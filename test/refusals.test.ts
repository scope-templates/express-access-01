import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyGrant,
  approveRequest,
  denyRequest,
  endContracts,
  listLiveGrants,
  listRequests,
  requestAccess,
  revokeGrant,
  runLeaver,
} from "../src/access.js";
import type { Actor } from "../src/actors.js";
import { addPerson, recordEndDate } from "../src/people.js";
import { listAudit } from "../src/reports.js";
import { LEAVER_ORDER } from "../src/systems.js";
import { AT, emailOf, world } from "./fixtures.js";

const offer = (email: string, manager = "") => ({
  name: "Rosa Quill",
  work_email: email,
  team: "Field",
  manager_email: manager,
  kind: "employee",
  work_country: "US",
  work_state: "CO",
  start_date: "2026-05-18",
  offer_signed_date: "2026-04-30",
});

test("leaver runs, single revokes and ending contracts belong to it and admin", () => {
  const w = world();
  const g = applyGrant(w.db, w.as("Lena Fisk"), { personId: w.id("Ned Lowe"), system: "slack", level: "member" }, AT);
  const lastDay = "2026-05-15T12:00:00Z";
  for (const name of ["Mark Ode", "Bea Nolan", "Ned Lowe"]) {
    assert.throws(() => revokeGrant(w.db, w.as(name), g.id, lastDay), { code: "role" });
    assert.throws(() => runLeaver(w.db, w.as(name), w.id("Lou Hart"), LEAVER_ORDER, lastDay), { code: "role" });
    assert.throws(() => endContracts(w.db, w.as(name), lastDay), { code: "role" });
  }
});

test("a grant that was already revoked cannot be revoked again", () => {
  const w = world();
  const g = applyGrant(w.db, w.as("Lena Fisk"), { personId: w.id("Ned Lowe"), system: "slack", level: "member" }, AT);
  revokeGrant(w.db, w.as("Lena Fisk"), g.id, AT);
  assert.throws(() => revokeGrant(w.db, w.as("Opal Reyes"), g.id, AT), { code: "not-live" });
});

test("a decided request cannot be decided again", () => {
  const w = world();
  const r = requestAccess(w.db, w.as("Opal Reyes"), { personId: w.id("Ned Lowe"), system: "aws", level: "read", reason: "x" }, AT);
  approveRequest(w.db, w.as("Lena Fisk"), r.id, AT);
  assert.throws(() => denyRequest(w.db, w.as("Hugo Marsh"), r.id, AT), { code: "not-open" });
  assert.throws(() => approveRequest(w.db, w.as("Hugo Marsh"), r.id, AT), { code: "not-open" });
});

test("an unknown system is refused", () => {
  const w = world();
  assert.throws(
    () => requestAccess(w.db, w.as("Opal Reyes"), { personId: w.id("Ned Lowe"), system: "wiki", level: "read", reason: "x" }, AT),
    { code: "system", status: 400 },
  );
});

test("a person past their last day can be granted nothing", () => {
  const w = world();
  const after = "2026-05-16T15:00:00Z";
  assert.throws(
    () => applyGrant(w.db, w.as("Lena Fisk", after), { personId: w.id("Lou Hart"), system: "slack", level: "guest" }, after),
    { code: "left" },
  );
});

test("a system actor never signs a grant, whatever its role", () => {
  const w = world();
  const system: Actor = { ...w.as("nightly-report"), role: "admin" };
  assert.throws(() => applyGrant(w.db, system, { personId: w.id("Ned Lowe"), system: "slack", level: "member" }, AT), {
    code: "system-actor",
  });
});

test("people are added and given end dates by admin and people-ops only", () => {
  const w = world();
  for (const name of ["Lena Fisk", "Mark Ode", "Ned Lowe"]) {
    assert.throws(() => addPerson(w.db, w.as(name), offer("rosa.quill@example.test"), AT), { code: "role" });
    assert.throws(() => recordEndDate(w.db, w.as(name), w.id("Ned Lowe"), "2026-06-30", AT), { code: "role" });
  }
  assert.equal(recordEndDate(w.db, w.as("Bea Nolan"), w.id("Ned Lowe"), "2026-06-30", AT).end_date, "2026-06-30");
});

test("a person is added once, under a manager who is on file", () => {
  const w = world();
  assert.throws(() => addPerson(w.db, w.as("Bea Nolan"), offer(emailOf("Ned Lowe")), AT), { code: "exists" });
  assert.throws(() => addPerson(w.db, w.as("Bea Nolan"), offer("rosa.quill@example.test", "nobody@example.test"), AT), {
    code: "unknown-manager",
  });
  const added = addPerson(w.db, w.as("Bea Nolan"), offer("rosa.quill@example.test", emailOf("Mark Ode")), AT);
  assert.equal(added.person.role, "viewer");
  assert.match(added.token, /^[0-9a-f]{32}$/);
});

test("a manager lists only the requests they made and the grants of their own reports", () => {
  const w = world();
  requestAccess(w.db, w.as("Mark Ode"), { personId: w.id("Sam Pike"), system: "github", level: "read", reason: "x" }, AT);
  requestAccess(w.db, w.as("Opal Reyes"), { personId: w.id("Ned Lowe"), system: "github", level: "read", reason: "x" }, AT);
  applyGrant(w.db, w.as("Lena Fisk"), { personId: w.id("Sam Pike"), system: "slack", level: "member" }, AT);
  applyGrant(w.db, w.as("Lena Fisk"), { personId: w.id("Ned Lowe"), system: "slack", level: "member" }, AT);
  assert.deepEqual(listRequests(w.db, w.as("Mark Ode"), null, AT).map((r) => r.person), ["Sam Pike"]);
  assert.equal(listRequests(w.db, w.as("Bea Nolan"), null, AT).length, 2);
  assert.deepEqual(listLiveGrants(w.db, w.as("Mark Ode"), AT).map((g) => g.person), ["Sam Pike"]);
  assert.equal(listLiveGrants(w.db, w.as("Bea Nolan"), AT).length, 2);
  assert.throws(() => listRequests(w.db, w.as("Ned Lowe"), null, AT), { code: "role" });
  assert.throws(() => listLiveGrants(w.db, w.as("Ned Lowe"), AT), { code: "role" });
});

test("the audit log is read by it and admin only", () => {
  const w = world();
  assert.ok(Array.isArray(listAudit(w.db, w.as("Lena Fisk"), 10, AT)));
  for (const name of ["Bea Nolan", "Mark Ode", "Ned Lowe"]) {
    assert.throws(() => listAudit(w.db, w.as(name), 10, AT), { code: "role" });
  }
});

test("nobody grants their own access, even at a level that needs no approval", () => {
  const w = world();
  for (const name of ["Lena Fisk", "Opal Reyes"]) {
    assert.throws(() => applyGrant(w.db, w.as(name), { personId: w.id(name), system: "slack", level: "member" }, AT), {
      code: "own-access",
    });
  }
  assert.equal(applyGrant(w.db, w.as("Opal Reyes"), { personId: w.id("Lena Fisk"), system: "slack", level: "member" }, AT).system, "slack");
});

test("a clock behind the last audit entry is refused as clock-behind and nothing is written", () => {
  const w = world();
  w.db
    .prepare("INSERT INTO audit_log (at, actor_person_id, action, subject, detail) VALUES ('2027-01-04T15:00:00Z', ?, 'grant', 'x', 'x')")
    .run(w.id("Opal Reyes"));
  const counts = () => w.db.prepare("SELECT (SELECT COUNT(*) FROM grants) AS grants, (SELECT COUNT(*) FROM audit_log) AS audit").get();
  const before = counts();
  assert.throws(() => applyGrant(w.db, w.as("Lena Fisk"), { personId: w.id("Ned Lowe"), system: "slack", level: "member" }, AT), {
    code: "clock-behind",
  });
  assert.throws(() => applyGrant(w.db, w.as("Ned Lowe"), { personId: w.id("Sam Pike"), system: "slack", level: "member" }, AT), {
    code: "clock-behind",
  });
  assert.deepEqual(counts(), before);
});
