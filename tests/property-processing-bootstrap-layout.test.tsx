import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Actual shared panel, React Query, styles and native browser interaction.
// Permission/API responses are deliberate fixtures, not real API or role proof.
const fixture = `
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {ApiError} from "/src/api/client.ts";
import {compositeSourceCurrent} from "/src/app/compositeSourceState.ts";
import {PropertyProcessingPanel} from "/src/features/properties/PropertyProcessingPanel.tsx";
import "/src/styles.css";
const params=new URLSearchParams(location.search);
const property={propertyId:"property",name:"Riverside House",code:"RIVER",status:"active",version:3};
const binding={operatingCountryCode:"GB",policyId:"qa-policy",policyVersion:1,contentSha256:"fixture",dataRegionId:"uk",transferProfileId:"local",retentionPolicyId:"qa-retention",retentionPolicyVersion:1,activatedAtUtc:"2026-01-01T00:00:00Z",policyEffectiveAtUtc:"2020-01-01T00:00:00Z",policyExpiresAtUtc:"2099-01-01T00:00:00Z",acknowledgements:[]};
const processing={propertyId:"property",propertyVersion:3,configuredStatus:"enabled",effectiveStatus:"enabled",reasonCode:null,governancePolicy:binding};
const policies={items:[{...binding,launchStatus:"enabled",effectiveAtUtc:"2020-01-01T00:00:00Z",expiresAtUtc:"2099-01-01T00:00:00Z",accommodationTypes:["hostel"],permittedDataRegions:["uk"],permittedTransferProfiles:["local"],retentionPolicies:[{retentionPolicyId:"qa-retention",retentionPolicyVersion:1}],requiredAcknowledgements:[]}]};
window.processingRequests=[];
window.processingRead={status:Number(params.get("status")||200),pending:params.has("pending")};
window.policyReadStatus=200;
window.permissionRetries=0;
window.processingFixtureRequest=async(path,options)=>{
 window.processingRequests.push({path,method:options?.method||"GET"});
 if(options?.method && options.method!=="GET")throw Error("Fixture writes forbidden");
 if(path.endsWith("/country-policies")){
  const status=window.policyReadStatus;
  if(window.holdPolicyRead)await new Promise(resolve=>{window.releasePolicy=resolve;});
  if(status!==200)throw new ApiError("Unavailable",status);
  return policies;
 }
 if(path.endsWith("/processing")){
  const {status,pending}=window.processingRead;
  if(pending)await new Promise(resolve=>{window.releaseProcessing=resolve;});
  if(status!==200)throw new ApiError("Request failed",status);
  return processing;
 }
 throw Error("Unexpected fixture request: "+path);
};
const client=new QueryClient({defaultOptions:{queries:{retry:false,retryOnMount:false,refetchOnWindowFocus:false,refetchOnReconnect:false}}});
function Fixture(){
 const initial=params.get("permission")||"ready";
 const [permission,setPermission]=useState({state:initial==="refreshing"?"ready":initial,isFetching:initial==="loading"||initial==="refreshing"});
 const source={label:"Property permissions",...permission,refetch:async()=>{
  window.permissionRetries++;
  setPermission(p=>({...p,isFetching:true}));
  if(window.holdPermissionRetry)await new Promise(resolve=>{window.releasePermission=resolve;});
  setPermission({state:window.permissionRetryState||"ready",isFetching:false});
 }};
 window.processingHarness={setPermission,refetch:()=>client.invalidateQueries({queryKey:["property-processing","property"],exact:true}),refetchPolicies:()=>client.invalidateQueries({queryKey:["country-policies","property"],exact:true})};
 return <QueryClientProvider client={client}><main className="p-2 sm:p-6"><h1 className="mb-4 text-lg font-semibold">{params.has("embedded")?"Spaces · Property settings":"Properties"}</h1><PropertyProcessingPanel property={property} embedded={params.has("embedded")} canManage={!params.has("viewer")} permissionSource={source} permissionsCurrent={compositeSourceCurrent(source)} propertyCurrent onChanged={async()=>{}}/><button type="button" className="btn btn-ghost mt-4">Independent navigation</button></main></QueryClientProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture/>);
`;

let server: ViteDevServer;
let browser: Browser;
let origin: string;
const runtimeErrors: string[] = [];
beforeAll(async () => {
  const entry = normalizePath(process.cwd() + "/__property_processing_fixture.tsx");
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-property-processing-vite-")), logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "react-router", "@tanstack/react-query", "lucide-react", "@radix-ui/react-popover", "@radix-ui/react-select", "@daypicker/react"] },
    plugins: [react(), tailwindcss(), {
      name: "property-processing-fixture",
      resolveId: id => id === "/__property_processing_fixture.tsx" || id === entry ? entry : undefined,
      load(id) {
        if (id === entry) return fixture;
        if (id === normalizePath(process.cwd() + "/src/app/session.tsx")) return 'const request=(...args)=>window.processingFixtureRequest(...args); export function useSession(){return {request};}';
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__property-processing")) return next();
        void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__property_processing_fixture.tsx"></script></body></html>')
          .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
      }); },
    }], server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen(); origin = server.resolvedUrls!.local[0]; browser = await launchNativeChromium();
}, 60000);
afterAll(async () => { await browser?.close(); await server?.close(); expect(runtimeErrors).toEqual([]); });

type FixtureWindow = {
  processingRequests: { path: string; method: string }[];
  processingRead: { status: number; pending: boolean };
  policyReadStatus: number;
  holdPolicyRead: boolean;
  releasePolicy: () => void;
  permissionRetries: number;
  permissionRetryState: string;
  holdPermissionRetry: boolean;
  releasePermission: () => void;
  releaseProcessing: () => void;
  processingHarness: {
    setPermission: (value: { state: string; isFetching: boolean }) => void;
    refetch: () => Promise<unknown>;
    refetchPolicies: () => Promise<unknown>;
  };
};
async function open(width: number, embedded: boolean, query = "") {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => runtimeErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") runtimeErrors.push(message.text()); });
  await page.goto(origin + "__property-processing?" + (embedded ? "embedded&" : "") + query);
  await page.getByRole("heading", { level: 1 }).waitFor();
  return page;
}
async function permission(page: Page, state: string, isFetching = false) {
  await page.evaluate(value => (window as unknown as FixtureWindow).processingHarness.setPermission(value), { state, isFetching });
}
async function setRead(page: Page, status: number, pending = false) {
  await page.evaluate(value => { (window as unknown as FixtureWindow).processingRead = value; }, { status, pending });
}
async function count(page: Page, suffix = "/processing") {
  return page.evaluate(suffix => (window as unknown as FixtureWindow).processingRequests.filter(request => request.path.endsWith(suffix)).length, suffix);
}
async function noWritesOrOverflow(page: Page) {
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).processingRequests.filter(request => request.method !== "GET"))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function capture(page: Page, name: string) {
  const directory = process.env.BUNKFY_PROPERTY_PROCESSING_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name), fullPage: true });
}
async function tabToRetry(page: Page) {
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  for (let n = 0; n < 20 && !await retry.evaluate(element => element === document.activeElement); n++) await page.keyboard.press("Tab");
  expect(await retry.evaluate(element => element === document.activeElement)).toBe(true);
  return retry;
}
const variants = [
  { width: 320, embedded: false }, { width: 1024, embedded: false },
  { width: 320, embedded: true }, { width: 1024, embedded: true },
];

describe.each(variants)("property processing $width embedded=$embedded", ({ width, embedded }) => {
  it("distinguishes permission checking, ready-refreshing and the admitted pending GET", async () => {
    const page = await open(width, embedded, "permission=loading&pending");
    try {
      await page.getByText("Checking data-processing access", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Try again" }).count()).toBe(0);
      expect(await page.getByText(/unavailable|delayed/).count()).toBe(0);
      expect(await count(page)).toBe(0);
      await capture(page, `checking-${width}-${embedded}.png`);
      await permission(page, "ready", true);
      await page.getByText("Checking data-processing access", { exact: true }).waitFor();
      expect(await count(page)).toBe(0);
      await permission(page, "ready");
      await page.getByText("Loading data processing", { exact: true }).waitFor();
      expect(await count(page)).toBe(1);
      expect(await page.getByRole("button", { name: "Try again" }).count()).toBe(0);
      await page.evaluate(() => (window as unknown as FixtureWindow).releaseProcessing());
      await page.getByRole("button", { name: "Suspend", exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Change policy", exact: true }).isEnabled()).toBe(true);
      await noWritesOrOverflow(page);
    } finally { await page.close(); }
  });

  it.each(["unavailable", "stale"])("retries only %s permission evidence before admitting processing", async state => {
    const page = await open(width, embedded, "permission=" + state);
    try {
      await page.getByText("Data-processing access could not be confirmed", { exact: true }).waitFor();
      expect(await page.getByText("Data processing unavailable", { exact: true }).count()).toBe(0);
      expect(await count(page)).toBe(0);
      await page.evaluate(() => { (window as unknown as FixtureWindow).holdPermissionRetry = true; });
      const retry = await tabToRetry(page);
      await page.keyboard.press("Enter");
      await expect.poll(() => retry.isDisabled()).toBe(true);
      await page.keyboard.press("Enter"); await page.keyboard.press("Space");
      expect(await page.evaluate(() => (window as unknown as FixtureWindow).permissionRetries)).toBe(1);
      expect(await count(page)).toBe(0);
      await page.evaluate(() => (window as unknown as FixtureWindow).releasePermission());
      await page.getByRole("button", { name: "Suspend", exact: true }).waitFor();
      expect(await count(page)).toBe(1);
      await expect.poll(() => page.locator("[data-processing-heading]").evaluate(element => element === document.activeElement)).toBe(true);
      await noWritesOrOverflow(page);
    } finally { await page.close(); }
  });

  it("gives genuine 503 one retry, blocks offline/repeated activation, then recovers", async () => {
    const page = await open(width, embedded, "status=503");
    try {
      await page.getByText("Data processing could not be loaded", { exact: true }).waitFor();
      expect(await page.getByRole("alert").count()).toBe(1);
      expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(1);
      await capture(page, `failed-${width}-${embedded}.png`);
      await page.context().setOffline(true);
      await page.getByText("Reconnect before loading data processing.", { exact: true }).waitFor();
      const retry = page.getByRole("button", { name: "Try again", exact: true });
      expect(await retry.isDisabled()).toBe(true);
      await retry.evaluate(button => (button as HTMLButtonElement).click());
      expect(await count(page)).toBe(1);
      await page.context().setOffline(false);
      await setRead(page, 200, true);
      await tabToRetry(page);
      await page.keyboard.press("Enter");
      await page.getByText("Loading data processing", { exact: true }).waitFor();
      await page.keyboard.press("Enter"); await page.keyboard.press("Space");
      expect(await count(page)).toBe(2);
      await page.evaluate(() => (window as unknown as FixtureWindow).releaseProcessing());
      await page.getByRole("button", { name: "Suspend", exact: true }).waitFor();
      expect(await page.getByRole("alert").count()).toBe(0);
      await expect.poll(() => page.locator("[data-processing-heading]").evaluate(element => element === document.activeElement)).toBe(true);
      await noWritesOrOverflow(page);
    } finally { await page.close(); }
  });

  it("keeps a genuine 403 distinct from an unavailable service", async () => {
    const page = await open(width, embedded, "status=403&viewer");
    try {
      await page.getByText("Data-processing access denied", { exact: true }).waitFor();
      expect(await page.getByText("Your current workspace role does not allow this action.", { exact: true }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(0);
      expect(await count(page, "/country-policies")).toBe(0);
      await noWritesOrOverflow(page);
    } finally { await page.close(); }
  });

  it("retains stale facts, disables writes, and keeps permission/policy recovery independent", async () => {
    const page = await open(width, embedded);
    try {
      await page.getByRole("button", { name: "Suspend", exact: true }).waitFor();
      await setRead(page, 503);
      await page.evaluate(() => (window as unknown as FixtureWindow).processingHarness.refetch());
      await page.getByText("Processing status is showing its last confirmed snapshot.", { exact: true }).waitFor();
      await page.getByText("Last confirmed configuration", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Change policy", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Suspend", exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "Show policy details", exact: true }).click();
      await page.getByText("qa-retention v1", { exact: true }).waitFor();
      await capture(page, `stale-${width}-${embedded}.png`);
      await permission(page, "ready", true);
      await page.getByText("Checking data-processing access. Changes are paused.", { exact: true }).waitFor();
      await permission(page, "unavailable");
      await page.getByText("Data-processing access could not be confirmed", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(1);
      await setRead(page, 200);
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await page.getByRole("button", { name: "Suspend", exact: true }).waitFor();
      const processingReads = await count(page);
      await page.evaluate(async () => { const state = window as unknown as FixtureWindow; state.policyReadStatus = 503; await state.processingHarness.refetchPolicies(); });
      await page.getByText("Country policies could not be confirmed", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Change policy", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Suspend", exact: true }).isEnabled()).toBe(true);
      expect(await page.getByText("Data-processing context is delayed", { exact: true }).count()).toBe(0);
      await page.evaluate(() => { (window as unknown as FixtureWindow).policyReadStatus = 200; });
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await expect.poll(() => page.getByRole("button", { name: "Change policy", exact: true }).isEnabled()).toBe(true);
      expect(await count(page)).toBe(processingReads);
      await noWritesOrOverflow(page);
    } finally { await page.close(); }
  });

  it.each(["processing", "permission", "policy"] as const)("restores retained %s retry focus after failure and respects independent navigation", async source => {
    const page = await open(width, embedded);
    try {
      await page.getByRole("button", { name: "Suspend", exact: true }).waitFor();
      const fault = async () => page.evaluate(async source => {
        const state = window as unknown as FixtureWindow;
        if (source === "permission") {
          state.permissionRetryState = "unavailable";
          state.processingHarness.setPermission({ state: "unavailable", isFetching: false });
        } else if (source === "policy") {
          state.holdPolicyRead = false; state.policyReadStatus = 503;
          await state.processingHarness.refetchPolicies();
        } else {
          state.processingRead = { status: 503, pending: false };
          await state.processingHarness.refetch();
        }
      }, source);
      const hold = async (succeed: boolean) => page.evaluate(({ source, succeed }) => {
        const state = window as unknown as FixtureWindow;
        if (source === "permission") { state.holdPermissionRetry = true; state.permissionRetryState = succeed ? "ready" : "unavailable"; }
        else if (source === "policy") { state.holdPolicyRead = true; state.policyReadStatus = succeed ? 200 : 503; }
        else state.processingRead = { status: succeed ? 200 : 503, pending: true };
      }, { source, succeed });
      const release = async () => page.evaluate(source => {
        const state = window as unknown as FixtureWindow;
        if (source === "permission") { state.holdPermissionRetry = false; state.releasePermission(); }
        else if (source === "policy") { state.holdPolicyRead = false; state.releasePolicy(); }
        else { state.processingRead.pending = false; state.releaseProcessing(); }
      }, source);
      await fault();
      const retry = page.locator(`[data-processing-recovery="${source}"]`).getByRole("button", { name: "Try again", exact: true });
      await retry.waitFor();
      await hold(false); await tabToRetry(page); await page.keyboard.press("Enter");
      await expect.poll(() => retry.isDisabled()).toBe(true);
      await release();
      await expect.poll(() => retry.isEnabled()).toBe(true);
      await expect.poll(() => retry.evaluate(element => element === document.activeElement)).toBe(true);

      await hold(true); await page.keyboard.press("Enter");
      await expect.poll(() => retry.isDisabled()).toBe(true);
      await release();
      await expect.poll(() => page.locator("[data-processing-heading]").evaluate(element => element === document.activeElement)).toBe(true);

      await fault(); await retry.waitFor(); await hold(true); await tabToRetry(page); await page.keyboard.press("Enter");
      await expect.poll(() => retry.isDisabled()).toBe(true);
      const independent = page.getByRole("button", { name: "Independent navigation", exact: true });
      await independent.focus(); await release();
      await expect.poll(() => retry.count()).toBe(0);
      await expect.poll(() => page.getByRole("button", { name: "Suspend", exact: true }).isEnabled()).toBe(true);
      expect(await independent.evaluate(element => element === document.activeElement)).toBe(true);
      await noWritesOrOverflow(page);
    } finally { await page.close(); }
  });

  it("does not expose cached processing facts after definitive 403", async () => {
    const page = await open(width, embedded);
    try {
      await page.getByRole("button", { name: "Suspend", exact: true }).waitFor();
      await setRead(page, 403);
      await page.evaluate(() => (window as unknown as FixtureWindow).processingHarness.refetch());
      await page.getByText("Data-processing access denied", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: /Change policy|Show policy details|Suspend|Try again/ }).count()).toBe(0);
      expect(await page.getByText("Last confirmed configuration", { exact: true }).count()).toBe(0);
      await noWritesOrOverflow(page);
    } finally { await page.close(); }
  });

  it.each(["Tab", "Escape"])("cancels retained recovery focus intent after deliberate %s", async key => {
    const page = await open(width, embedded);
    try {
      await page.getByRole("button", { name: "Suspend", exact: true }).waitFor();
      await setRead(page, 503);
      await page.evaluate(() => (window as unknown as FixtureWindow).processingHarness.refetch());
      const retry = await tabToRetry(page);
      await setRead(page, 503, true); await page.keyboard.press("Enter");
      await expect.poll(() => retry.isDisabled()).toBe(true);
      await page.keyboard.press(key);
      const focused = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent }));
      await page.evaluate(() => (window as unknown as FixtureWindow).releaseProcessing());
      await expect.poll(() => retry.isEnabled()).toBe(true);
      expect(await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent }))).toEqual(focused);
      expect(await retry.evaluate(element => element === document.activeElement)).toBe(false);
      await noWritesOrOverflow(page);
    } finally { await page.close(); }
  });

  it("does not steal independent focus when keyboard retry completes", async () => {
    const page = await open(width, embedded, "status=503");
    try {
      await page.getByText("Data processing could not be loaded", { exact: true }).waitFor();
      await setRead(page, 200, true);
      await tabToRetry(page);
      await page.keyboard.press("Enter");
      await page.getByText("Loading data processing", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Independent navigation", exact: true }).focus();
      await page.evaluate(() => (window as unknown as FixtureWindow).releaseProcessing());
      await page.getByRole("button", { name: "Suspend", exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Independent navigation", exact: true }).evaluate(element => element === document.activeElement)).toBe(true);
      await noWritesOrOverflow(page);
    } finally { await page.close(); }
  });
});

it("passes actual permission sources through both owners without changing authority gates", () => {
  const source = (path: string) => readFileSync(new URL("../src/" + path, import.meta.url), "utf8");
  for (const path of ["features/properties/PropertiesPage.tsx", "features/spaces/SpacesPage.tsx", "features/spaces/SpacesPropertySection.tsx"]) {
    expect(source(path)).toContain("permissionSource={permissionSource}");
  }
  const panel = source("features/properties/PropertyProcessingPanel.tsx");
  expect(panel).toContain("permissionSource: CompositeSource;");
  expect(panel).toContain("enabled: permissionsCurrent,");
  expect(panel).toContain("enabled: permissionsCurrent && canManage,");
  expect(panel).toContain("processingCurrent: compositeSourceCurrent(processingSource)");
  expect(panel).toContain("policiesCurrent: compositeSourceCurrent(policySource)");
  expect(panel).not.toContain('state: permissionsCurrent ? "ready"');
});
