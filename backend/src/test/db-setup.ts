import { Pool } from "pg";

export const TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/membership_test";

export async function resetTestDb(): Promise<Pool> {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  await admin.query("DROP TABLE IF EXISTS schema_migrations, reputation, tier_history, claims, epochs, members, indexer_cursor CASCADE");
  await admin.end();
  return new Pool({ connectionString: TEST_DATABASE_URL });
}
