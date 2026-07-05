'use strict';
// Bonus — Slack notifications via incoming webhook. Disabled gracefully when
// no webhook URL is configured. Customer-supplied text is sanitized before
// being embedded (Security §10).

const { sanitizeForSlack } = require('../lib/redact');

class SlackNotifier {
  constructor({ webhookUrl, fetchImpl = fetch }) {
    this.webhookUrl = webhookUrl || null;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return !!this.webhookUrl;
  }

  async post(text) {
    if (!this.enabled) return;
    const res = await this.fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slack webhook ${res.status}`);
  }

  async ticketAlert({ ticketId, priority, issueSummary, assignedTeam, sentiment }) {
    await this.post(
      `:rotating_light: *${priority} ticket* ${ticketId}\n*Summary:* ${sanitizeForSlack(issueSummary)}\n*Team:* ${assignedTeam} | *Sentiment:* ${sentiment}`
    );
  }

  async escalationAlert({ ticketId, breached, priority, assignedTeam, ageMinutes, targetMinutes, issueSummary }) {
    await this.post(
      `:hourglass_flowing_sand: *SLA ${breached ? 'BREACH' : 'warning (80%)'}* — Ticket ${ticketId}\n*Summary:* ${sanitizeForSlack(issueSummary)}\n*Priority:* ${priority} | *Team:* ${assignedTeam}\n*Age:* ${ageMinutes} min (target ${targetMinutes} min)`
    );
  }

  async errorAlert({ workflow, step, message, severity }) {
    await this.post(
      `:warning: *Automation error* [${severity}]\n*Component:* ${workflow} / ${step}\n*Error:* ${sanitizeForSlack(message)}`
    );
  }
}

/** Demo/test double: records alerts and prints them. */
class ConsoleSlack extends SlackNotifier {
  constructor() {
    super({ webhookUrl: 'console' });
    this.posts = [];
  }
  async post(text) {
    this.posts.push(text);
    console.log(`  [slack] ${text.split('\n')[0]}`);
  }
}

module.exports = { SlackNotifier, ConsoleSlack };
