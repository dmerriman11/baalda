// SPDX-License-Identifier: Apache-2.0
export const REMOTE_DASHBOARD_PREF = "context.dashboard.allowAnyHttps";
export function linkUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) throw new Error("Use an HTTPS link without a username or password.");
  if (value.length > 4096) throw new Error("The link is too long.");
  return url.href;
}
export function internetShortcut(value: string): string {
  return `[InternetShortcut]\nURL=${linkUrl(value)}\n`;
}
export function readDashboardLink(content: string, path: string): string {
  if (/\.webloc$/i.test(path)) {
    // Finder emits Apple's standard PUBLIC plist doctype. This reader does
    // not use an XML parser or resolve/fetch DTDs; only the literal URL string
    // and five built-in entities are decoded. Custom entities are unsupported.
    if (/<!ENTITY/i.test(content)) throw new Error("Custom XML entities are not supported.");
    const match = content.match(/<key>\s*URL\s*<\/key>\s*<string>([^<]*)<\/string>/i);
    if (!match) throw new Error("This .webloc file has no URL. Binary .webloc files are not supported.");
    const value = match[1].replace(/&(amp|quot|apos|lt|gt);/g, (_, entity: string) => ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" })[entity]!);
    return linkUrl(value);
  }
  let section = false;
  for (const line of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) section = /^\s*\[InternetShortcut\]\s*$/i.test(line);
    else if (section && /^\s*URL\s*=/i.test(line)) return linkUrl(line.slice(line.indexOf("=") + 1));
  }
  throw new Error("This shortcut has no InternetShortcut URL.");
}
export function remoteDashboardAllowed(value: string, allowAny: boolean): boolean {
  const url = new URL(linkUrl(value));
  if (allowAny) return true;
  return ["claude.ai", "claude.site", "chatgpt.com", "openai.com"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}
/** These app origins currently refuse cross-origin framing. Published sites may allow it. */
export function knownFrameBlocked(value: string): boolean {
  const host = new URL(value).hostname;
  return host === "claude.ai" || host.endsWith(".claude.ai") || host === "chatgpt.com" || host.endsWith(".chatgpt.com");
}
