import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchNativeChromium } from "./support/nativeChromium";

// Actual export component, session provider, query lifecycle and browser Blob
// download. The loopback HTTP service models owner responses, not genuine Auth.
const subject = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const identity = { tenantId: "fixture-workspace", username: "owner@example.test", subjectId: subject, sessionId, generation: "export-fixture" };
const token = (acr: string) => `e30.${Buffer.from(JSON.stringify({ sub: subject, sid: sessionId, acr })).toString("base64url")}.synthetic`;
const artifact = { id: "33333333-3333-4333-8333-333333333333", version: 7, status: 3, expiresAtUtc: "2100-01-01T00:00:00Z" };
const basePath = "/api/privacy-fixture/case-a";
const downloadPath = `${basePath}/export/${artifact.id}/download`;
const mfa = "urn:gma:acr:mfa";
const fixture = `
import React,{useEffect,useState} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient,QueryClientProvider,useIsMutating} from "@tanstack/react-query";
import {BrowserRouter} from "react-router";
import {SessionProvider,useSession} from "/src/app/session.tsx";
import {PrivacyRequestExport} from "/src/features/data-rights/PrivacyRequestExport.tsx";
import {dataRightsOperatorScopeKey,dataRightsExportQueryKey} from "/src/features/data-rights/dataRightsSourceAuthority.ts";
const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
function Fixture(){
 const auth=useSession(),mutating=useIsMutating();
 const [caseValue,setCase]=useState({id:"case-a",version:11,status:5,decisionRevision:4,selectedSubjectCount:2});
 const [canDownload,setCanDownload]=useState(true),[permissionCurrent,setPermissionCurrent]=useState(true),[caseCurrent,setCaseCurrent]=useState(true);
 const operator=dataRightsOperatorScopeKey(auth.session),scope="staff";
 useEffect(()=>{window.exportHarness={
  update:(kind)=>{
   if(kind==="permission")setCanDownload(false);
   if(kind==="permission-restore")setCanDownload(true);
   if(kind==="permission-source")setPermissionCurrent(false);
   if(kind==="case")setCase(value=>({...value,version:value.version+1}));
   if(kind==="case-source")setCaseCurrent(false);
   if(kind==="artifact-version"||kind==="artifact-status")client.setQueryData(dataRightsExportQueryKey(scope,"case-a",operator),value=>({...value,...(kind==="artifact-version"?{version:value.version+1}:{status:5})}));
   if(kind==="workspace")auth.selectWorkspace("another-workspace");
  },adopt:auth.adoptBrowserAccount,conceal:auth.concealForAccountTransition
 };},[auth,operator]);
 return <main><output data-session>{auth.session?.username??"Signed out"}</output><output data-mutating>{mutating}</output>
 {auth.session&&<PrivacyRequestExport basePath="${basePath}" scopeKey={scope} dataRightsCase={caseValue} canGenerate={false} canDownload={canDownload} operatorScopeKey={operator} permissionCurrent={permissionCurrent} caseCurrent={caseCurrent} selectedEvidenceCurrent={true} onTerminalState={async()=>{}}/>}</main>;
}
createRoot(document.getElementById("root")).render(<BrowserRouter><QueryClientProvider client={client}><SessionProvider><Fixture/></SessionProvider></QueryClientProvider></BrowserRouter>);
`;

type State = {
  allowDownload: boolean;
  downloads: { path: string; authorization?: string }[];
  confirmations: unknown[];
  refreshes: number;
  holdDownload?: Promise<void>;
  holdConfirmation?: Promise<void>;
  rejectCode?: boolean;
  contexts?: string[];
};
let state: State;
let api: Server;
let web: ViteDevServer;
let browser: Browser;
let origin = "";
const runtimeErrors: string[] = [];

beforeAll(async () => {
  api = createHttpServer((req, res) => {
    void (async () => {
      res.setHeader("Access-Control-Allow-Origin", new URL(origin).origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Content-Disposition");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] ?? "Content-Type, Authorization, X-Tenant-Id");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw new Error("Oversized fixture request"); }
      const reply = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/api/auth/browser/refresh") { state.refreshes++; reply(200, { accessToken: token("old") }); return; }
      if (req.url === `${basePath}/export`) { reply(200, artifact); return; }
      if (req.url === "/api/auth/browser/step-up/mfa") {
        state.confirmations.push(JSON.parse(raw));
        if (state.holdConfirmation) await state.holdConfirmation;
        if (state.rejectCode) { res.writeHead(401); res.end(); return; }
        state.allowDownload = true; reply(200, { accessToken: token(mfa) }); return;
      }
      if (req.url === downloadPath) {
        state.downloads.push({ path: req.url, authorization: req.headers.authorization });
        if (!state.allowDownload) {
          res.setHeader("WWW-Authenticate", `Bearer error="insufficient_user_authentication", acr_values="${(state.contexts ?? [mfa, "urn:gma:acr:two-step"]).join(" ")}", max_age="600"`);
          reply(401, { title: "Security.InsufficientAuthentication", detail: "Recent MFA is required." }); return;
        }
        if (state.holdDownload) await state.holdDownload;
        res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="owned-export.json"' });
        res.end(JSON.stringify({ subject: "owned-fixture-records" })); return;
      }
      reply(404, { title: "Unexpected fixture request" });
    })().catch(error => { runtimeErrors.push(String(error)); res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture API port");
  const entry = normalizePath(process.cwd() + "/__privacy_export_auth_fixture.tsx");
  web = await createServer({
    configFile: false, root: process.cwd(), cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-export-auth-")), logLevel: "error",
    define: { "import.meta.env.VITE_BUNKFY_API_BASE_URL": JSON.stringify(`http://127.0.0.1:${address.port}`) },
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "react-router", "@tanstack/react-query", "lucide-react"] },
    plugins: [react(), {
      name: "privacy-export-auth-fixture",
      resolveId: id => id === entry || id === "/__privacy_export_auth_fixture.tsx" ? entry : undefined,
      load: id => id === entry ? fixture : undefined,
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__privacy-export-auth")) return next();
        void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__privacy_export_auth_fixture.tsx"></script></body></html>')
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

async function open(allowDownload = false): Promise<{ context: BrowserContext; page: Page }> {
  state = { allowDownload, downloads: [], confirmations: [], refreshes: 0 };
  const context = await browser.newContext();
  await context.addInitScript(value => {
    localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(value));
    const createObjectURL = URL.createObjectURL.bind(URL);
    (window as unknown as { exportedBlobs: number }).exportedBlobs = 0;
    URL.createObjectURL = blob => { (window as unknown as { exportedBlobs: number }).exportedBlobs++; return createObjectURL(blob); };
  }, identity);
  const page = await context.newPage();
  page.on("pageerror", error => runtimeErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of 401")) runtimeErrors.push(message.text()); });
  await page.goto(origin + "__privacy-export-auth");
  await expect.poll(() => page.locator("[data-session]").textContent()).toBe(identity.username);
  await expect.poll(() => page.getByRole("button", { name: "Download", exact: true }).isEnabled()).toBe(true);
  return { context, page };
}

describe("native protected privacy-export download", () => {
  it.each(["unchanged", "permission", "permission-source", "artifact-version", "artifact-status", "case", "case-source"])("releases bytes only for a current authorized artifact after %s", async boundary => {
    const { context, page } = await open(true);
    let release!: () => void;
    state.holdDownload = new Promise<void>(resolve => { release = resolve; });
    try {
      await page.getByRole("button", { name: "Download", exact: true }).click();
      await expect.poll(() => state.downloads.length).toBe(1);
      await expect.poll(() => page.locator("[data-mutating]").textContent()).toBe("1");
      if (boundary !== "unchanged") await page.evaluate(value => (window as unknown as { exportHarness: { update(kind: string): void } }).exportHarness.update(value), boundary);
      release();
      await expect.poll(() => page.locator("[data-mutating]").textContent()).toBe("0");
      expect(await page.evaluate(() => (window as unknown as { exportedBlobs: number }).exportedBlobs)).toBe(boundary === "unchanged" ? 1 : 0);
      expect(state.downloads).toHaveLength(1); expect(state.confirmations).toEqual([]);
    } finally { release(); await context.close(); }
  }, 15000);

  it.each(["totp", "recovery-code"])("recovers the actual export download with %s without replacing its submission", async codeType => {
    const { context, page } = await open();
    try {
      await page.getByRole("button", { name: "Download", exact: true }).click();
      await expect.poll(() => state.downloads.length).toBe(1);
      await page.getByLabel("Authenticator code", { exact: true }).waitFor({ timeout: 3000 });
      expect(state.refreshes).toBe(1);
      if (codeType === "recovery-code") await page.getByRole("tab", { name: "Recovery code", exact: true }).click();
      await page.getByLabel("Current password", { exact: true }).fill("synthetic-password");
      await page.getByLabel(codeType === "totp" ? "Authenticator code" : "Recovery code", { exact: true }).fill(codeType === "totp" ? "123456" : "synthetic-recovery-code");
      const downloaded = page.waitForEvent("download");
      await page.getByRole("button", { name: "Confirm and retry", exact: true }).click();
      expect((await downloaded).suggestedFilename()).toBe("owned-export.json");
      expect(state.downloads.map(value => value.path)).toEqual([downloadPath, downloadPath]);
      expect(state.downloads[1]?.authorization).toBe("Bearer " + token(mfa));
      expect(state.confirmations).toEqual([{ password: "synthetic-password", codeType, code: codeType === "totp" ? "123456" : "synthetic-recovery-code" }]);
      expect(await page.evaluate(() => (window as unknown as { exportedBlobs: number }).exportedBlobs)).toBe(1);
    } finally { await context.close(); }
  }, 15000);

  it.each(["permission", "permission-restored", "permission-source", "artifact-version", "artifact-status", "case", "case-source", "actor", "new-session", "workspace", "conceal"])("does not resume an export after %s changes during MFA", async boundary => {
    const { context, page } = await open();
    let release!: () => void;
    state.holdConfirmation = new Promise<void>(resolve => { release = resolve; });
    try {
      await page.getByRole("button", { name: "Download", exact: true }).click();
      await page.getByLabel("Current password", { exact: true }).fill("synthetic-password");
      await page.getByLabel("Authenticator code", { exact: true }).fill("123456");
      await page.getByRole("button", { name: "Confirm and retry", exact: true }).click();
      await expect.poll(() => state.confirmations.length).toBe(1);
      if (boundary === "actor" || boundary === "new-session") {
        const nextSubject = boundary === "actor" ? "44444444-4444-4444-8444-444444444444" : subject;
        const nextSession = "55555555-5555-4555-8555-555555555555";
        const accessToken = `e30.${Buffer.from(JSON.stringify({ sub: nextSubject, sid: nextSession })).toString("base64url")}.synthetic`;
        await page.evaluate(account => (window as unknown as { exportHarness: { adopt(value: unknown): void } }).exportHarness.adopt(account), { ...identity, subjectId: nextSubject, sessionId: nextSession, generation: "replacement", accessToken });
      } else if (boundary === "conceal") {
        await page.evaluate(() => (window as unknown as { exportHarness: { conceal(): void } }).exportHarness.conceal());
      } else {
        await page.evaluate(kind => (window as unknown as { exportHarness: { update(value: string): void } }).exportHarness.update(kind), boundary === "permission-restored" ? "permission" : boundary);
      }
      await expect.poll(() => page.getByLabel("Current password", { exact: true }).count()).toBe(0);
      if (boundary === "permission-restored") {
        await page.evaluate(() => (window as unknown as { exportHarness: { update(kind: string): void } }).exportHarness.update("permission-restore"));
        await expect.poll(() => page.getByRole("button", { name: "Download", exact: true }).isEnabled()).toBe(true);
      }
      const response = page.waitForResponse(value => value.url().endsWith("/api/auth/browser/step-up/mfa"));
      release();
      await (await response).finished();
      await page.waitForLoadState("networkidle", { timeout: 5000 });
      expect(state.downloads).toHaveLength(1);
      expect(await page.evaluate(() => (window as unknown as { exportedBlobs: number }).exportedBlobs)).toBe(0);
      expect(await page.getByLabel("Current password", { exact: true }).count()).toBe(0);
    } finally { release(); await context.close(); }
  }, 15000);

  it("keeps the original export pending after rejected credentials and accepts an explicit retry", async () => {
    const { context, page } = await open();
    state.rejectCode = true;
    try {
      await page.getByRole("button", { name: "Download", exact: true }).click();
      await page.getByLabel("Current password", { exact: true }).fill("synthetic-password");
      await page.getByLabel("Authenticator code", { exact: true }).fill("000000");
      await page.getByRole("button", { name: "Confirm and retry", exact: true }).click();
      await page.getByText("Verification could not be completed. Check your password and code, or sign in again.", { exact: true }).waitFor();
      expect(state.downloads).toHaveLength(1); expect(state.refreshes).toBe(1);
      expect(await page.locator("[data-session]").textContent()).toBe(identity.username);
      state.rejectCode = false;
      await page.getByLabel("Authenticator code", { exact: true }).fill("123456");
      const downloaded = page.waitForEvent("download");
      await page.getByRole("button", { name: "Confirm and retry", exact: true }).click();
      expect((await downloaded).suggestedFilename()).toBe("owned-export.json");
      expect(state.downloads.map(value => value.path)).toEqual([downloadPath, downloadPath]);
      expect(state.confirmations).toHaveLength(2);
    } finally { await context.close(); }
  }, 15000);

  it("retains a sign-in fallback when only the external-primary context is accepted", async () => {
    const { context, page } = await open();
    state.contexts = ["urn:gma:acr:two-step"];
    try {
      await page.getByRole("button", { name: "Download", exact: true }).click();
      await page.getByText("A different sign-in method is required", { exact: true }).waitFor();
      expect(await page.getByRole("link", { name: "Account security", exact: true }).getAttribute("href")).toBe("/account?section=security");
      expect(await page.getByLabel("Current password", { exact: true }).count()).toBe(0);
      expect(state.downloads).toHaveLength(1); expect(state.confirmations).toEqual([]);
    } finally { await context.close(); }
  }, 15000);
});
