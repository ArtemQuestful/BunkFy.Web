import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The actual component, query lifecycle and browser run here. Session and HTTP
// responses are synthetic; this is not live-backend/RBAC/cutover acceptance.
const fixture = `
import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {ApiError} from "/src/api/client.ts";
import {WorkspaceJoinRequestSettings} from "/src/features/workspaces/WorkspaceJoinRequestSettings.tsx";
const params=new URLSearchParams(location.search);
const item={applicationId:"application",sourceKind:2,sourceId:"source",claimId:"claim",claimVersion:4,status:params.has("failed")?6:2,version:2,failureCode:null,createdAtUtc:"2026-11-06T00:00:00Z",lastChangedAtUtc:"2026-11-06T00:00:00Z",hasStaffTarget:params.has("staff")};
window.joinFixture={subject:"first",workspace:"workspace",generation:"first",staff:false,hold:false,held:false,reviewCount:0,writes:[],membershipRefreshes:0};
const state=window.joinFixture;
state.request=async(path,options)=>{
 if(options?.method==="POST"){
  state.writes.push({path,body:options.body});
  if(path.endsWith("/recovery-attempts")){
   if(params.has("disabled"))throw new ApiError("Not found",404);
   if(params.has("lost")&&state.writes.length===1)throw Error("Response lost");
   const intent=JSON.parse(options.body);
   return {operationId:intent.operationId,applicationId:"application",outcome:1,reason:1,applicationStatus:5,applicationVersion:3,retryDirective:0,retryAfterSeconds:null,recordedAtUtc:new Date().toISOString()};
  }
  return {};
 }
 if(path.includes("/summary?"))return {items:[{...item}],page:1,pageSize:25,hasMore:false};
 if(path.endsWith("/recovery-attempts/latest"))throw new ApiError("Receipt unavailable",params.has("receipt-error")?503:404);
 if(path.endsWith("/review")){
  state.reviewCount++;
  const subject=state.subject;
  if(state.hold){state.held=true;await new Promise(resolve=>{state.release=resolve;});}
  if(state.staff)throw new ApiError("Profile unavailable",409);
  return {...item,organizationId:state.workspace,subjectId:subject,verifiedAccountEmail:subject+"@example.test",displayName:subject+" Applicant",legalName:"Legal Name",workEmail:"desk@example.test",workPhone:null,employeeNumber:null,jobTitle:"Front desk",department:null,staffMemberId:null};
 }
 throw Error("Unexpected fixture request: "+path);
};
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:0}}});
state.refresh=()=>client.invalidateQueries({queryKey:["workspace-staff-onboarding"]});
function Fixture(){
 const [workspace,setWorkspace]=useState("workspace");const [generation,setGeneration]=useState("first");const [canGrant,setCanGrant]=useState(!params.has("deny-only"));
 state.changeAccount=()=>{state.subject="second";state.generation="second";setGeneration("second");};
 state.changeWorkspace=()=>{state.workspace="second-workspace";setWorkspace(state.workspace);};
 state.changeTenantOnly=()=>{state.workspace="other-tenant";state.generation="other-tenant";setGeneration(state.generation);};
 state.canGrant=setCanGrant;
 return <QueryClientProvider client={client}><output>{generation}</output><WorkspaceJoinRequestSettings workspaceId={workspace} canGrant={canGrant} onMembershipChanged={async()=>{state.membershipRefreshes++;}}/></QueryClientProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture/>);
`;
let server: ViteDevServer;
let browser: Browser;
let origin: string;
const runtimeErrors: string[] = [];
beforeAll(async () => {
  const entry = normalizePath(process.cwd() + "/__join_review_fixture.tsx");
  server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
    cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-join-review-")),
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "react-router", "@tanstack/react-query", "lucide-react"] },
    plugins: [react(), { name: "join-review-fixture",
      resolveId: id => id === entry || id === "/__join_review_fixture.tsx" ? entry : undefined,
      load(id) {
        if (id === entry) return fixture;
        if (id === normalizePath(process.cwd() + "/src/app/session.tsx")) return 'export function useSession(){const s=window.joinFixture;return {request:s.request,session:{subjectId:s.subject,sessionId:s.subject,tenantId:s.workspace,generation:s.generation}};}';
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__join-review")) return next();
        void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__join_review_fixture.tsx"></script></body></html>')
          .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
      }); },
    }], server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen(); origin = server.resolvedUrls!.local[0]; browser = await launchNativeChromium();
}, 60000);
afterAll(async () => { await browser?.close(); await server?.close(); expect(runtimeErrors).toEqual([]); });
async function open(query = "") {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  page.on("pageerror", error => runtimeErrors.push(error.message));
  await page.goto(origin + "__join-review" + query);
  await page.getByRole("heading", { name: "Join requests" }).waitFor();
  return page;
}
async function change(page: Page, code: string) {
  await page.evaluate(code);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

describe("native applicant review screen", () => {
  it("keeps applicant identity and contact visible, then approves the reviewed claim version", async () => {
    const page = await open();
    try {
      await page.getByText("first Applicant", { exact: true }).waitFor();
      expect(await page.getByText("desk@example.test / Front desk", { exact: true }).count()).toBe(1);
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await page.waitForFunction(() => (window as unknown as { joinFixture: { membershipRefreshes: number } }).joinFixture.membershipRefreshes === 1);
      expect(await page.evaluate("window.joinFixture.writes")).toEqual([{
        path: "/api/organizations/workspace/join-requests/claim/approve", body: '{"expectedVersion":4}',
      }]);
    } finally { await page.close(); }
  });

  it("hides old profile data while refreshing, then keeps approval disabled after a same-version ownership denial", async () => {
    const page = await open();
    try {
      await page.getByText("first Applicant", { exact: true }).waitFor();
      await change(page, "window.joinFixture.hold=true;void window.joinFixture.refresh()");
      await page.waitForFunction("window.joinFixture.held");
      expect(await page.getByText("first Applicant", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Approve", exact: true }).isDisabled()).toBe(true);
      await change(page, "window.joinFixture.staff=true;window.joinFixture.hold=false;window.joinFixture.release()");
      await page.getByText("Applicant details are unavailable. Refresh before reviewing this request.", { exact: true }).waitFor();
      expect(await page.getByText("first Applicant", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Approve", exact: true }).isDisabled()).toBe(true);
      expect(await page.evaluate("window.joinFixture.writes.length")).toBe(0);
    } finally { await page.close(); }
  });

  it("cannot repaint another account's late applicant response", async () => {
    const page = await open();
    try {
      await page.getByText("first Applicant", { exact: true }).waitFor();
      await change(page, "window.joinFixture.hold=true;void window.joinFixture.refresh()");
      await page.waitForFunction("window.joinFixture.held");
      await change(page, "window.joinFixture.hold=false;window.joinFixture.changeAccount()");
      await page.getByText("second Applicant", { exact: true }).waitFor();
      await change(page, "window.joinFixture.release()");
      expect(await page.getByText("first Applicant", { exact: true }).count()).toBe(0);
      expect(await page.getByText("second Applicant", { exact: true }).count()).toBe(1);
    } finally { await page.close(); }
  });

  it("withholds profiles when the session tenant changes before the workspace view catches up", async () => {
    const page = await open();
    try {
      await page.getByText("first Applicant", { exact: true }).waitFor();
      const reads = await page.evaluate("window.joinFixture.reviewCount");
      await change(page, "window.joinFixture.changeTenantOnly()");
      expect(await page.getByText("first Applicant", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Approve", exact: true }).count()).toBe(0);
      expect(await page.evaluate("window.joinFixture.reviewCount")).toBe(reads);
      expect(await page.evaluate("window.joinFixture.writes.length")).toBe(0);
    } finally { await page.close(); }
  });

  it("preserves early setup retries when Staff absence is freshly reviewed and receipted recovery is disabled", async () => {
    const page = await open("?failed&disabled");
    try {
      await page.getByText("first Applicant", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Retry setup" }).click();
      await page.waitForFunction("window.joinFixture.writes.length===1");
      expect(await page.evaluate("window.joinFixture.writes[0].path")).toBe(
        "/api/workspace-staff-enrollment/applications/application/retry");
      await page.waitForFunction("window.joinFixture.membershipRefreshes===1");
    } finally { await page.close(); }
  });

  it("uses receipted recovery for a Staff target and exposes a disabled rollout without legacy writes", async () => {
    const page = await open("?failed&staff&disabled");
    try {
      await page.getByRole("button", { name: "Retry setup" }).click();
      await page.getByText("Setup recovery is unavailable. Ask your administrator to review this request.", { exact: true }).waitFor();
      const writes = await page.evaluate("window.joinFixture.writes") as Array<{ path: string }>;
      expect(writes).toHaveLength(1); expect(writes[0].path).toMatch(/\/recovery-attempts$/);
      expect(await page.evaluate("window.joinFixture.reviewCount")).toBe(0);
    } finally { await page.close(); }
  });

  it("retries a lost recovery response with the same operation and version", async () => {
    const page = await open("?failed&staff&lost");
    try {
      await page.getByRole("button", { name: "Retry setup" }).click();
      await page.getByText("Response lost", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Retry setup" }).click();
      await page.waitForFunction("window.joinFixture.membershipRefreshes===1");
      const writes = await page.evaluate("window.joinFixture.writes") as Array<{ path: string; body: string }>;
      expect(writes).toHaveLength(2); expect(writes[1].body).toBe(writes[0].body);
      expect(JSON.parse(writes[0].body).expectedApplicationVersion).toBe(2);
    } finally { await page.close(); }
  });

  it("preserves a reviewed rejection when grant authority is unavailable", async () => {
    const page = await open("?deny-only");
    try {
      await page.getByText("first Applicant", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Approve", exact: true }).isDisabled()).toBe(true);
      await page.getByRole("button", { name: "Reject", exact: true }).click();
      await page.waitForFunction("window.joinFixture.writes.length===1");
      expect(await page.evaluate("window.joinFixture.writes[0].path")).toMatch(/\/reject$/);
    } finally { await page.close(); }
  });

  it("blocks setup writes when the latest recovery receipt cannot be read", async () => {
    const page = await open("?failed&staff&receipt-error");
    try {
      await page.getByText("Recovery status is unavailable. Refresh before retrying setup.", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Retry setup" }).isDisabled()).toBe(true);
      expect(await page.evaluate("window.joinFixture.writes.length")).toBe(0);
    } finally { await page.close(); }
  });
});
