import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGrant, approveRequest, endContracts, requestAccess, revokeGrant, runLeaver } from "../src/access.js";
import { LEAVER_ORDER } from "../src/systems.js";
import { AT, type World, world } from "./fixtures.js";

function giveEverything(w: World, name: string, at = AT): void {
  const personId = w.id(name);
  for (const [system, level] of [["mail", "user"], ["slack", "member"], ["github", "write"]] as const) {
    applyGrant(w.db, w.as("Lena Fisk", at), { personId, system, level }, at);
  }
  const r = requestAccess(w.db, w.as("Opal Reyes", at), { personId, system: "aws", level: "deploy", reason: "x" }, at);
  approveRequest(w.db, w.as("Hugo Marsh", at), r.id, at);
  applyGrant(w.db, w.as("Lena Fisk", at), { requestId: r.id }, at);
}

const liveCount = (w: World, name: string) =>
  (w.db.prepare("SELECT COUNT(*) AS n FROM grants WHERE person_id = ? AND revoked_at IS NULL").get(w.id(name)) as { n: number }).n;

test("a leaver run revokes GitHub, AWS, Slack, then mail", () => {
  const w = world();
  giveEverything(w, "Lou Hart");
  const { id: before } = w.db.prepare("SELECT MAX(id) AS id FROM system_log").get() as { id: number };
  const run = runLeaver(w.db, w.as("Opal Reyes"), w.id("Lou Hart"), LEAVER_ORDER, "2026-05-16T15:00:00Z");
  assert.deepEqual(run.revoked.map((r) => r.system), ["github", "aws", "slack", "mail"]);
  const log = w.db.prepare("SELECT system FROM system_log WHERE id > ? ORDER BY id").all(before) as { system: string }[];
  assert.deepEqual(log.map((l) => l.system), ["github", "aws", "slack", "mail"]);
  assert.equal(liveCount(w, "Lou Hart"), 0);
});

test("a leaver run that skips a step is refused and revokes nothing", () => {
  const w = world();
  giveEverything(w, "Lou Hart");
  assert.throws(() => runLeaver(w.db, w.as("Opal Reyes"), w.id("Lou Hart"), ["github", "slack", "mail"], AT), {
    code: "step-skipped",
  });
  assert.equal(liveCount(w, "Lou Hart"), 4);
});

test("a leaver run with its steps out of order is refused", () => {
  const w = world();
  giveEverything(w, "Lou Hart");
  for (const steps of [["slack", "github", "aws", "mail"], [...LEAVER_ORDER, "github"]]) {
    assert.throws(() => runLeaver(w.db, w.as("Opal Reyes"), w.id("Lou Hart"), steps, AT), { code: "step-order" });
  }
  assert.equal(liveCount(w, "Lou Hart"), 4);
});

test("from their last day on, a person's access goes through the leaver run, not one grant at a time", () => {
  const w = world();
  const lastDay = "2026-05-15T17:00:00Z";
  giveEverything(w, "Lou Hart");
  const grantOn = (system: string) =>
    (w.db.prepare("SELECT id FROM grants WHERE person_id = ? AND system = ? AND revoked_at IS NULL").get(w.id("Lou Hart"), system) as {
      id: number;
    }).id;
  assert.throws(() => runLeaver(w.db, w.as("Lena Fisk"), w.id("Lou Hart"), LEAVER_ORDER, AT), { code: "not-leaving" });
  assert.throws(() => runLeaver(w.db, w.as("Lena Fisk"), w.id("Ned Lowe"), LEAVER_ORDER, AT), { code: "not-leaving" });
  assert.equal(revokeGrant(w.db, w.as("Lena Fisk"), grantOn("mail"), AT).revoked_by, w.id("Lena Fisk"));
  assert.throws(() => revokeGrant(w.db, w.as("Lena Fisk", lastDay), grantOn("slack"), lastDay), { code: "use-leaver-run" });
  assert.equal(runLeaver(w.db, w.as("Lena Fisk", lastDay), w.id("Lou Hart"), LEAVER_ORDER, lastDay).revoked.length, 3);
});

test("a contractor's access ends on the contract end date with no grace", () => {
  const w = world();
  const dayBefore = "2026-05-09T22:00:00Z";
  const endDay = "2026-05-10T09:00:00Z";
  giveEverything(w, "Cy Brandt", dayBefore);
  assert.deepEqual(endContracts(w.db, w.as("Lena Fisk", dayBefore), dayBefore), []);
  assert.equal(liveCount(w, "Cy Brandt"), 4);

  assert.throws(
    () => applyGrant(w.db, w.as("Lena Fisk", endDay), { personId: w.id("Cy Brandt"), system: "slack", level: "guest" }, endDay),
    { code: "contract-ended" },
  );
  const runs = endContracts(w.db, w.as("Lena Fisk", endDay), endDay);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].revoked.map((r) => r.system), ["github", "aws", "slack", "mail"]);
  assert.equal(liveCount(w, "Cy Brandt"), 0);
});
