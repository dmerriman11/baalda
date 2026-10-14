// Server paths a Windows disk cannot hold as spelled.
//
// Win32 silently strips a trailing dot or space from every name segment,
// refuses reserved device names (CON, AUX, NUL, PRN, COM1-9, LPT1-9, with or
// without an extension) and the characters < > : " | ? *, and without the
// long-path opt-in refuses anything past MAX_PATH (260). A server row with such
// a name either fails to materialize on every pull or lands under a STRIPPED
// name the watcher then reports as a folder nobody asked for. Either way the
// item cannot exist on this disk as the server spells it, so the inbound side
// skips it deterministically (once-per-session warning) instead of retrying.

const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"|?*\u0000-\u001f]/;

/**
 * Longest vault-relative path we materialize on Windows. MAX_PATH is 260
 * including the vault root (`C:\Users\<name>\Documents\Baalda Vaults\<vault>\`,
 * typically 40-60 chars) and the NUL; 200 leaves room for that root.
 */
export const WINDOWS_MAX_REL_PATH = 200;

export type WindowsPathProblem = "trailing-dot-or-space" | "reserved-name" | "forbidden-char" | "too-long";

/** Why `relPath` cannot exist on a Windows disk as spelled, or null if it can. */
export function windowsPathProblem(relPath: string): WindowsPathProblem | null {
  for (const seg of relPath.split("/")) {
    if (!seg) continue;
    if (/[. ]$/.test(seg)) return "trailing-dot-or-space";
    if (RESERVED.test(seg) || RESERVED.test(seg.replace(/[. ]+$/, ""))) return "reserved-name";
    if (FORBIDDEN.test(seg)) return "forbidden-char";
  }
  if (relPath.length > WINDOWS_MAX_REL_PATH) return "too-long";
  return null;
}

/** How Windows would spell `relPath` on disk: trailing dots/spaces stripped per segment. */
export function windowsStrip(relPath: string): string {
  return relPath
    .split("/")
    .map((s) => s.replace(/[. ]+$/, ""))
    .join("/");
}

/** True on a Windows host. Read from the user agent like `lib/platform.ts`. */
export function isWindowsHost(): boolean {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Windows/.test(ua);
}

/**
 * Session-scoped skip list: answers "skip this path on this OS?" and warns once
 * per path. `windows` is injectable for tests.
 */
export class UnmaterializablePaths {
  private warned = new Set<string>();
  constructor(private readonly windows: () => boolean = isWindowsHost) {}

  skip(relPath: string): boolean {
    if (!this.windows()) return false;
    const problem = windowsPathProblem(relPath);
    if (!problem) return false;
    if (!this.warned.has(relPath)) {
      this.warned.add(relPath);
      console.warn(`[sync] skipping "${relPath}": Windows cannot hold this name (${problem})`);
    }
    return true;
  }
}
