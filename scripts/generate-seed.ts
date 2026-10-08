import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSeed } from "./seed-builder.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { seed, octoberCsv } = buildSeed();
writeFileSync(`${root}data/seed.json`, seed);
writeFileSync(`${root}data/imports/people-2026-10.csv`, octoberCsv);
console.log("wrote data/seed.json and data/imports/people-2026-10.csv");
