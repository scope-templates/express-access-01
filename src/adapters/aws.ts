import type { DB } from "../db.js";
import type { PersonRow } from "../people.js";
import { handle, writeSystemLog } from "./system-log.js";

const GROUPS: Record<string, string> = {
  read: "readonly in staging and production",
  deploy: "deployers in staging and production",
  admin: "administrators in all accounts",
};

export function grant(db: DB, p: PersonRow, level: string, at: string): void {
  writeSystemLog(db, {
    system: "aws",
    op: "add-user-to-group",
    target: handle(p),
    detail: `IAM user ${handle(p)}, group ${GROUPS[level]}, MFA required at first sign-in`,
    at,
  });
}

export function revoke(db: DB, p: PersonRow, level: string, at: string): void {
  writeSystemLog(db, {
    system: "aws",
    op: "disable-user",
    target: handle(p),
    detail: `removed from ${GROUPS[level]}; console password deleted, access keys deactivated`,
    at,
  });
}
