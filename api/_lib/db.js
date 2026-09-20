// Postgres access for the serverless API. One pool per warm function instance.
// `pg` is imported lazily so the handler module can be loaded (and unit-tested) without a database.

let pool = null;

export async function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const { default: pg } = await import('pg');
  pool = new pg.Pool({
    connectionString: url,
    max: 3,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  return pool;
}

/** Run fn(client) inside a transaction. */
export async function withTx(fn) {
  const client = await (await getPool()).connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}
