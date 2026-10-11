// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { internetShortcut, knownFrameBlocked, readDashboardLink, remoteDashboardAllowed } from "../links";
describe("portable linked dashboards", () => {
  it("reads Windows shortcuts and text Apple weblocs", () => {
    expect(readDashboardLink(internetShortcut("https://example.com/x"), "Home.url")).toBe("https://example.com/x");
    expect(readDashboardLink('<plist><dict><key>URL</key><string>https://example.com/?a=1&amp;b=2</string></dict></plist>', "Home.webloc")).toBe("https://example.com/?a=1&b=2");
  });
  it("accepts Finder's standard plist doctype without resolving a DTD", () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>URL</key><string>https://example.com/dashboard?a=1&amp;b=2</string></dict></plist>`;
    expect(readDashboardLink(plist, "Finder.webloc")).toBe("https://example.com/dashboard?a=1&b=2");
    expect(() => readDashboardLink('<!ENTITY secret SYSTEM "file:///etc/passwd"><key>URL</key><string>https://example.com/&secret;</string>', "Unsafe.webloc")).toThrow("entities");
  });
  it("refuses executable URLs and allowlist lookalikes", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "http://example.com", "https://user:pass@example.com"]) expect(() => internetShortcut(url)).toThrow();
    expect(remoteDashboardAllowed("https://claude.ai.evil.com", false)).toBe(false);
    expect(remoteDashboardAllowed("https://demo.claude.site", false)).toBe(true);
    expect(remoteDashboardAllowed("https://example.com", true)).toBe(true);
    expect(knownFrameBlocked("https://claude.ai/artifact/abc")).toBe(true);
  });
});
