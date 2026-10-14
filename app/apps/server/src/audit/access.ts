// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";
import { pool } from "../db/pool.js";
import { orgRole } from "../permissions/lookup.js";

/** Request identity for Better Auth's post-write hooks (its `user` can be the target). */
export const auditRequestActor = new AsyncLocalStorage<string | null>();

/** Must be called inside the mutation's transaction; never leaks to the next pool borrower. */
export async function setAuditActor(db: Pick<pg.PoolClient, "query">, userId: string): Promise<void> {
  await db.query("SELECT set_config('baalda.audit_actor', $1, true)", [userId]);
}

export async function withAuditActor<T>(
  userId: string,
  write: (db: pg.PoolClient) => Promise<T>,
  db: pg.Pool = pool,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await setAuditActor(client, userId);
    const result = await write(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Better Auth owns its transaction. The trigger already recorded the change;
 * enrich that specific membership event with the authenticated request actor.
 * A crash before the hook leaves an honest null actor, never loses the event. */
export async function attributeMembershipEvent(memberId: string, action: "insert" | "delete", userId: string | null): Promise<void> {
  if (!userId) return;
  try {
    await pool.query(
      `UPDATE access_audit SET actor_user_id = $3, actor_name = (SELECT name FROM "user" WHERE id = $3)
        WHERE entity_type = 'member' AND entity_id = $1 AND action = $2 AND actor_user_id IS NULL`,
      [memberId, action, userId],
    );
  } catch (error) {
    // The membership and its event are already committed. Do not report a
    // failed join/remove after success; the durable event keeps a null actor.
    console.error("[audit] could not attribute membership event", error);
  }
}

export async function listAccessAudit(organizationId: string, userId: string, opts: { before?: string; limit?: number } = {}) {
  const role = await orgRole(organizationId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("access_manager_required");
  if (opts.before !== undefined && !/^[1-9][0-9]{0,18}$/.test(opts.before)) throw new Error("invalid_cursor");
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 100)));
  if (!Number.isFinite(limit)) throw new Error("invalid_limit");
  const { rows } = await pool.query(
    `SELECT id::text, occurred_at AS "occurredAt", actor_user_id AS "actorUserId", actor_name AS "actorName",
            entity_type AS "entityType", entity_id AS "entityId", action,
            before_state AS "before", after_state AS "after"
       FROM access_audit WHERE organization_id = $1 AND ($2::numeric IS NULL OR id < $2::numeric)
       ORDER BY id DESC LIMIT $3`,
    [organizationId, opts.before ?? null, limit + 1],
  );
  return { events: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id as string : null };
}
