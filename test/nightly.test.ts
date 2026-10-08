import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGrant, approveRequest, endContracts, requestAccess, revokeGrant, runLeaver } from "../src/access.js";
import { LEAVER_ORDER } from "../src/systems.js";
import { nightlyRun } from "../src/reports.js";
import { AT, world } from "./fixtures.js";

test("the nightly run reports, then ends contracts whose end date is on file and has come", () => {
  const w = world();
  applyGrant(w.db, w.as("Lena Fisk"), { personId: w.id("Cy Brandt"), system: "slack", level: "guest" }, AT);
  applyGrant(w.db, w.as("Lena Fisk"), { personId: w.id("Ana Sousa"), system: "slack", level: "guest" }, AT);
  assert.deepEqual(nightlyRun(w.db, "2026-05-09T06:05:00Z").ended, []);

  const run = nightlyRun(w.db, "2026-05-10T06:05:00Z");
  assert.deepEqual(run.report.endedWithAccess.map((p) => p.name), ["Cy Brandt"]);
  assert.deepEqual(run.ended.map((r) => r.person), ["Cy Brandt"]);
  const nightly = w.as("nightly-report");
  const revoked = w.db.prepare("SELECT revoked_by, revoked_by_system FROM grants WHERE person_id = ?").get(w.id("Cy Brandt"));
  assert.deepEqual(revoked, { revoked_by: null, revoked_by_system: nightly.id });
  const entries = w.db.prepare("SELECT action, actor_system_id FROM audit_log ORDER BY id DESC LIMIT 2").all();
  assert.deepEqual(entries, [
    { action: "revoke", actor_system_id: nightly.id },
    { action: "report", actor_system_id: nightly.id },
  ]);
});

test("a contractor with no contract end date on file keeps their access through the nightly run", () => {
  const w = world();
  w.db.prepare("UPDATE people SET contract_end_date = NULL WHERE id = ?").run(w.id("Cy Brandt"));
  applyGrant(w.db, w.as("Lena Fisk"), { personId: w.id("Cy Brandt"), system: "slack", level: "guest" }, AT);
  assert.deepEqual(nightlyRun(w.db, "2026-06-01T06:05:00Z").ended, []);
});

test("nightly-report ends contracts and may do nothing else", () => {
  const w = world();
  const nightly = w.as("nightly-report");
  const g = applyGrant(w.db, w.as("Lena Fisk"), { personId: w.id("Ned Lowe"), system: "slack", level: "member" }, AT);
  const r = requestAccess(w.db, w.as("Opal Reyes"), { personId: w.id("Ned Lowe"), system: "aws", level: "read", reason: "x" }, AT);
  assert.throws(() => applyGrant(w.db, nightly, { personId: w.id("Sam Pike"), system: "slack", level: "member" }, AT), { code: "role" });
  assert.throws(() => revokeGrant(w.db, nightly, g.id, AT), { code: "role" });
  assert.throws(() => approveRequest(w.db, nightly, r.id, AT), { code: "role" });
  assert.throws(() => requestAccess(w.db, nightly, { personId: w.id("Sam Pike"), system: "slack", level: "member", reason: "x" }, AT), {
    code: "role",
  });
  assert.throws(() => runLeaver(w.db, nightly, w.id("Lou Hart"), LEAVER_ORDER, "2026-05-15T12:00:00Z"), { code: "role" });
  assert.deepEqual(endContracts(w.db, nightly, "2026-05-15T12:00:00Z"), []);
});
