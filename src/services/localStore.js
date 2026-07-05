'use strict';
// Offline store with the same interface as AirtableStore, backed by JSON
// files. Used by `npm run demo` and integration tests so the whole pipeline
// runs locally with zero external accounts. Also keeps a built-in audit
// trail: every field change on updateTicket appends to audit_log.json
// (Step 10 — in Airtable mode this is handled by the Airtable Automation in
// docs/airtable_audit_automation.md).

const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('../lib/redact');

class LocalJsonStore {
  constructor({ dir, customers = {}, knowledgeBase = [], teamMap = null }) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
    this.tickets = [];
    this.errors = [];
    this.audit = [];
    this.customers = customers; // { email: { vip: true } }
    this.kb = knowledgeBase;
    this.teamMap = teamMap;
    this._seq = 0;
  }

  _persist() {
    fs.writeFileSync(path.join(this.dir, 'tickets.json'), JSON.stringify(this.tickets, null, 2));
    fs.writeFileSync(path.join(this.dir, 'error_log.json'), JSON.stringify(this.errors, null, 2));
    fs.writeFileSync(path.join(this.dir, 'audit_log.json'), JSON.stringify(this.audit, null, 2));
  }

  async findByMessageId(messageId) {
    const t = this.tickets.find((x) => x.fields['Message ID'] === messageId);
    return t ? { id: t.id, ticketId: t.fields['Ticket ID'] } : null;
  }

  async findOpenTicketsBySender(senderEmail, sinceDays) {
    const cutoff = Date.now() - sinceDays * 86400000;
    return this.tickets
      .filter((t) =>
        ['Open', 'In Progress'].includes(t.fields['Status']) &&
        String(t.fields['Sender Email'] || '').toLowerCase() === String(senderEmail || '').toLowerCase() &&
        new Date(t.fields['Received At']).getTime() >= cutoff
      )
      .map((t) => ({
        id: t.id,
        ticketId: t.fields['Ticket ID'],
        messageId: t.fields['Message ID'],
        issueSummary: t.fields['Issue Summary'],
        emailSubject: t.fields['Email Subject'],
        internalNotes: t.fields['Internal Notes'] || '',
      }));
  }

  async createTicket(fields) {
    this._seq += 1;
    const ticketId = `TCKT-${String(this._seq).padStart(4, '0')}`;
    const record = {
      id: `rec_local_${this._seq}`,
      fields: { 'Ticket ID': ticketId, 'Last Updated': new Date().toISOString(), ...fields },
    };
    this.tickets.push(record);
    this._audit(ticketId, 'Ticket', '', `created (Status=${fields.Status})`);
    this._persist();
    return { id: record.id, ticketId };
  }

  async updateTicket(id, fields) {
    const t = this.tickets.find((x) => x.id === id);
    if (!t) throw new Error(`LocalStore: no ticket ${id}`);
    for (const [k, v] of Object.entries(fields)) {
      const oldVal = t.fields[k];
      if (JSON.stringify(oldVal) !== JSON.stringify(v)) {
        this._audit(t.fields['Ticket ID'], k, oldVal ?? '', v);
        t.fields[k] = v;
      }
    }
    t.fields['Last Updated'] = new Date().toISOString();
    this._persist();
  }

  async getTicket(id) {
    const t = this.tickets.find((x) => x.id === id);
    if (!t) throw new Error(`LocalStore: no ticket ${id}`);
    return { id: t.id, fields: { ...t.fields } };
  }

  async appendNote(id, note) {
    const t = await this.getTicket(id);
    await this.updateTicket(id, { 'Internal Notes': `${t.fields['Internal Notes'] || ''}\n\n${note}`.trim() });
  }

  async attachFiles(id, attachments) {
    const t = await this.getTicket(id);
    const dir = path.join(this.dir, 'attachments', t.fields['Ticket ID']);
    fs.mkdirSync(dir, { recursive: true });
    const saved = [];
    for (const att of attachments) {
      const safeName = att.filename.replace(/[^\w.-]/g, '_');
      fs.writeFileSync(path.join(dir, safeName), Buffer.from(att.contentBase64, 'base64'));
      saved.push(safeName);
    }
    await this.updateTicket(id, {
      Attachments: [...(t.fields.Attachments || []), ...saved.map((f) => `attachments/${t.fields['Ticket ID']}/${f}`)],
    });
  }

  async listOpenForSla() {
    return this.tickets
      .filter((t) =>
        ['Open', 'In Progress', 'Waiting for Customer'].includes(t.fields['Status']) &&
        !t.fields['Escalated'] && t.fields['Received At']
      )
      .map((t) => ({
        id: t.id,
        ticketId: t.fields['Ticket ID'],
        priority: t.fields['Priority'] || 'Medium',
        assignedTeam: t.fields['Assigned Team'] || '',
        issueSummary: t.fields['Issue Summary'] || '',
        receivedAt: new Date(t.fields['Received At']).getTime(),
      }));
  }

  async getCustomerVip(email) {
    return this.customers[String(email || '').toLowerCase()]?.vip === true;
  }

  async getTeamMap() {
    return this.teamMap; // null → pipeline falls back to config.teamMap
  }

  async listKnowledgeBase() {
    return this.kb;
  }

  async logError(entry) {
    this.errors.push({
      workflow: entry.workflow,
      step: entry.step,
      message: redact(entry.message).slice(0, 1000),
      payload: redact(entry.payload || '').slice(0, 2000),
      severity: entry.severity || 'persistent',
      timestamp: new Date().toISOString(),
    });
    this._persist();
  }

  _audit(ticketId, field, oldValue, newValue) {
    this.audit.push({
      ticketId,
      fieldChanged: field,
      oldValue: String(oldValue).slice(0, 500),
      newValue: String(newValue).slice(0, 500),
      changedBy: 'automation',
      timestamp: new Date().toISOString(),
    });
  }
}

module.exports = { LocalJsonStore };
