// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  serverUrl: "https://two.example",
  flush: vi.fn(async () => {}),
  disable: vi.fn(),
  setServerUrl: vi.fn(async () => ({ user: { id: "new-user", name: "New", email: "new@example.com" }, activeOrganizationId: "same-org-id" })),
}));
vi.mock("../lib/auth/authManager", () => ({
  authManager: { api: {}, getServerUrl: () => mocks.serverUrl, setServerUrl: mocks.setServerUrl }, api: {},
}));
vi.mock("../lib/sync/docSession", () => ({ syncManager: { disable: mocks.disable, setViewing: vi.fn() } }));
vi.mock("../lib/bridge", () => ({ bridgeManager: { currentBridge: () => ({ flushEgest: mocks.flush }) } }));
vi.mock("../lib/ipc", () => ({ clearLastVault: vi.fn(async () => {}) }));
import { useStore } from "../store";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.serverUrl = "https://two.example";
  useStore.setState({
    vault: { path: "/old-vault", name: "Old", epoch: 1 },
    serverUrl: "https://one.example",
    syncEnabled: true,
    organizations: [{ id: "same-org-id", name: "Old", slug: "old" }],
    refreshVault: vi.fn(async () => {}),
    refreshBillingConfig: vi.fn(async () => {}),
    refreshOrgBilling: vi.fn(async () => {}),
    enableSyncForVault: vi.fn(async () => {}),
  });
});

it("flushes and stops the old vault before changing server, even for identical org IDs", async () => {
  await useStore.getState().setServerUrl("https://two.example");
  expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(mocks.disable.mock.invocationCallOrder[0]);
  expect(mocks.disable.mock.invocationCallOrder[0]).toBeLessThan(mocks.setServerUrl.mock.invocationCallOrder[0]);
  expect(useStore.getState().vault).toBeNull();
  expect(useStore.getState().syncEnabled).toBe(false);
  expect(useStore.getState().organizations).toEqual([]);
  expect(useStore.getState().enableSyncForVault).not.toHaveBeenCalled();
  expect(useStore.getState().session?.user.id).toBe("new-user");
});

it("aborts a switch if unsaved local content cannot be flushed", async () => {
  mocks.flush.mockRejectedValueOnce(Error("disk full"));
  await expect(useStore.getState().setServerUrl("https://two.example")).rejects.toThrow("disk full");
  expect(mocks.disable).not.toHaveBeenCalled();
  expect(mocks.setServerUrl).not.toHaveBeenCalled();
  expect(useStore.getState().vault?.path).toBe("/old-vault");
});

it("retains the current folder when reconnecting to the same server", async () => {
  await useStore.getState().setServerUrl("https://one.example/");
  expect(mocks.disable.mock.invocationCallOrder[0]).toBeLessThan(mocks.setServerUrl.mock.invocationCallOrder[0]);
  expect(useStore.getState().vault?.path).toBe("/old-vault");
  expect(useStore.getState().enableSyncForVault).toHaveBeenCalledOnce();
});

it("keeps the old server, vault and vault list when the new address cannot be adopted", async () => {
  const session = { user: { id: "old-user", name: "Old", email: "old@example.com" }, activeOrganizationId: "same-org-id" };
  useStore.setState({ session, authStatus: "signed-in" } as never);
  mocks.serverUrl = "https://one.example";
  mocks.setServerUrl.mockRejectedValueOnce(Error("keychain refused"));
  await expect(useStore.getState().setServerUrl("https://two.example")).rejects.toThrow("keychain refused");
  const state = useStore.getState();
  expect(state.serverUrl).toBe("https://one.example");
  expect(state.vault?.path).toBe("/old-vault");
  expect(state.organizations).toHaveLength(1);
  expect(state.session?.user.id).toBe("old-user");
  expect(state.authStatus).toBe("signed-in");
  expect(state.refreshVault).toHaveBeenCalledOnce();
  expect(state.enableSyncForVault).toHaveBeenCalledOnce();
  // The pending edits were still flushed before anything changed.
  expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(mocks.setServerUrl.mock.invocationCallOrder[0]);
});
