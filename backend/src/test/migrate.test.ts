import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";

// Point to test DB before importing anything that constructs the pool.
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/membership_test";

import { runMigrations } from "../migrate";
import { pool } from "../db";

describe("runMigrations", () => {
  let testPool: Pool;

  beforeAll(async () => {
    testPool = pool as unknown as Pool;
    // Clean slate
    await testPool.query("DROP TABLE IF EXISTS schema_migrations, reputation, tier_history, claims, epochs, members, indexer_cursor CASCADE");
  });

  afterAll(async () => {
    await testPool.end();
  });

  it("creates all tables on a fresh database", async () => {
    await runMigrations();

    const tables = await testPool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const names = tables.rows.map((r) => r.table_name);
    expect(names).toContain("members");
    expect(names).toContain("epochs");
    expect(names).toContain("claims");
    expect(names).toContain("reputation");
    expect(names).toContain("tier_history");
    expect(names).toContain("indexer_cursor");
    expect(names).toContain("schema_migrations");
  });

  it("is idempotent — running twice does not throw", async () => {
    await runMigrations();
    await expect(runMigrations()).resolves.not.toThrow();
  });

  it("records applied migrations in schema_migrations", async () => {
    const result = await testPool.query("SELECT filename FROM schema_migrations ORDER BY filename");
    expect(result.rows.length).toBeGreaterThanOrEqual(6);
    const files = result.rows.map((r) => r.filename);
    expect(files).toContain("001_init.sql");
    expect(files).toContain("006_indexer_cursor_block_hash.sql");
  });
});
