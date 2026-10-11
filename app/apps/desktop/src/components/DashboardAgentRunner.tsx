// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  appendAgentLog, cancelDashboardAgent, detectInstalledAgents, runDashboardAgent,
  type InstalledAgent,
} from "../lib/dashboard/agent";
import "./DashboardAgentRunner.css";

function useInstalledAgents() {
  const [agents, setAgents] = useState<InstalledAgent[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    void detectInstalledAgents().then((value) => { if (alive) setAgents(value); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);
  return { agents, error };
}

/** Trusted app chrome only: never expose this component through the page bridge. */
export function DashboardAgentRunner({ path, expectedEpoch }: { path: string; expectedEpoch: number }) {
  const { agents } = useInstalledAgents();
  const codex = agents?.find((a) => a.agent === "codex");
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [log, setLog] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const runId = useRef<string | null>(null);
  const alive = useRef(true);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const launchButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const output = useRef<HTMLPreElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (runId.current) void cancelDashboardAgent(runId.current).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (runId.current) void cancelDashboardAgent(runId.current).catch(() => {});
    setOpen(false); setPrompt(""); setLog(""); setStatus("");
  }, [path, expectedEpoch]);
  useEffect(() => { if (open) (promptInput.current ?? dialog.current)?.focus(); }, [open]);
  useEffect(() => { if (output.current) output.current.scrollTop = output.current.scrollHeight; }, [log]);

  const close = () => {
    if (running) return;
    setOpen(false); setLog(""); setStatus(""); launchButton.current?.focus();
  };
  const stop = async () => {
    if (!runId.current) return;
    setStatus("Stopping Codex…");
    try { await cancelDashboardAgent(runId.current); }
    catch { setStatus("Could not request cancellation. The run will stop after its time limit."); }
  };
  const start = async () => {
    if (!codex?.runnable || running || !prompt.trim()) return;
    const id = crypto.randomUUID(); runId.current = id;
    setRunning(true); setLog(""); setStatus("Starting Codex…");
    try {
      await runDashboardAgent({ agent: "codex", prompt, dashboardPath: path, expectedEpoch, runId: id }, (event) => {
        if (!alive.current || runId.current !== id) {
          if (event.type === "started") void cancelDashboardAgent(id).catch(() => {});
          return;
        }
        if (event.type === "text" || event.type === "status") setLog((previous) => appendAgentLog(previous, event.text));
        if (event.type === "started") setStatus("Codex is working in this vault…");
        if (event.type === "finished") setStatus(event.cancelled ? "Stopped. Changes already written remain in the vault." : event.success ? "Finished. Your dashboard reloads as files change." : "Codex could not finish. Check its sign-in and account limits in your terminal.");
      });
    } catch (error) {
      if (alive.current && runId.current === id) setStatus(String(error));
    } finally {
      if (alive.current && runId.current === id) { setRunning(false); runId.current = null; }
    }
  };

  if (!codex) return null;
  return <>
    <button ref={launchButton} type="button" className="ghost-pill sm dashboard-agent-launch" onClick={() => setOpen(true)}>
      Update with Codex
    </button>
    {open && createPortal(
      <div className="dashboard-agent-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
        <div ref={dialog} role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="dashboard-agent-title" className="dashboard-agent-dialog"
          onKeyDownCapture={(event) => {
            if ((event.metaKey || event.ctrlKey) && ["n", "w", "f", "k", "p", "g", "h"].includes(event.key.toLowerCase())) {
              event.preventDefault(); event.stopPropagation();
            }
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
            if (event.key === "Tab") {
              const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled), a[href]") ?? []);
              const first = controls[0]; const last = controls[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
          }}>
          <div className="dashboard-agent-heading">
            <h2 id="dashboard-agent-title">Update with Codex</h2>
            <button type="button" className="icon-btn" disabled={running} onClick={close} aria-label="Close agent dialog">×</button>
          </div>
          <p className="dashboard-agent-description">Codex can edit files in this vault using your installed CLI and its account. Changes sync as they are written.</p>
          <div className="dashboard-agent-path" title={path}>{path}</div>
          {!codex.runnable ? <p role="status">{codex.detail}</p> : <>
            <label htmlFor="dashboard-agent-prompt">What would you like to change?</label>
            <textarea id="dashboard-agent-prompt" ref={promptInput} rows={4} maxLength={8000} value={prompt} disabled={running}
              placeholder="Summarize my active projects and add a weekly progress section."
              onChange={(event) => setPrompt(event.target.value)} />
            <div className="dashboard-agent-actions">
              {running ? <button type="button" className="secondary sm" onClick={() => void stop()}>Stop</button> : <button type="button" className="primary" disabled={!prompt.trim()} onClick={() => void start()}>Run Codex</button>}
              <span>Uses your Codex account limits</span>
            </div>
          </>}
          {status && <p role="status" className="dashboard-agent-status">{status}</p>}
          {log && <pre ref={output} className="dashboard-agent-output" aria-label="Recent agent output">{log}</pre>}
        </div>
      </div>, document.body,
    )}
  </>;
}

/** Account Settings → About. Detection is cached until Baalda restarts. */
export function InstalledAgentsStatus() {
  const { agents, error } = useInstalledAgents();
  return <div className="installed-agents-status">
    <h3>Installed agents</h3>
    {error ? <p>Detection is unavailable in this preview.</p> : agents === null ? <p>Checking installed clients…</p> : !agents.length ? <p>No supported CLI detected. Install Codex and run <code>codex login</code> in your terminal, then restart Baalda.</p> : agents.map((agent) =>
      <div key={agent.agent} className="installed-agent-row">
        <strong>{agent.agent === "codex" ? "Codex" : "Claude"}</strong>
        <span>{agent.version} · {agent.signedIn ? "Signed in" : "Sign-in not confirmed"}</span>
        <p>{agent.detail}</p>
      </div>,
    )}
    <p className="dashboard-agent-description">Detection refreshes when Baalda restarts. Claude uses the Ask AI copy-prompt action.</p>
  </div>;
}
