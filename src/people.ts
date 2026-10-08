import { randomBytes } from "node:crypto";
import { z } from "zod";
import { type Actor, ROLES, type Role, can, personId, requireRole } from "./actors.js";
import { NotFound, Refusal, decide, writeAudit } from "./audit.js";
import type { DB } from "./db.js";
import { IsoDate, dateOf, isAbroad, statusOn } from "./policy.js";

export type PersonRow = {
  id: number;
  name: string;
  work_email: string;
  team_id: number;
  team: string;
  manager_id: number | null;
  manager: string | null;
  role: Role;
  kind: "employee" | "contractor";
  work_country: string;
  work_state: string | null;
  start_date: string;
  contract_end_date: string | null;
  end_date: string | null;
  offer_signed_date: string;
};

const PERSON_SELECT = `
  SELECT p.id, p.name, p.work_email, p.team_id, t.name AS team, p.manager_id, m.name AS manager, p.role, p.kind,
         p.work_country, p.work_state, p.start_date, p.contract_end_date, p.end_date, p.offer_signed_date
    FROM people p
    JOIN teams t ON t.id = p.team_id
    LEFT JOIN people m ON m.id = p.manager_id`;

export function getPerson(db: DB, id: number): PersonRow {
  const row = db.prepare(`${PERSON_SELECT} WHERE p.id = ?`).get(id) as PersonRow | undefined;
  if (!row) throw new NotFound(`no person ${id}`);
  return row;
}

function findByEmail(db: DB, email: string): PersonRow | undefined {
  return db.prepare(`${PERSON_SELECT} WHERE p.work_email = ?`).get(email) as PersonRow | undefined;
}

const blankAsNull = (v: unknown) => (v === "" || v === undefined ? null : v);
const optionalDate = z.preprocess(blankAsNull, IsoDate.nullable());

const PersonFields = z.object({
  name: z.string().trim().min(1),
  work_email: z.string().trim().toLowerCase().email(),
  team: z.string().trim().min(1),
  manager_email: z.preprocess(blankAsNull, z.string().trim().toLowerCase().email().nullable()),
  kind: z.enum(["employee", "contractor"]),
  work_country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "two-letter country code"),
  work_state: z.preprocess(blankAsNull, z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).nullable()),
  start_date: IsoDate,
  contract_end_date: optionalDate,
  end_date: optionalDate,
  offer_signed_date: IsoDate,
});

function checkPlace(p: z.infer<typeof PersonFields>, ctx: z.RefinementCtx): void {
  if ((p.work_country === "US") !== (p.work_state !== null)) {
    ctx.addIssue({ code: "custom", path: ["work_state"], message: "a state is given for US staff only" });
  }
  if (p.kind !== "contractor" && p.contract_end_date !== null) {
    ctx.addIssue({ code: "custom", path: ["contract_end_date"], message: "only contractors have one" });
  }
}

/** One person as typed from the signed offer. */
export const PersonInput = PersonFields.superRefine(checkPlace);
export type PersonInput = z.infer<typeof PersonInput>;

/** One row of the monthly import; the role column may be left out or blank. */
const ImportRow = PersonFields.extend({ role: z.preprocess(blankAsNull, z.enum(ROLES).nullable()) }).superRefine(checkPlace);
type ImportRow = z.infer<typeof ImportRow>;

function teamId(db: DB, name: string): number {
  db.prepare("INSERT OR IGNORE INTO teams (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM teams WHERE name = ?").get(name) as { id: number }).id;
}

function managerId(db: DB, email: string | null): number | null {
  if (email === null) return null;
  const manager = findByEmail(db, email);
  if (!manager) throw new Refusal("unknown-manager", `no person with work email ${email}`, 400);
  return manager.id;
}

/** Each person signs in with their own token, handed to them when they are added. */
export function newToken(): string {
  return randomBytes(16).toString("hex");
}

function insertPerson(db: DB, p: PersonInput, role: Role): { id: number; token: string } {
  const token = newToken();
  const id = Number(
    db
      .prepare(
        `INSERT INTO people (name, work_email, team_id, manager_id, role, kind, work_country, work_state,
                             start_date, contract_end_date, end_date, offer_signed_date, token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.name,
        p.work_email,
        teamId(db, p.team),
        managerId(db, p.manager_email),
        role,
        p.kind,
        p.work_country,
        p.work_state,
        p.start_date,
        p.contract_end_date,
        p.end_date,
        p.offer_signed_date,
        token,
      ).lastInsertRowid,
  );
  return { id, token };
}

export type NewPerson = { person: PersonRow; token: string };

/** Adds a person typed in from their signed offer letter, as a viewer. */
export function addPerson(db: DB, actor: Actor, input: unknown, at: string): NewPerson {
  const p = PersonInput.parse(input);
  return decide(db, actor, at, `person:${p.work_email}`, () => {
    requireRole(actor, "change people records");
    if (findByEmail(db, p.work_email)) throw new Refusal("exists", `${p.work_email} is already on file`, 409);
    const { id, token } = insertPerson(db, p, "viewer");
    writeAudit(db, actor, { action: "person.add", subject: `person:${id}`, detail: `${p.name}, entered from the signed offer`, at });
    return { person: getPerson(db, id), token };
  });
}

export function setRole(db: DB, actor: Actor, id: number, role: string, at: string): PersonRow {
  const next = z.enum(ROLES).parse(role);
  return decide(db, actor, at, `person:${id}`, () => {
    requireRole(actor, "change roles");
    const p = getPerson(db, id);
    db.prepare("UPDATE people SET role = ? WHERE id = ?").run(next, id);
    writeAudit(db, actor, { action: "person.update", subject: `person:${id}`, detail: `role: ${p.role} -> ${next}`, at });
    return getPerson(db, id);
  });
}

export function recordEndDate(db: DB, actor: Actor, id: number, endDate: string, at: string): PersonRow {
  const date = IsoDate.parse(endDate);
  return decide(db, actor, at, `person:${id}`, () => {
    requireRole(actor, "change people records");
    const p = getPerson(db, id);
    db.prepare("UPDATE people SET end_date = ? WHERE id = ?").run(date, id);
    writeAudit(db, actor, {
      action: "person.update",
      subject: `person:${id}`,
      detail: `end_date: ${p.end_date ?? "-"} -> ${date}`,
      at,
    });
    return getPerson(db, id);
  });
}

const COMPARED = [
  "name",
  "team",
  "manager_email",
  "kind",
  "work_country",
  "work_state",
  "start_date",
  "contract_end_date",
  "end_date",
  "offer_signed_date",
] as const;

export type ImportResult = { run: number; rows: number; added: number; updated: number; tokens: NewPerson[] };

/**
 * The monthly import: every row is checked before anything is written, then
 * people are added or updated by work email. Only an admin's file may change
 * a role. Grants are not touched.
 */
export function importPeople(db: DB, actor: Actor, file: string, records: Record<string, string>[], at: string): ImportResult {
  return decide(db, actor, at, `import:${file}`, () => {
    requireRole(actor, "change people records");
    const rows: ImportRow[] = [];
    const problems: string[] = [];
    records.forEach((record, i) => {
      const parsed = ImportRow.safeParse(record);
      if (parsed.success) rows.push(parsed.data);
      else problems.push(`line ${i + 2}: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
    });
    const seen = new Set<string>();
    for (const { work_email } of rows) {
      if (seen.has(work_email)) problems.push(`${work_email} appears twice`);
      seen.add(work_email);
    }
    if (problems.length > 0) throw new Refusal("bad-rows", problems.join(" | "), 400);
    const holdsAws = db.prepare(
      `SELECT 1 FROM grants g JOIN people p ON p.id = g.person_id
        WHERE p.work_email = ? AND g.system = 'aws' AND g.revoked_at IS NULL`,
    );
    const abroadWithAws = rows.filter((r) => isAbroad(r) && holdsAws.get(r.work_email));
    if (abroadWithAws.length > 0) {
      const names = abroadWithAws.map((r) => r.name).join(", ");
      throw new Refusal("abroad-aws", `${names} would work abroad holding AWS; revoke AWS before the import`);
    }
    const unknownManagers = rows.filter((r) => r.manager_email !== null && !seen.has(r.manager_email) && !findByEmail(db, r.manager_email));
    if (unknownManagers.length > 0) {
      const emails = unknownManagers.map((r) => r.manager_email).join(", ");
      throw new Refusal("unknown-manager", `no person with work email ${emails} on file or in the file`, 400);
    }
    const roleChanges = rows.filter((r) => r.role !== null && r.role !== (findByEmail(db, r.work_email)?.role ?? "viewer"));
    if (roleChanges.length > 0 && !can(actor, "change roles")) {
      const names = roleChanges.map((r) => r.name).join(", ");
      throw new Refusal("role", `${actor.role} may not change roles; the file sets a new role for ${names}`);
    }

    let added = 0;
    let updated = 0;
    const tokens: NewPerson[] = [];
    for (const row of rows) {
      if (findByEmail(db, row.work_email)) continue;
      const role = row.role ?? "viewer";
      const { id, token } = insertPerson(db, { ...row, manager_email: null }, role);
      tokens.push({ person: getPerson(db, id), token });
      added++;
      writeAudit(db, actor, {
        action: "person.add",
        subject: `person:${id}`,
        detail: `${row.name}, ${role}, the monthly import ${file}`,
        at,
      });
    }
    const addedIds = new Set(tokens.map((t) => t.person.id));
    for (const row of rows) {
      const current = findByEmail(db, row.work_email)!;
      const managerEmail = current.manager_id === null ? null : getPerson(db, current.manager_id).work_email;
      const before = { ...current, manager_email: managerEmail } as Record<string, unknown>;
      const fields = row.role === null ? COMPARED : [...COMPARED, "role" as const];
      const changes = fields.filter((f) => before[f] !== row[f]).map((f) => `${f}: ${before[f] ?? "-"} -> ${row[f] ?? "-"}`);
      if (changes.length === 0) continue;
      db.prepare(
        `UPDATE people SET name = ?, role = ?, team_id = ?, manager_id = ?, kind = ?, work_country = ?, work_state = ?,
                start_date = ?, contract_end_date = ?, end_date = ?, offer_signed_date = ?
          WHERE id = ?`,
      ).run(
        row.name,
        row.role ?? current.role,
        teamId(db, row.team),
        managerId(db, row.manager_email),
        row.kind,
        row.work_country,
        row.work_state,
        row.start_date,
        row.contract_end_date,
        row.end_date,
        row.offer_signed_date,
        current.id,
      );
      if (addedIds.has(current.id)) continue;
      updated++;
      writeAudit(db, actor, { action: "person.update", subject: `person:${current.id}`, detail: changes.join("; "), at });
    }
    const run = Number(
      db
        .prepare("INSERT INTO import_runs (at, file, rows, added, updated, run_by) VALUES (?, ?, ?, ?, ?, ?)")
        .run(at, file, rows.length, added, updated, personId(actor)).lastInsertRowid,
    );
    writeAudit(db, actor, {
      action: "import",
      subject: `import:${run}`,
      detail: `${file}: ${rows.length} rows, ${added} added, ${updated} updated`,
      at,
    });
    return { run, rows: rows.length, added, updated, tokens };
  });
}

const LISTED = `${PERSON_SELECT} ORDER BY t.name, p.name`;

export type Status = ReturnType<typeof statusOn>;
export type StaffEntry = Partial<PersonRow> & Pick<PersonRow, "id" | "name" | "team" | "manager"> & { status: Status };

/**
 * The staff list, with each person's status worked out from their dates. Personal
 * fields are shown to roles that may read them, and to managers for their own reports.
 */
export function staffList(db: DB, actor: Actor, today: string): StaffEntry[] {
  const people = db.prepare(LISTED).all() as PersonRow[];
  return people.map((p): StaffEntry => {
    const status = statusOn(p, today);
    const full = can(actor, "read personal fields") || (actor.role === "manager" && p.manager_id === actor.id);
    if (full) return { ...p, status };
    return { id: p.id, name: p.name, team: p.team, manager: p.manager, status };
  });
}
