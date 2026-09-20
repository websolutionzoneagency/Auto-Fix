// localStorage adapter — the default persistence layer. Same interface as adapters/api.js:
//   load()                 → Promise<state | null>
//   persist(state, action) → Promise<void>
// The store never touches storage directly, so swapping adapters is a one-line config change.

const LEGACY_KEY = 'rankops_console_state_v1';   // the pre-SaaS mock's key; migrated once, then ignored

export function createLocalAdapter({ key = 'rankops_state_v2', storage } = {}) {
  const store = storage || safeStorage();

  function read(k) {
    if (!store) return null;
    try { const raw = store.getItem(k); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }

  return {
    name: 'local',
    async load() { return read(key); },
    async persist(state) {
      if (!store) return;
      try { store.setItem(key, JSON.stringify(state)); } catch { /* quota / private mode: keep running in memory */ }
    },
    /** Clients added through the old mock UI, so nothing typed into v1 is lost. */
    loadLegacy() {
      const v1 = read(LEGACY_KEY);
      if (!v1) return null;
      return { theme: v1.theme ?? null, extraClients: Array.isArray(v1.extraClients) ? v1.extraClients : [] };
    },
    async clear() {
      if (!store) return;
      try { store.removeItem(key); } catch { /* ignore */ }
    },
  };
}

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    const probe = '__rankops_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return null; }
}
