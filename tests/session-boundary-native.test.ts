import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real SessionProvider, real same-origin pages, and real BroadcastChannel. The
// API remains a controlled route so the test can hold the old refresh response
// while another page publishes a newer actor.
const fixture = `
import React,{useEffect} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient,QueryClientProvider,useQueryClient} from "@tanstack/react-query";
import {SessionProvider,useSession} from "/src/app/session.tsx";
import {MemoryRouter} from "react-router";
import {WorkspaceProvider} from "/src/app/workspace.tsx";
import {JoinWorkspacePage} from "/src/features/workspaces/JoinWorkspacePage.tsx";
import {saveInviteStaffDraft} from "/src/features/workspaces/staffOnboarding.ts";
const privateDraft={displayName:"Synthetic A",legalName:"Synthetic Legal Person A",workEmail:"synthetic-a@example.invalid",workPhone:"",jobTitle:"Synthetic role",department:""};
let capturedRequests, capturePreviousRender;
import "/src/styles.css";
function Capture(){
 const auth=useSession(),query=useQueryClient();
 useEffect(()=>{window.sessionHarness={
 registerWithDraft:()=>auth.register({username:"registered@example.invalid",password:"synthetic-password"},subjectId=>saveInviteStaffDraft(privateDraft,subjectId)),
 adoptBrowserAccount:auth.adoptBrowserAccount,
 captureRequests:()=>{capturedRequests=auth.captureRequestContext();capturePreviousRender=auth.captureRequestContext;},
 sendCaptured:async()=>{try{await capturedRequests.request("/api/synthetic-mutation",{method:"POST"});return "sent";}catch{return "rejected";}},
 captureStaleRender:()=>{try{capturePreviousRender();return "captured";}catch{return "rejected";}},
 selectCaptured:workspaceId=>{try{capturedRequests=capturedRequests.selectWorkspace(workspaceId);return "selected";}catch{return "rejected";}},
 selectWorkspace:auth.selectWorkspace,
 setPrivate:()=>query.setQueryData(["private"],"old-actor"),hasPrivate:()=>query.getQueryData(["private"])??null};},[auth,query]);
 return <main><output data-session>{auth.session?.username??"Signed out"}</output><output data-restoring>{auth.isRestoring?"restoring":"ready"}</output><output data-subject>{auth.session?.subjectId??""}</output>{auth.session&&location.search.includes("join-probe")&&<MemoryRouter initialEntries={["/join#invitation=synthetic-token"]}><WorkspaceProvider><JoinWorkspacePage/></WorkspaceProvider></MemoryRouter>}</main>;
}
const query=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
createRoot(document.getElementById("root")).render(<QueryClientProvider client={query}><SessionProvider restoreOnMount={!location.search.includes("no-restore")}><Capture/></SessionProvider></QueryClientProvider>);
`;

const subjectA = "11111111-1111-4111-8111-111111111111";
const sessionA = "22222222-2222-4222-8222-222222222222";
const subjectB = "33333333-3333-4333-8333-333333333333";
const sessionB = "44444444-4444-4444-8444-444444444444";
const identityA = { tenantId: "synthetic-workspace", username: "owner-a@example.test", subjectId: subjectA, sessionId: sessionA, generation: "generation-a" };
const identityB = { tenantId: "synthetic-workspace", username: "staff-b@example.test", subjectId: subjectB, sessionId: sessionB, generation: "generation-b" };
const token = (subjectId: string, sessionId: string) => `e30.${Buffer.from(JSON.stringify({ sub: subjectId, sid: sessionId })).toString("base64url")}.synthetic`;
const response = (accessToken: string) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ accessToken }) });

let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let origin: string;
const runtimeErrors: string[] = [];

beforeAll(async () => {
  const entry = normalizePath(process.cwd() + "/__session_boundary_native_fixture.tsx");
  const cacheDir = mkdtempSync(join(tmpdir(), "bunkfy-session-boundary-native-"));
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir,
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@tanstack/react-query"] },
    plugins: [react(), {
      name: "session-boundary-native-fixture",
      resolveId: id => id === entry || id === "/__session_boundary_native_fixture.tsx" ? entry : undefined,
      load: id => id === entry ? fixture : undefined,
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/__session-boundary-native")) return next();
          void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__session_boundary_native_fixture.tsx"></script></body></html>')
            .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
        });
      },
    }],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  await context.addInitScript(identity => localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(identity)), identityA);
}, 60000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.close();
  expect(runtimeErrors).toEqual([]);
});

describe("native cross-tab remembered-session boundary", () => {
  it("rejects a prepared mutation after scope or actor changes and allows the explicitly guarded onboarding transition", async () => {
    const page = await context.newPage();
    const writes: { tenant: string | undefined; authorization: string | undefined }[] = [];
    page.on("pageerror", error => runtimeErrors.push(error.message));
    await page.route("**/api/synthetic-mutation", async route => {
      const headers = route.request().headers();
      writes.push({ tenant: headers["x-tenant-id"], authorization: headers.authorization });
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    try {
      await page.goto(origin + "__session-boundary-native?no-restore=1");
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { sessionHarness?: unknown }).sessionHarness))).toBe(true);
      await page.evaluate(account => (window as unknown as { sessionHarness: { adoptBrowserAccount(value: unknown): void } }).sessionHarness.adoptBrowserAccount(account), { ...identityA, accessToken: token(subjectA, sessionA) });
      await expect.poll(() => page.locator("[data-subject]").textContent()).toBe(subjectA);
      await page.evaluate(() => (window as unknown as { sessionHarness: { captureRequests(): void } }).sessionHarness.captureRequests());
      expect(await page.evaluate(() => (window as unknown as { sessionHarness: { sendCaptured(): Promise<string> } }).sessionHarness.sendCaptured())).toBe("sent");

      // A local operation that awaited hashing must not send into the newly
      // selected tenant through the stable request function.
      await page.evaluate(() => (window as unknown as { sessionHarness: { selectWorkspace(id: string): void } }).sessionHarness.selectWorkspace("different-workspace"));
      expect(await page.evaluate(() => (window as unknown as { sessionHarness: { sendCaptured(): Promise<string> } }).sessionHarness.sendCaptured())).toBe("rejected");
      expect(await page.evaluate(() => (window as unknown as { sessionHarness: { captureStaleRender(): string } }).sessionHarness.captureStaleRender())).toBe("rejected");
      expect(await page.evaluate(() => (window as unknown as { sessionHarness: { selectCaptured(id: string): string } }).sessionHarness.selectCaptured("synthetic-workspace"))).toBe("rejected");
      expect(writes).toHaveLength(1);

      // Creation intentionally enters its acknowledged workspace. The guarded
      // switch is synchronous; its returned context is the only valid one.
      await page.evaluate(() => (window as unknown as { sessionHarness: { captureRequests(): void } }).sessionHarness.captureRequests());
      expect(await page.evaluate(() => (window as unknown as { sessionHarness: { selectCaptured(id: string): string } }).sessionHarness.selectCaptured("newly-created-workspace"))).toBe("selected");
      expect(await page.evaluate(() => (window as unknown as { sessionHarness: { sendCaptured(): Promise<string> } }).sessionHarness.sendCaptured())).toBe("sent");
      expect(writes.map(write => write.tenant)).toEqual(["synthetic-workspace", "newly-created-workspace"]);
      expect(writes.every(write => write.authorization === `Bearer ${token(subjectA, sessionA)}`)).toBe(true);

      await page.evaluate(account => (window as unknown as { sessionHarness: { adoptBrowserAccount(value: unknown): void } }).sessionHarness.adoptBrowserAccount(account), { ...identityB, tenantId: "newly-created-workspace", accessToken: token(subjectB, sessionB) });
      await expect.poll(() => page.locator("[data-subject]").textContent()).toBe(subjectB);
      expect(await page.evaluate(() => (window as unknown as { sessionHarness: { sendCaptured(): Promise<string> } }).sessionHarness.sendCaptured())).toBe("rejected");
      expect(await page.evaluate(() => (window as unknown as { sessionHarness: { selectCaptured(id: string): string } }).sessionHarness.selectCaptured("newly-created-workspace"))).toBe("rejected");
      expect(writes).toHaveLength(2);
    } finally { await page.close(); }
  }, 30000);

  it("binds a registration draft before the real join form renders and isolates an account with the same display label", async () => {
    const page = await context.newPage();
    page.on("pageerror", error => runtimeErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") runtimeErrors.push(message.text()); });
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      if (path === "/api/auth/browser/register") return route.fulfill(response(token(subjectA, sessionA)));
      if (path === "/api/organization-invitations/preview") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ invitationId: "55555555-5555-4555-8555-555555555555", organizationId: "66666666-6666-4666-8666-666666666666", organizationName: "Synthetic workspace", organizationSlug: "synthetic", recipientBound: false, expiresAtUtc: "2030-01-01T00:00:00Z", status: "pending" }) });
      if (path === "/api/organizations") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], hasMore: false, totalCount: 0 }) });
      throw new Error("Unexpected owned draft fixture request: " + path);
    });
    try {
      await page.goto(origin + "__session-boundary-native?no-restore=1&join-probe=1");
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { sessionHarness?: unknown }).sessionHarness))).toBe(true);
      await page.evaluate(() => (window as unknown as { sessionHarness: { registerWithDraft(): Promise<void> } }).sessionHarness.registerWithDraft());
      const legalName = page.getByLabel("Legal name (optional)");
      await expect.poll(() => legalName.inputValue()).toBe("Synthetic Legal Person A");
      await legalName.fill("Edited private draft A");
      await page.evaluate(account => (window as unknown as { sessionHarness: { adoptBrowserAccount(value: unknown): void } }).sessionHarness.adoptBrowserAccount(account), { ...identityA, tenantId: "global", username: "GitHub account", accessToken: token(subjectA, sessionA) });
      await expect.poll(() => legalName.inputValue()).toBe("Edited private draft A");
      await page.evaluate(account => (window as unknown as { sessionHarness: { adoptBrowserAccount(value: unknown): void } }).sessionHarness.adoptBrowserAccount(account), { ...identityB, tenantId: "global", username: "GitHub account", accessToken: token(subjectB, sessionB) });
      await expect.poll(() => page.locator("[data-subject]").textContent()).toBe(subjectB);
      await expect.poll(() => legalName.inputValue()).toBe("");
      await legalName.fill("Private draft B");
      await page.evaluate(account => (window as unknown as { sessionHarness: { adoptBrowserAccount(value: unknown): void } }).sessionHarness.adoptBrowserAccount(account), { ...identityA, tenantId: "global", username: "GitHub account", generation: "return-to-a", accessToken: token(subjectA, sessionA) });
      await expect.poll(() => legalName.inputValue()).toBe("Edited private draft A");
    } finally { await page.close(); }
  }, 30000);

  it("does not hand off a private draft when the registration token lacks a valid session identity", async () => {
    const page = await context.newPage();
    const malformed = `e30.${Buffer.from(JSON.stringify({ sub: subjectA })).toString("base64url")}.synthetic`;
    await page.route("**/api/auth/browser/register", route => route.fulfill(response(malformed)));
    try {
      await page.goto(origin + "__session-boundary-native?no-restore=1");
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { sessionHarness?: unknown }).sessionHarness))).toBe(true);
      const failed = await page.evaluate(async () => {
        try { await (window as unknown as { sessionHarness: { registerWithDraft(): Promise<void> } }).sessionHarness.registerWithDraft(); return false; }
        catch { return true; }
      });
      expect(failed).toBe(true);
      expect(await page.locator("[data-session]").textContent()).toBe("Signed out");
      expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("bunkfy.invite.staff-profile.v3:")))).toEqual([]);
    } finally { await page.close(); }
  }, 30000);

  it("rejects a late old refresh after another page publishes a new actor", async () => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const oldRefreshStarted = new Promise<void>(resolve => {
      let first = true;
      void pageA.route("**/api/auth/browser/refresh", async route => {
        if (first) {
          first = false; resolve();
          await new Promise<void>(release => { (pageA as Page & { releaseOldRefresh?: () => void }).releaseOldRefresh = release; });
          await route.fulfill(response(token(subjectA, sessionA)));
          return;
        }
        await route.fulfill(response(token(subjectB, sessionB)));
      });
    });
    await pageB.route("**/api/auth/browser/refresh", route => route.fulfill(response(token(subjectA, sessionA))));
    for (const page of [pageA, pageB]) {
      page.on("pageerror", error => runtimeErrors.push(error.message));
      page.on("console", message => { if (message.type() === "error") runtimeErrors.push(message.text()); });
    }

    try {
      await pageA.goto(origin + "__session-boundary-native");
      await oldRefreshStarted;
      await expect.poll(() => pageA.evaluate(() => Boolean((window as unknown as { sessionHarness?: unknown }).sessionHarness))).toBe(true);
      await pageA.evaluate(() => (window as unknown as { sessionHarness: { setPrivate(): void } }).sessionHarness.setPrivate());
      await pageB.goto(origin + "__session-boundary-native?no-restore=1");
      await expect.poll(() => pageB.evaluate(() => Boolean((window as unknown as { sessionHarness?: unknown }).sessionHarness))).toBe(true);
      await pageB.evaluate(account => {
        const harness = (window as unknown as { sessionHarness: { adoptBrowserAccount(value: unknown): void } }).sessionHarness;
        harness.adoptBrowserAccount(account);
      }, { ...identityB, accessToken: token(subjectB, sessionB) });

      // A current actor change is a privacy boundary even before the delayed
      // old response is released; the query cache must not retain old data.
      await expect.poll(() => pageA.evaluate(() => (window as unknown as { sessionHarness: { hasPrivate(): unknown } }).sessionHarness.hasPrivate())).toBeNull();

      const release = (pageA as Page & { releaseOldRefresh?: () => void }).releaseOldRefresh;
      expect(release).toBeTypeOf("function"); release!();
      await expect.poll(() => pageA.locator("[data-session]").textContent()).toBe("staff-b@example.test");
      expect(await pageA.locator("[data-restoring]").textContent()).toBe("ready");
      expect(await pageA.evaluate(() => localStorage.getItem("bunkfy.session.identity.v2"))).toContain(sessionB);
    } finally {
      await pageA.close();
      await pageB.close();
    }
  }, 30000);
});
