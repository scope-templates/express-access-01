import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGrant, approveRequest, requestAccess, revokeGrant } from "../src/access.js";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actorForToken } from "../src/actors.js";
import { openDb, readSeed } from "../src/db.js";
import { AT, lastAudit, tokenOf, world } from "./fixtures.js";

test("every grant, revoke, approval and refusal writes an entry naming its actor", () => {
  const w = world();
  const ned = w.id("Ned Lowe");
  const g = applyGrant(w.db, w.as("Lena Fisk"), { personId: ned, system: "slack", level: "member" }, AT);
  assert.deepEqual([lastAudit(w.db).action, lastAudit(w.db).actor_person_id], ["grant", w.id("Lena Fisk")]);

  revokeGrant(w.db, w.as("Opal Reyes"), g.id, AT);
  assert.deepEqual([lastAudit(w.db).action, lastAudit(w.db).actor_person_id], ["revoke", w.id("Opal Reyes")]);

  const r = requestAccess(w.db, w.as("Opal Reyes"), { personId: ned, system: "aws", level: "read", reason: "x" }, AT);
  approveRequest(w.db, w.as("Hugo Marsh"), r.id, AT);
  assert.deepEqual([lastAudit(w.db).action, lastAudit(w.db).actor_person_id], ["approve", w.id("Hugo Marsh")]);

  assert.throws(() => applyGrant(w.db, w.as("nightly-report"), { personId: ned, system: "mail", level: "user" }, AT));
  const refusal = lastAudit(w.db);
  assert.equal(refusal.action, "refuse");
  assert.equal(refusal.actor_person_id, null);
  assert.equal(refusal.actor_system_id, w.as("nightly-report").id);
  assert.match(refusal.detail, /^role: viewer may not grant or revoke access/);
});

test("a refused decision leaves no trace but its refusal entry", () => {
  const w = world();
  const before = (w.db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n;
  assert.throws(() => applyGrant(w.db, w.as("Lena Fisk"), { personId: w.id("Ana Sousa"), system: "aws", level: "read" }, AT));
  assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n, before);
  assert.equal(lastAudit(w.db).action, "refuse");
});


test("the audit log refuses updates and deletes", () => {
  const w = world();
  applyGrant(w.db, w.as("Lena Fisk"), { personId: w.id("Ned Lowe"), system: "slack", level: "member" }, AT);
  assert.throws(() => w.db.prepare("UPDATE audit_log SET detail = 'edited'").run(), /append-only/);
  assert.throws(() => w.db.prepare("DELETE FROM audit_log").run(), /append-only/);
});

test("the store rejects an audit entry with no actor, two actors, or an actor not on file", () => {
  const w = world();
  const insert = w.db.prepare(
    "INSERT INTO audit_log (at, actor_person_id, actor_system_id, action, subject, detail) VALUES (?, ?, ?, 'grant', 'x', 'x')",
  );
  assert.throws(() => insert.run(AT, null, null), /no actor on file/);
  assert.throws(() => insert.run(AT, 9999, null), /no actor on file/);
  assert.throws(() => insert.run(AT, w.id("Opal Reyes"), 1), /CHECK constraint/);
});

test("a raw connection with no pragmas cannot change, replace, backdate or forge audit entries", () => {
  const file = join(mkdtempSync(join(tmpdir(), "access-desk-")), "desk.db");
  openDb(file).close();
  const raw = new Database(file);
  const count = () => (raw.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
  const before = count();
  const last = raw.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get() as { id: number; at: string };
  const later = "2027-01-04T15:00:00Z";
  const write = (verb: string, id: number | bigint | null, personId: number | null, at: string | Buffer = later) =>
    raw
      .prepare(`${verb} INTO audit_log (id, at, actor_person_id, actor_system_id, action, subject, detail) VALUES (?, ?, ?, NULL, 'grant', 'x', 'x')`)
      .run(id, at, personId);
  assert.throws(() => raw.prepare("UPDATE audit_log SET detail = 'edited' WHERE id = 1").run(), /append-only/);
  assert.throws(() => raw.prepare("DELETE FROM audit_log WHERE id = 1").run(), /append-only/);
  assert.throws(() => write("INSERT OR REPLACE", 1, 1), /append-only/);
  assert.throws(() => write("REPLACE", last.id, 1), /append-only/);
  assert.throws(() => write("INSERT", 0, 1), /append-only/);
  assert.throws(() => write("INSERT", -1, 1), /CHECK constraint/);
  assert.throws(() => write("INSERT", null, 1, "2025-01-01T09:00:00Z"), /append-only/);
  assert.throws(() => write("INSERT", null, 9999), /no actor on file/);
  assert.throws(() => write("INSERT", null, null), /no actor on file/);
  assert.throws(() => write("INSERT", null, 1, "2027-01-04T15:00:00+23:59"), /CHECK constraint/);
  assert.throws(() => write("INSERT", null, 1, "2027-01-04t15:00:00Z"), /CHECK constraint/);
  assert.throws(() => write("INSERT", null, 1, Buffer.from(later)), /CHECK constraint/);
  assert.throws(() => write("INSERT", 9223372036854775807n, 1), /append-only/);
  assert.equal(count(), before);
  assert.deepEqual(raw.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get(), last);
  const { lastInsertRowid } = write("INSERT", null, 1);
  assert.equal(Number(lastInsertRowid), last.id + 1);
  assert.equal(count(), before + 1);
  raw.close();
});

test("the seed's only system actor is nightly-report with role viewer", () => {
  assert.deepEqual(readSeed().system_actors, [{ id: 1, name: "nightly-report", role: "viewer" }]);
});

test("a person past their end date or contract end date cannot act", () => {
  const w = world();
  const reason = (name: string, at: string) => {
    const signIn = actorForToken(w.db, tokenOf(name), at);
    return signIn.ok ? "ok" : signIn.reason;
  };
  assert.equal(reason("Cy Brandt", "2026-05-09T20:00:00Z"), "ok");
  assert.equal(reason("Cy Brandt", "2026-05-10T08:00:00Z"), "access_ended");
  assert.equal(reason("Lou Hart", "2026-05-15T20:00:00Z"), "ok");
  assert.equal(reason("Lou Hart", "2026-05-16T08:00:00Z"), "access_ended");
  assert.deepEqual([lastAudit(w.db).action, lastAudit(w.db).actor_person_id], ["refuse", w.id("Lou Hart")]);
});

test("a call is signed in only by a person's token", () => {
  const w = world();
  const reason = (token: string | undefined) => {
    const signIn = actorForToken(w.db, token, AT);
    return signIn.ok ? signIn.actor.name : signIn.reason;
  };
  assert.equal(reason(tokenOf("Opal Reyes")), "Opal Reyes");
  assert.equal(reason(undefined), "token_missing");
  assert.equal(reason("nightly-report"), "token_unknown");
  assert.equal(reason("opal.reyes@example.test"), "token_unknown");
});
