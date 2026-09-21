// Connector registry. Credentials arrive as the ciphertext stored in site_connections and are
// decrypted here, AAD-bound to the row, so a ciphertext copied to another site row cannot open.
import { WordPressConnector } from './wordpress.js';
import { decryptSecret, encryptSecret } from '../crypto.js';

export function credentialAad(agencyId, siteId) { return `site:${agencyId}:${siteId}`; }

export function buildConnector(conn, { agencyId, fetchImpl } = {}) {
  const creds = decryptSecret(conn.credentials, { aad: credentialAad(agencyId, conn.siteId) });
  if (conn.platform === 'wordpress') {
    return new WordPressConnector({ baseUrl: conn.baseUrl, ...creds, ...(fetchImpl ? { fetchImpl } : {}) });
  }
  throw new Error(`no connector for platform "${conn.platform}" yet`);
}

export function buildConnectorFromPlain({ platform, baseUrl, credentials }, { fetchImpl } = {}) {
  if (platform === 'wordpress') return new WordPressConnector({ baseUrl, ...credentials, ...(fetchImpl ? { fetchImpl } : {}) });
  throw new Error(`no connector for platform "${platform}" yet`);
}

export function sealCredentials(credentials, agencyId, siteId) {
  return encryptSecret(credentials, { aad: credentialAad(agencyId, siteId) });
}

export const PLATFORMS = ['wordpress'];
