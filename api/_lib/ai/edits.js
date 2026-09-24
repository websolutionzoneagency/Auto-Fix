// The only writes an AI review may propose: a fixed set of fields on a fixed set of targets, each read
// before it is written (the snapshot that makes revert possible) and read back after (verification).
// Anything outside this table is rejected at planning time, whatever the model asked for.
import { restBase, seoKeys } from '../connectors/wordpress.js';

const POST_TYPES = new Set(['posts', 'pages', 'product']);
const TERM_TYPES = new Set(['categories', 'tags', 'product_cat', 'product_tag']);
const POST_FIELDS = new Set(['title', 'content', 'excerpt', 'meta.title', 'meta.description', 'meta.canonical', 'meta.robots']);
const MEDIA_FIELDS = new Set(['alt_text', 'title', 'caption', 'description']);
const TERM_FIELDS = new Set(['name', 'description', 'meta.title', 'meta.description', 'meta.robots']);

export const EDITABLE = {
  post: [...POST_FIELDS], media: [...MEDIA_FIELDS], term: [...TERM_FIELDS],
  postTypes: [...POST_TYPES], termTypes: [...TERM_TYPES],
};

export function kindOf(type) {
  if (POST_TYPES.has(type)) return 'post';
  if (type === 'media') return 'media';
  if (TERM_TYPES.has(type)) return 'term';
  return null;
}

/** Throws with a reason when an op is outside the table. Normalises `after`. */
export function validateOp(op) {
  const type = String(op?.target?.type || '');
  const kind = kindOf(type);
  if (!kind) throw new Error(`target type "${type}" cannot be edited`);
  const id = Number(op?.target?.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('target id must be a positive integer');
  const field = String(op?.field || '');
  const allowed = kind === 'post' ? POST_FIELDS : kind === 'media' ? MEDIA_FIELDS : TERM_FIELDS;
  if (!allowed.has(field)) throw new Error(`field "${field}" cannot be edited on ${type}`);
  let after = op.after;
  if (field === 'meta.robots') {
    after = Array.isArray(after) ? after.map(String) : String(after || '').split(/[,\s]+/).filter(Boolean);
    const bad = after.filter(v => !/^(index|noindex|follow|nofollow|noarchive|nosnippet|noimageindex)$/.test(v));
    if (bad.length) throw new Error(`robots values not allowed: ${bad.join(', ')}`);
  } else {
    if (typeof after !== 'string') throw new Error(`"after" for ${field} must be a string`);
    if (after.length > 60000) throw new Error('"after" is too long');
    if (/<script|<iframe|javascript:/i.test(after)) throw new Error('"after" contains script content');
  }
  return { ...op, target: { ...op.target, type, id }, field, after };
}

function metaKey(field, seoPlugin) {
  const keys = seoKeys(seoPlugin);
  const name = field.slice('meta.'.length);
  return keys[name];
}
const raw = (v) => (v && typeof v === 'object' ? (v.raw ?? v.rendered ?? '') : (v ?? ''));

export async function readField(connector, target, field, seoPlugin) {
  const kind = kindOf(target.type);
  const path = kind === 'term' ? `/wp-json/wp/v2/${target.type}/${target.id}` : `/wp-json/wp/v2/${restBase(target.type)}/${target.id}`;
  const { data } = await connector.request(path, { query: { context: 'edit' } });
  const value = field.startsWith('meta.') ? data?.meta?.[metaKey(field, seoPlugin)] : raw(data?.[field]);
  return { value: value ?? (field === 'meta.robots' ? [] : ''), url: data?.link || data?.source_url || target.url || null };
}

export async function writeField(connector, target, field, value, seoPlugin) {
  const kind = kindOf(target.type);
  const patch = field.startsWith('meta.') ? { meta: { [metaKey(field, seoPlugin)]: value } } : { [field]: value };
  if (kind === 'post') return connector.updatePost(target.id, patch, target.type);
  if (kind === 'media') return connector.updateMedia(target.id, patch);
  return connector.updateTerm(target.id, patch, target.type);
}

const norm = (v) => Array.isArray(v) ? v.join(',') : String(v ?? '').replace(/\s+/g, ' ').trim();
export const sameValue = (a, b) => norm(a) === norm(b);
