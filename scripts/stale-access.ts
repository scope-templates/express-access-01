import { parseArgs } from "node:util";
import { openDb } from "../src/db.js";
import { stamp } from "../src/policy.js";
import { formatNightlyRun, nightlyRun } from "../src/reports.js";

const { values } = parseArgs({ options: { json: { type: "boolean" } } });
const run = nightlyRun(openDb(), stamp(new Date()));
process.stdout.write(values.json ? `${JSON.stringify(run, null, 2)}\n` : formatNightlyRun(run));
