// WordPress / WooCommerce connector.
//
// Auth is WordPress Application Passwords (core since 5.6 — no plugin needed): HTTP Basic over HTTPS.
// WooCommerce uses its own consumer key/secret. Writing SEO meta (Rank Math) needs those meta keys
// registered for REST, which the companion mu-plugin in wordpress-plugin/ does.
//
// Every method is read-only unless its name starts with `update`/`delete`. Writes go through the fixer,
// which snapshots the previous value first.

const UA = 'RankOps-Console/1.0 (+https://github.com/websolutionzoneagency/Auto-Fix)';

export class WordPressConnector {
  /**
   * @param {object} cfg
   * @param {string} cfg.baseUrl      e.g. https://vapewizarddxb.com
   * @param {string} cfg.username     WP user the application password belongs to
   * @param {string} cfg.appPassword  the application password
   * @param {string} [cfg.wooKey]     WooCommerce consumer key
   * @param {string} [cfg.wooSecret]  WooCommerce consumer secret
   * @param {function} [cfg.fetchImpl] injected in tests
   */
  constructor({ baseUrl, username, appPassword, wooKey = '', wooSecret = '', fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    if (!baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.username = username;
    this.appPassword = appPassword;
    this.wooKey = wooKey;
    this.wooSecret = wooSecret;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.platform = 'wordpress';
  }

  get authHeader() {
    if (!this.username || !this.appPassword) return null;
    // Application passwords are displayed with spaces for readability; WP ignores them.
    const pass = String(this.appPassword).replace(/\s+/g, '');
    return 'Basic ' + Buffer.from(`${this.username}:${pass}`).toString('base64');
  }

  async request(path, { method = 'GET', body, query, auth = true, raw = false } = {}) {
    const url = new URL(path.startsWith('http') ? path : this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const headers = { 'user-agent': UA, accept: raw ? '*/*' : 'application/json' };
    if (auth && this.authHeader) headers.authorization = this.authHeader;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal, redirect: 'follow' });
    } catch (e) {
      throw new ConnectorError(e.name === 'AbortError' ? `timed out after ${this.timeoutMs}ms` : e.message, { url: url.toString(), cause: e });
    } finally {
      clearTimeout(timer);
    }
    if (raw) return { status: res.status, headers: res.headers, text: await res.text(), url: res.url || url.toString() };
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.message || j.code || ''; } catch { /* non-JSON error body */ }
      throw new ConnectorError(`${method} ${url.pathname} → HTTP ${res.status}${detail ? ': ' + detail : ''}`, { status: res.status, url: url.toString() });
    }
    const totalPages = Number(res.headers.get('x-wp-totalpages') || 0);
    const total = Number(res.headers.get('x-wp-total') || 0);
    return { data: await res.json(), totalPages, total };
  }

  /** Fetch a public URL on the site as text (for HTML/XML checks). Never sends credentials. */
  async fetchPublic(pathOrUrl) {
    return this.request(pathOrUrl, { auth: false, raw: true });
  }

  /** Verify the site is WordPress, the credentials work, and report what we can and cannot reach. */
  async testConnection() {
    const out = { ok: false, platform: 'wordpress', restOk: false, authOk: false, wooOk: false, seoPlugin: null, companionPlugin: false, user: null, errors: [] };
    try {
      const { data } = await this.request('/wp-json/', { auth: false });
      out.restOk = true;
      out.siteName = data?.name;
      const ns = data?.namespaces || [];
      out.companionPlugin = ns.includes('rankops/v1');
      if (ns.includes('rankmath/v1')) out.seoPlugin = 'Rank Math';
      else if (ns.includes('yoast/v1')) out.seoPlugin = 'Yoast SEO';
    } catch (e) {
      out.errors.push(`REST API unreachable: ${e.message}`);
      return out;                                   // nothing else can work without /wp-json
    }
    try {
      const { data } = await this.request('/wp-json/wp/v2/users/me', { query: { context: 'edit' } });
      out.authOk = true;
      out.user = { id: data.id, name: data.name, slug: data.slug, roles: data.roles || [] };
    } catch (e) {
      out.errors.push(`Authentication failed: ${e.message}`);
    }
    if (this.wooKey && this.wooSecret) {
      try {
        await this.woo('/wp-json/wc/v3/system_status');
        out.wooOk = true;
      } catch (e) {
        out.errors.push(`WooCommerce: ${e.message}`);
      }
    }
    out.ok = out.restOk && out.authOk;
    return out;
  }

  /** WooCommerce REST. Key/secret go as query params, which Woo accepts over HTTPS. */
  async woo(path, { method = 'GET', query = {}, body } = {}) {
    if (!this.wooKey || !this.wooSecret) throw new ConnectorError('WooCommerce credentials not configured');
    const { data, totalPages, total } = await this.request(path, {
      method, body, auth: false,
      query: { ...query, consumer_key: this.wooKey, consumer_secret: this.wooSecret },
    });
    return { data, totalPages, total };
  }

  /** Walk every page of a WP collection, bounded so one scan can never run away. */
  async *paginate(path, { perPage = 100, maxPages = 20, query = {}, woo = false } = {}) {
    for (let page = 1; page <= maxPages; page++) {
      const opts = { query: { ...query, per_page: perPage, page } };
      const { data, totalPages } = woo ? await this.woo(path, opts) : await this.request(path, opts);
      if (!Array.isArray(data) || data.length === 0) return;
      yield data;
      if (totalPages && page >= totalPages) return;
      if (data.length < perPage) return;
    }
  }

  async collect(path, opts = {}) {
    const out = [];
    const limit = opts.limit ?? Infinity;
    for await (const batch of this.paginate(path, opts)) {
      out.push(...batch);
      if (out.length >= limit) return out.slice(0, limit);
    }
    return out;
  }

  /* ---------- reads used by the checks ---------- */
  posts(opts)      { return this.collect('/wp-json/wp/v2/posts',      { query: { status: 'publish', _fields: 'id,link,title,content,meta,date,modified' }, ...opts }); }
  pages(opts)      { return this.collect('/wp-json/wp/v2/pages',      { query: { status: 'publish', _fields: 'id,link,title,content,meta,date,modified' }, ...opts }); }
  media(opts)      { return this.collect('/wp-json/wp/v2/media',      { query: { _fields: 'id,source_url,alt_text,title,media_type,mime_type' }, ...opts }); }
  users(opts)      { return this.collect('/wp-json/wp/v2/users',      { query: { context: 'edit', _fields: 'id,name,slug,email,roles' }, ...opts }); }
  categories(opts) { return this.collect('/wp-json/wp/v2/categories', { query: { per_page: 100, _fields: 'id,name,slug,count,link,meta' }, ...opts }); }
  productCategories(opts) { return this.collect('/wp-json/wc/v3/products/categories', { woo: true, ...opts }); }
  products(opts)   { return this.collect('/wp-json/wc/v3/products', { woo: true, query: { status: 'publish' }, ...opts }); }

  async settings() { const { data } = await this.request('/wp-json/wp/v2/settings'); return data; }

  /** Companion-plugin extras (revision counts, debug flag). Returns null when the plugin is absent. */
  async summary() {
    try { const { data } = await this.request('/wp-json/rankops/v1/summary'); return data; }
    catch { return null; }
  }

  /* ---------- writes (called only by the fixer, after a snapshot) ---------- */
  async updatePost(id, patch, type = 'posts') {
    const { data } = await this.request(`/wp-json/wp/v2/${type}/${id}`, { method: 'POST', body: patch });
    return data;
  }
  async updateMedia(id, patch) {
    const { data } = await this.request(`/wp-json/wp/v2/media/${id}`, { method: 'POST', body: patch });
    return data;
  }
  async updateUser(id, patch) {
    const { data } = await this.request(`/wp-json/wp/v2/users/${id}`, { method: 'POST', body: patch });
    return data;
  }
  async updateTerm(id, patch, taxonomy = 'categories') {
    const { data } = await this.request(`/wp-json/wp/v2/${taxonomy}/${id}`, { method: 'POST', body: patch });
    return data;
  }
  async updateSettings(patch) {
    const { data } = await this.request('/wp-json/wp/v2/settings', { method: 'POST', body: patch });
    return data;
  }
  async purgeRevisions(postId, keep = 5) {
    const { data } = await this.request('/wp-json/rankops/v1/revisions/purge', { method: 'POST', body: { post_id: postId, keep } });
    return data;
  }
}

export class ConnectorError extends Error {
  constructor(message, meta = {}) { super(message); this.name = 'ConnectorError'; Object.assign(this, meta); }
}

/** SEO meta keys differ per plugin; the checks/fixes speak in these neutral names. */
export const SEO_META = {
  'Rank Math': { canonical: 'rank_math_canonical_url', title: 'rank_math_title', description: 'rank_math_description', robots: 'rank_math_robots' },
  'Yoast SEO': { canonical: '_yoast_wpseo_canonical', title: '_yoast_wpseo_title', description: '_yoast_wpseo_metadesc', robots: '_yoast_wpseo_meta-robots-noindex' },
};
export function seoKeys(plugin) { return SEO_META[plugin] || SEO_META['Rank Math']; }
