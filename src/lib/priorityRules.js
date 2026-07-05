'use strict';
// Step 4 — Priority Detection, deterministic half of the hybrid:
// AI assigns priority + justification; keyword and VIP rules enforce floors.
// `priority_source` records whether a rule overrode the AI so every ticket's
// priority is justified and auditable.

function applyPriorityRules(aiPriority, combinedText, vipFlag, cfg) {
  let priority = aiPriority;
  const bodyLower = String(combinedText || '').toLowerCase();

  if (cfg.criticalKeywords.some((k) => bodyLower.includes(k))) {
    priority = 'Critical';
  } else if (cfg.highKeywords.some((k) => bodyLower.includes(k)) && priority === 'Medium') {
    priority = 'High';
  }

  if (vipFlag === true && priority === 'Low') priority = 'Medium';

  return {
    priority,
    priority_source: priority !== aiPriority ? 'business_rule_override' : 'ai',
  };
}

module.exports = { applyPriorityRules };
