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
const captured = vi.hoisted(() => ({ opts: null as any }));
vi.mock("../attachments", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    AttachmentSync: class { constructor(o: any) { captured.opts = o; } start() {} stop() {} schedule() {} request() {} async run() {} },
  };
});
vi.mock("../crdtGc", () => ({ collectCrdtGarbage: vi.fn(async () => {}) }));
import { SyncManager } from "../docSession";
import { vaultScopes } from "../vaultScope";

const session = (org: string) => ({ user: { id: "user", name: "Test", email: "test@example.com" }, activeOrganizationId: org });
const target = (letter: string, epoch: number) => ({ orgId: `org-${letter}`, name: letter, path: `/vault-${letter}`, epoch });
let manager: SyncManager;
beforeEach(() => {
  vi.clearAllMocks();
  captured.opts = null;
  manager = new SyncManager();
  vi.spyOn(manager as any, "startVaultEngine").mockImplementation(() => {});
  vi.spyOn(manager as any, "setupAttachments").mockImplementation(() => {});
});
afterEach(() => { manager.disable(); vaultScopes.end(); });

it("attachment host callbacks captured in A write to A's registry after switching to B", async () => {
  await manager.enable(session("org-a"), target("a", 1));
  const registryA = manager.registry;
  vi.mocked((manager as any).setupAttachments).mockRestore();
  (manager as any).setupAttachments((manager as any).scope);
  const host = captured.opts;
  expect(host).toBeTruthy();
  await manager.enable(session("org-b"), target("b", 2));
  const registryB = manager.registry;
  expect(registryB).not.toBe(registryA);
  const spyA = vi.spyOn(registryA, "setFileId").mockImplementation(() => {});
  const spyB = vi.spyOn(registryB, "setFileId").mockImplementation(() => {});
  const baseA = vi.spyOn(registryA, "setFileBase").mockImplementation(() => {});
  const baseB = vi.spyOn(registryB, "setFileBase").mockImplementation(() => {});
  host.rememberFileId("late.png", "file-1");
  host.setFileBase("file-1", "sha");
  expect(spyA).toHaveBeenCalledWith("late.png", "file-1", undefined);
  expect(baseA).toHaveBeenCalledWith("file-1", "sha");
  expect(spyB).not.toHaveBeenCalled();
  expect(baseB).not.toHaveBeenCalled();
});
