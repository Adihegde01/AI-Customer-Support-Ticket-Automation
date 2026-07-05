#!/usr/bin/env node
'use strict';
// Integration tests: the real pipeline + local store + mock LLM, end to end.
// Covers intake, classification, routing, ack, duplicates, idempotency,
// malformed-AI degradation, VIP override, ack failure, SLA escalation,
// reply suggestion, and the audit trail.
// Run: node tests/integration_tests.js  (exit code 0 = all pass)

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cfg = require('../config/config.json');
const kbSeed = require('../config/knowledge_base.json');
const { processEmail } = require('../src/pipeline');
const { checkSla } = require('../src/slaMonitor');
const { suggestReply } = require('../src/server');
const { LocalJsonStore } = require('../src/services/localStore');
const { MockLLM } = require('../src/services/mockLlm');

const quietLog = { info() {}, warn() {}, error() {} };

class StubMailer {
  constructor({ fail = false } = {}) {
    this.fail = fail;
    this.sent = [];
  }
  async sendAck(msg) {
    if (this.fail) throw new Error('SMTP connection refused');
    this.sent.push(msg);
  }
}

class StubSlack {
  constructor() {
    this.alerts = [];
    this.escalations = [];
    this.errors = [];
  }
  async ticketAlert(a) { this.alerts.push(a); }
  async escalationAlert(a) { this.escalations.push(a); }
  async errorAlert(a) { this.errors.push(a); }
}

function makeDeps({ mailer } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-int-'));
  const store = new LocalJsonStore({
    dir,
    customers: { 'vip@bigcorp.com': { vip: true } },
    knowledgeBase: kbSeed.map((a) => ({ title: a.title, content: a.content, tags: a.tags })),
  });
  return {
    dir,
    store,
    llm: new MockLLM(),
    mailer: mailer || new StubMailer(),
    slack: new StubSlack(),
    cfg,
    log: quietLog,
  };
}

function email(overrides = {}) {
  return {
    senderName: 'Rahul Menon',
    senderEmail: 'rahul.menon@brightpay.io',
    subject: 'URGENT: Production API completely down — all payments failing',
    body: 'Our entire production integration has been down since 09:40. Every request returns 503.',
    receivedAt: new Date().toISOString(),
    messageId: `<msg-${Math.random().toString(36).slice(2)}@test>`,
    inReplyTo: null,
    attachments: [],
    ...overrides,
  };
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}

(async () => {
  console.log('\nintake & triage');
  await test('critical outage: classified, routed, acked, alerted', async () => {
    const deps = makeDeps();
    const r = await processEmail(email(), deps);
    assert.strictEqual(r.action, 'created');
    assert.strictEqual(r.category, 'Technical Support');
    assert.strictEqual(r.priority, 'Critical');
    assert.strictEqual(r.assignedTeam, 'Technical Support');
    const t = await deps.store.getTicket(r.recordId);
    assert.strictEqual(t.fields.Status, 'Open');
    assert.ok(t.fields['Ack Sent At'], 'ack timestamp set');
    assert.strictEqual(deps.mailer.sent.length, 1);
    assert.match(deps.mailer.sent[0].subject, /Ticket #TCKT-0001/);
    assert.strictEqual(deps.slack.alerts.length, 1, 'critical priority triggers slack alert');
  });

  await test('original email + attachments saved to the ticket', async () => {
    const deps = makeDeps();
    const r = await processEmail(email({
      attachments: [{ filename: 'screenshot.png', mimeType: 'image/png', contentBase64: Buffer.from('png').toString('base64') }],
    }), deps);
    const dir = path.join(deps.dir, 'attachments', r.ticketId);
    assert.ok(fs.existsSync(path.join(dir, 'original_email.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'screenshot.png')));
  });

  await test('low-priority sales inquiry routes to Sales without slack noise', async () => {
    const deps = makeDeps();
    const r = await processEmail(email({
      senderEmail: 'daniel@kumasilogistics.com',
      subject: 'Pricing for 50-seat team?',
      body: 'Could someone share enterprise pricing and trial details?',
      messageId: '<sales-1@test>',
    }), deps);
    assert.strictEqual(r.category, 'Sales Inquiry');
    assert.strictEqual(r.assignedTeam, 'Sales');
    assert.strictEqual(deps.slack.alerts.length, 0);
  });

  console.log('\nduplicates & idempotency');
  await test('follow-up from same sender appends instead of creating', async () => {
    const deps = makeDeps();
    const first = await processEmail(email({ messageId: '<orig@test>' }), deps);
    const r = await processEmail(email({
      messageId: '<followup@test>',
      subject: 'Re: URGENT: Production API completely down — all payments failing',
      body: 'Following up — the API is STILL down, over an hour now.',
    }), deps);
    assert.strictEqual(r.action, 'appended_to_duplicate');
    assert.strictEqual(r.ticketId, first.ticketId);
    const t = await deps.store.getTicket(first.recordId);
    assert.match(t.fields['Internal Notes'], /Duplicate follow-up/);
    assert.strictEqual(deps.store.tickets.length, 1);
  });

  await test('re-delivered messageId is skipped (idempotency)', async () => {
    const deps = makeDeps();
    const msg = email({ messageId: '<same@test>' });
    const first = await processEmail(msg, deps);
    const r = await processEmail(msg, deps);
    assert.strictEqual(r.action, 'skipped_already_processed');
    assert.strictEqual(r.ticketId, first.ticketId);
    assert.strictEqual(deps.store.tickets.length, 1);
  });

  console.log('\ngraceful degradation');
  await test('malformed AI JSON: ticket still created with safe defaults + review flag', async () => {
    const deps = makeDeps();
    deps.llm.failNext = true;
    const r = await processEmail(email({ subject: 'Garbled export', body: 'CSV export has odd characters.', messageId: '<err-1@test>' }), deps);
    assert.strictEqual(r.action, 'created');
    assert.strictEqual(r.category, 'General Inquiry');
    assert.strictEqual(r.priority, 'Medium');
    assert.strictEqual(r.needsManualReview, true);
    const t = await deps.store.getTicket(r.recordId);
    assert.match(t.fields['Internal Notes'], /parse failed/i);
  });

  await test('ack failure: ticket stays Open with manual-follow-up note', async () => {
    const deps = makeDeps({ mailer: new StubMailer({ fail: true }) });
    const r = await processEmail(email({ messageId: '<ackfail@test>' }), deps);
    const t = await deps.store.getTicket(r.recordId);
    assert.strictEqual(t.fields.Status, 'Open');
    assert.strictEqual(t.fields['Ack Sent At'], undefined);
    assert.match(t.fields['Internal Notes'], /Ack email failed — manual follow-up needed/);
    assert.ok(deps.store.errors.length >= 1, 'failure logged to error log');
  });

  console.log('\nbusiness rules');
  await test('VIP customer floor: Low becomes Medium with override source', async () => {
    const deps = makeDeps();
    const r = await processEmail(email({
      senderEmail: 'vip@bigcorp.com',
      subject: 'Question about enterprise pricing',
      body: 'What discounts are available for annual plans?',
      messageId: '<vip-1@test>',
    }), deps);
    assert.strictEqual(r.priority, 'Medium');
    assert.strictEqual(r.prioritySource, 'business_rule_override');
  });

  console.log('\nSLA & lifecycle');
  await test('breached ticket escalates, bumps priority, alerts', async () => {
    const deps = makeDeps();
    const r = await processEmail(email({
      senderEmail: 'daniel@kumasilogistics.com',
      subject: 'Pricing for 50-seat team?',
      body: 'Enterprise pricing please.',
      messageId: '<sla-1@test>',
    }), deps);
    const rec = deps.store.tickets.find((t) => t.id === r.recordId);
    rec.fields['Received At'] = new Date(Date.now() - 5 * 86400000).toISOString(); // 5 days > Low target
    const flagged = await checkSla(deps);
    assert.strictEqual(flagged.length, 1);
    assert.strictEqual(flagged[0].breached, true);
    const t = await deps.store.getTicket(r.recordId);
    assert.strictEqual(t.fields.Escalated, true);
    assert.strictEqual(t.fields.Priority, 'Medium'); // bumped one level from Low
    assert.strictEqual(deps.slack.escalations.length, 1);
  });

  await test('status walk is fully audit-trailed', async () => {
    const deps = makeDeps();
    const r = await processEmail(email({ messageId: '<audit-1@test>' }), deps);
    for (const status of ['In Progress', 'Waiting for Customer', 'Resolved', 'Closed']) {
      await deps.store.updateTicket(r.recordId, { Status: status });
    }
    const statusChanges = deps.store.audit.filter((a) => a.fieldChanged === 'Status');
    assert.strictEqual(statusChanges.length, 4);
    assert.strictEqual(statusChanges.at(-1).oldValue, 'Resolved');
    assert.strictEqual(statusChanges.at(-1).newValue, 'Closed');
  });

  console.log('\nreply suggestion (webhook logic)');
  await test('suggest-reply drafts from KB and saves to the ticket', async () => {
    const deps = makeDeps();
    const r = await processEmail(email({
      senderEmail: 's.klein@nordicretail.se',
      subject: 'Charged twice this month',
      body: 'We were charged twice for our subscription. Please refund the duplicate.',
      messageId: '<reply-1@test>',
    }), deps);
    const res = await suggestReply(r.recordId, deps);
    assert.strictEqual(res.ok, true);
    assert.ok(res.kb_articles_used.includes('Duplicate charges and refund process'));
    const t = await deps.store.getTicket(r.recordId);
    assert.ok(t.fields['Suggested Reply'].length > 50);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error('Failed:', failures.join(', '));
    process.exit(1);
  }
})();
