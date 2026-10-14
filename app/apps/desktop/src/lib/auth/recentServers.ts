// SPDX-License-Identifier: Apache-2.0
import { normalizeServerUrl, type ServerChoice } from "./serverChoice";

const KEY = "context.recentServers";
const LIMIT = 8;

/** Device-local addresses only. Session credentials stay in the OS keychain. */
export function readRecentServers(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return [...new Set(stored.flatMap((value) => {
      const url = typeof value === "string" ? normalizeServerUrl(value) : null;
      return url ? [url] : [];
    }))].slice(0, LIMIT);
  } catch {
    return [];
  }
}

export function rememberServer(url: string): string[] {
  const clean = normalizeServerUrl(url);
  const recent = readRecentServers();
  if (!clean) return recent;
  const next = [clean, ...recent.filter((item) => item !== clean)].slice(0, LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Address history is optional; storage failure must not prevent connecting.
  }
  return next;
}

export interface SwitchServerDeps {
  /** The store's `setServerUrl`: `true` once the switch landed, `false` when
   *  another flow cancelled it; throws on failure. */
  switchTo: (url: string) => Promise<boolean>;
  /** Persist the managed/custom choice. */
  writeChoice: (choice: ServerChoice) => void;
  defaultUrl: string;
}

/**
 * The Connection tab's Save: switch, and only once the switch actually landed
 * record the managed/custom choice. A cancelled switch resolves `false` and a
 * failed one throws — neither touches the choice.
 */
export async function switchServer(url: string, deps: SwitchServerDeps): Promise<boolean> {
  const switched = await deps.switchTo(url);
  if (!switched) return false;
  deps.writeChoice(url === deps.defaultUrl ? "managed" : "custom");
  return true;
}
