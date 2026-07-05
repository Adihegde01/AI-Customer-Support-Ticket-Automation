'use strict';
// Step 8 — Customer acknowledgment over SMTP, threaded onto the original
// email via In-Reply-To/References headers.

const nodemailer = require('nodemailer');

class SmtpMailer {
  constructor({ host, port, user, password, from }) {
    this.from = from || user;
    this.transport = nodemailer.createTransport({
      host,
      port: Number(port) || 465,
      secure: Number(port) !== 587,
      auth: { user, pass: password },
    });
  }

  async sendAck({ to, subject, body, inReplyTo }) {
    await this.transport.sendMail({
      from: this.from,
      to,
      subject,
      text: body,
      inReplyTo: inReplyTo || undefined,
      references: inReplyTo || undefined,
    });
  }
}

/** Demo/test double: records sends and prints them instead of using SMTP. */
class ConsoleMailer {
  constructor() {
    this.sent = [];
  }
  async sendAck(msg) {
    this.sent.push(msg);
    console.log(`  [ack email → ${msg.to}] ${msg.subject}`);
  }
}

function buildAckEmail({ ticketId, customerName, issueSummary, assignedTeam, slaEstimate, companyName }) {
  const name = customerName && customerName !== 'Unknown' ? customerName : 'there';
  return {
    subject: `We've received your request — Ticket #${ticketId}`,
    body: `Hi ${name},

Thanks for reaching out. This confirms we've received your request:

Ticket ID: ${ticketId}
Summary: ${issueSummary}
Status: Open
Estimated first response: ${slaEstimate}

Our ${assignedTeam} team will follow up shortly. You can reply directly to
this email to add more details.

Best regards,
${companyName} Support Team`,
  };
}

module.exports = { SmtpMailer, ConsoleMailer, buildAckEmail };
