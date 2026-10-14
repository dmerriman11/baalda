// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const recents = vi.hoisted(() => ({
  readRecentServers: vi.fn(() => ["https://a.example.com", "https://b.example.com"]),
  switchServer: vi.fn(),
}));
vi.mock("../../lib/auth/recentServers", () => recents);

import { ConnectionTab } from "../AccountSettings";
import { useStore } from "../../store";

it("picks a recent server from the app's popover select, not a native <select>", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // A trailing slash still matches its normalized recent entry.
  useStore.setState({ serverUrl: "https://a.example.com/" } as never);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(ConnectionTab)));
    expect(host.querySelector("select")).toBeNull();
    const trigger = host.querySelector('[aria-label="Recent connections"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain("a.example.com");
    expect(trigger.textContent).toContain("Active");
    // Opening the tab reads the history; it never records (reorders) it.
    expect(recents.switchServer).not.toHaveBeenCalled();

    await act(async () => trigger.click());
    const items = [...document.querySelectorAll('[role="menuitemradio"]')];
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    await act(async () => (items[1] as HTMLElement).click());
    const input = host.querySelector('input[placeholder="https://notes.example.com"]') as HTMLInputElement;
    expect(input.value).toBe("https://b.example.com");
    expect(trigger.textContent).toContain("b.example.com");
    expect(trigger.textContent).not.toContain("Active");
    expect(host.textContent).not.toContain("Reconnected.");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
