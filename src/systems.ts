import * as aws from "./adapters/aws.js";
import * as github from "./adapters/github.js";
import * as mail from "./adapters/mail.js";
import * as slack from "./adapters/slack.js";
import type { DB } from "./db.js";
import type { PersonRow } from "./people.js";

export type Adapter = {
  grant(db: DB, person: PersonRow, level: string, at: string): void;
  revoke(db: DB, person: PersonRow, level: string, at: string): void;
};

export const SYSTEMS = {
  github: { name: "GitHub", levels: ["read", "write", "admin"], adapter: github },
  aws: { name: "AWS", levels: ["read", "deploy", "admin"], adapter: aws },
  slack: { name: "Slack", levels: ["guest", "member", "admin"], adapter: slack },
  mail: { name: "Mail and calendar", levels: ["user", "admin"], adapter: mail },
} as const satisfies Record<string, { name: string; levels: readonly string[]; adapter: Adapter }>;

export type SystemKey = keyof typeof SYSTEMS;

export const LEAVER_ORDER = ["github", "aws", "slack", "mail"] as const satisfies readonly SystemKey[];

export function isSystemKey(key: string): key is SystemKey {
  return Object.hasOwn(SYSTEMS, key);
}

export function needsSecondApproval(system: SystemKey, level: string): boolean {
  return system === "aws" || level === "admin";
}
