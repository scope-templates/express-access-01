# Access desk

Veldra Routing sells route-planning software to regional freight carriers. We are about forty-five people, with staff in
eight states and five contractors in Portugal and Mexico. Access desk is the small internal service we use to give
people their work tools when they join, change teams or leave: GitHub, AWS, Slack, and mail and calendar. It keeps
everyone we employ or contract with, what each of them holds on each tool and at what level, who asked for it, who
approved it and who applied it, and an append-only log of every decision. Our operations lead runs it day to day,
managers use it to ask for access for the people who report to them, and our CTO and infrastructure engineer approve
AWS and admin-level access.

## What is in it

An Express and TypeScript service with a JSON API under `/api` and a server-rendered admin page at `/admin`. The
store is SQLite through better-sqlite3, in `var/access-desk.db`. Days are UTC dates: "today" is the UTC date of the
moment a call is made.

### Tables

| Table | Holds |
| --- | --- |
| `people` | Name, work email, team, manager, role, employee or contractor, work state (US) or country, start date, contract end date (contractors, once it is known), end date, offer-signed date, and the person's secret access desk token. People are entered from the signed offer on the admin page or loaded by the monthly import of the operations spreadsheet's CSV export. A person's status is worked out from these dates whenever it is read: joining before the start date, left after the end date or from the contract end date, active otherwise. |
| `teams` | Team names. |
| `systems` | GitHub, AWS, Slack, and mail and calendar, with the levels each one has. |
| `grants` | Person, system, level, granted by, approved by, granted at, revoked at, revoked by (a person, or the `nightly-report` system actor). The store holds one live grant per person per system, refuses an AWS or admin-level grant with no approver, refuses a grant whose approver is its holder or its granter (on insert and on update), keeps a grant on its person and system, refuses AWS for a person whose work country is not the US, and refuses an update or replacement of a person that puts an AWS holder's work country abroad. |
| `access_requests` | Requester, person, system, level, reason, status (open, approved, denied, granted), who decided and when. The store refuses a decision by the requester or by the person the request is for. |
| `audit_log` | Actor, action, subject, detail, time. Append-only on any connection: triggers refuse an update, a delete, an entry with an explicit id other than the next one (so `INSERT OR REPLACE` fails), an entry timed before the last one, and an entry whose actor is not a person or system actor on file; checks require exactly one actor, a positive id, and a time written as text in the form `YYYY-MM-DDTHH:MM:SS…Z`. Ids are `AUTOINCREMENT`. |
| `system_actors` | Named actors that are not people: `nightly-report`, role viewer. |
| `system_log` | One line per grant or revoke from each system's adapter: system, operation, account, detail. |
| `import_runs` | Each monthly import: file, rows, added, updated, who ran it. |

Each system has an adapter in `src/adapters/` (`github.ts`, `aws.ts`, `slack.ts`, `mail.ts`) that writes every grant
and revoke for that system, with the account and level, to `system_log`. Every connection the service opens turns on
`foreign_keys` and `recursive_triggers`.

### Signing in

Each person has a secret token of 32 hex characters, issued when they are added (shown once on the admin page, or
printed by the import for the people it adds). API calls send it as `Authorization: Bearer <token>`; the admin page
asks for it and keeps it in a cookie. A call is refused with 401 and a reason code: `token_missing` when there is no
bearer token, `token_unknown` when no person holds it, and `access_ended` when the person's end date has passed or
their contract end date has come, checked against today on every call. An `access_ended` attempt is written to the
audit log. System actors hold no token and never act over HTTP.

### Operations

A refused operation answers 403 (409 for a state conflict, 400 for an unknown system, level or manager, or a bad
import file) and writes a `refuse` entry to the audit log with the reason. When the clock reads earlier than the last
audit entry, any call that would write to the log answers 409 `clock-behind` and writes nothing. A body that fails validation answers 400,
and an id that matches nothing answers 404; neither is a decision, and neither is logged.

| Operation | API | Refuses when |
| --- | --- | --- |
| Request access | `POST /api/requests` | the role is viewer; a manager asks for someone who is not their report; the system or level does not exist; the person has left or their contract has ended; AWS for someone working abroad |
| Approve or deny a request | `POST /api/requests/:id/approve`, `/deny` | the role is not it or admin; the decider made the request; the request is for the decider's own access; the request is already decided |
| Apply a grant | `POST /api/grants` with `request_id`, or `person_id`, `system`, `level` | the role is not it or admin; the actor is a system actor; the grant is for the person applying it, at any level; AWS or any admin level without an approved request; the person applying it approved the request; the request was denied or already granted; the person already holds that system; the system or level does not exist; the person has left or their contract has ended; AWS for someone working abroad. A grant from a `request_id` takes the person, system and level from the request |
| Revoke a grant | `POST /api/grants/:id/revoke` | the role is not it or admin; the grant was already revoked; the person's last day or contract end date has come (their access goes through the leaver run) |
| Leaver run | `POST /api/people/:id/leaver-run` with `steps` | the role is not it or admin; any of the four steps is missing or they are out of order (GitHub, AWS, Slack, mail); the person's last day or contract end date has not come |
| End contracts | `POST /api/contracts/end` | the actor is not it, admin or `nightly-report`. Revokes every grant held by a contractor whose contract end date is on file and is today or earlier |
| Change a role | `POST /api/people/:id/role` with `role`, or the admin page | the role is not admin; the role does not exist |
| Staff list | `GET /api/people` | never; fields depend on the role |
| Live grants | `GET /api/grants` | the role is viewer |
| Requests | `GET /api/requests?status=` | the role is viewer |
| Stale access | `GET /api/reports/stale-access?as_of=` | the role is manager or viewer |
| Audit log | `GET /api/audit?limit=` (newest first; `limit` 1 to 1000, default 100) | the role is not it or admin |
| Add a person from the signed offer | admin page | the role is not admin or people-ops; the work email is already on file; the manager's work email is not on file; a field is malformed, a state is given for someone outside the US or missing for someone in it, or a contract end date is given for an employee |
| Record an end date | admin page | the role is not admin or people-ops |
| Monthly import | `npm run import -- <file> --as <email>` | the role is not admin or people-ops; any row is malformed or a work email appears twice; a manager's work email is neither on file nor in the file; a row would put someone who holds AWS abroad; the optional `role` column changes a role and the person running the import is not admin. A refused file writes nothing |

An end date is the last day worked; access is stale from the day after. A contract end date ends access on the day
itself.

### The nightly run

`npm run stale-access` is the nightly run, signed by the `nightly-report` system actor. It writes one audit entry with
the stale-access counts, prints the people whose end date has passed and who still hold any grant and the people whose
start date has passed with no grant, then ends access for every contractor whose contract end date is on file and has
come, and prints whom it ended. Ending those contracts is the only change `nightly-report` may make. `--json` prints
the same as JSON.

## Roles

| Role | May see | May do |
| --- | --- | --- |
| admin | Everything, including the audit log | Request for anyone, approve and deny, grant and revoke, leaver runs, end contracts, add people, record end dates, run the import, change roles |
| it | Everything, including the audit log | Request for anyone, approve and deny, grant and revoke, leaver runs, end contracts |
| people-ops | Staff list with personal fields, requests, live grants, stale access | Request for anyone, add people, record end dates, run the import |
| manager | Staff list; personal fields and live grants of their own reports; requests they made | Request access for their own reports |
| viewer | Staff list: name, team, manager, status | Nothing |

A manager sees the personal fields of the people who report to them; a person listed as someone's manager without
the manager role does not. People added from the signed offer start as viewers; the import adds people with the role
in its `role` column, or viewer when it is blank. `nightly-report` is a system actor with the viewer role.

## Running locally

Node 22 or later.

```sh
npm install
npm run build
npm test
npm run import -- data/imports/people-2026-10.csv --as marisol.ibarra@veldraroute.com
npm run stale-access
npm start
```

`npm start` serves the admin page at http://localhost:3040/admin (set `PORT` to change it). The first open of an empty
store loads `data/seed.json`; delete `var/` to start again from the seed. Set `ACCESS_DESK_DB` to use another file.

Example API call, as Priya Raman (it) with her seeded token:

```sh
curl -H "Authorization: Bearer 9746cc1a13dc45164ebc060d72a5720e" http://localhost:3040/api/reports/stale-access
```

## Tests

`npm test` compiles the service and runs the suite with `node:test`, mostly against a small company built in an
in-memory store.

## The data

`data/seed.json` is the store as it stood at the end of September 2026: 52 people (45 at work by the dates on file,
one starting in October, six who left during the year), eight teams, twelve monthly imports from October 2025 to
September 2026, 359 nightly runs from October 7, 156 grants, 37 access requests and 682 audit entries. It is built by
`scripts/seed-builder.ts`, which sets up the operations lead's own record and the `nightly-report` actor, then replays
the year through the service's own operations at their recorded times, starting with the first import and its roles,
with a fixed random seed, so `npm run seed:generate` writes the same bytes every time; a test checks that it does.
`data/imports/people-2026-10.csv` is the October export of the operations spreadsheet, the file used in the import
command above.
