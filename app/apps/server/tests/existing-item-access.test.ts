// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeEach, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { effectivePermission } from "../src/permissions/resolver.js";
import { canCreateIn } from "../src/permissions/http-gates.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { resetDb } from "./helpers/db.js";
import { seedFolder, seedMember, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";

const rec = recordingAppDeps();
const app = createApp(rec.deps);
const post = (user: TestUser, path: string, body: unknown) => app.request(path, {
  method: "POST", headers: { ...authHeaders(user), "content-type": "application/json" },
  body: JSON.stringify(body),
});
beforeEach(async () => { await resetDb(); rec.reset(); });
afterAll(async () => { await pool.end(); });

it.each(["owner", "member"] as const)("restricting existing items preserves new root creation for a %s", async (role) => {
  const owner = await signUp("owner@existing.test");
  const org = await createOrg(owner, "Existing items", "existing-items");
  const vaultId = await seedVault(org.id);
  await seedVaultGrant(org.id, "edit");
  const person = role === "owner" ? owner : await signUp("member@existing.test");
  if (role === "member") await seedMember(org.id, person.userId, "member");
  const folder = await seedFolder(vaultId, null, "Existing", "Existing", person.userId);
  const nested = await seedNote(vaultId, folder, "Existing/Child.md", person.userId);
  const root = await seedNote(vaultId, null, "Old.md", person.userId);
  const vaultRules = () => pool.query("SELECT * FROM shares WHERE resource_type='vault' AND resource_id=$1 ORDER BY id", [org.id]);
  const before = (await vaultRules()).rows;

  const moved = await post(owner, `/api/orgs/${org.id}/access/bulk`, {
    resources: [{ resourceType: "folder", resourceId: folder }, { resourceType: "file", resourceId: root }],
    audience: { type: "users", userIds: [person.userId] }, mode: "private",
  });
  expect(moved.status).toBe(200);
  expect(await effectivePermission(person.userId, root)).toBe("none");
  expect(await effectivePermission(person.userId, nested)).toBe("none");
  expect((await vaultRules()).rows).toEqual(before);
  expect(await canCreateIn(person.userId, vaultId, null)).toBe(true);
  expect(await canCreateIn(person.userId, vaultId, folder)).toBe(false);

  const note = await post(person, "/api/notes", { vaultId, relPath: "New.md" });
  expect(note.status).toBe(201);
  const newNote = await note.json();
  expect(await effectivePermission(person.userId, newNote.docId)).toBe("edit");
  const newFolder = await post(person, "/api/folders", { vaultId, name: "New", path: "New" });
  expect(newFolder.status).toBe(201);
  expect(await canCreateIn(person.userId, vaultId, (await newFolder.json()).id)).toBe(true);
  const blocked = await post(person, "/api/notes", { vaultId, relPath: "Existing/Blocked.md", folderId: folder });
  expect(blocked.status).toBe(403);
  expect((await blocked.json()).code).toBe("no_write_access");
});
