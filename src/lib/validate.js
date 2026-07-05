'use strict';
// Step 5 — Data Validation: safe JSON parsing, missing-field handling,
// category normalization, tag dedupe, email validation, malformed-AI handling.

function safeJsonParse(raw) {
  try {
    const cleaned = String(raw).replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    const err = new Error(`AI_JSON_PARSE_ERROR: ${e.message} | raw: ${String(raw).slice(0, 200)}`);
    err.code = 'AI_JSON_PARSE_ERROR';
    throw err;
  }
}

function normalizeEnum(value, allowed, fallback) {
  if (!value) return fallback;
  const match = allowed.find((a) => a.toLowerCase() === String(value).toLowerCase());
  return match || fallback;
}

function dedupeTags(tags) {
  return [...new Set((tags || []).map((t) => String(t).trim().toLowerCase()))]
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1));
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return email && re.test(email) ? String(email).toLowerCase() : null;
}

function clampConfidence(v) {
  return typeof v === 'number' && !Number.isNaN(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}

/**
 * Cleans raw AI analysis output into a trusted ticket payload.
 * `data` may be {} (parse failure path) — every field has a safe default so a
 * ticket is never dropped. Sender email always comes from message metadata,
 * never from the AI.
 */
function cleanAiOutput(data, meta, cfg, { parseFailed = false, rawOutput = '' } = {}) {
  const d = data || {};
  const trimOr = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  const cleaned = {
    customer_name: trimOr(d.customer_name, meta.senderName || 'Unknown'),
    company: trimOr(d.company, null),
    issue_summary: trimOr(d.issue_summary, 'No summary generated'),
    detailed_description: trimOr(d.detailed_description, ''),
    category: normalizeEnum(d.category, cfg.categories, cfg.defaults.category),
    priority: normalizeEnum(d.priority, cfg.priorities, cfg.defaults.priority),
    priority_justification: trimOr(d.priority_justification, ''),
    sentiment: normalizeEnum(d.sentiment, cfg.sentiments, cfg.defaults.sentiment),
    product_service: trimOr(d.product_service, null),
    suggested_department: trimOr(d.suggested_department, cfg.defaults.department),
    suggested_tags: dedupeTags(d.suggested_tags),
    detected_language: trimOr(d.detected_language, 'en'),
    confidence_score: parseFailed ? 0 : clampConfidence(d.confidence_score),
    sender_email: validateEmail(meta.senderEmail),
  };
  cleaned.needs_manual_review = parseFailed || cleaned.confidence_score < cfg.confidenceReviewThreshold;
  cleaned.raw_ai_output_note = parseFailed
    ? `AI JSON parse failed after repair retry. Raw output: ${String(rawOutput).slice(0, 1000)}`
    : '';
  return cleaned;
}

module.exports = { safeJsonParse, normalizeEnum, dedupeTags, validateEmail, clampConfidence, cleanAiOutput };
