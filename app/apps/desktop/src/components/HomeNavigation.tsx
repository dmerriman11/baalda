// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useStore } from "../store";
import { requestNewDashboard as dispatchNewDashboard } from "../lib/homeEvents";
import { mergePins, visiblePinnedItems, pinKey, resolveHome, isDashboard } from "../lib/pins";
import { displayName } from "../lib/notePath";
import { nodeAt } from "../lib/tree/lazyTree";
import { itemColorValue, itemColorFill, automaticTreeColors } from "../lib/appearance";
import { applyOrder } from "../lib/ordering";
import { sortTree } from "../lib/tree/sort";
import { effectiveLockForPath, lockScopesByPath, LOCK_TITLES } from "../lib/locks";
import { iconForPath, SidebarPresence } from "./FileTree";
import { toast } from "../lib/toast";
import "./HomeNavigation.css";

export function requestNewDashboard(kind?: "link") {
  useStore.setState({ homePickerOpen: false });
  dispatchNewDashboard(kind);
}
const onError = (e: unknown) => toast(e instanceof Error ? e.message : String(e), "error");

export function PinnedSection() {
  const st = useStore();
  const orgId = st.syncEnabled ? st.session?.activeOrganizationId : null;
  const shared = orgId ? st.vaultAppearance[orgId]?.pinnedItems ?? [] : [];
  const pins = mergePins(shared, st.personalPins);
  const pinSignature = JSON.stringify(pins);
  useEffect(() => {
    const epoch = st.vault?.epoch;
    if (!st.tree || epoch === undefined) return;
    void (async () => {
      // Only load ancestors of pinned folders; a lazy tree is not evidence that
      // the pin disappeared. Preferences are never pruned by incomplete lists.
      for (const { item } of pins) {
        const path = item.kind === "folder" ? item.path : st.titles.find((note) => note.id === item.docId)?.path;
        if (!path) continue;
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) {
          if (useStore.getState().vault?.epoch !== epoch) return;
          const ancestor = parts.slice(0, i).join("/");
          const currentTree = useStore.getState().tree;
          if (currentTree && nodeAt(currentTree, ancestor)?.childrenLoaded) continue;
          await useStore.getState().loadChildren(ancestor).catch(() => {});
        }
      }
    })();
  }, [st.vault?.epoch, st.tree?.path, pinSignature, st.titles]);
  const automatic = useMemo(() => st.automaticItemColors
    ? automaticTreeColors(st.session?.user.id ?? "local", st.session?.activeOrganizationId ?? st.vault?.path ?? "vault", applyOrder(sortTree(st.tree?.children ?? [], st.treeSort, st.folderSorts), "", st.itemOrder), st.docIdByPath, st.itemColors)
    : {}, [st.automaticItemColors, st.session?.user.id, st.session?.activeOrganizationId, st.vault?.path, st.tree, st.treeSort, st.folderSorts, st.itemOrder, st.docIdByPath, st.itemColors]);
  const locks = lockScopesByPath(st.tree, st.locks, st.session?.user.id, st.lifts);
  const rows = visiblePinnedItems(shared, st.personalPins, st.titles, (path) => Boolean(st.tree && nodeAt(st.tree, path)));
  if (!rows.length) return null;
  return <section className="pinned-section" aria-label="Pinned notes and folders">
    <div className="pinned-label">Pinned</div>
    {rows.map(({ item, shared, path }) => {
      const color = st.itemColors[path] ?? automatic[path];
      const lock = st.syncEnabled ? effectiveLockForPath(locks, path) : null;
      const peers = st.vaultPresence.filter((peer) => peer.docId && (item.kind === "note" ? peer.docId === item.docId : st.titles.some((t) => t.id === peer.docId && t.path.startsWith(path + "/"))));
      return <div key={pinKey(item)} className={`tree-row pinned-row${item.kind === "folder" ? " is-dir" : ""}${st.openNote?.path === path ? " selected" : ""}`}>
        <button className="pinned-open" title={path} onClick={() => item.kind === "folder"
          ? useStore.setState({ revealRequest: { path, edit: false, token: (st.revealRequest?.token ?? 0) + 1 } })
          : void st.openNoteByPath(path).catch(onError)}>
          <span className={`tree-glyph${itemColorValue(color) ? " colored" : ""}`} style={{ color: itemColorValue(color), "--glyph-fill": itemColorFill(color) } as CSSProperties} aria-hidden="true">
            {item.kind === "folder" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 7h6l2-3h10v16H3z" /></svg> : iconForPath(path)}
          </span>
          <span className="pinned-name">{displayName(path.split("/").pop() ?? path, item.kind === "folder")}</span>
          <SidebarPresence peers={peers} />
          {lock && <span className="pinned-lock" title={LOCK_TITLES[lock]} aria-label={LOCK_TITLES[lock]}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg></span>}
          {shared && <span className="pinned-shared" title="Pinned for everyone by a vault admin">Everyone</span>}
        </button>
        {!shared && <button className="pinned-remove" aria-label={`Unpin ${path}`} title="Unpin" onClick={() => void st.togglePin(path, item.kind === "folder").catch(onError)}>×</button>}
      </div>;
    })}
  </section>;
}

export function HomeButton() {
  const [hint, setHint] = useState(() => { try { return localStorage.getItem("context.home.hintShown") !== "1"; } catch { return false; } });
  const seen = () => { setHint(false); try { localStorage.setItem("context.home.hintShown", "1"); } catch { /* unavailable */ } };
  return <div className="home-tools">
    <button className="titlebar-tool home-button" title={`${document.documentElement.dataset.platform === "windows" ? "Home (Ctrl+Shift+H)" : "Home (⌘⇧H)"} · Right-click to choose a dashboard`} aria-label="Home"
      onClick={() => { seen(); void useStore.getState().openHome().catch(onError); }}
      onContextMenu={(event) => { event.preventDefault(); seen(); useStore.setState({ homePickerOpen: true }); }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault(); seen(); useStore.setState({ homePickerOpen: true });
        }
      }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m3 10 9-7 9 7v11h-6v-7H9v7H3z" /></svg>
      {hint && <span className="home-hint" />}
    </button>
  </div>;
}

export function HomePicker() {
  const st = useStore();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!st.homePickerOpen) return;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") useStore.setState({ homePickerOpen: false }); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [st.homePickerOpen]);
  if (!st.homePickerOpen) return null;
  const orgId = st.syncEnabled ? st.session?.activeOrganizationId : null;
  const appearance = orgId ? st.vaultAppearance[orgId] : undefined;
  const home = resolveHome(st.personalHomeDocId, appearance?.homeDocId);
  const pinned = new Set(mergePins(appearance?.pinnedItems ?? [], st.personalPins).flatMap(({ item }) => item.kind === "note" ? [item.docId] : []));
  const dashboards = st.titles.filter((t) => isDashboard(t.path)).sort((a, b) => Number(b.id === home) - Number(a.id === home) || Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || a.path.localeCompare(b.path));
  const homeNote = st.titles.find((t) => t.id === home);
  const canManage = st.members.some((m) => m.userId === st.session?.user.id && (m.role === "owner" || m.role === "admin"));
  const list = homeNote && !isDashboard(homeNote.path) ? [homeNote, ...dashboards] : dashboards;
  return <div className="home-picker-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) useStore.setState({ homePickerOpen: false }); }}>
    <div className="home-picker" ref={panel} role="dialog" aria-modal="true" aria-labelledby="home-picker-title" onKeyDown={(event) => {
      event.stopPropagation();
      if ((event.metaKey || event.ctrlKey) && ["n", "w", "h", "r", "g", "f", "k", "p", "s"].includes(event.key.toLowerCase())) event.preventDefault();
      if (event.key === "Escape") useStore.setState({ homePickerOpen: false });
      if (event.key === "Tab") {
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="home-picker-header"><h2 id="home-picker-title">Home & dashboards</h2><button aria-label="Close" onClick={() => useStore.setState({ homePickerOpen: false })}>×</button></div>
      {!homeNote && <p>Choose a note as your Home, or create a dashboard your agent can update from your vault.</p>}
      <div className="home-picker-list">{list.map((note) => <div className="home-picker-row" key={note.id}>
        <button className="home-picker-open" title={note.path} onClick={() => { useStore.setState({ homePickerOpen: false }); void st.openNoteByPath(note.path).catch(onError); }}><span>{iconForPath(note.path)}</span><span>{displayName(note.path.split("/").pop() ?? note.path, false)}<small>{note.id === home ? "Home" : note.path}</small></span></button>
        <button title="Set as my home" aria-label={`Set ${note.path} as my home`} onClick={() => void st.setHome(note.path).catch(onError)}>My home</button>
        {canManage && orgId && <button title="Set as vault home for everyone" onClick={() => void st.setHome(note.path, "vault").catch(onError)}>Vault home</button>}
      </div>)}</div>
      {list.length === 0 && <p className="home-picker-empty">Dashboards are HTML files in your vault. Start with a template, add a link, or ask your agent to create one.</p>}
      <div className="home-picker-actions"><button onClick={() => requestNewDashboard()}>New dashboard…</button><button onClick={() => requestNewDashboard("link")}>Add dashboard link…</button></div>
      {st.openNote && <button className="home-picker-current" onClick={() => void st.setHome(st.openNote!.path).catch(onError)}>Use the current note as my home</button>}
      {st.personalHomeDocId && <button className="home-picker-current" onClick={() => void st.setHome(null).catch(onError)}>Use vault home instead</button>}
      <p className="home-picker-help">Ask Claude or Codex to edit the file in your vault, or connect an agent through MCP. The dashboard stays a normal, shareable file.</p>
    </div>
  </div>;
}
