import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError, z } from "zod";
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
import { type Actor, SIGN_IN_REFUSED, actorForToken, requireRole } from "./actors.js";
import { adminRouter } from "./admin.js";
import { NotFound, Refusal, decide } from "./audit.js";
import type { DB } from "./db.js";
import { setRole, staffList } from "./people.js";
import { Id, IsoDate, dateOf, stamp } from "./policy.js";
import { listAudit, staleAccess } from "./reports.js";
import { SYSTEMS } from "./systems.js";

export type Clock = () => Date;


const RequestBody = z.object({
  person_id: Id,
  system: z.string(),
  level: z.string(),
  reason: z.string().trim().min(1),
});
const GrantBody = z.union([
  z.object({ request_id: Id }).transform((b) => ({ requestId: b.request_id })),
  z.object({ person_id: Id, system: z.string(), level: z.string() }).transform((b) => ({
    personId: b.person_id,
    system: b.system,
    level: b.level,
  })),
]);
const LeaverBody = z.object({ steps: z.array(z.string()) });

export function createApp(db: DB, clock: Clock = () => new Date()) {
  const now = () => stamp(clock());
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.get("/", (_req, res) => res.redirect("/admin"));
  app.use("/admin", adminRouter(db, now));

  const api = express.Router();
  api.use((req, res, next) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "");
    const signIn = actorForToken(db, bearer?.[1], now());
    if (!signIn.ok) {
      res.status(401).json({ error: signIn.reason, message: SIGN_IN_REFUSED[signIn.reason] });
      return;
    }
    res.locals.actor = signIn.actor;
    next();
  });
  const actorOf = (res: Response) => res.locals.actor as Actor;
  const id = (req: Request) => Id.parse(req.params.id);

  api.get("/systems", (_req, res) => {
    res.json(Object.entries(SYSTEMS).map(([key, s]) => ({ key, name: s.name, levels: s.levels })));
  });
  api.get("/people", (_req, res) => {
    res.json(staffList(db, actorOf(res), dateOf(now())));
  });
  api.get("/grants", (_req, res) => {
    res.json(listLiveGrants(db, actorOf(res), now()));
  });
  api.get("/requests", (req, res) => {
    const status = z.enum(["open", "approved", "denied", "granted"]).optional().parse(req.query.status);
    res.json(listRequests(db, actorOf(res), status ?? null, now()));
  });
  api.post("/requests", (req, res) => {
    const b = RequestBody.parse(req.body);
    const input = { personId: b.person_id, system: b.system, level: b.level, reason: b.reason };
    res.status(201).json(requestAccess(db, actorOf(res), input, now()));
  });
  api.post("/requests/:id/approve", (req, res) => {
    res.json(approveRequest(db, actorOf(res), id(req), now()));
  });
  api.post("/requests/:id/deny", (req, res) => {
    res.json(denyRequest(db, actorOf(res), id(req), now()));
  });
  api.post("/grants", (req, res) => {
    res.status(201).json(applyGrant(db, actorOf(res), GrantBody.parse(req.body), now()));
  });
  api.post("/grants/:id/revoke", (req, res) => {
    res.json(revokeGrant(db, actorOf(res), id(req), now()));
  });
  api.post("/people/:id/role", (req, res) => {
    res.json(setRole(db, actorOf(res), id(req), z.object({ role: z.string() }).parse(req.body).role, now()));
  });
  api.post("/people/:id/leaver-run", (req, res) => {
    res.json(runLeaver(db, actorOf(res), id(req), LeaverBody.parse(req.body).steps, now()));
  });
  api.post("/contracts/end", (_req, res) => {
    res.json(endContracts(db, actorOf(res), now()));
  });
  api.get("/reports/stale-access", (req, res) => {
    const at = now();
    const asOf = IsoDate.optional().parse(req.query.as_of) ?? dateOf(at);
    const actor = actorOf(res);
    res.json(
      decide(db, actor, at, "stale-access", () => {
        requireRole(actor, "read personal fields");
        return staleAccess(db, asOf);
      }),
    );
  });
  api.get("/audit", (req, res) => {
    const limit = z.coerce.number().int().min(1).max(1000).default(100).parse(req.query.limit);
    res.json(listAudit(db, actorOf(res), limit, now()));
  });
  app.use("/api", api);

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof Refusal) res.status(err.status).json({ error: err.code, message: err.message });
    else if (err instanceof NotFound) res.status(404).json({ error: "not-found", message: err.message });
    else if (err instanceof ZodError) res.status(400).json({ error: "invalid", issues: err.issues });
    else next(err);
  });
  return app;
}
