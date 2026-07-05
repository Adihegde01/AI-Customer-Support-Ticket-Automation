# Demo Recording Script (5–10 min)

A step-by-step shot list covering every evaluation criterion in the brief.

## Setup (before recording)
Have these ready in separate windows/tabs:
1. **Terminal** — in `/automation/` directory
2. **Airtable** — open `Tickets` table (Kanban view by Status)
3. **Ticket Dashboard** — `dashboard/ticket_dashboard.html` open in browser
4. **Gmail** — `hegdeadi01@gmail.com` inbox (to send + receive test emails)
5. **Text editor** — have `samples/email_1_critical_outage.txt` ready to copy

---

## Scene 1 — Test Suite (45 sec)
```bash
npm test
```
Show: 49 assertions, exit 0. Proves unit + integration coverage.

## Scene 2 — Offline Demo (1 min)
```bash
npm run demo
```
Show the results table:
- 6 sample emails triaged with category / priority / team
- Duplicate email appended (not double-processed)
- Idempotency skip logged
- Forced-AI-failure ticket still created (Needs Manual Review = true)
- SLA breach escalation triggered

## Scene 3 — Live Email Ingestion (1 min)
1. Show terminal: `npm start` is running
2. Send **email_1_critical_outage.txt** contents to `hegdeadi01@gmail.com` from any address
3. Wait up to 60 s — show terminal: `[inbox] 1 new email(s)` → pipeline log line

## Scene 4 — AI Classification (30 sec)
Point at the log line showing:
- `created TKT-XXX: Technical Support / Critical (ai) → Technical Support`
- Confidence score, sentiment

## Scene 5 — Ticket Creation in Airtable (1 min)
Switch to Airtable Tickets grid:
- New row: TKT-XXX, Status = Open
- Expand record: show Customer Name, Company, Issue Summary, Detailed Description, Tags, Confidence Score, Priority Justification
- Show Attachments tab: `original_email.txt` uploaded

## Scene 6 — Automatic Routing (30 sec)
Show `Assigned Team = Technical Support` set automatically.
Open `config/config.json` → show `teamMap` section.
Open `ConfigTeamMapping` table in Airtable — show it's data-driven, no code changes needed.

## Scene 7 — Acknowledgement Email (30 sec)
Switch to Gmail inbox — show auto-reply received with:
- Ticket ID
- Issue Summary
- Status: Open
- Estimated Response Time

Show `Ack Sent At` field set in Airtable.

## Scene 8 — Ticket Dashboard (30 sec)
Switch to `dashboard/ticket_dashboard.html`:
- KPI cards: Total, Open, Critical/High, Negative Sentiment, Avg Confidence, Needs Review
- Priority donut chart, Status pipeline chart, Category bar chart
- Filter by Priority = Critical — table filters live
- Click the new ticket row — slide-in drawer shows all 30 fields

## Scene 9 — Ticket Lifecycle / Agent Review (1 min)
In Airtable, as an agent:
1. Edit Priority from Critical → High (show audit trail in AuditLog table)
2. Add Internal Note: "Investigating server logs"
3. Drag ticket across Kanban: Open → In Progress → Waiting for Customer → Resolved → Closed
4. Show AuditLog — every status change captured with old/new values

## Scene 10 — Duplicate Detection (30 sec)
Send **email_5_duplicate.txt** to the inbox.
Show terminal: `duplicate of TKT-XXX (fuzzy_match) — appended to existing ticket`
No new ticket created. Open original ticket → Internal Notes shows the follow-up body appended.

## Scene 11 — Error Handling (1 min)
1. Stop the service
2. Set a bad API key: `GEMINI_API_KEY=invalid`
3. Restart: `npm start`
4. Send any email
5. Show terminal: backoff retries logged (5s → 15s → 45s)
6. Show Airtable: ticket still created with `Needs Manual Review = true`, raw AI error in Internal Notes
7. Show ErrorLog table — error captured with severity + timestamp
8. Reset the real API key and restart

## Scene 12 — Sentiment Dashboard (30 sec)
Open `dashboard/sentiment_dashboard.html`:
- Weekly sentiment trend chart
- Category-by-sentiment stacked chart
- Negative-sentiment hotspots

---

## Total runtime: ~8–9 minutes
