// SPDX-License-Identifier: Apache-2.0
import { performance } from "node:perf_hooks";
import { afterAll, beforeEach, expect, it } from "vitest";
import { pool, resetDb } from "./helpers/db.js";
import { seedMember, seedOrg, seedUser, seedVault } from "./helpers/seed.js";
import { listDeletedReadableDocsInVault } from "../src/permissions/vault-docs.js";

beforeEach(resetDb);
afterAll(() => pool.end());

it("resolves a large scoped vault's deleted set without a tombstone/path cross product", async () => {
  const org = await seedOrg("Large", "large-deleted");
  const user = await seedUser("scoped@large.test");
  await seedMember(org, user, "member");
  const vault = await seedVault(org);
  await pool.query("DELETE FROM member_access_snapshots WHERE organization_id = $1", [org]);
  await pool.query(`INSERT INTO folders (id, vault_id, parent_id, name, path)
    SELECT 'f' || i, $1, NULL, 'F' || i, 'F' || i FROM generate_series(1, 4100) i`, [vault]);
  await pool.query(`INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
    SELECT 's' || i, $1, 'folder', 'f' || i, 'user', $2, 'view' FROM generate_series(1, 240) i`, [org, user]);
  await pool.query(`INSERT INTO folder_tombstones (id, vault_id, path, deleted_at)
    SELECT 'dead' || i, $1, 'F' || (1 + i % 240) || '/Gone' || i, now()
    FROM generate_series(1, 500) i`, [vault]);
  await pool.query(`INSERT INTO notes (id, doc_id, vault_id, rel_path, created_at, deleted_at)
    SELECT 'n' || i, 'n' || i, $1,
      CASE WHEN i <= 670 THEN 'F' || (1 + (1 + i % 500) % 240) || '/Gone' || (1 + i % 500) || '/n' || i || '.md'
        ELSE 'live' || i || '.md' END,
      now() - interval '1 day', CASE WHEN i <= 670 THEN now() ELSE NULL END
    FROM generate_series(1, 7000) i`, [vault]);
  const started = performance.now();
  const result = await listDeletedReadableDocsInVault(user, vault);
  const elapsed = performance.now() - started;
  console.info(`deleted-readable 4100 folders / 7000 notes / 500 tombstones: ${Math.round(elapsed)} ms`);
  expect(result.size).toBe(670);
  expect(elapsed).toBeLessThan(5000);
});
