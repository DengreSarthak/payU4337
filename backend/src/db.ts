import { Pool } from "pg";

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  }
  return _pool;
}

// Lazy proxy — pool is constructed only on first use, after dotenv has run.
export const pool: Pool = new Proxy({} as Pool, {
  get(_, prop) {
    const p = getPool();
    const val = (p as any)[prop];
    return typeof val === "function" ? val.bind(p) : val;
  },
});

export async function withTx<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
