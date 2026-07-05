'use strict';
// Offline end-to-end demo: runs every sample email through the real pipeline
// with a local JSON store, console mailer/Slack, and — unless
// ANTHROPIC_API_KEY is set — a deterministic mock LLM. Demonstrates intake,
// classification, routing, acknowledgment, duplicate handling, error
// injection, SLA escalation, and the reply-suggestion webhook logic.
// Output: demo_output/ (tickets.json, audit_log.json, error_log.json,
// attachments/).

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../config/config.json');
const kbSeed = require('../config/knowledge_base.json');
const { processEmail } = require('./pipeline');
const { checkSla } = require('./slaMonitor');
const { suggestReply } = require('./server');
const { LocalJsonStore } = require('./services/localStore');
const { ConsoleMailer } = require('./services/mailer');
const { ConsoleSlack } = require('./services/slack');
const { ClaudeClient } = require('./services/claude');
const { GeminiClient } = require('./services/gemini');
const { MockLLM } = require('./services/mockLlm');

// ------------------------------------------------------------ sample loader ---
function parseSampleEmail(file, idx) {
  const raw = fs.readFileSync(file, 'utf8');
  const body = raw.split('--- Expected triage ---')[0].trim();
  const header = (name) => (body.match(new RegExp(`^${name}: (.+)$`, 'm')) || [])[1] || '';
  const fromRaw = header('From');
  const m = fromRaw.match(/^(.*?)\s*<(.+)>$/);
  return {
    senderName: m ? m[1].trim() : fromRaw,
    senderEmail: m ? m[2].trim() : fromRaw,
    subject: header('Subject'),
    body: body.split(/^Subject: .+$/m)[1]?.trim() || body,
    receivedAt: new Date().toISOString(),
    messageId: `<demo-${idx}@samples.local>`,
    inReplyTo: null,
    attachments: [],
  };
}

// -------------------------------------------------------------------- main ---
async function main() {
  const outDir = path.join(__dirname, '..', 'demo_output');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const llm = process.env.GEMINI_API_KEY
    ? new GeminiClient({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL })
    : process.env.ANTHROPIC_API_KEY
      ? new ClaudeClient({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL })
      : new MockLLM();
  const useRealLlm = !(llm instanceof MockLLM);

  const store = new LocalJsonStore({
    dir: outDir,
    customers: { 'rahul.menon@brightpay.io': { vip: true } },
    knowledgeBase: kbSeed.map((a) => ({ title: a.title, content: a.content, tags: a.tags })),
  });
  const mailer = new ConsoleMailer();
  const slack = new ConsoleSlack();
  const deps = { store, llm, mailer, slack, cfg, log: console };

  console.log(`\n=== Support Ticket Automation — offline demo (LLM: ${useRealLlm ? `${llm.constructor.name} ${llm.model}` : 'mock'}) ===`);

  // 1. Intake: run every sample through the pipeline (email_5 → duplicate path)
  const sampleDir = path.join(__dirname, '..', 'samples');
  const files = fs.readdirSync(sampleDir).filter((f) => f.endsWith('.txt')).sort();
  const results = [];
  for (const [i, f] of files.entries()) {
    console.log(`\n[${f}]`);
    const email = parseSampleEmail(path.join(sampleDir, f), i + 1);
    results.push({ sample: f, ...(await processEmail(email, deps)) });
  }

  // 2. Idempotency: re-deliver sample 1's exact messageId — must be skipped
  console.log('\n[idempotency check — re-delivering email 1]');
  results.push({
    sample: 'email_1 (re-delivered)',
    ...(await processEmail(parseSampleEmail(path.join(sampleDir, files[0]), 1), deps)),
  });

  // 3. Error injection: malformed AI response → safe defaults + review flag
  console.log('\n[error injection — malformed AI JSON]');
  if (llm instanceof MockLLM) llm.failNext = true;
  results.push({
    sample: 'error injection (broken AI JSON)',
    ...(await processEmail({
      senderName: 'Erin Doyle',
      senderEmail: 'erin.doyle@example.org',
      subject: 'Strange characters in export file',
      body: 'The CSV export contains garbled characters when opened in Excel.',
      receivedAt: new Date().toISOString(),
      messageId: '<demo-error-1@samples.local>',
      attachments: [{
        filename: 'export_sample.csv',
        mimeType: 'text/csv',
        contentBase64: Buffer.from('id,name\n1,Ã©xample').toString('base64'),
      }],
    }, deps)),
  });

  // 4. SLA monitor: backdate the Critical ticket by 2 hours, then sweep
  console.log('\n[SLA sweep — Critical ticket backdated 2h]');
  const critical = store.tickets.find((t) => t.fields.Priority === 'Critical');
  if (critical) {
    critical.fields['Received At'] = new Date(Date.now() - 2 * 3600000).toISOString();
  }
  const escalations = await checkSla(deps);

  // 5. Agent lifecycle: walk a ticket through the stages (audit-trailed)
  console.log('\n[agent lifecycle — ticket 2 walked to Closed]');
  const t2 = store.tickets[1];
  for (const status of ['In Progress', 'Waiting for Customer', 'Resolved', 'Closed']) {
    await store.updateTicket(t2.id, { Status: status });
  }
  await store.appendNote(t2.id, 'Agent note: refund verified against ledger and issued.');

  // 6. Reply suggestion (webhook logic) for the billing ticket
  console.log('\n[reply suggestion — billing ticket]');
  const reply = await suggestReply(t2.id, deps);
  console.log(`  KB articles used: ${reply.kb_articles_used.join('; ') || '(none)'}`);

  // ------------------------------------------------------------- summary ---
  console.log('\n=== Results ===');
  console.table(results.map((r) => ({
    sample: r.sample.replace('.txt', ''),
    action: r.action,
    ticket: r.ticketId || '',
    category: r.category || '',
    priority: r.priority || '',
    team: r.assignedTeam || '',
    review: r.needsManualReview === undefined ? '' : r.needsManualReview,
  })));
  console.log(`Escalations: ${escalations.length} | Acks sent: ${mailer.sent.length} | Slack alerts: ${slack.posts.length}`);
  console.log(`Audit trail entries: ${store.audit.length} | Error log entries: ${store.errors.length}`);
  console.log(`\nArtifacts written to demo_output/ (tickets, audit log, error log, attachments).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
