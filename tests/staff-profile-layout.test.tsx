import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type Page, type Locator } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Native browser, actual Staff components/Modal/styles. Session, permissions and
// API responses are explicitly synthetic: this is not real-role/backend proof.
const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router';
import {StaffDetail} from '/src/features/staff/StaffDetail.tsx';
import {StaffProfileForm} from '/src/features/staff/StaffProfileForm.tsx';
import {Modal} from '/src/components/ui/primitives.tsx';
import {ApiError} from '/src/api/client.ts';
import '/src/styles.css';
const params=new URLSearchParams(location.search);
const member={staffMemberId:'member',displayName:params.has('long')?'N'.repeat(256):'Morgan Lee',legalName:null,jobTitle:'Hostel manager',department:'Operations',employeeNumber:'QA-01',workEmail:'morgan@example.invalid',workPhone:null,status:params.get('status')||'active',version:7,createdAtUtc:'2026-09-20T12:00:00Z',lastChangedAtUtc:'2026-09-27T12:00:00Z',authSubjectId:null,assignments:[]};
if(params.has('stress'))Object.assign(member,{displayName:params.get('stress')==='unbroken'?'N'.repeat(256):'Alexandria Natalia Example '.repeat(10).slice(0,256),jobTitle:'Senior multilingual overnight reception and guest operations coordinator '.repeat(2).slice(0,128),department:'Front desk and guest relations across multiple hostel locations and seasonal operations '.repeat(2).slice(0,128)});
const directory=()=>{const {legalName,employeeNumber,workEmail,workPhone,authSubjectId,createdAtUtc,...safe}=member;return safe;};
window.staffRequests=[];window.staffWrites=[];window.staffReadStatus=Number(params.get('read')||200);window.staffReadStatuses={};window.staffSaveStatus=200;window.staffHoldSave=false;window.staffHoldRead=false;window.staffReadReleases=[];window.staffPermissionReads=0;
window.staffRequest=async(path,options)=>{
 const method=options?.method||'GET';window.staffRequests.push({path,method});
 if(method!=='GET'){
  if(method!=='PUT'||!path.endsWith('/members/member'))throw Error('Unexpected fixture mutation');
  const payload=JSON.parse(options.body);window.staffWrites.push(payload);
  if(window.staffHoldSave)await new Promise(resolve=>window.releaseStaffSave=resolve);
  if(window.staffSaveStatus!==200)throw new ApiError('Synthetic failed save',window.staffSaveStatus);
  Object.assign(member,payload,{version:member.version+1});return {staffMemberId:'member',version:member.version};
 }
 if(window.staffHoldRead)await new Promise(resolve=>window.staffReadReleases.push(resolve));
 const status=window.staffReadStatuses[path]??window.staffReadStatus;
 if(status==='offline')throw new TypeError('Synthetic network unavailable');
 if(status!==200)throw new ApiError('Synthetic failed read',status);
 if(path.endsWith('/profile'))return {...member,staffMemberId:path.split('/').at(-2)};
 if(path.includes('/members/'))return {...directory(),staffMemberId:path.split('/').at(-1)};
 throw Error('Unexpected fixture request '+path);
};
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
function Fixture(){
 const [open,setOpen]=useState(true),[mounted,setMounted]=useState(true),[tab,setTab]=useState('profile'),[id,setId]=useState('member'),[nested,setNested]=useState(false),[tenant,setTenant]=useState('tenant');
 const [manage,setManage]=useState(!params.has('readonly')),[sensitive,setSensitive]=useState(!params.has('directory')),[permission,setPermission]=useState('ready');
 window.staffHarness={setOpen,setMounted,setTab,setId,setTenant,setNested,setManage,setSensitive,setPermission,pending:()=>client.isMutating(),retry:()=>client.refetchQueries({queryKey:['staff-member']}),refetch:()=>client.invalidateQueries({queryKey:['staff-member']}),cache:()=>client.getQueryCache().findAll({queryKey:['staff-member']}).map(q=>({key:q.queryKey,data:q.state.data,error:!!q.state.error})),bump:()=>{member.version++;return client.invalidateQueries({queryKey:['staff-member']});}};
 const source={label:'Synthetic permission',state:permission,isFetching:false,refetch:async()=>{window.staffPermissionReads++;if(window.staffHoldRead)await new Promise(resolve=>window.staffReadReleases.push(resolve));setPermission(window.staffPermissionResult||'ready');}};
 function boundary(event){
  if(!window.staffBoundary||!['Cancel','Save profile','Edit'].includes(event.target.textContent))return;
  const action=window.staffBoundary;delete window.staffBoundary;
  if(action==='member')setId('other-member');
  if(action==='permission')setManage(false);
  if(action==='tab')setTab('account');
  if(action==='unmount')setOpen(false);
  if(action==='top modal')setNested(true);
  if(action==='independent')document.querySelector('[aria-label="Close dialog"]').focus({preventScroll:true});
 }
 return <QueryClientProvider client={client}><div onClick={boundary}><button onClick={()=>setOpen(true)}>Open Staff</button>{mounted&&open&&(params.has('create')?<Modal open title='Add staff member' onClose={()=>setOpen(false)}><StaffProfileForm submitting={false} error={null} submitLabel='Create staff member' sources={[source]} authorityCurrent={permission==='ready'} authorityMessage='Refresh access' onCancel={()=>setOpen(false)} onSubmit={payload=>window.staffWrites.push(payload)}/></Modal>:<StaffDetail tenantId={tenant} memberId={id} initialTab={tab} properties={[]} selectedProperty={null} propertySource={source} permissionSource={source} canReadSensitive={sensitive} canManage={manage} canManageAccountLinks={false} canManageLifecycle={true} onSectionChange={setTab} onClose={()=>setOpen(false)}/>)}{nested&&<Modal open title='Independent dialog' onClose={()=>setNested(false)}><button>Independent task</button></Modal>}</div></QueryClientProvider>;
}
createRoot(document.getElementById('root')).render(<MemoryRouter><Fixture/></MemoryRouter>);
`;
let server: ViteDevServer;
let browser: Browser;
let origin: string;
const errors: string[] = [];
beforeAll(async () => {
  const entry = normalizePath(process.cwd() + "/__staff_profile_fixture.tsx");
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-staff-layout-")), logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "react-router", "@tanstack/react-query", "lucide-react", "@radix-ui/react-popover", "@radix-ui/react-select", "@daypicker/react"] },
    plugins: [react(), tailwindcss(), {
      name: "staff-native-fixture", resolveId: id => id === "/__staff_profile_fixture.tsx" || id === entry ? entry : undefined,
      load(id) {
        if (id === entry) return fixture;
        if (id === normalizePath(process.cwd() + "/src/app/session.tsx")) return 'export function useSession(){return {session:{tenantId:"tenant",subjectId:"synthetic",sessionId:"synthetic"},request:(...args)=>window.staffRequest(...args)};}';
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__staff-profile")) return next();
        void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__staff_profile_fixture.tsx"></script></body></html>')
          .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
      }); },
    }], server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen(); origin = server.resolvedUrls!.local[0]; browser = await launchNativeChromium();
}, 60000);
afterAll(async () => { await browser?.close(); await server?.close(); expect(errors).toEqual([]); });
async function open(width = 320, query = "") {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(5000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(origin + "__staff-profile" + query);
  await page.getByRole("dialog").waitFor();
  if (!query.includes("create") && !query.includes("read=")) await page.getByRole("heading", { name: "Employment profile", exact: true }).waitFor();
  return page;
}
async function settle(page: Page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 40 && !await target.evaluate(e => document.activeElement === e); i++) await page.keyboard.press("Tab");
  expect(await target.evaluate(e => document.activeElement === e)).toBe(true);
}
async function edit(page: Page) { await tabTo(page, page.getByRole("button", { name: "Edit", exact: true })); await page.keyboard.press("Enter"); await page.locator('input[name="displayName"]').waitFor(); await settle(page); }
async function painted(target: Locator) {
  return target.evaluate(element => {
    const modal = element.closest("[data-bunkfy-modal-box]")!;
    const port = modal.children[1].getBoundingClientRect(), rect = element.getBoundingClientRect();
    const css = getComputedStyle(element), outline = parseFloat(css.outlineWidth) + Math.max(0, parseFloat(css.outlineOffset));
    return document.activeElement === element && rect.top - outline >= port.top && rect.bottom + outline <= port.bottom && rect.left - outline >= 0 && rect.right + outline <= innerWidth;
  });
}
async function change(page: Page, action: string, value?: unknown) {
  await page.evaluate(({ action, value }) => (window as unknown as { staffHarness: Record<string, (value: unknown) => unknown> }).staffHarness[action](value), { action, value });
  await settle(page);
}
async function writes(page: Page) { return page.evaluate(() => (window as unknown as { staffWrites: Record<string, unknown>[] }).staffWrites); }
async function readStatus(page: Page, directory: number | "offline", profile: number | "offline") {
  await page.evaluate(({ directory, profile }) => Object.assign(window, { staffReadStatuses: {
    "/api/staff/members/member": directory, "/api/staff/members/member/profile": profile,
  } }), { directory, profile });
}
async function sensitiveAbsent(page: Page) {
  expect(await page.getByText("morgan@example.invalid", { exact: true }).count()).toBe(0);
  expect(await page.locator('input[name="workEmail"]').count()).toBe(0);
  expect(await page.getByRole("button", { name: "Edit", exact: true }).count()).toBe(0);
}
async function holdReads(page: Page) {
  await page.evaluate(() => Object.assign(window, { staffHoldRead: true, staffReadReleases: [], staffRequests: [] }));
}
async function releaseReads(page: Page) {
  await page.evaluate(() => { Object.assign(window, { staffHoldRead: false }); for (const resolve of (window as unknown as { staffReadReleases: (() => void)[] }).staffReadReleases) resolve(); });
  await settle(page);
}
describe("Staff D01 native layout and task continuity", () => {
  it.each([320, 1024])("%i: cold offline Retry explains reconnection, stays focused and resumes without extra reads", async width => {
    const page = await open(width, "?read=503"); try {
      const retry = page.getByRole("button", { name: "Try again", exact: true });
      await retry.waitFor(); await tabTo(page, retry);
      const requests = () => page.evaluate(() => (window as unknown as { staffRequests: unknown[] }).staffRequests.length);
      const before = await requests();
      await page.context().setOffline(true); await settle(page);
      expect(await page.getByRole("status").filter({ hasText: "Reconnect to retry. Staff details cannot be loaded while you are offline." }).count()).toBe(1);
      expect(await retry.isDisabled()).toBe(true);
      expect(await retry.ariaSnapshot()).toContain('[disabled]');
      expect(await painted(retry)).toBe(true);
      await page.keyboard.press("Enter"); await page.keyboard.press("Space"); await settle(page);
      expect(await requests()).toBe(before);
      expect(await page.getByRole("status", { name: "Refreshing staff details", exact: true }).count()).toBe(0);
      await page.context().setOffline(false); await settle(page);
      await expect.poll(() => retry.isEnabled()).toBe(true);
      expect(await painted(retry)).toBe(true);
      await readStatus(page, 200, 200); await page.keyboard.press("Enter");
      await page.getByText("morgan@example.invalid", { exact: true }).waitFor(); await settle(page);
      expect(await painted(page.getByRole("heading", { name: "Employment profile", exact: true }))).toBe(true);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it.each(["both denied", "profile denied", "directory denied", "initial503"])("notice Retry: %s preserves source boundaries and focus through failure and fresh success", async variant => {
    const page = await open(320, variant === "initial503" ? "?read=503" : ""); try {
      if (variant !== "initial503") {
        await readStatus(page, variant === "profile denied" ? 200 : 403, variant === "directory denied" ? 200 : 403);
        await change(page, "refetch");
      }
      const retry = page.getByRole("button", { name: "Try again", exact: true }); await retry.waitFor();
      await readStatus(page, variant === "profile denied" ? 200 : 503, variant === "directory denied" ? 200 : 503);
      await holdReads(page); await tabTo(page, retry); await page.keyboard.press("Enter"); await settle(page);
      expect(await painted(page.getByRole("status", { name: "Refreshing staff details", exact: true }))).toBe(true);
      if (variant !== "directory denied") await sensitiveAbsent(page);
      await releaseReads(page); await retry.waitFor(); await settle(page); expect(await painted(retry)).toBe(true);
      if (variant !== "directory denied") await sensitiveAbsent(page);
      const count = variant === "profile denied" || variant === "directory denied" ? 1 : 2;
      expect(await page.evaluate(() => (window as unknown as { staffRequests: unknown[] }).staffRequests.length)).toBe(count);
      await readStatus(page, 200, 200); await page.keyboard.press("Enter");
      await page.getByText("morgan@example.invalid", { exact: true }).waitFor();
      await expect.poll(() => retry.count()).toBe(0); await settle(page);
      expect(await painted(page.getByRole("heading", { name: "Employment profile", exact: true }))).toBe(true);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it.each(["permission only", "all sources"])("notice Retry: %s is one operation, failed permission does not require Edit authority", async variant => {
    const page = await open(1024, "?readonly"); try {
      if (variant === "all sources") { await readStatus(page, 503, 503); await change(page, "refetch"); }
      await change(page, "setPermission", "stale"); await holdReads(page);
      await page.evaluate(() => Object.assign(window, { staffPermissionResult: "stale" }));
      const retry = page.getByRole("button", { name: "Try again", exact: true }); await retry.click(); await settle(page);
      expect(await painted(page.getByRole("status", { name: "Refreshing staff details", exact: true }))).toBe(true);
      await expect.poll(() => page.evaluate(() => (window as unknown as { staffReadReleases: unknown[] }).staffReadReleases.length)).toBe(variant === "all sources" ? 3 : 1);
      await page.keyboard.press("Enter"); // Pending status is not a second Retry control.
      await releaseReads(page); await retry.waitFor(); await settle(page); expect(await painted(retry)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { staffPermissionReads: number }).staffPermissionReads)).toBe(1);
      expect(await page.evaluate(() => (window as unknown as { staffRequests: unknown[] }).staffRequests.length)).toBe(variant === "all sources" ? 2 : 0);
      await readStatus(page, 200, 200); await page.evaluate(() => Object.assign(window, { staffPermissionResult: "ready" }));
      await retry.click(); await expect.poll(() => retry.count()).toBe(0); await settle(page);
      expect(await painted(page.getByRole("heading", { name: "Employment profile", exact: true }))).toBe(true);
      expect(await page.getByRole("button", { name: "Edit", exact: true }).count()).toBe(0);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it.each(["Tab", "Shift+Tab", "pointer", "independent focus", "Escape", "close", "member", "tenant", "tab", "permission", "unmount", "top modal"])("notice Retry never steals late focus across %s", async boundary => {
    const page = await open(); try {
      await page.getByRole("button", { name: "Close dialog", exact: true }).click(); await page.getByRole("button", { name: "Open Staff", exact: true }).click();
      await readStatus(page, 503, 503); await change(page, "refetch"); await holdReads(page);
      const retry = page.getByRole("button", { name: "Try again", exact: true }); await tabTo(page, retry); await page.keyboard.press("Enter");
      await page.getByRole("status", { name: "Refreshing staff details", exact: true }).waitFor();
      if (["Tab", "Shift+Tab", "Escape"].includes(boundary)) await page.keyboard.press(boundary);
      else if (boundary === "pointer") await page.getByRole("heading", { name: "Morgan Lee", exact: true }).click();
      else if (boundary === "independent focus") await page.getByRole("button", { name: "Close dialog", exact: true }).focus();
      else if (boundary === "close") await page.getByRole("button", { name: "Close dialog", exact: true }).click();
      else { const [action, value] = ({ member: ["setId", "other-member"], tenant: ["setTenant", "other-tenant"], tab: ["setTab", "account"], permission: ["setSensitive", false], unmount: ["setMounted", false], "top modal": ["setNested", true] } as Record<string, [string, unknown]>)[boundary]; await change(page, action, value); }
      await readStatus(page, 200, 200); await releaseReads(page);
      await expect.poll(() => page.getByRole("status", { name: "Refreshing staff details", exact: true }).count()).toBe(0); await settle(page);
      expect(await page.evaluate(() => document.activeElement?.textContent === "Employment profile")).toBe(false);
      if (boundary === "close" || boundary === "Escape") expect(await page.getByRole("button", { name: "Open Staff", exact: true }).evaluate(e => e === document.activeElement)).toBe(true);
      if (boundary === "independent focus") expect(await page.getByRole("button", { name: "Close dialog", exact: true }).evaluate(e => e === document.activeElement)).toBe(true);
      if (boundary === "top modal") expect(await page.getByRole("dialog", { name: "Independent dialog" }).evaluate(e => e.contains(document.activeElement))).toBe(true);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("notice Retry does not start an offline read or duplicate background in-flight reads", async () => {
    const page = await open(); try {
      await readStatus(page, 503, 503); await change(page, "refetch");
      await page.context().setOffline(true); await settle(page);
      expect(await page.getByRole("button", { name: "Reconnect to retry", exact: true }).isDisabled()).toBe(true);
      await page.context().setOffline(false); await holdReads(page);
      await page.evaluate(() => { void (window as unknown as { staffHarness: { refetch: () => Promise<unknown> } }).staffHarness.refetch(); });
      await settle(page); expect(await page.getByRole("button", { name: "Try again", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole("status", { name: "Refreshing staff details", exact: true }).count()).toBe(0);
      await releaseReads(page); expect(await page.evaluate(() => (window as unknown as { staffRequests: unknown[] }).staffRequests.length)).toBe(2);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it.each([320, 1024, 1440])("%i: native notice Retry owns visible pending, failed and recovered focus without duplicate reads", async width => {
    const page = await open(width); try {
      await readStatus(page, 503, 503); await change(page, "refetch");
      const retry = page.getByRole("button", { name: "Try again", exact: true });
      await retry.waitFor(); await tabTo(page, retry);
      await page.evaluate(() => Object.assign(window, { staffHoldRead: true, staffReadReleases: [], staffRequests: [] }));
      await page.keyboard.press("Enter"); await settle(page);
      const pending = page.getByRole("status", { name: "Refreshing staff details", exact: true });
      expect(await pending.count()).toBe(1); expect(await painted(pending)).toBe(true);
      expect(await page.getByText("morgan@example.invalid", { exact: true }).count()).toBe(1);
      await expect.poll(() => page.evaluate(() => (window as unknown as { staffReadReleases: unknown[] }).staffReadReleases.length)).toBe(2);
      await page.evaluate(() => { Object.assign(window, { staffHoldRead: false }); for (const resolve of (window as unknown as { staffReadReleases: (() => void)[] }).staffReadReleases) resolve(); });
      await retry.waitFor(); await settle(page); expect(await painted(retry)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { staffRequests: unknown[] }).staffRequests.length)).toBe(2);
      await readStatus(page, 200, 200); await page.keyboard.press("Enter");
      await expect.poll(() => retry.count()).toBe(0); await settle(page);
      expect(await painted(page.getByRole("heading", { name: "Employment profile", exact: true }))).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { staffRequests: unknown[] }).staffRequests.length)).toBe(4);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("native Edit starts at the first profile field", async () => {
    const page = await open(); try { await edit(page); expect(await painted(page.locator('input[name="displayName"]'))).toBe(true); } finally { await page.close(); }
  });
  it("native Cancel returns to the surviving Edit control", async () => {
    const page = await open(); try {
      await edit(page); await tabTo(page, page.getByRole("button", { name: "Cancel", exact: true })); await page.keyboard.press("Enter"); await settle(page);
      expect(await painted(page.getByRole("button", { name: "Edit", exact: true }))).toBe(true);
    } finally { await page.close(); }
  });
  it("dirty native Work phone remains visible through desktop-to-mobile shrink with caret preserved", async () => {
    const page = await open(1440); try {
      await edit(page); const phone = page.locator('input[name="workPhone"]');
      await tabTo(page, phone); await page.keyboard.type("+441234567890"); await page.keyboard.press("ArrowLeft"); await settle(page);
      const before = await phone.evaluate(e => ({ value: (e as HTMLInputElement).value, caret: (e as HTMLInputElement).selectionStart }));
      expect(await painted(phone)).toBe(true); await page.setViewportSize({ width: 320, height: 800 }); await settle(page);
      expect(await painted(phone)).toBe(true);
      expect(await phone.evaluate(e => ({ value: (e as HTMLInputElement).value, caret: (e as HTMLInputElement).selectionStart }))).toEqual(before);
    } finally { await page.close(); }
  });

  it.each([320, 1024, 1440])("%i: one identity heading, retained status/location/lifecycle and adjacent tabs", async width => {
    const page = await open(width); try {
      expect(await page.getByRole("heading", { level: 2, name: "Morgan Lee", exact: true }).count()).toBe(1);
      expect(await page.getByText("0 current properties", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Employment actions", { exact: true }).count()).toBe(1);
      expect(await page.getByRole("tab", { name: "Profile", exact: true }).count()).toBe(1);
      expect(await page.getByRole("tab", { name: /Locations|Work locations/ }).count()).toBe(1);
      expect(await page.getByRole("tab", { name: /Account/ }).count()).toBe(1);
      expect(await page.getByRole("heading", { name: "Employment profile", exact: true }).evaluate(e => e.getBoundingClientRect().top)).toBeLessThan(400);
      await edit(page); expect(await page.getByRole("heading", { name: "Edit employment profile", exact: true }).count()).toBe(1);
      expect(await page.locator("input").evaluateAll(elements => elements.map(e => ({ name: (e as HTMLInputElement).name, max: (e as HTMLInputElement).maxLength })))).toEqual([
        { name: "displayName", max: 256 }, { name: "legalName", max: 256 }, { name: "jobTitle", max: 128 },
        { name: "department", max: 128 }, { name: "employeeNumber", max: 64 }, { name: "workEmail", max: 320 }, { name: "workPhone", max: 64 },
      ]);
    } finally { await page.close(); }
  });

  it("contract-length unbroken identity wraps locally without horizontal overflow", async () => {
    const page = await open(320, "?long"); try {
      const name = page.getByRole("heading", { level: 2 });
      expect(await name.textContent()).toBe("N".repeat(256));
      expect(await name.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await name.evaluate(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })).toBe(true);
    } finally { await page.close(); }
  });

  it.each([
    [320, 600, "spaced"], [320, 800, "spaced"], [1024, 800, "spaced"], [1440, 800, "spaced"],
    [320, 600, "unbroken"], [320, 800, "unbroken"],
  ] as const)("%ix%i %s: long identity leaves readable task space and painted native controls", async (width, height, content) => {
    const page = await open(width, "?stress=" + content); try {
      await page.setViewportSize({ width, height }); await settle(page);
      const name = content === "unbroken" ? "N".repeat(256) : "Alexandria Natalia Example ".repeat(10).slice(0, 256);
      const dialog = page.getByRole("dialog", { name, exact: true });
      expect(await dialog.count()).toBe(1);
      const body = page.locator("[data-bunkfy-modal-box] > div:nth-child(2)");
      expect(await body.evaluate(e => e.getBoundingClientRect().height)).toBeGreaterThan(height / 2);
      expect(await body.getByText(name, { exact: true }).count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await edit(page);
      const first = page.locator('input[name="displayName"]');
      expect(await first.inputValue()).toBe(name);
      expect(await painted(first)).toBe(true);
      expect(await first.evaluate(e => {
        const label = e.closest("label")!.getBoundingClientRect();
        const port = e.closest("[data-bunkfy-modal-box]")!.children[1].getBoundingClientRect();
        return label.top >= port.top && label.bottom <= port.bottom;
      })).toBe(true);
      const phone = page.locator('input[name="workPhone"]');
      await tabTo(page, phone); await settle(page); expect(await painted(phone)).toBe(true);
      await tabTo(page, page.getByRole("button", { name: "Cancel", exact: true }));
      await page.keyboard.press("Enter"); await settle(page);
      expect(await painted(page.getByRole("button", { name: "Edit", exact: true }))).toBe(true);
      expect(await body.getByText(name, { exact: true }).count()).toBe(1);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("directory-safe long identity stays fully readable without sensitive profile access", async () => {
    const page = await open(320, "?stress=unbroken&directory"); try {
      await page.setViewportSize({ width: 320, height: 600 }); await settle(page);
      const body = page.locator("[data-bunkfy-modal-box] > div:nth-child(2)");
      expect(await body.getByText("N".repeat(256), { exact: true }).count()).toBe(1);
      expect(await body.evaluate(e => e.getBoundingClientRect().height)).toBeGreaterThan(300);
      expect(await page.getByText("morgan@example.invalid", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Edit", exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { staffRequests: { path: string }[] }).staffRequests.some(r => r.path.endsWith("/profile")))).toBe(false);
    } finally { await page.close(); }
  });

  it.each(["member", "permission", "tab", "unmount", "top modal", "independent"])("Cancel rejects focus return across %s boundary", async boundary => {
    const page = await open(); try {
      await edit(page); await tabTo(page, page.getByRole("button", { name: "Cancel", exact: true }));
      await page.evaluate(value => Object.assign(window, { staffBoundary: value }), boundary);
      await page.keyboard.press("Enter"); await settle(page);
      expect(await page.evaluate(() => document.activeElement?.textContent === "Edit")).toBe(false);
      if (boundary === "independent") expect(await page.getByRole("button", { name: "Close dialog", exact: true }).evaluate(e => e === document.activeElement)).toBe(true);
      if (boundary === "top modal") expect(await page.getByRole("dialog", { name: "Independent dialog" }).evaluate(e => e.contains(document.activeElement))).toBe(true);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it.each(["readonly", "directory", "status=departed"])("%s preserves read-only, redaction and immutable-profile boundaries", async query => {
    const page = await open(320, "?" + query); try {
      expect(await page.getByRole("button", { name: "Edit", exact: true }).count()).toBe(0);
      if (query === "directory") {
        expect(await page.getByText("morgan@example.invalid", { exact: true }).count()).toBe(0);
        expect(await page.getByRole("tab", { name: /Account/ }).count()).toBe(0);
        expect(await page.evaluate(() => (window as unknown as { staffRequests: { path: string }[] }).staffRequests.some(r => r.path.endsWith("/profile")))).toBe(false);
      }
      if (query === "status=departed") expect(await page.getByText("Employment actions", { exact: true }).count()).toBe(0);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it.each([403, 503])("initial %i read never exposes a fabricated profile", async status => {
    const page = await open(320, "?read=" + status); try {
      await page.getByText("Staff profile could not be opened", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Edit", exact: true }).count()).toBe(0);
      expect(await page.getByText("morgan@example.invalid", { exact: true }).count()).toBe(0);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("stale profile blocks saving without dropping the seven-field draft", async () => {
    const page = await open(); try {
      await edit(page); await page.locator('input[name="jobTitle"]').fill("Night duty supervisor");
      await change(page, "bump");
      expect(await page.locator('input[name="jobTitle"]').inputValue()).toBe("Night duty supervisor");
      expect(await page.getByRole("button", { name: "Save profile", exact: true }).isDisabled()).toBe(true);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("successful save retains normalized payload and operation/version semantics then restores Edit", async () => {
    const page = await open(); try {
      await edit(page); await page.locator('input[name="displayName"]').fill(" Morgan Updated ");
      await page.locator('input[name="legalName"]').fill("  ");
      await tabTo(page, page.getByRole("button", { name: "Save profile", exact: true })); await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Edit", exact: true }).waitFor(); await settle(page);
      expect(await painted(page.getByRole("button", { name: "Edit", exact: true }))).toBe(true);
      const payloads = await writes(page); expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({ displayName: "Morgan Updated", legalName: null, expectedVersion: 7, workPhone: null });
      expect(payloads[0].operationId).toMatch(/^[0-9a-f-]{36}$/i);
    } finally { await page.close(); }
  });

  it("pending save never steals independently moved focus on completion", async () => {
    const page = await open(); try {
      await edit(page); await page.evaluate(() => Object.assign(window, { staffHoldSave: true }));
      await tabTo(page, page.getByRole("button", { name: "Save profile", exact: true })); await page.keyboard.press("Enter");
      await expect.poll(async () => (await writes(page)).length).toBe(1);
      await expect.poll(() => page.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), { timeout: 1000 }).toBe(true);
      const close = page.getByRole("button", { name: "Close dialog", exact: true }); await tabTo(page, close);
      await page.evaluate(() => (window as unknown as { releaseStaffSave: () => void }).releaseStaffSave());
      await page.getByRole("button", { name: "Edit", exact: true }).waitFor(); await settle(page);
      expect(await close.evaluate(e => e === document.activeElement)).toBe(true);
    } finally { await page.close(); }
  });

  it("failed save preserves the editor and draft instead of returning to read mode", async () => {
    const page = await open(); try {
      await edit(page); await page.locator('input[name="department"]').fill("Night operations");
      await page.evaluate(() => Object.assign(window, { staffSaveStatus: 503 }));
      await tabTo(page, page.getByRole("button", { name: "Save profile", exact: true })); await page.keyboard.press("Enter");
      await expect.poll(async () => (await writes(page)).length).toBe(1);
      await expect.poll(() => page.getByRole("button", { name: "Cancel", exact: true }).isDisabled()).toBe(false);
      expect(await page.locator('input[name="department"]').inputValue()).toBe("Night operations");
      expect(await page.getByRole("button", { name: "Edit", exact: true }).count()).toBe(0);
    } finally { await page.close(); }
  });

  it.each([
    ["permission", "setManage", false], ["member", "setId", "other-member"], ["tab", "setTab", "account"],
    ["unmount", "setOpen", false], ["top modal", "setNested", true],
  ] as const)("late successful save cannot return focus across %s boundary", async (_name, action, value) => {
    const page = await open(); try {
      await edit(page); await page.evaluate(() => Object.assign(window, { staffHoldSave: true }));
      await tabTo(page, page.getByRole("button", { name: "Save profile", exact: true })); await page.keyboard.press("Enter");
      await expect.poll(async () => (await writes(page)).length).toBe(1);
      await change(page, action, value);
      await page.evaluate(() => (window as unknown as { releaseStaffSave: () => void }).releaseStaffSave());
      await expect.poll(() => page.evaluate(() => (window as unknown as { staffHarness: { pending: () => number } }).staffHarness.pending())).toBe(0);
      await settle(page);
      expect(await page.evaluate(() => document.activeElement?.textContent === "Edit")).toBe(false);
      if (action === "setNested") expect(await page.getByRole("dialog", { name: "Independent dialog" }).evaluate(e => e.contains(document.activeElement))).toBe(true);
      expect(await writes(page)).toHaveLength(1);
    } finally { await page.close(); }
  });

  it("background read pending disables writes, preserves draft and does not hijack focus on recovery", async () => {
    const page = await open(); try {
      await edit(page); await page.locator('input[name="workPhone"]').fill("+441234567890");
      await page.evaluate(() => {
        Object.assign(window, { staffHoldRead: true });
        void (window as unknown as { staffHarness: { refetch: () => Promise<unknown> } }).staffHarness.refetch();
      });
      await expect.poll(() => page.getByRole("button", { name: "Save profile", exact: true }).isDisabled()).toBe(true);
      const close = page.getByRole("button", { name: "Close dialog", exact: true }); await tabTo(page, close);
      await page.evaluate(() => { Object.assign(window, { staffHoldRead: false }); for (const resolve of (window as unknown as { staffReadReleases: (() => void)[] }).staffReadReleases) resolve(); });
      await expect.poll(() => page.getByRole("button", { name: "Save profile", exact: true }).isDisabled()).toBe(false);
      expect(await close.evaluate(e => document.activeElement === e)).toBe(true);
      expect(await page.locator('input[name="workPhone"]').inputValue()).toBe("+441234567890");
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("403 after a populated read removes cached sensitive values and edit controls", async () => {
    const page = await open(); try {
      await page.getByText("morgan@example.invalid", { exact: true }).waitFor();
      await page.evaluate(() => Object.assign(window, { staffReadStatus: 403 })); await change(page, "refetch");
      expect(await page.getByText("morgan@example.invalid", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Edit", exact: true }).count()).toBe(0);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it.each([401, 403])("warm profile-only %i conceals sensitive facts but preserves independent directory", async status => {
    const page = await open(); try {
      await readStatus(page, 200, status); await change(page, "refetch"); await sensitiveAbsent(page);
      expect(await page.getByRole("heading", { name: "Morgan Lee", exact: true }).count()).toBe(1);
      expect(await page.getByText("Sensitive identity and work-contact details are not available in this view.", { exact: true }).count()).toBe(1);
      const cache = await page.evaluate(() => (window as unknown as { staffHarness: { cache: () => { key: string[]; data?: unknown }[] } }).staffHarness.cache());
      expect(cache.filter(q => q.key[3] === "profile" && q.data !== undefined)).toEqual([]);
      expect(cache.some(q => q.key[3] === "directory" && q.data !== undefined)).toBe(true);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("directory-only denial does not conceal a separately current successful sensitive profile", async () => {
    const page = await open(); try {
      await readStatus(page, 403, 200); await change(page, "refetch");
      expect(await page.getByText("morgan@example.invalid", { exact: true }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Edit", exact: true }).isEnabled()).toBe(true);
      const cache = await page.evaluate(() => (window as unknown as { staffHarness: { cache: () => { key: string[]; data?: unknown }[] } }).staffHarness.cache());
      expect(cache.filter(q => q.key[3] === "directory" && q.data !== undefined)).toEqual([]);
      expect(cache.some(q => q.key[3] === "profile" && q.data !== undefined)).toBe(true);
    } finally { await page.close(); }
  });

  it("warm both-source denial removes all member facts and never falls back to the denied full object", async () => {
    const page = await open(); try {
      await readStatus(page, 403, 403); await change(page, "refetch"); await sensitiveAbsent(page);
      expect(await page.getByRole("heading", { name: "Morgan Lee", exact: true }).count()).toBe(0);
      expect(await page.getByText("QA-01", { exact: true }).count()).toBe(0);
      expect(await page.getByText("Employment actions", { exact: true }).count()).toBe(0);
      expect(await page.getByText("0 current properties", { exact: true }).count()).toBe(0);
      expect(await page.getByText("Loading staff profile", { exact: true }).count()).toBe(0);
    } finally { await page.close(); }
  });

  it("a denied native-focused draft lands on visible safe access feedback", async () => {
    const page = await open(); try {
      await edit(page); await tabTo(page, page.locator('input[name="workEmail"]')); await page.keyboard.type("extra");
      await readStatus(page, 200, 403); await change(page, "refetch");
      const feedback = page.getByRole("status", { name: "Staff access update", exact: true });
      expect(await feedback.count()).toBe(1);
      const geometry = await feedback.evaluate(e => ({ active: document.activeElement?.outerHTML.slice(0,500), target: e.getBoundingClientRect().toJSON(), port: e.closest('[data-bunkfy-modal-box]')!.children[1].getBoundingClientRect().toJSON(), outline: getComputedStyle(e).outline, offset: getComputedStyle(e).outlineOffset }));
      expect(await painted(feedback), JSON.stringify(geometry)).toBe(true);
      await sensitiveAbsent(page);
    } finally { await page.close(); }
  });

  it("denial feedback does not take focus from independent modal navigation", async () => {
    const page = await open(); try {
      await edit(page); const close = page.getByRole("button", { name: "Close dialog", exact: true }); await tabTo(page, close);
      await readStatus(page, 200, 403); await change(page, "refetch"); await sensitiveAbsent(page);
      expect(await close.evaluate(e => document.activeElement === e)).toBe(true);
    } finally { await page.close(); }
  });

  it("mutation403 is not misclassified as read denial or a cancelled save", async () => {
    const page = await open(); try {
      await edit(page); await page.locator('input[name="department"]').fill("Keep submitted draft");
      await page.evaluate(() => Object.assign(window, { staffSaveStatus: 403 }));
      await tabTo(page, page.getByRole("button", { name: "Save profile", exact: true })); await page.keyboard.press("Enter");
      await expect.poll(async () => (await writes(page)).length).toBe(1);
      await expect.poll(() => page.evaluate(() => (window as unknown as { staffHarness: { pending: () => number } }).staffHarness.pending())).toBe(0);
      expect(await page.locator('input[name="department"]').inputValue()).toBe("Keep submitted draft");
      expect(await page.getByText(/staff details are hidden/).count()).toBe(0);
      expect(await page.getByText(/Unsaved profile changes were cleared/).count()).toBe(0);
    } finally { await page.close(); }
  });

  it("denied dirty draft is cleared with explanation and is not restored by fresh success", async () => {
    const page = await open(); try {
      await edit(page); await page.locator('input[name="workEmail"]').fill("unsaved-secret@example.invalid");
      await readStatus(page, 200, 403); await change(page, "refetch"); await sensitiveAbsent(page);
      expect(await page.getByText(/Unsaved profile changes were cleared/).count()).toBe(1);
      await readStatus(page, 200, 200); await page.getByRole("button", { name: "Try again", exact: true }).click();
      await page.getByText("morgan@example.invalid", { exact: true }).waitFor();
      expect(await page.locator('input[name="workEmail"]').count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.textContent === "Edit")).toBe(false);
      await edit(page); expect(await page.locator('input[name="workEmail"]').inputValue()).toBe("morgan@example.invalid");
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("denial persists through native pending Retry,503/network failures and restores only a fresh success", async () => {
    const page = await open(); try {
      await readStatus(page, 200, 403); await change(page, "refetch"); await sensitiveAbsent(page);
      await readStatus(page, 200, 503); await page.evaluate(() => Object.assign(window, { staffHoldRead: true }));
      await tabTo(page, page.getByRole("button", { name: "Try again", exact: true })); await page.keyboard.press("Enter");
      await expect.poll(() => page.evaluate(() => (window as unknown as { staffReadReleases: unknown[] }).staffReadReleases.length)).toBeGreaterThan(0);
      await sensitiveAbsent(page);
      await page.evaluate(() => { Object.assign(window, { staffHoldRead: false }); for (const resolve of (window as unknown as { staffReadReleases: (() => void)[] }).staffReadReleases) resolve(); });
      await expect.poll(() => page.getByRole("button", { name: "Try again", exact: true }).isEnabled()).toBe(true);
      await sensitiveAbsent(page);
      await readStatus(page, 200, "offline"); await page.getByRole("button", { name: "Try again", exact: true }).click();
      await expect.poll(() => page.getByRole("button", { name: "Try again", exact: true }).isEnabled()).toBe(true); await sensitiveAbsent(page);
      await readStatus(page, 200, 200); await page.getByRole("button", { name: "Try again", exact: true }).click();
      await page.getByText("morgan@example.invalid", { exact: true }).waitFor(); expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it.each(["close/reopen", "member A-B-A", "route unmount/remount"])("denied cache cannot resurrect on %s followed by503", async boundary => {
    const page = await open(); try {
      await readStatus(page, 403, 403); await change(page, "refetch"); await sensitiveAbsent(page);
      await readStatus(page, 503, 503);
      if (boundary === "close/reopen") { await page.getByRole("button", { name: "Close dialog", exact: true }).click(); await page.getByRole("button", { name: "Open Staff", exact: true }).click(); }
      else if (boundary === "member A-B-A") { await change(page, "setId", "other-member"); await page.getByText("morgan@example.invalid", { exact: true }).waitFor(); await change(page, "setId", "member"); }
      else { await change(page, "setMounted", false); await change(page, "setMounted", true); }
      await settle(page); await sensitiveAbsent(page);
      expect(await page.getByRole("heading", { name: "Morgan Lee", exact: true }).count()).toBe(0);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("actual sensitive permission-prop loss immediately removes a dirty draft and keeps directory facts", async () => {
    const page = await open(); try {
      await edit(page); await page.locator('input[name="workEmail"]').fill("unsaved-secret@example.invalid");
      await change(page, "setSensitive", false); await sensitiveAbsent(page);
      expect(await page.getByRole("heading", { name: "Morgan Lee", exact: true }).count()).toBe(1);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("ordinary503 without preceding denial keeps honest stale facts and the disabled draft", async () => {
    const page = await open(); try {
      await edit(page); await page.locator('input[name="department"]').fill("Unsubmitted night shift");
      await readStatus(page, 503, 503); await change(page, "refetch");
      expect(await page.locator('input[name="department"]').inputValue()).toBe("Unsubmitted night shift");
      expect(await page.getByRole("button", { name: "Save profile", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByText(/Unsaved profile changes were cleared/).count()).toBe(0);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("denial during an in-flight save hides the editor but preserves one operation and honest settlement without focus theft", async () => {
    const page = await open(); try {
      await edit(page); await page.locator('input[name="workPhone"]').fill("+441234567890");
      await page.evaluate(() => Object.assign(window, { staffHoldSave: true }));
      await tabTo(page, page.getByRole("button", { name: "Save profile", exact: true })); await page.keyboard.press("Enter");
      await expect.poll(async () => (await writes(page)).length).toBe(1); const sent = (await writes(page))[0];
      await readStatus(page, 200, 403); await change(page, "refetch"); await sensitiveAbsent(page);
      expect(await page.getByText(/save is still in progress/).count()).toBe(1);
      const close = page.getByRole("button", { name: "Close dialog", exact: true }); await tabTo(page, close);
      await page.evaluate(() => (window as unknown as { releaseStaffSave: () => void }).releaseStaffSave());
      await expect.poll(() => page.evaluate(() => (window as unknown as { staffHarness: { pending: () => number } }).staffHarness.pending())).toBe(0);
      await sensitiveAbsent(page); expect(await close.evaluate(e => document.activeElement === e)).toBe(true);
      expect(await writes(page)).toEqual([sent]); expect(sent.expectedVersion).toBe(7); expect(sent.operationId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(await page.getByText(/submitted profile save completed/).count()).toBe(1);
    } finally { await page.close(); }
  });

  it("late save for member A cannot restore another member B's denied profile or move independent focus", async () => {
    const page = await open(); try {
      await edit(page); await page.evaluate(() => Object.assign(window, { staffHoldSave: true }));
      await tabTo(page, page.getByRole("button", { name: "Save profile", exact: true })); await page.keyboard.press("Enter");
      await expect.poll(async () => (await writes(page)).length).toBe(1);
      await change(page, "setId", "other-member"); await page.getByText("morgan@example.invalid", { exact: true }).waitFor();
      await page.evaluate(() => Object.assign(window, { staffReadStatuses: { "/api/staff/members/other-member/profile": 403 } }));
      await change(page, "refetch"); await sensitiveAbsent(page);
      const close = page.getByRole("button", { name: "Close dialog", exact: true }); await tabTo(page, close);
      await page.evaluate(() => (window as unknown as { releaseStaffSave: () => void }).releaseStaffSave());
      await expect.poll(() => page.evaluate(() => (window as unknown as { staffHarness: { pending: () => number } }).staffHarness.pending())).toBe(0);
      await sensitiveAbsent(page); expect(await close.evaluate(e => e === document.activeElement)).toBe(true);
      expect(await writes(page)).toHaveLength(1);
    } finally { await page.close(); }
  });

  it("profile denial removes Account descendants without disabling independently authorized directory access", async () => {
    const page = await open(); try {
      await page.getByRole("tab", { name: "Account link", exact: true }).click();
      await page.getByRole("heading", { name: "Sign-in account link", exact: true }).waitFor();
      await readStatus(page, 200, 403); await change(page, "refetch");
      expect(await page.getByRole("heading", { name: "Sign-in account link", exact: true }).count()).toBe(0);
      expect(await page.getByRole("heading", { name: "Morgan Lee", exact: true }).count()).toBe(1);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it("healthy create preserves native required/email validation, field order and draft on resize", async () => {
    const page = await open(1440, "?create"); try {
      const submit = page.getByRole("button", { name: "Create staff member", exact: true });
      await tabTo(page, submit); await page.keyboard.press("Enter"); expect(await writes(page)).toEqual([]);
      expect(await page.locator('input[name="displayName"]').evaluate(e => document.activeElement === e)).toBe(true);
      await page.keyboard.type(" New colleague "); await page.locator('input[name="workEmail"]').fill("not-an-email");
      await tabTo(page, submit); await page.keyboard.press("Enter"); expect(await writes(page)).toEqual([]);
      await page.locator('input[name="workEmail"]').fill("colleague@example.invalid");
      await page.setViewportSize({ width: 320, height: 800 }); await settle(page);
      expect(await page.locator('input[name="displayName"]').inputValue()).toBe(" New colleague ");
      await tabTo(page, submit); await page.keyboard.press("Enter");
      expect(await writes(page)).toEqual([{ displayName: "New colleague", legalName: null, workEmail: "colleague@example.invalid", workPhone: null, employeeNumber: null, jobTitle: null, department: null }]);
    } finally { await page.close(); }
  });

  it("create dirty Cancel and detail Close retain the outer-modal opener return", async () => {
    for (const query of ["?create", ""]) {
      const page = await open(320, query); try {
        // Establish the genuine opener rather than treating initial fixture mount as an open event.
        await tabTo(page, page.getByRole("button", { name: "Close dialog", exact: true })); await page.keyboard.press("Enter");
        const opener = page.getByRole("button", { name: "Open Staff", exact: true }); await tabTo(page, opener); await page.keyboard.press("Enter");
        if (query) { await page.locator('input[name="displayName"]').fill("Unsaved person"); await tabTo(page, page.getByRole("button", { name: "Cancel", exact: true })); }
        else await tabTo(page, page.getByRole("button", { name: "Close dialog", exact: true }));
        await page.keyboard.press("Enter"); await settle(page);
        expect(await opener.evaluate(e => document.activeElement === e)).toBe(true); expect(await writes(page)).toEqual([]);
      } finally { await page.close(); }
    }
  });

  it("resize does not pull an intentionally scrolled-away focused field back into view", async () => {
    const page = await open(1024); try {
      await edit(page); await tabTo(page, page.locator('input[name="workPhone"]')); await settle(page);
      const port = page.locator('[data-bunkfy-modal-box] > div').nth(1);
      await port.evaluate(e => { e.scrollTop = 0; }); await settle(page);
      await page.setViewportSize({ width: 320, height: 800 }); await settle(page);
      expect(await port.evaluate(e => e.scrollTop)).toBe(0);
    } finally { await page.close(); }
  });
});
