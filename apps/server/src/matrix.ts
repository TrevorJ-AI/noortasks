import { defaultMatrixPrefs, isPlainObject, newId, type BatchResponse, type Loose } from "@noortasks/core";
import type { FastifyInstance } from "fastify";
import { batchSimple } from "./m4util.js";
import { ApiError, type Service } from "./service.js";

/** List named Eisenhower matrix views ordered by `sortOrder` (creation order on ties). */
export function listMatrixProfiles(svc: Service): Loose[] {
  return svc.store
    .collAll<Loose>("matrix_profiles")
    .sort((a, b) => (typeof a.sortOrder === "number" ? a.sortOrder : 0) - (typeof b.sortOrder === "number" ? b.sortOrder : 0));
}

/** `POST /api/v2/matrixProfiles/batch`: `{add, update, delete}` for named matrix views; no count cap. */
export function batchMatrixProfiles(svc: Service, body: unknown): BatchResponse {
  return batchSimple(svc, "matrix_profiles", body, {
    keep: ["name", "status", "sortOrder", "quadrants"],
    add: (o) => {
      if (typeof o.name !== "string") o.name = typeof o.name === "number" ? String(o.name) : "";
      o.status ??= 0;
      if (o.sortOrder === undefined) o.sortOrder = (svc.store.get<{ m: number | null }>("select max(pos) as m from matrix_profiles")?.m ?? 0) + 1;
      if (o.quadrants === undefined) o.quadrants = defaultMatrixPrefs().quadrants;
    },
    update: (o) => {
      if (o.name !== undefined && typeof o.name !== "string") o.name = typeof o.name === "number" ? String(o.name) : "";
    },
  });
}

/** `POST /api/v2/matrixProfiles`: single profile upsert, array upsert, or `{add, update, delete}` batch. */
export function postMatrixProfiles(svc: Service, body: unknown): Loose | Loose[] | BatchResponse {
  if (Array.isArray(body)) {
    if (body.some((item) => !isPlainObject(item))) throw new ApiError(400, "invalid_matrix_profile");
    return svc.store.tx(() => {
      const saved: Loose[] = [];
      for (const raw of body as Loose[]) {
        const id = typeof raw.id === "string" && raw.id ? raw.id : newId(svc.now());
        const exists = svc.store.collGet("matrix_profiles", id) !== undefined;
        const res = batchMatrixProfiles(svc, exists ? { update: [{ ...raw, id }] } : { add: [{ ...raw, id }] });
        const err = res.id2error[id];
        if (err) throw new ApiError(400, err);
        saved.push(svc.store.collGet<Loose>("matrix_profiles", id)!);
      }
      return saved;
    });
  }
  if (!isPlainObject(body)) throw new ApiError(400, "invalid_matrix_profile");
  if ("add" in body || "update" in body || "delete" in body) return batchMatrixProfiles(svc, body);
  const id = typeof body.id === "string" && body.id ? body.id : newId(svc.now());
  const exists = svc.store.collGet("matrix_profiles", id) !== undefined;
  const res = batchMatrixProfiles(svc, exists ? { update: [{ ...body, id }] } : { add: [{ ...body, id }] });
  const err = res.id2error[id];
  if (err) throw new ApiError(400, err);
  return svc.store.collGet<Loose>("matrix_profiles", id)!;
}

export function registerMatrixRoutes(app: FastifyInstance, svc: Service): void {
  app.get("/api/v2/matrixProfiles", async () => listMatrixProfiles(svc));
  app.post("/api/v2/matrixProfiles", async (req) => postMatrixProfiles(svc, req.body));
  app.post("/api/v2/matrixProfiles/batch", async (req) => batchMatrixProfiles(svc, req.body));
  app.post("/matrixProfiles/batch", async (req) => batchMatrixProfiles(svc, req.body));
}
