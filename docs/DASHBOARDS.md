# Home and dashboards

Baalda renders. It never generates. A dashboard is an ordinary `.html` or `.htm`
note in your vault. You or your agent author the page; Baalda displays it, watches
for edits, and synchronizes it through the existing note access model. Markdown
notes remain the source material. There is no exported dashboard database.

## Getting started

Right-click Home (or press Shift+F10 while it has keyboard focus) to open the
dashboard chooser and create a dashboard. Choose Daily home, Project tracker,
Reading list, Team pulse, CRM-lite, or Blank, then a name and folder. These are
static examples, with an editing guide in their HTML comment. Creation only
happens after you click Create; existing files are never overwritten.

Open Preview to interact with the page or Source to edit its HTML. Copy agent
prompt includes the file path and optional bridge reference. Paste it into your
preferred agent, use Baalda's MCP tools, or let an agent edit the file on disk.
The watcher reloads the open preview after the file changes. Pages using the SDK
restore scroll and can retain widget state on this device.

Any note can be Home. Set as my home creates a device-local override; vault
owners/admins can set a shared vault home. Your override takes precedence. An available Home
opens when the vault opens, and Cmd/Ctrl+Shift+H returns to it. With no available
Home, the Home button opens the chooser. The chooser lists HTML and linked
dashboards, with Home first and pinned dashboards before the remaining files;
there is only one effective Home.

Opening a dashboard slides the sidebar away to give the page the full content
width. The sidebar toggle can reveal it for that visit. Returning to a normal
note restores your usual sidebar preference; dashboard browsing does not change it.

Pin notes or folders from their row menu. Personal pins live on this device.
Owners/admins can also pin for everyone; shared pins appear first and members
cannot remove the shared pin. Personal duplicates appear only once. Note pins and
Home use the stable note ID, so a recognized rename or move keeps the reference.
Folder pins follow moves made in Baalda and folder moves recognized by sync.
Unavailable pins are hidden without erasing saved references during an incomplete
listing, startup, or loss of access; a restored note with the same ID reappears.

Local external note moves retain IDs when the filesystem supplies reliable file
identity and creation time. Identical copies keep separate IDs. On filesystems
without that metadata, use Baalda's rename/move action or the existing sync
reconciliation rather than relying on local external move recognition.

## Agent paths

- **MCP:** create or update an HTML note with the normal note tools. Dashboard
  content uses the same permissions and sync as other notes.
- **Files:** run your agent in the vault and edit the HTML directly. Baalda's
  watcher picks up the change.
- **Routines:** configure your agent's scheduler to edit the file or use the
  Baalda MCP connector. Scheduling belongs to the agent; Baalda adds no scheduler.
- **Installed Codex:** when a supported, signed-in CLI is detected, Update with
  Codex opens a prompt and streaming log. Cancel stops the process and its children.
  Detection and compatibility appear under Account Settings → About.
- **Claude:** use Copy agent prompt. This release does not invoke Claude from
  Baalda with a subscription login.

The installed runner requires Codex CLI 0.160.1 or newer with named permission
profiles. Its dedicated profile permits vault content but denies the vault-root
paths `.context`, `.git`, `.env`, `.claude`, `.codex`, and `.agents`, including
their contents. These are specific paths, not a blanket denial of every hidden
file or nested `.env` file. Agent tools cannot access outside the vault apart
from the CLI's minimal runtime, and their network access is disabled. Codex uses
its saved CLI login or an inherited `CODEX_API_KEY`; that key can override the
saved login and use API billing. Baalda neither reads credential files nor
displays authentication output. Runs skip session rollout persistence; displayed
logs stay in memory. The runner ignores user configuration and execution-policy
rules, disables hooks/plugins/apps, and supplies its own permission overrides.
It refuses detected local project, system, or forced managed configuration using
presence checks, without reading those files. Organization policy fetched by the
installed CLI also applies. The runner relies on that CLI's enforcement of its
permission profile. If this profile is unsupported, use
Copy agent prompt instead. See the official [Codex non-interactive
documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

## Optional live bridge

A handwritten page needs no SDK. Include the following only when you want live
reads, app navigation, theme tokens, scroll restoration, or device-local state:

```html
<script src="/__baalda/sdk.js"></script>
<script>
  baalda.ready.then(async () => {
    const notes = await baalda.notes.list({ tag: "project", limit: 50 });
    const list = document.querySelector("#projects");
    for (const note of notes) {
      const button = document.createElement("button");
      button.textContent = note.title;
      button.onclick = () => baalda.app.open({ docId: note.id });
      list.append(button);
    }
  }).catch(console.error);
</script>
<div id="projects"></div>
```

Use `textContent` for note text rather than inserting unsanitized HTML. All
methods return promises and may reject, for example after a vault switch or
permission change.

| API | Result / arguments |
| --- | --- |
| `baalda.ready`, `baalda.vault.info()` | Vault name, user display name, platform, theme, CSS tokens |
| `baalda.notes.search(q, limit)` | Search results for readable notes; at most 200 |
| `baalda.notes.list(query)` | Note metadata: `id`, `path`, `title`, `mtime` (Unix seconds), `frontmatter` (JSON string or null), `tags` |
| `baalda.notes.read(note)` | Note source text |
| `baalda.notes.meta(note)` | Metadata for one note, or null |
| `baalda.notes.backlinks(note)` | Readable backlinks |
| `baalda.graph.edges()` | Links whose endpoints are both readable |
| `baalda.tags.list()` | `{name, count}` rows |
| `baalda.properties.keys()` | `{key, count}` rows |
| `baalda.properties.values(key)` | Distinct scalar values as strings |
| `baalda.vault.stats()` | Local vault health, or readable-note counts/activity for a synced vault |
| `baalda.state.get(key)`, `baalda.state.set(key, value)` | JSON widget state, device-local per dashboard; 64 KB total |
| `baalda.app.open(note)` | Open a readable note in Baalda |
| `baalda.app.openExternal(url)` | Open an HTTPS or mailto link in the system handler |

`note` accepts a path string, `{path: "Projects/Plan.md"}`, or `{docId: "…"}`.
`notes.list` accepts `folder`, `tag`, `property: {key, value}`, `modifiedSince`
(Unix seconds), `sort` (`path`, `title`, `modified-desc`, `modified-asc`),
`extensions`, and `limit` (0–200). Filters combine. Use filtered lists for large
vaults: aggregate tags/properties/stats are bounded to 10,000 readable notes.

The SDK applies `data-theme` and `--bg`, `--fg`, `--surface`, `--muted`, `--accent`,
`--accent-soft`, `--border`; updates follow the app theme. It relays app keyboard
shortcuts, including Cmd/Ctrl+K, and internal note links. `__scroll` is reserved
for scroll restoration. Widget state is separate from editor UI state and never
changes note content or syncs to teammates.

Local-only bridge reads work offline. In a synced vault the bridge requires a
fresh server-readable listing and fails closed when that listing is unavailable.
The saved HTML itself can still render offline. UI title caches are not authority.

## Runtime boundaries

Local pages run in an opaque-origin iframe with scripts and popup links enabled.
They receive neither same-origin access nor Tauri IPC. A separate `baalda-view`
protocol supplies the mounted HTML and local presentation assets, with an epoch
and per-view lease. Paths reject traversal, hidden metadata and symlink escape;
switching vaults invalidates the view. Raw notes are available only through the
authorized bridge.

Relative image/media paths work, including `./attachments/image.png`. Guest CSP
allows inline scripts/styles and scripts from cdnjs, jsDelivr and unpkg, with
Google Fonts styling/fonts. Fetch, WebSocket, nested frames, forms, and arbitrary
remote images are blocked. Popups and allowed CDN scripts remain capabilities
of the page; the sandbox is not a guarantee against every form of outbound
navigation. The main app's script policy stays `script-src 'self'`.

Host messages must come from the mounted iframe and its opaque origin. Methods,
request sizes, response sizes and concurrent requests are bounded. Old frames
cannot act on a newly opened vault. Read-only means the page cannot edit notes;
state storage and app navigation are the deliberate exceptions.

## Linked dashboards

Add dashboard from link creates a portable text `.url` note:

```ini
[InternetShortcut]
URL=https://example.com/dashboard
```

XML `.webloc` shortcuts are also readable; binary plist shortcuts are unsupported.
Both formats can be Home, pinned, shared and edited as ordinary notes. Links must
use HTTPS without embedded credentials. Known Claude/OpenAI domains are allowed
by default; Account Settings → About has Allow any HTTPS dashboard link for other
hosts. Remote pages receive no vault bridge. Open in browser is always available.
Claude and ChatGPT pages known to block iframe embedding display that fallback;
other sites may also block embedding, in which case use Open in browser.

## Development verification

Run desktop tests, Rust tests and the relevant server authorization/appearance
suites against a disposable database. Inspect Windows and macOS simulator layouts
at normal and narrow widths. A simulator or `tauri dev` cannot verify packaged
CSP: use a packaged app to check inline/SDK scripts, relative images, blocked
fetch, keyboard relay, and watcher reload with state/scroll restoration. Native
Windows WebView2 and actual two-device sharing require separate checks.
