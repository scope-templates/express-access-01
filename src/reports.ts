import { type LeaverRun, endContracts } from "./access.js";
import { type Actor, NIGHTLY_REPORT, requireRole, systemActor } from "./actors.js";
import { decide, writeAudit } from "./audit.js";
import type { DB } from "./db.js";
import type { PersonRow } from "./people.js";
import { dateOf, daysBetween, endedOn } from "./policy.js";
import { LEAVER_ORDER, SYSTEMS, type SystemKey } from "./systems.js";

export type StaleReport = {
  asOf: string;
  lastImport: { file: string; at: string; daysAgo: number } | null;
  endedWithAccess: { id: number; name: string; team: string; kind: string; ended: string; daysSince: number; holds: string[] }[];
  startedWithoutAccess: { id: number; name: string; team: string; started: string; daysSince: number; openRequests: number }[];
};

type Row = PersonRow & { holds: string | null; open_requests: number };

/**
 * People whose end date has passed and who still hold a grant (a contract end
 * date counts on the day), and people whose start date has passed with no grant.
 */
export function staleAccess(db: DB, asOf: string): StaleReport {
  const people = db
    .prepare(
      `SELECT p.*, t.name AS team,
              (SELECT group_concat(g.system || ':' || g.level, ',') FROM grants g
                WHERE g.person_id = p.id AND g.revoked_at IS NULL) AS holds,
              (SELECT COUNT(*) FROM access_requests r
                WHERE r.person_id = p.id AND r.status IN ('open', 'approved')) AS open_requests
         FROM people p JOIN teams t ON t.id = p.team_id
        ORDER BY p.name`,
    )
    .all() as Row[];
  const last = db
    .prepare("SELECT file, at FROM import_runs WHERE substr(at, 1, 10) <= ? ORDER BY at DESC, id DESC LIMIT 1")
    .get(asOf) as
    | { file: string; at: string }
    | undefined;

  const report: StaleReport = {
    asOf,
    lastImport: last ? { ...last, daysAgo: daysBetween(last.at.slice(0, 10), asOf) } : null,
    endedWithAccess: [],
    startedWithoutAccess: [],
  };
  for (const p of people) {
    const ended = endedOn(p, asOf);
    if (ended && p.holds) {
      const holds = p.holds
        .split(",")
        .map((h) => h.split(":") as [SystemKey, string])
        .sort(([a], [b]) => LEAVER_ORDER.indexOf(a) - LEAVER_ORDER.indexOf(b))
        .map(([system, level]) => `${SYSTEMS[system].name} ${level}`);
      report.endedWithAccess.push({ id: p.id, name: p.name, team: p.team, kind: p.kind, ended, daysSince: daysBetween(ended, asOf), holds });
    } else if (!ended && !p.holds && p.start_date < asOf) {
      report.startedWithoutAccess.push({
        id: p.id,
        name: p.name,
        team: p.team,
        started: p.start_date,
        daysSince: daysBetween(p.start_date, asOf),
        openRequests: p.open_requests,
      });
    }
  }
  return report;
}

export function formatStaleReport(r: StaleReport): string {
  const lines = [`Stale access as of ${r.asOf}`];
  lines.push(
    r.lastImport
      ? `People data from the monthly import ${r.lastImport.file}, loaded ${r.lastImport.at.slice(0, 10)} (${r.lastImport.daysAgo} days ago)`
      : "No monthly import on file",
  );
  lines.push("", `Ended, still holding access (${r.endedWithAccess.length})`);
  for (const p of r.endedWithAccess) {
    lines.push(`  ${p.name} (${p.team}, ${p.kind}) ended ${p.ended}, ${p.daysSince} days ago: ${p.holds.join(", ")}`);
  }
  lines.push("", `Started, holding no access (${r.startedWithoutAccess.length})`);
  for (const p of r.startedWithoutAccess) {
    lines.push(`  ${p.name} (${p.team}) started ${p.started}, ${p.daysSince} days ago; ${p.openRequests} open requests`);
  }
  return `${lines.join("\n")}\n`;
}

export type NightlyRun = { report: StaleReport; ended: LeaverRun[] };

/**
 * The nightly run, signed by the nightly-report system actor: the stale-access
 * report as the store stands, then access ended for contracts whose end date is
 * on file and has arrived.
 */
export function nightlyRun(db: DB, at: string): NightlyRun {
  const actor = systemActor(db, NIGHTLY_REPORT);
  if (!actor) throw new Error(`system actor ${NIGHTLY_REPORT} is not on file`);
  const report = staleAccess(db, dateOf(at));
  writeAudit(db, actor, {
    action: "report",
    subject: "stale-access",
    detail: `${report.endedWithAccess.length} ended with access, ${report.startedWithoutAccess.length} started without access`,
    at,
  });
  return { report, ended: endContracts(db, actor, at) };
}

export function formatNightlyRun({ report, ended }: NightlyRun): string {
  const lines = ["", `Contracts ended tonight (${ended.length})`];
  for (const run of ended) lines.push(`  ${run.person}: ${run.revoked.map((r) => `${SYSTEMS[r.system].name} ${r.level}`).join(", ")}`);
  return `${formatStaleReport(report)}${lines.join("\n")}\n`;
}

export type AuditRow = {
  id: number;
  at: string;
  actor: string;
  actor_role: string;
  action: string;
  subject: string;
  detail: string;
};

export function listAudit(db: DB, actor: Actor, limit: number, at: string): AuditRow[] {
  return decide(db, actor, at, "audit_log", () => {
    requireRole(actor, "read the audit log");
    return db
      .prepare(
        `SELECT a.id, a.at, COALESCE(p.name, s.name) AS actor, COALESCE(p.role, s.role) AS actor_role,
                a.action, a.subject, a.detail
           FROM audit_log a
           LEFT JOIN people p ON p.id = a.actor_person_id
           LEFT JOIN system_actors s ON s.id = a.actor_system_id
          ORDER BY a.id DESC
          LIMIT ?`,
      )
      .all(limit) as AuditRow[];
  });
}
