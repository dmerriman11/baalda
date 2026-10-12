// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../lib/auth/authManager", () => ({ authManager: { getServerUrl: () => "http://localhost:3010", api: {} }, api: {} }));
vi.mock("../lib/sync/docSession", () => ({ syncManager: {} }));
vi.mock("../lib/bridge", () => ({ bridgeManager: {} }));
vi.mock("../components/FileTree", () => ({ iconForPath: () => null, SidebarPresence: () => null }));
import { useStore } from "../store";
import { HomeSection } from "../components/HomeNavigation";
import { readHomeSectionHidden } from "../lib/prefs";

const vault = { path: "/vault", name: "Vault", epoch: 1 };
const home = { id: "home", path: "Start here.md", title: "Start here" };
const initial = useStore.getInitialState();
const renderHome = () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(createElement(HomeSection)));
  const html = host.innerHTML;
  act(() => root.unmount());
  return html;
};

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useStore.setState({ ...initial, vault, titles: [home], personalHomeDocId: home.id,
    syncEnabled: false, session: null, activeVirtualTab: null, openingNotePath: null,
    homeActivation: null, openNote: null,
    openNoteByPath: vi.fn(async (path: string) => {
      useStore.setState({ openNote: { ...home, path }, activeVirtualTab: null });
    }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Home navigation", () => {
  it("reveals the section when assigning even the existing Home, without expanding the page", async () => {
    useStore.getState().setHomeSectionHidden(true);
    await useStore.getState().setHome(home.path);
    expect(useStore.getState().homeSectionHidden).toBe(false);
    expect(readHomeSectionHidden()).toBe(false);
    expect(useStore.getState().homeActivation).toBeNull();
  });
  it("hides and restores the section without unsetting Home, and persists the preference", () => {
    useStore.getState().setHomeSectionHidden(true);
    expect(readHomeSectionHidden()).toBe(true);
    expect(renderHome()).toBe("");
    expect(useStore.getState().personalHomeDocId).toBe(home.id);
    useStore.getState().setHomeSectionHidden(false);
    expect(readHomeSectionHidden()).toBe(false);
    expect(renderHome()).toContain("Start here");
  });
  it("collapses only for explicit sidebar Home activations", async () => {
    await useStore.getState().openHome();
    expect(useStore.getState().homeActivation).toBeNull();
    await useStore.getState().openHome(true, true);
    expect(useStore.getState().homeActivation).toEqual({ vaultPath: "/vault", path: home.path, revision: 1 });
    await useStore.getState().openHome(true, true);
    expect(useStore.getState().homeActivation).toEqual({ vaultPath: "/vault", path: home.path, revision: 2 });
  });

  it("does not collapse an unrelated note after a superseded open", async () => {
    useStore.setState({ openNoteByPath: async () => {
      useStore.setState({ openNote: { id: "other", path: "Other.md", title: "Other" } });
    } });
    await useStore.getState().openHome(true, true);
    expect(useStore.getState().homeActivation).toBeNull();
  });

  it("ignores a late open after the vault epoch changes", async () => {
    useStore.setState({ openNoteByPath: async () => {
      useStore.setState({ vault: { ...vault, epoch: 2 }, openNote: home });
    } });
    await useStore.getState().openHome();
    expect(useStore.getState().homeActivation).toBeNull();
  });

  it("does not publish a collapse when opening fails", async () => {
    useStore.setState({ openNoteByPath: async () => { throw new Error("Unavailable"); } });
    await expect(useStore.getState().openHome()).rejects.toThrow("Unavailable");
    expect(useStore.getState().homeActivation).toBeNull();
  });

  it.each(["Change Home…", "Unset Home"])("keeps %s actionable through WebKit's null-target blur", async (label) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(HomeSection)));
    const menu = host.querySelector("details")!;
    const summary = host.querySelector("summary")!;
    act(() => { menu.open = true; summary.focus(); });
    const button = Array.from(menu.querySelectorAll("button")).find((item) => item.textContent === label)!;
    act(() => {
      button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      summary.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    });
    expect(menu.open).toBe(true);
    await act(async () => button.click());
    expect(menu.open).toBe(false);
    if (label === "Change Home…") expect(useStore.getState().homePickerOpen).toBe(true);
    else {
      expect(useStore.getState().personalHomeDocId).toBeNull();
      expect(useStore.getState().titles).toEqual([home]);
    }
    act(() => root.unmount());
    host.remove();
  });

  it("dismisses Home options on an outside pointer press", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(HomeSection)));
    const menu = host.querySelector("details")!;
    menu.open = true;
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(menu.open).toBe(false);
    act(() => root.unmount());
    host.remove();
  });

  it("shows the effective Home name and current-page marker for a Home visit", async () => {
    await useStore.getState().openHome(true, true);
    const html = renderHome();
    expect(html).toContain('aria-label="Home"');
    expect(html).toContain("Start here");
    expect(html).toContain('aria-current="page"');
  });
  it("does not highlight Home when its original file is opened directly", async () => {
    await useStore.getState().openNoteByPath(home.path);
    expect(renderHome()).not.toContain('aria-current="page"');
  });
  it("offers Unset Home for a personal Home without changing the file", () => {
    const clear = vi.fn(async () => {});
    useStore.setState({ setHome: clear });
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(HomeSection)));
      const button = [...host.querySelectorAll("button")].find((el) => el.textContent === "Unset Home");
      expect(button).toBeDefined();
      act(() => button!.click());
      expect(clear).toHaveBeenCalledWith(null, "personal");
    } finally { act(() => root.unmount()); }
  });
  it("describes shared fallback and restricts clearing shared Home to vault managers", () => {
    useStore.setState({ syncEnabled: true,
      session: { user: { id: "me", name: "Me", email: "me@example.com" }, activeOrganizationId: "org" },
      vaultAppearance: { org: { homeDocId: home.id } }, members: [],
    });
    expect(renderHome()).toContain("Use vault Home instead");
    expect(renderHome()).not.toContain("Unset vault Home for everyone");
    useStore.setState({ members: [{ id: "membership", userId: "me", organizationId: "org", role: "admin" }] });
    expect(renderHome()).toContain("Unset vault Home for everyone");
  });

  it("offers templates without overwriting an unavailable Home preference", async () => {
    useStore.setState({ titles: [] });
    expect(renderHome()).toContain("Set a home");
    const requested = vi.fn();
    window.addEventListener("baalda:new-dashboard", requested);
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(HomeSection)));
      act(() => host.querySelector("button")!.click());
      expect(requested).toHaveBeenCalledOnce();
      expect(useStore.getState().personalHomeDocId).toBe(home.id);
      expect(useStore.getState().homePickerOpen).toBe(false);
    } finally {
      act(() => root.unmount());
      window.removeEventListener("baalda:new-dashboard", requested);
    }
    expect(useStore.getState().homeActivation).toBeNull();
  });
});
