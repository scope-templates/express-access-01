import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { lastAudit, tokenOf, world } from "./fixtures.js";

const w = world();
let server: Server;
let base = "";

before(() => {
  server = createApp(w.db, () => new Date("2026-05-01T16:00:00Z")).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const call = (method: string, path: string, person?: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(person ? { authorization: `Bearer ${tokenOf(person)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("a call without a person's token is turned away with a reason", async () => {
  const reason = async (authorization?: string) => {
    const res = await fetch(`${base}/api/people`, { headers: authorization ? { authorization } : {} });
    return [res.status, ((await res.json()) as { error: string }).error];
  };
  assert.deepEqual(await reason(), [401, "token_missing"]);
  assert.deepEqual(await reason("Bearer 00000000000000000000000000000000"), [401, "token_unknown"]);
  assert.deepEqual(await reason("Bearer nightly-report"), [401, "token_unknown"]);
  assert.deepEqual(await reason(`Basic ${tokenOf("Opal Reyes")}`), [401, "token_missing"]);
  assert.deepEqual(await reason(`Bearer ${tokenOf("Opal Reyes")}`), [200, undefined]);
});

test("a viewer's staff list carries no personal fields", async () => {
  const res = await call("GET", "/api/people", "Ned Lowe");
  const people = (await res.json()) as Record<string, unknown>[];
  assert.equal(res.status, 200);
  assert.ok(people.every((p) => !("work_email" in p) && !("work_state" in p) && !("start_date" in p)));
});

test("a refused grant answers 403 and is written to the audit log", async () => {
  const res = await call("POST", "/api/grants", "Mark Ode", { person_id: w.id("Sam Pike"), system: "slack", level: "member" });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "role", message: "manager may not grant or revoke access" });
  assert.deepEqual([lastAudit(w.db).action, lastAudit(w.db).actor_person_id], ["refuse", w.id("Mark Ode")]);
});

test("AWS is requested, approved and granted over the API", async () => {
  const asked = await call("POST", "/api/requests", "Mark Ode", {
    person_id: w.id("Sam Pike"),
    system: "aws",
    level: "read",
    reason: "Reads the queue logs during the support rotation.",
  });
  assert.equal(asked.status, 201);
  const { id } = (await asked.json()) as { id: number };
  assert.equal((await call("POST", `/api/requests/${id}/approve`, "Hugo Marsh")).status, 200);
  const granted = await call("POST", "/api/grants", "Lena Fisk", { request_id: id });
  assert.equal(granted.status, 201);
  assert.equal(((await granted.json()) as { approved_by: number }).approved_by, w.id("Hugo Marsh"));
  const audit = (await (await call("GET", "/api/audit?limit=3", "Lena Fisk")).json()) as { action: string }[];
  assert.deepEqual(audit.map((a) => a.action), ["grant", "approve", "request"]);
});

test("the admin page shows the staff list to a signed-in person", async () => {
  const signedOut = await fetch(`${base}/admin`);
  assert.equal(signedOut.status, 401);
  assert.match(await signedOut.text(), /Your access desk token/);
  const res = await fetch(`${base}/admin`, { headers: { cookie: `token=${tokenOf("Opal Reyes")}` } });
  const html = await res.text();
  assert.match(html, /Signed in as Opal Reyes \(admin\)/);
  assert.match(html, /Add a person entered from the signed offer/);
  assert.match(html, /Lou Hart/);
});

test("stale access is read by admin, it and people-ops only", async () => {
  assert.equal((await call("GET", "/api/reports/stale-access", "Bea Nolan")).status, 200);
  const res = await call("GET", "/api/reports/stale-access", "Mark Ode");
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, "role");
});

test("an admin page form without a signed-in person changes nothing", async () => {
  const count = () => (w.db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n;
  const before = count();
  const res = await fetch(`${base}/admin/grants`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `person_id=${w.id("Ned Lowe")}&access=slack:member`,
  });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /Your access desk token/);
  assert.equal(count(), before);
});

test("the add-person form answers 400 for a misplaced state or a contract end date on an employee", async () => {
  const add = (fields: Record<string, string>) =>
    fetch(`${base}/admin/people`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `token=${tokenOf("Bea Nolan")}` },
      body: new URLSearchParams({
        name: "Rosa Quill",
        work_email: "rosa.quill@example.test",
        team: "Field",
        manager_email: "",
        kind: "employee",
        work_country: "US",
        work_state: "CO",
        start_date: "2026-05-18",
        contract_end_date: "",
        offer_signed_date: "2026-04-30",
        ...fields,
      }).toString(),
    });
  const cases: Record<string, string>[] = [{ work_state: "" }, { work_country: "PT" }, { contract_end_date: "2026-12-31" }];
  for (const fields of cases) {
    const res = await add(fields);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Refused: (work_state|contract_end_date)/);
  }
  assert.equal(w.db.prepare("SELECT 1 FROM people WHERE work_email = 'rosa.quill@example.test'").get(), undefined);
});

test("a call made while the clock reads earlier than the last audit entry answers 409 clock-behind", async () => {
  w.db
    .prepare("INSERT INTO audit_log (at, actor_person_id, action, subject, detail) VALUES ('2027-01-04T15:00:00Z', ?, 'grant', 'x', 'x')")
    .run(w.id("Opal Reyes"));
  const res = await call("POST", "/api/grants", "Lena Fisk", { person_id: w.id("Tia Gold"), system: "mail", level: "user" });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, "clock-behind");
});
