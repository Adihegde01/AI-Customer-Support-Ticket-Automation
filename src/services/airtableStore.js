'use strict';
// Step 6 — Ticket storage on Airtable via REST.
// Respects the 5 req/s base limit with simple request spacing, retries writes
// twice (plan §9), and uploads attachments through Airtable's content API —
// including the original email as a .txt attachment.

const { redact } = require('../lib/redact');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AirtableStore {
  constructor({ apiKey, baseId, fetchImpl = fetch, minRequestSpacingMs = 220 }) {
    if (!apiKey || !baseId) throw new Error('AIRTABLE_API_KEY and AIRTABLE_BASE_ID are required');
    this.apiKey = apiKey;
    this.baseId = baseId;
    this.fetch = fetchImpl;
    this.minSpacing = minRequestSpacingMs;
    this._lastRequestAt = 0;
    this._teamMapCache = null;
  }

  async _request(url, options = {}, retries = 2) {
    const wait = this._lastRequestAt + this.minSpacing - Date.now();
    if (wait > 0) await sleep(wait);
    this._lastRequestAt = Date.now();
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
      if (res.ok) return res.json();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) {
        throw new Error(`Airtable ${res.status} ${url.split('?')[0]}: ${(await res.text()).slice(0, 300)}`);
      }
      await sleep(attempt === 0 ? 5000 : 15000);
    }
  }

  _tableUrl(table, params) {
    const qs = params ? `?${params}` : '';
    return `https://api.airtable.com/v0/${this.baseId}/${encodeURIComponent(table)}${qs}`;
  }

  async _select(table, filterByFormula, fields = []) {
    let records = [];
    let offset = '';
    do {
      const params = new URLSearchParams();
      if (filterByFormula) params.set('filterByFormula', filterByFormula);
      fields.forEach((f) => params.append('fields[]', f));
      params.set('pageSize', '100');
      if (offset) params.set('offset', offset);
      const page = await this._request(this._tableUrl(table, params.toString()));
      records = records.concat(page.records || []);
      offset = page.offset || '';
    } while (offset);
    return records;
  }

  // ---- tickets ----

  async findByMessageId(messageId) {
    const recs = await this._select('Tickets', `{Message ID} = "${messageId}"`, ['Ticket ID']);
    return recs[0] ? { id: recs[0].id, ticketId: recs[0].fields['Ticket ID'] } : null;
  }

  async findOpenTicketsBySender(senderEmail, sinceDays) {
    const formula = `AND(OR({Status} = "Open", {Status} = "In Progress"), IS_AFTER({Received At}, DATEADD(NOW(), -${sinceDays}, "days")), LOWER({Sender Email}) = LOWER("${senderEmail}"))`;
    const recs = await this._select('Tickets', formula, [
      'Ticket ID', 'Message ID', 'Issue Summary', 'Email Subject', 'Internal Notes',
    ]);
    return recs.map((r) => ({
      id: r.id,
      ticketId: r.fields['Ticket ID'],
      messageId: r.fields['Message ID'],
      issueSummary: r.fields['Issue Summary'],
      emailSubject: r.fields['Email Subject'],
      internalNotes: r.fields['Internal Notes'] || '',
    }));
  }

  async createTicket(fields) {
    const data = await this._request(this._tableUrl('Tickets'), {
      method: 'POST',
      body: JSON.stringify({ fields, typecast: true }),
    });
    return { id: data.id, ticketId: data.fields['Ticket ID'] || data.id };
  }

  async updateTicket(id, fields) {
    await this._request(`${this._tableUrl('Tickets')}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields, typecast: true }),
    });
  }

  async getTicket(id) {
    const data = await this._request(`${this._tableUrl('Tickets')}/${id}`);
    return { id: data.id, fields: data.fields };
  }

  async appendNote(id, note) {
    const t = await this.getTicket(id);
    const existing = t.fields['Internal Notes'] || '';
    await this.updateTicket(id, { 'Internal Notes': `${existing}\n\n${note}`.trim() });
  }

  /** attachments: [{ filename, contentBase64, mimeType }] via the content API. */
  async attachFiles(id, attachments) {
    for (const att of attachments) {
      await this._request(
        `https://content.airtable.com/v0/${this.baseId}/${id}/${encodeURIComponent('Attachments')}/uploadAttachment`,
        {
          method: 'POST',
          body: JSON.stringify({
            contentType: att.mimeType || 'application/octet-stream',
            file: att.contentBase64,
            filename: att.filename,
          }),
        }
      );
    }
  }

  async listOpenForSla() {
    const formula = 'AND(OR({Status} = "Open", {Status} = "In Progress", {Status} = "Waiting for Customer"), {Escalated} = FALSE())';
    const recs = await this._select('Tickets', formula, [
      'Ticket ID', 'Priority', 'Assigned Team', 'Issue Summary', 'Received At',
    ]);
    return recs
      .filter((r) => r.fields['Received At'])
      .map((r) => ({
        id: r.id,
        ticketId: r.fields['Ticket ID'],
        priority: r.fields['Priority'] || 'Medium',
        assignedTeam: r.fields['Assigned Team'] || '',
        issueSummary: r.fields['Issue Summary'] || '',
        receivedAt: new Date(r.fields['Received At']).getTime(),
      }));
  }

  // ---- config / lookups ----

  async getCustomerVip(email) {
    if (!email) return false;
    const recs = await this._select('Customers', `LOWER({Email}) = LOWER("${email}")`, ['VIP Flag']);
    return recs[0]?.fields['VIP Flag'] === true;
  }

  /** Configurable Category → Team map, cached per process (plan §11). */
  async getTeamMap() {
    if (!this._teamMapCache) {
      const recs = await this._select('ConfigTeamMapping', '', ['Category', 'Assigned Team']);
      this._teamMapCache = Object.fromEntries(
        recs.map((r) => [r.fields['Category'], r.fields['Assigned Team']]).filter(([k, v]) => k && v)
      );
    }
    return this._teamMapCache;
  }

  async listKnowledgeBase() {
    const recs = await this._select('KnowledgeBase', '', ['Article Title', 'Content', 'Tags']);
    return recs.map((r) => ({
      title: r.fields['Article Title'] || '',
      content: r.fields['Content'] || '',
      tags: r.fields['Tags'] || [],
    }));
  }

  async logError(entry) {
    await this._request(this._tableUrl('ErrorLog'), {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          Workflow: entry.workflow,
          Node: entry.step,
          'Error Message': redact(entry.message).slice(0, 1000),
          'Payload Snapshot': redact(entry.payload || '').slice(0, 2000),
          Severity: entry.severity || 'persistent',
          Timestamp: new Date().toISOString(),
        },
        typecast: true,
      }),
    });
  }
}

module.exports = { AirtableStore };
