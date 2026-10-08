import type { DB } from "../db.js";
import type { PersonRow } from "../people.js";
import { handle, teamSlug, writeSystemLog } from "./system-log.js";

const ORG = "veldra-routing";

const ORG_ACCESS: Record<string, string> = {
  read: "member, read on team repositories",
  write: "member, write on team repositories",
  admin: "owner",
};

export function grant(db: DB, p: PersonRow, level: string, at: string): void {
  writeSystemLog(db, {
    system: "github",
    op: "add-to-org",
    target: handle(p),
    detail: `org ${ORG}, team ${teamSlug(p)}, ${ORG_ACCESS[level]}`,
    at,
  });
}

export function revoke(db: DB, p: PersonRow, level: string, at: string): void {
  writeSystemLog(db, {
    system: "github",
    op: "remove-from-org",
    target: handle(p),
    detail: `org ${ORG}, was ${ORG_ACCESS[level]}; pending invitations cancelled`,
    at,
  });
}
