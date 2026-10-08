import type { DB } from "../db.js";
import type { PersonRow } from "../people.js";
import { teamSlug, writeSystemLog } from "./system-log.js";

export function grant(db: DB, p: PersonRow, level: string, at: string): void {
  const access =
    level === "guest"
      ? `single-channel guest in #${teamSlug(p)}`
      : level === "admin"
        ? "workspace admin"
        : `full member, added to #general and #${teamSlug(p)}`;
  writeSystemLog(db, { system: "slack", op: "invite", target: p.work_email, detail: access, at });
}

export function revoke(db: DB, p: PersonRow, level: string, at: string): void {
  writeSystemLog(db, {
    system: "slack",
    op: "deactivate",
    target: p.work_email,
    detail: `${level} account deactivated, all sessions signed out`,
    at,
  });
}
