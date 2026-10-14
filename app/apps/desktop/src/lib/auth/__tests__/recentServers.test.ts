// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readRecentServers, rememberServer, switchServer } from "../recentServers";

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("remembers normalized addresses in recency order without credentials", () => {
  rememberServer("https://user:secret@one.example/baalda/?token=private#fragment");
  rememberServer("two.example");
  rememberServer("https://one.example/baalda/");
  expect(readRecentServers()).toEqual(["https://one.example/baalda", "https://two.example"]);
  expect([...values.values()].join()).not.toMatch(/secret|private/);
});

it("bounds history and tolerates corrupt storage", () => {
  values.set("context.recentServers", "{");
  expect(readRecentServers()).toEqual([]);
  values.set("context.recentServers", JSON.stringify([null, {}, "ftp://bad.example", "one.example", "https://one.example/"]));
  expect(readRecentServers()).toEqual(["https://one.example"]);
  for (let i = 0; i < 10; i++) rememberServer(`https://server${i}.example`);
  expect(readRecentServers()).toHaveLength(8);
  expect(readRecentServers()[0]).toBe("https://server9.example");
});

it("does not make optional storage a connection prerequisite", () => {
  vi.stubGlobal("localStorage", { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } });
  expect(rememberServer("one.example")).toEqual(["https://one.example"]);
});

it("writes the managed/custom choice only after the switch landed", async () => {
  const writeChoice = vi.fn();
  const deps = (switchTo: (url: string) => Promise<boolean>) => ({ switchTo, writeChoice, defaultUrl: "https://api.example" });
  await expect(switchServer("https://self.example", deps(async () => false))).resolves.toBe(false);
  await expect(switchServer("https://self.example", deps(async () => { throw Error("keychain"); }))).rejects.toThrow("keychain");
  expect(writeChoice).not.toHaveBeenCalled();
  await expect(switchServer("https://self.example", deps(async () => true))).resolves.toBe(true);
  expect(writeChoice).toHaveBeenLastCalledWith("custom");
  await switchServer("https://api.example", deps(async () => true));
  expect(writeChoice).toHaveBeenLastCalledWith("managed");
});

it("records recents only for a switch that landed, newest first", async () => {
  const deps = (ok: boolean) => ({
    switchTo: async () => ok,
    writeChoice: vi.fn(),
    defaultUrl: "https://api.example",
    previousUrl: "https://one.example",
  });
  await switchServer("https://two.example/", deps(false));
  expect(readRecentServers()).toEqual([]);
  await switchServer("https://two.example/", deps(true));
  expect(readRecentServers()).toEqual(["https://two.example", "https://one.example"]);
});
