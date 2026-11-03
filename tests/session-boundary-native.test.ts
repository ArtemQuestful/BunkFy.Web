import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { type Browser, type BrowserContext, type Page } from "@playwright/test";
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
import "/src/styles.css";
function Capture(){
 const auth=useSession(),query=useQueryClient();
 useEffect(()=>{window.sessionHarness={adoptBrowserAccount:auth.adoptBrowserAccount,setPrivate:()=>query.setQueryData(["private"],"old-actor"),hasPrivate:()=>query.getQueryData(["private"])??null};},[auth,query]);
 return <main><output data-session>{auth.session?.username??"Signed out"}</output><output data-restoring>{auth.isRestoring?"restoring":"ready"}</output></main>;
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
  browser = await launchNativeChromium();
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
