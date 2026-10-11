// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";
import { knownFrameBlocked, readDashboardLink, remoteDashboardAllowed, REMOTE_DASHBOARD_PREF } from "../lib/dashboard/links";
import "../styles/dashboard.css";

function allowsAny() { try { return localStorage.getItem(REMOTE_DASHBOARD_PREF) === "true"; } catch { return false; } }
export function RemoteDashboardSettings() {
  const [enabled, setEnabled] = useState(allowsAny);
  return <label className="dashboard-remote-setting"><input type="checkbox" checked={enabled} onChange={(event) => {
    const next = event.target.checked;
    localStorage.setItem(REMOTE_DASHBOARD_PREF, String(next)); setEnabled(next);
    window.dispatchEvent(new Event("baalda:dashboard-links-changed"));
  }} /> Allow any HTTPS dashboard link <small>Enable embedded views for your own hosted sites. Pages receive no vault data bridge.</small></label>;
}
export function RemoteDashboardView({ path }: { path: string }) {
  const epoch = useStore((s) => s.vault?.epoch);
  const [url, setUrl] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [allowAny, setAllowAny] = useState(allowsAny);
  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    setUrl(null); setError(null);
    const load = () => {
      const request = ++sequence;
      void ipc.readNote(path, epoch).then((content) => {
        if (!cancelled && request === sequence) { setUrl(readDashboardLink(content, path)); setError(null); }
      }).catch((e) => {
        if (!cancelled && request === sequence) { setUrl(null); setError(String(e)); }
      });
    };
    load(); let unlisten: (() => void) | undefined;
    void ipc.onFileChanged((event) => { if (event.path === path && event.kind === "modified" && !event.unchanged) load(); }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, [path, epoch]);
  useEffect(() => {
    const update = () => setAllowAny(allowsAny());
    window.addEventListener("baalda:dashboard-links-changed", update); window.addEventListener("storage", update);
    return () => { window.removeEventListener("baalda:dashboard-links-changed", update); window.removeEventListener("storage", update); };
  }, []);
  const allowed = url ? remoteDashboardAllowed(url, allowAny) : false;
  const blocked = url ? knownFrameBlocked(url) : false;
  return <div className="dashboard-link-view">
    <div className="html-toolbar dashboard-toolbar">
      <span className="dashboard-live-badge">Linked dashboard</span>
      <div className="dashboard-toolbar-actions">
        <button type="button" className="ghost-pill sm" onClick={() => window.dispatchEvent(new CustomEvent("baalda:set-home", { detail: { path, scope: "personal" } }))}>Set as my home</button>
        <button type="button" className="primary sm" disabled={!url} onClick={() => { if (url) void ipc.openExternal(url).catch((e) => setError(String(e))); }}>Open in browser</button>
      </div>
    </div>
    {error ? <div className="dashboard-link-empty" role="alert">{error}</div> : !url ? <div className="dashboard-link-empty">Loading…</div> : blocked || !allowed ? <div className="dashboard-link-empty">
      <h2>{blocked ? "Open this dashboard in your browser" : "This site needs your permission to embed"}</h2>
      <p>{blocked ? "This service prevents embedded views. The link still works as your Home or a pinned dashboard." : "Enable “Allow any HTTPS dashboard link” in Account Settings → About to embed your own hosted dashboard."}</p>
      <button type="button" className="primary" onClick={() => void ipc.openExternal(url).catch((e) => setError(String(e)))}>Open in browser</button>
    </div> : <>
      <p className="dashboard-link-help">If the site refuses to load here, use Open in browser.</p>
      <iframe key={url} title={path} src={url} referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'" />
    </>}
  </div>;
}
