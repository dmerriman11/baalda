// SPDX-License-Identifier: Apache-2.0
import { IMPORTED_DASHBOARD_TEMPLATES } from "./importedTemplates";
export type { DashboardTemplate } from "./importedTemplates";
export const DASHBOARD_TEMPLATES = IMPORTED_DASHBOARD_TEMPLATES;

export function dashboardPrompt(path: string, vaultPath: string, request = "Update this dashboard using my notes."): string {
  return `${request}\n\nDashboard: ${path}\nVault folder: ${vaultPath}\nBaalda renders; it never generates. Read the HTML comment at the top of the file for the optional baalda API. Read relevant Markdown notes or use the Baalda MCP tools; keep those notes as the source of truth, without a separate JSON export. Update this HTML file via filesystem edits or MCP update_note/edit_note, preserving its identity. Only use information I can read and don't invent facts. No fetch/XHR/WebSocket; inline JS or allowed CDNs (cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com). Use /__baalda/sdk.js only when live data is useful; no localStorage. Optional API: vault.info/stats; notes.search/list/read/meta/backlinks; graph.edges; tags.list; properties.keys/values; state.get/set; app.open/openExternal. List filters: folder,tag,property:{key,value},modifiedSince (Unix seconds),sort,limit. Use CSS theme variables --bg,--fg,--surface,--muted,--accent,--border. Write the page the user asked for.`;
}
export async function copyDashboardPrompt(path: string, vaultPath: string, request?: string) {
  await navigator.clipboard.writeText(dashboardPrompt(path, vaultPath, request));
}
