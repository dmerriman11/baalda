// SPDX-License-Identifier: Apache-2.0
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listVaults: vi.fn(async () => [
    { id: "collection-a", organization_id: "org-a", name: "A" },
    { id: "collection-b", organization_id: "org-b", name: "B" },
  ]),
  listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
  listNoteRegistryPaged: vi.fn(async (_id: string) => ({ notes: [] as any[], tombstones: [] as string[] })),
  listFilesWithBytes: vi.fn(async () => []),
}));
vi.mock("../../auth/authManager", () => ({ api, authManager: { api } }));
vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => null),
  setVaultConfig: vi.fn(async () => {}),
  listTree: vi.fn(async () => ({ id: "root", name: "", path: "", isDir: true, children: [], childrenLoaded: true })),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
  writeNoteIfMissing: vi.fn(async () => true),
  isVaultMismatch: vi.fn(() => false),
  vaultRootExists: vi.fn(async () => true),
}));
vi.mock("../crdtGc", () => ({ collectCrdtGarbage: vi.fn(async () => {}) }));
import * as ipc from "../../ipc";
import { SyncManager } from "../docSession";
import { vaultScopes } from "../vaultScope";

const session = (org: string) => ({ user: { id: "user", name: "Test", email: "test@example.com" }, activeOrganizationId: org });
const target = (letter: string, epoch: number) => ({ orgId: `org-${letter}`, name: letter, path: `/vault-${letter}`, epoch });
let manager: SyncManager;
beforeEach(() => {
  vi.clearAllMocks();
  api.listNoteRegistryPaged.mockImplementation(async () => ({ notes: [], tombstones: [] }));
  manager = new SyncManager();
  // Exercise the real registry and session lifetime; exclude sockets and blobs.
  vi.spyOn(manager as any, "startVaultEngine").mockImplementation(() => {});
  vi.spyOn(manager as any, "setupAttachments").mockImplementation(() => {});
});
afterEach(() => { manager.disable(); vaultScopes.end(); });

it("a delayed listing from A cannot materialize files, maps, or counts into B", async () => {
  let arrived!: () => void;
  const requested = new Promise<void>(resolve => { arrived = resolve; });
  let release!: (value: any) => void;
  const delayed = new Promise<any>(resolve => { release = resolve; });
  api.listNoteRegistryPaged.mockImplementation(async (id) => {
    if (id === "collection-a") { arrived(); return delayed; }
    return { notes: [], tombstones: [] };
  });
  const openingA = manager.enable(session("org-a"), target("a", 1));
  await requested;
  const registryA = manager.registry;
  await manager.enable(session("org-b"), target("b", 2));
  const registryB = manager.registry;
  vi.mocked(ipc.setVaultConfig).mockClear();
  release({ notes: [{ id: "a-note", rel_path: "Only-in-A.md" }], tombstones: [] });
  expect((await openingA).ok).toBe(false);
  expect(registryB).not.toBe(registryA);
  expect(registryB.vaultId).toBe("collection-b");
  expect(registryB.mappedNotes()).toEqual([]);
  expect(ipc.writeNoteIfMissing).not.toHaveBeenCalled();
  expect(ipc.setVaultConfig).not.toHaveBeenCalled();
  expect(await registryA.primeLocal("org-b")).toBe(false);
});

it("a delayed unsuccessful local prime cannot reconcile A in the next session", async () => {
  let release!: (value: null) => void;
  const delayed = new Promise<null>(resolve => { release = resolve; });
  vi.mocked(ipc.getVaultConfig).mockReturnValueOnce(delayed);
  const openingA = manager.enable(session("org-a"), target("a", 1));
  await manager.enable(session("org-b"), target("b", 2));
  api.listVaults.mockClear();
  release(null);
  expect((await openingA).ok).toBe(false);
  expect(api.listVaults).not.toHaveBeenCalled();
  expect(manager.registry.vaultId).toBe("collection-b");
});
