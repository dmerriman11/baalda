// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";
import { effectiveLockForPath, lockScopesByPath } from "../lib/locks";
import { createDashboardBridge, dashboardUrl, DASHBOARD_PROTOCOL } from "../lib/dashboard/bridge";
import { dashboardHost, pushDashboardTheme } from "../lib/dashboard/host";
import { copyDashboardPrompt } from "../lib/dashboard/templates";
import { DashboardAgentRunner } from "./DashboardAgentRunner";
import { invoke } from "@tauri-apps/api/core";
import "../styles/dashboard.css";

function snapshotFrame(frame: HTMLIFrameElement | null): Promise<void> {
  const source = frame?.contentWindow;
  if (!source) return Promise.resolve();
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const done = () => { clearTimeout(timer); window.removeEventListener("message", acknowledge); resolve(); };
    const acknowledge = (event: MessageEvent) => {
      if (event.source === source && event.origin === "null" && event.data?.channel === DASHBOARD_PROTOCOL && event.data.event === "snapshotAck" && event.data.id === id) done();
    };
    // A page without the optional SDK has no host-backed state to capture.
    const timer = setTimeout(done, 250);
    window.addEventListener("message", acknowledge);
    source.postMessage({ channel: DASHBOARD_PROTOCOL, event: "beforeReload", id }, "*");
  });
}

/** HTML is a synced note. Its scripts run in a separate opaque-origin frame. */
export function HtmlView({ path }: { path: string }) {
  const vault = useStore((s) => s.vault);
  const titles = useStore((s) => s.titles);
  const locks = useStore((s) => s.locks);
  const tree = useStore((s) => s.tree);
  const lifts = useStore((s) => s.lifts);
  const userId = useStore((s) => s.session?.user.id);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const state = useStore((s) => s.docSyncState);
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [lease, setLease] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const docId = titles.find((note) => note.path === path)?.id;
  const epoch = vault?.epoch;
  const readOnly = Boolean(effectiveLockForPath(lockScopesByPath(tree, locks, userId, lifts), path)) || ["read-only", "no-access", "deleted"].includes(String(docId ? state[docId] : ""));
  useEffect(() => {
    setLease(null);
    if (epoch == null || mode !== "preview") return;
    if (import.meta.env.MODE === "simulator") { setLease("synthetic-preview"); return; }
    let cancelled = false, granted: string | null = null;
    const release = (value: string) => { void invoke("dashboard_unmount_view", { lease: value, epoch }).catch(() => {}); };
    void invoke<string>("dashboard_mount_view", { path, epoch }).then((value) => {
      if (cancelled) release(value);
      else { granted = value; setLease(value); }
    }).catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; if (granted) release(granted); };
  }, [path, epoch, mode]);
  useEffect(() => {
    let cancelled = false;
    let loadNumber = 0;
    setMode("preview"); setDirty(false); setContent(null); setError(null);
    const load = async (changed = false) => {
      const thisLoad = ++loadNumber;
      try {
        const value = await ipc.readNote(path, epoch);
        if (cancelled || thisLoad !== loadNumber || changed && dirtyRef.current) return;
        if (changed) await snapshotFrame(frame.current);
        if (cancelled || thisLoad !== loadNumber || changed && dirtyRef.current) return;
        setContent(value); setDraft(value); setRevision((old) => old + 1);
      } catch (e) { if (!cancelled) setError(String(e)); }
    };
    void load();
    let unlisten: (() => void) | undefined;
    void ipc.onFileChanged((event) => {
      if (event.path === path && event.kind === "modified" && !event.unchanged && !dirtyRef.current) void load(true);
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, [path, epoch]);
  useEffect(() => {
    if (!docId || epoch == null || mode !== "preview") return;
    const bridge = createDashboardBridge({
      source: () => frame.current?.contentWindow,
      current: () => useStore.getState().vault?.epoch === epoch && useStore.getState().openNote?.path === path,
      methods: dashboardHost(epoch, docId, () => host.current?.focus()),
      reply: (message) => frame.current?.contentWindow?.postMessage(message, "*"),
    });
    const message = (event: MessageEvent) => { void bridge.handle(event); };
    window.addEventListener("message", message);
    const observer = new MutationObserver(() => { if (frame.current) pushDashboardTheme(frame.current); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => { bridge.dispose(); observer.disconnect(); window.removeEventListener("message", message); };
  }, [docId, epoch, mode, path, revision, syncEnabled, userId]);
  const save = async () => {
    if (readOnly || epoch == null) return;
    try {
      await ipc.writeNote(path, draft, epoch);
      if (useStore.getState().vault?.epoch !== epoch) return;
      setContent(draft); setDirty(false); setError(null); setRevision((old) => old + 1);
    } catch (e) { setError(String(e)); }
  };
  if (!vault) return null;
  const url = dashboardUrl(path, vault.epoch, document.documentElement.dataset.platform ?? "other");
  return (
    <div className="html-view dashboard-view" ref={host} tabIndex={-1}>
      <div className="html-toolbar dashboard-toolbar">
        <div className="segmented html-tabs">
          <button type="button" className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>Preview</button>
          <button type="button" className={mode === "source" ? "active" : ""} onClick={() => setMode("source")}>Source{dirty ? " •" : ""}</button>
        </div>
        <span className="dashboard-live-badge" title="Scripts run in an isolated frame">Scripts run</span>
        <div className="dashboard-toolbar-actions">
          <button type="button" className="ghost-pill sm" onClick={() => window.dispatchEvent(new CustomEvent("baalda:set-home", { detail: { path, scope: "personal" } }))}>Set as my home</button>
          <button type="button" className="ghost-pill sm" onClick={() => void copyDashboardPrompt(path, vault.path).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch((e) => setError(String(e)))}>{copied ? "Prompt copied" : "Ask AI to change this"}</button>
          {mode === "source" && <button type="button" className="primary sm" disabled={!dirty || readOnly} onClick={() => void save()}>{readOnly ? "View only" : dirty ? "Save" : "Saved"}</button>}
          {!readOnly && <DashboardAgentRunner path={path} expectedEpoch={vault.epoch} />}
        </div>
      </div>
      {error && <div className="dashboard-error" role="alert">{error}</div>}
      {mode === "preview" ? content === null || lease === null ? <div className="editor-empty">{error ? "Couldn’t load this dashboard." : "Loading…"}</div> : (
        <iframe ref={frame} key={`${path}:${epoch}:${revision}`} className="html-frame" title={path}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          src={import.meta.env.MODE === "simulator" ? undefined : `${url}?lease=${encodeURIComponent(lease)}&revision=${revision}`}
          srcDoc={import.meta.env.MODE === "simulator" ? content : undefined}
          onLoad={() => { if (frame.current) pushDashboardTheme(frame.current); }} />
      ) : <textarea className="html-source" value={draft} readOnly={readOnly} spellCheck={false}
        onChange={(event) => { setDraft(event.target.value); setDirty(event.target.value !== content); }}
        onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } }} />}
    </div>
  );
}
