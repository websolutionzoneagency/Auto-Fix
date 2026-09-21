// Sign-in for the API backend.
//   - With CONFIG.supabase set: Supabase Auth (email + password, or a magic link). The session's
//     access token is what the API adapter sends. supabase-js is loaded from jsDelivr on demand.
//   - Without it: single-agency mode using CONFIG.apiToken; no sign-in screen.
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';

export function createAuth(config) {
  if (!config.supabase || !config.supabase.url) {
    return {
      mode: 'token',
      async init() {},
      async getToken() { return config.apiToken || ''; },
      isSignedIn() { return !!config.apiToken; },
      user() { return null; },
      async signIn() { throw new Error('Supabase is not configured'); },
      async signOut() {},
      onChange() {},
    };
  }

  let client = null, session = null;
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => fn(session));

  async function loadLib() {
    if (globalThis.supabase?.createClient) return globalThis.supabase;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SUPABASE_JS; s.onload = resolve; s.onerror = () => reject(new Error('could not load supabase-js'));
      document.head.appendChild(s);
    });
    return globalThis.supabase;
  }

  return {
    mode: 'supabase',
    async init() {
      const lib = await loadLib();
      client = lib.createClient(config.supabase.url, config.supabase.anonKey);
      const { data } = await client.auth.getSession();
      session = data.session || null;
      client.auth.onAuthStateChange((_event, s) => { session = s; notify(); });
      notify();
    },
    async getToken() {
      if (!client) return '';
      const { data } = await client.auth.getSession();       // refreshes if close to expiry
      session = data.session || null;
      return session?.access_token || '';
    },
    isSignedIn() { return !!session; },
    user() { return session?.user || null; },
    async signIn({ email, password }) {
      if (password) {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        return { method: 'password' };
      }
      const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      return { method: 'magic-link' };
    },
    async signOut() { await client?.auth.signOut(); session = null; notify(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
