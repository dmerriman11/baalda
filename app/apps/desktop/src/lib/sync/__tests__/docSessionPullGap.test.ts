// REGISTRY_FRAME_PULL_MIN_GAP_MS: teammate-driven pulls wait for the last pull to
// end plus the gap; local and urgent reasons keep the 250ms path. Registry faked
// as in docSessionVaultScope.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` because importing `../docSession` evaluates its `syncManager`
// singleton, which constructs a VaultRegistry at module-eval time — before a
// plain `const` here would be initialized.
const fakeRegistry = vi.hoisted(() => {
  const reg = {
    vaultId: null as string | null,
    // Phase A of `enable`: the local prime. False here — this suite is about the
    // reconcile-and-teardown path, and a prime that adopts nothing is exactly
    // the pre-prime behaviour these assertions were written against.
    primeLocal: vi.fn(async (_orgId: string) => false),
    reconcile: vi.fn(async () => ({ seeded: false })),
    // Resolves true ("something changed") so the tests can assert the tree
    // refresh fires — a false pull deliberately skips it to avoid flicker.
    pull: vi.fn(async () => true),
    reset: vi.fn(),
    getMapping: vi.fn(() => null),
    pathForDocId: vi.fn(() => null),
    allDocIds: vi.fn((): string[] => []),
    // Bulk-sync surface (phase 2): the manager reports progress through the
    // registry and drives the content upload off its mapped-note list.
    setProgressSink: vi.fn(),
    // Phase 3: the manager mirrors the path→docId map out to the sidebar
    // (coalesced), so the fake keeps the listener it is handed.
    mapListener: null as (() => void) | null,
    setMapListener: vi.fn((cb: (() => void) | null) => {
      reg.mapListener = cb;
    }),
    // Versioning: the manager also mirrors {docId → last-edit} out of the pull.
    setNoteMetaListener: vi.fn(),
    // …and the vault's shared item colors, from that same pull.
    setColorListener: vi.fn(),
    setFailureListener: vi.fn(),
    // Inbound reconciliation: the manager hands itself over as the host that can
    // make the editor/doc-store let go of a doc before its file moves.
    inboundHost: null as unknown,
    setInboundHost: vi.fn((host: unknown) => {
      reg.inboundHost = host;
    }),
    mappedNotes: vi.fn((): Array<{ docId: string; relPath: string }> => []),
    isPushed: vi.fn(() => false),
    markPushed: vi.fn(),
    flushCheckpoint: vi.fn(async () => {}),
    materializePendingFromBootstrap: vi.fn(async () => false),
    pendingFromBootstrapCount: vi.fn(() => 0),
    failures: vi.fn((): unknown[] => []),
    hasFailures: vi.fn(() => false),
    heldRefusals: vi.fn((): unknown[] => []),
    retryHeldRefusals: vi.fn(() => false),
    limitCode: vi.fn((): string | null => null),
  };
  return reg;
});

vi.mock("../registry", () => ({
  VaultRegistry: class {
    constructor() {
      return fakeRegistry;
    }
  },
}));

import type { SessionInfo } from "../../api";
import { REGISTRY_FRAME_PULL_MIN_GAP_MS, SyncManager } from "../docSession";
import { vaultScopes } from "../vaultScope";

function session(): SessionInfo {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: "org-a",
  } as unknown as SessionInfo;
}

/** Each pull stays open until the test releases it. */
const open: Array<() => void> = [];

async function enabled(): Promise<SyncManager> {
  vi.useFakeTimers();
  const sm = new SyncManager();
  await sm.enable(session(), { orgId: "org-a", name: "a", path: "/vaults/a", epoch: 1 });
  return sm;
}

beforeEach(() => {
  vi.useRealTimers();
  open.length = 0;
  fakeRegistry.pull.mockReset().mockImplementation(
    () => new Promise<boolean>((r) => open.push(() => r(false))),
  );
  fakeRegistry.mappedNotes.mockReturnValue([]);
  fakeRegistry.isPushed.mockReturnValue(false);
  vaultScopes.end();
});

describe("SyncManager — spacing teammate-driven registry pulls", () => {
  it("a burst of frames during and right after a pull gives at most 2 pulls, the second ≥ the gap after the first ended", async () => {
    const sm = await enabled();
    sm.handleRegistryChanged("registry-frame");
    await vi.advanceTimersByTimeAsync(300);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    // Frames while the pull runs: none may start a second pull alongside it.
    for (let i = 0; i < 10; i++) {
      sm.handleRegistryChanged("registry-frame");
      await vi.advanceTimersByTimeAsync(400);
    }
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    open[0]();
    await vi.advanceTimersByTimeAsync(0);
    const endedAt = Date.now();
    // …and right after it ended.
    for (let i = 0; i < 5; i++) {
      sm.handleRegistryChanged("registry-frame");
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(endedAt + REGISTRY_FRAME_PULL_MIN_GAP_MS - 1 - Date.now());
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(2);
    open[1]();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(2);
    sm.disable();
    vi.useRealTimers();
  });

  it("a local change still pulls on the 250ms path right after a pull", async () => {
    const sm = await enabled();
    sm.handleRegistryChanged("registry-frame");
    await vi.advanceTimersByTimeAsync(300);
    open[0]();
    await vi.advanceTimersByTimeAsync(0);
    sm.handleRegistryChanged("watcher");
    await vi.advanceTimersByTimeAsync(300);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(2);
    open[1]();
    sm.disable();
    vi.useRealTimers();
  });

  it("an urgent reason re-arms a gap-delayed timer sooner", async () => {
    const sm = await enabled();
    sm.handleRegistryChanged("registry-frame");
    await vi.advanceTimersByTimeAsync(300);
    open[0]();
    await vi.advanceTimersByTimeAsync(0);
    sm.handleRegistryChanged("registry-frame"); // due in ~2 s
    await vi.advanceTimersByTimeAsync(1_100); // past the storm cap
    sm.handleRegistryChanged("reauth");
    await vi.advanceTimersByTimeAsync(300);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(2);
    open[1]();
    sm.disable();
    vi.useRealTimers();
  });

  it("teardown clears the armed and the owed trailing pull", async () => {
    const sm = await enabled();
    sm.handleRegistryChanged("registry-frame");
    await vi.advanceTimersByTimeAsync(300);
    sm.handleRegistryChanged("registry-frame");
    await vi.advanceTimersByTimeAsync(300); // fires during the pull ⇒ trailing owed
    sm.handleRegistryChanged("registry-frame"); // and one armed
    expect(sm.hasPendingRegistryPull()).toBe(true);
    sm.disable();
    expect(sm.hasPendingRegistryPull()).toBe(false);
    open[0]();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    const internals = sm as unknown as Record<string, unknown>;
    expect(internals.registryPullTrailing).toBe(false);
    expect(internals.registryPullsInFlight).toBe(0);
    vi.useRealTimers();
  });
});
