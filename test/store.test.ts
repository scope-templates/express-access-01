import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyGrant, requestAccess } from "../src/access.js";
import { openDb } from "../src/db.js";
import { AT, world } from "./fixtures.js";

test("every connection the service opens enforces foreign keys and recursive triggers", () => {
  const w = world();
  assert.equal(w.db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(w.db.pragma("recursive_triggers", { simple: true }), 1);
  assert.throws(
    () =>
      w.db
        .prepare("INSERT INTO grants (person_id, system, level, granted_by, granted_at) VALUES (9999, 'slack', 'member', 1, ?)")
        .run(AT),
    /FOREIGN KEY constraint/,
  );
});

test("the store refuses an AWS or admin-level grant with no approver", () => {
  const w = world();
  const insert = w.db.prepare(
    "INSERT INTO grants (person_id, system, level, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)",
  );
  assert.throws(() => insert.run(w.id("Ned Lowe"), "aws", "read", w.id("Lena Fisk"), AT), /CHECK constraint/);
  assert.throws(() => insert.run(w.id("Ned Lowe"), "github", "admin", w.id("Lena Fisk"), AT), /CHECK constraint/);
});

test("the store refuses a request decided by its requester or by the person it is for", () => {
  const w = world();
  const r = requestAccess(w.db, w.as("Lena Fisk"), { personId: w.id("Ned Lowe"), system: "aws", level: "read", reason: "x" }, AT);
  const decide = w.db.prepare("UPDATE access_requests SET status = 'approved', decided_by = ? WHERE id = ?");
  assert.throws(() => decide.run(w.id("Lena Fisk"), r.id), /CHECK constraint/);
  assert.throws(() => decide.run(w.id("Ned Lowe"), r.id), /CHECK constraint/);
});

test("the store holds one live grant per person per system", () => {
  const w = world();
  applyGrant(w.db, w.as("Lena Fisk"), { personId: w.id("Ned Lowe"), system: "slack", level: "member" }, AT);
  assert.throws(
    () =>
      w.db
        .prepare("INSERT INTO grants (person_id, system, level, granted_by, granted_at) VALUES (?, 'slack', 'guest', ?, ?)")
        .run(w.id("Ned Lowe"), w.id("Lena Fisk"), AT),
    /UNIQUE constraint/,
  );
});

test("on a raw connection the store refuses a grant approved by its holder or its granter, and AWS abroad", () => {
  const file = join(mkdtempSync(join(tmpdir(), "access-desk-")), "desk.db");
  openDb(file).close();
  const raw = new Database(file);
  const idOf = (name: string) => (raw.prepare("SELECT id FROM people WHERE name = ?").get(name) as { id: number }).id;
  const grant = raw.prepare(
    "INSERT INTO grants (person_id, system, level, granted_by, approved_by, granted_at) VALUES (?, ?, ?, ?, ?, '2027-01-04T15:00:00Z')",
  );
  const [kofi, priya, ravi, rui] = ["Kofi Mensah", "Priya Raman", "Ravi Subramaniam", "Rui Mendonça"].map(idOf);
  assert.throws(() => grant.run(kofi, "aws", "read", priya, kofi), /someone other than its holder and its granter/);
  assert.throws(() => grant.run(kofi, "aws", "read", priya, priya), /someone other than its holder and its granter/);
  assert.throws(() => grant.run(rui, "aws", "read", priya, ravi), /never hold AWS/);
  assert.equal(grant.run(kofi, "aws", "read", priya, ravi).changes, 1);
  assert.throws(() => raw.prepare("UPDATE people SET work_country = 'PT', work_state = NULL WHERE id = ?").run(kofi), /never hold AWS/);
  raw.close();
});

test("on a raw connection, even with foreign keys off, grants cannot be bent after the fact", () => {
  const file = join(mkdtempSync(join(tmpdir(), "access-desk-")), "desk.db");
  openDb(file).close();
  const raw = new Database(file);
  raw.pragma("foreign_keys = OFF");
  const idOf = (name: string) => (raw.prepare("SELECT id FROM people WHERE name = ?").get(name) as { id: number }).id;
  const live = (name: string, system: string) =>
    (raw.prepare("SELECT id FROM grants WHERE person_id = ? AND system = ? AND revoked_at IS NULL").get(idOf(name), system) as { id: number }).id;
  const priyaAws = live("Priya Raman", "aws");
  assert.throws(() => raw.prepare("UPDATE grants SET approved_by = person_id WHERE id = ?").run(priyaAws), /someone other than its holder/);
  assert.throws(() => raw.prepare("UPDATE grants SET approved_by = granted_by WHERE id = ?").run(priyaAws), /someone other than its holder/);
  assert.throws(() => raw.prepare("UPDATE grants SET person_id = ? WHERE id = ?").run(idOf("Rui Mendonça"), priyaAws), /stays with its person/);
  assert.throws(() => raw.prepare("UPDATE grants SET system = 'aws', level = 'read' WHERE id = ?").run(live("Inês Carvalho", "github")), /stays with its person/);
  assert.throws(
    () =>
      raw
        .prepare(
          `INSERT OR REPLACE INTO people
           SELECT id, name, work_email, team_id, manager_id, role, kind, 'PT', NULL, start_date, contract_end_date, end_date,
                  offer_signed_date, token
             FROM people WHERE id = ?`,
        )
        .run(idOf("Priya Raman")),
    /never hold AWS/,
  );
  assert.equal((raw.prepare("SELECT work_country FROM people WHERE name = 'Priya Raman'").get() as { work_country: string }).work_country, "US");
  raw.close();
});
