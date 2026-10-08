import { type Actor, NIGHTLY_REPORT, can, personId, requireRole } from "./actors.js";
import { NotFound, Refusal, decide, writeAudit } from "./audit.js";
import type { DB } from "./db.js";
import { getPerson, type PersonRow } from "./people.js";
import { checkEligible, checkLeaverSteps, dateOf, lastDayReached } from "./policy.js";
import { LEAVER_ORDER, SYSTEMS, isSystemKey, needsSecondApproval, type SystemKey } from "./systems.js";

export type RequestRow = {
  id: number;
  requester_id: number;
  person_id: number;
  system: SystemKey;
  level: string;
  reason: string;
  status: "open" | "approved" | "denied" | "granted";
  created_at: string;
  decided_by: number | null;
  decided_at: string | null;
};

export type GrantRow = {
  id: number;
  person_id: number;
  system: SystemKey;
  level: string;
  request_id: number | null;
  granted_by: number;
  approved_by: number | null;
  granted_at: string;
  revoked_at: string | null;
  revoked_by: number | null;
  revoked_by_system: number | null;
};

function systemKey(key: string): SystemKey {
  if (!isSystemKey(key)) throw new Refusal("system", `no system "${key}"`, 400);
  return key;
}

function getRequest(db: DB, id: number): RequestRow {
  const row = db.prepare("SELECT * FROM access_requests WHERE id = ?").get(id) as RequestRow | undefined;
  if (!row) throw new NotFound(`no request ${id}`);
  return row;
}

function getGrant(db: DB, id: number): GrantRow {
  const row = db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as GrantRow | undefined;
  if (!row) throw new NotFound(`no grant ${id}`);
  return row;
}

function liveGrants(db: DB, personId: number): GrantRow[] {
  return db.prepare("SELECT * FROM grants WHERE person_id = ? AND revoked_at IS NULL").all(personId) as GrantRow[];
}

export type NewRequest = { personId: number; system: string; level: string; reason: string };

export function requestAccess(db: DB, actor: Actor, input: NewRequest, at: string): RequestRow {
  return decide(db, actor, at, `person:${input.personId}`, () => {
    requireRole(actor, "request access");
    const requester = personId(actor);
    const p = getPerson(db, input.personId);
    if (actor.role === "manager" && p.manager_id !== requester) {
      throw new Refusal("not-own-report", `${p.name} does not report to ${actor.name}`);
    }
    const system = systemKey(input.system);
    checkEligible(p, system, input.level, dateOf(at));
    const id = Number(
      db
        .prepare(
          `INSERT INTO access_requests (requester_id, person_id, system, level, reason, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(requester, p.id, system, input.level, input.reason, at).lastInsertRowid,
    );
    writeAudit(db, actor, {
      action: "request",
      subject: `request:${id}`,
      detail: `${SYSTEMS[system].name} ${input.level} for ${p.name}`,
      at,
    });
    return getRequest(db, id);
  });
}

function decideRequest(db: DB, actor: Actor, id: number, outcome: "approved" | "denied", at: string): RequestRow {
  return decide(db, actor, at, `request:${id}`, () => {
    requireRole(actor, "approve or deny requests");
    const decider = personId(actor);
    const r = getRequest(db, id);
    if (r.status !== "open") throw new Refusal("not-open", `request ${id} is already ${r.status}`, 409);
    if (decider === r.requester_id) throw new Refusal("own-request", "nobody decides their own request");
    if (decider === r.person_id) throw new Refusal("own-access", "nobody decides a request for their own access");
    db.prepare("UPDATE access_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(
      outcome,
      decider,
      at,
      id,
    );
    writeAudit(db, actor, {
      action: outcome === "approved" ? "approve" : "deny",
      subject: `request:${id}`,
      detail: `${SYSTEMS[r.system].name} ${r.level} for ${getPerson(db, r.person_id).name}`,
      at,
    });
    return getRequest(db, id);
  });
}

export function approveRequest(db: DB, actor: Actor, id: number, at: string): RequestRow {
  return decideRequest(db, actor, id, "approved", at);
}

export function denyRequest(db: DB, actor: Actor, id: number, at: string): RequestRow {
  return decideRequest(db, actor, id, "denied", at);
}

export type NewGrant = { requestId: number } | { personId: number; system: string; level: string };

function resolveGrant(db: DB, input: NewGrant) {
  if (!("requestId" in input)) return { request: undefined, ...input };
  const request = getRequest(db, input.requestId);
  return { request, personId: request.person_id, system: request.system as string, level: request.level };
}

/**
 * Applies a grant through the system's adapter. AWS and any admin level are
 * applied only from a request approved by someone other than its holder, its
 * requester and the person applying it. A grant from a request takes the
 * person, system and level from the request.
 */
export function applyGrant(db: DB, actor: Actor, input: NewGrant, at: string): GrantRow {
  const subject = "requestId" in input ? `request:${input.requestId}` : `person:${input.personId}`;
  return decide(db, actor, at, subject, () => {
    requireRole(actor, "grant or revoke access");
    const grantedBy = personId(actor);
    const { request, personId: target, system: key, level } = resolveGrant(db, input);
    const p = getPerson(db, target);
    if (p.id === grantedBy) throw new Refusal("own-access", "nobody grants their own access");
    const system = systemKey(key);
    checkEligible(p, system, level, dateOf(at));
    if (request && request.status !== "open" && request.status !== "approved") {
      throw new Refusal("not-open", `request ${request.id} is ${request.status}`, 409);
    }
    if (needsSecondApproval(system, level) && request?.status !== "approved") {
      throw new Refusal("needs-approval", `${SYSTEMS[system].name} ${level} needs an approved request`);
    }
    if (request?.decided_by === grantedBy) {
      throw new Refusal("own-approval", "the person who approved a request does not also apply it");
    }
    if (liveGrants(db, p.id).some((g) => g.system === system)) {
      throw new Refusal("already-held", `${p.name} already holds ${SYSTEMS[system].name}; revoke it to change level`, 409);
    }
    SYSTEMS[system].adapter.grant(db, p, level, at);
    const id = Number(
      db
        .prepare(
          `INSERT INTO grants (person_id, system, level, request_id, granted_by, approved_by, granted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(p.id, system, level, request?.id ?? null, grantedBy, request?.decided_by ?? null, at).lastInsertRowid,
    );
    if (request) db.prepare("UPDATE access_requests SET status = 'granted' WHERE id = ?").run(request.id);
    writeAudit(db, actor, { action: "grant", subject: `grant:${id}`, detail: `${SYSTEMS[system].name} ${level} for ${p.name}`, at });
    return getGrant(db, id);
  });
}

function revokeLive(db: DB, actor: Actor, p: PersonRow, g: GrantRow, why: string, at: string): void {
  SYSTEMS[g.system].adapter.revoke(db, p, g.level, at);
  db.prepare("UPDATE grants SET revoked_at = ?, revoked_by = ?, revoked_by_system = ? WHERE id = ?").run(
    at,
    actor.kind === "person" ? actor.id : null,
    actor.kind === "system" ? actor.id : null,
    g.id,
  );
  writeAudit(db, actor, {
    action: "revoke",
    subject: `grant:${g.id}`,
    detail: `${SYSTEMS[g.system].name} ${g.level} for ${p.name}${why}`,
    at,
  });
}

/** Revokes one grant. From a person's last day on, their access goes through the leaver run instead. */
export function revokeGrant(db: DB, actor: Actor, id: number, at: string): GrantRow {
  return decide(db, actor, at, `grant:${id}`, () => {
    requireRole(actor, "grant or revoke access");
    const g = getGrant(db, id);
    if (g.revoked_at) throw new Refusal("not-live", `grant ${id} was revoked at ${g.revoked_at}`, 409);
    const p = getPerson(db, g.person_id);
    if (lastDayReached(p, dateOf(at))) {
      throw new Refusal("use-leaver-run", `${p.name}'s last day has come; their access is revoked by the leaver run`, 409);
    }
    revokeLive(db, actor, p, g, "", at);
    return getGrant(db, id);
  });
}

export type LeaverRun = { person: string; revoked: { system: SystemKey; level: string }[] };

function revokeInOrder(db: DB, actor: Actor, p: PersonRow, why: (step: number) => string, at: string): LeaverRun {
  const live = liveGrants(db, p.id);
  const revoked: LeaverRun["revoked"] = [];
  LEAVER_ORDER.forEach((system, i) => {
    for (const g of live.filter((x) => x.system === system)) {
      revokeLive(db, actor, p, g, why(i + 1), at);
      revoked.push({ system, level: g.level });
    }
  });
  return { person: p.name, revoked };
}

/** Revokes everything a leaver holds, from their last day on, one step per system in the fixed order. */
export function runLeaver(db: DB, actor: Actor, id: number, steps: readonly string[], at: string): LeaverRun {
  return decide(db, actor, at, `person:${id}`, () => {
    requireRole(actor, "grant or revoke access");
    checkLeaverSteps(steps);
    const p = getPerson(db, id);
    if (!lastDayReached(p, dateOf(at))) {
      throw new Refusal("not-leaving", `${p.name} has no last day on or before ${dateOf(at)}`, 409);
    }
    return revokeInOrder(db, actor, p, (step) => `, leaver run step ${step} of ${LEAVER_ORDER.length}`, at);
  });
}

/**
 * Ends access for every contractor whose contract end date is on file and has
 * arrived. Besides it and admin, the nightly run may do this, and only this.
 */
export function endContracts(db: DB, actor: Actor, at: string): LeaverRun[] {
  return decide(db, actor, at, "contracts", () => {
    if (!(actor.kind === "system" && actor.name === NIGHTLY_REPORT)) requireRole(actor, "grant or revoke access");
    const today = dateOf(at);
    const ended = db
      .prepare(
        `SELECT DISTINCT p.id FROM people p JOIN grants g ON g.person_id = p.id AND g.revoked_at IS NULL
          WHERE p.contract_end_date IS NOT NULL AND p.contract_end_date <= ? ORDER BY p.id`,
      )
      .all(today) as { id: number }[];
    return ended.map(({ id }) => {
      const p = getPerson(db, id);
      return revokeInOrder(db, actor, p, () => `, contract ended ${p.contract_end_date}`, at);
    });
  });
}

export type ListedRequest = RequestRow & { person: string; requester: string };

/** Requests, newest first; a manager sees the requests they made. */
export function listRequests(db: DB, actor: Actor, status: string | null, at: string): ListedRequest[] {
  return decide(db, actor, at, "requests", () => {
    requireRole(actor, "request access");
    return db
      .prepare(
        `SELECT r.*, p.name AS person, q.name AS requester
           FROM access_requests r JOIN people p ON p.id = r.person_id JOIN people q ON q.id = r.requester_id
          WHERE (@status IS NULL OR r.status = @status) AND (@all OR r.requester_id = @me)
          ORDER BY r.id DESC`,
      )
      .all({ status, all: actor.role === "manager" ? 0 : 1, me: actor.id }) as ListedRequest[];
  });
}

/** Live grants; managers see their own reports' grants. */
export function listLiveGrants(db: DB, actor: Actor, at: string): (GrantRow & { person: string })[] {
  return decide(db, actor, at, "grants", () => {
    const all = can(actor, "read personal fields") || can(actor, "grant or revoke access");
    if (!all && actor.role !== "manager") throw new Refusal("role", `${actor.role} may not read grants`);
    return db
      .prepare(
        `SELECT g.*, p.name AS person FROM grants g JOIN people p ON p.id = g.person_id
          WHERE g.revoked_at IS NULL AND (@all OR p.manager_id = @me)
          ORDER BY p.name, g.system`,
      )
      .all({ all: all ? 1 : 0, me: actor.kind === "person" ? actor.id : -1 }) as (GrantRow & { person: string })[];
  });
}
