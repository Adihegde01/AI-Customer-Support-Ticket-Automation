'use strict';
// Steps 2–8 — the end-to-end triage pipeline for one incoming email.
// Guiding invariant (plan §4/§9): a ticket is NEVER silently dropped. AI or
// attachment failures degrade the ticket (safe defaults, review flag, notes)
// instead of aborting it.

const { cleanAiOutput } = require('./lib/validate');
const { applyPriorityRules } = require('./lib/priorityRules');
const { findDuplicate } = require('./lib/duplicates');
const { buildAckEmail } = require('./services/mailer');
const { redact } = require('./lib/redact');

async function processEmail(email, { store, llm, mailer, slack, cfg, log = console }) {
  const meta = {
    senderName: email.senderName,
    senderEmail: email.senderEmail,
    subject: email.subject,
    body: email.body,
    receivedAt: email.receivedAt,
    messageId: email.messageId,
  };

  // Idempotency: exact re-delivery of an already-processed message is a no-op.
  const existing = await store.findByMessageId(meta.messageId);
  if (existing) {
    log.info(`  skipped: message ${meta.messageId} already processed as ${existing.ticketId}`);
    return { action: 'skipped_already_processed', ticketId: existing.ticketId };
  }

  // VIP lookup — absent customer rows skip the VIP rule gracefully.
  let vipFlag = false;
  try {
    vipFlag = await store.getCustomerVip(meta.senderEmail);
  } catch (e) {
    log.warn(`  VIP lookup failed (continuing without): ${e.message}`);
  }

  // Step 2 — AI analysis, with the full degradation ladder:
  // transport failure OR unparseable JSON (after one repair retry inside the
  // client) → defaults + needs_manual_review, raw output kept for the agent.
  let aiResult;
  try {
    aiResult = await llm.analyzeTicket(meta.subject, meta.body);
  } catch (e) {
    aiResult = { parseFailed: true, raw: `(AI call failed after retries: ${e.message})` };
    await safeLogError({ store, slack, log }, {
      workflow: 'intake', step: 'ai_analysis', message: e.message, severity: 'transient',
      payload: JSON.stringify({ subject: meta.subject }),
    });
  }

  // Steps 3–5 — classification, validation, priority (AI + business rules).
  const cleaned = cleanAiOutput(aiResult.data, meta, cfg, {
    parseFailed: !!aiResult.parseFailed,
    rawOutput: aiResult.raw || '',
  });
  const ruled = applyPriorityRules(
    cleaned.priority,
    `${cleaned.detailed_description} ${meta.body}`,
    vipFlag,
    cfg
  );
  cleaned.priority = ruled.priority;
  cleaned.priority_source = ruled.priority_source;

  // Bonus — duplicate detection before creating a new record.
  const candidates = await store.findOpenTicketsBySender(meta.senderEmail, cfg.duplicateWindowDays);
  const dup = findDuplicate(
    { messageId: meta.messageId, issue_summary: cleaned.issue_summary, subject: meta.subject },
    candidates,
    cfg.duplicateSimilarityThreshold
  );
  if (dup) {
    await store.appendNote(
      dup.ticket.id,
      `[${new Date().toISOString()}] Duplicate follow-up from ${meta.senderEmail} (${dup.reason}, messageId ${meta.messageId}):\n${meta.body.slice(0, 2000)}`
    );
    log.info(`  duplicate of ${dup.ticket.ticketId} (${dup.reason}) — appended to existing ticket`);
    return { action: 'appended_to_duplicate', ticketId: dup.ticket.ticketId, reason: dup.reason };
  }

  // Step 7 — configurable team assignment (store-backed map, config fallback).
  let teamMap = null;
  try {
    teamMap = await store.getTeamMap();
  } catch (e) {
    log.warn(`  team map lookup failed, using config fallback: ${e.message}`);
  }
  const assignedTeam = (teamMap || cfg.teamMap)[cleaned.category] || cfg.defaultTeam;

  // Step 6 — create the ticket, Status = Open.
  const { id, ticketId } = await store.createTicket({
    'Customer Name': cleaned.customer_name,
    Company: cleaned.company,
    'Sender Email': cleaned.sender_email,
    'Email Subject': meta.subject,
    'Email Body': meta.body,
    'Issue Summary': cleaned.issue_summary,
    'Detailed Description': cleaned.detailed_description,
    Category: cleaned.category,
    Priority: cleaned.priority,
    'Priority Justification': cleaned.priority_justification,
    'Priority Source': cleaned.priority_source,
    Sentiment: cleaned.sentiment,
    'Product/Service': cleaned.product_service,
    'Suggested Department': cleaned.suggested_department,
    Tags: cleaned.suggested_tags,
    'Detected Language': cleaned.detected_language,
    'Confidence Score': cleaned.confidence_score,
    'Needs Manual Review': cleaned.needs_manual_review,
    'Assigned Team': assignedTeam,
    Status: 'Open',
    'Internal Notes': cleaned.raw_ai_output_note,
    'Message ID': meta.messageId,
    'VIP Flag': vipFlag,
    'Received At': meta.receivedAt,
  });
  log.info(`  created ${ticketId}: ${cleaned.category} / ${cleaned.priority} (${cleaned.priority_source}) → ${assignedTeam}`);

  // Attach original email + any attachments; failure degrades to text-only.
  try {
    const files = [
      {
        filename: 'original_email.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from(
          `From: ${meta.senderName} <${meta.senderEmail}>\nSubject: ${meta.subject}\nReceived: ${meta.receivedAt}\n\n${meta.body}`
        ).toString('base64'),
      },
      ...(email.attachments || []),
    ];
    await store.attachFiles(id, files);
  } catch (e) {
    await store.appendNote(id, 'Attachment upload failed — ticket continues text-only.');
    await safeLogError({ store, slack, log }, {
      workflow: 'intake', step: 'attach_files', message: e.message, severity: 'transient',
    });
  }

  // Step 8 — acknowledgment email; on failure the ticket stays Open with a
  // manual-follow-up note (plan §9) rather than being lost.
  const ack = buildAckEmail({
    ticketId,
    customerName: cleaned.customer_name,
    issueSummary: cleaned.issue_summary,
    assignedTeam,
    slaEstimate: cfg.slaEstimateLabels[cleaned.priority] || cfg.slaEstimateLabels.Medium,
    companyName: cfg.companyName,
  });
  try {
    if (!cleaned.sender_email) throw new Error('no valid sender email to acknowledge');
    await mailer.sendAck({ to: cleaned.sender_email, ...ack, inReplyTo: email.inReplyTo });
    await store.updateTicket(id, { 'Ack Sent At': new Date().toISOString() });
  } catch (e) {
    await store.appendNote(id, `Ack email failed — manual follow-up needed (${redact(e.message).slice(0, 200)})`);
    await safeLogError({ store, slack, log }, {
      workflow: 'intake', step: 'ack_email', message: e.message, severity: 'transient',
    });
  }

  // Bonus — priority-based notification.
  if (cfg.notifyPriorities.includes(cleaned.priority)) {
    try {
      await slack.ticketAlert({
        ticketId,
        priority: cleaned.priority,
        issueSummary: cleaned.issue_summary,
        assignedTeam,
        sentiment: cleaned.sentiment,
      });
    } catch (e) {
      log.warn(`  slack alert failed: ${e.message}`);
    }
  }

  return {
    action: 'created',
    ticketId,
    recordId: id,
    category: cleaned.category,
    priority: cleaned.priority,
    prioritySource: cleaned.priority_source,
    sentiment: cleaned.sentiment,
    assignedTeam,
    needsManualReview: cleaned.needs_manual_review,
  };
}

async function safeLogError(deps, entry) {
  try {
    await deps.store.logError(entry);
    await deps.slack.errorAlert(entry);
  } catch (e) {
    deps.log.error(`  error logging failed: ${e.message}`);
  }
}

module.exports = { processEmail, safeLogError };
