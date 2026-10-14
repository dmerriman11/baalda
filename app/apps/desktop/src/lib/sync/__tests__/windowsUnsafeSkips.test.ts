// Windows-unsafe server paths are skipped, warned once, and never retried
// (commit 47636e2): a tree binary download and an inbound rename destination.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(),
  setVaultConfig: vi.fn(),
  listTree: vi.fn(),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(),
  writeNote: vi.fn(),
  writeNoteIfMissing: vi.fn(),
  readNote: vi.fn(),
  ensureFolder: vi.fn(),
  renamePath: vi.fn(),
  trashNote: vi.fn(),
  deletePath: vi.fn(),
  deleteFile: vi.fn(),
  deleteFilesBatch: vi.fn(),
  deleteFolderIfEmpty: vi.fn(),
  fileStat: vi.fn(),
  binaryExists: vi.fn(),
  getDiskBase: vi.fn(),
  copyToTrash: vi.fn(),
  writeTrashCopy: vi.fn(),
  rebindNoteId: vi.fn(async () => true),
  isVaultMismatch: vi.fn(() => false),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { AttachmentSync, type AttachmentSyncDeps } from "../attachments";
import { VaultRegistry, type InboundHost } from "../registry";
import { sha256Hex } from "../../bridge/adapter";
import { UnmaterializablePaths } from "../windowsPaths";

const ORG = "org-1";
const VAULT = "vault-1";

let warn: { mock: { calls: unknown[][] }; mockRestore(): void };
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {}) as unknown as typeof warn;
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null as never);
  vi.mocked(ipc.setVaultConfig).mockResolvedValue(undefined as never);
  vi.mocked(ipc.isVaultMismatch).mockReturnValue(false);
});
afterEach(() => warn.mockRestore());

function warnedAbout(path: string) {
  return warn.mock.calls.filter((c) => c.some((a) => typeof a === "string" && a.includes(path)));
}

// ---------------------------------------------------------------- attachments

function makeAttachments(serverPaths: string[]) {
  const downloaded: string[] = [];
  const written: string[] = [];
  const blobs = serverPaths.map((relPath, i) => ({
    id: `blob-${i}`,
    sha256: `sha-${relPath}`,
    relPath,
    docId: `file-${i}`,
  }));
  const deps = {
    listLocal: async () => [],
    readLocal: async () => new Uint8Array([1]),
    writeLocal: async () => {},
    writeTreeLocal: async (relPath: string) => {
      written.push(relPath);
    },
    markMaterialized: () => {},
    listServer: async () => blobs,
    uploadServer: async () => {},
    downloadServer: async (id: string) => {
      downloaded.push(blobs.find((b) => b.id === id)?.relPath ?? id);
      return new Uint8Array([9]);
    },
    createIntent: async () => {
      throw new Error("no uploads expected");
    },
    completeUpload: async () => {},
    putFile: async () => ({ status: 204, etag: null }),
    localFileIds: async () => new Map(),
    knownFileId: () => null,
    registerFile: async ({ id }: { id: string }) => id,
    rememberFileId: () => {},
    confirmFileBytes: () => {},
    fileText: async () => ({ sha256: "x", status: "ok", chars: 0, text: "" }),
    uploadText: async () => {},
  } as unknown as AttachmentSyncDeps;
  const sync = new AttachmentSync(
    deps,
    400,
    (() => 0) as unknown as typeof setTimeout,
    (() => {}) as unknown as typeof clearTimeout,
  );
  return { sync, downloaded, written };
}

const BAD_BIN = "Team/Drafts./pic.png";
const GOOD_BIN = "Team/Drafts/ok.png";

describe("AttachmentSync skips Windows-unsafe tree binaries", () => {
  it("never downloads the unsafe one on Windows, warns once across two passes, still fetches the safe one", async () => {
    const { sync, downloaded, written } = makeAttachments([BAD_BIN, GOOD_BIN]);
    sync.unmaterializable = new UnmaterializablePaths(() => true);

    await sync.reconcile();
    await sync.reconcile();

    expect(downloaded).not.toContain(BAD_BIN);
    expect(written).not.toContain(BAD_BIN);
    expect(downloaded).toContain(GOOD_BIN);
    expect(warnedAbout(BAD_BIN)).toHaveLength(1);
    expect(warnedAbout(GOOD_BIN)).toHaveLength(0);
  });

  it("downloads the same path on macOS, with no warning", async () => {
    const { sync, downloaded } = makeAttachments([BAD_BIN, GOOD_BIN]);
    sync.unmaterializable = new UnmaterializablePaths(() => false);

    await sync.reconcile();

    expect(downloaded).toContain(BAD_BIN);
    expect(downloaded).toContain(GOOD_BIN);
    expect(warnedAbout(BAD_BIN)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------- registry

class FakeDisk {
  /** relPath → docId, for the notes the local index knows. */
  notes = new Map<string, string>();
  folders = new Set<string>();
  /** relPath → body, for the emptiness check on unconfirmed notes. */
  bodies = new Map<string, string>();
  trashed: Array<{ from: string; to: string }> = [];
  /** Paths removed outright (revocations) — never in the trash. */
  deleted: string[] = [];
  /** Tree binaries on disk (a `.pdf`, a `.docx`). NOT notes: they have no index
   *  row, no CRDT and no `GET /api/notes` entry — their only identity here is
   *  the registry's `files` map. */
  binaries = new Set<string>();
  /** docIds whose file moved on since the last agreed disk base: UNSEEN WORK
   *  (offline reconciliation). Everything else is in sync with its base. */
  unseen = new Set<string>();
  /** Recovery copies made before an inbound removal. */
  copies: Array<{ from: string; to: string }> = [];

  tree(): TreeNode {
    const dirs = [...this.folders].map((f) => ({
      id: f,
      name: f,
      path: f,
      isDir: true,
      children: [],
      childrenLoaded: true,
    }));
    const files = [...this.notes.keys()].map((p) => ({
      id: p,
      name: p,
      path: p,
      isDir: false,
    }));
    return {
      id: "root",
      name: "vault",
      path: "",
      isDir: true,
      childrenLoaded: true,
      children: [...dirs, ...files],
    };
  }

  titles() {
    return [...this.notes].map(([path, id]) => ({ path, id, title: null }));
  }
}

function install(disk: FakeDisk) {
  vi.mocked(ipc.binaryExists).mockImplementation(async (path) => disk.binaries.has(path));
  vi.mocked(ipc.deleteFilesBatch).mockImplementation(async (items) => Promise.all(items.map(async (item) => {
    try {
      await ipc.deleteFile(item.path);
      return { path: item.path, error: null };
    } catch (e) {
      return { path: item.path, error: String(e) };
    }
  })));

  vi.mocked(ipc.listTree).mockImplementation((async () => disk.tree()) as never);
  vi.mocked(ipc.listNoteTitles).mockImplementation((async () => disk.titles()) as never);
  vi.mocked(ipc.readNote).mockImplementation((async (p: string) =>
    disk.bodies.get(p) ?? "") as never);
  vi.mocked(ipc.ensureFolder).mockImplementation((async (p: string) => {
    if (disk.folders.has(p)) return false; // already there — not a disk change
    disk.folders.add(p);
    return true;
  }) as never);
  vi.mocked(ipc.writeNoteIfMissing).mockImplementation((async (p: string) => {
    if (disk.notes.has(p)) return false;
    disk.notes.set(p, `local-${p}`);
    return true;
  }) as never);
  vi.mocked(ipc.renamePath).mockImplementation((async (from: string, to: string) => {
    const docId = disk.notes.get(from);
    if (docId === undefined) throw new Error("source path does not exist");
    if (disk.notes.has(to)) throw new Error("destination already exists");
    disk.notes.delete(from);
    disk.notes.set(to, docId);
    const body = disk.bodies.get(from);
    if (body !== undefined) {
      disk.bodies.delete(from);
      disk.bodies.set(to, body);
    }
    return to;
  }) as never);
  vi.mocked(ipc.deleteFolderIfEmpty).mockImplementation((async (p: string) => {
    if (!disk.folders.has(p)) return false; // already gone — nothing removed
    const prefix = p + "/";
    const occupied =
      [...disk.notes.keys()].some((n) => n.startsWith(prefix)) ||
      [...disk.folders].some((f) => f.startsWith(prefix));
    if (occupied) return false;
    disk.folders.delete(p);
    return true;
  }) as never);
  vi.mocked(ipc.deletePath).mockImplementation((async (p: string) => {
    if (!disk.notes.has(p)) throw new Error("path does not exist");
    disk.notes.delete(p);
    disk.bodies.delete(p);
    disk.deleted.push(p);
  }) as never);
  // The revocation removal's own call: single file, never a directory (Rust
  // refuses one). Same book-keeping so the assertions below read the same.
  // Matches `notefile.rs delete_file`, which returns Ok for a path that is
  // already gone. A mock that threw instead would make the reconciler look
  // broken on the one case Rust deliberately makes idempotent.
  vi.mocked(ipc.deleteFile).mockImplementation((async (p: string) => {
    if (disk.binaries.delete(p)) {
      disk.deleted.push(p);
      return;
    }
    if (!disk.notes.has(p)) return;
    disk.notes.delete(p);
    disk.bodies.delete(p);
    disk.deleted.push(p);
  }) as never);
  vi.mocked(ipc.fileStat).mockImplementation((async (p: string) => {
    if (!disk.notes.has(p) && !disk.binaries.has(p)) throw new Error("no such file");
    return { size: 1 };
  }) as never);
  vi.mocked(ipc.getDiskBase).mockImplementation((async (docId: string) => {
    if (disk.unseen.has(docId)) return "base-before-the-offline-edit";
    const path = [...disk.notes].find(([, id]) => id === docId)?.[0];
    return path === undefined ? null : sha256Hex(disk.bodies.get(path) ?? "");
  }) as never);
  vi.mocked(ipc.copyToTrash).mockImplementation((async (p: string, stamp: string) => {
    if (!disk.notes.has(p) && !disk.binaries.has(p)) throw new Error("path does not exist");
    const dest = `.context/trash/${stamp}/${p}`;
    disk.copies.push({ from: p, to: dest });
    return dest;
  }) as never);
  vi.mocked(ipc.trashNote).mockImplementation((async (p: string, stamp: string) => {
    // `trash_note` is a rename, so it moves any bytes — a binary needs no twin.
    const isBinary = disk.binaries.delete(p);
    if (!isBinary) {
      if (!disk.notes.has(p)) throw new Error("path does not exist");
      disk.notes.delete(p);
      disk.bodies.delete(p);
    }
    const dest = `.context/trash/${stamp}/${p}`;
    disk.trashed.push({ from: p, to: dest });
    return dest;
  }) as never);
}


function fakeApi(state: { notes: Array<{ id: string; rel_path: string }> }) {
  const list = async () => ({ notes: state.notes, tombstones: [] });
  return {
    listVaults: vi.fn(async () => [{ id: VAULT, name: "v", organization_id: ORG }]),
    createVault: vi.fn(),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    createFolder: vi.fn(async (i: { path: string }) => ({ id: `folder-${i.path}`, path: i.path })),
    listNotes: vi.fn(async () => state.notes),
    listNoteRegistry: vi.fn(list),
    listNoteRegistryPaged: vi.fn(list),
    createNote: vi.fn(async (i: { relPath: string; docId?: string }) => ({
      id: i.docId ?? `note-${i.relPath}`,
      rel_path: i.relPath,
    })),
  } as unknown as ApiClient;
}

function host(): InboundHost {
  return {
    releaseDoc: async () => {},
    notePathChanged: () => {},
    noteRemoved: () => {},
    materializeContent: async () => false,
    revocationAuthority: () => false,
    authoritativeRevoked: () => null,
    revocationRefused: () => {},
    localUserId: () => "user-me",
    suppressBinaryDelete: () => {},
    fileRemoved: () => {},
  } as InboundHost;
}

/** Baseline pass at `from`, relaunch, then two pulls with the server at `to`. */
async function movedOnServer(from: string, to: string, windows: boolean) {
  const disk = new FakeDisk();
  disk.notes.set(from, "d1");
  install(disk);
  const state = { notes: [{ id: "d1", rel_path: from }] };
  const reg1 = new VaultRegistry(fakeApi(state));
  reg1.setInboundHost(host());
  await reg1.reconcile({ organizationId: ORG, vaultName: "v" });
  const writes = vi.mocked(ipc.setVaultConfig).mock.calls;
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(writes[writes.length - 1]?.[0] as never);
  vi.mocked(ipc.renamePath).mockClear();

  state.notes = [{ id: "d1", rel_path: to }];
  const reg = new VaultRegistry(fakeApi(state));
  reg.unmaterializable = new UnmaterializablePaths(() => windows);
  reg.setInboundHost(host());
  await reg.reconcile({ organizationId: ORG, vaultName: "v" });
  await reg.reconcile({ organizationId: ORG, vaultName: "v" });
  return { disk };
}

describe("VaultRegistry skips renames to Windows-unsafe destinations", () => {
  for (const to of ["Team/Bad./a.md", "Team/a?.md"]) {
    it(`keeps the old path on Windows for ${to}, warning once over two pulls`, async () => {
      const { disk } = await movedOnServer("Team/a.md", to, true);

      expect(ipc.renamePath).not.toHaveBeenCalled();
      expect(disk.notes.has("Team/a.md")).toBe(true);
      expect(disk.notes.has(to)).toBe(false);
      expect(warnedAbout(to)).toHaveLength(1);
    });
  }

  it("performs the rename on macOS", async () => {
    const { disk } = await movedOnServer("Team/a.md", "Team/Bad./a.md", false);

    expect(ipc.renamePath).toHaveBeenCalledWith("Team/a.md", "Team/Bad./a.md", null);
    expect(disk.notes.has("Team/Bad./a.md")).toBe(true);
    expect(disk.notes.has("Team/a.md")).toBe(false);
    expect(warnedAbout("Team/Bad./a.md")).toHaveLength(0);
  });
});

describe("VaultRegistry never registers this disk's spelling of a stripped server name", () => {
  async function leftover(windows: boolean) {
    const disk = new FakeDisk();
    disk.folders.add("Team");
    disk.folders.add("Team/X");
    disk.notes.set("Team/X/a.md", "local-a");
    install(disk);
    const api = fakeApi({ notes: [] });
    vi.mocked(api.listFolderRegistry).mockResolvedValue({
      folders: [
        { id: "f-team", path: "Team", name: "Team", parent_id: null },
        { id: "f-xdot", path: "Team/X.", name: "X.", parent_id: "f-team" },
      ],
      tombstones: [],
    } as never);
    const reg = new VaultRegistry(api);
    reg.unmaterializable = new UnmaterializablePaths(() => windows);
    reg.setInboundHost(host());
    await reg.reconcile({ organizationId: ORG, vaultName: "v" });
    await reg.reconcile({ organizationId: ORG, vaultName: "v" });
    const folderPaths = vi.mocked(api.createFolder).mock.calls.map((c) => (c[0] as { path: string }).path);
    const notePaths = vi.mocked(api.createNote).mock.calls.map((c) => (c[0] as { relPath: string }).relPath);
    return { folderPaths, notePaths };
  }

  it("on Windows skips local Team/X and Team/X/a.md beside server Team/X., warning once each", async () => {
    const { folderPaths, notePaths } = await leftover(true);
    expect(folderPaths).not.toContain("Team/X");
    expect(notePaths).not.toContain("Team/X/a.md");
    expect(warnedAbout('not registering "Team/X"')).toHaveLength(1);
    expect(warnedAbout('not registering "Team/X/a.md"')).toHaveLength(1);
  });

  it("on macOS registers them as before", async () => {
    const { folderPaths, notePaths } = await leftover(false);
    expect(folderPaths).toContain("Team/X");
    expect(notePaths).toContain("Team/X/a.md");
  });
});
