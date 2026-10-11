// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HomeDashboardDialog } from "../HomeDashboardDialog";
const mocks = vi.hoisted(() => ({ state: {} as any, write: vi.fn() }));
vi.mock("../../store", () => ({ useStore: Object.assign((selector: any) => selector(mocks.state), { getState: () => mocks.state, setState: vi.fn() }) }));
vi.mock("../../lib/ipc", () => ({ writeNoteIfMissing: mocks.write }));
vi.mock("../../lib/dashboard/templates", () => ({ DASHBOARD_TEMPLATES: [{ id: "daily", name: "Daily", description: "Daily", html: "daily" }], copyDashboardPrompt: vi.fn() }));
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
 mocks.state = { vault: { path: "/fixture", epoch: 1 }, titles: [{path:"HOME.html"}], tree: null, rootFrozen: false };
 mocks.write.mockReset(); host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);
 await act(async()=>root.render(createElement(HomeDashboardDialog)));
 await act(async()=>window.dispatchEvent(new CustomEvent("baalda:new-dashboard")));
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const input=()=>document.querySelector<HTMLInputElement>(".dashboard-name-input input")!;
async function name(value:string){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input(),value);input().dispatchEvent(new Event("input",{bubbles:true}));});}
async function create(){await act(async()=>[...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="Create dashboard")!.click());}
it("suggests an available name without overwriting an existing case variant",async()=>{expect(input().value).toBe("Home 2");await name("Home");await create();expect(document.querySelector('[role="alert"]')?.textContent).toContain("already exists");expect(mocks.write).not.toHaveBeenCalled();});
it.each([" .hidden", ".html", "\u007fInvalid"])("rejects invalid normalized name %j without writing",async value=>{await name(value);await create();expect(document.querySelector('[role="alert"]')).not.toBeNull();expect(mocks.write).not.toHaveBeenCalled();expect(document.activeElement).toBe(input());});
it("focuses the editable name after an atomic create collision",async()=>{mocks.write.mockResolvedValue(false);await create();expect(mocks.write).toHaveBeenCalledOnce();expect(input().disabled).toBe(false);expect(document.activeElement).toBe(input());expect(document.querySelector('[role="alert"]')?.textContent).toContain("already exists");});
