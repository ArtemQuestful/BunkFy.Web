import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchNativeChromium } from "./support/nativeChromium";

// Real SessionProvider/prompt/fetch/CORS and browser controls; the loopback API
// deliberately models assurance responses. It is not genuine Auth/cookie proof.
const subject = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const identity = { tenantId: "global", username: "owner@example.test", subjectId: subject, sessionId, generation: "recovery-fixture" };
const token = (acr: string) => `e30.${Buffer.from(JSON.stringify({ sub: subject, sid: sessionId, acr })).toString("base64url")}.synthetic`;
const mfa = "urn:gma:acr:mfa";
const passwordContext = "urn:gma:acr:password";
const fixture = `
import React,{useEffect,useState} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {BrowserRouter} from "react-router";
import {SessionProvider,useSession} from "/src/app/session.tsx";
import {RecentAuthenticationPrompt} from "/src/components/ui/RecentAuthenticationPrompt.tsx";
const payload={operationId:"33333333-3333-4333-8333-333333333333",expectedVersion:4,value:"preserve-this-command"};
function Fixture(){
 const auth=useSession(),[error,setError]=useState(null),[result,setResult]=useState("Pending");
 useEffect(()=>{window.recoveryHarness={conceal:auth.concealForAccountTransition};},[auth]);
 async function attempt(){try{await auth.request("/api/sensitive-action",{method:"POST",body:JSON.stringify(payload)});setError(null);setResult("Complete");}catch(error){setError(error);}}
 return <main><output data-session>{auth.session?.username??"Signed out"}</output><output data-result>{result}</output><button disabled={!auth.session} onClick={()=>void attempt()}>Run action</button><RecentAuthenticationPrompt error={error} onAuthenticated={()=>{window.resumeCount=(window.resumeCount||0)+1;void attempt();}}/></main>;
}
const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
createRoot(document.getElementById("root")).render(<BrowserRouter><QueryClientProvider client={client}><SessionProvider><Fixture/></SessionProvider></QueryClientProvider></BrowserRouter>);
`;

type State = {
  accepted: string[];
  operations: unknown[];
  confirmations: { endpoint: string; body: unknown }[];
  refreshes: number;
  commits: number;
  rejectCode: boolean;
  exposeChallenge: boolean;
  holdConfirmation?: Promise<void>;
};
let api: Server;
let web: ViteDevServer;
let browser: Browser;
let origin = "";
let state: State;
const runtimeErrors: string[] = [];

beforeAll(async () => {
  api = createHttpServer((req, res) => {
    void (async () => {
      res.setHeader("Access-Control-Allow-Origin", new URL(origin).origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      if (state.exposeChallenge) res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] ?? "Content-Type, Authorization, X-Tenant-Id");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw new Error("Oversized fixture request"); }
      const body: unknown = raw ? JSON.parse(raw) : null;
      const reply = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/api/auth/browser/refresh") { state.refreshes++; reply(200, { accessToken: token("old") }); return; }
      if (req.url === "/api/auth/browser/step-up/password" || req.url === "/api/auth/browser/step-up/mfa") {
        state.confirmations.push({ endpoint: req.url, body });
        if (state.holdConfirmation) await state.holdConfirmation;
        // Auth deliberately does not disclose which credential failed.
        if (state.rejectCode) { res.writeHead(401); res.end(); return; }
        reply(200, { accessToken: token(req.url.endsWith("/mfa") ? mfa : passwordContext) }); return;
      }
      if (req.url === "/api/sensitive-action") {
        state.operations.push(body);
        const needed = state.accepted.length > 0 ? mfa : passwordContext;
        if (req.headers.authorization === "Bearer " + token(needed)) { state.commits++; reply(200, { completed: true }); return; }
        const contexts = state.accepted.length ? `, acr_values="${state.accepted.join(" ")}"` : "";
        res.setHeader("WWW-Authenticate", `Bearer error="insufficient_user_authentication"${contexts}, max_age="600"`);
        reply(401, { title: "Security.InsufficientAuthentication", detail: "A stronger or more recent authentication event is required." }); return;
      }
      reply(404, { title: "Unexpected fixture request" });
    })().catch(error => { runtimeErrors.push(String(error)); res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture API address");
  const entry = normalizePath(process.cwd() + "/__authentication_recovery_fixture.tsx");
  web = await createServer({
    configFile: false, root: process.cwd(), cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-auth-recovery-")), logLevel: "error",
    define: { "import.meta.env.VITE_BUNKFY_API_BASE_URL": JSON.stringify(`http://127.0.0.1:${address.port}`) },
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "react-router", "@tanstack/react-query", "lucide-react"] },
    plugins: [react(), {
      name: "authentication-recovery-fixture",
      resolveId: id => id === entry || id === "/__authentication_recovery_fixture.tsx" ? entry : undefined,
      load: id => id === entry ? fixture : undefined,
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__authentication-recovery")) return next();
        void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__authentication_recovery_fixture.tsx"></script></body></html>')
          .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
      }); },
    }], server: { host: "127.0.0.1", port: 0 },
  });
  await web.listen(); origin = web.resolvedUrls!.local[0]!;
  browser = await launchNativeChromium();
}, 60000);

afterAll(async () => {
  await browser?.close(); await web?.close();
  if (api) await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  expect(runtimeErrors).toEqual([]);
});

async function open(accepted: string[] = [mfa], exposeChallenge = true): Promise<{ context: BrowserContext; page: Page }> {
  state = { accepted, operations: [], confirmations: [], refreshes: 0, commits: 0, rejectCode: false, exposeChallenge };
  const context = await browser.newContext();
  await context.addInitScript(value => localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(value)), identity);
  const page = await context.newPage();
  page.on("pageerror", error => runtimeErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of 401")) runtimeErrors.push(message.text()); });
  await page.goto(origin + "__authentication-recovery");
  await expect.poll(() => page.locator("[data-session]").textContent()).toBe(identity.username);
  await page.getByRole("button", { name: "Run action", exact: true }).click();
  return { context, page };
}

describe("native authentication assurance recovery", () => {
  it.each(["totp", "recovery-code"])("satisfies the MFA challenge with %s and resumes the identical command", async codeType => {
    const { context, page } = await open();
    try {
      await page.getByLabel("Authenticator code", { exact: true }).waitFor();
      expect(state.operations).toHaveLength(1);
      expect(state.refreshes).toBe(1);
      if (codeType === "recovery-code") await page.getByRole("tab", { name: "Recovery code", exact: true }).click();
      await page.getByLabel("Current password", { exact: true }).fill("synthetic-password");
      await page.getByLabel(codeType === "totp" ? "Authenticator code" : "Recovery code", { exact: true }).fill(codeType === "totp" ? "123456" : "synthetic-recovery-code");
      await page.getByRole("button", { name: "Confirm and retry", exact: true }).click();
      await expect.poll(() => page.locator("[data-result]").textContent()).toBe("Complete");
      expect(state.confirmations).toEqual([{ endpoint: "/api/auth/browser/step-up/mfa", body: { password: "synthetic-password", codeType, code: codeType === "totp" ? "123456" : "synthetic-recovery-code" } }]);
      expect(state.operations).toHaveLength(2); expect(state.operations[1]).toEqual(state.operations[0]); expect(state.commits).toBe(1);
    } finally { await context.close(); }
  }, 15000);

  it("retains the password-only freshness path without a redundant refresh", async () => {
    const { context, page } = await open([]);
    try {
      await page.getByLabel("Current password", { exact: true }).waitFor();
      expect(state.operations).toHaveLength(1); expect(state.refreshes).toBe(1);
      await page.getByLabel("Current password", { exact: true }).fill("synthetic-password");
      await page.getByRole("button", { name: "Confirm and retry", exact: true }).click();
      await expect.poll(() => page.locator("[data-result]").textContent()).toBe("Complete");
      expect(state.confirmations).toEqual([{ endpoint: "/api/auth/browser/step-up/password", body: { password: "synthetic-password" } }]);
      expect(state.operations[1]).toEqual(state.operations[0]); expect(state.commits).toBe(1);
    } finally { await context.close(); }
  }, 15000);

  it("keeps the command pending after a rejected MFA code", async () => {
    const { context, page } = await open();
    try {
      await page.getByLabel("Authenticator code", { exact: true }).waitFor(); state.rejectCode = true;
      await page.getByLabel("Current password", { exact: true }).fill("synthetic-password");
      await page.getByLabel("Authenticator code", { exact: true }).fill("000000");
      await page.getByRole("button", { name: "Confirm and retry", exact: true }).click();
      await page.getByText("Verification could not be completed. Check your password and code, or sign in again.", { exact: true }).waitFor();
      expect(state.operations).toHaveLength(1); expect(state.confirmations).toHaveLength(1); expect(state.commits).toBe(0);
      expect(await page.locator("[data-result]").textContent()).toBe("Pending");
    } finally { await context.close(); }
  }, 15000);

  it("offers explicit MFA recovery when a legacy CORS response hides the hint", async () => {
    const { context, page } = await open([mfa], false);
    try {
      await page.getByRole("button", { name: "Use MFA instead", exact: true }).click();
      await page.getByLabel("Current password", { exact: true }).fill("synthetic-password");
      await page.getByLabel("Authenticator code", { exact: true }).fill("123456");
      await page.getByRole("button", { name: "Confirm and retry", exact: true }).click();
      await expect.poll(() => page.locator("[data-result]").textContent()).toBe("Complete");
      expect(state.confirmations[0]?.endpoint).toBe("/api/auth/browser/step-up/mfa");
      expect(state.operations).toHaveLength(2); expect(state.operations[1]).toEqual(state.operations[0]);
    } finally { await context.close(); }
  }, 15000);

  it("does not substitute password or MFA for an unsupported context", async () => {
    const { context, page } = await open(["urn:other:unsupported"]);
    try {
      await page.getByText("A different sign-in method is required", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Confirm and retry", exact: true }).count()).toBe(0);
      expect(state.confirmations).toEqual([]); expect(state.operations).toHaveLength(1); expect(state.commits).toBe(0);
    } finally { await context.close(); }
  }, 15000);

  it("clears secrets and refuses to resume after concealment during MFA", async () => {
    const { context, page } = await open();
    let release: (() => void) | undefined;
    try {
      await page.getByLabel("Authenticator code", { exact: true }).waitFor();
      state.holdConfirmation = new Promise<void>(resolve => { release = resolve; });
      await page.getByLabel("Current password", { exact: true }).fill("synthetic-password");
      await page.getByLabel("Authenticator code", { exact: true }).fill("123456");
      await page.getByRole("button", { name: "Confirm and retry", exact: true }).click();
      await expect.poll(() => state.confirmations.length).toBe(1);
      expect(await page.getByRole("button", { name: "Confirm and retry", exact: true }).locator(".loading").count()).toBe(1);
      await page.evaluate(() => (window as unknown as { recoveryHarness: { conceal(): void } }).recoveryHarness.conceal());
      await expect.poll(() => page.locator("[data-session]").textContent()).toBe("Signed out");
      expect(await page.getByLabel("Current password", { exact: true }).inputValue()).toBe("");
      expect(await page.getByLabel("Authenticator code", { exact: true }).inputValue()).toBe("");
      release!();
      // Wait for the held confirmation's finally block, rather than checking
      // the retry counter while the old response is still in flight.
      await expect.poll(() => page.getByRole("button", { name: "Confirm and retry", exact: true }).locator(".loading").count()).toBe(0);
      await expect.poll(() => page.getByRole("button", { name: "Confirm and retry", exact: true }).isDisabled()).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { resumeCount?: number }).resumeCount ?? 0)).toBe(0);
      expect(state.operations).toHaveLength(1); expect(state.commits).toBe(0);
      expect(await page.locator("[data-result]").textContent()).toBe("Pending");
    } finally { release?.(); await context.close(); }
  }, 15000);

});
