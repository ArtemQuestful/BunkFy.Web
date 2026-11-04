import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Production session provider, transport, editor hook, form and focus behavior.
// Controlled HTTP responses and permission evidence; no genuine Auth/backend claim.
const propertyId = "10000000-0000-4000-8000-000000000001";
const roomId = "20000000-0000-4000-8000-000000000001";
const unitId = "30000000-0000-4000-8000-000000000001";
const groupId = "40000000-0000-4000-8000-000000000001";
const subjectId = "60000000-0000-4000-8000-000000000001";
const sessionId = "70000000-0000-4000-8000-000000000001";
const fixture = `
import React,{useEffect,useState} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter} from "react-router";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {SessionProvider,useSession} from "/src/app/session.tsx";
import {useManualBlockEditor} from "/src/features/inventory/useManualBlockEditor.ts";
import {BlockInventoryModal} from "/src/features/inventory/BlockInventoryModal.tsx";
import {BlockMutationNotice} from "/src/features/inventory/BlockEditorFrame.tsx";
import "/src/styles.css";
const rooms=[{propertyId:${JSON.stringify(propertyId)},roomId:${JSON.stringify(roomId)},roomName:"Garden",buildingLabel:null,floorLabel:null,salesMode:3,version:1,
 units:[{propertyId:${JSON.stringify(propertyId)},roomId:${JSON.stringify(roomId)},inventoryUnitId:${JSON.stringify(unitId)},bedId:${JSON.stringify(unitId)},kind:2,label:"A",isSellable:true,isTopologyActive:true}]}];
function Fixture(){
 const auth=useSession(),[current,setCurrent]=useState(true),[notice,setNotice]=useState(null);
 const groups=!location.search.includes("unit");
 const editor=useManualBlockEditor({propertyId:${JSON.stringify(propertyId)},propertyName:"Synthetic property",rooms,blocks:[],mayManage:true,mayManageGroups:groups,
  evidence:{permissionsCurrent:current,propertyCurrent:true,inventoryCurrent:true,blocksCurrent:true},onSuccess:setNotice});
 useEffect(()=>{window.blockProtocolHarness={setCurrent};},[]);
 return <main data-blocks-region><h2>Inventory</h2><output data-session>{auth.session?"ready":"restoring"}</output><output data-restore-error>{auth.restorationError?.message}</output>
  <button disabled={!auth.session} onClick={event=>editor.openCreate(event.currentTarget)}>Add block</button>
  <button type="button" data-unrelated-focus>Other work</button>
  <BlockMutationNotice notice={notice}/>
  <BlockInventoryModal inline editor={editor} initialRange={{arrival:"2026-11-05",departure:"2026-11-07"}}
   initialTargetId={groups?${JSON.stringify("room:" + roomId)}:${JSON.stringify("unit:" + unitId)}} sources={[]}/></main>;
}
const query=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
createRoot(document.getElementById("root")).render(<MemoryRouter><QueryClientProvider client={query}><SessionProvider><Fixture/></SessionProvider></QueryClientProvider></MemoryRouter>);
`;

let server: ViteDevServer, browser: Browser, origin: string;
const runtimeErrors: string[] = [];
beforeAll(async () => {
  const entry = normalizePath(process.cwd() + "/__block_protocol_native.tsx");
  server = await createServer({
    configFile: false, root: process.cwd(), logLevel: "error",
    cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-block-protocol-native-")),
    define: { "import.meta.env.VITE_BUNKFY_API_BASE_URL": "window.location.origin" },
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "react-router", "@tanstack/react-query", "lucide-react", "@radix-ui/react-popover", "@radix-ui/react-select", "@daypicker/react"] },
    plugins: [react(), tailwindcss(), {
      name: "block-protocol-native-fixture",
      resolveId: id => id === entry || id === "/__block_protocol_native.tsx" ? entry : undefined,
      load: id => id === entry ? fixture : undefined,
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/__block-protocol-native")) return next();
          void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__block_protocol_native.tsx"></script></body></html>')
            .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
        });
      },
    }], server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen(); origin = server.resolvedUrls!.local[0];
  browser = await launchNativeChromium();
}, 60000);
afterAll(async () => { await browser?.close(); await server?.close(); expect(runtimeErrors).toEqual([]); });

async function open(unit = false, holdPreview?: Promise<void>) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  await context.addInitScript(identity => localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(identity)),
    { tenantId: "synthetic-workspace", username: "fixture@example.test", subjectId, sessionId, generation: "fixture" });
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  page.on("pageerror", error => runtimeErrors.push(error.message));
  const startup: string[] = [];
  page.on("requestfailed", request => startup.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`));
  const calls: { path: string; method: string; body: Record<string, unknown>; authorization: string | undefined }[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let response: unknown;
    if (path === "/api/auth/browser/refresh") {
      response = { accessToken: `e30.${Buffer.from(JSON.stringify({ sub: subjectId, sid: sessionId })).toString("base64url")}.synthetic` };
    } else {
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.push({ path, method: request.method(), body, authorization: request.headers().authorization });
      response = path.endsWith("/preview")
        ? { ...body, propertyId, status: 1, maximumAffectedBlockCount: 500, affectedBlockCount: 1, atLeastAffectedBlockCount: 1,
          exceedsMaximumAffectedBlockCount: false, selectionDigest: "a".repeat(64), membershipDigest: "b".repeat(64), membershipDigestVersion: 1,
          hasManualBlockConflict: false, hasActiveAllocationConflict: false, members: [], hasMoreMembers: false, blockGroupVersion: null, isNoOpReplacement: false }
        : unit ? { blockId: "50000000-0000-4000-8000-000000000001", blockGroupId: groupId, propertyId, status: 1, version: 1 }
          : { blockGroupId: groupId, propertyId, affectedBlockCount: 1, status: 1, version: 1, previousBlockGroupId: null,
            releasedBlockCount: 0, createdBlockCount: 1, totalBlockCount: 1, activeBlockCount: 1, alreadyReleasedBlockCount: 0,
            membershipDigest: "b".repeat(64), resultBlockGroupId: groupId, releasedNowBlockCount: 0, createdNowBlockCount: 1 };
    }
    if (path.endsWith("/preview")) await holdPreview;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.goto(origin + "__block-protocol-native" + (unit ? "?unit=1" : ""));
  try { await page.locator("[data-session]").filter({ hasText: "ready" }).waitFor(); }
  catch (error) {
    const detail = await page.locator("body").innerText(); await context.close();
    throw new Error(`Synthetic session setup failed: ${detail}; ${startup.join("; ")}`, { cause: error });
  }
  await page.getByRole("button", { name: "Add block", exact: true }).click();
  await page.getByRole("textbox", { name: "Reason", exact: true }).fill("Maintenance");
  return { context, page, calls };
}
async function stale(page: Page) {
  await page.evaluate(() => (window as unknown as { blockProtocolHarness: { setCurrent(value: boolean): void } }).blockProtocolHarness.setCurrent(false));
  await page.getByText("Your draft is kept.", { exact: false }).waitFor();
}

describe("native shared block editor confirmation", () => {
  it("moves keyboard focus to the read-only preview; repeated Enter cannot silently confirm", async () => {
    const { context, page, calls } = await open();
    try {
      const preview = page.getByRole("button", { name: "Preview block", exact: true });
      await preview.focus(); await page.keyboard.press("Enter");
      const review = page.locator("[data-block-preview]"); await review.waitFor();
      await expect.poll(() => review.evaluate(node => node === document.activeElement)).toBe(true);
      expect(calls).toHaveLength(1); expect(calls[0].path).toMatch(/\/preview$/);
      await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
      expect(calls).toHaveLength(1);
      await page.getByRole("button", { name: "Confirm block", exact: true }).press("Enter");
      await page.getByRole("status").filter({ hasText: "Block added" }).waitFor();
      expect(calls).toHaveLength(2);
      expect(calls[1].path).toBe(`/api/inventory/properties/${propertyId}/block-groups`);
      expect(calls[1].method).toBe("POST");
      expect(calls[1].body).toMatchObject({ confirmed: true, expectedSelectionDigest: "a".repeat(64), expectedAffectedBlockCount: 1, reason: "Maintenance" });
      expect(calls[1].authorization).toMatch(/^Bearer /);
    } finally { await context.close(); }
  }, 30000);

  it("keeps the reason and disables confirmation when current permission evidence is lost", async () => {
    const { context, page, calls } = await open();
    try {
      await page.getByRole("button", { name: "Preview block", exact: true }).click();
      await page.locator("[data-block-preview]").waitFor(); await stale(page);
      expect(await page.getByRole("button", { name: "Confirm block", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole("textbox", { name: "Reason", exact: true }).inputValue()).toBe("Maintenance");
      expect(calls).toHaveLength(1);
      await page.evaluate(() => (window as unknown as { blockProtocolHarness: { setCurrent(value: boolean): void } }).blockProtocolHarness.setCurrent(true));
      await page.getByText("Your draft is kept.", { exact: false }).waitFor({ state: "hidden" });
      expect(await page.getByRole("textbox", { name: "Reason", exact: true }).inputValue()).toBe("Maintenance");
      expect(calls).toHaveLength(1);
    } finally { await context.close(); }
  }, 30000);

  it("does not take focus from a user who moves elsewhere while preview is pending", async () => {
    let releasePreview!: () => void;
    const held = new Promise<void>(resolve => { releasePreview = resolve; });
    const { context, page, calls } = await open(false, held);
    try {
      await page.getByRole("button", { name: "Preview block", exact: true }).click();
      await expect.poll(() => calls.length).toBe(1);
      const other = page.getByRole("button", { name: "Other work", exact: true });
      await other.focus();
      releasePreview();
      await page.locator("[data-block-preview]").waitFor();
      expect(await other.evaluate(node => node === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      expect(calls).toHaveLength(1);
    } finally { releasePreview(); await context.close(); }
  }, 30000);

  it("requires deliberate confirmation when the submit control retains focus across a fast preview", async () => {
    let releasePreview!: () => void;
    const held = new Promise<void>(resolve => { releasePreview = resolve; });
    const { context, page, calls } = await open(false, held);
    try {
      const trigger = page.getByRole("button", { name: "Preview block", exact: true });
      const button = await trigger.elementHandle();
      await trigger.press("Enter");
      await expect.poll(() => calls.length).toBe(1);
      // Model a retained submit focus even if this Chromium build normally
      // blurs disabled buttons. Keep the real form, transport and preview hook.
      await button!.evaluate(node => { (node as HTMLButtonElement).disabled = false; (node as HTMLButtonElement).focus(); });
      expect(await button!.evaluate(node => node === document.activeElement)).toBe(true);
      releasePreview();
      const review = page.locator("[data-block-preview]");
      await review.waitFor();
      await expect.poll(() => review.evaluate(node => node === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
      expect(calls).toHaveLength(1);
    } finally { releasePreview(); await context.close(); }
  }, 30000);

  it("retains the individual unit command for a user without group management access", async () => {
    const { context, page, calls } = await open(true);
    try {
      await page.getByRole("button", { name: "Add block", exact: true }).last().click();
      await page.getByRole("status").filter({ hasText: "Block added" }).waitFor();
      expect(calls).toHaveLength(1); expect(calls[0].path).toBe(`/api/inventory/properties/${propertyId}/blocks`);
      expect(calls[0].body).toMatchObject({ inventoryUnitId: unitId, reason: "Maintenance" });
    } finally { await context.close(); }
  }, 30000);
});
