// SPDX-License-Identifier: Apache-2.0
import daily from "../../dashboards/templates/daily-home.html?raw";
import projects from "../../dashboards/templates/project-tracker.html?raw";
import reading from "../../dashboards/templates/reading-list.html?raw";
import team from "../../dashboards/templates/team-pulse.html?raw";
import people from "../../dashboards/templates/crm-lite.html?raw";
import blank from "../../dashboards/templates/blank.html?raw";

export const DASHBOARD_TEMPLATES = [
  { id: "daily", name: "Daily home", description: "Priorities, tasks, and quick links", html: daily, prompt: "Build a daily home from my notes with today's priorities, active tasks, and useful links." },
  { id: "projects", name: "Project tracker", description: "Projects grouped by status", html: projects, prompt: "Build a project tracker from my project notes, grouped by frontmatter status." },
  { id: "reading", name: "Reading list", description: "Books, articles, and takeaways", html: reading, prompt: "Build a reading list from my book and article notes, with authors, status, and useful takeaways." },
  { id: "team", name: "Team pulse", description: "Decisions, work, and open questions", html: team, prompt: "Build a team pulse from the notes I can read. Highlight decisions, active work, and open questions without inventing activity or attribution." },
  { id: "people", name: "People & conversations", description: "Contacts and thoughtful follow-ups", html: people, prompt: "Build a relationship dashboard from People and meeting notes, with next steps and last-contact dates when provided." },
  { id: "blank", name: "Blank", description: "Start with your own idea", html: blank, prompt: "Build an interactive home dashboard from my notes. Ask me what I want to see." },
] as const;

export function dashboardPrompt(path: string, vaultPath: string, request = "Update this dashboard using my notes."): string {
  return `${request}\n\nDashboard: ${path}\nVault folder: ${vaultPath}\nBaalda renders; it never generates. Read the HTML comment at the top of the file for the optional baalda API. Read relevant Markdown notes or use the Baalda MCP tools; keep those notes as the source of truth, without a separate JSON export. Update this HTML file via filesystem edits or MCP update_note/edit_note, preserving its identity. Only use information I can read and don't invent facts. No fetch/XHR/WebSocket; inline JS or allowed CDNs (cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com). Use /__baalda/sdk.js only when live data is useful; no localStorage. Optional API: vault.info/stats; notes.search/list/read/meta/backlinks; graph.edges; tags.list; properties.keys/values; state.get/set; app.open/openExternal. List filters: folder,tag,property:{key,value},modifiedSince (Unix seconds),sort,limit. Use CSS theme variables --bg,--fg,--surface,--muted,--accent,--border. Write the page the user asked for.`;
}
export async function copyDashboardPrompt(path: string, vaultPath: string, request?: string) {
  await navigator.clipboard.writeText(dashboardPrompt(path, vaultPath, request));
}
