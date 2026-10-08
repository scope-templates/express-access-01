import { Refusal, writeAudit } from "./audit.js";
import type { DB } from "./db.js";
import { dateOf, endedOn } from "./policy.js";

export const ROLES = ["admin", "people-ops", "it", "manager", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export type Actor = { kind: "person" | "system"; id: number; name: string; role: Role };

export const NIGHTLY_REPORT = "nightly-report";

export const ALLOWED = {
  "grant or revoke access": ["admin", "it"],
  "approve or deny requests": ["admin", "it"],
  "request access": ["admin", "it", "people-ops", "manager"],
  "change people records": ["admin", "people-ops"],
  "read personal fields": ["admin", "it", "people-ops"],
  "read the audit log": ["admin", "it"],
  "change roles": ["admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof ALLOWED;

export function can(actor: Actor, what: Permission): boolean {
  return (ALLOWED[what] as readonly Role[]).includes(actor.role);
}

export function requireRole(actor: Actor, what: Permission): void {
  if (!can(actor, what)) throw new Refusal("role", `${actor.role} may not ${what}`);
}

/** Grants, revokes and decisions are signed by a person; system actors only report. */
export function personId(actor: Actor): number {
  if (actor.kind !== "person") throw new Refusal("system-actor", `${actor.name} is a system actor`);
  return actor.id;
}

type ActorRow = { id: number; name: string; role: Role };
type PersonActorRow = ActorRow & { end_date: string | null; contract_end_date: string | null };

const PERSON_ACTOR = "SELECT id, name, role, end_date, contract_end_date FROM people";

export type SignIn =
  | { ok: true; actor: Actor }
  | { ok: false; reason: "token_missing" | "token_unknown" }
  | { ok: false; reason: "access_ended"; person: Actor };

export const SIGN_IN_REFUSED: Record<Exclude<SignIn, { ok: true }>["reason"], string> = {
  token_missing: "send Authorization: Bearer <your access desk token>",
  token_unknown: "no person holds this token",
  access_ended: "this person's access has ended",
};

/**
 * Checked against today on every call: people past their end date or contract
 * end date cannot act, and the refused attempt is written to the audit log.
 */
function signIn(db: DB, row: PersonActorRow | undefined, at: string): SignIn {
  if (!row) return { ok: false, reason: "token_unknown" };
  const actor: Actor = { kind: "person", id: row.id, name: row.name, role: row.role };
  const ended = endedOn(row, dateOf(at));
  if (!ended) return { ok: true, actor };
  writeAudit(db, actor, { action: "refuse", subject: `person:${row.id}`, detail: `access_ended: access ended ${ended}`, at });
  return { ok: false, reason: "access_ended", person: actor };
}

/** The person holding a secret token. System actors hold no token and never act over HTTP. */
export function actorForToken(db: DB, token: string | undefined, at: string): SignIn {
  if (!token) return { ok: false, reason: "token_missing" };
  return signIn(db, db.prepare(`${PERSON_ACTOR} WHERE token = ?`).get(token) as PersonActorRow | undefined, at);
}

/** The person at a work email, for the command-line scripts run on the host. */
export function actorForEmail(db: DB, email: string, at: string): SignIn {
  const row = db.prepare(`${PERSON_ACTOR} WHERE work_email = ?`).get(email.trim().toLowerCase()) as PersonActorRow | undefined;
  return signIn(db, row, at);
}

export function systemActor(db: DB, name: string): Actor | undefined {
  const row = db.prepare("SELECT id, name, role FROM system_actors WHERE name = ?").get(name) as ActorRow | undefined;
  return row ? { kind: "system", ...row } : undefined;
}
