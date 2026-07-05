# Airtable Schema — Support Ticket Automation

Base name suggestion: **Support Ticket Automation** (restrict the API token's scope to this base only).

## Table: `Tickets` (primary)

All 30 fields below are created automatically by the setup script. Fields marked **AI** are populated by Gemini/Claude analysis. Fields marked **Agent** are intended for human review and editing.

| Field | Type | Source | Notes |
|---|---|---|---|
| Ticket ID | Single line text | System | Auto-assigned `TKT-NNN` sequence |
| Message ID | Single line text | System | Gmail Message-ID — idempotency key, prevents double-processing |
| Sender Name | Single line text | Email | From header |
| Sender Email | Email | Email | Always from metadata, never AI-guessed |
| Customer Name | Single line text | AI | Extracted from email signature/body |
| Company | Single line text | AI | Organisation, if mentioned |
| Email Subject | Single line text | Email | Raw subject line |
| Email Body | Long text | Email | Full original message, unmodified |
| Issue Summary | Long text | AI | 1-sentence summary |
| Detailed Description | Long text | AI | 2–4 sentence paraphrase |
| Category | Single select | AI | Technical Support / Billing / Sales Inquiry / Feature Request / Bug Report / Account Access / Refund Request / General Inquiry / Other |
| Priority | Single select | AI + Rules | Critical / High / Medium / Low |
| Priority Justification | Long text | AI | Reasoning behind priority choice |
| Priority Source | Single line text | System | `ai` or `business_rule_override` |
| Sentiment | Single select | AI | Positive / Neutral / Negative |
| Product/Service | Single line text | AI | Affected product or service |
| Suggested Department | Single line text | AI | AI's department recommendation |
| Tags | Long text | AI | Comma-separated, deduplicated |
| Confidence Score | Number (0–1, precision 2) | AI | Overall triage confidence |
| Needs Manual Review | Checkbox | System | True if confidence < 0.6 or AI parse failed |
| Assigned Team | Single line text | System | Resolved from Category→Team map |
| Status | Single select | Agent | Open / In Progress / Waiting for Customer / Resolved / Closed — default: Open |
| Internal Notes | Long text | Agent | Free-text agent notes; also stores raw AI output on parse failure |
| Attachments | Attachment | Email | original_email.txt + any file attachments |
| Escalated | Checkbox | System | Set by SLA monitor on breach |
| VIP Flag | Checkbox | System | Copied from Customers table at intake |
| Ack Sent At | Date/time | System | When acknowledgement email was sent |
| Last Updated | Date/time | System | Last field modification timestamp |
| Received At | Date/time | Email | Original email timestamp |
| Detected Language | Single line text | AI | ISO 639-1 code (e.g. `en`, `fr`) |

### Recommended views
- **Kanban by Status** — agent lifecycle board (Open → In Progress → Waiting for Customer → Resolved → Closed)
- **Grid by Assigned Team** — one filtered view per team queue
- **Needs Review** — filter `Needs Manual Review = TRUE()`
- **Ticket Dashboard** — open `dashboard/ticket_dashboard.html` for charts, KPIs, full-text search, and per-ticket drawer

## Table: `ConfigTeamMapping`

Category → Team routing, editable by business users without touching code.

| Category (Single select, primary) | Assigned Team (Single select) |
|---|---|
| Technical Support | Technical Support |
| Bug Report | Technical Support |
| Billing | Finance |
| Refund Request | Finance |
| Sales Inquiry | Sales |
| Account Access | Customer Success |
| Feature Request | Product Team |
| General Inquiry | Customer Success |
| Other | Customer Success |

Unmapped categories fall back to **Customer Success** in the workflow code.

## Table: `SLATargets`

| Priority (Single select, primary) | Target Response (Duration/text) | Minutes (Number) |
|---|---|---|
| Critical | 1 hour | 60 |
| High | 4 hours | 240 |
| Medium | 1 business day | 1440 |
| Low | 2 business days | 2880 |

v1 note: the SLA monitor ships with these values in config/config.json for
fewer API calls; swap in an Airtable lookup if targets must be editable live.

## Table: `Customers`

| Field | Type |
|---|---|
| Email (primary) | Email |
| Company | Single line text |
| Account Tier | Single select: Free / Pro / Enterprise |
| VIP Flag | Checkbox |

If a sender has no row here, the VIP override is skipped gracefully.

## Table: `AuditLog`

Populated by an **Airtable Automation** ("When record updated" on `Tickets`,
watching Status / Assigned Team / Priority / Internal Notes) that creates a row here:

| Field | Type |
|---|---|
| Ticket ID | Single line text |
| Field Changed | Single line text |
| Old Value | Long text |
| New Value | Long text |
| Changed By | Single line text (collaborator if available) |
| Timestamp | Created time |

## Table: `ErrorLog`

Written by the error logger (src/pipeline.js safeLogError; payloads PII-redacted and truncated):

| Field | Type |
|---|---|
| Workflow | Single line text |
| Node | Single line text |
| Error Message | Long text |
| Payload Snapshot | Long text |
| Severity | Single select: transient / persistent |
| Timestamp | Date/time |

## Table: `KnowledgeBase` (bonus, for RAG)

| Field | Type |
|---|---|
| Article Title (primary) | Single line text |
| Content | Long text |
| Tags | Multi-select |
