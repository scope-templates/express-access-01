import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSeed } from "../scripts/seed-builder.js";
import { SEED_FILE, openDb } from "../src/db.js";

test("regenerating the seed gives the committed bytes", () => {
  const { seed, octoberCsv } = buildSeed();
  assert.equal(seed, readFileSync(SEED_FILE, "utf8"));
  assert.equal(octoberCsv, readFileSync(new URL("../../data/imports/people-2026-10.csv", import.meta.url), "utf8"));
});

test("an empty store loads the seed on first open, and only then", () => {
  const file = join(mkdtempSync(join(tmpdir(), "access-desk-")), "desk.db");
  const count = (table: string) => {
    const db = openDb(file);
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    db.close();
    return n;
  };
  assert.equal(count("people"), 52);
  assert.equal(count("people"), 52);
  assert.equal(count("import_runs"), 12);
});
