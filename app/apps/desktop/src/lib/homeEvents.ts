// SPDX-License-Identifier: Apache-2.0

/** A creation request is explicit; no Home hint writes into a vault. */
export function requestNewDashboard(kind?: "link") {
  window.dispatchEvent(new CustomEvent("baalda:new-dashboard", { detail: kind ? { kind } : undefined }));
}
