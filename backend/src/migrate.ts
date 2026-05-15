import {readdir, readFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {pool} from "./db";

const MIGRATIONS_DIR = resolve(process.cwd(), "migrations");

async function ensureTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
        )
    `);
}

async function applied(): Promise<Set<string>> {
    const r = await pool.query<{filename: string}>(`SELECT filename FROM schema_migrations`);
    return new Set(r.rows.map((x) => x.filename));
}

async function main() {
    await ensureTable();
    const done = await applied();

    const files = (await readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith(".sql"))
        .sort();

    for (const f of files) {
        if (done.has(f)) continue;
        const sql = await readFile(join(MIGRATIONS_DIR, f), "utf8");
        console.log(`[migrate] applying ${f}`);
        await pool.query(sql);
        await pool.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [f]);
    }

    console.log("[migrate] done");
    await pool.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
