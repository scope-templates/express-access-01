import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGrant, approveRequest, requestAccess } from "../src/access.js";
import { formatCsv, parseCsv } from "../src/csv.js";
import { importPeople } from "../src/people.js";
import { AT, emailOf, world } from "./fixtures.js";

const HEADER =
  "name,work_email,team,manager_email,kind,work_country,work_state,start_date,contract_end_date,end_date,offer_signed_date";

test("CSV fields may be quoted, hold commas and doubled quotes, and end in CRLF", () => {
  const rows = parseCsv('a,b,c\r\n"Lowe, Ned","say ""hi""",3\r\n\r\n');
  assert.deepEqual(rows, [{ a: "Lowe, Ned", b: 'say "hi"', c: "3" }]);
  assert.deepEqual(parseCsv(formatCsv(["a", "b"], [{ a: "x,y", b: null }])), [{ a: "x,y", b: "" }]);
});

test("the monthly import adds new people and updates changed ones by work email", () => {
  const w = world();
  const ned = w.id("Ned Lowe");
  applyGrant(w.db, w.as("Lena Fisk"), { personId: ned, system: "slack", level: "member" }, AT);
  const csv = [
    HEADER,
    `Ned Lowe,${emailOf("Ned Lowe")},Core,,employee,US,CO,2025-02-03,,2026-05-29,2025-01-02`,
    `Sam Pike,${emailOf("Sam Pike")},Core,${emailOf("Opal Reyes")},employee,US,CO,2025-02-03,,,2025-01-02`,
    `Tia Gold,${emailOf("Tia Gold")},Field,${emailOf("Mark Ode")},employee,US,CO,2026-04-27,,,2025-01-02`,
    "Rosa Quill,rosa.quill@example.test,Field,mark.ode@example.test,contractor,PT,,2026-05-11,2026-11-30,,2026-04-22",
  ].join("\n");
  const result = importPeople(w.db, w.as("Bea Nolan"), "people-2026-05.csv", parseCsv(csv), AT);
  assert.deepEqual([result.rows, result.added, result.updated], [4, 1, 2]);

  const rosa = w.db.prepare("SELECT role, manager_id FROM people WHERE work_email = 'rosa.quill@example.test'").get();
  assert.deepEqual(rosa, { role: "viewer", manager_id: w.id("Mark Ode") });
  const updates = w.db.prepare("SELECT detail FROM audit_log WHERE action = 'person.update' ORDER BY id").all() as { detail: string }[];
  assert.deepEqual(updates.map((u) => u.detail), [
    "end_date: - -> 2026-05-29",
    `team: Field -> Core; manager_email: ${emailOf("Mark Ode")} -> ${emailOf("Opal Reyes")}`,
  ]);
  const live = w.db.prepare("SELECT system FROM grants WHERE person_id = ? AND revoked_at IS NULL").all(ned);
  assert.deepEqual(live, [{ system: "slack" }]);
  assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM import_runs").get() as { n: number }).n, 1);
});

test("a file with one bad row is refused whole", () => {
  const w = world();
  const csv = [
    HEADER,
    "Rosa Quill,rosa.quill@example.test,Field,,contractor,PT,,2026-05-11,2026-11-30,,2026-04-22",
    "Al Mott,al.mott@example.test,Field,,employee,US,CO,05/11/2026,,,2026-04-22",
    "Bo Pratt,bo.pratt@example.test,Field,,employee,US,,2026-05-11,,,2026-04-22",
  ].join("\n");
  assert.throws(() => importPeople(w.db, w.as("Bea Nolan"), "bad.csv", parseCsv(csv), AT), (err: Error & { code: string }) => {
    assert.equal(err.code, "bad-rows");
    assert.match(err.message, /line 3: start_date expected YYYY-MM-DD/);
    assert.match(err.message, /line 4: work_state a state is given for US staff only/);
    return true;
  });
  assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n, 11);
});

test("an import that would make an AWS holder a contractor abroad is refused", () => {
  const w = world();
  const sam = w.id("Sam Pike");
  const r = requestAccess(w.db, w.as("Mark Ode"), { personId: sam, system: "aws", level: "read", reason: "logs" }, AT);
  approveRequest(w.db, w.as("Hugo Marsh"), r.id, AT);
  applyGrant(w.db, w.as("Lena Fisk"), { requestId: r.id }, AT);
  const row = `Sam Pike,${emailOf("Sam Pike")},Field,${emailOf("Mark Ode")},contractor,PT,,2025-02-03,2027-01-29,,2025-01-02`;
  assert.throws(() => importPeople(w.db, w.as("Bea Nolan"), "people-2026-05.csv", parseCsv(`${HEADER}\n${row}`), AT), {
    code: "abroad-aws",
  });
  const { work_country } = w.db.prepare("SELECT work_country FROM people WHERE id = ?").get(sam) as { work_country: string };
  assert.equal(work_country, "US");
});

test("only admin and people-ops run the import", () => {
  const w = world();
  for (const name of ["Lena Fisk", "Mark Ode", "Ned Lowe"]) {
    assert.throws(() => importPeople(w.db, w.as(name), "people.csv", [], AT), { code: "role" });
  }
});

test("a refused file writes nothing: unknown managers are all named before anyone is added", () => {
  const w = world();
  const counts = () => w.db.prepare("SELECT (SELECT COUNT(*) FROM people) AS people, (SELECT COUNT(*) FROM import_runs) AS runs").get();
  const before = counts();
  const csv = [
    HEADER,
    "Rosa Quill,rosa.quill@example.test,Field,mark.ode@example.test,employee,US,CO,2026-05-11,,,2026-04-22",
    "Al Mott,al.mott@example.test,Field,nobody@example.test,employee,US,CO,2026-05-11,,,2026-04-22",
    "Bo Pratt,bo.pratt@example.test,Field,someone@example.test,employee,US,CO,2026-05-11,,,2026-04-22",
  ].join("\n");
  assert.throws(() => importPeople(w.db, w.as("Bea Nolan"), "people.csv", parseCsv(csv), AT), (err: Error & { code: string }) => {
    assert.equal(err.code, "unknown-manager");
    assert.match(err.message, /nobody@example\.test, someone@example\.test/);
    return true;
  });
  assert.deepEqual(counts(), before);
});

test("a work email that appears twice in a file is refused", () => {
  const w = world();
  const row = "Rosa Quill,rosa.quill@example.test,Field,,employee,US,CO,2026-05-11,,,2026-04-22";
  assert.throws(() => importPeople(w.db, w.as("Bea Nolan"), "people.csv", parseCsv(`${HEADER}\n${row}\n${row}`), AT), (err: Error & { code: string }) => {
    assert.equal(err.code, "bad-rows");
    assert.match(err.message, /rosa\.quill@example\.test appears twice/);
    return true;
  });
});
