# AI Customer Support Ticket Automation

A standalone **Node.js** service that turns incoming support emails into
triaged, routed, acknowledged tickets — AI classification (Claude),
deterministic business rules, duplicate detection, SLA escalation, and a full
audit trail. No workflow engine required: plain JavaScript, REST APIs, and
webhooks.

**Try it in 30 seconds (no accounts needed):**

```bash
npm install
npm test        # 38 unit + 11 integration assertions
npm run demo    # full pipeline on the sample emails, offline
```

## Architecture

```
            ┌──────────────────────────── src/index.js (entrypoint) ───────────────────────────┐
            │                                                                                   │
[IMAP inbox poll] ──► [pipeline.js — per email]                          [slaMonitor.js sweep]  │
 inbox.js   │           1. idempotency check (Message ID)                 every 15 min          │
 every 60s  │           2. VIP lookup (Customers)                         warn @80%, escalate   │
            │           3. Claude analysis ── claude.js                   + bump on breach      │
            │              (backoff 5s/15s/45s, repair-prompt retry)              │             │
            │           4. validate/clean ── lib/validate.js              [webhook server]      │
            │           5. business rules ── lib/priorityRules.js         server.js :8788       │
            │           6. duplicate check ── lib/duplicates.js           /suggest-reply        │
            │           7. create ticket (Status=Open) + attach files     (Prompt 2 + RAG-lite) │
            │           8. team assignment (configurable map)                                   │
            │           9. acknowledgment email ── mailer.js                                    │
            │          10. Slack alert (Critical/High) ── slack.js                              │
            │                        │                                                          │
            └────────────► [storage: airtableStore.js ⇄ localStore.js (same interface)] ◄──────┘
                            Airtable in production; local JSON for demo/tests
```

Every step degrades instead of aborting: **a ticket is never silently
dropped** (AI failure → safe defaults + review flag; attachment failure →
text-only note; ack failure → "manual follow-up needed" note).

## Contents

```
src/
  index.js                 # production entrypoint (inbox poll + SLA + webhook)
  pipeline.js              # Steps 2–8: the per-email triage pipeline
  slaMonitor.js            # SLA sweep: warn/escalate/bump
  server.js                # /suggest-reply webhook + /healthz
  demo.js                  # offline end-to-end demo (npm run demo)
  lib/                     # pure logic: validate, priorityRules, duplicates, sla, kb, redact
  services/                # adapters: claude, prompts, airtableStore, localStore,
                           #           inbox (IMAP), mailer (SMTP), slack, mockLlm
config/
  config.json              # categories, keywords, team map, SLA targets — all tunable
  knowledge_base.json      # seed KB articles for RAG-lite reply suggestions
prompts/                   # Prompt 1 (analysis) + Prompt 2 (reply) as text files
schema/airtable_schema.md  # all 7 tables, field types, views
samples/                   # 6 test emails with expected triage annotated
tests/                     # unit_tests.js + integration_tests.js (node, no framework)
dashboard/sentiment_dashboard.html   # bonus: sentiment trends (demo-data mode included)
docs/                      # Airtable audit automation + demo recording script
legacy_n8n/                # earlier n8n prototype exports (not used)
```

## Setup

### 1. Requirements

- Node.js ≥ 20
- An Airtable base built per `schema/airtable_schema.md` (7 tables; seed
  `ConfigTeamMapping` from the schema doc)
- A support mailbox reachable over IMAP/SMTP (for Gmail: enable 2FA and create
  an App Password)

### 2. Install & configure

```bash
npm install
cp .env.example .env   # then fill in the values
```

Required environment variables (`.env`):

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` **or** `ANTHROPIC_API_KEY` | LLM for Step 2 analysis + reply drafts — the provider is picked by whichever key is set (Gemini wins if both). Both clients share one interface (`src/services/gemini.js` / `claude.js`), so adding another provider is one file. |
| `GEMINI_MODEL` / `ANTHROPIC_MODEL` | optional, default `gemini-2.5-flash` / `claude-sonnet-5` |
| `AIRTABLE_API_KEY` | personal access token scoped to the support base only |
| `AIRTABLE_BASE_ID` | `app…` id of the base |
| `IMAP_HOST` / `IMAP_PORT` / `IMAP_USER` / `IMAP_PASSWORD` | support inbox |
| `IMAP_MAILBOX` | optional — watch a dedicated label/folder instead of INBOX (recommended for shared/personal accounts) |
| `IMAP_SINCE` | optional — only process mail received after this ISO date; empty = from service start; `all` = entire unread backlog |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | acknowledgment sending |
| `SLACK_WEBHOOK_URL` | optional — leave empty to disable notifications |

Behavioral tuning (keywords, category→team map, SLA targets, confidence
threshold, poll intervals) lives in `config/config.json` — no code changes
needed to re-route categories or adjust SLAs.

### 3. Run

```bash
npm start
```

This starts three loops in one process: the IMAP poll (every 60 s, unseen
messages only), the SLA sweep (every 15 min), and the webhook server
(`http://localhost:8788`). Processing is sequential by design to respect
Airtable's 5 req/s and LLM rate limits.

### 4. Airtable-side setup (one-time)

- **Audit trail** (Step 10): create the Airtable Automation from
  `docs/airtable_audit_automation.md` — logs every Status / Assigned Team /
  Priority / Internal Notes change to `AuditLog` with old and new values.
- **Suggest Reply button**: Button field opening
  `http://YOUR_HOST:8788/suggest-reply?record_id=` & `RECORD_ID()` — fills the
  ticket's `Suggested Reply` field via Claude + KB retrieval.
- **Agent views** (Step 9): Kanban grouped by Status for the lifecycle
  (Open → In Progress → Waiting for Customer → Resolved → Closed), grid views
  per Assigned Team, and a "Needs Review" filter. All AI fields are advisory
  and freely editable.

## How each requirement is met

| Step | Implementation |
|---|---|
| 1. Monitor inbox | `services/inbox.js` — IMAP poll, unseen-only, extracts sender name/email, subject, body, received time, attachments as base64. At-least-once + idempotency = no lost or double-processed mail. |
| 2. AI analysis | `services/claude.js` + `services/prompts.js` — strict-JSON Prompt 1, temperature 0; returns all 12 required fields incl. confidence score. |
| 3. Classification | The 9 allowed categories enforced by enum normalization — unknown AI output falls back to General Inquiry. |
| 4. Priority + justification | Hybrid: AI justification text + deterministic keyword/VIP floors in `lib/priorityRules.js`; `Priority Source` records ai vs business_rule_override. |
| 5. Validation | `lib/validate.js` — safe parse, missing-field defaults, category normalization, tag dedupe, email validation; malformed AI JSON → one repair-prompt retry, then safe defaults + review flag + raw output preserved in Internal Notes. |
| 6. Ticket creation | `services/airtableStore.js` — Status=Open; original email saved as `original_email.txt` + all attachments uploaded via Airtable's content API. |
| 7. Auto-assignment | Category→Team map from Airtable `ConfigTeamMapping` (cached), falling back to `config.json` — configurable in two layers, hardcoded in none. |
| 8. Acknowledgment | `services/mailer.js` — threaded reply with Ticket ID, summary, status, SLA estimate; `Ack Sent At` recorded. |
| 9. Agent review | Airtable UI — all fields editable; schema doc defines the views. |
| 10. Lifecycle + audit | Five statuses; every change captured in `AuditLog` (Airtable Automation in production, built into `localStore.js` for the demo). |

## Testing

```bash
npm test
```

- **Unit** (38 assertions): parsing, normalization, tag dedupe, email
  validation, confidence clamping, priority rules, duplicate matching, SLA
  math, priority bumping, PII redaction, KB ranking.
- **Integration** (11 scenarios): full pipeline with the local store — intake,
  routing, attachment persistence, duplicate append, messageId idempotency,
  malformed-AI degradation, ack failure handling, VIP override, SLA breach
  escalation, audit-trailed lifecycle, reply suggestion.

**Expected outcomes matrix** (verified by `npm run demo`):

| Sample | Category | Priority | Team | Notes |
|---|---|---|---|---|
| email_1_critical_outage | Technical Support | Critical | Technical Support | Slack alert fired |
| email_2_billing_complaint | Billing | High | Finance | Slack alert fired |
| email_3_sales_inquiry | Sales Inquiry | Low | Sales | no alert (by design) |
| email_4_feature_request | Feature Request | Low | Product Team | |
| email_5_duplicate | — | — | — | appended to email_1's ticket |
| email_6_ambiguous | Other | Low | Customer Success | Needs Manual Review = true |

The demo also exercises: re-delivery (skipped), forced-malformed AI JSON
(ticket still created, flagged), a backdated Critical ticket (SLA breach →
escalation), a full status walk (26 audit entries), and a KB-grounded reply
draft. Artifacts land in `demo_output/`.

## Error handling & resilience

| Failure | Behavior |
|---|---|
| LLM 429/5xx/network | Exponential backoff 5 s → 15 s → 45 s, then safe defaults + review flag |
| LLM invalid JSON | One repair-prompt retry, then defaults + raw output in Internal Notes |
| Airtable write | 2 retries with backoff; errors logged + Slack `#support-ops` alert |
| Attachment upload | Ticket continues text-only with a note |
| Ack email send | Ticket stays Open with "manual follow-up needed" note |
| Duplicate delivery | `Message ID` idempotency — exact re-fires are no-ops |
| Empty SLA sweep | Normal exit, not an error |

All error-log writes are **PII-redacted** (emails, phones, card-like numbers)
and truncated first.

## Security & privacy

- Credentials only in `.env` (git-ignored) — never in code, config, or logs.
- Airtable token scoped to the one base; Slack via single-purpose webhook.
- Customer text sanitized before embedding in Slack messages.
- Attachment binaries live only in Airtable's attachment field.
- Recommended retention policy: purge/redact tickets Closed > N days
  (documented, not enforced in v1).

## Scalability

- Sequential per-poll processing keeps within Airtable (5 req/s) and LLM rate
  limits; request spacing built into the Airtable client.
- Team-map lookups cached per process.
- Hundreds of emails/day fit one process comfortably (the bottleneck is one
  LLM call per email). Beyond that: split inbox → queue (e.g. Redis) → N
  workers; swap `AirtableStore` for Postgres/NocoDB behind the same interface
  (the local store proves the interface swap works).

## Assumptions

- Single shared support inbox; more inboxes = more `InboxMonitor` instances.
- Categories match the brief's list + "Other" catch-all.
- SLA targets (Critical 1 h / High 4 h / Medium 1 day / Low 2 days) are
  tunable defaults in config; business-day math approximated as calendar time in v1.
- VIP data comes from the `Customers` table; absent rows skip the rule.
- English-primary; non-English emails are normalized to English with a
  `Detected Language` field.
- Confidence threshold 0.6 for forced review is tunable.

## Bonus features

| Bonus | Status |
|---|---|
| AI reply suggestions | ✅ `/suggest-reply` webhook + Airtable button → `Suggested Reply` field |
| RAG knowledge base | ✅ keyword retrieval over `KnowledgeBase`, top-3 snippets into Prompt 2 |
| Duplicate detection | ✅ messageId idempotency + fuzzy match (7-day window) |
| SLA monitoring & escalation | ✅ 80% warning, breach → escalate + bump + alert |
| Slack notifications | ✅ priority-based ticket, escalation, and error alerts |
| Sentiment dashboard | ✅ `dashboard/sentiment_dashboard.html` (Airtable API or demo data) |
| Multi-language | ✅ language detection + English-normalized output |
| Retry & failure handling | ✅ table above |
| Logging & monitoring | ✅ ErrorLog + AuditLog + console logs |
| Unit & integration tests | ✅ 49 assertions, `npm test` |

## Demo recording

`docs/demo_script.md` is a 12-step shot list covering every point required in
the brief (ingestion → classification → creation → routing → ack → lifecycle →
error handling). `npm run demo` is the fastest way to show the full pipeline
on camera before switching to the live inbox/Airtable flow.
