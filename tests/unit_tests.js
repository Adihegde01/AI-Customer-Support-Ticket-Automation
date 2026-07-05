#!/usr/bin/env node
'use strict';
// Unit tests for the pipeline's pure-logic modules (src/lib/*).
// Run: node tests/unit_tests.js  (exit code 0 = all pass)

const assert = require('node:assert');
const cfg = require('../config/config.json');
const { safeJsonParse, normalizeEnum, dedupeTags, validateEmail, clampConfidence, cleanAiOutput } = require('../src/lib/validate');
const { applyPriorityRules } = require('../src/lib/priorityRules');
const { findDuplicate, similarity } = require('../src/lib/duplicates');
const { slaState, bumpPriority } = require('../src/lib/sla');
const { redact, sanitizeForSlack } = require('../src/lib/redact');
const { rankKb } = require('../src/lib/kb');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}

console.log('\nsafeJsonParse');
test('parses clean JSON', () => {
  assert.deepStrictEqual(safeJsonParse('{"category":"Billing"}'), { category: 'Billing' });
});
test('strips markdown code fences', () => {
  assert.strictEqual(safeJsonParse('```json\n{"a":1}\n```').a, 1);
});
test('throws AI_JSON_PARSE_ERROR on malformed input', () => {
  assert.throws(() => safeJsonParse('Sure! Here is the JSON: {broken'), /AI_JSON_PARSE_ERROR/);
});
test('throws on empty string', () => {
  assert.throws(() => safeJsonParse(''), /AI_JSON_PARSE_ERROR/);
});

console.log('\nnormalizeEnum');
test('case-insensitive match returns canonical value', () => {
  assert.strictEqual(normalizeEnum('bILLing', cfg.categories, 'Other'), 'Billing');
});
test('unknown category falls back', () => {
  assert.strictEqual(normalizeEnum('Spam Complaint', cfg.categories, 'General Inquiry'), 'General Inquiry');
});
test('null/undefined falls back', () => {
  assert.strictEqual(normalizeEnum(null, cfg.priorities, 'Medium'), 'Medium');
  assert.strictEqual(normalizeEnum(undefined, cfg.priorities, 'Medium'), 'Medium');
});
test('non-string input does not crash', () => {
  assert.strictEqual(normalizeEnum(42, cfg.priorities, 'Medium'), 'Medium');
});

console.log('\ndedupeTags');
test('dedupes case-insensitively and title-cases', () => {
  assert.deepStrictEqual(dedupeTags([' API ', 'api', 'OUTAGE']), ['Api', 'Outage']);
});
test('handles null and empty entries', () => {
  assert.deepStrictEqual(dedupeTags(null), []);
  assert.deepStrictEqual(dedupeTags(['', '  ', 'billing']), ['Billing']);
});

console.log('\nvalidateEmail');
test('lowercases valid email', () => {
  assert.strictEqual(validateEmail('Rahul.Menon@BrightPay.io'), 'rahul.menon@brightpay.io');
});
test('rejects invalid emails', () => {
  assert.strictEqual(validateEmail('not-an-email'), null);
  assert.strictEqual(validateEmail('a b@c.com'), null);
  assert.strictEqual(validateEmail(null), null);
});

console.log('\nclampConfidence');
test('clamps out-of-range and defaults non-numbers to 0.5', () => {
  assert.strictEqual(clampConfidence(1.7), 1);
  assert.strictEqual(clampConfidence(-2), 0);
  assert.strictEqual(clampConfidence('high'), 0.5);
});

console.log('\ncleanAiOutput');
const meta = { senderName: 'Sarah Klein', senderEmail: 'S.Klein@NordicRetail.se', subject: 'x', body: 'y' };
test('happy path normalizes and validates', () => {
  const c = cleanAiOutput(
    { category: 'billing', priority: 'HIGH', sentiment: 'negative', suggested_tags: ['Refund', 'refund'], confidence_score: 0.92, issue_summary: 'Duplicate charge' },
    meta, cfg
  );
  assert.strictEqual(c.category, 'Billing');
  assert.strictEqual(c.priority, 'High');
  assert.strictEqual(c.sentiment, 'Negative');
  assert.deepStrictEqual(c.suggested_tags, ['Refund']);
  assert.strictEqual(c.sender_email, 's.klein@nordicretail.se');
  assert.strictEqual(c.needs_manual_review, false);
});
test('missing fields get safe defaults', () => {
  const c = cleanAiOutput({}, meta, cfg);
  assert.strictEqual(c.category, 'General Inquiry');
  assert.strictEqual(c.priority, 'Medium');
  assert.strictEqual(c.issue_summary, 'No summary generated');
  assert.strictEqual(c.customer_name, 'Sarah Klein'); // falls back to metadata
});
test('low confidence forces manual review', () => {
  assert.strictEqual(cleanAiOutput({ confidence_score: 0.55 }, meta, cfg).needs_manual_review, true);
  assert.strictEqual(cleanAiOutput({ confidence_score: 0.6 }, meta, cfg).needs_manual_review, false);
});
test('parse failure path: zero confidence, review flag, raw preserved', () => {
  const c = cleanAiOutput(null, meta, cfg, { parseFailed: true, rawOutput: '{broken' });
  assert.strictEqual(c.needs_manual_review, true);
  assert.strictEqual(c.confidence_score, 0);
  assert.match(c.raw_ai_output_note, /\{broken/);
});

console.log('\napplyPriorityRules');
test('critical keyword overrides AI priority', () => {
  const r = applyPriorityRules('Medium', 'Our API has been down since 09:40', false, cfg);
  assert.strictEqual(r.priority, 'Critical');
  assert.strictEqual(r.priority_source, 'business_rule_override');
});
test('high keyword raises Medium to High only', () => {
  assert.strictEqual(applyPriorityRules('Medium', 'please treat this as urgent', false, cfg).priority, 'High');
  assert.strictEqual(applyPriorityRules('Low', 'urgent-ish question', false, cfg).priority, 'Low');
});
test('VIP floor raises Low to Medium', () => {
  assert.strictEqual(applyPriorityRules('Low', 'just wondering about invoices', true, cfg).priority, 'Medium');
});
test('no override keeps ai source', () => {
  const r = applyPriorityRules('Low', 'general question about pricing tiers', false, cfg);
  assert.strictEqual(r.priority, 'Low');
  assert.strictEqual(r.priority_source, 'ai');
});

console.log('\nduplicate detection');
const openTicket = {
  id: 'rec1',
  messageId: 'msg-001',
  issueSummary: 'Production API outage causing all payment processing to fail',
  emailSubject: 'URGENT: Production API completely down — all payments failing',
};
test('same messageId is a hard duplicate (idempotency)', () => {
  const dup = findDuplicate({ messageId: 'msg-001', issue_summary: 'anything', subject: 'anything' }, [openTicket]);
  assert.strictEqual(dup.ticket.id, 'rec1');
  assert.strictEqual(dup.reason, 'message_id');
});
test('fuzzy subject match catches follow-up email (email_5 sample)', () => {
  const dup = findDuplicate({
    messageId: 'msg-002',
    issue_summary: 'Follow-up: production API still down, payments failing',
    subject: 'Re: URGENT: Production API completely down — all payments failing',
  }, [openTicket]);
  assert.strictEqual(dup.ticket.id, 'rec1');
});
test('unrelated email is not a duplicate', () => {
  const dup = findDuplicate({
    messageId: 'msg-003',
    issue_summary: 'Customer asks about enterprise pricing for a 50-seat team',
    subject: 'Pricing for 50-seat team?',
  }, [openTicket]);
  assert.strictEqual(dup, null);
});
test('empty candidate list and empty strings are safe', () => {
  assert.strictEqual(findDuplicate({ messageId: 'x', issue_summary: 'y', subject: 'z' }, []), null);
  assert.strictEqual(similarity('', 'anything'), 0);
});

console.log('\nSLA');
const now = Date.now();
test('critical ticket breaches after 61 minutes', () => {
  assert.strictEqual(slaState('Critical', now - 61 * 60000, now, cfg).breached, true);
});
test('critical ticket at 50 min is near-breach (80% of 60)', () => {
  const s = slaState('Critical', now - 50 * 60000, now, cfg);
  assert.deepStrictEqual([s.breached, s.near_breach], [false, true]);
});
test('fresh ticket is not flagged', () => {
  assert.strictEqual(slaState('High', now - 10 * 60000, now, cfg).flagged, false);
});
test('unknown priority falls back to Medium target', () => {
  assert.strictEqual(slaState(undefined, now - 1500 * 60000, now, cfg).breached, true);
});
test('bump raises one level and caps at Critical', () => {
  assert.strictEqual(bumpPriority('Low', cfg.priorities), 'Medium');
  assert.strictEqual(bumpPriority('High', cfg.priorities), 'Critical');
  assert.strictEqual(bumpPriority('Critical', cfg.priorities), 'Critical');
});

console.log('\nredaction & sanitization');
test('redacts email addresses', () => {
  assert.ok(!redact('contact sarah.klein@nordicretail.se now').includes('@nordicretail'));
});
test('redacts card-like digit runs', () => {
  assert.ok(!redact('card 4111 1111 1111 1111 declined').includes('4111'));
});
test('redacts phone numbers', () => {
  assert.ok(!redact('call me at +91 98450 12345').includes('98450'));
});
test('keeps ordinary text intact', () => {
  assert.strictEqual(redact('API returned 503 on 3 retries'), 'API returned 503 on 3 retries');
});
test('sanitizeForSlack strips markup-significant characters', () => {
  assert.strictEqual(sanitizeForSlack('<script>*bold*_x_`y`|z</script>'), 'scriptboldxyz/script');
});

console.log('\nKB snippet ranking');
const kb = [
  { title: 'Troubleshooting API downtime', content: 'Steps when the API is down or returning 503 errors during an outage', tags: ['api'] },
  { title: 'How refunds work', content: 'Refund timelines and duplicate charge reversal process', tags: ['billing'] },
  { title: 'Office locations', content: 'We have offices in Berlin and Austin', tags: [] },
];
test('outage query ranks the API article first', () => {
  assert.strictEqual(rankKb('Production API outage returning 503 errors', kb)[0].article.title, 'Troubleshooting API downtime');
});
test('billing query does not surface the API article first', () => {
  assert.strictEqual(rankKb('duplicate charge refund on subscription billing', kb)[0].article.title, 'How refunds work');
});
test('returns at most 3 and empty on no overlap', () => {
  assert.strictEqual(rankKb('zzzz qqqq xxxx', kb).length, 0);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('Failed:', failures.join(', '));
  process.exit(1);
}
