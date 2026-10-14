// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { buildAccessContextFromIndex, createResolverCache, effectivePermission, loadAccessIndex, resolveAccessForUser } from "../src/permissions/resolver.js";
import { listReadableDocsInVault } from "../src/permissions/vault-docs.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

beforeEach(resetDb);
afterAll(async () => { await pool.end(); });
const migration = readFileSync(new URL("../migrations/057_legacy_solo_owner_access.sql", import.meta.url), "utf8");

async function setup() {
  const org = await seedOrg("Legacy", "legacy");
  const owner = await seedUser("owner@legacy.test");
  await seedMember(org, owner, "owner");
  const vault = await seedVault(org);
  const file = randomUUID();
  await pool.query("INSERT INTO files (id, vault_id, path, created_by) VALUES ($1,$2,'report.pdf',$3)", [file, vault, owner]);
  return { org, owner, vault, file };
}

it("a recorded attachment creator keeps access with no vault grant across all resolver paths", async () => {
  const { org, owner, vault, file } = await setup();
  const cache = createResolverCache();
  await cache.prefetch(pool, [file]);
  expect(await effectivePermission(owner, file)).toBe("edit");
  expect(await effectivePermission(owner, file, pool, cache)).toBe("edit");
  expect(await listReadableDocsInVault(owner, vault)).toEqual(new Set([file]));
  const index = await loadAccessIndex(pool, org);
  const ctx = await buildAccessContextFromIndex(index, "file", file);
  expect((await resolveAccessForUser(ctx!, owner, "owner", pool, undefined, index)).permission).toBe("edit");

  // Authorship must not bypass an explicit denial or removed membership.
  await pool.query("INSERT INTO shares (id,org_id,resource_type,resource_id,principal_type,principal_id,permission) VALUES ($1,$2,'file',$3,'user',$4,'denied')", [randomUUID(), org, file, owner]);
  expect(await effectivePermission(owner, file)).toBe("none");
  expect(await listReadableDocsInVault(owner, vault)).toEqual(new Set());
  await pool.query("DELETE FROM shares");
  await pool.query('DELETE FROM member WHERE "userId"=$1', [owner]);
  expect(await effectivePermission(owner, file)).toBe("none");
  expect(await listReadableDocsInVault(owner, vault)).toEqual(new Set());
});

it("repairs a solo legacy owner through authorship only: no share, no audit row, no reach into later members' notes", async () => {
  const { org, owner, vault, file } = await setup();
  await pool.query("UPDATE files SET created_by=NULL WHERE id=$1", [file]);
  const note = randomUUID();
  await pool.query("INSERT INTO notes (id, doc_id, vault_id, rel_path) VALUES ($1,$1,$2,'legacy.md')", [note, vault]);
  expect(await effectivePermission(owner, file)).toBe("none");
  await pool.query("DELETE FROM access_audit");
  await pool.query(migration);
  await pool.query(migration); // retry is a no-op
  expect(await effectivePermission(owner, file)).toBe("edit");
  expect(await effectivePermission(owner, note)).toBe("edit");
  expect(await listReadableDocsInVault(owner, vault)).toEqual(new Set([file, note]));
  expect((await pool.query("SELECT created_by FROM files WHERE id=$1", [file])).rows[0].created_by).toBe(owner);
  expect((await pool.query("SELECT * FROM shares")).rows).toHaveLength(0);
  expect((await pool.query("SELECT * FROM access_audit")).rows).toHaveLength(0);

  // A member who joins later: their notes stay theirs, and the legacy owner
  // gains nothing over them from this migration (no absolute vault level).
  const other = await seedUser("new@legacy.test");
  await seedMember(org, other, "member");
  const theirs = randomUUID();
  await pool.query("INSERT INTO notes (id, doc_id, vault_id, rel_path, created_by) VALUES ($1,$1,$2,'mine.md',$3)", [theirs, vault, other]);
  await pool.query(migration); // a re-run against a now multi-member vault touches nothing
  expect(await effectivePermission(other, file)).toBe("none");
  expect(await effectivePermission(owner, theirs)).toBe("none");
  expect((await listReadableDocsInVault(owner, vault)).has(theirs)).toBe(false);
  expect((await pool.query("SELECT created_by FROM notes WHERE id=$1", [theirs])).rows[0].created_by).toBe(other);
  expect((await pool.query("SELECT * FROM shares")).rows).toHaveLength(0);
});

it("preserves the live note's identity when a legacy file row uses the same id", async () => {
  const { owner, vault, file } = await setup();
  await pool.query("INSERT INTO notes (id, doc_id, vault_id, rel_path) VALUES ($1,$1,$2,'legacy.md')", [file, vault]);
  expect(await effectivePermission(owner, file)).toBe("none");
  expect(await listReadableDocsInVault(owner, vault)).toEqual(new Set());
});

it.each(["denied", "view"])("preserves an explicit %s vault posture", async (permission) => {
  const { org, owner, vault, file } = await setup();
  await pool.query("INSERT INTO shares (id,org_id,resource_type,resource_id,principal_type,principal_id,permission) VALUES ($1,$2,'vault',$2,'org',$2,$3)", [randomUUID(), org, permission]);
  await pool.query(migration);
  expect((await pool.query("SELECT * FROM shares")).rows).toHaveLength(1);
  expect(await effectivePermission(owner, file)).toBe(permission === "denied" ? "none" : "view");
  expect((await listReadableDocsInVault(owner, vault)).has(file)).toBe(permission === "view");
});

it("does not infer grants for multi-member vaults or vaults with item-level restrictions", async () => {
  const { org, owner, file } = await setup();
  const other = await seedUser("other@legacy.test");
  await seedMember(org, other, "member");
  await pool.query("UPDATE files SET created_by=NULL WHERE id=$1", [file]);
  await pool.query(migration);
  expect((await pool.query("SELECT * FROM shares")).rows).toHaveLength(0);
  expect((await pool.query("SELECT created_by FROM files WHERE id=$1", [file])).rows[0].created_by).toBeNull();
  await pool.query('DELETE FROM member WHERE "userId"=$1', [other]);
  await pool.query("INSERT INTO shares (id,org_id,resource_type,resource_id,principal_type,principal_id,permission) VALUES ($1,$2,'file',$3,'user',$4,'denied')", [randomUUID(), org, file, owner]);
  await pool.query(migration);
  expect((await pool.query("SELECT * FROM shares")).rows).toHaveLength(1);
  expect(await effectivePermission(owner, file)).toBe("none");
});
