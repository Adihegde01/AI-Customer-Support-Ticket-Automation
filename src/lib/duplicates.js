'use strict';
// Bonus — Duplicate ticket detection.
// Hard match: identical message ID (idempotency against re-delivery).
// Fuzzy match: token overlap between summaries/subjects >= threshold, scoped
// to the same sender's open tickets within the rolling window.

function tokenSet(s) {
  return new Set(
    String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 3)
  );
}

function similarity(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/**
 * @param {{messageId, issue_summary, subject}} incoming
 * @param {Array<{id, messageId, issueSummary, emailSubject}>} candidates
 */
function findDuplicate(incoming, candidates, threshold = 0.6) {
  for (const c of candidates) {
    if (c.messageId && c.messageId === incoming.messageId) return { ticket: c, reason: 'message_id' };
    const sim = Math.max(
      similarity(incoming.issue_summary, c.issueSummary),
      similarity(incoming.subject, c.emailSubject)
    );
    if (sim >= threshold) return { ticket: c, reason: `similarity_${sim.toFixed(2)}` };
  }
  return null;
}

module.exports = { tokenSet, similarity, findDuplicate };
