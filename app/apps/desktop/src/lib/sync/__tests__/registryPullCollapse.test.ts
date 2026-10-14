import { describe, expect, it } from "vitest";
import { VaultRegistry } from "../registry";

/** A bare registry whose pass is a stub we resolve by hand: only `pull()`'s
 *  queueing is under test, not a real reconcile. */
function harness() {
  const reg = Object.create(VaultRegistry.prototype) as VaultRegistry & Record<string, unknown>;
  reg.pullChain = Promise.resolve(false);
  reg.queuedPull = null;
  reg.registrations = new Set();
  const releases: Array<() => void> = [];
  let calls = 0;
  reg.pullOnce = () => {
    calls++;
    return new Promise<boolean>((r) => releases.push(() => r(true)));
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { reg, releases, calls: () => calls, flush };
}

describe("VaultRegistry.pull collapses requests made while a pull runs", () => {
  it("a burst of N requests during a running pull adds exactly one trailing pull", async () => {
    const h = harness();
    const first = h.reg.pull();
    await h.flush();
    expect(h.calls()).toBe(1);
    const burst = Array.from({ length: 20 }, () => h.reg.pull());
    // Every joiner shares the one queued pull.
    expect(new Set(burst).size).toBe(1);
    h.releases[0]();
    await first;
    await h.flush();
    expect(h.calls()).toBe(2);
    h.releases[1]();
    await Promise.all(burst);
    expect(h.calls()).toBe(2);
  });

  it("a request after the trailing pull STARTED queues a new one (never joins a running pass)", async () => {
    const h = harness();
    void h.reg.pull();
    await h.flush();
    const second = h.reg.pull();
    h.releases[0]();
    await h.flush();
    expect(h.calls()).toBe(2);
    const third = h.reg.pull();
    expect(third).not.toBe(second);
    h.releases[1]();
    await second;
    await h.flush();
    expect(h.calls()).toBe(3);
    h.releases[2]();
    await third;
  });
});
