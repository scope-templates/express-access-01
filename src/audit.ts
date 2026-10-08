import type { Actor } from "./actors.js";
import type { DB } from "./db.js";

export class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 403,
  ) {
    super(message);
  }
}

export class NotFound extends Error {}

export type AuditEntry = { action: string; subject: string; detail: string; at: string };

/** Refuses, and writes nothing, when the clock reads earlier than the last entry. */
export function writeAudit(db: DB, actor: Actor, entry: AuditEntry): void {
  const last = db.prepare("SELECT at FROM audit_log ORDER BY id DESC LIMIT 1").get() as { at: string } | undefined;
  if (last && entry.at < last.at) {
    throw new Refusal("clock-behind", `the clock reads ${entry.at}, before the last audit entry at ${last.at}`, 409);
  }
  db.prepare(
    `INSERT INTO audit_log (at, actor_person_id, actor_system_id, action, subject, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.at,
    actor.kind === "person" ? actor.id : null,
    actor.kind === "system" ? actor.id : null,
    entry.action,
    entry.subject,
    entry.detail,
  );
}

/**
 * Runs one decision in a transaction. A refused decision rolls back and is
 * then written to the audit log on its own, so the refusal survives.
 */
export function decide<T>(db: DB, actor: Actor, at: string, subject: string, fn: () => T): T {
  try {
    return db.transaction(fn)();
  } catch (err) {
    if (err instanceof Refusal && err.code !== "clock-behind") {
      writeAudit(db, actor, { action: "refuse", subject, detail: `${err.code}: ${err.message}`, at });
    }
    throw err;
  }
}
