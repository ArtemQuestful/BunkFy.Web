import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { type Browser, type Route } from "@playwright/test";
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
import {App} from "/src/app/App.tsx";
import {SessionProvider,useSession} from "/src/app/session.tsx";
import {WorkspaceProvider,useWorkspace} from "/src/app/workspace.tsx";
import {WorkspaceGate} from "/src/features/workspaces/WorkspaceGate.tsx";
import {parseWorkspaceJoinSecret,prepareWorkspaceJoinContext,preserveWorkspaceJoinContext} from "/src/features/workspaces/workspaceJoin.ts";
const bootstrap=new URLSearchParams(location.search).has("bootstrap");
if(!bootstrap){const incoming=parseWorkspaceJoinSecret(location.hash);
if(incoming){const prepared=await prepareWorkspaceJoinContext(incoming);preserveWorkspaceJoinContext(prepared.context);}
history.replaceState(null,"","/join");}
const client=new QueryClient({defaultOptions:{queries:{staleTime:20000,retry:1,refetchOnWindowFocus:false},mutations:{networkMode:"always",retry:0}}});
window.refreshApplication=()=>client.invalidateQueries({queryKey:["workspace-staff-onboarding"]});
window.joinMutationsSettled=()=>client.getMutationCache().getAll().every(m=>m.state.status!=="pending");
function Content(){const {session}=useSession();const {selectedWorkspaceId}=useWorkspace();return <><output data-tenant>{session?.tenantId}</output><output data-selected>{selectedWorkspaceId}</output><WorkspaceGate><nav aria-label="Main navigation">Workspace ready</nav></WorkspaceGate></>;}
function SignedIn(){const {session}=useSession();return session?<WorkspaceProvider><Content/></WorkspaceProvider>:<p>Restoring session</p>;}
createRoot(document.getElementById("root")).render(<QueryClientProvider client={client}><SessionProvider restoreOnMount={!bootstrap}><BrowserRouter>{bootstrap?<React.StrictMode><App/></React.StrictMode>:<SignedIn/>}</BrowserRouter></SessionProvider></QueryClientProvider>);
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
  it.each([false, true])("opens an accepted invitation after its own workspace switch, existing workspace=%s", async existingWorkspace => {
    const context = await browser.newContext();
    await context.addInitScript(value => localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(value)),
      { ...identity, tenantId: existingWorkspace ? homeId : "global" });
    const page = await context.newPage();
    const contexts = new Map<string, { sourceKind: number }>();
    let accepted = false;
    let acceptanceCount = 0;
    const requests: { path: string; tenant: string | undefined }[] = [];
    await page.route(url => url.pathname.startsWith("/api/"), async route => {
      const path = await resolveJoinTransport(route, contexts);
      if (path === null) return;
      requests.push({ path, tenant: route.request().headers()["x-tenant-id"] });
      let status = 200;
      let body: unknown;
      if (path === "/api/auth/browser/refresh") body = { accessToken: token };
      else if (path === "/api/organizations") body = {
        items: [...(existingWorkspace ? [membership(homeId)] : []), ...(accepted ? [membership(targetId)] : [])],
        page: 1, pageSize: 100, hasMore: false,
      };
      else if (path === "/api/organization-invitations/preview") {
        // Tenant activation removes the old scoped preview query. Give its
        // replacement a real async interval; its absence is not a new source.
        if (accepted) await new Promise(resolve => setTimeout(resolve, 100));
        body = { organizationId: targetId, organizationName: "Target", organizationSlug: "target",
          invitationId: sourceId, expiresAtUtc: "2027-01-01T00:00:00Z", recipientBound: false };
      } else if (path === "/api/workspace-staff-enrollment/applications") body = { organizationId: targetId, applicationId: "application", status: 1 };
      else if (path === "/api/organization-invitations/accept") {
        accepted = true;
        acceptanceCount++;
        body = { membership: membership(targetId) };
      } else if (path === "/api/properties") body = { properties: [], page: 1, pageSize: 100, hasMore: false };
      else { status = 500; body = { code: "Test.UnexpectedRoute" }; }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    try {
      await page.goto(origin + "join#invitation=synthetic-accepted-invitation");
      await page.getByRole("button", { name: "Join workspace", exact: true }).click();
      await page.getByRole("navigation", { name: "Main navigation" }).waitFor({ timeout: 5000 });
      expect(acceptanceCount).toBe(1);
      expect(await page.locator("[data-tenant]").textContent()).toBe(targetId);
      expect(await page.locator("[data-selected]").textContent()).toBe(targetId);
      expect(new URL(page.url()).pathname).toBe("/");
      expect(requests.some(value => value.path === "/api/properties" && value.tenant === targetId)).toBe(true);
      expect(requests.length).toBeLessThan(30);
    } finally { await context.close(); }
  }, 30000);

  it.each([
    "completed", "provisioning", "failed", "wrong-subject", "wrong-organization",
    "wrong-source", "wrong-kind", "missing-application", "missing-staff",
    "unavailable", "other-conflict", "replay-denied", "leave", "sign-out",
  ] as const)("revalidates an accepted invitation after Staff owns its profile: %s", async scenario => {
    const context = await browser.newContext();
    await context.addInitScript(value => localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(value)), identity);
    const page = await context.newPage();
    const contexts = new Map<string, { sourceKind: number }>();
    let profileAttempts = 0;
    let statusReads = 0;
    let acceptances = 0;
    let held = false;
    let releaseStatus: (() => void) | undefined;
    const propertiesTenants: (string | undefined)[] = [];
    await page.route(url => url.pathname.startsWith("/api/"), async route => {
      const path = await resolveJoinTransport(route, contexts);
      if (path === null) return;
      let status = 200;
      let body: unknown;
      if (path === "/api/auth/browser/refresh") body = { accessToken: token };
      else if (path === "/api/auth/browser/sign-out") body = {};
      else if (path === "/api/organizations") body = { items: [membership(homeId), membership(targetId)], page: 1, pageSize: 100, hasMore: false };
      else if (path === "/api/organization-invitations/preview") body = {
        organizationId: targetId, organizationName: "Target", organizationSlug: "target",
        invitationId: sourceId, expiresAtUtc: "2027-01-01T00:00:00Z", recipientBound: true,
      };
      else if (path === "/api/workspace-staff-enrollment/applications") {
        profileAttempts++;
        status = 409;
        body = { code: scenario === "other-conflict" ? "Test.UnrelatedConflict" : "Workspaces.StaffOnboardingProfileMutationAuthorityUnavailable" };
      } else if (path === `/api/workspace-staff-enrollment/${targetId}/applications/current`) {
        statusReads++;
        const query = new URL(route.request().url()).searchParams;
        expect(query.get("sourceKind")).toBe("1");
        expect(query.get("sourceId")).toBe(sourceId);
        if (scenario === "leave" || scenario === "sign-out") {
          held = true;
          await new Promise<void>(resolve => { releaseStatus = resolve; });
        }
        status = scenario === "unavailable" ? 403 : 200;
        body = {
          applicationId: scenario === "missing-application" ? "" : "77777777-7777-4777-8777-777777777777",
          organizationId: scenario === "wrong-organization" ? homeId : targetId,
          sourceKind: scenario === "wrong-kind" ? 2 : 1,
          sourceId: scenario === "wrong-source" ? homeId : sourceId,
          subjectId: scenario === "wrong-subject" ? sessionId : subjectId,
          status: scenario === "provisioning" ? 4 : scenario === "failed" ? 6 : 5,
          staffMemberId: scenario === "missing-staff" ? null : "88888888-8888-4888-8888-888888888888",
          verifiedAccountEmail: null, displayName: null, legalName: null, workEmail: null,
          workPhone: null, employeeNumber: null, jobTitle: null, department: null,
        };
      } else if (path === "/api/organization-invitations/accept") {
        acceptances++;
        status = scenario === "replay-denied" ? 403 : 200;
        body = scenario === "replay-denied" ? { code: "Organizations.InvitationUnavailable" }
          : { membership: { ...membership(targetId), membershipId: "99999999-9999-4999-8999-999999999999" } };
      } else if (path === "/api/properties") {
        propertiesTenants.push(route.request().headers()["x-tenant-id"]);
        body = { properties: [], page: 1, pageSize: 100, hasMore: false };
      } else { status = 500; body = { code: "Test.UnexpectedRoute" }; }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    try {
      await page.goto(origin + "join#invitation=synthetic-terminal-invitation");
      await page.getByRole("button", { name: "Join workspace", exact: true }).click();
      await expect.poll(() => profileAttempts).toBe(1);
      if (scenario === "leave" || scenario === "sign-out") {
        await expect.poll(() => held).toBe(true);
        if (scenario === "leave") await page.getByLabel("Back to BunkFy", { exact: true }).click();
        else await page.getByRole("button", { name: "Sign out", exact: true }).click();
        await page.getByText(scenario === "leave" ? "Workspace ready" : "Restoring session", { exact: true }).waitFor();
        const response = page.waitForResponse(value => new URL(value.url()).pathname.endsWith("/applications/current"));
        releaseStatus!();
        await (await response).finished();
      }
      if (scenario === "completed") {
        await page.getByRole("navigation", { name: "Main navigation" }).waitFor({ timeout: 5000 });
        expect(acceptances).toBe(1);
        expect(await page.locator("[data-tenant]").textContent()).toBe(targetId);
        expect(await page.locator("[data-selected]").textContent()).toBe(targetId);
        expect(new URL(page.url()).pathname).toBe("/");
        expect(propertiesTenants).toContain(targetId);
      } else {
        await expect.poll(() => page.evaluate(() => (window as unknown as { joinMutationsSettled(): boolean }).joinMutationsSettled())).toBe(true);
        expect(acceptances).toBe(scenario === "replay-denied" ? 1 : 0);
        expect(propertiesTenants).not.toContain(targetId);
        if (scenario !== "leave" && scenario !== "sign-out") expect(new URL(page.url()).pathname).toBe("/join");
      }
      expect(profileAttempts).toBe(1);
      expect(statusReads).toBe(scenario === "other-conflict" ? 0 : 1);
    } finally { releaseStatus?.(); await context.close(); }
  }, 30000);

  it.each(["invitation", "enrollment", "legacy", "retry"] as const)("prepares %s custody in the actual app before sign-in", async scenario => {
    const context = await browser.newContext();
    const credential = "synthetic-app-bootstrap-credential";
    if (scenario === "legacy") {
      await context.addInitScript(value => sessionStorage.setItem("bunkfy.join.secret.v1", JSON.stringify({ kind: "enrollment", token: value })), credential);
    }
    const page = await context.newPage();
    const contexts = new Map<string, { sourceKind: number }>();
    const errors: string[] = [];
    const authRequests: string[] = [];
    let prepareRequests = 0;
    let held = false;
    let releasePreparation: (() => void) | undefined;
    let rejectProof = scenario === "retry";
    page.on("pageerror", error => errors.push(error.message));
    await page.route(url => url.pathname.startsWith("/api/"), async route => {
      const request = route.request();
      const urlPath = new URL(request.url()).pathname;
      if (/^\/api\/workspace-join\/[^/]+$/.test(urlPath) && request.method() === "POST") {
        prepareRequests++;
        if (prepareRequests === 1) {
          held = true;
          await new Promise<void>(resolve => { releasePreparation = resolve; });
        }
      }
      if (urlPath.endsWith("/preview") && rejectProof) {
        rejectProof = false;
        await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "Workspaces.JoinContextUnavailable", detail: "Synthetic cookie confirmation failed" }) });
        return;
      }
      const path = await resolveJoinTransport(route, contexts);
      if (path === null) return;
      let body: unknown;
      if (path.endsWith("/preview")) body = { organizationId: targetId, organizationName: "Target", organizationSlug: "target", invitationId: sourceId, enrollmentLinkId: sourceId, expiresAtUtc: "2027-01-01T00:00:00Z", recipientBound: true, approvalMode: "requiresApproval" };
      else if (path === "/api/auth/external/providers") { authRequests.push(path); body = { providers: [] }; }
      else if (path === "/api/auth/self-registration") { authRequests.push(path); body = { passwordEnabled: true, externalEnabled: true }; }
      else {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "Test.UnexpectedRoute" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    try {
      await page.goto(origin + "join?bootstrap=1" + (scenario === "legacy" ? "" : `#${scenario === "invitation" ? "invitation" : "enrollment"}=${credential}`));
      await expect.poll(() => held).toBe(true);
      await page.getByRole("heading", { name: "Preparing your invitation", exact: true }).waitFor();
      expect(authRequests).toEqual([]);
      expect(await page.evaluate(() => sessionStorage.getItem("bunkfy.join.context.v2"))).toBeNull();
      releasePreparation!();
      if (scenario === "retry") {
        await page.getByRole("alert").waitFor();
        expect(new URL(page.url()).hash).toContain(credential);
        expect(authRequests).toEqual([]);
        expect(await page.evaluate(() => sessionStorage.getItem("bunkfy.join.context.v2"))).toBeNull();
        await page.getByRole("button", { name: "Try again", exact: true }).click();
      }
      await page.getByRole("heading", { name: "Join your team", exact: true }).waitFor();
      expect(new URL(page.url()).hash).toBe("");
      expect(prepareRequests).toBe(scenario === "retry" ? 2 : 1);
      expect(await page.evaluate(() => sessionStorage.getItem("bunkfy.join.secret.v1"))).toBeNull();
      expect(await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)))).not.toContain(credential);
      expect(await page.evaluate(() => document.cookie)).not.toContain("bunkfy.workspace-join");
      expect(errors).toEqual([]);
    } finally {
      releasePreparation?.();
      await context.close();
    }
  }, 30000);

  it("does not switch workspace when a submitted join response arrives after leaving", async () => {
    const context = await browser.newContext();
    await context.addInitScript(value => localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(value)), identity);
    const joinContexts = new Map<string, { sourceKind: number }>();
    const page = await context.newPage();
    let submitted = false;
    let joined = false;
    let releaseJoin: (() => void) | undefined;
    const targetRequests: string[] = [];
    await page.route(url => url.pathname.startsWith("/api/"), async route => {
      const request = route.request();
      if (request.headers()["x-tenant-id"] === targetId) targetRequests.push(new URL(request.url()).pathname);
      const path = await resolveJoinTransport(route, joinContexts);
      if (path === null) return;
      let status = 200;
      let body: unknown;
      if (path === "/api/auth/browser/refresh") body = { accessToken: token };
      else if (path === "/api/organizations") body = { items: joined ? [membership(homeId), membership(targetId)] : [membership(homeId)], page: 1, pageSize: 100, hasMore: false };
      else if (path === "/api/organization-enrollment/preview") body = { organizationId: targetId, organizationName: "Target", organizationSlug: "target", enrollmentLinkId: sourceId, expiresAtUtc: "2027-01-01T00:00:00Z", approvalMode: "automatic" };
      else if (path.endsWith("/applications/current")) { status = 404; body = { code: "Workspaces.ApplicationNotFound" }; }
      else if (path === "/api/workspace-staff-enrollment/applications") body = { organizationId: targetId, applicationId: "application", status: 1 };
      else if (path === "/api/organization-enrollment/claim") {
        submitted = true;
        await new Promise<void>(resolve => { releaseJoin = resolve; });
        joined = true;
        body = { claim: { organizationId: targetId }, membership: membership(targetId) };
      } else if (path === "/api/properties") body = { properties: [], page: 1, pageSize: 100, hasMore: false };
      else { status = 500; body = { code: "Test.UnexpectedRoute" }; }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    try {
      await page.goto(origin + "join#enrollment=synthetic-delayed-join-token");
      await page.getByRole("button", { name: "Request access", exact: true }).click();
      await expect.poll(() => submitted).toBe(true);
      await page.getByLabel("Back to BunkFy", { exact: true }).click();
      await page.getByRole("navigation", { name: "Main navigation" }).waitFor();
      const response = page.waitForResponse(value => new URL(value.url()).pathname.endsWith("/join"));
      releaseJoin!();
      await (await response).finished();
      await expect.poll(() => page.evaluate(() => (window as unknown as { joinMutationsSettled(): boolean }).joinMutationsSettled())).toBe(true);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.locator("[data-selected]").textContent()).toBe(homeId);
      expect(await page.locator("[data-tenant]").textContent()).toBe(homeId);
      expect(targetRequests).toEqual([]);
    } finally {
      releaseJoin?.();
      await context.close();
    }
  }, 30000);

  it("keeps two tabs' join cookies independent when one tab leaves", async () => {
    const context = await browser.newContext();
    await context.addInitScript(value => localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(value)), identity);
    const joinContexts = new Map<string, { sourceKind: number }>();
    await context.route(url => url.pathname.startsWith("/api/"), async route => {
      const path = await resolveJoinTransport(route, joinContexts);
      if (path === null) return;
      let status = 200;
      let body: unknown;
      if (path === "/api/auth/browser/refresh") body = { accessToken: token };
      else if (path === "/api/organizations") body = { items: [membership(homeId)], page: 1, pageSize: 100, hasMore: false };
      else if (path === "/api/organization-enrollment/preview") body = { organizationId: targetId, organizationName: "Target", organizationSlug: "target", enrollmentLinkId: sourceId, expiresAtUtc: "2027-01-01T00:00:00Z", approvalMode: "requiresApproval" };
      else if (path.endsWith("/applications/current")) body = { organizationId: targetId, applicationId: "application", status: 2, claimId: "77777777-7777-4777-8777-777777777777", claimVersion: 1 };
      else if (path === "/api/properties") body = { properties: [], page: 1, pageSize: 100, hasMore: false };
      else { status = 500; body = { code: "Test.UnexpectedRoute" }; }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    try {
      const first = await context.newPage();
      const second = await context.newPage();
      await first.goto(origin + "join#enrollment=synthetic-first-tab-token");
      await first.getByRole("heading", { name: "Request sent", exact: true }).waitFor();
      await second.goto(origin + "join#enrollment=synthetic-second-tab-token");
      await second.getByRole("heading", { name: "Request sent", exact: true }).waitFor();
      const pointer = (page: typeof first) => page.evaluate(() => JSON.parse(sessionStorage.getItem("bunkfy.join.context.v2")!) as { contextId: string });
      const firstContext = await pointer(first);
      const secondContext = await pointer(second);
      expect(firstContext.contextId).not.toBe(secondContext.contextId);
      expect((await context.cookies()).filter(cookie => cookie.name === "bunkfy.workspace-join")).toHaveLength(2);
      await first.getByLabel("Back to BunkFy", { exact: true }).click();
      await first.getByRole("navigation", { name: "Main navigation" }).waitFor();
      await expect.poll(async () => (await context.cookies()).filter(cookie => cookie.name === "bunkfy.workspace-join").length).toBe(1);
      await second.reload();
      await second.getByRole("heading", { name: "Request sent", exact: true }).waitFor();
      expect((await pointer(second)).contextId).toBe(secondContext.contextId);
      expect(await second.evaluate(() => JSON.stringify(Object.entries(sessionStorage)))).not.toContain("synthetic-second-tab-token");
    } finally {
      await context.close();
    }
  }, 30000);

  it.each(["account-switch", "withdrawn", "expired"] as const)("retains cookie and pending recovery through %s without a stored credential", async recovery => {
    const context = await browser.newContext();
    await context.addInitScript(value => {
      if (!localStorage.getItem("bunkfy.session.identity.v2")) {
        localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(value));
      }
    }, identity);
    const page = await context.newPage();
    const credential = "synthetic-enrollment-reusable-credential";
    const anotherSubject = "66666666-6666-4666-8666-666666666666";
    let currentSubject = subjectId;
    let claimed = false;
    let applicationUnavailable = false;
    let terminalStatus: "withdrawn" | "expired" | null = null;
    const submittedBodies: unknown[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const joinContexts = new Map<string, { sourceKind: number }>();
    await page.route(url => url.pathname.startsWith("/api/"), async route => {
      const request = route.request();
      const path = await resolveJoinTransport(route, joinContexts);
      if (path === null) return;
      let status = 200;
      let body: unknown;
      if (path === "/api/auth/browser/refresh") {
        body = { accessToken: `e30.${Buffer.from(JSON.stringify({ sub: currentSubject, sid: sessionId })).toString("base64url")}.synthetic` };
      } else if (path === "/api/organizations") {
        body = { items: [membership(homeId)], page: 1, pageSize: 100, hasMore: false };
      } else if (path === "/api/organization-enrollment/preview") {
        body = { organizationId: targetId, organizationName: "Target", organizationSlug: "target", enrollmentLinkId: sourceId, expiresAtUtc: "2027-01-01T00:00:00Z", approvalMode: "ownerReview" };
      } else if (path.endsWith("/applications/current")) {
        if (applicationUnavailable || !claimed || currentSubject !== subjectId) {
          status = applicationUnavailable ? 503 : 404;
          body = { code: "Workspaces.ApplicationNotFound" };
        } else {
          body = { organizationId: targetId, applicationId: "application", status: terminalStatus === "withdrawn" ? 10 : terminalStatus === "expired" ? 9 : 2, claimId: "77777777-7777-4777-8777-777777777777", claimVersion: 1 };
        }
      } else if (path === "/api/workspace-staff-enrollment/applications") {
        submittedBodies.push(request.postData() ? request.postDataJSON() : null);
        body = { organizationId: targetId, applicationId: "application", status: 1 };
      } else if (path === "/api/organization-enrollment/claim") {
        submittedBodies.push(request.postData() ? request.postDataJSON() : null);
        claimed = true;
        body = { claim: { organizationId: targetId }, membership: null };
      } else if (path.endsWith("/withdraw")) {
        expect(request.postDataJSON()).toEqual({ expectedVersion: 1 });
        terminalStatus = recovery === "expired" ? "expired" : "withdrawn";
        body = { claim: { organizationId: targetId, status: terminalStatus }, membership: null };
      } else {
        status = 500;
        body = { code: "Test.UnexpectedRoute" };
      }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    try {
      await page.goto(origin + "join#enrollment=" + credential);
      await page.getByRole("button", { name: "Request access", exact: true }).waitFor();
      // An older account's marker is no longer needed: its authoritative
      // application remains on the server, and the join continuation is separate.
      await page.evaluate(() => sessionStorage.setItem(
        "bunkfy.join.pending-enrollment.v2:old%40example.test", "old-synthetic-credential",
      ));
      await page.getByRole("button", { name: "Request access", exact: true }).click();
      await page.getByRole("heading", { name: "Request sent", exact: true }).waitFor();
      expect(submittedBodies).toHaveLength(2);
      expect(JSON.stringify(submittedBodies)).not.toContain(credential);
      expect(await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)))).not.toContain(credential);
      expect(await page.evaluate(() => document.cookie)).not.toContain("bunkfy.workspace-join");
      const markers = await page.evaluate(() => Object.entries(sessionStorage)
        .filter(([key]) => key.startsWith("bunkfy.join.pending-enrollment.")));
      expect(markers).toEqual([["bunkfy.join.pending-enrollment.v3:" + subjectId, sourceId]]);

      applicationUnavailable = true;
      await page.reload();
      await page.getByRole("heading", { name: "Request sent", exact: true }).waitFor();
      expect(submittedBodies).toHaveLength(2);
      expect(new URL(page.url()).hash).toBe("");

      if (recovery !== "account-switch") {
        applicationUnavailable = false;
        await page.evaluate(() => (window as unknown as { refreshApplication(): Promise<void> }).refreshApplication());
        await page.getByRole("button", { name: "Withdraw request", exact: true }).click();
        await page.getByText("Withdraw this request?", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Withdraw request", exact: true }).click();
        await page.getByRole("heading", { name: recovery === "expired" ? "Request expired" : "Request withdrawn", exact: true }).waitFor({ timeout: 2500 });
        expect(await page.evaluate(() => sessionStorage.getItem("bunkfy.join.context.v2"))).toBeNull();
        expect(await page.evaluate(() => sessionStorage.getItem("bunkfy.join.pending-enrollment.v3:" + "44444444-4444-4444-8444-444444444444"))).toBeNull();
        await expect.poll(async () => (await context.cookies()).filter(value => value.name === "bunkfy.workspace-join").length).toBe(0);
        await page.reload();
        await page.getByRole("heading", { name: "Open an invitation", exact: true }).waitFor();
        expect(errors).toEqual([]);
        return;
      }
      currentSubject = anotherSubject;
      applicationUnavailable = false;
      await page.evaluate(value => localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(value)), {
        ...identity, username: "other@example.test", subjectId: anotherSubject, generation: "other-generation",
      });
      await page.reload();
      await page.getByRole("button", { name: "Request access", exact: true }).waitFor();
      expect(await page.getByRole("heading", { name: "Request sent", exact: true }).count()).toBe(0);
      expect(submittedBodies).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30000);

  it.each([
    ...[0, 100, 500].flatMap(catalogueDelay => [0, 2].map(accessDenials => ({ catalogueDelay, accessDenials, staleCatalogues: 0 }))),
    { catalogueDelay: 0, accessDenials: 0, staleCatalogues: 1 },
    { catalogueDelay: 100, accessDenials: 0, staleCatalogues: 1 },
    { catalogueDelay: 500, accessDenials: 2, staleCatalogues: 1 },
  ].map(value => ({ ...value, abandonActivation: false })).concat([
    { catalogueDelay: 0, accessDenials: 0, staleCatalogues: 0, abandonActivation: true },
  ]))("handles activation with $catalogueDelay ms catalogue latency, $accessDenials access denials, $staleCatalogues stale catalogues, leaving=$abandonActivation", async ({ catalogueDelay, accessDenials, staleCatalogues, abandonActivation }) => {
    const context = await browser.newContext();
    await context.addInitScript(value => {
      localStorage.setItem("bunkfy.session.identity.v2", JSON.stringify(value));
      sessionStorage.setItem("bunkfy.join.pending-enrollment.v3:" + value.subjectId, "33333333-3333-4333-8333-333333333333");
    }, identity);
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
    const joinContexts = new Map<string, { sourceKind: number }>();
    await page.route(url => url.pathname.startsWith("/api/"), async route => {
      const request = route.request();
      const path = await resolveJoinTransport(route, joinContexts);
      if (path === null) return;
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
      expect(await page.evaluate(value => sessionStorage.getItem("bunkfy.join.pending-enrollment.v3:" + value), subjectId)).toBeNull();
      expect(requests.length).toBeLessThan(30);
      expect(runtimeErrors).toEqual([]);
    } finally { releaseCatalogue?.(); await context.close(); }
  }, 30000);
});

// Only the transport responses are controlled here. The server's real DP,
// request guards and owner forwarding are exercised by the .NET HTTP suite.
async function resolveJoinTransport(
  route: Route,
  contexts: Map<string, { sourceKind: number }>,
): Promise<string | null> {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const match = path.match(/^\/api\/workspace-join\/([a-f0-9-]+)(\/[^?]*)?$/);
  if (!match) return path;
  const contextId = match[1]!;
  const operation = match[2] ?? "";
  const expectedCookie = `bunkfy.workspace-join=synthetic-protected-${contextId}`;
  if (request.headers()["x-bunkfy-join-context"] !== contextId) {
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "Workspaces.JoinContextDenied" }) });
    return null;
  }
  if (!operation && request.method() === "POST") {
    const body = request.postDataJSON() as { sourceKind: number };
    contexts.set(contextId, { sourceKind: body.sourceKind });
    await route.fulfill({ status: 200, contentType: "application/json",
      headers: { "set-cookie": `${expectedCookie}; Path=/api/workspace-join/${contextId}; HttpOnly; SameSite=Strict` },
      body: JSON.stringify({ contextId, sourceKind: body.sourceKind }),
    });
    return null;
  }
  if (!operation && request.method() === "DELETE") {
    contexts.delete(contextId);
    await route.fulfill({ status: 204, headers: {
      "set-cookie": `bunkfy.workspace-join=; Path=/api/workspace-join/${contextId}; HttpOnly; SameSite=Strict; Max-Age=0`,
    } });
    return null;
  }
  const prepared = contexts.get(contextId);
  if (!prepared || !request.headers()["cookie"]?.includes(expectedCookie)) {
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "Workspaces.JoinContextUnavailable" }) });
    return null;
  }
  if (operation === "/applications") return "/api/workspace-staff-enrollment/applications";
  if (operation === "/preview") return prepared.sourceKind === 1
    ? "/api/organization-invitations/preview" : "/api/organization-enrollment/preview";
  if (operation === "/join") return prepared.sourceKind === 1
    ? "/api/organization-invitations/accept" : "/api/organization-enrollment/claim";
  return path;
}
