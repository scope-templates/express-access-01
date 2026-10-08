import express, { type Request, type Response, type Router } from "express";
import { ZodError } from "zod";
import {
  applyGrant,
  approveRequest,
  denyRequest,
  endContracts,
  listLiveGrants,
  listRequests,
  requestAccess,
  revokeGrant,
  runLeaver,
} from "./access.js";
import { type Actor, ROLES, SIGN_IN_REFUSED, type SignIn, actorForToken, can } from "./actors.js";
import { NotFound, Refusal } from "./audit.js";
import type { DB } from "./db.js";
import { addPerson, recordEndDate, setRole, staffList } from "./people.js";
import { Id, dateOf } from "./policy.js";
import { formatStaleReport, staleAccess } from "./reports.js";
import { LEAVER_ORDER, SYSTEMS } from "./systems.js";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Access desk</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;max-width:1100px}
table{border-collapse:collapse;margin:8px 0 24px}td,th{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left}
form.inline{display:inline}fieldset{margin:0 0 16px;border:1px solid #ccc}label{display:inline-block;margin:2px 8px 2px 0}
.msg{background:#fff6d5;padding:8px;border:1px solid #e5c100}pre{background:#f5f5f5;padding:8px}
</style></head><body>${body}</body></html>`;
}

function signInFrom(db: DB, req: Request, at: string): SignIn {
  const match = /(?:^|;\s*)token=([^;]+)/.exec(req.headers.cookie ?? "");
  return actorForToken(db, match ? decodeURIComponent(match[1]) : undefined, at);
}

const SIGN_IN_FORM = `<h1>Access desk</h1><form method="post" action="/admin/sign-in">
<label>Your access desk token <input name="token" type="password" size="40" autocomplete="off" required></label>
<button>Sign in</button></form>`;

const systemOptions = () =>
  Object.entries(SYSTEMS)
    .map(([key, s]) => s.levels.map((l) => `<option value="${key}:${l}">${esc(s.name)} ${l}</option>`).join(""))
    .join("");

function render(db: DB, actor: Actor, at: string, msg: string): string {
  const people = staffList(db, actor, dateOf(at));
  const personOptions = people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  const parts = [`<h1>Access desk</h1><p>Signed in as ${esc(actor.name)} (${actor.role}).</p>`];
  if (msg) parts.push(`<p class="msg">${esc(msg)}</p>`);

  if (can(actor, "read personal fields")) {
    parts.push(`<h2>Stale access</h2><pre>${esc(formatStaleReport(staleAccess(db, dateOf(at))))}</pre>`);
  }
  if (can(actor, "request access")) {
    const open = listRequests(db, actor, null, at).filter((r) => r.status === "open" || r.status === "approved");
    const mayDecide = can(actor, "approve or deny requests");
    const grant = can(actor, "grant or revoke access");
    parts.push(`<h2>Requests waiting</h2><table><tr><th>#</th><th>For</th><th>Access</th><th>Asked by</th><th>Reason</th><th>Status</th><th></th></tr>
${open
  .map(
    (r) => `<tr><td>${r.id}</td><td>${esc(r.person)}</td><td>${esc(SYSTEMS[r.system].name)} ${esc(r.level)}</td>
<td>${esc(r.requester)}</td><td>${esc(r.reason)}</td><td>${r.status}</td><td>
${mayDecide && r.status === "open" ? `<form class="inline" method="post" action="/admin/requests/${r.id}/approve"><button>Approve</button></form> <form class="inline" method="post" action="/admin/requests/${r.id}/deny"><button>Deny</button></form>` : ""}
${grant ? `<form class="inline" method="post" action="/admin/requests/${r.id}/grant"><button>Apply grant</button></form>` : ""}</td></tr>`,
  )
  .join("\n")}</table>
<form method="post" action="/admin/requests"><fieldset><legend>Request access</legend>
<label>For <select name="person_id">${personOptions}</select></label>
<label>Access <select name="access">${systemOptions()}</select></label>
<label>Reason <input name="reason" size="50" required></label><button>Request</button></fieldset></form>`);
  }

  const columns = Object.keys(people.find((p) => "work_email" in p) ?? people[0] ?? {}).filter(
    (c) => !["team_id", "manager_id"].includes(c),
  );
  parts.push(`<h2>Staff</h2><table><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>
${people.map((p) => `<tr>${columns.map((c) => `<td>${esc((p as Record<string, unknown>)[c])}</td>`).join("")}</tr>`).join("\n")}</table>`);

  if (can(actor, "grant or revoke access")) {
    const grants = listLiveGrants(db, actor, at);
    parts.push(`<h2>Live grants</h2><table><tr><th>Person</th><th>Access</th><th>Granted</th><th></th></tr>
${grants
  .map(
    (g) => `<tr><td>${esc(g.person)}</td><td>${esc(SYSTEMS[g.system].name)} ${esc(g.level)}</td><td>${g.granted_at}</td>
<td><form class="inline" method="post" action="/admin/grants/${g.id}/revoke"><button>Revoke</button></form></td></tr>`,
  )
  .join("\n")}</table>
<form method="post" action="/admin/grants"><fieldset><legend>Grant without a request (levels that need no approval)</legend>
<label>To <select name="person_id">${personOptions}</select></label>
<label>Access <select name="access">${systemOptions()}</select></label><button>Grant</button></fieldset></form>
<form method="post" action="/admin/leaver-run"><fieldset><legend>Leaver run</legend>
<label>Person <select name="person_id">${personOptions}</select></label>
${LEAVER_ORDER.map((s, i) => `<label><input type="checkbox" name="steps" value="${s}" checked> ${i + 1}. ${esc(SYSTEMS[s].name)}</label>`).join("")}
<button>Revoke in order</button></fieldset></form>
<form method="post" action="/admin/contracts/end"><button>End access for contracts that have ended</button></form>`);
  }

  if (can(actor, "change people records")) {
    const field = (name: string, label: string, type = "text") =>
      `<label>${label} <input name="${name}" type="${type}"${["name", "work_email", "team", "work_country", "start_date", "offer_signed_date"].includes(name) ? " required" : ""}></label>`;
    parts.push(`<form method="post" action="/admin/people"><fieldset><legend>Add a person entered from the signed offer</legend>
${field("name", "Name")}${field("work_email", "Work email", "email")}${field("team", "Team")}${field("manager_email", "Manager's work email", "email")}
<label>Kind <select name="kind"><option>employee</option><option>contractor</option></select></label>
${field("work_country", "Country (US, PT, ...)")}${field("work_state", "State (US only)")}
${field("start_date", "Start date", "date")}${field("contract_end_date", "Contract end date", "date")}${field("offer_signed_date", "Offer signed", "date")}
<button>Add</button></fieldset></form>
<form method="post" action="/admin/people/end-date"><fieldset><legend>Record an end date</legend>
<label>Person <select name="person_id">${personOptions}</select></label>${field("end_date", "Last day", "date")}<button>Save</button></fieldset></form>`);
  }
  if (can(actor, "change roles")) {
    parts.push(`<form method="post" action="/admin/people/role"><fieldset><legend>Change a role</legend>
<label>Person <select name="person_id">${personOptions}</select></label>
<label>Role <select name="role">${ROLES.map((r) => `<option>${r}</option>`).join("")}</select></label><button>Save</button></fieldset></form>`);
  }
  return page(parts.join("\n"));
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)]);

function splitAccess(value: unknown): { system: string; level: string } {
  const [system = "", level = ""] = String(value ?? "").split(":");
  return { system, level };
}

export function adminRouter(db: DB, now: () => string): Router {
  const router = express.Router();

  router.get("/", (req, res) => {
    const at = now();
    const signIn = signInFrom(db, req, at);
    if (!signIn.ok) {
      const reason = signIn.reason === "token_missing" ? "" : `<p class="msg">${esc(SIGN_IN_REFUSED[signIn.reason])}</p>`;
      res.status(401).send(page(`${reason}${SIGN_IN_FORM}`));
      return;
    }
    res.send(render(db, signIn.actor, at, ""));
  });

  router.post("/sign-in", (req, res) => {
    res.setHeader("Set-Cookie", `token=${encodeURIComponent(String(req.body.token ?? ""))}; Path=/admin; HttpOnly; SameSite=Strict`);
    res.redirect("/admin");
  });

  const act = (path: string, run: (actor: Actor, req: Request, at: string) => string) => {
    router.post(path, (req: Request, res: Response) => {
      const at = now();
      const signIn = signInFrom(db, req, at);
      if (!signIn.ok) {
        res.redirect("/admin");
        return;
      }
      let msg: string;
      let status = 200;
      try {
        msg = run(signIn.actor, req, at);
      } catch (err) {
        if (err instanceof Refusal) [status, msg] = [err.status, `Refused: ${err.message}`];
        else if (err instanceof NotFound) [status, msg] = [404, `Refused: ${err.message}`];
        else if (err instanceof ZodError) [status, msg] = [400, `Refused: ${err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`];
        else throw err;
      }
      res.status(status).send(render(db, signIn.actor, at, msg));
    });
  };

  act("/people", (actor, req, at) => {
    const added = addPerson(db, actor, req.body, at);
    return `Added ${added.person.name}. Their access desk token, to hand to them: ${added.token}`;
  });
  act("/people/role", (actor, req, at) => {
    const p = setRole(db, actor, Id.parse(req.body.person_id), String(req.body.role ?? ""), at);
    return `${p.name} is now ${p.role}.`;
  });
  act("/people/end-date", (actor, req, at) => {
    const p = recordEndDate(db, actor, Id.parse(req.body.person_id), String(req.body.end_date ?? ""), at);
    return `Recorded ${p.name}'s last day as ${p.end_date}.`;
  });
  act("/requests", (actor, req, at) => {
    const access = splitAccess(req.body.access);
    const r = requestAccess(db, actor, { personId: Id.parse(req.body.person_id), ...access, reason: String(req.body.reason ?? "") }, at);
    return `Request ${r.id} is open.`;
  });
  act("/requests/:id/approve", (actor, req, at) => `Request ${approveRequest(db, actor, Id.parse(req.params.id), at).id} approved.`);
  act("/requests/:id/deny", (actor, req, at) => `Request ${denyRequest(db, actor, Id.parse(req.params.id), at).id} denied.`);
  act("/requests/:id/grant", (actor, req, at) => `Grant ${applyGrant(db, actor, { requestId: Id.parse(req.params.id) }, at).id} applied.`);
  act("/grants", (actor, req, at) => {
    const g = applyGrant(db, actor, { personId: Id.parse(req.body.person_id), ...splitAccess(req.body.access) }, at);
    return `Grant ${g.id} applied.`;
  });
  act("/grants/:id/revoke", (actor, req, at) => `Grant ${revokeGrant(db, actor, Id.parse(req.params.id), at).id} revoked.`);
  act("/leaver-run", (actor, req, at) => {
    const run = runLeaver(db, actor, Id.parse(req.body.person_id), asList(req.body.steps), at);
    return `Leaver run for ${run.person}: ${run.revoked.length} grants revoked.`;
  });
  act("/contracts/end", (actor, _req, at) => {
    const runs = endContracts(db, actor, at);
    return `Ended access for ${runs.length} contractors.`;
  });
  return router;
}
