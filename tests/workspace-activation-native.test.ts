import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the actual session/cache boundary and workspace/join components.
// Only HTTP responses are synthetic; this is not real-backend acceptance.
const fixture = `
import React from "react";
import {createRoot} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {BrowserRouter} from "react-router";
import {SessionProvider,useSession} from "/src/app/session.tsx";
import {WorkspaceProvider,useWorkspace} from "/src/app/workspace.tsx";
import {WorkspaceGate} from "/src/features/workspaces/WorkspaceGate.tsx";
import {preserveWorkspaceJoinSecret} from "/src/features/workspaces/workspaceJoin.ts";
preserveWorkspaceJoinSecret(location.hash);
history.replaceState(null,"","/join");
const client=new QueryClient({defaultOptions:{queries:{staleTime:20000,retry:1,refetchOnWindowFocus:false},mutations:{networkMode:"always",retry:0}}});
window.refreshApplication=()=>client.invalidateQueries({queryKey:["workspace-staff-onboarding"]});
function Content(){const {session}=useSession();const {selectedWorkspaceId}=useWorkspace();return <><output data-tenant>{session?.tenantId}</output><output data-selected>{selectedWorkspaceId}</output><WorkspaceGate><nav aria-label="Main navigation">Workspace ready</nav></WorkspaceGate></>;}
function SignedIn(){const {session}=useSession();return session?<WorkspaceProvider><Content/></WorkspaceProvider>:<p>Restoring session</p>;}
createRoot(document.getElementById("root")).render(<QueryClientProvider client={client}><SessionProvider><BrowserRouter><SignedIn/></BrowserRouter></SessionProvider></QueryClientProvider>);
`;

const homeId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const subjectId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const identity = { tenantId: homeId, username: "applicant@example.test", subjectId, sessionId, generation: "initial-generation" };
const token = `e30.${Buffer.from(JSON.stringify({ sub: subjectId, sid: sessionId })).toString("base64url")}.synthetic`;
const membership = (id: string) => ({ organization: { organizationId: id, name: id === homeId ? "Home" : "Target", slug: id === homeId ? "home" : "target", status: "active" }, role: id === homeId ? "owner" : "member", status: "active" });
let server: ViteDevServer;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  const entry = normalizePath(process.cwd() + "/__workspace_activation_fixture.tsx");
  server = await createServer({ configFile: false, root: process.cwd(),
    cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-workspace-activation-")), logLevel: "error",
    define: { "import.meta.env.VITE_BUNKFY_API_BASE_URL": "window.location.origin" },
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "react-router", "@tanstack/react-query", "lucide-react"] },
    plugins: [react(), { name: "workspace-activation-fixture",
      resolveId: id => id === entry || id === "/__workspace_activation_fixture.tsx" ? entry : undefined,
      load: id => id === entry ? fixture : undefined,
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/join")) return next();
        void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__workspace_activation_fixture.tsx"></script></body></html>')
          .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
      }); },
    }], server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
  browser = await launchNativeChromium();
}, 60000);

afterAll(async () => { await browser?.close(); await server?.close(); });

describe("native workspace activation with existing workspace selection", () => {
  it.each([
    ...[0, 100, 500].flatMap(catalogueDelay => [0, 2].map(accessDenials => ({ catalogueDelay, accessDenials, staleCatalogues: 0 }))),
    { catalogueDelay: 0, accessDenials: 0, staleCatalogues: 1 },
    { catalogueDelay: 100, accessDenials: 0, staleCatalogues: 1 },
    { catalogueDelay: 500, accessDenials: 2, staleCatalogues: 1 },
  ].map(value => ({ ...value, abandonActivation: false })).concat([
    { catalogueDelay: 0, accessDenials: 0, staleCatalogues: 0, abandonActivation: true },
  ]))("handles activation with $catalogueDelay ms catalogue latency, $accessDenials access denials, $staleCatalogues stale catalogues, leaving=$abandonActivation", async ({ catalogueDelay, accessDenials, staleCatalogues, abandonActivation }) => {
    const context = await browser.newContext();
    await context.addInitScript(value => localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(value)), identity);
    const page = await context.newPage();
    let approved = false;
    let remainingDenials = accessDenials;
    let remainingStaleCatalogues = staleCatalogues;
    let catalogueHeld = false;
    let releaseCatalogue: (() => void) | undefined;
    let leftJoin = false;
    const requests: { path: string; tenant: string | undefined; status: number }[] = [];
    const runtimeErrors: string[] = [];
    page.on("pageerror", error => runtimeErrors.push(error.message));
    await page.route(url => url.pathname.startsWith("/api/"), async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const tenant = request.headers()["x-tenant-id"];
      let status = 200;
      let body: unknown;
      if (path === "/api/auth/browser/refresh") body = { accessToken: token };
      else if (path === "/api/organizations") {
        if (approved && abandonActivation && !leftJoin) {
          catalogueHeld = true;
          await new Promise<void>(resolve => { releaseCatalogue = resolve; });
        }
        if (approved && catalogueDelay) await new Promise(resolve => setTimeout(resolve, catalogueDelay));
        const current = approved && remainingStaleCatalogues-- <= 0;
        body = { items: current ? [membership(homeId), membership(targetId)] : [membership(homeId)], page: 1, pageSize: 100, hasMore: false };
      } else if (path === "/api/organization-enrollment/preview") body = { organizationId: targetId, organizationName: "Target", organizationSlug: "target", enrollmentLinkId: sourceId, expiresAtUtc: "2027-01-01T00:00:00Z", approvalRequired: true };
      else if (path.endsWith("/applications/current")) body = { organizationId: targetId, applicationId: "application", status: approved ? 5 : 2, staffMemberId: approved ? "staff" : null, claimId: "claim", claimVersion: 1 };
      else if (path === "/api/properties") {
        if (approved && tenant === targetId && new URL(request.url()).searchParams.get("pageSize") === "1" && remainingDenials-- > 0) {
          status = 403; body = { code: "Properties.AccessDenied", detail: "Synthetic pending grant." };
        } else body = { properties: [], page: 1, pageSize: 100, hasMore: false };
      }
      else { status = 500; body = { code: "Test.UnexpectedRoute" }; }
      requests.push({ path, tenant, status });
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    try {
      await page.goto(origin + "join#enrollment=synthetic-team-link");
      try {
        await page.getByRole("heading", { name: "Request sent", exact: true }).waitFor({ timeout: 10000 });
      } catch (error) {
        console.log(JSON.stringify({ phase: "pending", catalogueDelay, requests, state: await page.locator("body").innerText(), runtimeErrors }));
        throw error;
      }
      approved = true;
      await page.evaluate(() => (window as unknown as { refreshApplication(): Promise<void> }).refreshApplication());
      if (abandonActivation) {
        await expect.poll(() => catalogueHeld).toBe(true);
        await page.getByLabel("Back to BunkFy", { exact: true }).click();
        leftJoin = true;
        const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/organizations");
        releaseCatalogue!();
        await (await response).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.getByRole("navigation", { name: "Main navigation" }).waitFor();
        expect(await page.locator("[data-tenant]").textContent()).toBe(homeId);
        expect(await page.locator("[data-selected]").textContent()).toBe(homeId);
        expect(requests.filter(value => value.tenant === targetId)).toEqual([]);
        expect(new URL(page.url()).pathname).toBe("/");
        expect(runtimeErrors).toEqual([]);
        return;
      }
      try {
        await page.getByRole("navigation", { name: "Main navigation" }).waitFor({ timeout: 7000 });
      } catch (error) {
        console.log(JSON.stringify({ catalogueDelay, requests, state: await page.locator("body").innerText(), runtimeErrors }));
        throw error;
      }
      expect(await page.locator("[data-tenant]").textContent()).toBe(targetId);
      expect(await page.locator("[data-selected]").textContent()).toBe(targetId);
      expect(new URL(page.url()).pathname).toBe("/");
      expect(await page.evaluate(() => sessionStorage.getItem("bunkfy.join.secret.v1"))).toBeNull();
      expect(requests.length).toBeLessThan(30);
      expect(runtimeErrors).toEqual([]);
    } finally { releaseCatalogue?.(); await context.close(); }
  }, 30000);
});
