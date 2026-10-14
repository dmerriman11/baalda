import { describe, expect, it, vi } from "vitest";
import {
  UnmaterializablePaths,
  applySkippingUnsafe,
  strippedServerIndex,
  windowsPathProblem,
  windowsStrip,
} from "../windowsPaths";

describe("windowsPathProblem", () => {
  it("flags names Windows cannot hold", () => {
    expect(windowsPathProblem("Team/Drafts./a.md")).toBe("trailing-dot-or-space");
    expect(windowsPathProblem("Team/Drafts /a.md")).toBe("trailing-dot-or-space");
    expect(windowsPathProblem("Team/con")).toBe("reserved-name");
    expect(windowsPathProblem("Team/AUX/a.md")).toBe("reserved-name");
    expect(windowsPathProblem("Team/lpt1.txt")).toBe("reserved-name");
    expect(windowsPathProblem("Team/com9/x.png")).toBe("reserved-name");
    expect(windowsPathProblem("Team/a:b.md")).toBe("forbidden-char");
    expect(windowsPathProblem("Team/what?.md")).toBe("forbidden-char");
    expect(windowsPathProblem("ab/".repeat(80) + "x.md")).toBe("too-long");
  });
  it("passes ordinary names", () => {
    expect(windowsPathProblem("Team/Notes/a.md")).toBeNull();
    expect(windowsPathProblem("Team/console/a.md")).toBeNull();
    expect(windowsPathProblem("Team/com10/a.md")).toBeNull();
    expect(windowsPathProblem("Café/v1.2 draft.md")).toBeNull();
  });
  it("strips like Win32 does", () => {
    expect(windowsStrip("A./B /c.md")).toBe("A/B/c.md");
  });
});

describe("UnmaterializablePaths", () => {
  it("skips on Windows with one warning per path, never elsewhere", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const win = new UnmaterializablePaths(() => true);
    expect(win.skip("X/Drafts.")).toBe(true);
    expect(win.skip("X/Drafts.")).toBe(true);
    expect(win.skip("X/ok")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const mac = new UnmaterializablePaths(() => false);
    expect(mac.skip("X/Drafts.")).toBe(false);
    warn.mockRestore();
  });
});

describe("applySkippingUnsafe", () => {
  const entries = [
    { docId: "a", relPath: "Team/ok.md" },
    { docId: "b", relPath: "Team/X./a.md" },
  ];
  const ok = (es: typeof entries) =>
    Promise.resolve(es.map((e) => ({ docId: e.docId, status: "written", reason: null as string | null })));

  it("on Windows never sends an unsafe entry and answers it rejected by doc id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const apply = vi.fn(ok);
    const paths = new UnmaterializablePaths(() => true);
    const out = await applySkippingUnsafe(entries, apply, paths);
    expect(apply).toHaveBeenCalledWith([entries[0]]);
    expect(out.find((o) => o.docId === "a")?.status).toBe("written");
    expect(out.find((o) => o.docId === "b")?.status).toBe("rejected");
    // Only unsafe entries: Rust is not called at all.
    apply.mockClear();
    const only = await applySkippingUnsafe([entries[1]], apply, paths);
    expect(apply).not.toHaveBeenCalled();
    expect(only).toEqual([{ docId: "b", status: "rejected", reason: "Windows cannot hold this name" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("elsewhere passes every entry through unchanged", async () => {
    const apply = vi.fn(ok);
    const out = await applySkippingUnsafe(entries, apply, new UnmaterializablePaths(() => false));
    expect(apply).toHaveBeenCalledWith(entries);
    expect(out.map((o) => o.status)).toEqual(["written", "written"]);
  });
});

describe("skipShadow", () => {
  it("matches the stripped twin case-insensitively and in NFC, only on Windows", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const index = strippedServerIndex(["Caf\u00e9.", "Caf\u00e9./a.md", "Team"]);
    const win = new UnmaterializablePaths(() => true);
    expect(win.skipShadow("CAFE\u0301", index)).toBe(true);
    expect(win.skipShadow("cafe\u0301/new.md", index)).toBe(true);
    expect(win.skipShadow("Team/new.md", index)).toBe(false);
    expect(win.skipShadow("Cafes", index)).toBe(false);
    expect(new UnmaterializablePaths(() => false).skipShadow("Caf\u00e9", index)).toBe(false);
    warn.mockRestore();
  });

  it("never blocks new work under a real server item that shares the stripped spelling", () => {
    const index = strippedServerIndex(["X.", "X"]);
    const win = new UnmaterializablePaths(() => true);
    expect(index.size).toBe(0);
    expect(win.skipShadow("X/new.md", index)).toBe(false);
  });
});
