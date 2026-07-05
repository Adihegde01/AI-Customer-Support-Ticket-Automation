'use strict';
// Bonus — scheduled SLA sweep: warn at 80% of target, on breach set
// Escalated + bump priority one level, and alert the team lead channel.
// Finding no tickets past threshold is a normal exit, not an error.

const { slaState, bumpPriority } = require('./lib/sla');

async function checkSla({ store, slack, cfg, log = console, now = Date.now() }) {
  const open = await store.listOpenForSla();
  const flagged = [];
  for (const t of open) {
    const state = slaState(t.priority, t.receivedAt, now, cfg);
    if (!state.flagged) continue;
    const newPriority = state.breached ? bumpPriority(t.priority, cfg.priorities) : t.priority;
    if (state.breached) {
      await store.updateTicket(t.id, { Escalated: true, Priority: newPriority });
    }
    try {
      await slack.escalationAlert({
        ticketId: t.ticketId,
        breached: state.breached,
        priority: newPriority,
        assignedTeam: t.assignedTeam,
        ageMinutes: state.age_minutes,
        targetMinutes: state.target_minutes,
        issueSummary: t.issueSummary,
      });
    } catch (e) {
      log.warn(`  slack escalation alert failed: ${e.message}`);
    }
    flagged.push({ ticketId: t.ticketId, ...state, newPriority });
    log.info(`  SLA ${state.breached ? 'BREACH' : 'warning'}: ${t.ticketId} age ${state.age_minutes}m / target ${state.target_minutes}m`);
  }
  return flagged;
}

module.exports = { checkSla };
