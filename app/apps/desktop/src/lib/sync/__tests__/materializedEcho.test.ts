import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({}));

import { VaultRegistry } from "../registry";

const reg = () => new VaultRegistry({} as never);

describe("consumeMaterialized — echo under the OS's own spelling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("matches case and NFC variants, once", () => {
    const r = reg();
    r.markMaterialized("Team/Café/A.md");
    expect(r.consumeMaterialized("team/café/a.md")).toBe(true);
    expect(r.consumeMaterialized("Team/Café/A.md")).toBe(false);
  });

  it("matches a Windows-stripped trailing dot/space on Windows only", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    const r = reg();
    r.markMaterialized("Team/Drafts. ");
    expect(r.consumeMaterialized("Team/Drafts")).toBe(true);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" });
    const m = reg();
    m.markMaterialized("Team/Drafts.");
    expect(m.consumeMaterialized("Team/Drafts")).toBe(false);
  });
});
