// SPDX-License-Identifier: Apache-2.0
//! User-selected installed CLI agents. No shell, credential files, or persisted logs.
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, State, WebviewWindow};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

const MAX_LINE: usize = 64 * 1024;
const MAX_PROMPT: usize = 32 * 1024;
const MAX_STREAM: usize = 512 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_RUN: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
}
impl Agent {
    fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAgent {
    pub agent: Agent,
    pub version: String,
    pub signed_in: bool,
    pub runnable: bool,
    pub detail: String,
}
#[derive(Clone)]
struct Installation {
    info: InstalledAgent,
    executable: PathBuf,
    prefix: Vec<OsString>,
    path: OsString,
}
struct ActiveRun {
    id: String,
    cancel: Option<oneshot::Sender<()>>,
}
#[derive(Default)]
pub struct AgentRunnerState {
    detection: tokio::sync::Mutex<Option<Vec<Installation>>>,
    active: Mutex<Option<ActiveRun>>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    Started {
        run_id: String,
    },
    Text {
        text: String,
    },
    Status {
        text: String,
    },
    Finished {
        cancelled: bool,
        success: bool,
        exit_code: Option<i32>,
    },
}
struct OutputBudget {
    remaining: usize,
    omitted: bool,
}
impl Default for OutputBudget {
    fn default() -> Self {
        Self {
            remaining: MAX_STREAM,
            omitted: false,
        }
    }
}
impl OutputBudget {
    fn reserve(&mut self, event: &AgentEvent) -> bool {
        let text_length = match event {
            AgentEvent::Text { text } | AgentEvent::Status { text } => text.len(),
            _ => 0,
        };
        // Account for escaped JSON and transport/event overhead, including empty records.
        let cost = text_length.saturating_mul(6).saturating_add(256);
        if cost > self.remaining {
            return false;
        }
        self.remaining -= cost;
        true
    }
    fn send(&mut self, channel: &Channel<AgentEvent>, event: AgentEvent) -> bool {
        if self.reserve(&event) {
            return channel.send(event).is_ok();
        }
        if !self.omitted {
            self.omitted = true;
            return channel
                .send(AgentEvent::Status {
                    text: "Further CLI output omitted; the run is still active.".into(),
                })
                .is_ok();
        }
        true
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunAgentRequest {
    pub agent: Agent,
    pub prompt: String,
    pub dashboard_path: String,
    pub expected_epoch: u64,
    pub run_id: String,
}

fn trusted_window(window: &WebviewWindow) -> AppResult<()> {
    let url = window.url()?;
    let trusted = window.label() == "main"
        && match url.scheme() {
            "tauri" => url.host_str() == Some("localhost"),
            "http" | "https" => {
                url.host_str() == Some("tauri.localhost")
                    || (cfg!(debug_assertions)
                        && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
                        && url.port() == Some(1420))
            }
            _ => false,
        };
    if trusted {
        Ok(())
    } else {
        Err(AppError::new(
            "Installed agents are available only in the trusted app window",
        ))
    }
}

/// Repair the child's PATH without executing a login shell or reading shell rc files.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<_> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for p in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        dirs.push(PathBuf::from(p));
    }
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        let home = PathBuf::from(home);
        dirs.extend([
            home.join(".local/bin"),
            home.join(".claude/local"),
            home.join(".npm-global/bin"),
            home.join(".volta/bin"),
            home.join(".cargo/bin"),
        ]);
        if let Ok(nodes) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut nodes: Vec<_> = nodes.flatten().map(|e| e.path().join("bin")).collect();
            nodes.sort();
            nodes.reverse();
            dirs.extend(nodes);
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(programfiles) = std::env::var_os("ProgramFiles") {
        dirs.push(PathBuf::from(programfiles).join("nodejs"));
    }
    let mut unique = Vec::new();
    for dir in dirs {
        if dir.is_absolute() && !unique.contains(&dir) {
            unique.push(dir);
        }
    }
    unique
}

fn executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return path
            .metadata()
            .is_ok_and(|m| m.permissions().mode() & 0o111 != 0);
    }
    #[cfg(not(unix))]
    {
        true
    }
}
/// Windows npm `.cmd` fallback runs the known package entry point through Node.
/// Never send a prompt or path through cmd.exe's command-string parser.
fn launch_target(
    agent: Agent,
    candidate: PathBuf,
    dirs: &[PathBuf],
) -> Option<(PathBuf, Vec<OsString>)> {
    if !candidate.is_file() {
        return None;
    }
    if candidate
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd"))
    {
        let root = candidate.parent()?;
        let script = root.join(match agent {
            Agent::Claude => "node_modules/@anthropic-ai/claude-code/cli.js",
            Agent::Codex => "node_modules/@openai/codex/bin/codex.js",
        });
        if !script.is_file() {
            return None;
        }
        let node = std::iter::once(root.to_path_buf())
            .chain(dirs.iter().cloned())
            .map(|d| d.join("node.exe"))
            .find(|p| executable_file(p))?;
        return Some((node, vec![script.into_os_string()]));
    }
    executable_file(&candidate).then_some((candidate, Vec::new()))
}
fn command(install: &Installation, args: &[String]) -> Command {
    let mut cmd = Command::new(&install.executable);
    cmd.args(&install.prefix)
        .args(args)
        .env("PATH", &install.path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(0x08000004); // CREATE_NO_WINDOW | CREATE_SUSPENDED; resume after Job assignment.
    cmd
}

/// Fixed-memory chunk reader: oversized NDJSON records are dropped, never buffered whole.
async fn lines<R: AsyncRead + Unpin>(mut input: R, tx: mpsc::Sender<String>) {
    let mut chunk = [0u8; 4096];
    let mut line = Vec::with_capacity(4096);
    let mut oversize = false;
    loop {
        let n = match input.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for byte in &chunk[..n] {
            if *byte == b'\n' {
                let output = if oversize {
                    "[Agent output record omitted: too large]".into()
                } else {
                    String::from_utf8_lossy(&line).into_owned()
                };
                if tx.send(output).await.is_err() {
                    return;
                }
                line.clear();
                oversize = false;
            } else if !oversize {
                if line.len() < MAX_LINE {
                    line.push(*byte);
                } else {
                    line.clear();
                    oversize = true;
                }
            }
        }
    }
    if !line.is_empty() && !oversize {
        let _ = tx.send(String::from_utf8_lossy(&line).into_owned()).await;
    }
}
async fn probe(install: &Installation, args: &[&str]) -> Option<(bool, String)> {
    let args: Vec<_> = args.iter().map(|s| s.to_string()).collect();
    let mut child = command(install, &args).spawn().ok()?;
    #[cfg(unix)]
    let _group = ProcessGroup(child.id());
    #[cfg(windows)]
    let _job = windows_job::Job::attach(&child).ok()?;
    let (tx, mut rx) = mpsc::channel(16);
    let out = tokio::spawn(lines(child.stdout.take()?, tx.clone()));
    let err = tokio::spawn(lines(child.stderr.take()?, tx));
    let start = Instant::now();
    let mut text = String::new();
    let result = loop {
        for _ in 0..64 {
            let Ok(line) = rx.try_recv() else {
                break;
            };
            if text.len() < 128 * 1024 {
                text.push_str(&line);
                text.push('\n');
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            break Some(status.success());
        }
        if start.elapsed() > PROBE_TIMEOUT {
            terminate(&mut child).await;
            break None;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    // Join bounded readers while continuing to drain their bounded queue.
    let drain_start = Instant::now();
    while (!out.is_finished() || !err.is_finished())
        && drain_start.elapsed() < Duration::from_millis(500)
    {
        for _ in 0..64 {
            let Ok(line) = rx.try_recv() else {
                break;
            };
            if text.len() < 128 * 1024 {
                text.push_str(&line);
                text.push('\n');
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    for _ in 0..64 {
        let Ok(line) = rx.try_recv() else {
            break;
        };
        if text.len() < 128 * 1024 {
            text.push_str(&line);
            text.push('\n');
        }
    }
    out.abort();
    err.abort();
    result.map(|ok| (ok, text))
}
fn authenticated(agent: Agent, ok: bool, text: &str) -> bool {
    if !ok {
        return false;
    }
    match agent {
        Agent::Claude => serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|v| v.get("loggedIn").and_then(Value::as_bool))
            .unwrap_or(false),
        Agent::Codex => {
            let t = text.to_lowercase();
            t.contains("logged in") && !t.contains("not logged in")
        }
    }
}
fn configuration_paths_present(paths: &[PathBuf]) -> bool {
    paths.iter().any(|path| path.try_exists().unwrap_or(true))
}
fn project_configuration_paths(vault: &Path) -> Vec<PathBuf> {
    let mut paths = vec![vault.join("config.toml")];
    paths.extend(vault.ancestors().map(|dir| dir.join(".codex/config.toml")));
    paths
}
/// Presence only: do not open configurations (which may contain credentials).
/// Such layers can add unsandboxed MCP integrations or override CLI settings.
fn local_configuration_present(vault: Option<&Path>) -> bool {
    let mut paths = Vec::new();
    #[cfg(unix)]
    for name in ["config.toml", "requirements.toml", "managed_config.toml"] {
        paths.push(PathBuf::from("/etc/codex").join(name));
    }
    #[cfg(windows)]
    {
        let Some(system_dir) = windows_job::system_config_dir() else {
            return true;
        };
        for name in ["config.toml", "requirements.toml"] {
            paths.push(system_dir.join(name));
        }
        if let Some(home) = std::env::var_os("CODEX_HOME") {
            let home = PathBuf::from(home);
            if !home.is_absolute() {
                return true;
            }
            paths.push(home.join("managed_config.toml"));
        } else if let Some(home) = std::env::var_os("USERPROFILE") {
            paths.push(PathBuf::from(home).join(".codex/managed_config.toml"));
        } else {
            return true;
        }
    }
    if let Some(vault) = vault {
        paths.extend(project_configuration_paths(vault));
    }
    if configuration_paths_present(&paths) {
        return true;
    }
    #[cfg(target_os = "macos")]
    if forced_macos_configuration_present() {
        return true;
    }
    false
}
#[cfg(target_os = "macos")]
fn forced_macos_configuration_present() -> bool {
    use std::ffi::c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithBytes(
            allocator: *const c_void,
            bytes: *const u8,
            len: isize,
            encoding: u32,
            external: u8,
        ) -> *const c_void;
        fn CFPreferencesAppSynchronize(application: *const c_void) -> u8;
        fn CFPreferencesAppValueIsForced(key: *const c_void, application: *const c_void) -> u8;
        fn CFRelease(value: *const c_void);
    }
    unsafe {
        let make_string = |value: &str| {
            CFStringCreateWithBytes(
                std::ptr::null(),
                value.as_ptr(),
                value.len() as isize,
                0x08000100,
                0,
            )
        };
        let domain = make_string("com.openai.codex");
        if domain.is_null() {
            return true;
        }
        let mut present = CFPreferencesAppSynchronize(domain) == 0;
        for name in ["config_toml_base64", "requirements_toml_base64"] {
            let key = make_string(name);
            if key.is_null() {
                present = true;
            } else {
                present |= CFPreferencesAppValueIsForced(key, domain) != 0;
                CFRelease(key);
            }
        }
        CFRelease(domain);
        present
    }
}
async fn detect() -> Vec<Installation> {
    let dirs = search_dirs();
    let path = std::env::join_paths(&dirs).unwrap_or_default();
    let mut found = Vec::new();
    for agent in [Agent::Claude, Agent::Codex] {
        for dir in &dirs {
            let names: Vec<_> = if cfg!(windows) {
                vec![
                    format!("{}.exe", agent.name()),
                    format!("{}.cmd", agent.name()),
                ]
            } else {
                vec![agent.name().into()]
            };
            let mut detected = None;
            for name in names {
                let Some((executable, prefix)) = launch_target(agent, dir.join(name), &dirs) else {
                    continue;
                };
                let mut install = Installation {
                    info: InstalledAgent {
                        agent,
                        version: String::new(),
                        signed_in: false,
                        runnable: false,
                        detail: String::new(),
                    },
                    executable,
                    prefix,
                    path: path.clone(),
                };
                let Some((true, version)) = probe(&install, &["--version"]).await else {
                    continue;
                };
                let version = version.trim().lines().next().unwrap_or_default();
                if version.len() > 100 || !version.chars().any(|c| c.is_ascii_digit()) {
                    continue;
                }
                install.info.version = version.into();
                let auth_args: &[&str] = match agent {
                    Agent::Claude => &["auth", "status"],
                    Agent::Codex => &["login", "status"],
                };
                install.info.signed_in = probe(&install, auth_args)
                    .await
                    .is_some_and(|(ok, t)| authenticated(agent, ok, &t));
                let help_args: &[&str] = match agent {
                    Agent::Claude => &["--help"],
                    Agent::Codex => &["exec", "--help"],
                };
                let help = probe(&install, help_args)
                    .await
                    .map(|(_, t)| t)
                    .unwrap_or_default();
                let required: &[&str] = match agent {
                    Agent::Claude => &[],
                    Agent::Codex => &[
                        "--sandbox",
                        "--json",
                        "--skip-git-repo-check",
                        "--ephemeral",
                        "--ignore-user-config",
                        "--ignore-rules",
                        "--strict-config",
                    ],
                };
                let global_help = if agent == Agent::Codex {
                    probe(&install, &["--help"])
                        .await
                        .map(|(_, text)| text)
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let has_local_config = agent == Agent::Codex && local_configuration_present(None);
                let compatible = !has_local_config
                    && required.iter().all(|flag| help.contains(flag))
                    && (agent != Agent::Codex
                        || (supports_permissions(&install.info.version)
                            && global_help.contains("--no-daemon")));
                install.info.runnable = compatible
                    && match agent {
                        Agent::Claude => false,
                        Agent::Codex => {
                            install.info.signed_in
                                || std::env::var_os("CODEX_API_KEY").is_some_and(|v| !v.is_empty())
                        }
                    };
                install.info.detail = if has_local_config {
                    "Installed CLI policy cannot be scoped safely in Baalda. Use Ask AI to copy a prompt.".into()
                } else if !compatible {
                    "Update Codex to version 0.160.1 or newer: required safe execution flags are unavailable.".into()
                } else if agent == Agent::Claude {
                    "Use Ask AI to copy a prompt for Claude. In-app runs currently support Codex only.".into()
                } else if !install.info.runnable {
                    "Sign in from your terminal with codex login, then restart Baalda.".into()
                } else {
                    "Ready · uses CLI authentication with a vault-scoped permission profile.".into()
                };
                detected = Some(install);
                break;
            }
            if let Some(install) = detected {
                found.push(install);
                break;
            }
        }
    }
    found
}
/// Start detection once at launch, without blocking the app's startup or changing
/// its environment. Known GUI install paths are added only to each child PATH.
pub fn warm_detection(app: &tauri::AppHandle) {
    use tauri::Manager;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let runner = app.state::<AgentRunnerState>();
        let mut cache = runner.detection.lock().await;
        if cache.is_none() {
            *cache = Some(detect().await);
        }
    });
}
#[tauri::command]
pub async fn detect_agents(
    window: WebviewWindow,
    runner: State<'_, AgentRunnerState>,
) -> AppResult<Vec<InstalledAgent>> {
    trusted_window(&window)?;
    let mut cache = runner.detection.lock().await;
    if cache.is_none() {
        *cache = Some(detect().await);
    }
    Ok(cache
        .as_ref()
        .unwrap()
        .iter()
        .map(|i| i.info.clone())
        .collect())
}
const PERMISSION_PROFILE: &str = "baalda_dashboard";
fn permission_args() -> Vec<String> {
    // Static names; narrower private-directory denials override vault writes.
    vec![
        "-c".into(), format!("default_permissions=\"{PERMISSION_PROFILE}\""),
        "-c".into(), format!("permissions.{PERMISSION_PROFILE}.extends=\":workspace\""),
        "-c".into(), format!("permissions.{PERMISSION_PROFILE}.filesystem={{\":root\"=\"deny\",\":minimal\"=\"read\",\":tmpdir\"=\"deny\",\":slash_tmp\"=\"deny\",\":workspace_roots\"={{\".\"=\"write\",\".context\"=\"deny\",\".git\"=\"deny\",\".env\"=\"deny\",\".claude\"=\"deny\",\".codex\"=\"deny\",\".agents\"=\"deny\"}}}}"),
        "-c".into(), format!("permissions.{PERMISSION_PROFILE}.network.enabled=false"),
    ]
}
fn run_args(vault: &Path) -> Vec<String> {
    let mut args = vec!["--no-daemon".into()];
    args.extend(permission_args());
    args.extend(vec![
        "-c".into(),
        "approval_policy=\"never\"".into(),
        "-c".into(),
        "web_search=\"disabled\"".into(),
        "-c".into(),
        "shell_environment_policy.inherit=\"none\"".into(),
        "-c".into(),
        "features.shell_snapshot=false".into(),
        "-c".into(),
        "features.hooks=false".into(),
        "-c".into(),
        "features.plugins=false".into(),
        "-c".into(),
        "features.apps=false".into(),
        "exec".into(),
        "--strict-config".into(),
        "--skip-git-repo-check".into(),
        "--json".into(),
        "--ephemeral".into(),
        "--ignore-user-config".into(),
        "--ignore-rules".into(),
        "-C".into(),
        vault.to_string_lossy().into_owned(),
        "-".into(),
    ]);
    args
}
fn supports_permissions(version: &str) -> bool {
    let Some(version) = version
        .split_whitespace()
        .find(|s| s.starts_with(|c: char| c.is_ascii_digit()))
    else {
        return false;
    };
    let parts: Vec<_> = version
        .split('.')
        .filter_map(|s| s.parse::<u32>().ok())
        .collect();
    parts.len() == 3 && (parts[0], parts[1], parts[2]) >= (0, 160, 1)
}

fn safe_dashboard_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(s) if !s.to_string_lossy().starts_with('.')))
        && Path::new(path)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
}
/// Extract only user-facing text/tool names. Never forward init auth metadata, raw
/// command output, environment dumps, or the complete NDJSON object to the webview.
fn parse_event(line: &str) -> Option<AgentEvent> {
    let value: Value = serde_json::from_str(line).ok()?;
    match value.get("type")?.as_str()? {
        "assistant" => {
            let blocks = value.pointer("/message/content")?.as_array()?;
            let text: String = blocks
                .iter()
                .filter_map(|b| {
                    if b.get("type")?.as_str()? == "text" {
                        b.get("text")?.as_str()
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !text.is_empty() {
                Some(AgentEvent::Text { text })
            } else {
                Some(AgentEvent::Status {
                    text: "Editing dashboard…".into(),
                })
            }
        }
        "result" => value
            .get("result")
            .and_then(Value::as_str)
            .map(|text| AgentEvent::Text { text: text.into() }),
        "item.completed" => {
            let item = value.get("item")?;
            match item.get("type")?.as_str()? {
                "agent_message" => item
                    .get("text")?
                    .as_str()
                    .map(|text| AgentEvent::Text { text: text.into() }),
                "file_change" => Some(AgentEvent::Status {
                    text: "Updated files in the vault.".into(),
                }),
                _ => None,
            }
        }
        "error" | "turn.failed" => Some(AgentEvent::Status {
            text:
                "The CLI reported an error. Check its sign-in and account limits in your terminal."
                    .into(),
        }),
        _ => None,
    }
}
#[cfg(unix)]
struct ProcessGroup(Option<u32>);
#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}
#[cfg(unix)]
fn interrupt(child: &Child) {
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGINT);
        }
    }
}
#[cfg(windows)]
fn interrupt(_child: &Child) { /* GUI apps have no attached console for CTRL_BREAK; close stdin, then kill the job below. */
}
async fn terminate(child: &mut Child) {
    interrupt(child);
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(2) {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
}

#[derive(PartialEq, Eq, Debug)]
enum PromptDelivery {
    Delivered,
    Cancelled,
    Failed,
}
/// Preserve the pending write across short timeout polls. A CLI which never
/// reads stdin must still respond to cancellation, vault changes and the limit.
async fn write_prompt<W: AsyncWrite + Unpin>(
    mut stdin: W,
    input: &[u8],
    mut should_stop: impl FnMut() -> bool,
    limit: Duration,
) -> PromptDelivery {
    let start = Instant::now();
    let mut write = std::pin::pin!(stdin.write_all(input));
    loop {
        if should_stop() || start.elapsed() >= limit {
            return PromptDelivery::Cancelled;
        }
        match tokio::time::timeout(Duration::from_millis(25), write.as_mut()).await {
            Ok(Ok(())) => return PromptDelivery::Delivered,
            Ok(Err(_)) => return PromptDelivery::Failed,
            Err(_) => {}
        }
    }
}
struct RunGuard<'a>(&'a AgentRunnerState);
impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        *self.0.active.lock().unwrap() = None;
    }
}

#[tauri::command]
pub async fn run_agent(
    window: WebviewWindow,
    state: State<'_, AppState>,
    runner: State<'_, AgentRunnerState>,
    request: RunAgentRequest,
    on_event: Channel<AgentEvent>,
) -> AppResult<()> {
    trusted_window(&window)?;
    if request.agent != Agent::Codex {
        return Err(AppError::new(
            "In-app runs currently support Codex only. Copy a prompt for Claude.",
        ));
    }
    if request.prompt.trim().is_empty()
        || request.prompt.len() > MAX_PROMPT
        || request.run_id.len() > 80
        || request.run_id.is_empty()
        || !safe_dashboard_path(&request.dashboard_path)
    {
        return Err(AppError::new("Invalid dashboard agent request"));
    }
    let vault = {
        let inner = state.inner.lock().unwrap();
        if inner.vault_epoch != request.expected_epoch {
            return Err(AppError::new("vault_mismatch: the open vault changed"));
        }
        let vault = inner
            .vault
            .clone()
            .ok_or_else(|| AppError::new("No vault is open"))?;
        let dashboard = crate::vault::resolve_in_vault(&vault, &request.dashboard_path)?;
        if !dashboard.is_file() {
            return Err(AppError::new("The dashboard no longer exists"));
        }
        vault
    };
    if local_configuration_present(Some(&vault)) {
        return Err(AppError::new("Project or system CLI configuration prevents a scoped in-app run. Use Ask AI to copy a prompt."));
    }
    let install = {
        let mut cache = runner.detection.lock().await;
        if cache.is_none() {
            *cache = Some(detect().await);
        }
        cache.as_ref().unwrap().iter().find(|i| i.info.agent == request.agent && i.info.runnable).cloned().ok_or_else(|| AppError::new("This installed agent is unavailable. Check Settings → About, then restart Baalda."))?
    };
    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    {
        let mut active = runner.active.lock().unwrap();
        if active.is_some() {
            return Err(AppError::new("Another dashboard agent is already running"));
        }
        *active = Some(ActiveRun {
            id: request.run_id.clone(),
            cancel: Some(cancel_tx),
        });
    }
    let _guard = RunGuard(&runner);
    // Recheck after detection (which may take seconds). Never launch after a switch.
    if state.inner.lock().unwrap().vault_epoch != request.expected_epoch {
        return Err(AppError::new("vault_mismatch: the open vault changed"));
    }
    let mut cmd = command(&install, &run_args(&vault));
    cmd.current_dir(&vault).stdin(Stdio::piped());
    let mut child = cmd.spawn().map_err(|_| {
        AppError::new("Could not start the installed CLI. Check its installation in your terminal.")
    })?;
    #[cfg(unix)]
    let _group = ProcessGroup(child.id());
    #[cfg(windows)]
    let _job = windows_job::Job::attach(&child)?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::new("CLI stdin unavailable"))?;
    let input = format!("Update the HTML dashboard at {} in the current vault. Work only inside this vault; do not read or modify .context, .git, hidden files or credentials. Use the existing dashboard's API comments. Preserve note identities and source notes. Request: {}\n", serde_json::to_string(&request.dashboard_path)?, request.prompt);
    let (tx, mut rx) = mpsc::channel(32);
    let out = tokio::spawn(lines(child.stdout.take().unwrap(), tx.clone()));
    let err = tokio::spawn(lines(child.stderr.take().unwrap(), tx));
    let disconnected = on_event
        .send(AgentEvent::Started {
            run_id: request.run_id,
        })
        .is_err();
    let start = Instant::now();
    let delivery = write_prompt(
        stdin,
        input.as_bytes(),
        || {
            disconnected
                || cancel_rx.try_recv().is_ok()
                || state.inner.lock().unwrap().vault_epoch != request.expected_epoch
        },
        MAX_RUN,
    )
    .await;
    let mut cancelled = delivery == PromptDelivery::Cancelled;
    let failed_input = delivery == PromptDelivery::Failed;
    let mut failed_event = failed_input;
    let mut output_budget = OutputBudget::default();
    let status = loop {
        for _ in 0..64 {
            let Ok(line) = rx.try_recv() else { break };
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                failed_event |= v.get("is_error").and_then(Value::as_bool) == Some(true)
                    || matches!(
                        v.get("type").and_then(Value::as_str),
                        Some("error" | "turn.failed")
                    );
            }
            if let Some(event) = parse_event(&line) {
                if !output_budget.send(&on_event, event) {
                    cancelled = true;
                }
            }
        }
        let switched = state.inner.lock().unwrap().vault_epoch != request.expected_epoch;
        if cancel_rx.try_recv().is_ok()
            || switched
            || cancelled
            || failed_input
            || start.elapsed() > MAX_RUN
        {
            cancelled |= !failed_input;
            terminate(&mut child).await;
            break child.try_wait()?;
        }
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    // A descendant may keep stdout open: never wait forever after the CLI exits.
    let drain_start = Instant::now();
    while drain_start.elapsed() < Duration::from_millis(500) {
        for _ in 0..64 {
            let Ok(line) = rx.try_recv() else {
                break;
            };
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                failed_event |= v.get("is_error").and_then(Value::as_bool) == Some(true)
                    || matches!(
                        v.get("type").and_then(Value::as_str),
                        Some("error" | "turn.failed")
                    );
            }
            if let Some(event) = parse_event(&line) {
                let _ = output_budget.send(&on_event, event);
            }
        }
        if out.is_finished() && err.is_finished() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    out.abort();
    err.abort();
    let _ = on_event.send(AgentEvent::Finished {
        cancelled,
        success: !cancelled && !failed_event && status.as_ref().is_some_and(|s| s.success()),
        exit_code: status.and_then(|s| s.code()),
    });
    Ok(())
}
#[tauri::command]
pub fn cancel_agent(
    window: WebviewWindow,
    runner: State<'_, AgentRunnerState>,
    run_id: String,
) -> AppResult<()> {
    trusted_window(&window)?;
    cancel_run(&runner, &run_id);
    Ok(())
}

fn cancel_run(runner: &AgentRunnerState, run_id: &str) {
    if let Some(active) = runner.active.lock().unwrap().as_mut() {
        if active.id == run_id {
            if let Some(cancel) = active.cancel.take() {
                let _ = cancel.send(());
            }
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use super::*;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    pub fn system_config_dir() -> Option<PathBuf> {
        use windows_sys::Win32::System::Com::CoTaskMemFree;
        use windows_sys::Win32::UI::Shell::{FOLDERID_ProgramData, SHGetKnownFolderPath};
        unsafe {
            let mut path = std::ptr::null_mut();
            if SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, std::ptr::null_mut(), &mut path) < 0
                || path.is_null()
            {
                return None;
            }
            let mut length = 0;
            while *path.add(length) != 0 {
                length += 1;
            }
            use std::os::windows::ffi::OsStringExt;
            let directory = PathBuf::from(OsString::from_wide(std::slice::from_raw_parts(
                path, length,
            )));
            CoTaskMemFree(path as *const _);
            Some(directory.join("OpenAI/Codex"))
        }
    }
    pub struct Job(HANDLE);
    unsafe impl Send for Job {}
    impl Job {
        pub fn attach(child: &Child) -> AppResult<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(AppError::new("Could not create the agent process job"));
                }
                let job = Self(handle);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                    || AssignProcessToJobObject(
                        handle,
                        child
                            .raw_handle()
                            .ok_or_else(|| AppError::new("Agent process handle unavailable"))?
                            as HANDLE,
                    ) == 0
                {
                    return Err(AppError::new("Could not isolate the agent process job"));
                }
                // std/Tokio does not expose CreateProcess's primary thread handle.
                // The child is still suspended and has not executed user code;
                // find that one initial thread only after assigning its Job.
                resume_initial_thread(
                    child
                        .id()
                        .ok_or_else(|| AppError::new("Agent process ID unavailable"))?,
                )?;
                Ok(job)
            }
        }
    }
    unsafe fn resume_initial_thread(process_id: u32) -> AppResult<()> {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(AppError::new(
                "Could not inspect the suspended agent process",
            ));
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut available = Thread32First(snapshot, &mut entry) != 0;
        let mut resumed = false;
        while available {
            if entry.th32OwnerProcessID == process_id {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() {
                    resumed = ResumeThread(thread) == 1;
                    CloseHandle(thread);
                }
                break;
            }
            available = Thread32Next(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        if resumed {
            Ok(())
        } else {
            // The caller's Job guard terminates the suspended process on error.
            Err(AppError::new("Could not resume the isolated agent process"))
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }
    #[test]
    fn dashboard_boundary() {
        for invalid in [
            "",
            "../Home.html",
            "/Home.html",
            ".context/Home.html",
            "a/.git/Home.html",
            "a\\Home.html",
            "Home.md",
        ] {
            assert!(!safe_dashboard_path(invalid), "{invalid}");
        }
        assert!(safe_dashboard_path("Projects/My home.HTML"));
    }
    #[test]
    fn permission_profile_requires_a_known_cli_version() {
        assert!(!supports_permissions("codex-cli 0.159.0"));
        assert!(!supports_permissions("codex-cli unknown"));
        assert!(supports_permissions("codex-cli 0.160.1"));
        assert!(supports_permissions("codex-cli 1.0.0"));
    }
    #[test]
    fn project_and_ancestor_configuration_presence_blocks_the_runner() {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("workspace/vault");
        std::fs::create_dir_all(&vault).unwrap();
        let paths = project_configuration_paths(&vault);
        assert!(paths.contains(&vault.join("config.toml")));
        assert!(paths.contains(&temp.path().join(".codex/config.toml")));
        // Check only controlled paths, independent of this computer's policy.
        let controlled: Vec<_> = paths
            .into_iter()
            .filter(|p| p.starts_with(temp.path()))
            .collect();
        assert!(!configuration_paths_present(&controlled));
        let ancestor_config = temp.path().join(".codex/config.toml");
        std::fs::create_dir_all(ancestor_config.parent().unwrap()).unwrap();
        std::fs::write(&ancestor_config, "not parsed; could contain credentials").unwrap();
        assert!(configuration_paths_present(&controlled));
        std::fs::remove_file(ancestor_config).unwrap();
        // Non-file entries also fail closed instead of being treated as absent.
        std::fs::create_dir(vault.join("config.toml")).unwrap();
        assert!(configuration_paths_present(&controlled));
    }
    #[test]
    fn run_guard_clears_the_single_run_reservation() {
        let state = AgentRunnerState::default();
        let (tx, mut rx) = oneshot::channel();
        *state.active.lock().unwrap() = Some(ActiveRun {
            id: "owned-run".into(),
            cancel: Some(tx),
        });
        {
            let _guard = RunGuard(&state);
            assert!(matches!(
                rx.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
        }
        assert!(state.active.lock().unwrap().is_none());
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }
    #[test]
    fn cancellation_is_scoped_to_the_matching_run() {
        let state = AgentRunnerState::default();
        let (tx, mut rx) = oneshot::channel();
        *state.active.lock().unwrap() = Some(ActiveRun {
            id: "owned".into(),
            cancel: Some(tx),
        });
        cancel_run(&state, "other");
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        cancel_run(&state, "owned");
        assert_eq!(rx.try_recv(), Ok(()));
        cancel_run(&state, "owned");
    }
    #[test]
    fn windows_cmd_fallback_uses_the_known_node_entrypoint() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert!(launch_target(Agent::Codex, root.join("codex.cmd"), &[]).is_none());
        std::fs::write(root.join("codex.cmd"), "fake npm shim").unwrap();
        let script = root.join("node_modules/@openai/codex/bin/codex.js");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "// fake entrypoint").unwrap();
        let node = root.join("node.exe");
        std::fs::write(&node, "fake node").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let (executable, prefix) =
            launch_target(Agent::Codex, root.join("codex.cmd"), &[]).unwrap();
        assert_eq!(executable, node);
        assert_eq!(prefix, vec![script.into_os_string()]);
    }
    #[test]
    fn auth_is_explicit_and_never_inferred_from_files() {
        assert!(authenticated(
            Agent::Claude,
            true,
            "{\"loggedIn\":true,\"email\":\"private@example.test\"}"
        ));
        assert!(!authenticated(Agent::Claude, true, "{}"));
        assert!(!authenticated(Agent::Codex, true, "Not logged in"));
        assert!(authenticated(Agent::Codex, true, "Logged in using ChatGPT"));
        assert!(!authenticated(
            Agent::Codex,
            false,
            "Logged in using ChatGPT"
        ));
    }
    #[test]
    fn argv_does_not_contain_prompt_or_use_permission_bypass() {
        let args = run_args(Path::new("/a vault"));
        assert!(args.iter().any(|a| a.contains("extends=\":workspace\"")));
        assert!(args
            .iter()
            .any(|a| a.contains(".context") && a.contains("deny")));
        assert!(args.contains(&"--strict-config".into()));
        assert!(args.contains(&"--no-daemon".into()));
        assert!(args.contains(&"--ignore-user-config".into()));
        assert!(args.contains(&"--ephemeral".into()));
        for feature in ["hooks", "plugins", "apps"] {
            assert!(args.contains(&format!("features.{feature}=false")));
        }
        assert!(!args
            .iter()
            .any(|a| a.contains("bypass") || a.contains("danger-full-access")));
        assert_eq!(args.last().unwrap(), "-");
    }

    #[test]
    fn parser_omits_auth_metadata_and_command_output() {
        assert!(parse_event("{\"type\":\"system\",\"apiKeySource\":\"secret\"}").is_none());
        assert!(parse_event("{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"aggregated_output\":\"secret\"}}").is_none());
        assert!(
            matches!(parse_event("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Done\"}}"), Some(AgentEvent::Text { text }) if text == "Done")
        );
    }
    #[test]
    fn emitted_output_is_bounded_even_for_empty_records() {
        let mut budget = OutputBudget::default();
        let text = AgentEvent::Text {
            text: "x".repeat(MAX_LINE),
        };
        assert!(budget.reserve(&text));
        assert!(!budget.reserve(&text));
        let empty = AgentEvent::Text {
            text: String::new(),
        };
        let mut admitted = 0;
        while budget.reserve(&empty) {
            admitted += 1;
        }
        assert!(admitted < MAX_STREAM / 256);
        assert!(!budget.reserve(&empty));
        assert!(!budget.reserve(&text));
    }
    #[test]
    fn oversized_records_do_not_grow_memory_or_hide_next_record() {
        runtime().block_on(async {
            let input = format!(
                "{}\n{{\"type\":\"result\",\"result\":\"Done\"}}\n",
                "x".repeat(MAX_LINE + 900)
            );
            let (tx, mut rx) = mpsc::channel(4);
            lines(input.as_bytes(), tx).await;
            assert!(rx.recv().await.unwrap().contains("omitted"));
            assert!(rx.recv().await.unwrap().contains("Done"));
        });
    }
    #[cfg(unix)]
    #[test]
    fn unread_stdin_remains_cancellable_and_time_bounded() {
        runtime().block_on(async {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().unwrap();
            let bin = dir.path().join("codex");
            // Keeps stdin open without consuming a byte; no real agent or credit.
            std::fs::write(
                &bin,
                "#!/bin/sh\ntrap 'exit 0' INT\nwhile :; do sleep 0.1; done\n",
            )
            .unwrap();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
            let install = Installation {
                info: InstalledAgent {
                    agent: Agent::Codex,
                    version: String::new(),
                    signed_in: false,
                    runnable: false,
                    detail: String::new(),
                },
                executable: bin,
                prefix: vec![],
                path: OsString::from("/usr/bin:/bin"),
            };
            for cancel_requested in [true, false] {
                let mut cmd = command(&install, &[]);
                cmd.stdin(Stdio::piped());
                let mut child = cmd.spawn().unwrap();
                let _group = ProcessGroup(child.id());
                let stdin = child.stdin.take().unwrap();
                let (cancel_tx, mut cancel_rx) = oneshot::channel();
                let sender = tokio::spawn(async move {
                    if cancel_requested {
                        tokio::time::sleep(Duration::from_millis(75)).await;
                        let _ = cancel_tx.send(());
                    }
                });
                let started = Instant::now();
                // Larger than the platform pipe capacity, to force a pending write.
                let input = vec![b'x'; 2 * 1024 * 1024];
                let outcome = write_prompt(
                    stdin,
                    &input,
                    || cancel_rx.try_recv().is_ok(),
                    Duration::from_millis(150),
                )
                .await;
                assert_eq!(outcome, PromptDelivery::Cancelled);
                assert!(started.elapsed() < Duration::from_secs(1));
                terminate(&mut child).await;
                assert!(child.try_wait().unwrap().is_some());
                sender.await.unwrap();
            }
        });
    }
    #[cfg(unix)]
    #[test]
    fn fake_cli_probe_and_cancel_do_not_run_models() {
        runtime().block_on(async {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap(); let bin = dir.path().join("codex");
        std::fs::write(&bin, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codex-cli 0.160.1'; exit 0; fi\ntrap 'exit 0' INT\nwhile :; do sleep 0.1; done\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let install = Installation { info: InstalledAgent { agent: Agent::Codex, version: String::new(), signed_in: false, runnable: false, detail: String::new() }, executable: bin, prefix: vec![], path: OsString::from("/usr/bin:/bin") };
        assert!(probe(&install, &["--version"]).await.unwrap().1.contains("0.160.1"));
        let mut child = command(&install, &[]).spawn().unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await; terminate(&mut child).await;
        assert!(child.try_wait().unwrap().is_some());
    });
    }
}
