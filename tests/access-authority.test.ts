import { launchNativeChromium } from "./support/nativeChromium";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { type Browser, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ACCESS_AUTHORITY_REFRESH_INTERVAL_MS,
  accessAuthorityIdentity,
  accessAuthorityChecksMatchTenant,
  accessAuthorityQuerySurvivesScrub,
  grantedAccessPermissionKeys,
  evaluateAccessPermissionChecks,
  mergeAccessPermissionChecks,
  revokedAccessPermissionKeys,
} from "../src/app/accessAuthority";

const nativeFixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {AccessAuthorityProvider,useAccessPermissions} from '/src/app/accessAuthority.tsx';
import {WorkspaceProvider,useWorkspace} from '/src/app/workspace.tsx';
import {FixtureSession,useSession} from '/src/app/session.tsx';
import {ApiError} from '/src/api/client.ts';
window.authoritySession={tenantId:'tenant',username:'operator@example.invalid',subjectId:'actor',sessionId:'session',generation:'generation'};
window.authorityCalls=[];window.authorityPending=[];window.authorityHold=false;window.authorityStatus=200;window.authorityDenied=false;
window.catalogueCalls=[];window.loopCapped=false;window.loopStart=null;
window.authorityRequest=async(path,options)=>{
 if(path.startsWith('/api/organizations?')){window.catalogueCalls.push(path);await new Promise(r=>setTimeout(r,5));return {items:[{organization:{organizationId:'tenant',name:'Test hostel'}}]};}
 if(path.startsWith('/api/properties?')){window.catalogueCalls.push(path);await new Promise(r=>setTimeout(r,5));return {properties:[{propertyId:'property-a',name:'Test house'}],hasMore:false};}
 if(path!=='/api/access/permissions/evaluate')throw Error('Unexpected request');
 const {checks}=JSON.parse(options.body);if(!checks.length||checks.length>32)throw Error('API check cardinality violated');
 window.authorityCalls.push(checks);
 if(window.loopStart!==null&&window.authorityCalls.length-window.loopStart>24){window.loopCapped=true;window.authorityStatus=503;}
 const reply=(status,denied)=>{if(status!==200)throw new ApiError('Synthetic authority failure',status);return {permissions:checks.map(c=>({...c,allowed:!(denied&&c.permission==='staff.read')}))};};
 if(window.authorityHold)return new Promise((resolve,reject)=>window.authorityPending.push({checks,aborted:()=>!!options.signal?.aborted,finish:(status=200,denied=false)=>{try{resolve(reply(status,denied));}catch(error){reject(error);}}}));
 return reply(window.authorityStatus,window.authorityDenied);
};
const retryDelay=new URLSearchParams(location.search).get('retryDelay');
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false,...(retryDelay?{retryDelay:Number(retryDelay)}:{})}}});
window.authorityCache={put:()=>client.setQueryData(['sensitive-fixture'],'private'),get:()=>client.getQueryData(['sensitive-fixture'])??null,pending:()=>client.isFetching()};
function Probe(){
 const [extra,setExtra]=useState(0),{session}=useSession(),scope='tenant:'+session.tenantId;
 const checks=[{permission:'staff.read',scope},...Array.from({length:extra},(_,i)=>({permission:'staff.assign-properties',scope:scope+'/property:'+i}))];
 const access=useAccessPermissions(checks);
 window.authorityProbe={setExtra,refetch:access.refetch};
 return <output id='probe'>{JSON.stringify({allowed:access.allows('staff.read',scope),extraAllowed:access.allows('staff.assign-properties',scope+'/property:0'),hasData:access.hasData,fetching:access.isFetching,loading:access.isLoading,error:!!access.error,errorStatus:access.error?.status??null})}</output>;
}
function PropertyCommands(){const {selectedProperty}=useWorkspace();useAccessPermissions(selectedProperty?[{permission:'staff.assign-properties',scope:'tenant:tenant/property:'+selectedProperty.propertyId}]:[]);return <span>Protected commands</span>;}
function WorkspaceProbe(){
 const {selectedProperty}=useWorkspace();
 const checks=[{permission:'staff.read',scope:'tenant:tenant'},...(selectedProperty?[{permission:'properties.read',scope:'tenant:tenant/property:'+selectedProperty.propertyId}]:[])];
 const access=useAccessPermissions(checks),allowed=access.allows('staff.read','tenant:tenant');
 window.authorityProbe={refetch:access.refetch};
 return <><output id='probe'>{JSON.stringify({allowed,hasData:access.hasData,fetching:access.isFetching,loading:access.isLoading,error:!!access.error})}</output><div id='access-status' role='status'>{access.error?'Access unavailable':access.isLoading?'Loading access':allowed?'Protected staff facts':'Access denied'}</div>{allowed&&<PropertyCommands/>}</>;
}
const workspaceFixture=new URLSearchParams(location.search).has('workspace');
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><FixtureSession><AccessAuthorityProvider>{workspaceFixture?<WorkspaceProvider><WorkspaceProbe/></WorkspaceProvider>:<Probe/>}</AccessAuthorityProvider></FixtureSession></QueryClientProvider>);
`;
let nativeServer: ViteDevServer;
let nativeBrowser: Browser;
let nativeOrigin: string;
const nativeErrors: string[] = [];
beforeAll(async () => {
  const entry = normalizePath(process.cwd() + "/__authority_fixture.tsx");
  nativeServer = await createServer({ configFile: false, root: process.cwd(), cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-authority-")), logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "@tanstack/react-query"] },
    plugins: [react(), {
      name: "authority-native-fixture", resolveId: id => id === "/__authority_fixture.tsx" || id === entry ? entry : undefined,
      load(id) {
        if (id === entry) return nativeFixture;
        if (id === normalizePath(process.cwd() + "/src/app/session.tsx")) return `import React,{createContext,useContext,useState} from 'react';const Context=createContext(null),selectWorkspace=()=>{};export function FixtureSession({children}){const[session,setSession]=useState(window.authoritySession);window.replaceAuthoritySession=patch=>setSession(current=>({...current,...patch}));return <Context.Provider value={{session,selectWorkspace,request:(...args)=>window.authorityRequest(...args)}}>{children}</Context.Provider>;}export function useSession(){return useContext(Context);}`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/__authority") return next();
        void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__authority_fixture.tsx"></script></body></html>')
          .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
      }); },
    }], server: { host: "127.0.0.1", port: 0 },
  });
  await nativeServer.listen(); nativeOrigin = nativeServer.resolvedUrls!.local[0]; nativeBrowser = await launchNativeChromium();
}, 60000);
afterAll(async () => { await nativeBrowser?.close(); await nativeServer?.close(); expect(nativeErrors).toEqual([]); });
type ProbeState = { allowed: boolean; extraAllowed: boolean; hasData: boolean; fetching: boolean; loading: boolean; error: boolean };
async function probe(page: Page): Promise<ProbeState> { return JSON.parse(await page.locator("#probe").innerText()); }
async function nativeOpen(workspace = false, retryDelay?: number) {
  const page = await nativeBrowser.newPage(); page.setDefaultTimeout(4000);
  page.on("pageerror", error => nativeErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") nativeErrors.push(message.text()); });
  const parameters = new URLSearchParams();
  if (workspace) parameters.set("workspace", "");
  if (retryDelay !== undefined) parameters.set("retryDelay", String(retryDelay));
  await page.goto(nativeOrigin + "__authority?" + parameters); await expect.poll(async () => (await probe(page)).allowed).toBe(true); return page;
}
async function pendingCount(page: Page) { return page.evaluate(() => (window as unknown as { authorityPending: unknown[] }).authorityPending.length); }
async function holdAndExpand(page: Page, extra: number) {
  await page.evaluate(extra => { const w = window as unknown as { authorityHold: boolean; authorityProbe: { setExtra: (n: number) => void } }; w.authorityHold = true; w.authorityProbe.setExtra(extra); }, extra);
  await expect.poll(() => pendingCount(page)).toBeGreaterThan(0);
}
async function finishPending(page: Page, status = 200, denied = false) {
  await page.evaluate(({ status, denied }) => { const w = window as unknown as { authorityHold: boolean; authorityPending: { finish: (s: number, d: boolean) => void }[] }; w.authorityHold = false; w.authorityPending.splice(0).forEach(r => r.finish(status, denied)); }, { status, denied });
  // Final error assertions belong after the real aggregate and its configured
  // retry settle. A one-second poll otherwise races the one-second retry.
  await page.waitForFunction(() => (window as unknown as { authorityCache: { pending: () => number } }).authorityCache.pending() === 0);
}

describe("native authority snapshot continuity", () => {
  it.each([401, 403])("workspace %i settles without a catalogue/registration request loop and recovers", async status => {
    const page = await nativeOpen(true); try {
      await expect.poll(() => page.evaluate(() => (window as unknown as { authorityCalls: unknown[][] }).authorityCalls.at(-1)?.length)).toBe(3);
      await page.waitForTimeout(100);
      const start = await page.evaluate(status => {
        const w = window as unknown as { authorityCalls: unknown[]; catalogueCalls: string[]; loopStart: number; authorityStatus: number; authorityProbe: { refetch: () => Promise<void> } };
        w.loopStart = w.authorityCalls.length; w.authorityStatus = status; void w.authorityProbe.refetch();
        return { evaluations: w.loopStart, catalogues: w.catalogueCalls.length };
      }, status);
      await expect.poll(async () => (await probe(page)).allowed).toBe(false);
      await page.waitForTimeout(600);
      const burst = await page.evaluate(() => {
        const w = window as unknown as { authorityCalls: unknown[][]; catalogueCalls: string[]; loopCapped: boolean };
        return { evaluations: w.authorityCalls.length, checkCounts: w.authorityCalls.map(checks => checks.length), catalogues: w.catalogueCalls.length, capped: w.loopCapped };
      });
      console.info("workspace denial diagnostics", JSON.stringify({ status, start, burst }));
      expect(burst.evaluations - start.evaluations).toBeLessThanOrEqual(4);
      expect(burst.capped).toBe(false);
      await expect.poll(async () => (await probe(page)).error, { timeout: 5000 }).toBe(true);
      await page.waitForTimeout(3500); // Include a scheduled refresh, not just the first settled rejection.
      expect(await page.locator("#access-status").innerText()).toBe("Access unavailable");
      expect(await probe(page)).toMatchObject({ allowed: false, loading: false });
      const denied = await page.evaluate(() => {
        const w = window as unknown as { authorityCalls: unknown[]; catalogueCalls: string[]; loopCapped: boolean };
        return { evaluations: w.authorityCalls.length, catalogues: w.catalogueCalls.length, capped: w.loopCapped };
      });
      expect(denied.capped).toBe(false);
      expect(denied.evaluations - start.evaluations).toBeLessThanOrEqual(8);
      expect(denied.catalogues - start.catalogues).toBeLessThanOrEqual(4);
      await page.evaluate(() => { const w = window as unknown as { authorityStatus: number; authorityProbe: { refetch: () => Promise<void> } }; w.authorityStatus = 503; return w.authorityProbe.refetch(); });
      expect(await probe(page)).toMatchObject({ allowed: false, error: true, loading: false });
      await page.evaluate(() => { const w = window as unknown as { authorityStatus: number; authorityProbe: { refetch: () => Promise<void> } }; w.authorityStatus = 200; return w.authorityProbe.refetch(); });
      await expect.poll(async () => (await probe(page)).allowed).toBe(true);
      await expect.poll(() => page.evaluate(() => (window as unknown as { authorityCalls: unknown[][] }).authorityCalls.at(-1)?.length)).toBe(3);
      await page.evaluate(status => {
        const w = window as unknown as { authorityStatus: number; loopStart: number; authorityCalls: unknown[]; authorityCache: { put: () => void }; authorityProbe: { refetch: () => Promise<void> } };
        w.authorityCache.put(); w.loopStart = w.authorityCalls.length; w.authorityStatus = status; void w.authorityProbe.refetch();
      }, status);
      await expect.poll(async () => (await probe(page)).allowed).toBe(false);
      expect(await page.evaluate(() => (window as unknown as { authorityCache: { get: () => unknown } }).authorityCache.get())).toBe(null);
      await expect.poll(async () => (await probe(page)).error, { timeout: 5000 }).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { loopCapped: boolean }).loopCapped)).toBe(false);
    } finally { await page.close(); }
  }, 20000);

  it("a denied identity can return after an uncompleted replacement without inheriting scrub suppression", async () => {
    const page = await nativeOpen(true); try {
      await page.evaluate(() => { const w = window as unknown as { authorityStatus: number; authorityProbe: { refetch: () => Promise<void> } }; w.authorityStatus = 403; void w.authorityProbe.refetch(); });
      await expect.poll(async () => (await probe(page)).error, { timeout: 5000 }).toBe(true);
      await page.evaluate(() => {
        const w = window as unknown as { authorityHold: boolean; replaceAuthoritySession: (patch: object) => void };
        w.authorityHold = true; w.replaceAuthoritySession({ sessionId: "replacement" });
      });
      await expect.poll(() => pendingCount(page)).toBeGreaterThan(0);
      await page.evaluate(() => {
        const w = window as unknown as { authorityCache: { put: () => void }; replaceAuthoritySession: (patch: object) => void };
        w.authorityCache.put(); w.replaceAuthoritySession({ sessionId: "session" });
      });
      await expect.poll(() => pendingCount(page)).toBeGreaterThan(1);
      await page.evaluate(() => {
        const w = window as unknown as { authorityHold: boolean; authorityPending: { aborted: () => boolean; finish: (s: number) => void }[] };
        w.authorityHold = false; w.authorityPending.splice(0).forEach(r => r.finish(r.aborted() ? 200 : 403));
      });
      await expect.poll(async () => (await probe(page)).error, { timeout: 5000 }).toBe(true);
      expect((await probe(page)).allowed).toBe(false);
      expect(await page.evaluate(() => (window as unknown as { authorityCache: { get: () => unknown } }).authorityCache.get())).toBe(null);
    } finally { await page.close(); }
  }, 15000);

  it("records a later403 after revoked200 and keeps denial feedback while another aggregate is pending", async () => {
    const page = await nativeOpen(); try {
      await holdAndExpand(page, 65); await expect.poll(() => pendingCount(page)).toBe(3);
      await page.evaluate(() => {
        const w = window as unknown as { authorityPending: { checks: { permission: string }[]; finish: (s: number, d: boolean) => void }[] };
        w.authorityPending.find(r => r.checks.some(c => c.permission === "staff.read"))!.finish(200, true);
      });
      await expect.poll(async () => (await probe(page)).allowed).toBe(false);
      await page.evaluate(() => {
        const w = window as unknown as { authorityPending: { checks: { permission: string }[]; finish: (s: number, d: boolean) => void }[] };
        w.authorityPending.find(r => !r.checks.some(c => c.permission === "staff.read"))!.finish(403, false);
      });
      await expect.poll(async () => (await probe(page)).error).toBe(true);
      expect(await probe(page)).toMatchObject({ allowed: false, errorStatus: 403, loading: false });
      await page.evaluate(() => (window as unknown as { authorityProbe: { setExtra: (n: number) => void } }).authorityProbe.setExtra(64));
      await expect.poll(() => pendingCount(page)).toBeGreaterThan(3);
      expect(await probe(page)).toMatchObject({ allowed: false, errorStatus: 403, loading: false });
      await finishPending(page, 200);
      await expect.poll(async () => (await probe(page)).allowed).toBe(true);
      expect((await probe(page)).error).toBe(false);
    } finally { await page.close(); }
  }, 15000);

  it("keeps confirmed read facts but no new grant during expansion and503, then recovers", async () => {
    const page = await nativeOpen(); try {
      await holdAndExpand(page, 1);
      expect(await probe(page)).toMatchObject({ allowed: true, extraAllowed: false, hasData: false, fetching: true });
      await page.evaluate(() => { (window as unknown as { authorityStatus: number }).authorityStatus = 503; });
      await finishPending(page, 503);
      await expect.poll(async () => (await probe(page)).error).toBe(true);
      expect(await probe(page)).toMatchObject({ allowed: true, extraAllowed: false, hasData: false });
      await page.evaluate(() => { const w = window as unknown as { authorityStatus: number; authorityProbe: { refetch: () => Promise<void> } }; w.authorityStatus = 200; return w.authorityProbe.refetch(); });
      await expect.poll(async () => (await probe(page)).extraAllowed).toBe(true);
    } finally { await page.close(); }
  }, 15000);

  it.each([401, 403])("%i conceals immediately while the other chunk is held and does not resurrect on503", async status => {
    const page = await nativeOpen(); try {
      await page.evaluate(() => (window as unknown as { authorityCache: { put: () => void } }).authorityCache.put());
      await holdAndExpand(page, 33); await expect.poll(() => pendingCount(page)).toBe(2);
      await page.evaluate(status => { const w = window as unknown as { authorityStatus: number; authorityPending: { finish: (status: number) => void }[] }; w.authorityStatus = 503; w.authorityPending[0].finish(status); }, status);
      await expect.poll(async () => (await probe(page)).allowed).toBe(false);
      expect(await page.evaluate(() => (window as unknown as { authorityCache: { get: () => unknown } }).authorityCache.get())).toBe(null);
      await finishPending(page, 503);
      await expect.poll(async () => (await probe(page)).error).toBe(true);
      expect((await probe(page)).allowed).toBe(false);
      await page.evaluate(() => { const w = window as unknown as { authorityStatus: number; authorityProbe: { setExtra: (n: number) => void } }; w.authorityStatus = 503; w.authorityProbe.setExtra(0); });
      await expect.poll(async () => (await probe(page)).error).toBe(true);
      expect((await probe(page)).allowed).toBe(false);
      await page.evaluate(() => { const w = window as unknown as { authorityStatus: number; authorityProbe: { refetch: () => Promise<void> } }; w.authorityStatus = 200; return w.authorityProbe.refetch(); });
      await expect.poll(async () => (await probe(page)).allowed).toBe(true);
    } finally { await page.close(); }
  }, 15000);

  it.each([undefined, 1500])("observed revoked200 conceals old grants before a second chunk fails (retry delay %s)", async retryDelay => {
    const page = await nativeOpen(false, retryDelay); try {
      await holdAndExpand(page, 33); await expect.poll(() => pendingCount(page)).toBe(2);
      await page.evaluate(() => {
        const w = window as unknown as { authorityPending: { checks: { permission: string }[]; finish: (s: number, d: boolean) => void }[] };
        w.authorityPending.find(r => r.checks.some(c => c.permission === "staff.read"))!.finish(200, true);
      });
      await expect.poll(async () => (await probe(page)).allowed).toBe(false);
      await page.evaluate(() => { (window as unknown as { authorityStatus: number }).authorityStatus = 503; });
      await finishPending(page, 503);
      await expect.poll(async () => (await probe(page)).error).toBe(true);
      expect((await probe(page)).allowed).toBe(false);
    } finally { await page.close(); }
  }, 15000);

  it.each(["sessionId", "generation", "subjectId", "tenantId"])("does not carry grants or late denials across %s replacement", async field => {
    const page = await nativeOpen(); try {
      await holdAndExpand(page, 1);
      await page.evaluate(field => (window as unknown as { replaceAuthoritySession: (patch: object) => void }).replaceAuthoritySession({ [field]: "replacement" }), field);
      await expect.poll(async () => (await probe(page)).allowed).toBe(false);
      await expect.poll(() => pendingCount(page)).toBeGreaterThan(1);
      await page.evaluate(() => { const w = window as unknown as { authorityHold: boolean; authorityPending: { aborted: () => boolean; finish: (s: number, d: boolean) => void }[] }; w.authorityHold = false; for (const r of w.authorityPending.splice(0)) r.finish(r.aborted() ? 403 : 200, false); });
      await expect.poll(async () => (await probe(page)).allowed).toBe(true);
      expect((await probe(page)).extraAllowed).toBe(true);
    } finally { await page.close(); }
  }, 15000);
});

describe("access authority", () => {
  it("binds retained authority to the complete actor and session identity", () => {
    const identity = { tenantId: "one", username: "operator@example.invalid", subjectId: "actor", sessionId: "session", generation: "generation" };
    const original = accessAuthorityIdentity(identity);
    for (const key of Object.keys(identity) as (keyof typeof identity)[]) expect(accessAuthorityIdentity({ ...identity, [key]: "different" })).not.toBe(original);
    expect(accessAuthorityIdentity({ ...identity, username: " OPERATOR@example.invalid " })).toBe(original);
    expect(accessAuthorityIdentity(null)).toBe("");
  });

  it.each([31, 32, 33, 65])("normalizes %i checks and never exceeds the API32-check limit", async count => {
    const checks = Array.from({ length: count }, (_, index) => ({ permission: "staff.assign-properties", scope: `tenant:one/property:${index}` }));
    const sizes: number[] = [];
    const result = await evaluateAccessPermissionChecks([...checks, ...checks], async batch => {
      sizes.push(batch.length);
      return { permissions: batch.map(check => ({ ...check, allowed: true })) };
    });
    expect(sizes.every(size => size > 0 && size <= 32)).toBe(true);
    expect(sizes.length).toBe(Math.ceil(count / 32));
    expect(result.permissions.length).toBe(count);
  });

  it("does not commit partial grants when another batch fails", async () => {
    const checks = Array.from({ length: 33 }, (_, index) => ({ permission: "staff.read", scope: `tenant:one/property:${index}` }));
    let completed = 0;
    await expect(evaluateAccessPermissionChecks(checks, async batch => {
      if (batch.length === 1) throw Error("Second batch unavailable");
      completed++;
      return { permissions: batch.map(check => ({ ...check, allowed: true })) };
    })).rejects.toThrow("Second batch unavailable");
    expect(completed).toBe(1);
  });

  it("batches active permission checks into one stable unique request", () => {
    expect(mergeAccessPermissionChecks([
      [
        { permission: "reservations.read", scope: "tenant:one/property:first" },
        { permission: "inventory.read", scope: "tenant:one/property:first" },
      ],
      [
        { permission: "reservations.read", scope: "tenant:one/property:first" },
        { permission: "reservations.create", scope: "tenant:one/property:first" },
      ],
    ])).toEqual([
      { permission: "inventory.read", scope: "tenant:one/property:first" },
      { permission: "reservations.create", scope: "tenant:one/property:first" },
      { permission: "reservations.read", scope: "tenant:one/property:first" },
    ]);
  });

  it("detects only permissions that were allowed and are still actively observed", () => {
    expect(revokedAccessPermissionKeys(
      new Set(["inventory.read@scope", "reservations.manage@scope", "staff.read@scope"]),
      new Set(["inventory.read@scope"]),
      ["inventory.read@scope", "reservations.manage@scope"],
    )).toEqual(["reservations.manage@scope"]);
  });

  it("detects newly granted permissions only after an earlier authority snapshot", () => {
    expect(grantedAccessPermissionKeys(
      new Set(["inventory.read@scope"]),
      new Set(["inventory.read@scope", "reservations.read@scope"]),
      new Set(["inventory.read@scope", "reservations.read@scope", "staff.read@scope"]),
      ["inventory.read@scope", "reservations.read@scope", "staff.read@scope"],
    )).toEqual(["reservations.read@scope"]);
  });

  it("retains only authority and workspace-catalogue queries after revocation", () => {
    expect(accessAuthorityQuerySurvivesScrub(["access-permissions", "actor"])).toBe(true);
    expect(accessAuthorityQuerySurvivesScrub(["organizations", "mine"])).toBe(true);
    expect(accessAuthorityQuerySurvivesScrub(["organizations", "workspace", "members"])).toBe(false);
    expect(accessAuthorityQuerySurvivesScrub(["staff-members"])).toBe(false);
    expect(accessAuthorityQuerySurvivesScrub(["reservation", "property", "id"])).toBe(false);
  });

  it("converges inside the five-second online revocation contract", () => {
    expect(ACCESS_AUTHORITY_REFRESH_INTERVAL_MS).toBeLessThan(5_000);
  });

  it("does not evaluate checks outside the active tenant boundary", () => {
    expect(accessAuthorityChecksMatchTenant("one", [
      { permission: "staff.read", scope: "tenant:one" },
      { permission: "reservations.read", scope: "tenant:one/property:first" },
    ])).toBe(true);
    expect(accessAuthorityChecksMatchTenant("one", [
      { permission: "staff.read", scope: "tenant:two" },
    ])).toBe(false);
    expect(accessAuthorityChecksMatchTenant("global", [
      { permission: "staff.read", scope: "tenant:one" },
    ])).toBe(false);
  });
});
