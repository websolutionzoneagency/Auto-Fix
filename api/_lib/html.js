// Minimal HTML/XML helpers. Deliberately regex-based rather than a DOM dependency:
// the checks only need attributes and link targets, and this runs inside a serverless function.
export function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}
export function tags(html, tagName) {
  return String(html || '').match(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')) || [];
}
export function canonicalOf(html) {
  for (const t of tags(html, 'link')) {
    if ((attr(t, 'rel') || '').toLowerCase() === 'canonical') return attr(t, 'href');
  }
  return null;
}
export function metaRobots(html) {
  for (const t of tags(html, 'meta')) {
    if ((attr(t, 'name') || '').toLowerCase() === 'robots') return (attr(t, 'content') || '').toLowerCase();
  }
  return null;
}
export function links(html) {
  return tags(html, 'a').map(t => attr(t, 'href')).filter(h => h !== null);
}
export function images(html) {
  return tags(html, 'img').map(t => ({ src: attr(t, 'src'), alt: attr(t, 'alt') }));
}
/** Every JSON-LD @type on the page, flattened through @graph and arrays. */
export function jsonLdTypes(html) {
  const out = new Set();
  const blocks = String(html || '').match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const body = b.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    let parsed; try { parsed = JSON.parse(body); } catch { continue; }
    walk(parsed);
  }
  function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const t = node['@type'];
    if (typeof t === 'string') out.add(t); else if (Array.isArray(t)) t.forEach(x => typeof x === 'string' && out.add(x));
    if (node['@graph']) walk(node['@graph']);
  }
  return [...out];
}
export function sitemapLocs(xml) {
  return [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
}
/** Same-origin absolute URL, or null for off-site / non-http links. */
export function internalUrl(href, baseUrl) {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(mailto:|tel:|javascript:|data:)/i.test(h)) return null;
  let u; try { u = new URL(h, baseUrl); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (u.host !== new URL(baseUrl).host) return null;
  u.hash = '';
  return u.toString();
}
export function isDeadHref(href) {
  const h = String(href ?? '').trim();
  return h === '' || h === '#' || h === 'javascript:void(0)' || h === 'javascript:;';
}
