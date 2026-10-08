import { z } from "zod";
import { Refusal } from "./audit.js";
import type { PersonRow } from "./people.js";
import { LEAVER_ORDER, SYSTEMS, type SystemKey } from "./systems.js";

export const Id = z.coerce.number().int().positive();
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

type EndDates = Pick<PersonRow, "end_date" | "contract_end_date">;

/** An audit timestamp: UTC to the second. */
export function stamp(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

export function dateOf(at: string): string {
  return at.slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The date a person's access should have ended, once it has been reached.
 * An end date counts from the day after (the last day is worked); a contract
 * end date counts on the day itself, with no grace.
 */
export function endedOn(p: EndDates, today: string): string | null {
  const reached: string[] = [];
  if (p.end_date && p.end_date < today) reached.push(p.end_date);
  if (p.contract_end_date && p.contract_end_date <= today) reached.push(p.contract_end_date);
  return reached.sort()[0] ?? null;
}

/** From their last day (or contract end date) on, a person's access goes through the leaver run. */
export function lastDayReached(p: EndDates, today: string): boolean {
  return (p.end_date !== null && p.end_date <= today) || (p.contract_end_date !== null && p.contract_end_date <= today);
}

export function statusOn(p: EndDates & Pick<PersonRow, "start_date">, today: string): "joining" | "active" | "left" {
  if (endedOn(p, today)) return "left";
  return p.start_date > today ? "joining" : "active";
}

export function isAbroad(p: Pick<PersonRow, "work_country">): boolean {
  return p.work_country !== "US";
}

/** Refuses access that this person may not hold on this system today. */
export function checkEligible(p: PersonRow, system: SystemKey, level: string, today: string): void {
  if (!(SYSTEMS[system].levels as readonly string[]).includes(level)) {
    throw new Refusal("level", `${SYSTEMS[system].name} has no level "${level}"`, 400);
  }
  if (p.contract_end_date && p.contract_end_date <= today) {
    throw new Refusal("contract-ended", `${p.name}'s contract ended on ${p.contract_end_date}`);
  }
  if (endedOn(p, today)) {
    throw new Refusal("left", `${p.name} left on ${p.end_date}`);
  }
  if (system === "aws" && isAbroad(p)) {
    throw new Refusal("abroad-aws", `${p.name} works in ${p.work_country}; people working abroad never hold AWS`);
  }
}

/** A leaver run names every step, in the fixed order. */
export function checkLeaverSteps(steps: readonly string[]): void {
  const skipped = LEAVER_ORDER.filter((step) => !steps.includes(step));
  if (skipped.length > 0) {
    throw new Refusal("step-skipped", `leaver run skipped ${skipped.join(", ")}; every step runs`);
  }
  if (steps.length !== LEAVER_ORDER.length || steps.some((step, i) => step !== LEAVER_ORDER[i])) {
    throw new Refusal("step-order", `leaver steps run in this order: ${LEAVER_ORDER.join(", ")}`);
  }
}
