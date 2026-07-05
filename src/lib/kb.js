'use strict';
// Bonus — RAG-lite retrieval: rank knowledge-base articles by unique-token
// overlap with the ticket text, inject top 3 into the reply prompt.

function rankKb(queryText, articles, topN = 3) {
  const tokens = (s) =>
    String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
  const qSet = new Set(tokens(queryText));
  return articles
    .map((a) => {
      const docTokens = tokens(`${a.title} ${a.content} ${(a.tags || []).join(' ')}`);
      const seen = new Set();
      let hits = 0;
      for (const t of docTokens) {
        if (qSet.has(t) && !seen.has(t)) { hits++; seen.add(t); }
      }
      return { article: a, score: qSet.size ? hits / qSet.size : 0 };
    })
    .filter((s) => s.score > 0.05)
    .sort((x, y) => y.score - x.score)
    .slice(0, topN);
}

function buildRagContext(ranked) {
  if (!ranked.length) return '(no relevant knowledge base articles found)';
  return ranked
    .map((s) => `[${s.article.title}]\n${String(s.article.content).slice(0, 800)}`)
    .join('\n\n---\n\n');
}

module.exports = { rankKb, buildRagContext };
