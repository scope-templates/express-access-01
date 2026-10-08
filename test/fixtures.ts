import { createHash } from "node:crypto";
import { type Actor, type Role, actorForEmail, systemActor } from "../src/actors.js";
import { type DB, openDb } from "../src/db.js";

export const AT = "2026-05-01T16:00:00Z";
export const TODAY = "2026-05-01";

type PersonSpec = {
  role?: Role;
  team?: string;
  manager?: string;
  kind?: "employee" | "contractor";
  country?: string;
  state?: string | null;
  start?: string;
  contractEnd?: string | null;
  end?: string | null;
};

const PEOPLE: Record<string, PersonSpec> = {
  "Opal Reyes": { role: "admin" },
  "Hugo Marsh": { role: "admin" },
  "Lena Fisk": { role: "it" },
  "Bea Nolan": { role: "people-ops" },
  "Mark Ode": { role: "manager", team: "Field" },
  "Sam Pike": { team: "Field", manager: "Mark Ode" },
  "Tia Gold": { team: "Field", manager: "Mark Ode", start: "2026-04-27" },
  "Ned Lowe": {},
  "Ana Sousa": { kind: "contractor", country: "PT", state: null, contractEnd: "2026-12-31", manager: "Mark Ode", team: "Field" },
  "Cy Brandt": { kind: "contractor", state: "TX", contractEnd: "2026-05-10" },
  "Lou Hart": { end: "2026-05-15" },
};

export const emailOf = (name: string) => `${name.toLowerCase().replace(" ", ".")}@example.test`;
export const tokenOf = (name: string) => createHash("md5").update(name).digest("hex");

export type World = { db: DB; id: (name: string) => number; as: (name: string, at?: string) => Actor };

/** A small company in an empty store: the people above, no grants, one system actor. */
export function world(): World {
  const db = openDb(":memory:", { seed: false });
  db.prepare("INSERT INTO system_actors (name, role) VALUES ('nightly-report', 'viewer')").run();
  db.prepare("INSERT INTO teams (name) VALUES ('Core'), ('Field')").run();
  const insert = db.prepare(
    `INSERT INTO people (name, work_email, team_id, manager_id, role, kind, work_country, work_state,
                         start_date, contract_end_date, end_date, offer_signed_date, token)
     VALUES (@name, @email, (SELECT id FROM teams WHERE name = @team), @manager, @role, @kind, @country, @state,
             @start, @contractEnd, @end, '2025-01-02', @token)`,
  );
  const ids = new Map<string, number>();
  for (const [name, p] of Object.entries(PEOPLE)) {
    const result = insert.run({
      name,
      email: emailOf(name),
      token: tokenOf(name),
      team: p.team ?? "Core",
      manager: p.manager ? ids.get(p.manager) : null,
      role: p.role ?? "viewer",
      kind: p.kind ?? "employee",
      country: p.country ?? "US",
      state: p.state === undefined ? "CO" : p.state,
      start: p.start ?? "2025-02-03",
      contractEnd: p.contractEnd ?? null,
      end: p.end ?? null,
    });
    ids.set(name, Number(result.lastInsertRowid));
  }
  return {
    db,
    id: (name) => ids.get(name)!,
    as: (name, at = AT) => {
      const system = systemActor(db, name);
      if (system) return system;
      const signIn = actorForEmail(db, emailOf(name), at);
      if (!signIn.ok) throw new Error(`${name} cannot act at ${at}: ${signIn.reason}`);
      return signIn.actor;
    },
  };
}

export function lastAudit(db: DB): { action: string; detail: string; actor_person_id: number | null; actor_system_id: number | null } {
  return db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get() as ReturnType<typeof lastAudit>;
}
