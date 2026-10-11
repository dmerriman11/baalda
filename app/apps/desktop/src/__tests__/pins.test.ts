// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { mergePins, visiblePinnedItems, parsePins, renamePinnedFolders, resolveHome, togglePinned, isDashboard, type PinnedItem } from "../lib/pins";
import { parseVaultAppearanceSettings } from "../lib/appearanceSettings";

describe("personal and vault navigation", () => {
  const note: PinnedItem = { kind: "note", docId: "stable-id" };
  const folder: PinnedItem = { kind: "folder", path: "Projects" };
  it("puts shared pins first and deduplicates identities and folder case", () => {
    expect(mergePins([note, folder], [{ kind: "folder", path: "projects" }, note, { kind: "note", docId: "second" }])).toEqual([
      { item: note, shared: true }, { item: folder, shared: true }, { item: { kind: "note", docId: "second" }, shared: false },
    ]);
  });
  it("keeps note identity while folder moves rewrite descendants only", () => {
    expect(renamePinnedFolders([note, folder, { kind: "folder", path: "Projects/One" }, { kind: "folder", path: "Projects-old" }], "projects", "Work")).toEqual([
      note, { kind: "folder", path: "Work" }, { kind: "folder", path: "Work/One" }, { kind: "folder", path: "Projects-old" },
    ]);
  });
  it("hides missing/deleted entries without purging references during incomplete listing or restoration", () => {
    const preferences = [note, folder];
    expect(visiblePinnedItems([], preferences, [], () => false)).toEqual([]);
    expect(preferences).toEqual([note, folder]);
    expect(visiblePinnedItems([], preferences, [{ id: note.docId, path: "Renamed.html" }], () => true)).toEqual([
      { item: note, shared: false, path: "Renamed.html" }, { item: folder, shared: false, path: "Projects" },
    ]);
    // A confirmed deletion is hidden too; Trash restore keeps the doc_id and
    // brings the pin back without a write to personal/shared preferences.
    expect(visiblePinnedItems([note], [], [], () => true)).toEqual([]);
    expect(visiblePinnedItems([note], [], [{ id: note.docId, path: "Restored.html" }], () => true)[0].path).toBe("Restored.html");
  });
  it("toggles a personal list without editing shared pins", () => {
    expect(togglePinned([note], note)).toEqual([]);
    expect(togglePinned([], folder)).toEqual([folder]);
    expect(mergePins([note], togglePinned([note], note))).toEqual([{ item: note, shared: true }]);
  });
  it("personal home wins, with an absent override inheriting the vault", () => {
    expect(resolveHome("mine", "vault")).toBe("mine");
    expect(resolveHome(null, "vault")).toBe("vault");
    expect(resolveHome(null, undefined)).toBeNull();
  });
  it("rejects unsafe pins without dropping valid stable references", () => {
    expect(parsePins([note, { kind: "folder", path: "../secret" }, { kind: "folder", path: ".context" }, { kind: "folder", path: "/tmp" }, { kind: "note", docId: "bad/id" }])).toEqual([note]);
    expect(parsePins([note])).toEqual([note]); // no tree/listing is needed to retain a pin
  });
  it("preserves shared navigation when parsing live appearance frames", () => {
    expect(parseVaultAppearanceSettings({ theme: "dark", pinnedItems: [note], homeDocId: "home-id" })).toEqual({ theme: "dark", pinnedItems: [note], homeDocId: "home-id" });
    expect(parseVaultAppearanceSettings({ homeDocId: null })).toEqual({ homeDocId: null });
  });
  it("discovers local and linked dashboards by extension", () => {
    for (const path of ["Home.html", "a/Board.HTM", "Link.url", "Link.webloc"]) expect(isDashboard(path)).toBe(true);
    expect(isDashboard("note.md")).toBe(false);
  });
});
