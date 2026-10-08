import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { SIGN_IN_REFUSED, actorForEmail } from "../src/actors.js";
import { Refusal } from "../src/audit.js";
import { parseCsv } from "../src/csv.js";
import { openDb } from "../src/db.js";
import { importPeople } from "../src/people.js";
import { stamp } from "../src/policy.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { as: { type: "string" } } });
const [file] = positionals;
if (!file || !values.as) {
  console.error("usage: npm run import -- <people.csv> --as <your work email>");
  process.exit(2);
}

const db = openDb();
const at = stamp(new Date());
const signIn = actorForEmail(db, values.as, at);
if (!signIn.ok) {
  console.error(`${values.as}: ${signIn.reason === "token_unknown" ? "no person with this work email" : SIGN_IN_REFUSED[signIn.reason]}`);
  process.exit(2);
}
try {
  const result = importPeople(db, signIn.actor, basename(file), parseCsv(readFileSync(file, "utf8")), at);
  console.log(`${basename(file)}: ${result.rows} rows, ${result.added} added, ${result.updated} updated (import run ${result.run})`);
  for (const { person, token } of result.tokens) console.log(`  token for ${person.name} (${person.work_email}): ${token}`);
} catch (err) {
  if (!(err instanceof Refusal)) throw err;
  console.error(`refused (${err.code}): ${err.message}`);
  process.exitCode = 1;
}
