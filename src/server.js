'use strict';
// Bonus — webhook server for AI reply suggestions (Prompt 2 + RAG-lite).
// GET or POST /suggest-reply?record_id=recXXX — wired to an Airtable button
// (see docs/airtable_audit_automation.md). Also serves /healthz.

const http = require('node:http');
const { rankKb, buildRagContext } = require('./lib/kb');

async function suggestReply(recordId, { store, llm, cfg }) {
  const ticket = await store.getTicket(recordId);
  const f = ticket.fields;
  const kb = await store.listKnowledgeBase();
  const ranked = rankKb(
    `${f['Issue Summary'] || ''} ${f['Detailed Description'] || ''} ${f['Category'] || ''}`,
    kb
  );
  const draft = await llm.suggestReply({
    category: f['Category'] || cfg.defaults.category,
    priority: f['Priority'] || cfg.defaults.priority,
    detailedDescription: f['Detailed Description'] || f['Issue Summary'] || '',
    ragContext: buildRagContext(ranked),
  });
  await store.updateTicket(recordId, { 'Suggested Reply': draft });
  return {
    ok: true,
    ticket_id: f['Ticket ID'] || recordId,
    kb_articles_used: ranked.map((r) => r.article.title),
    suggested_reply: draft,
  };
}

function createServer(deps) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const respond = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (url.pathname === '/healthz') return respond(200, { ok: true });
      if (url.pathname === '/suggest-reply') {
        let recordId = url.searchParams.get('record_id');
        if (!recordId && req.method === 'POST') {
          const body = await new Promise((resolve) => {
            let data = '';
            req.on('data', (c) => (data += c));
            req.on('end', () => resolve(data));
          });
          try { recordId = JSON.parse(body || '{}').record_id; } catch { /* fall through */ }
        }
        if (!recordId) return respond(400, { ok: false, error: 'record_id required' });
        return respond(200, await suggestReply(recordId, deps));
      }
      respond(404, { ok: false, error: 'not found' });
    } catch (e) {
      respond(500, { ok: false, error: e.message });
    }
  });
}

module.exports = { createServer, suggestReply };
