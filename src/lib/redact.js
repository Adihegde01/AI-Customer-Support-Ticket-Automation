'use strict';
// Security — PII redaction for anything persisted to logs: email addresses,
// card-like digit runs, phone-like numbers. Applied before ErrorLog writes
// and before customer text is echoed into Slack.

function redact(text) {
  return String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[EMAIL_REDACTED]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[CARD_REDACTED]')
    .replace(/\+?\d[\d ()-]{8,}\d/g, '[PHONE_REDACTED]');
}

// Strip characters that carry meaning in Slack mrkdwn/HTML before embedding
// customer-controlled text in alerts.
function sanitizeForSlack(text) {
  return String(text || '').replace(/[<>&*_`|]/g, '').slice(0, 300);
}

module.exports = { redact, sanitizeForSlack };
