import type { DB } from "../db.js";
import type { PersonRow } from "../people.js";
import { teamSlug, writeSystemLog } from "./system-log.js";

export function grant(db: DB, p: PersonRow, level: string, at: string): void {
  writeSystemLog(db, {
    system: "mail",
    op: "create-mailbox",
    target: p.work_email,
    detail:
      level === "admin"
        ? "mailbox with admin console access"
        : `mailbox, added to ${teamSlug(p)}@ list and the ${p.team} calendar`,
    at,
  });
}

export function revoke(db: DB, p: PersonRow, level: string, at: string): void {
  writeSystemLog(db, {
    system: "mail",
    op: "suspend-mailbox",
    target: p.work_email,
    detail: `${level} mailbox suspended, mail held for 90 days, calendar events transferred to the team calendar`,
    at,
  });
}
