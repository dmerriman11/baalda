// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import { listAccessAudit } from "../../audit/access.js";
import { getSession } from "../session.js";

export const accessAuditRoutes = new Hono();
accessAuditRoutes.get("/orgs/:orgId/access-audit", async c => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  try {
    return c.json(await listAccessAudit(c.req.param("orgId"), session.userId, {
      before: c.req.query("before"),
      limit: c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit")),
    }));
  } catch (error) {
    const code = (error as Error).message;
    if (code === "access_manager_required") return c.json({ error: code }, 403);
    if (code === "invalid_cursor" || code === "invalid_limit") return c.json({ error: code }, 400);
    throw error;
  }
});
