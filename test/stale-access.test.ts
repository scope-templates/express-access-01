import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGrant } from "../src/access.js";
import { formatStaleReport, staleAccess } from "../src/reports.js";
import { AT, world } from "./fixtures.js";

function withSlackForAll() {
  const w = world();
  for (const name of ["Opal Reyes", "Hugo Marsh", "Lena Fisk", "Bea Nolan", "Mark Ode", "Sam Pike", "Ned Lowe", "Ana Sousa", "Cy Brandt", "Lou Hart"]) {
    const granter = name === "Lena Fisk" ? "Opal Reyes" : "Lena Fisk";
    applyGrant(w.db, w.as(granter), { personId: w.id(name), system: "slack", level: "guest" }, AT);
  }
  return w;
}

test("lists people past their end date who still hold a grant", () => {
  const w = withSlackForAll();
  const report = staleAccess(w.db, "2026-05-20");
  assert.deepEqual(
    report.endedWithAccess.map((p) => [p.name, p.ended, p.daysSince, p.holds]),
    [
      ["Cy Brandt", "2026-05-10", 10, ["Slack guest"]],
      ["Lou Hart", "2026-05-15", 5, ["Slack guest"]],
    ],
  );
});

test("a contract end date counts on the day; an end date from the day after", () => {
  const w = withSlackForAll();
  assert.deepEqual(staleAccess(w.db, "2026-05-10").endedWithAccess.map((p) => p.name), ["Cy Brandt"]);
  assert.deepEqual(staleAccess(w.db, "2026-05-15").endedWithAccess.map((p) => p.name), ["Cy Brandt"]);
  assert.deepEqual(staleAccess(w.db, "2026-05-16").endedWithAccess.map((p) => p.name), ["Cy Brandt", "Lou Hart"]);
});

test("lists people past their start date who hold no grant", () => {
  const w = withSlackForAll();
  assert.deepEqual(
    staleAccess(w.db, "2026-04-28").startedWithoutAccess.map((p) => [p.name, p.started, p.daysSince]),
    [["Tia Gold", "2026-04-27", 1]],
  );
  assert.deepEqual(staleAccess(w.db, "2026-04-27").startedWithoutAccess, []);
});

test("the printed report names the last monthly import on or before its date", () => {
  const w = withSlackForAll();
  w.db.prepare("INSERT INTO import_runs (at, file, rows, added, updated, run_by) VALUES (?, 'people-2026-05.csv', 11, 0, 0, ?)").run(
    "2026-05-04T15:00:00Z",
    w.id("Bea Nolan"),
  );
  assert.equal(staleAccess(w.db, "2026-05-03").lastImport, null);
  const text = formatStaleReport(staleAccess(w.db, "2026-05-20"));
  assert.match(text, /monthly import people-2026-05\.csv, loaded 2026-05-04 \(16 days ago\)/);
  assert.match(text, /Ended, still holding access \(2\)/);
  assert.match(text, /Cy Brandt \(Core, contractor\) ended 2026-05-10, 10 days ago: Slack guest/);
});
