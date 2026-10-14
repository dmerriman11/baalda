import { describe, expect, it, vi } from "vitest";
import { UnmaterializablePaths, windowsPathProblem, windowsStrip } from "../windowsPaths";

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
