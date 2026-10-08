import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGrant, approveRequest, denyRequest, requestAccess } from "../src/access.js";
import { AT, world } from "./fixtures.js";

test("AWS is applied only from a request a second person approved", () => {
  const w = world();
  const sam = w.id("Sam Pike");
  assert.throws(() => applyGrant(w.db, w.as("Lena Fisk"), { personId: sam, system: "aws", level: "read" }, AT), {
    code: "needs-approval",
  });
  const r = requestAccess(w.db, w.as("Mark Ode"), { personId: sam, system: "aws", level: "read", reason: "logs" }, AT);
  assert.throws(() => applyGrant(w.db, w.as("Lena Fisk"), { requestId: r.id }, AT), { code: "needs-approval" });
  approveRequest(w.db, w.as("Hugo Marsh"), r.id, AT);
  const g = applyGrant(w.db, w.as("Lena Fisk"), { requestId: r.id }, AT);
  assert.equal(g.approved_by, w.id("Hugo Marsh"));
  assert.equal(g.granted_by, w.id("Lena Fisk"));
  assert.throws(() => applyGrant(w.db, w.as("Lena Fisk"), { requestId: r.id }, AT), { code: "not-open" });
});

test("any admin level needs an approved request", () => {
  const w = world();
  assert.throws(
    () => applyGrant(w.db, w.as("Opal Reyes"), { personId: w.id("Ned Lowe"), system: "github", level: "admin" }, AT),
    { code: "needs-approval" },
  );
  const r = requestAccess(w.db, w.as("Opal Reyes"), { personId: w.id("Ned Lowe"), system: "slack", level: "admin", reason: "x" }, AT);
  denyRequest(w.db, w.as("Lena Fisk"), r.id, AT);
  assert.throws(() => applyGrant(w.db, w.as("Opal Reyes"), { requestId: r.id }, AT), { code: "not-open" });
});

test("nobody approves their own request", () => {
  const w = world();
  const r = requestAccess(w.db, w.as("Lena Fisk"), { personId: w.id("Ned Lowe"), system: "aws", level: "deploy", reason: "x" }, AT);
  assert.throws(() => approveRequest(w.db, w.as("Lena Fisk"), r.id, AT), { code: "own-request" });
  assert.throws(() => denyRequest(w.db, w.as("Lena Fisk"), r.id, AT), { code: "own-request" });
  assert.equal(approveRequest(w.db, w.as("Opal Reyes"), r.id, AT).decided_by, w.id("Opal Reyes"));
});

test("nobody approves a request for their own access", () => {
  const w = world();
  const r = requestAccess(w.db, w.as("Opal Reyes"), { personId: w.id("Hugo Marsh"), system: "aws", level: "admin", reason: "x" }, AT);
  assert.throws(() => approveRequest(w.db, w.as("Hugo Marsh"), r.id, AT), { code: "own-access" });
  assert.throws(() => approveRequest(w.db, w.as("Mark Ode"), r.id, AT), { code: "role" });
});

test("contractors abroad can never hold AWS", () => {
  const w = world();
  const ana = w.id("Ana Sousa");
  assert.throws(
    () => requestAccess(w.db, w.as("Mark Ode"), { personId: ana, system: "aws", level: "read", reason: "x" }, AT),
    { code: "abroad-aws" },
  );
  assert.throws(() => applyGrant(w.db, w.as("Opal Reyes"), { personId: ana, system: "aws", level: "read" }, AT), {
    code: "abroad-aws",
  });
  assert.equal(applyGrant(w.db, w.as("Opal Reyes"), { personId: ana, system: "github", level: "write" }, AT).system, "github");
});

test("levels that need no approval are granted directly, once per system", () => {
  const w = world();
  const ned = w.id("Ned Lowe");
  const g = applyGrant(w.db, w.as("Lena Fisk"), { personId: ned, system: "mail", level: "user" }, AT);
  assert.equal(g.approved_by, null);
  assert.throws(() => applyGrant(w.db, w.as("Lena Fisk"), { personId: ned, system: "mail", level: "user" }, AT), {
    code: "already-held",
  });
  assert.throws(() => applyGrant(w.db, w.as("Lena Fisk"), { personId: ned, system: "mail", level: "owner" }, AT), {
    code: "level",
  });
});

test("the person who approved a request does not also apply it", () => {
  const w = world();
  const r = requestAccess(w.db, w.as("Opal Reyes"), { personId: w.id("Ned Lowe"), system: "aws", level: "read", reason: "x" }, AT);
  approveRequest(w.db, w.as("Lena Fisk"), r.id, AT);
  assert.throws(() => applyGrant(w.db, w.as("Lena Fisk"), { requestId: r.id }, AT), { code: "own-approval" });
  assert.equal(applyGrant(w.db, w.as("Hugo Marsh"), { requestId: r.id }, AT).approved_by, w.id("Lena Fisk"));
});
