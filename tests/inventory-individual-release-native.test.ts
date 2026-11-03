import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Actual Inventory page, session/workspace/permission providers and transport.
// HTTP state is synthetic; this does not qualify real Auth or backend admission.
const workspaceId = "90000000-0000-4000-8000-000000000001";
const propertyId = "10000000-0000-4000-8000-000000000001";
const roomId = "20000000-0000-4000-8000-000000000001";
const unitId = "30000000-0000-4000-8000-000000000001";
const otherUnitId = "30000000-0000-4000-8000-000000000002";
const groupId = "40000000-0000-4000-8000-000000000001";
const blockId = "50000000-0000-4000-8000-000000000001";
const otherBlockId = "50000000-0000-4000-8000-000000000002";
const subjectId = "60000000-0000-4000-8000-000000000001";
const sessionId = "70000000-0000-4000-8000-000000000001";
const fixture = `
import React from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter} from "react-router";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {SessionProvider} from "/src/app/session.tsx";
import {WorkspaceProvider} from "/src/app/workspace.tsx";
import {AccessAuthorityProvider} from "/src/app/accessAuthority.tsx";
import {InventoryPage} from "/src/features/inventory/InventoryPage.tsx";
import "/src/styles.css";
const query=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
window.inventoryReleaseHarness={refreshPermissions:()=>query.invalidateQueries({queryKey:["access-permissions"]})};
createRoot(document.getElementById("root")).render(
 <MemoryRouter initialEntries={["/inventory?property=${propertyId}&arrival=2026-11-05&departure=2026-11-07"]}>
  <QueryClientProvider client={query}><SessionProvider><WorkspaceProvider><AccessAuthorityProvider>
   <InventoryPage/>
  </AccessAuthorityProvider></WorkspaceProvider></SessionProvider></QueryClientProvider>
 </MemoryRouter>);
`;
let server: ViteDevServer, browser: Browser, origin: string;
const runtimeErrors: string[] = [];
beforeAll(async () => {
  const entry = normalizePath(process.cwd() + "/__inventory_release_native.tsx");
  server = await createServer({
    configFile: false, root: process.cwd(), logLevel: "error",
    cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-inventory-release-native-")),
    define: { "import.meta.env.VITE_BUNKFY_API_BASE_URL": "window.location.origin" },
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "react-router", "@tanstack/react-query", "lucide-react", "@radix-ui/react-popover", "@radix-ui/react-select", "@daypicker/react"] },
    plugins: [react(), tailwindcss(), {
      name: "inventory-release-native-fixture",
      resolveId: id => id === entry || id === "/__inventory_release_native.tsx" ? entry : undefined,
      load: id => id === entry ? fixture : undefined,
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/__inventory-release-native")) return next();
          void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__inventory_release_native.tsx"></script></body></html>')
            .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
        });
      },
    }], server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen(); origin = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); await server?.close(); expect(runtimeErrors).toEqual([]); });

async function open(individualAllowed = true) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addInitScript(identity => localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(identity)),
    { tenantId: workspaceId, username: "fixture@example.test", subjectId, sessionId, generation: "fixture" });
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  page.on("pageerror", error => runtimeErrors.push(error.message));
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const reads: string[] = [];
  let allowed = individualAllowed, released = false;
  const blocks = () => [
    { blockId, inventoryUnitId: unitId, status: released ? 2 : 1, version: released ? 5 : 4 },
    { blockId: otherBlockId, inventoryUnitId: otherUnitId, status: 1, version: 4 },
  ].map(block => ({ ...block, blockGroupId: groupId, propertyId, arrival: "2026-11-05", departure: "2026-11-07", reason: "Maintenance",
    createdAtUtc: "2026-11-01T12:00:00Z", releasedAtUtc: released && block.blockId === blockId ? "2026-11-03T12:00:00Z" : null }));
  const group = () => ({ blockGroupId: groupId, propertyId, target: { kind: 4, roomId, inventoryUnitId: null, bedId: null, buildingLabel: null, floorLabel: null },
    arrival: "2026-11-05", departure: "2026-11-07", reason: "Maintenance", status: released ? 2 : 1, version: released ? 10 : 9,
    initialBlockCount: 2, totalBlockCount: 2, activeBlockCount: released ? 1 : 2, releasedBlockCount: released ? 1 : 0,
    replacesGroupId: null, replacedByGroupId: null, createdAtUtc: "2026-11-01T12:00:00Z", updatedAtUtc: null,
    releasedAtUtc: null, createdByActorId: subjectId, lastModifiedByActorId: null });
  const room = { propertyId, roomId, roomName: "Garden", buildingLabel: null, floorLabel: null, salesMode: 3, version: 1,
    units: [unitId, otherUnitId].map((id, index) => ({ propertyId, roomId, inventoryUnitId: id, bedId: id, kind: 2,
      label: index ? "Bed B" : "Bed A", isSellable: true, isTopologyActive: true })) };
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let response: unknown;
    if (path === "/api/auth/browser/refresh") {
      response = { accessToken: `e30.${Buffer.from(JSON.stringify({ sub: subjectId, sid: sessionId })).toString("base64url")}.synthetic` };
    } else if (path === "/api/organizations") {
      response = { items: [{ organization: { organizationId: workspaceId, scopeId: workspaceId, name: "Fixture workspace", slug: "fixture", status: 1 },
        membership: { organizationId: workspaceId, subjectId, status: 1, role: 2 } }], hasMore: false };
    } else if (path === "/api/properties") {
      response = { properties: [{ propertyId, name: "Fixture property", timeZoneId: "UTC", canonicalTimeZoneId: "UTC", status: 1 }], hasMore: false };
    } else if (path === "/api/access/permissions/evaluate") {
      const body = request.postDataJSON() as { checks: { permission: string; scope: string }[] };
      response = { permissions: body.checks.map(check => ({ ...check, allowed: check.permission === "inventory.read" || (allowed && check.permission === "inventory.blocks.manage") })) };
    } else if (request.method() === "POST") {
      writes.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      if (path !== `/api/inventory/properties/${propertyId}/blocks/${blockId}/release`) {
        await route.fulfill({ status: 403, body: "Unexpected mutation" }); return;
      }
      released = true;
      response = { propertyId, blockId, blockGroupId: groupId, status: 2, version: 5 };
    } else {
      reads.push(path);
      if (path.endsWith("/rooms")) response = { rooms: [room], hasMore: false };
      else if (path.endsWith("/availability")) response = { propertyId, arrival: url.searchParams.get("arrival"), departure: url.searchParams.get("departure"),
        units: room.units.map(unit => ({ unit, isAvailable: false })) };
      else if (path.endsWith("/blocks")) response = { blocks: blocks().filter(block => block.status === 1), hasMore: false };
      else if (path.endsWith("/members")) response = { blocks: blocks(), pageSize: 50, nextCursor: null };
      else if (path.endsWith(`/block-groups/${groupId}`)) response = group();
      else if (path.endsWith("/block-groups")) response = { blockGroups: released && url.searchParams.get("status") === "1" ? [] : [group()], pageSize: 50, nextCursor: null };
      else { await route.fulfill({ status: 404, body: "Unexpected read" }); return; }
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.goto(origin + "__inventory-release-native");
  try {
    await page.getByRole("button", { name: "View details for Garden", exact: true }).click();
  } catch (error) {
    const detail = await page.locator("body").innerText();
    await context.close();
    throw new Error(`Inventory fixture setup failed: ${detail}; reads: ${reads.join(", ")}; runtime: ${runtimeErrors.join(", ")}`, { cause: error });
  }
  await page.getByRole("heading", { name: "Members", exact: true }).waitFor();
  return { context, page, writes, reads, revoke: async () => {
    allowed = false;
    await page.evaluate(() => (window as unknown as { inventoryReleaseHarness: { refreshPermissions(): Promise<void> } }).inventoryReleaseHarness.refreshPermissions());
  } };
}

describe("Inventory individual block release", () => {
  it("retains a release action for one member without whole-group permission", async () => {
    const { context, page, writes } = await open();
    try {
      await page.getByRole("button", { name: "Release Bed A", exact: true }).click();
      await page.getByText("This removes the hold from 1 unit.", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Confirm release", exact: true }).click();
      await expect.poll(() => writes.length).toBe(1);
      expect(writes[0].path).toBe(`/api/inventory/properties/${propertyId}/blocks/${blockId}/release`);
      expect(writes[0].body).toMatchObject({ expectedVersion: 4, operationId: expect.any(String) });
      await page.getByText("Active members", { exact: true }).locator("..").getByText("1", { exact: true }).waitFor();
      expect(writes.some(call => call.path.includes("/block-groups/"))).toBe(false);
    } finally { await context.close(); }
  }, 30000);

  it("does not expose a release action to read-only operators", async () => {
    const { context, page, writes } = await open(false);
    try {
      expect(await page.getByRole("button", { name: /^Release/ }).count()).toBe(0);
      expect(writes).toEqual([]);
    } finally { await context.close(); }
  }, 30000);

  it("withdraws an open confirmation when the individual permission is revoked", async () => {
    const { context, page, writes, revoke } = await open();
    try {
      await page.getByRole("button", { name: "Release Bed A", exact: true }).click();
      const confirm = page.getByRole("button", { name: "Confirm release", exact: true });
      await expect.poll(() => confirm.isEnabled()).toBe(true);
      await revoke();
      await expect.poll(async () => await confirm.count() === 0 || await confirm.isDisabled()).toBe(true);
      expect(writes).toEqual([]);
    } finally { await context.close(); }
  }, 30000);
});
