import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEMS } from "./systems.js";

export type DB = Database.Database;

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const SEED_FILE = `${ROOT}data/seed.json`;
const DEFAULT_DB_FILE = `${ROOT}var/access-desk.db`;

// Insert order for loading the seed; parents before children.
export const SEED_TABLES = [
  "teams",
  "people",
  "system_actors",
  "import_runs",
  "access_requests",
  "grants",
  "system_log",
  "audit_log",
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  work_email TEXT NOT NULL UNIQUE,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  manager_id INTEGER REFERENCES people(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'people-ops', 'it', 'manager', 'viewer')),
  kind TEXT NOT NULL CHECK (kind IN ('employee', 'contractor')),
  work_country TEXT NOT NULL,
  work_state TEXT,
  start_date TEXT NOT NULL,
  contract_end_date TEXT,
  end_date TEXT,
  offer_signed_date TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE CHECK (length(token) = 32),
  CHECK ((work_country = 'US') = (work_state IS NOT NULL)),
  CHECK (kind = 'contractor' OR contract_end_date IS NULL)
);

CREATE TABLE IF NOT EXISTS systems (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  levels TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_actors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'people-ops', 'it', 'manager', 'viewer'))
);

CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  file TEXT NOT NULL,
  rows INTEGER NOT NULL,
  added INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  run_by INTEGER NOT NULL REFERENCES people(id)
);

CREATE TABLE IF NOT EXISTS access_requests (
  id INTEGER PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES people(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  system TEXT NOT NULL REFERENCES systems(key),
  level TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'denied', 'granted')),
  created_at TEXT NOT NULL,
  decided_by INTEGER REFERENCES people(id),
  decided_at TEXT,
  CHECK (decided_by IS NULL OR (decided_by <> requester_id AND decided_by <> person_id))
);

CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  system TEXT NOT NULL REFERENCES systems(key),
  level TEXT NOT NULL,
  request_id INTEGER REFERENCES access_requests(id),
  granted_by INTEGER NOT NULL REFERENCES people(id),
  approved_by INTEGER REFERENCES people(id),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by INTEGER REFERENCES people(id),
  revoked_by_system INTEGER REFERENCES system_actors(id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL AND revoked_by_system IS NULL)),
  CHECK (revoked_by IS NULL OR revoked_by_system IS NULL),
  CHECK ((system <> 'aws' AND level <> 'admin') OR approved_by IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS grants_one_live_per_system
  ON grants (person_id, system) WHERE revoked_at IS NULL;

CREATE TRIGGER IF NOT EXISTS grants_second_person BEFORE INSERT ON grants
WHEN NEW.approved_by IS NOT NULL AND (NEW.approved_by = NEW.person_id OR NEW.approved_by = NEW.granted_by)
BEGIN SELECT RAISE(ABORT, 'a grant is approved by someone other than its holder and its granter'); END;

CREATE TRIGGER IF NOT EXISTS grants_second_person_kept BEFORE UPDATE OF approved_by, person_id, granted_by ON grants
WHEN NEW.approved_by IS NOT NULL AND (NEW.approved_by = NEW.person_id OR NEW.approved_by = NEW.granted_by)
BEGIN SELECT RAISE(ABORT, 'a grant is approved by someone other than its holder and its granter'); END;

CREATE TRIGGER IF NOT EXISTS grants_stay_put BEFORE UPDATE OF person_id, system ON grants
WHEN NEW.person_id <> OLD.person_id OR NEW.system <> OLD.system
BEGIN SELECT RAISE(ABORT, 'a grant stays with its person and system'); END;

CREATE TRIGGER IF NOT EXISTS grants_no_aws_abroad BEFORE INSERT ON grants
WHEN NEW.system = 'aws' AND (SELECT work_country FROM people WHERE id = NEW.person_id) <> 'US'
BEGIN SELECT RAISE(ABORT, 'people working abroad never hold AWS'); END;

CREATE TRIGGER IF NOT EXISTS people_no_aws_abroad BEFORE UPDATE OF work_country ON people
WHEN NEW.work_country <> 'US'
 AND EXISTS (SELECT 1 FROM grants WHERE person_id = NEW.id AND system = 'aws' AND revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'people working abroad never hold AWS'); END;

CREATE TRIGGER IF NOT EXISTS people_no_aws_abroad_replaced BEFORE INSERT ON people
WHEN NEW.work_country <> 'US'
 AND EXISTS (SELECT 1 FROM grants WHERE person_id = NEW.id AND system = 'aws' AND revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'people working abroad never hold AWS'); END;

CREATE TABLE IF NOT EXISTS system_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  system TEXT NOT NULL REFERENCES systems(key),
  op TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0),
  at TEXT NOT NULL CHECK (
    typeof(at) = 'text' AND at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
  ),
  actor_person_id INTEGER REFERENCES people(id),
  actor_system_id INTEGER REFERENCES system_actors(id),
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT NOT NULL,
  CHECK ((actor_person_id IS NULL) <> (actor_system_id IS NULL))
);

-- These triggers hold on any connection, whatever its pragmas: an entry names an
-- actor on file, takes the next id and a time no earlier than the last entry, and
-- is never replaced, updated or deleted.
CREATE TRIGGER IF NOT EXISTS audit_log_actor_on_file BEFORE INSERT ON audit_log
WHEN NOT EXISTS (SELECT 1 FROM people WHERE id = NEW.actor_person_id)
 AND NOT EXISTS (SELECT 1 FROM system_actors WHERE id = NEW.actor_system_id)
BEGIN SELECT RAISE(ABORT, 'audit_log entry names no actor on file'); END;

-- NEW.id is -1 in a BEFORE trigger when SQLite assigns the id itself.
CREATE TRIGGER IF NOT EXISTS audit_log_in_order BEFORE INSERT ON audit_log
WHEN (NEW.id <> -1 AND NEW.id <> COALESCE((SELECT MAX(id) FROM audit_log), 0) + 1)
  OR NEW.at < (SELECT at FROM audit_log ORDER BY id DESC LIMIT 1)
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`;

export type Seed = Record<(typeof SEED_TABLES)[number], Record<string, unknown>[]>;

export function readSeed(): Seed {
  return JSON.parse(readFileSync(SEED_FILE, "utf8")) as Seed;
}

/** Opens the store; an empty store is loaded from the seed unless `seed` is false. */
export function openDb(file: string = process.env.ACCESS_DESK_DB ?? DEFAULT_DB_FILE, { seed = true } = {}): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("recursive_triggers = ON");
  db.exec(SCHEMA);
  const addSystem = db.prepare("INSERT OR IGNORE INTO systems (key, name, levels) VALUES (?, ?, ?)");
  for (const [key, system] of Object.entries(SYSTEMS)) addSystem.run(key, system.name, system.levels.join(","));
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number };
  if (seed && n === 0) loadSeed(db, readSeed());
  return db;
}

function loadSeed(db: DB, seed: Seed): void {
  db.transaction(() => {
    db.pragma("defer_foreign_keys = ON");
    for (const table of SEED_TABLES) {
      const rows = seed[table];
      if (rows.length === 0) continue;
      const columns = Object.keys(rows[0]);
      const insert = db.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
      );
      for (const row of rows) insert.run(row);
    }
  })();
}

export function dumpTables(db: DB): Seed {
  const out = {} as Seed;
  for (const table of SEED_TABLES) {
    out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
  }
  return out;
}
