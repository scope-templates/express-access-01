// Builds the committed seed by replaying a year of the access desk's own
// operations against an empty store: monthly imports, offers typed in, requests,
// approvals, grants, leaver runs and the nightly run, each at its recorded time.
import { applyGrant, approveRequest, denyRequest, requestAccess, revokeGrant, runLeaver } from "../src/access.js";
import { type Actor, type Role, actorForEmail } from "../src/actors.js";
import { Refusal } from "../src/audit.js";
import { formatCsv } from "../src/csv.js";
import { type DB, SEED_TABLES, dumpTables, openDb } from "../src/db.js";
import { addPerson, importPeople, newToken, recordEndDate } from "../src/people.js";
import { nightlyRun } from "../src/reports.js";
import { LEAVER_ORDER, type SystemKey, needsSecondApproval } from "../src/systems.js";

const DOMAIN = "veldraroute.com";
const FIRST_LOAD = "2025-10-01";
const FIRST_NIGHT = "2025-10-07";
const LAST_NIGHT = "2026-09-30";
const IMPORT_DAYS = [
  "2025-11-03", "2025-12-01", "2026-01-05", "2026-02-02", "2026-03-02", "2026-04-01",
  "2026-05-04", "2026-06-01", "2026-07-01", "2026-08-03", "2026-09-01",
];
const OCTOBER_EXPORT = "2026-10-01";
const WEEKEND_WORK = new Set(["2026-08-22"]);

const OPS_LEAD = "Marisol Ibarra";
const PEOPLE_OPS = "Keith Lindqvist";
const CTO = "Ravi Subramaniam";
const INFRA = "Priya Raman";
const APPROVERS = [CTO, INFRA, OPS_LEAD];
const ENGINEERING = new Set(["Platform", "Dispatch", "Mobile", "Data"]);

type Spec = {
  name: string;
  team: string;
  manager?: string;
  role?: Role;
  /** `known` is the day the contract end date reaches the spreadsheet; it is on file from the start when absent. */
  contractor?: { ends: string; known?: string };
  loc: string;
  start: string;
  offer?: string;
  added?: { via: "form"; on: string } | { via: "import" };
  grantsOn?: string;
  end?: { on: string; known: string; via: "form" | "import"; runOn?: string; runBy?: string };
  movedFrom?: { team: string; manager: string; until: string };
};

const P = (name: string, team: string, manager: string | undefined, loc: string, start: string, more: Partial<Spec> = {}): Spec => ({
  name, team, manager, loc, start, ...more,
});

const SPECS: Spec[] = [
  P("Dana Whitcombe", "Leadership", undefined, "CO", "2019-03-04", { role: "manager" }),
  P(CTO, "Leadership", "Dana Whitcombe", "CO", "2019-03-04", { role: "admin" }),
  P(OPS_LEAD, "Operations", "Dana Whitcombe", "CO", "2020-08-17", { role: "admin" }),
  P(PEOPLE_OPS, "Operations", OPS_LEAD, "CO", "2021-11-01", { role: "people-ops" }),
  P("Tamsin Okoro", "Operations", OPS_LEAD, "TX", "2024-06-10"),
  P("Jonah Feld", "Platform", CTO, "CO", "2019-09-09", { role: "manager" }),
  P(INFRA, "Platform", "Jonah Feld", "CO", "2020-02-03", { role: "it" }),
  P("Caleb Ostrowski", "Platform", "Jonah Feld", "WA", "2022-05-16"),
  P("Desmond Achebe", "Platform", "Jonah Feld", "IL", "2023-09-05"),
  P("Hana Kobayashi", "Platform", "Jonah Feld", "CO", "2025-11-10", {
    offer: "2025-10-20", added: { via: "form", on: "2025-10-21" }, grantsOn: "2025-11-07",
  }),
  P("Lucia Ferraro", "Platform", "Jonah Feld", "NC", "2026-03-16", {
    offer: "2026-03-04", contractor: { ends: "2026-09-18", known: OCTOBER_EXPORT },
    added: { via: "form", on: "2026-03-18" }, grantsOn: "2026-03-18",
  }),
  P("Felix Navarro", "Platform", "Jonah Feld", "CO", "2021-03-15", {
    movedFrom: { team: "Dispatch", manager: "Nadia Castellanos", until: "2026-06-01" },
  }),
  P("Nadia Castellanos", "Dispatch", CTO, "CO", "2020-01-13", { role: "manager" }),
  P("Brendan Kowalczyk", "Dispatch", "Nadia Castellanos", "TX", "2021-07-12"),
  P("Imani Brooks", "Dispatch", "Nadia Castellanos", "GA", "2022-10-03"),
  P("Sofia Lindgren", "Dispatch", "Nadia Castellanos", "IL", "2023-02-06"),
  P("Trevor Haldane", "Dispatch", "Nadia Castellanos", "MN", "2024-03-18"),
  P("Yusuf Demir", "Dispatch", "Nadia Castellanos", "CO", "2026-02-09", {
    offer: "2026-01-22", added: { via: "form", on: "2026-02-12" }, grantsOn: "2026-02-13",
  }),
  P("Inês Carvalho", "Dispatch", "Nadia Castellanos", "PT", "2024-09-02", { contractor: { ends: "2026-12-31" } }),
  P("Rui Mendonça", "Dispatch", "Nadia Castellanos", "PT", "2025-04-07", { contractor: { ends: "2027-03-31" } }),
  P("Fatima Rahimi", "Dispatch", "Nadia Castellanos", "IL", "2021-06-07", {
    end: { on: "2026-03-27", known: "2026-03-30", via: "form", runOn: "2026-03-30", runBy: INFRA },
  }),
  P("Grace Albright", "Mobile", CTO, "NY", "2021-01-11", { role: "manager" }),
  P("Theo Vasquez", "Mobile", "Grace Albright", "CO", "2022-03-07"),
  P("Min-jun Park", "Mobile", "Grace Albright", "WA", "2023-06-12"),
  P("Aaron Sheffield", "Mobile", "Grace Albright", "NC", "2024-11-04"),
  P("Valeria Quintero", "Mobile", "Grace Albright", "MX", "2026-04-06", {
    offer: "2026-03-20", contractor: { ends: "2027-04-05" }, added: { via: "import" }, grantsOn: "2026-04-03",
  }),
  P("Diego Arredondo", "Mobile", "Grace Albright", "MX", "2025-02-03", { contractor: { ends: "2026-12-18" } }),
  P("Andrea Molina", "Mobile", "Grace Albright", "NY", "2022-02-14", {
    end: { on: "2026-07-09", known: "2026-07-16", via: "form", runOn: "2026-07-17" },
  }),
  P("Elena Varga", "Data", CTO, "IL", "2021-05-03", { role: "manager" }),
  P("Marcus Oyelaran", "Data", "Elena Varga", "CO", "2022-08-01"),
  P("Ingrid Solberg", "Data", "Elena Varga", "MN", "2023-10-16"),
  P("Odile Marchetti", "Data", "Elena Varga", "WA", "2025-11-17", {
    offer: "2025-10-27", contractor: { ends: "2026-05-29" }, added: { via: "form", on: "2025-10-28" }, grantsOn: "2025-11-14",
  }),
  P("Samir Haddad", "Data", "Elena Varga", "TX", "2026-05-04", {
    offer: "2026-04-09", added: { via: "form", on: "2026-05-06" }, grantsOn: "2026-05-07",
  }),
  P("Tiago Fonseca", "Data", "Elena Varga", "PT", "2025-06-02", { contractor: { ends: "2026-11-30" } }),
  P("Naomi Ferreira", "Data", "Elena Varga", "CO", "2026-10-13", {
    offer: "2026-09-24", added: { via: "form", on: "2026-09-24" },
  }),
  P("Jasper Thorne", "Data", "Elena Varga", "CO", "2023-04-03", {
    end: { on: "2025-12-12", known: "2025-11-24", via: "form", runOn: "2025-12-12" },
  }),
  P("Rebecca Tran", "Customer Success", "Dana Whitcombe", "CO", "2020-06-01", { role: "manager" }),
  P("Luis Ortega", "Customer Success", "Rebecca Tran", "TX", "2021-09-20"),
  P("Courtney Bell", "Customer Success", "Rebecca Tran", "GA", "2022-01-18"),
  P("Jamal Whitfield", "Customer Success", "Rebecca Tran", "GA", "2023-03-13"),
  P("Erin Gallagher", "Customer Success", "Rebecca Tran", "NY", "2023-08-21"),
  P("Mei-Ling Chou", "Customer Success", "Rebecca Tran", "WA", "2024-04-15"),
  P("Patrick Doyle", "Customer Success", "Rebecca Tran", "CO", "2026-09-28", {
    offer: "2026-09-08", added: { via: "form", on: "2026-09-30" },
  }),
  P("Colin Byrne", "Customer Success", "Rebecca Tran", "GA", "2024-01-08", {
    end: { on: "2026-05-22", known: "2026-05-27", via: "form", runOn: "2026-05-27" },
  }),
  P("Stephen Aldana", "Sales", "Dana Whitcombe", "TX", "2020-04-06", { role: "manager" }),
  P("Allison Mercer", "Sales", "Stephen Aldana", "NY", "2021-10-04", {
    end: { on: "2026-10-30", known: OCTOBER_EXPORT, via: "import" },
  }),
  P("Kofi Mensah", "Sales", "Stephen Aldana", "IL", "2022-06-06"),
  P("Laura Bianchi", "Sales", "Stephen Aldana", "CO", "2023-01-09"),
  P("Derek Saunders", "Sales", "Stephen Aldana", "NC", "2023-11-06"),
  P("Victor Shapiro", "Sales", "Stephen Aldana", "MN", "2024-08-12"),
  P("Rachel Kim", "Sales", "Stephen Aldana", "WA", "2026-06-01", {
    offer: "2026-05-12", added: { via: "form", on: "2026-05-13" }, grantsOn: "2026-05-29",
  }),
  P("Wesley Corrigan", "Sales", "Stephen Aldana", "TX", "2022-08-15", {
    end: { on: "2026-01-23", known: "2026-02-02", via: "import", runOn: "2026-02-03" },
  }),
  P("Bethany Holcomb", "Sales", "Stephen Aldana", "GA", "2026-10-19", { offer: "2026-09-30", added: { via: "import" } }),
];

const byName = new Map(SPECS.map((s) => [s.name, s]));
const spec = (name: string) => byName.get(name)!;

function email(name: string): string {
  const plain = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/-/g, "");
  return `${plain.split(" ").join(".")}@${DOMAIN}`;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** The day of the month of the nth given weekday (n = -1 for the last). */
function nthWeekday(year: number, month: number, day: number, n: number): string {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  if (n > 0) return addDays(first, ((day - weekday(first) + 7) % 7) + (n - 1) * 7);
  const last = addDays(addDays(first, 32).slice(0, 8) + "01", -1);
  return addDays(last, -((weekday(last) - day + 7) % 7));
}

function isHoliday(date: string): boolean {
  const year = Number(date.slice(0, 4));
  const fixed = ["01-01", "06-19", "07-04", "11-11", "12-25"].map((md) => `${year}-${md}`);
  const floating = [
    nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3), nthWeekday(year, 5, 1, -1),
    nthWeekday(year, 9, 1, 1), nthWeekday(year, 10, 1, 2), nthWeekday(year, 11, 4, 4),
  ];
  return fixed.includes(date) || floating.includes(date);
}

const isBusinessDay = (date: string) => weekday(date) !== 0 && weekday(date) !== 6 && !isHoliday(date);

function businessDayOnOrBefore(date: string): string {
  let d = date;
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

const COUNTRIES_ABROAD = new Set(["PT", "MX"]);
const offerOf = (s: Spec) => s.offer ?? businessDayOnOrBefore(addDays(s.start, -24));
const abroad = (s: Spec) => COUNTRIES_ABROAD.has(s.loc);

/** The operations spreadsheet as exported on a given day. */
function roster(day: string): Record<string, string | null>[] {
  return SPECS.filter((s) => offerOf(s) <= day && !(s.added?.via === "form" && s.added.on > day)).map((s) => {
    const moved = s.movedFrom && day < s.movedFrom.until ? s.movedFrom : undefined;
    const manager = moved ? moved.manager : s.manager;
    const contractEnd = s.contractor && (s.contractor.known ?? "") <= day ? s.contractor.ends : null;
    return {
      name: s.name,
      work_email: email(s.name),
      team: moved ? moved.team : s.team,
      manager_email: manager ? email(manager) : null,
      kind: s.contractor ? "contractor" : "employee",
      work_country: abroad(s) ? s.loc : "US",
      work_state: abroad(s) ? null : s.loc,
      start_date: s.start,
      contract_end_date: contractEnd,
      end_date: s.end && s.end.known <= day ? s.end.on : null,
      offer_signed_date: offerOf(s),
      role: s.role ?? "viewer",
    };
  });
}

const CSV_COLUMNS = [
  "name", "work_email", "team", "manager_email", "kind", "work_country", "work_state",
  "start_date", "contract_end_date", "end_date", "offer_signed_date", "role",
] as const;

function plannedGrants(s: Spec, team: string): [SystemKey, string][] {
  const out: [SystemKey, string][] = [];
  if (!abroad(s)) out.push(["mail", s.name === OPS_LEAD ? "admin" : "user"]);
  out.push(["slack", s.name === OPS_LEAD ? "admin" : s.contractor ? "guest" : "member"]);
  if (s.name === CTO || s.name === OPS_LEAD) out.push(["github", "admin"]);
  else if (ENGINEERING.has(team)) out.push(["github", "write"]);
  if (!abroad(s)) {
    if (s.name === CTO || s.name === INFRA) out.push(["aws", "admin"]);
    else if (team === "Platform") out.push(["aws", "deploy"]);
    else if (ENGINEERING.has(team)) out.push(["aws", "read"]);
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_LOAD_REASONS = [
  "Held before the access desk started; recorded at first load.",
  "Existing access, carried over from the onboarding checklist.",
  "On the access tab of the old spreadsheet. Recording it here.",
  "Has had this since joining.",
  "Carried over at first load; same group as the rest of the team.",
  "Existing access, checked against the console before recording.",
  "Recorded at first load.",
];

const REASONS: Record<string, string[]> = {
  "aws:read": [
    "Reads CloudWatch logs for the tender ingest workers when a carrier says a load never showed up.",
    "Same read-only group as the rest of the team.",
    "Needs the S3 exports for the lane-volume model.",
    "On the support rotation for dispatch next quarter; read access to logs and the queue dashboards.",
  ],
  "aws:deploy": [
    "Deploys the routing service and the carrier API.",
    "Joins the platform on-call rotation.",
    "Same deployers group as the rest of Platform.",
  ],
  "aws:admin": ["Account owner for the production and staging accounts."],
  "github:admin": ["Org owner: billing, seats and repository settings."],
  "slack:admin": ["Workspace owner for billing and deactivations."],
  "mail:admin": ["Mail admin for mailbox suspensions and shared calendars."],
};

type Step = { day: string; night: boolean; run: (at: string) => void };

export function buildSeed(): { seed: string; octoberCsv: string } {
  for (const s of SPECS) {
    if (!isBusinessDay(offerOf(s))) throw new Error(`${s.name}'s offer is signed on ${offerOf(s)}, not a business day`);
  }
  const db: DB = openDb(":memory:", { seed: false });
  const rand = mulberry32(20250930);
  const steps: Step[] = [];
  const on = (day: string, run: (at: string) => void) => {
    if (!isBusinessDay(day) && !WEEKEND_WORK.has(day)) throw new Error(`${day} is not a business day`);
    steps.push({ day, night: false, run });
  };
  const actor = (name: string, at: string): Actor => {
    const signIn = actorForEmail(db, email(name), at);
    if (!signIn.ok) throw new Error(`${name} cannot act on ${at}: ${signIn.reason}`);
    return signIn.actor;
  };
  const personIdOf = (name: string) =>
    (db.prepare("SELECT id FROM people WHERE work_email = ?").get(email(name)) as { id: number }).id;
  const liveGrantId = (name: string, system: SystemKey) =>
    (db
      .prepare("SELECT id FROM grants WHERE person_id = ? AND system = ? AND revoked_at IS NULL")
      .get(personIdOf(name), system) as { id: number }).id;
  const pick = (list: string[]) => list[Math.floor(rand() * list.length)];
  const refused = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      if (err instanceof Refusal) return;
      throw err;
    }
    throw new Error("expected a refusal");
  };

  /** A grant as the desk records it: through an approved request when the level needs one. */
  const grantFor = (s: Spec, day: string, system: SystemKey, level: string, reason?: string) => {
    const applier = s.name === OPS_LEAD ? INFRA : OPS_LEAD;
    if (!needsSecondApproval(system, level)) {
      on(day, (at) => applyGrant(db, actor(applier, at), { personId: personIdOf(s.name), system, level }, at));
      return;
    }
    const manager = s.movedFrom && day < s.movedFrom.until ? s.movedFrom.manager : s.manager;
    const managerSpec = manager ? spec(manager) : undefined;
    const requester = managerSpec?.role && managerSpec.role !== "viewer" ? managerSpec.name : OPS_LEAD;
    const approver = APPROVERS.find((a) => a !== requester && a !== s.name && a !== applier)!;
    let request = 0;
    const why = reason ?? pick(REASONS[`${system}:${level}`]);
    on(day, (at) => {
      request = requestAccess(db, actor(requester, at), { personId: personIdOf(s.name), system, level, reason: why }, at).id;
    });
    on(day, (at) => approveRequest(db, actor(approver, at), request, at));
    on(day, (at) => applyGrant(db, actor(applier, at), { requestId: request }, at));
  };

  on(FIRST_LOAD, (at) => {
    db.prepare("INSERT INTO system_actors (name, role) VALUES ('nightly-report', 'viewer')").run();
    db.prepare("INSERT INTO teams (name) VALUES ('Operations')").run();
    const ops = spec(OPS_LEAD);
    db.prepare(
      `INSERT INTO people (name, work_email, team_id, role, kind, work_country, work_state, start_date, offer_signed_date, token)
       VALUES (?, ?, 1, 'admin', 'employee', 'US', ?, ?, ?, ?)`,
    ).run(ops.name, email(ops.name), ops.loc, ops.start, offerOf(ops), newToken());
    importPeople(db, actor(OPS_LEAD, at), `people-${FIRST_LOAD.slice(0, 7)}.csv`, roster(FIRST_LOAD) as Record<string, string>[], at);
  });
  const firstLoadDay: Record<string, string> = {
    Leadership: "2025-10-02", Operations: "2025-10-02", Platform: "2025-10-02",
    Dispatch: "2025-10-03", Mobile: "2025-10-03",
    Data: "2025-10-06", "Customer Success": "2025-10-06", Sales: "2025-10-06",
  };
  for (const s of SPECS) {
    if (offerOf(s) > FIRST_LOAD) continue;
    const team = s.movedFrom ? s.movedFrom.team : s.team;
    for (const [system, level] of plannedGrants(s, team)) grantFor(s, firstLoadDay[team], system, level, pick(FIRST_LOAD_REASONS));
  }

  for (const day of IMPORT_DAYS) {
    on(day, (at) => {
      importPeople(db, actor(OPS_LEAD, at), `people-${day.slice(0, 7)}.csv`, roster(day) as Record<string, string>[], at);
    });
  }

  for (const s of SPECS) {
    if (s.added?.via === "form") {
      const added = s.added;
      on(added.on, (at) => {
        const row = roster(added.on).find((r) => r.work_email === email(s.name))!;
        addPerson(db, actor(PEOPLE_OPS, at), row, at);
      });
    }
    const grantsOn = s.grantsOn;
    if (grantsOn) for (const [system, level] of plannedGrants(s, s.team)) grantFor(s, grantsOn, system, level);
    const end = s.end;
    if (end?.via === "form") {
      on(end.known, (at) => recordEndDate(db, actor(PEOPLE_OPS, at), personIdOf(s.name), end.on, at));
    }
    if (end?.runOn) {
      on(end.runOn, (at) => runLeaver(db, actor(end.runBy ?? OPS_LEAD, at), personIdOf(s.name), LEAVER_ORDER, at));
    }
  }

  let felixRequest = 0;
  on("2026-06-02", (at) => {
    felixRequest = requestAccess(db, actor("Jonah Feld", at), {
      personId: personIdOf("Felix Navarro"),
      system: "aws",
      level: "deploy",
      reason: "Moved to Platform with the June 1 reorg. Still on the dispatch read-only group, so he can't ship the geofence service.",
    }, at).id;
  });
  on("2026-06-02", (at) => approveRequest(db, actor(INFRA, at), felixRequest, at));
  on("2026-06-02", (at) => revokeGrant(db, actor(OPS_LEAD, at), liveGrantId("Felix Navarro", "aws"), at));
  on("2026-06-02", (at) => applyGrant(db, actor(OPS_LEAD, at), { requestId: felixRequest }, at));

  let calebRequest = 0;
  on("2026-07-22", (at) => {
    calebRequest = requestAccess(db, actor(INFRA, at), {
      personId: personIdOf("Caleb Ostrowski"),
      system: "github",
      level: "admin",
      reason: "Caleb is covering repo rulesets and deploy-key rotation while I'm out Aug 3-21.",
    }, at).id;
  });
  on("2026-07-22", (at) => refused(() => approveRequest(db, actor(INFRA, at), calebRequest, at)));
  on("2026-07-23", (at) => approveRequest(db, actor(CTO, at), calebRequest, at));
  on("2026-07-23", (at) => revokeGrant(db, actor(OPS_LEAD, at), liveGrantId("Caleb Ostrowski", "github"), at));
  on("2026-07-23", (at) => applyGrant(db, actor(OPS_LEAD, at), { requestId: calebRequest }, at));
  on("2026-08-22", (at) => revokeGrant(db, actor(INFRA, at), liveGrantId("Caleb Ostrowski", "github"), at));
  on("2026-08-22", (at) =>
    applyGrant(db, actor(INFRA, at), { personId: personIdOf("Caleb Ostrowski"), system: "github", level: "write" }, at),
  );

  on("2025-12-03", (at) =>
    refused(() =>
      requestAccess(db, actor("Grace Albright", at), {
        personId: personIdOf("Inês Carvalho"),
        system: "github",
        level: "admin",
        reason: "Needs to manage the mobile release workflow secrets.",
      }, at),
    ),
  );
  let jamalRequest = 0;
  on("2026-02-24", (at) => {
    jamalRequest = requestAccess(db, actor("Rebecca Tran", at), {
      personId: personIdOf("Jamal Whitfield"),
      system: "aws",
      level: "read",
      reason:
        "Jamal is building the carrier onboarding checklist and wants to look at the load-tender logs himself " +
        "instead of asking Data every time a carrier's first loads don't show. Read only is plenty.",
    }, at).id;
  });
  on("2026-02-25", (at) => denyRequest(db, actor(INFRA, at), jamalRequest, at));
  on("2026-04-14", (at) =>
    refused(() =>
      requestAccess(db, actor("Nadia Castellanos", at), {
        personId: personIdOf("Rui Mendonça"),
        system: "aws",
        level: "read",
        reason: "Rui is picking up the ETA alerts and needs to see the queue metrics.",
      }, at),
    ),
  );
  on("2026-08-12", (at) =>
    refused(() =>
      applyGrant(db, actor("Stephen Aldana", at), { personId: personIdOf("Kofi Mensah"), system: "github", level: "read" }, at),
    ),
  );

  const openRequest = (day: string, by: string, who: string, system: SystemKey, level: string, reason: string) =>
    on(day, (at) => requestAccess(db, actor(by, at), { personId: personIdOf(who), system, level, reason }, at));
  openRequest("2026-09-29", "Elena Varga", "Naomi Ferreira", "github", "write", "Starts Oct 13 on the lane-volume model.");
  openRequest(
    "2026-09-29",
    "Elena Varga",
    "Naomi Ferreira",
    "aws",
    "read",
    "Starts Oct 13. She needs the S3 exports and Athena from day one; the model retrain is due before the November carrier reviews.",
  );
  openRequest("2026-09-30", "Rebecca Tran", "Patrick Doyle", "mail", "user", "Started Monday. Sorry, late on this one.");
  openRequest("2026-09-30", "Rebecca Tran", "Patrick Doyle", "slack", "member", "Same channels as Mei-Ling.");

  for (let night = FIRST_NIGHT; night <= LAST_NIGHT; night = addDays(night, 1)) {
    steps.push({ day: night, night: true, run: (at) => nightlyRun(db, at) });
  }

  const dayCounts = new Map<string, number>();
  for (const step of steps) if (!step.night) dayCounts.set(step.day, (dayCounts.get(step.day) ?? 0) + 1);
  // Nights run between 05:40 and 06:40 UTC; a working day opens between 13:00 and 22:00 UTC, earlier on busy days.
  const minutes = new Map<string, number>();
  const opened = new Set<string>();
  const order = (s: Step) => `${s.day}${s.night ? 0 : 1}`;
  for (const step of steps.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0))) {
    const before = minutes.get(step.day) ?? 0;
    let m: number;
    if (step.night) {
      m = 5 * 60 + 40 + Math.floor(rand() * 60);
    } else if (!opened.has(step.day)) {
      opened.add(step.day);
      const window = Math.max(0, 9 * 60 - (dayCounts.get(step.day) ?? 0) * 7);
      m = Math.max(before + 1, 13 * 60 + Math.floor(rand() * window));
    } else {
      m = before + 1 + Math.floor(rand() * 6);
    }
    if (m >= 24 * 60) throw new Error(`too many steps on ${step.day}`);
    minutes.set(step.day, m);
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    const ss = String(Math.floor(rand() * 60)).padStart(2, "0");
    step.run(`${step.day}T${hh}:${mm}:${ss}Z`);
  }

  const tokenRand = mulberry32(20251001);
  const hex8 = () => Math.floor(tokenRand() * 2 ** 32).toString(16).padStart(8, "0");
  const setToken = db.prepare("UPDATE people SET token = ? WHERE id = ?");
  for (const { id } of db.prepare("SELECT id FROM people ORDER BY id").all() as { id: number }[]) {
    setToken.run(hex8() + hex8() + hex8() + hex8(), id);
  }

  const tables = dumpTables(db);
  const seed = `{\n${SEED_TABLES.map((t) => {
    const rows = tables[t].map((r) => `    ${JSON.stringify(r)}`).join(",\n");
    return `  "${t}": [${rows ? `\n${rows}\n  ` : ""}]`;
  }).join(",\n")}\n}\n`;
  return { seed, octoberCsv: formatCsv(CSV_COLUMNS, roster(OCTOBER_EXPORT)) };
}
