# Ticket Lifecycle Audit Trail (Airtable Automation)

The audit trail runs **natively inside Airtable** rather than in the Node
service — Airtable's "When record updated" trigger fires on every field change
(including manual agent edits in the UI), which an external poller could miss
between polls. (In the offline demo, `localStore.js` provides the equivalent
audit trail itself.)

## Setup (one automation, ~2 minutes)

1. In the Support base, open **Automations → Create automation**.
2. **Trigger:** "When record updated"
   - Table: `Tickets`
   - Watched fields: `Status`, `Assigned Team`, `Priority`, `Internal Notes`
3. **Action:** "Run script", paste the script below.
4. Add these **input variables** (left panel of the script editor), all from the
   trigger record:

   | Variable name | Value (from trigger) |
   |---|---|
   | `recordId` | Airtable record ID |
   | `ticketId` | Ticket ID |
   | `status` | Status |
   | `assignedTeam` | Assigned Team |
   | `priority` | Priority |
   | `internalNotes` | Internal Notes |

5. Turn the automation **on**.

## Script (paste into the "Run script" action)

```javascript
// Audit trail: append one AuditLog row per changed watched field.
// Old values come from a "Last Audited *" shadow snapshot stored on the
// ticket itself, since Airtable automations don't expose previous values.
const input_ = input.config();
const tickets = base.getTable('Tickets');
const auditLog = base.getTable('AuditLog');

const record = await tickets.selectRecordAsync(input_.recordId, {
  fields: [
    'Last Audited Status', 'Last Audited Team',
    'Last Audited Priority', 'Last Audited Notes',
  ],
});

const watched = [
  { field: 'Status',        now: input_.status,       shadow: 'Last Audited Status' },
  { field: 'Assigned Team', now: input_.assignedTeam, shadow: 'Last Audited Team' },
  { field: 'Priority',      now: input_.priority,     shadow: 'Last Audited Priority' },
  { field: 'Internal Notes',now: input_.internalNotes,shadow: 'Last Audited Notes' },
];

const shadowUpdate = {};
for (const w of watched) {
  const oldValue = record.getCellValueAsString(w.shadow);
  const newValue = w.now == null ? '' : String(w.now);
  if (oldValue !== newValue) {
    await auditLog.createRecordAsync({
      'Ticket ID': input_.ticketId,
      'Field Changed': w.field,
      'Old Value': oldValue,
      'New Value': newValue,
      // 'Changed By' is best-effort: Airtable scripting has no editor identity;
      // use a "Last Modified By" field on Tickets if collaborator data is needed.
    });
    shadowUpdate[w.shadow] = newValue;
  }
}

if (Object.keys(shadowUpdate).length) {
  await tickets.updateRecordAsync(input_.recordId, shadowUpdate);
}
```

## Extra fields required on `Tickets`

Add four hidden single-line/long-text fields used only as snapshots:
`Last Audited Status`, `Last Audited Team`, `Last Audited Priority`,
`Last Audited Notes`. Hide them from agent views.

For attributing changes to a person, add a native **Last Modified By** field per
watched column and include it in the script's created row — Airtable tracks the
collaborator automatically; the script cannot.

## "Suggest Reply" button (pairs with the webhook server)

Add a **Button** field on `Tickets`:

- Label: `Suggest Reply`
- Action: *Open URL*
- URL formula (replace host with wherever `npm start` runs; port is
  `webhookPort` in config/config.json):

```
"http://YOUR_HOST:8788/suggest-reply?record_id=" & RECORD_ID()
```

Note: the button opens as a GET request; the webhook (src/server.js) accepts
`record_id` from either the query string or a POST body, so both the button
and programmatic calls work.
