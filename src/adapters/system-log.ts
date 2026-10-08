import type { DB } from "../db.js";
import type { PersonRow } from "../people.js";

export type SystemLogEntry = { system: string; op: string; target: string; detail: string; at: string };

export function writeSystemLog(db: DB, entry: SystemLogEntry): void {
  db.prepare("INSERT INTO system_log (at, system, op, target, detail) VALUES (@at, @system, @op, @target, @detail)").run(
    entry,
  );
}

export function handle(p: PersonRow): string {
  return p.work_email.split("@")[0];
}

export function teamSlug(p: PersonRow): string {
  return p.team.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
