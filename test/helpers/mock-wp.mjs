// A small but faithful stand-in for a WordPress + WooCommerce + Rank Math site.
// Speaks the real REST shapes (including X-WP-Total/TotalPages paging and Basic auth),
// serves real HTML/XML for the public-page checks, and records every write so tests can
// assert exactly what the fixer touched.
import { createServer } from 'node:http';

export const APP_PASSWORD = 'abcd efgh ijkl mnop';
export const USERNAME = 'ismail';
const AUTH = 'Basic ' + Buffer.from(`${USERNAME}:${APP_PASSWORD.replace(/\s+/g, '')}`).toString('base64');

export function defaultFixture() {
  return {
    name: 'Vape Wizard DXB',
    namespaces: ['wp/v2', 'wc/v3', 'rankmath/v1', 'rankops/v1'],
    settings: { users_can_register: true, title: 'Vape Wizard DXB' },
    users: [
      { id: 1, name: 'admin', slug: 'admin', email: 'admin@vapewizarddxb.com', roles: ['administrator'] },
      { id: 2, name: 'Ismail Hossain', slug: 'ismail', email: 'ismail@vapewizarddxb.com', roles: ['editor'] },
      { id: 3, name: 'info@vapewizarddxb.com', slug: 'info', email: 'info@vapewizarddxb.com', roles: ['author'] },
    ],
    posts: [
      { id: 10, type: 'post', link: '/blog/best-disposables/', title: 'Best disposables', meta: { rank_math_canonical_url: '' },
        content: '<p>See our <a href="/shop/old-prefix/product/xyz/">XYZ</a> and <a href="/blog/gone/">gone</a>. Sourced from <a href="https://competitor.example/deal">competitor</a>.</p><img src="/wp-content/uploads/IMG_1234.jpg">', revisions: 24 },
      { id: 11, type: 'post', link: '/blog/coil-guide/', title: 'Coil guide', meta: { rank_math_canonical_url: 'https://vapewizarddxb.com/blog/coil-guide/' },
        content: '<p>Read the <a href="/blog/best-disposables/">disposables guide</a>.</p>', revisions: 3 },
      { id: 12, type: 'post', link: '/blog/orphan/', title: 'Orphan post', meta: {}, content: '<p>Nothing links here.</p>', revisions: 1 },
    ],
    pages: [
      { id: 20, type: 'page', link: '/privacy-policy/', title: 'Privacy Policy', meta: {}, content: '<p>Policy.</p>', revisions: 2 },
      { id: 21, type: 'page', link: '/shipping/', title: 'Shipping', meta: {}, content: '<p>Shipping.</p>', revisions: 1 },
    ],
    media: [
      { id: 30, source_url: 'https://vapewizarddxb.com/wp-content/uploads/IMG_1234.jpg', alt_text: '', title: { rendered: 'IMG_1234' }, media_type: 'image', mime_type: 'image/jpeg' },
      { id: 31, source_url: 'https://vapewizarddxb.com/wp-content/uploads/yuoto-xxl-mango.jpg', alt_text: 'Yuoto XXL mango disposable', title: { rendered: 'yuoto-xxl-mango' }, media_type: 'image', mime_type: 'image/jpeg' },
      { id: 32, source_url: 'https://vapewizarddxb.com/wp-content/uploads/DSC_0099.png', alt_text: '', title: { rendered: 'DSC_0099' }, media_type: 'image', mime_type: 'image/png' },
    ],
    categories: [
      { id: 40, name: 'Disposables', slug: 'disposables', count: 120, link: '/product-category/disposables/', meta: { rank_math_robots: [] } },
      { id: 41, name: 'Disposable Vapes', slug: 'disposable-vapes', count: 0, link: '/product-category/disposable-vapes/', meta: { rank_math_robots: [] } },
      { id: 42, name: 'Pods', slug: 'pods', count: 2, link: '/product-category/pods/', meta: { rank_math_robots: [] } },
    ],
    // path → { status, body, contentType }
    pagesHtml: {
      '/': { status: 200, body: html('<nav><a href="/">Home</a><a href="#">Brands</a><a href="/blog/best-disposables/">Blog</a></nav><footer><a href="#">Terms</a><a href="/privacy-policy/">Privacy</a></footer>', '<link rel="canonical" href="https://vapewizarddxb.com/">') },
      '/blog/best-disposables/': { status: 200, body: html('<h1>Best disposables</h1><a href="https://competitor.example/deal">competitor</a>', '') },
      '/blog/coil-guide/': { status: 200, body: html('<h1>Coil guide</h1>', '<link rel="canonical" href="https://vapewizarddxb.com/blog/coil-guide/">') },
      '/privacy-policy/': { status: 200, body: html('<h1>Privacy Policy</h1>', '<link rel="canonical" href="https://vapewizarddxb.com/privacy-policy/">') },
      '/shipping/': { status: 200, body: html('<h1>Shipping</h1>', '') },
      '/blog/gone/': { status: 404, body: '<h1>Not found</h1>' },
      '/shop/old-prefix/product/xyz/': { status: 404, body: '<h1>Not found</h1>' },
      '/wp-sitemap.xml': { status: 200, contentType: 'application/xml', body: `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://vapewizarddxb.com/wp-sitemap-posts-post-1.xml</loc></sitemap></sitemapindex>` },
    },
  };
}

function html(body, head = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Page</title>${head}
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Page"}</script>
</head><body>${body}</body></html>`;
}

export const PLACEHOLDER_ORIGIN = 'https://vapewizarddxb.com';

export async function startMockWp(fixture = defaultFixture()) {
  const state = fixture;
  let origin = PLACEHOLDER_ORIGIN;                 // replaced with the real listen origin below
  const writes = [];
  const requests = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    requests.push({ method: req.method, path: p });
    const authed = req.headers.authorization === AUTH;
    const send = (code, obj, type = 'application/json', headers = {}) => {
      res.writeHead(code, { 'content-type': type, ...headers });
      const raw = typeof obj === 'string' ? obj : JSON.stringify(obj);
      res.end(raw.split(PLACEHOLDER_ORIGIN).join(origin));   // fixture speaks one origin; the server serves its own
    };
    const body = req.method === 'POST' ? await readJson(req) : null;
    if (body) writes.push({ path: p, body });

    // ---- discovery
    if (p === '/wp-json/' || p === '/wp-json') return send(200, { name: state.name, namespaces: state.namespaces });

    // ---- auth-gated collections
    const needsAuth = p.startsWith('/wp-json/wp/v2/');
    if (needsAuth && !authed) return send(401, { code: 'rest_not_logged_in', message: 'You are not currently logged in.' });

    if (p === '/wp-json/wp/v2/users/me') return send(200, state.users[1]);
    if (p === '/wp-json/wp/v2/users') return paged(state.users);
    if (p === '/wp-json/wp/v2/posts') return paged(state.posts);
    if (p === '/wp-json/wp/v2/pages') return paged(state.pages);
    if (p === '/wp-json/wp/v2/media') return paged(state.media);
    if (p === '/wp-json/wp/v2/categories') return paged(state.categories);
    if (p === '/wp-json/wp/v2/settings') {
      if (req.method === 'POST') { Object.assign(state.settings, body); return send(200, state.settings); }
      return send(200, state.settings);
    }
    let m;
    if ((m = p.match(/^\/wp-json\/wp\/v2\/(posts|pages|media|users|categories)\/(\d+)$/))) {
      const coll = { posts: state.posts, pages: state.pages, media: state.media, users: state.users, categories: state.categories }[m[1]];
      const row = coll.find(x => x.id === Number(m[2]));
      if (!row) return send(404, { code: 'rest_post_invalid_id', message: 'Invalid ID.' });
      if (req.method === 'POST') { deepMerge(row, body); return send(200, row); }
      return send(200, row);
    }

    // ---- companion plugin
    if (p === '/wp-json/rankops/v1/summary') {
      if (!state.namespaces.includes('rankops/v1')) return send(404, { code: 'rest_no_route', message: 'No route' });
      return send(200, {
        revisions: { total: state.posts.reduce((n, x) => n + (x.revisions || 0), 0), worst: state.posts.map(x => ({ id: x.id, count: x.revisions || 0 })).sort((a, b) => b.count - a.count).slice(0, 5) },
        debug_display: state.debugDisplay ?? false,
        users_can_register: state.settings.users_can_register,
        seo_plugin: 'Rank Math',
      });
    }
    if (p === '/wp-json/rankops/v1/revisions/purge' && req.method === 'POST') {
      const post = state.posts.find(x => x.id === body.post_id);
      if (!post) return send(404, { message: 'Invalid ID.' });
      const removed = Math.max(0, (post.revisions || 0) - (body.keep ?? 5));
      post.revisions = Math.min(post.revisions || 0, body.keep ?? 5);
      return send(200, { post_id: post.id, removed, remaining: post.revisions });
    }

    // ---- WooCommerce (key/secret in query)
    if (p.startsWith('/wp-json/wc/v3/')) {
      if (url.searchParams.get('consumer_key') !== 'ck_test' || url.searchParams.get('consumer_secret') !== 'cs_test') {
        return send(401, { code: 'woocommerce_rest_authentication_error', message: 'Invalid signature.' });
      }
      if (p === '/wp-json/wc/v3/system_status') return send(200, { environment: { version: '8.0.0' } });
      if (p === '/wp-json/wc/v3/products/categories') return paged(state.categories);
      return send(200, []);
    }

    // ---- public pages
    const page = state.pagesHtml[p];
    if (page) return send(page.status, page.body, page.contentType || 'text/html');
    return send(404, '<h1>Not found</h1>', 'text/html');

    function paged(all) {
      const per = Number(url.searchParams.get('per_page') || 10);
      const pg = Number(url.searchParams.get('page') || 1);
      const slice = all.slice((pg - 1) * per, pg * per);
      return send(200, slice, 'application/json', { 'x-wp-total': String(all.length), 'x-wp-totalpages': String(Math.max(1, Math.ceil(all.length / per))) });
    }
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  origin = `http://127.0.0.1:${port}`;
  return {
    baseUrl: origin,
    state, writes, requests,
    creds: { username: USERNAME, appPassword: APP_PASSWORD, wooKey: 'ck_test', wooSecret: 'cs_test' },
    async close() { await new Promise(r => server.close(r)); },
  };
}

function readJson(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  }
}
