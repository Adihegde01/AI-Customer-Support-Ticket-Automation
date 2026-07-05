'use strict';
// Step 1 — Monitor Support Inbox over IMAP (works with Gmail app passwords,
// Outlook, or any IMAP host). Polls for UNSEEN messages, parses metadata and
// attachments with mailparser, marks processed messages \Seen so a crash
// before marking means at-least-once delivery — the pipeline's messageId
// idempotency check makes that safe.
//
// Safety guards for shared/personal inboxes:
//  - `mailbox` can point at a dedicated label/folder (e.g. Gmail label
//    "support-inbox") instead of INBOX.
//  - `sinceDate` ignores anything received before it, so pointing the service
//    at a mailbox with a large unread backlog can't trigger a mass-ack storm.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

class InboxMonitor {
  constructor({ host, port, user, password, mailbox = 'INBOX', sinceDate = null, logger = console }) {
    this.config = { host, port: Number(port) || 993, secure: true, auth: { user, pass: password } };
    this.mailbox = mailbox;
    this.sinceDate = sinceDate; // Date | null (null = no cutoff)
    this.log = logger;
  }

  /** Fetch, parse, and mark-seen all unseen messages. Returns normalized emails. */
  async fetchNew() {
    const client = new ImapFlow({ ...this.config, logger: false });
    const emails = [];
    await client.connect();
    try {
      const lock = await client.getMailboxLock(this.mailbox);
      try {
        const criteria = { seen: false };
        if (this.sinceDate) criteria.since = this.sinceDate; // server-side, day granularity
        const uids = await client.search(criteria);
        for (const uid of uids || []) {
          const { content } = await client.download(uid);
          const parsed = await simpleParser(content);
          // Precise client-side cutoff (IMAP `since` is day-granular)
          if (this.sinceDate && parsed.date && parsed.date < this.sinceDate) {
            continue; // leave unseen; predates the cutoff
          }
          emails.push(this._normalize(parsed, uid));
          await client.messageFlagsAdd(uid, ['\\Seen']);
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
    return emails;
  }

  _normalize(parsed, uid) {
    const from = parsed.from?.value?.[0] || {};
    return {
      senderName: from.name || '',
      senderEmail: from.address || '',
      subject: parsed.subject || '(no subject)',
      body: parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ') || '',
      receivedAt: (parsed.date || new Date()).toISOString(),
      messageId: parsed.messageId || `imap-uid-${uid}-${Date.now()}`,
      inReplyTo: parsed.messageId || null,
      attachments: (parsed.attachments || []).map((a) => ({
        filename: a.filename || 'attachment.bin',
        mimeType: a.contentType || 'application/octet-stream',
        contentBase64: a.content.toString('base64'),
      })),
    };
  }
}

module.exports = { InboxMonitor };
