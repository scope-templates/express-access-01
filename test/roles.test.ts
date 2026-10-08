import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGrant, requestAccess } from "../src/access.js";
import { parseCsv } from "../src/csv.js";
import { importPeople, setRole, staffList } from "../src/people.js";
import { AT, TODAY, emailOf, lastAudit, world } from "./fixtures.js";

const slackFor = (personId: number) => ({ personId, system: "slack", level: "member" });

test("only it and admin roles grant access", () => {
  const w = world();
  for (const name of ["Mark Ode", "Bea Nolan", "Ned Lowe", "nightly-report"]) {
    assert.throws(() => applyGrant(w.db, w.as(name), slackFor(w.id("Sam Pike")), AT), { code: "role" });
  }
  const byIt = applyGrant(w.db, w.as("Lena Fisk"), slackFor(w.id("Sam Pike")), AT);
  const byAdmin = applyGrant(w.db, w.as("Opal Reyes"), slackFor(w.id("Tia Gold")), AT);
  assert.equal(byIt.granted_by, w.id("Lena Fisk"));
  assert.equal(byAdmin.granted_by, w.id("Opal Reyes"));
});

test("a manager requests access for their own reports only", () => {
  const w = world();
  const ask = (who: string) =>
    requestAccess(w.db, w.as("Mark Ode"), { personId: w.id(who), system: "github", level: "read", reason: "new on the team" }, AT);
  assert.equal(ask("Sam Pike").status, "open");
  assert.throws(() => ask("Ned Lowe"), { code: "not-own-report" });
  assert.throws(() => ask("Mark Ode"), { code: "not-own-report" });
  assert.throws(
    () => requestAccess(w.db, w.as("Ned Lowe"), { personId: w.id("Ned Lowe"), system: "slack", level: "member", reason: "x" }, AT),
    { code: "role" },
  );
});

test("a viewer reads the staff list without email, state or dates", () => {
  const w = world();
  const list = staffList(w.db, w.as("Ned Lowe"), TODAY);
  assert.equal(list.length, 11);
  for (const entry of list) {
    assert.deepEqual(Object.keys(entry).sort(), ["id", "manager", "name", "status", "team"]);
  }
});

test("a manager reads personal fields for their own reports only", () => {
  const w = world();
  const full = staffList(w.db, w.as("Mark Ode"), TODAY)
    .filter((p) => "work_email" in p)
    .map((p) => p.name)
    .sort();
  assert.deepEqual(full, ["Ana Sousa", "Sam Pike", "Tia Gold"]);
  assert.ok(staffList(w.db, w.as("Bea Nolan"), TODAY).every((p) => "work_email" in p && "start_date" in p));
});

test("a viewer listed as someone's manager still reads no personal fields", () => {
  const w = world();
  w.db.prepare("UPDATE people SET manager_id = ? WHERE id = ?").run(w.id("Ned Lowe"), w.id("Sam Pike"));
  assert.ok(staffList(w.db, w.as("Ned Lowe"), TODAY).every((p) => !("work_email" in p)));
});

test("status is worked out from the dates on the day it is read", () => {
  const w = world();
  const statusOf = (name: string, today: string) => staffList(w.db, w.as("Bea Nolan"), today).find((p) => p.name === name)?.status;
  assert.equal(statusOf("Tia Gold", "2026-04-26"), "joining");
  assert.equal(statusOf("Tia Gold", "2026-04-27"), "active");
  assert.equal(statusOf("Lou Hart", "2026-05-15"), "active");
  assert.equal(statusOf("Lou Hart", "2026-05-16"), "left");
  assert.equal(statusOf("Cy Brandt", "2026-05-10"), "left");
});

test("only an admin changes a role, and the change is in the audit log", () => {
  const w = world();
  const sam = w.id("Sam Pike");
  for (const name of ["Lena Fisk", "Bea Nolan", "Mark Ode", "Ned Lowe"]) {
    assert.throws(() => setRole(w.db, w.as(name), sam, "it", AT), { code: "role" });
  }
  assert.equal(setRole(w.db, w.as("Opal Reyes"), sam, "it", AT).role, "it");
  assert.equal(lastAudit(w.db).detail, "role: viewer -> it");
  assert.equal(applyGrant(w.db, w.as("Sam Pike"), slackFor(w.id("Ned Lowe")), AT).granted_by, sam);
  assert.throws(() => setRole(w.db, w.as("Opal Reyes"), sam, "owner", AT));
});

test("the import sets roles from its role column only when an admin runs it", () => {
  const w = world();
  const header = "name,work_email,team,manager_email,kind,work_country,work_state,start_date,contract_end_date,end_date,offer_signed_date,role";
  const ned = (role: string) => parseCsv(`${header}\nNed Lowe,${emailOf("Ned Lowe")},Core,,employee,US,CO,2025-02-03,,,2025-01-02,${role}`);
  assert.throws(() => importPeople(w.db, w.as("Bea Nolan"), "people.csv", ned("manager"), AT), { code: "role" });
  assert.equal(importPeople(w.db, w.as("Bea Nolan"), "people.csv", ned(""), AT).updated, 0);
  assert.equal(importPeople(w.db, w.as("Bea Nolan"), "people.csv", ned("viewer"), AT).updated, 0);
  assert.equal(importPeople(w.db, w.as("Opal Reyes"), "people.csv", ned("manager"), AT).updated, 1);
  assert.equal(lastAudit(w.db).action, "import");
  const role = w.db.prepare("SELECT role FROM people WHERE id = ?").get(w.id("Ned Lowe")) as { role: string };
  assert.equal(role.role, "manager");
});
