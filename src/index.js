'use strict';
// Production entrypoint: wires IMAP inbox → pipeline → Airtable, plus the SLA
// interval and the suggest-reply webhook server. All credentials come from
// .env (see .env.example); nothing sensitive lives in code or config.

require('dotenv').config();
const cfg = require('../config/config.json');
const { processEmail, safeLogError } = require('./pipeline');
const { checkSla } = require('./slaMonitor');
const { createServer } = require('./server');
const { ClaudeClient } = require('./services/claude');
const { GeminiClient } = require('./services/gemini');
const { AirtableStore } = require('./services/airtableStore');
const { InboxMonitor } = require('./services/inbox');
const { SmtpMailer } = require('./services/mailer');
const { SlackNotifier } = require('./services/slack');

function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

/** LLM provider is chosen by which key is configured (Gemini wins if both). */
function buildLlm() {
  if (process.env.GEMINI_API_KEY) {
    return new GeminiClient({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return new ClaudeClient({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL });
  }
  console.error('Missing LLM credentials: set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env.');
  process.exit(1);
}

async function main() {
  requireEnv([
    'AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID',
    'IMAP_HOST', 'IMAP_USER', 'IMAP_PASSWORD',
    'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD',
  ]);

  const deps = {
    cfg,
    log: console,
    llm: buildLlm(),
    store: new AirtableStore({ apiKey: process.env.AIRTABLE_API_KEY, baseId: process.env.AIRTABLE_BASE_ID }),
    mailer: new SmtpMailer({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASSWORD,
      from: process.env.SMTP_FROM,
    }),
    slack: new SlackNotifier({ webhookUrl: process.env.SLACK_WEBHOOK_URL }),
  };

  // Mailbox/backlog guards: watch a dedicated label via IMAP_MAILBOX, and
  // ignore pre-existing unread mail unless IMAP_SINCE overrides the cutoff
  // (ISO date to process backlog from that date, or "all" to disable).
  const sinceEnv = (process.env.IMAP_SINCE || '').trim();
  const sinceDate = sinceEnv.toLowerCase() === 'all' ? null : sinceEnv ? new Date(sinceEnv) : new Date();
  if (sinceDate && Number.isNaN(sinceDate.getTime())) {
    console.error(`Invalid IMAP_SINCE date: "${sinceEnv}" — use an ISO date (2026-07-05) or "all".`);
    process.exit(1);
  }
  const inbox = new InboxMonitor({
    host: process.env.IMAP_HOST,
    port: process.env.IMAP_PORT,
    user: process.env.IMAP_USER,
    password: process.env.IMAP_PASSWORD,
    mailbox: process.env.IMAP_MAILBOX || 'INBOX',
    sinceDate,
  });

  let polling = false;
  async function pollInbox() {
    if (polling) return; // don't overlap slow polls
    polling = true;
    try {
      const emails = await inbox.fetchNew();
      if (emails.length) console.log(`[inbox] ${emails.length} new email(s)`);
      // Sequential processing keeps us inside Airtable/LLM rate limits
      // (scalability plan: pacing instead of unbounded parallelism).
      for (const email of emails) {
        try {
          await processEmail(email, deps);
        } catch (e) {
          console.error(`[pipeline] failed for ${email.messageId}: ${e.message}`);
          await safeLogError(deps, {
            workflow: 'intake', step: 'pipeline', message: e.message, severity: 'persistent',
            payload: JSON.stringify({ subject: email.subject }),
          });
        }
      }
    } catch (e) {
      console.error(`[inbox] poll failed: ${e.message}`);
    } finally {
      polling = false;
    }
  }

  setInterval(pollInbox, cfg.pollIntervalSeconds * 1000);
  pollInbox();

  setInterval(() => {
    checkSla(deps).catch((e) => console.error(`[sla] sweep failed: ${e.message}`));
  }, cfg.slaCheckIntervalSeconds * 1000);

  createServer(deps).listen(cfg.webhookPort, () => {
    console.log(`Support automation running:
  LLM            ${deps.llm.constructor.name} (${deps.llm.model})
  inbox poll     every ${cfg.pollIntervalSeconds}s (${process.env.IMAP_USER}, mailbox "${inbox.mailbox}", since ${sinceDate ? sinceDate.toISOString() : 'beginning (all backlog)'})
  SLA sweep      every ${cfg.slaCheckIntervalSeconds}s
  reply webhook  http://localhost:${cfg.webhookPort}/suggest-reply?record_id=recXXX`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
