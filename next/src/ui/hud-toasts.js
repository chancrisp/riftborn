// The toast budget (IMPROVEMENTS §1.4): priority-1 toasts (first-encounter hazards, codex NEW
// ENTRY, elite arrivals, relic grants, unlocks) share a budget of one per 4 s of sim time. Extra
// ones wait in a queue of at most 3 (the oldest gives way) and are dropped after waiting 8 s.
// Priority >= 2 toasts, and toasts that name no priority, never touch it.
export const TOAST_BUDGET = Object.freeze({ gap: 4, max: 3, stale: 8 });

export function createToastBudget(rules = TOAST_BUDGET) {
  const waiting = []; // [{ message, options, wait }]
  let clock = rules.gap; // sim seconds since the last budgeted toast went out

  return {
    // A budgeted toast: returns true when it may show now, else it waits (a repeat of a waiting
    // message only refreshes its wait).
    offer(message, options) {
      if (clock >= rules.gap && !waiting.length) {
        clock = 0;
        return true;
      }
      const same = waiting.find((w) => w.message === message);
      if (same) same.wait = 0;
      else {
        if (waiting.length >= rules.max) waiting.shift();
        waiting.push({ message, options, wait: 0 });
      }
      return false;
    },
    // Advances sim time; returns the waiting toast released this step, or null.
    tick(dt) {
      if (!(dt > 0)) return null;
      clock += dt;
      for (let i = waiting.length - 1; i >= 0; i--) if ((waiting[i].wait += dt) > rules.stale) waiting.splice(i, 1);
      if (clock < rules.gap || !waiting.length) return null;
      clock = 0;
      return waiting.shift();
    },
    get pending() {
      return waiting.length;
    },
    clear() {
      waiting.length = 0;
      clock = rules.gap;
    },
  };
}
