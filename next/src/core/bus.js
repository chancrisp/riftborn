// Tiny synchronous event bus. Systems announce facts ("enemyKilled", "stageEntered")
// and other systems react without importing each other. Handlers never throw into
// the emitter: a broken listener is logged and the rest still run.
export function createBus() {
  const handlers = new Map();
  return {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type)?.delete(fn);
    },
    off(type, fn) {
      handlers.get(type)?.delete(fn);
    },
    emit(type, payload) {
      const set = handlers.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[bus] ${type} handler failed`, err);
        }
      }
    },
  };
}
