'use strict';
// Bonus — SLA monitoring: near-breach at nearBreachRatio (default 80%),
// breach at 100%; breached tickets get bumped one priority level.

function slaState(priority, receivedAtMs, nowMs, cfg) {
  const targetMin = cfg.slaTargetsMinutes[priority] || cfg.slaTargetsMinutes.Medium;
  const ageMinutes = (nowMs - receivedAtMs) / 60000;
  const ratio = ageMinutes / targetMin;
  return {
    breached: ratio >= 1,
    near_breach: ratio >= cfg.nearBreachRatio && ratio < 1,
    flagged: ratio >= cfg.nearBreachRatio,
    age_minutes: Math.round(ageMinutes),
    target_minutes: targetMin,
  };
}

function bumpPriority(priority, priorities) {
  const order = [...priorities].reverse(); // config lists high→low; we need low→high
  const idx = order.indexOf(priority);
  if (idx === -1) return 'Medium';
  return order[Math.min(idx + 1, order.length - 1)];
}

module.exports = { slaState, bumpPriority };
