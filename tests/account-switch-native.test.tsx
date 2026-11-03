import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type BrowserContext } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Native account-switch path: actual SharedAccountRoot, AccountSwitchScreen,
// remembered endpoints, PIN form and same-origin cross-tab storage/channel.
const fixture = `
import React,{useEffect} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router";
import {ProductCapabilitiesProvider} from "/src/app/productCapabilities.tsx";
import {useSession} from "/src/app/session.tsx";
import {SharedAccountRoot,useSharedAccounts} from "/src/features/account-switch/SharedAccountsProvider.tsx";
import "/src/styles.css";
function Product(){
 const auth=useSession(),shared=useSharedAccounts();
 useEffect(()=>{window.accountHarness={signIn:()=>auth.login({username:"owner-a@example.test",password:"synthetic-password"}),chooseWorkspace:()=>auth.selectWorkspace("workspace-a"),requestOld:()=>{window.oldReadResult=null;void auth.request("/synthetic-old-read").then(()=>{window.oldReadResult="unexpected-success";},error=>{window.oldReadResult=error?.name??"unknown";});},hasSession:()=>auth.session?.username??null};},[auth]);
 return <main><output data-user>{auth.session?.username??"Signed out"}</output><button type="button" onClick={()=>void shared?.switchAccount()}>Switch account</button></main>;
}
const query=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
createRoot(document.getElementById("root")).render(<ProductCapabilitiesProvider capabilities={{emailVerificationEnabled:false,sharedAccountSwitchEnabled:true}}><QueryClientProvider client={query}><MemoryRouter><SharedAccountRoot><Product/></SharedAccountRoot></MemoryRouter></QueryClientProvider></ProductCapabilitiesProvider>);
`;

const memberA = "11111111-1111-4111-8111-111111111111";
const sessionA = "22222222-2222-4222-8222-222222222222";
const memberB = "33333333-3333-4333-8333-333333333333";
const sessionB = "44444444-4444-4444-8444-444444444444";
const proofA = "66666666-6666-4666-8666-666666666666";
const proofB = "55555555-5555-4555-8555-555555555555";
const identityA = { tenantId: "workspace-a", username: "owner-a@example.test", subjectId: memberA, sessionId: sessionA, generation: "identity-a" };
const token = (subjectId: string, sessionId: string) => `e30.${Buffer.from(JSON.stringify({ sub: subjectId, sid: sessionId })).toString("base64url")}.synthetic`;
const accountA = { proofId: proofA, username: identityA.username, label: "Person A", requiresSignIn: false, expiresAtUtc: "2099-01-01T00:00:00Z" };
const accountB = { proofId: proofB, username: "staff-b@example.test", label: "Person B", requiresSignIn: false, expiresAtUtc: "2099-01-01T00:00:00Z" };
const current = (state: number, generation: number, active: null | { memberId: string; sessionId: string; proofId: string | null; username: string; label: string | null }) => ({
  state, generation, pinDigits: 6, accounts: [accountA, accountB], active, csrfToken: "synthetic-csrf", idleExpiresAtUtc: null, absoluteExpiresAtUtc: null,
});
const activeA = (generation: number) => current(2, generation, { memberId: memberA, sessionId: sessionA, proofId: proofA, username: identityA.username, label: accountA.label });
const locked = (generation: number) => current(1, generation, null);
const activeB = (generation: number) => current(2, generation, { memberId: memberB, sessionId: sessionB, proofId: proofB, username: accountB.username, label: accountB.label });
const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });

let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let origin: string;
const runtimeErrors: string[] = [];

beforeAll(async () => {
  const entry = normalizePath(process.cwd() + "/__account_switch_native_fixture.tsx");
  const cacheDir = mkdtempSync(join(tmpdir(), "bunkfy-account-switch-native-"));
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir,
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "react-router", "@tanstack/react-query", "lucide-react"] },
    plugins: [react(), tailwindcss(), {
      name: "account-switch-native-fixture",
      resolveId: id => id === entry || id === "/__account_switch_native_fixture.tsx" ? entry : undefined,
      load: id => id === entry ? fixture : undefined,
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/__account-switch-native")) return next();
          void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__account_switch_native_fixture.tsx"></script></body></html>')
            .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
        });
      },
    }],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
  browser = await launchNativeChromium();
  context = await browser.newContext();
  await context.addInitScript(identity => {
    if (!localStorage.getItem("bunkfy.session.identity.v2")) localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(identity));
  }, identityA);
}, 60000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.close();
  expect(runtimeErrors).toEqual([]);
});

describe("native normal-account PIN switch", () => {
  it("keeps ordinary first login and workspace reload when no remembered device exists", async () => {
    const fresh = await browser.newContext();
    const page = await fresh.newPage();
    page.setDefaultTimeout(5000);
    let stage = "initial sign-out";
    let currentReads = 0;
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/")) { await route.continue(); return; }
      if (path.endsWith("/remembered/current")) {
        currentReads++;
        await route.fulfill(json({ ...current(0, 0, null), accounts: [], csrfToken: null })); return;
      }
      if (path === "/api/auth/browser/login" || path === "/api/auth/browser/refresh") {
        await route.fulfill(json({ accessToken: token(memberA, sessionA) })); return;
      }
      throw new Error(`Unexpected first-login request: ${path}`);
    });
    try {
      await page.goto(origin + "__account-switch-native");
      await page.getByText("Signed out", { exact: true }).waitFor();
      stage = "password login";
      await page.evaluate(() => (window as unknown as { accountHarness: { signIn(): Promise<unknown> } }).accountHarness.signIn());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.locator("[data-user]").count()).toBe(1);
      expect(await page.locator("[data-user]").textContent()).toBe(identityA.username);
      await page.evaluate(() => (window as unknown as { accountHarness: { chooseWorkspace(): void } }).accountHarness.chooseWorkspace());
      stage = "workspace session reload";
      await page.reload();
      await expect.poll(() => currentReads).toBeGreaterThanOrEqual(3);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.locator("[data-user]").count()).toBe(1);
      expect(await page.locator("[data-user]").textContent()).toBe(identityA.username);
    } catch (error) {
      throw new Error(`First login failed at ${stage}, Current reads=${currentReads}: ${await page.locator("body").innerText()}`, { cause: error });
    } finally { await fresh.close(); }
  }, 30000);

  it("conceals a previously managed session when its remembered device disappears", async () => {
    const managed = await browser.newContext();
    await managed.addInitScript(identity => localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(identity)), identityA);
    const page = await managed.newPage();
    page.setDefaultTimeout(5000);
    let currentReads = 0;
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/")) { await route.continue(); return; }
      if (path.endsWith("/remembered/current")) {
        currentReads++;
        await route.fulfill(json(currentReads < 3 ? activeA(1) : { ...current(0, 0, null), accounts: [], csrfToken: null })); return;
      }
      if (path === "/api/auth/browser/refresh") { await route.fulfill(json({ accessToken: token(memberA, sessionA) })); return; }
      throw new Error(`Unexpected managed-session request: ${path}`);
    });
    try {
      await page.goto(origin + "__account-switch-native");
      await page.getByText("Choose your account", { exact: true }).waitFor();
      expect(currentReads).toBeGreaterThanOrEqual(3);
      expect(await page.locator("[data-user]").count()).toBe(0);
    } finally { await managed.close(); }
  }, 30000);

  it("switches one tab by PIN while another tab fences its delayed old refresh", async () => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    let state: "active-a" | "locked" | "active-b" = "active-a";
    let serverGeneration = 1;
    let holdNextARefresh = false;
    let releaseOldRefresh: (() => void) | undefined;
    let oldRefreshStarted!: () => void;
    const oldRefreshReady = new Promise<void>(resolve => { oldRefreshStarted = resolve; });
    const oldRefreshReleased = new Promise<void>(resolve => { releaseOldRefresh = resolve; });

    const routeApi = async (route: import("@playwright/test").Route, page: "a" | "b") => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/browser/refresh") {
        if (page === "a") {
          if (holdNextARefresh) { holdNextARefresh = false; oldRefreshStarted(); await oldRefreshReleased; await route.fulfill(json({ accessToken: token(memberA, sessionA) })); return; }
          await route.fulfill(json({ accessToken: state === "active-b" ? token(memberB, sessionB) : token(memberA, sessionA) })); return;
        }
        await route.fulfill(json({ accessToken: token(state === "active-b" ? memberB : memberA, state === "active-b" ? sessionB : sessionA) })); return;
      }
      if (path.endsWith("/remembered/current")) { await route.fulfill(json(state === "active-a" ? activeA(serverGeneration) : state === "locked" ? locked(serverGeneration) : activeB(serverGeneration))); return; }
      if (path.endsWith("/remembered/lock")) { serverGeneration += 1; state = "locked"; await route.fulfill(json({ outcome: 0, current: locked(serverGeneration) })); return; }
      if (path.endsWith("/remembered/select")) {
        const body = JSON.parse(route.request().postData() ?? "{}") as { proofId?: string };
        serverGeneration += 1;
        if (body.proofId === proofB) { state = "active-b"; await route.fulfill(json({ outcome: 0, current: activeB(serverGeneration), accessToken: token(memberB, sessionB) })); }
        else { state = "active-a"; await route.fulfill(json({ outcome: 0, current: activeA(serverGeneration), accessToken: token(memberA, sessionA) })); }
        return;
      }
      if (path === "/api/auth/browser/sign-out") { await route.fulfill(json(null)); return; }
      if (path === "/api/auth/browser/remembered/activity") { await route.fulfill(json({ outcome: 0, current: state === "active-b" ? activeB(serverGeneration) : activeA(serverGeneration) })); return; }
      await route.continue();
    };
    await pageA.route("**/synthetic-old-read", route => route.fulfill(json({ title: "Unauthorized", status: 401 }, 401)));
    await pageA.route("**/api/**", route => routeApi(route, "a"));
    await pageB.route("**/api/**", route => routeApi(route, "b"));
    for (const page of [pageA, pageB]) {
      page.on("pageerror", error => runtimeErrors.push(error.message));
      page.on("console", message => { if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) runtimeErrors.push(message.text()); });
    }

    try {
      await pageA.goto(origin + "__account-switch-native");
      await expect.poll(() => pageA.locator("[data-user]").textContent()).toBe(identityA.username);
      await pageB.goto(origin + "__account-switch-native");
      await pageB.setViewportSize({ width: 1440, height: 1000 });
      await expect.poll(() => pageB.locator("[data-user]").textContent()).toBe(identityA.username);
      holdNextARefresh = true;
      await pageA.evaluate(() => { void (window as unknown as { accountHarness: { requestOld(): Promise<unknown> } }).accountHarness.requestOld(); });
      await oldRefreshReady;

      await pageB.getByRole("button", { name: "Switch account", exact: true }).click();
      await expect.poll(() => pageB.getByText("Choose your account", { exact: true }).count()).toBe(1);
      expect(await pageB.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await pageB.locator("button").filter({ hasText: "Person B" }).click();
      const pin = pageB.locator('input[name="devicePin"]');
      expect(await pin.evaluate(element => document.activeElement === element)).toBe(true);
      await pin.fill("654321"); await pin.press("Enter");
      await expect.poll(() => pageB.locator("[data-user]").textContent()).toBe(accountB.username);

      releaseOldRefresh!();
      await expect.poll(() => pageA.evaluate(() => (window as unknown as { oldReadResult: unknown }).oldReadResult)).toBe("SessionBoundarySupersededError");
      await expect.poll(() => pageA.locator("[data-user]").textContent()).toBe(accountB.username);
      expect(await pageA.evaluate(() => localStorage.getItem("bunkfy.session.identity.v2"))).toContain(sessionB);
      await pageA.reload();
      await expect.poll(() => pageA.locator("[data-user]").textContent()).toBe(accountB.username);

      await pageB.getByRole("button", { name: "Switch account", exact: true }).click();
      await expect.poll(() => pageB.getByText("Choose your account", { exact: true }).count()).toBe(1);
      await pageB.locator("button").filter({ hasText: "Person A" }).click();
      const pinA = pageB.locator('input[name="devicePin"]');
      await pinA.fill("123456"); await pinA.press("Enter");
      await expect.poll(() => pageB.locator("[data-user]").textContent()).toBe(identityA.username);
      await expect.poll(() => pageA.locator("[data-user]").textContent()).toBe(identityA.username);
      expect(await pageA.evaluate(() => localStorage.getItem("bunkfy.session.identity.v2"))).toContain(sessionA);
      for (const page of [pageA, pageB]) {
        const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
        expect(JSON.stringify(storage)).not.toMatch(/654321|123456|accessToken|synthetic-csrf|\.synthetic/);
      }
    } finally {
      releaseOldRefresh?.();
      await pageA.close(); await pageB.close();
    }
  }, 30000);
});
