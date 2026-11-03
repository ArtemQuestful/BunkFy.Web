import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type Page, type Locator } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep one integration cell on the real page and permission registry. A panel
// fixture alone cannot expose a child registration unmounting its parent gate.
const integratedFixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router';
import {AccessAuthorityProvider} from '/src/app/accessAuthority.tsx';
import {StaffPage} from '/src/features/staff/StaffPage.tsx';
import '/src/styles.css';
const assignment={assignmentId:'assignment-a',propertyId:'property-a',propertyJobTitle:'Night reception',isPrimary:true,effectiveFrom:'2026-09-01'};
const member={staffMemberId:'member',displayName:'Morgan Lee',jobTitle:'Hostel manager',status:'active',version:7,assignments:[assignment]};
const sequence=new URLSearchParams(location.search).has('sequence');
if(sequence)member.assignments.push({assignmentId:'assignment-c',propertyId:'property-c',propertyJobTitle:'Relief reception',isPrimary:false,effectiveFrom:'2026-09-02'});
window.integrationProperties=[{propertyId:'property-a',name:'Harbour House',code:'HAR',status:'active',version:3},{propertyId:'property-b',name:'Canal Annex',code:'CAN',status:'active',version:5},{propertyId:'property-c',name:'Garden Lodge',code:'GAR',status:'active',version:2}];
window.integrationProperties.push(...Array.from({length:35},(_,i)=>({propertyId:'other-'+i,name:'Other hostel '+i,code:'QA'+i,status:'active',version:1})));
window.integrationRequests=[];window.integrationHoldB=false;window.integrationPending=[];
window.integrationRequest=async(path,options)=>{
 const method=options?.method||'GET';window.integrationRequests.push({path,method});
 if(path==='/api/access/permissions/evaluate'){
  const {checks}=JSON.parse(options.body);
  if(checks.length>32)throw Error('API32-check limit exceeded');
  if(window.integrationHoldB&&checks.some(c=>c.scope.endsWith('/property:property-b')))await new Promise(resolve=>window.integrationPending.push(resolve));
  return {permissions:checks.map(c=>({...c,allowed:sequence||!c.scope.endsWith('/property:property-c')}))};
 }
 if(method!=='GET')throw Error('Unexpected integrated mutation');
 if(path.endsWith('/profile'))return {...member,authSubjectId:null,createdAtUtc:'2026-09-01T00:00:00Z',lastChangedAtUtc:'2026-09-01T00:00:00Z',assignments:sequence?[...member.assignments.map(a=>({...a,assignedAtUtc:'2026-09-01T00:00:00Z',isCurrent:true})),{assignmentId:'ended-b',propertyId:'property-b',propertyJobTitle:'Previous cover',isPrimary:false,effectiveFrom:'2026-08-01',effectiveTo:'2026-08-30',assignedAtUtc:'2026-08-01T00:00:00Z',isCurrent:false}]:member.assignments};
 if(path==='/api/staff/members/member')return member;
 if(path.startsWith('/api/staff/members?'))return {items:[member],page:1,pageSize:30,hasMore:false};
 throw Error('Unexpected integrated read '+path);
};
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><AccessAuthorityProvider><MemoryRouter initialEntries={['/staff?member=member&section=assignments']}><StaffPage/></MemoryRouter></AccessAuthorityProvider></QueryClientProvider>);
`;

describe("Staff page with the actual permission registry", () => {
  it.each([false, 640, 800])("keeps the real page mounted and its owned editor visible (composed sequence=%s)", async sequence => {
    const entry = normalizePath(process.cwd() + "/__staff_integrated_fixture.tsx");
    const runtimeErrors: string[] = [];
    const integrated = await createServer({ configFile: false, root: process.cwd(), cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-staff-integrated-")), logLevel: "error",
      optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "react-router", "@tanstack/react-query", "lucide-react", "@radix-ui/react-popover", "@radix-ui/react-select", "@daypicker/react"] },
      plugins: [react(), tailwindcss(), {
        name: "staff-integrated-fixture", resolveId: id => id === "/__staff_integrated_fixture.tsx" || id === entry ? entry : undefined,
        load(id) {
          if (id === entry) return integratedFixture;
          if (id === normalizePath(process.cwd() + "/src/app/session.tsx")) return 'export function useSession(){return {session:{tenantId:"tenant",username:"operator@example.invalid",subjectId:"operator",sessionId:"session"},request:(...args)=>window.integrationRequest(...args)};}';
          if (id === normalizePath(process.cwd() + "/src/app/workspace.tsx")) return 'export function useWorkspace(){return {properties:window.integrationProperties,selectedProperty:window.integrationProperties[0],propertiesLoaded:true,propertiesLoading:false,propertiesFetching:false,propertiesError:null,refetchProperties:async()=>{},selectProperty:()=>{}};}';
        },
        configureServer(vite) { vite.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/__staff-integrated")) return next();
          void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__staff_integrated_fixture.tsx"></script></body></html>')
            .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
        }); },
      }], server: { host: "127.0.0.1", port: 0 },
    });
    await integrated.listen();
    const page = await browser.newPage({ viewport: { width: sequence ? 1024 : 320, height: 800 } });
    page.setDefaultTimeout(6000);
    page.on("pageerror", error => runtimeErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") runtimeErrors.push(message.text()); });
    try {
      await page.goto(integrated.resolvedUrls!.local[0] + "__staff-integrated" + (sequence ? "?sequence=1" : ""));
      await page.getByRole("heading", { name: /^Current work locations/ }).waitFor({ timeout: 6000 });
      if (sequence) {
        const history = page.locator("summary").filter({ hasText: "Assignment history" });
        await activate(page, history);
        await addAtCanal(page);
        const job = page.locator('input[name="propertyJobTitle"]');
        await tabTo(page, job); await page.keyboard.type("Retained draft");
        await page.setViewportSize({ width: 320, height: Number(sequence) }); await settle(page);
        expect(await fieldPaintContained(job)).toBe(true);
        await activate(page, page.getByRole("button", { name: "Cancel", exact: true }));
        await page.setViewportSize({ width: 1024, height: 800 });
        const end = page.getByRole("button", { name: "End assignment at Garden Lodge", exact: true });
        await activate(page, end);
        const reason = page.locator('textarea[name="reason"]');
        // Entry owns this focus. Do not use fill(), locator.focus(), or Tab
        // away/back: those would hide the initial-focus listener gap.
        expect(await reason.evaluate(e => e === document.activeElement)).toBe(true);
        await page.keyboard.type("Read-only sequence draft");
        const entryContained = await fieldPaintContained(reason);
        if (process.env.BUNKFY_QA_CAPTURE_DIR) await page.screenshot({ path: join(process.env.BUNKFY_QA_CAPTURE_DIR, `composed-end-entry-${sequence}.png`) });
        const draft = await reason.evaluate(e => ({ value: (e as HTMLTextAreaElement).value, caret: (e as HTMLTextAreaElement).selectionStart }));
        await page.setViewportSize({ width: 320, height: Number(sequence) }); await settle(page);
        if (process.env.BUNKFY_QA_CAPTURE_DIR) await page.screenshot({ path: join(process.env.BUNKFY_QA_CAPTURE_DIR, `composed-end-reflow-320x${sequence}.png`) });
        expect(await reason.evaluate(e => e === document.activeElement)).toBe(true);
        expect(await reason.evaluate(e => ({ value: (e as HTMLTextAreaElement).value, caret: (e as HTMLTextAreaElement).selectionStart }))).toEqual(draft);
        expect(entryContained).toBe(true);
        expect(await fieldPaintContained(reason)).toBe(true);
        await activate(page, page.getByRole("button", { name: "Cancel", exact: true }));
        expect(await end.evaluate(e => e === document.activeElement)).toBe(true);
        await page.setViewportSize({ width: 1024, height: 800 });
        await addAtCanal(page); await tabTo(page, job); await page.keyboard.type("Second editor draft");
        await page.setViewportSize({ width: 320, height: Number(sequence) }); await settle(page);
        expect(await fieldPaintContained(job)).toBe(true);
        expect(await job.inputValue()).toContain("Second editor draft");
        await activate(page, page.getByRole("button", { name: "Cancel", exact: true }));
        expect(await page.getByRole("button", { name: "Add work location", exact: true }).evaluate(e => e === document.activeElement)).toBe(true);
        expect(await page.evaluate(() => (window as unknown as { integrationRequests: { path: string; method: string }[] }).integrationRequests.filter(r => r.method !== "GET" && r.path !== "/api/access/permissions/evaluate"))).toEqual([]);
        expect(runtimeErrors).toEqual([]);
        return;
      }
      await page.evaluate(() => { (window as unknown as { integrationHoldB: boolean }).integrationHoldB = true; });
      await addAtCanal(page);
      await expect.poll(() => page.evaluate(() => (window as unknown as { integrationPending: unknown[] }).integrationPending.length)).toBe(1);
      expect(await page.getByRole("dialog").count()).toBe(1);
      expect(await page.getByRole("button", { name: "Add assignment", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Work location", exact: true }).evaluate(e => document.activeElement === e)).toBe(true);
      await page.evaluate(() => { const w = window as unknown as { integrationHoldB: boolean; integrationPending: (() => void)[] }; w.integrationHoldB = false; w.integrationPending.splice(0).forEach(resolve => resolve()); });
      await expect.poll(() => page.getByRole("button", { name: "Add assignment", exact: true }).isEnabled()).toBe(true);
      const job = page.locator('input[name="propertyJobTitle"]');
      await job.fill("Unsent local draft");
      await page.getByRole("button", { name: "Work location", exact: true }).click();
      await page.getByRole("combobox", { name: "Search work location" }).fill("Garden");
      await page.keyboard.press("Enter");
      await page.getByText("You do not have access to manage assignments at this property. Choose another property or ask a workspace administrator.").waitFor();
      expect(await page.getByRole("button", { name: "Add assignment", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole("dialog").count()).toBe(1);
      expect(await page.evaluate(() => (window as unknown as { integrationRequests: unknown[] }).integrationRequests.length)).toBeLessThan(30);
      expect(await page.evaluate(() => (window as unknown as { integrationRequests: { path: string; method: string }[] }).integrationRequests.filter(r => r.method !== "GET" && r.path !== "/api/access/permissions/evaluate"))).toEqual([]);
      expect(runtimeErrors).toEqual([]);
    } catch (error) {
      if (sequence && process.env.BUNKFY_QA_CAPTURE_DIR) await page.screenshot({ path: join(process.env.BUNKFY_QA_CAPTURE_DIR, `composed-failure-${sequence}.png`) });
      throw error;
    } finally { await page.close(); await integrated.close(); }
  }, 30000);
});

// Actual panel, controls, Modal and styles in Chromium. Authority/transport here
// are explicitly synthetic; real-role persistence is a separate preview gate.
const fixture = `
import React,{useReducer} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {StaffAssignmentsPanel} from '/src/features/staff/StaffAssignmentsPanel.tsx';
import {Modal} from '/src/components/ui/primitives.tsx';
import {ApiError} from '/src/api/client.ts';
import '/src/styles.css';
const params=new URLSearchParams(location.search);
const assignment={assignmentId:'assignment-a',propertyId:'property-a',propertyJobTitle:'Night reception',isPrimary:true,effectiveFrom:'2026-09-01'};
const member={staffMemberId:'member',displayName:'Morgan Lee',jobTitle:'Hostel manager',status:'active',version:7,assignments:[assignment]};
const properties=[{propertyId:'property-a',name:'Harbour House',code:'HAR',status:'active',version:3},{propertyId:'property-b',name:'Canal Annex',code:'CAN',status:'active',version:5},{propertyId:'property-c',name:'Garden Lodge',code:'GAR',status:'active',version:2}];
if(params.has('long'))properties[0].name='N'.repeat(256);
if(params.has('empty'))member.assignments=[];
window.state={member,properties,selectedProperty:properties[0],tenantId:'tenant',memberState:'ready',propertyState:'ready',permissionState:'ready',denied:[],history:[],historyRestricted:false,session:{tenantId:'tenant',subjectId:'operator',sessionId:'session'},nested:false,mounted:true};
window.writes=[];window.refreshes=[];window.permissionChecks=[];window.saveStatus=200;window.holdSave=false;window.holdHash=false;
const digest=crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest=async(...args)=>{if(window.holdHash){window.holdHash=false;await new Promise(resolve=>window.releaseHash=resolve);}return digest(...args);};
window.assignmentRequest=async(path,options)=>{
 const payload=JSON.parse(options.body);window.writes.push({path,method:options.method,payload});
 if(window.holdSave)await new Promise(resolve=>window.releaseSave=resolve);
 if(window.saveStatus!==200)throw new ApiError('Synthetic assignment failure',window.saveStatus);
 return {staffMemberId:'member',version:8,status:'active'};
};
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}});
function Fixture(){
 const [,render]=useReducer(x=>x+1,0),s=window.state;
 window.change=patch=>{Object.assign(s,patch);render();};
 const source=(label,state)=>({label,state:state==='refreshing'?'ready':state,isFetching:state==='refreshing',refetch:async()=>{}});
 const memberSource=source('Staff member',s.memberState),propertySource=source('Property catalogue',s.propertyState),permissionSource=source('Assignment access',s.permissionState);
 return <QueryClientProvider client={client}><button>Outside task</button>{s.mounted&&<Modal open title='Morgan Lee' onClose={()=>window.change({mounted:false})}><StaffAssignmentsPanel tenantId={s.tenantId} member={s.member} currentMember={s.memberState==='ready'?s.member:null} memberSource={memberSource} properties={s.properties} selectedProperty={s.selectedProperty} propertySource={propertySource} assignmentPermissionSource={permissionSource} canAssign={true} assignmentHistory={s.history} historyRestricted={s.historyRestricted} historyStale={s.historyStale||false} onUpdated={async(tenant,id)=>{window.refreshes.push({tenant,id});}}/></Modal>}{s.nested&&<Modal open title='Other task' onClose={()=>window.change({nested:false})}><button>Other task action</button></Modal>}</QueryClientProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
let server: ViteDevServer;
let browser: Browser;
let origin: string;
const errors: string[] = [];
beforeAll(async () => {
  const entry = normalizePath(process.cwd() + "/__staff_assignment_fixture.tsx");
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-staff-assignment-")), logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "@tanstack/react-query", "lucide-react", "@radix-ui/react-popover", "@radix-ui/react-select", "@daypicker/react"] },
    plugins: [react(), tailwindcss(), {
      name: "staff-assignment-native-fixture", resolveId: id => id === "/__staff_assignment_fixture.tsx" || id === entry ? entry : undefined,
      load(id) {
        if (id === entry) return fixture;
        if (id === normalizePath(process.cwd() + "/src/app/session.tsx")) return 'export function useSession(){return {session:window.state.session,request:(...args)=>window.assignmentRequest(...args)};}';
        if (id === normalizePath(process.cwd() + "/src/app/permissions.ts")) return `export const permissions={staffAssignProperties:'staff.assign-properties'};export const propertyAccessScope=(t,p)=>'tenant:'+t+'/property:'+p;export function usePermissions(checks){window.permissionChecks=checks;const s=window.state;return {hasData:s.permissionState!=='loading',isLoading:s.permissionState==='loading',isFetching:s.permissionState==='refreshing',error:['stale','unavailable'].includes(s.permissionState)?Error('Synthetic permission failure'):null,refetch:async()=>{},allows:(p,scope)=>checks.some(c=>c.permission===p&&c.scope===scope)&&!s.denied.some(id=>scope.endsWith('/property:'+id))};}`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__staff-assignment")) return next();
        void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__staff_assignment_fixture.tsx"></script></body></html>')
          .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
      }); },
    }], server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen(); origin = server.resolvedUrls!.local[0]; browser = await launchNativeChromium();
}, 60000);
afterAll(async () => { await browser?.close(); await server?.close(); expect(errors).toEqual([]); });
async function open(width = 320, query = "") {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(4000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(origin + "__staff-assignment" + query);
  await page.getByRole("dialog", { name: "Morgan Lee" }).waitFor();
  return page;
}
async function settle(page: Page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 60 && !await target.evaluate(e => document.activeElement === e); i++) await page.keyboard.press("Tab");
  expect(await target.evaluate(e => document.activeElement === e)).toBe(true);
}
async function activate(page: Page, target: Locator) { await tabTo(page, target); await page.keyboard.press("Enter"); await settle(page); }
async function contained(target: Locator) {
  return target.evaluate(element => {
    const modal = element.closest("[data-bunkfy-modal-box]")!, port = modal.children[1].getBoundingClientRect(), r = element.getBoundingClientRect();
    const style = getComputedStyle(element), paint = parseFloat(style.outlineWidth) + Math.max(0, parseFloat(style.outlineOffset));
    return r.left - paint >= port.left && r.right + paint <= port.right && r.top - paint >= port.top && r.bottom + paint <= port.bottom;
  });
}
async function change(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(patch => (window as unknown as { change: (patch: unknown) => void }).change(patch), patch);
  await settle(page);
}
async function addAtCanal(page: Page) {
  await activate(page, page.getByRole("button", { name: "Add work location", exact: true }));
  await activate(page, page.getByRole("button", { name: "Work location", exact: true }));
  await page.getByRole("combobox", { name: "Search work location" }).fill("CAN");
  await page.keyboard.press("Enter"); await settle(page);
}
async function endAtHarbour(page: Page) {
  await activate(page, page.getByRole("button", { name: "End assignment at Harbour House", exact: true }));
  await page.getByRole("textbox", { name: "Reason", exact: true }).fill("Rotation to the other hostel");
}
async function writes(page: Page) {
  return page.evaluate(() => (window as unknown as { writes: { path: string; method: string; payload: Record<string, unknown> }[] }).writes);
}

async function fieldPaintContained(field: Locator) {
  return field.evaluate(element => {
    const bounds = element.closest("[data-bunkfy-modal-box]")!.children[1].getBoundingClientRect();
    const r = element.getBoundingClientRect(), label = element.closest("label")?.getBoundingClientRect();
    const style = getComputedStyle(element);
    const shadows = style.boxShadow.replace(/rgba?\([^)]*\)/g, "").split(",").map(shadow => {
      const [x = 0, y = 0, blur = 0, spread = 0] = [...shadow.matchAll(/(-?[\d.]+)px/g)].map(match => Number(match[1]));
      return Math.abs(x) + Math.abs(y) + Math.max(0, blur) + Math.max(0, spread);
    });
    const paint = Math.max(parseFloat(style.outlineWidth) + Math.max(0, parseFloat(style.outlineOffset)), ...shadows);
    return r.top - paint >= bounds.top && r.bottom + paint <= bounds.bottom &&
      r.left - paint >= bounds.left && r.right + paint <= bounds.right && (!label || label.top >= bounds.top);
  });
}

async function twoLocations(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { state: { member: { assignments: object[] } }; change: (patch: unknown) => void };
    w.change({ member: { ...w.state.member, assignments: [...w.state.member.assignments,
      { assignmentId: "assignment-c", propertyId: "property-c", propertyJobTitle: "Relief reception", isPrimary: false, effectiveFrom: "2026-09-02" }] } });
  });
  await settle(page);
}

describe("assignment focused field reflow", () => {
  for (const action of ["add", "end"]) for (const height of [800, 640]) it(`keeps ${action} field label, caret and complete ring after 1024 to 320x${height}`, async () => {
    const page = await open(1024);
    try {
      await twoLocations(page);
      if (action === "add") await addAtCanal(page);
      else await activate(page, page.getByRole("button", { name: "End assignment at Harbour House", exact: true }));
      const field = page.locator(action === "add" ? 'input[name="propertyJobTitle"]' : 'textarea[name="reason"]');
      await tabTo(page, field); await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.type("Night reception draft"); await settle(page);
      expect(await fieldPaintContained(field)).toBe(true);
      const before = await field.evaluate(e => ({ value: (e as HTMLInputElement).value, start: (e as HTMLInputElement).selectionStart, end: (e as HTMLInputElement).selectionEnd }));
      await page.setViewportSize({ width: 320, height }); await settle(page);
      if (process.env.BUNKFY_QA_CAPTURE_DIR) await page.screenshot({ path: join(process.env.BUNKFY_QA_CAPTURE_DIR, `resize-${action}-320x${height}.png`) });
      expect(await field.evaluate(e => e === document.activeElement)).toBe(true);
      expect(await field.evaluate(e => ({ value: (e as HTMLInputElement).value, start: (e as HTMLInputElement).selectionStart, end: (e as HTMLInputElement).selectionEnd }))).toEqual(before);
      expect(await fieldPaintContained(field)).toBe(true);
      await activate(page, page.getByRole("button", { name: "Cancel", exact: true }));
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  }, 15000);

  it("keeps the full field ring visible after native reentry on a short viewport", async () => {
    const page = await open(1024);
    try {
      await twoLocations(page); await addAtCanal(page);
      const field = page.locator('input[name="propertyJobTitle"]'); await tabTo(page, field);
      await page.setViewportSize({ width: 320, height: 640 }); await settle(page);
      await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab"); await settle(page);
      if (process.env.BUNKFY_QA_CAPTURE_DIR) await page.screenshot({ path: join(process.env.BUNKFY_QA_CAPTURE_DIR, "native-reentry-320x640.png") });
      expect(await field.evaluate(e => e === document.activeElement)).toBe(true);
      expect(await fieldPaintContained(field)).toBe(true);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  }, 15000);

  it("does not pull a deliberately scrolled-away field back during shrink", async () => {
    const page = await open(1024);
    try {
      await twoLocations(page); await addAtCanal(page);
      const field = page.locator('input[name="propertyJobTitle"]'); await tabTo(page, field);
      await page.setViewportSize({ width: 320, height: 800 }); await settle(page);
      expect(await fieldPaintContained(field)).toBe(true);
      await page.mouse.move(150, 250); await page.mouse.wheel(0, -2000);
      await expect.poll(() => field.evaluate(e => e.closest("[data-bunkfy-modal-box]")!.children[1].scrollTop)).toBe(0);
      expect(await fieldPaintContained(field)).toBe(false);
      await page.setViewportSize({ width: 320, height: 640 }); await settle(page);
      expect(await field.evaluate(e => e === document.activeElement)).toBe(true);
      expect(await fieldPaintContained(field)).toBe(false);
      expect(await field.evaluate(e => e.closest("[data-bunkfy-modal-box]")!.children[1].scrollTop)).toBe(0);
    } finally { await page.close(); }
  }, 15000);

  it("does not fight a native active pointer gesture during shrink", async () => {
    const page = await open(1024);
    try {
      await twoLocations(page); await addAtCanal(page);
      const field = page.locator('input[name="propertyJobTitle"]'); await tabTo(page, field); await settle(page);
      const box = await field.boundingBox(); await page.mouse.move(box!.x + 8, box!.y + 8); await page.mouse.down();
      expect(await field.evaluate(e => e === document.activeElement)).toBe(true);
      await page.setViewportSize({ width: 320, height: 640 }); await settle(page);
      expect(await fieldPaintContained(field)).toBe(false);
      await page.mouse.up();
      expect(await writes(page)).toEqual([]);
    } finally { await page.mouse.up(); await page.close(); }
  }, 15000);

  it("does not replay consumed entry after manual scroll and authority recovery", async () => {
    const page = await open(1024);
    try {
      await twoLocations(page); await endAtHarbour(page);
      const field = page.locator('textarea[name="reason"]');
      await page.setViewportSize({ width: 320, height: 640 }); await settle(page);
      expect(await fieldPaintContained(field)).toBe(true);
      await page.mouse.move(150, 250); await page.mouse.wheel(0, -2000);
      await expect.poll(() => field.evaluate(e => e.closest("[data-bunkfy-modal-box]")!.children[1].scrollTop)).toBe(0);
      expect(await fieldPaintContained(field)).toBe(false);
      await field.evaluate(e => {
        const port = e.closest("[data-bunkfy-modal-box]")!.children[1];
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
        const calls: number[] = []; Object.assign(window, { entryScrollWrites: calls });
        Object.defineProperty(port, "scrollTop", { configurable: true, get: () => descriptor.get!.call(port), set: value => { calls.push(value); descriptor.set!.call(port, value); } });
      });
      await change(page, { permissionState: "refreshing" });
      await change(page, { permissionState: "unavailable" });
      await change(page, { permissionState: "ready" });
      // React may preserve the same scroll position when disabling a focused
      // field. Reject any pullback, not a no-op write of the manual position.
      expect(await page.evaluate(() => (window as unknown as { entryScrollWrites: number[] }).entryScrollWrites.every(value => value === 0))).toBe(true);
      expect(await field.evaluate(e => e.closest("[data-bunkfy-modal-box]")!.children[1].scrollTop)).toBe(0);
      expect(await fieldPaintContained(field)).toBe(false);
      expect(await field.inputValue()).toBe("Rotation to the other hostel");
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  }, 15000);

  it.each(["independent Close", "nested modal", "authority lost"])("does not reveal the old editor after %s", async boundary => {
    const page = await open(1024);
    try {
      await twoLocations(page); await addAtCanal(page);
      const field = page.locator('input[name="propertyJobTitle"]'); await tabTo(page, field);
      if (boundary === "independent Close") await tabTo(page, page.getByRole("button", { name: "Close dialog", exact: true }));
      else if (boundary === "nested modal") { await change(page, { nested: true }); await tabTo(page, page.getByRole("button", { name: "Other task action", exact: true })); }
      else await change(page, { permissionState: "loading" });
      const focused = await page.evaluateHandle(() => document.activeElement);
      // Native scroll anchoring may leave the old field incidentally visible.
      // Count application scrollTop writes instead of requiring it to be hidden.
      await field.evaluate(e => {
        const port = e.closest("[data-bunkfy-modal-box]")!.children[1];
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
        const calls: number[] = []; Object.assign(window, { resizeScrollWrites: calls });
        Object.defineProperty(port, "scrollTop", { configurable: true, get: () => descriptor.get!.call(port), set: value => { calls.push(value); descriptor.set!.call(port, value); } });
      });
      await page.setViewportSize({ width: 320, height: 640 }); await settle(page);
      expect(await focused.evaluate(e => e === document.activeElement)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { resizeScrollWrites: number[] }).resizeScrollWrites)).toEqual([]);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  }, 15000);
});

describe("staff local work-location workspace", () => {
  it("keeps short contextual actions contained at320 and returns Cancel to the exact row", async () => {
    const page = await open();
    try {
      const end = page.getByRole("button", { name: "End assignment at Harbour House", exact: true });
      expect(await end.count()).toBe(1);
      await activate(page, end);
      await page.getByRole("textbox", { name: "Reason", exact: true }).fill("Shift coverage changed");
      await activate(page, page.getByRole("button", { name: "Cancel", exact: true }));
      expect(await end.evaluate(e => e === document.activeElement)).toBe(true);
      expect(await contained(end)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { writes: unknown[] }).writes)).toEqual([]);
    } finally { await page.close(); }
  }, 15000);
  it("adds a locally selected property without changing the shell context", async () => {
    const page = await open(1024);
    try {
      const add = page.getByRole("button", { name: "Add work location", exact: true });
      expect(await add.count()).toBe(1);
      await activate(page, add);
      const picker = page.getByRole("button", { name: "Work location", exact: true });
      await activate(page, picker);
      await page.getByRole("combobox", { name: "Search work location" }).fill("Canal");
      await page.keyboard.press("Enter"); await settle(page);
      expect(await page.evaluate(() => (window as unknown as { state: { selectedProperty: { propertyId: string } } }).state.selectedProperty.propertyId)).toBe("property-a");
      expect(await page.getByRole("button", { name: "Add assignment", exact: true }).isEnabled()).toBe(true);
    } finally { await page.close(); }
  }, 15000);

  for (const width of [320, 1024, 1440]) it(`contains unbroken property identity and native actions at${width}`, async () => {
    const page = await open(width, "?long");
    try {
      const end = page.getByRole("button", { name: "End assignment at " + "N".repeat(256), exact: true });
      await activate(page, end);
      const reason = page.getByRole("textbox", { name: "Reason", exact: true });
      expect(await reason.evaluate(e => e === document.activeElement)).toBe(true);
      expect(await contained(reason)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.getByRole("dialog").evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
      await activate(page, page.getByRole("button", { name: "Cancel", exact: true }));
      expect(await contained(end)).toBe(true);
    } finally { await page.close(); }
  }, 15000);

  it("keeps an empty view useful and Escape closes only the searchable picker", async () => {
    const page = await open(320, "?empty");
    try {
      expect(await page.getByText("No current work locations. Add the property where this person works.").count()).toBe(1);
      await activate(page, page.getByRole("button", { name: "Add work location", exact: true }));
      const picker = page.getByRole("button", { name: "Work location", exact: true });
      await activate(page, picker);
      await page.getByRole("combobox", { name: "Search work location" }).fill("zzzz");
      await page.keyboard.press("Enter");
      expect(await writes(page)).toEqual([]);
      await page.keyboard.press("Escape"); await settle(page);
      expect(await page.getByRole("dialog", { name: "Morgan Lee" }).count()).toBe(1);
      expect(await picker.evaluate(e => e === document.activeElement)).toBe(true);
      await activate(page, page.getByRole("button", { name: "Cancel", exact: true }));
      expect(await page.getByRole("button", { name: "Add work location", exact: true }).evaluate(e => e === document.activeElement)).toBe(true);
    } finally { await page.close(); }
  }, 15000);

  it("does not let shell A deny local B or let allowed A authorize denied B", async () => {
    const page = await open();
    try {
      await change(page, { denied: ["property-a"] });
      expect(await page.getByRole("button", { name: "End assignment at Harbour House" }).count()).toBe(0);
      await addAtCanal(page);
      const save = page.getByRole("button", { name: "Add assignment", exact: true });
      expect(await save.isEnabled()).toBe(true);
      await change(page, { denied: ["property-b"] });
      expect(await save.isDisabled()).toBe(true);
      expect(await page.getByText(/You do not have access to manage assignments at this property/).count()).toBe(1);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  }, 15000);

  for (const source of ["memberState", "propertyState", "permissionState"]) {
    for (const state of ["loading", "refreshing", "stale", "unavailable"]) it(`retains a disabled draft during${source}:${state}`, async () => {
      const page = await open();
      try {
        await endAtHarbour(page);
        await change(page, { [source]: state });
        expect(await page.getByRole("textbox", { name: "Reason", exact: true }).inputValue()).toBe("Rotation to the other hostel");
        expect(await page.getByRole("button", { name: "End assignment", exact: true }).isDisabled()).toBe(true);
        expect(await writes(page)).toEqual([]);
        await change(page, { [source]: "ready" });
        expect(await page.getByRole("button", { name: "End assignment", exact: true }).isEnabled()).toBe(true);
      } finally { await page.close(); }
    }, 15000);
  }

  it("blocks a changed member revision without silently rebasing the draft", async () => {
    const page = await open();
    try {
      await endAtHarbour(page);
      await page.evaluate(() => { const w = window as unknown as { state: { member: object }; change: (patch: unknown) => void }; w.change({ member: { ...w.state.member, version: 8 } }); });
      await settle(page);
      expect(await page.getByRole("button", { name: "End assignment", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByText(/This staff record has changed/).count()).toBe(1);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  }, 15000);

  it("keeps Cancel reachable when another operator has ended the selected assignment", async () => {
    const page = await open();
    try {
      await endAtHarbour(page);
      await page.evaluate(() => { const w = window as unknown as { state: { member: object }; change: (patch: unknown) => void }; w.change({ member: { ...w.state.member, version: 8, assignments: [] } }); });
      await settle(page);
      expect(await page.getByRole("button", { name: "End assignment", exact: true }).isDisabled()).toBe(true);
      await activate(page, page.getByRole("button", { name: "Cancel", exact: true }));
      expect(await page.getByRole("button", { name: "Add work location", exact: true }).isEnabled()).toBe(true);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  }, 15000);

  it("clears an Add draft if the staff member becomes suspended", async () => {
    const page = await open();
    try {
      await addAtCanal(page);
      await page.evaluate(() => { const w = window as unknown as { state: { member: object }; change: (patch: unknown) => void }; w.change({ member: { ...w.state.member, version: 8, status: "suspended" } }); });
      await settle(page);
      expect(await page.getByRole("button", { name: "Add assignment", exact: true }).count()).toBe(0);
      await page.evaluate(() => { const w = window as unknown as { state: { member: object }; change: (patch: unknown) => void }; w.change({ member: { ...w.state.member, version: 9, status: "active" } }); });
      await settle(page);
      expect(await page.getByRole("button", { name: "Add assignment", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Add work location", exact: true }).isEnabled()).toBe(true);
    } finally { await page.close(); }
  }, 15000);

  for (const width of [320, 1024]) for (const action of ["add", "end"]) it(`returns focus locally when${action} closes after suspension at${width}`, async () => {
    const page = await open(width);
    try {
      if (action === "add") { await addAtCanal(page); await page.locator('input[name="propertyJobTitle"]').focus(); }
      else await endAtHarbour(page);
      await page.evaluate(() => { const w = window as unknown as { state: { member: object }; change: (patch: unknown) => void }; w.change({ member: { ...w.state.member, version: 8, status: "suspended" } }); });
      await settle(page);
      if (process.env.BUNKFY_QA_CAPTURE_DIR) await page.screenshot({ path: join(process.env.BUNKFY_QA_CAPTURE_DIR, `status-loss-${width}-${action}.png`) });
      const heading = page.getByRole("heading", { name: /^Current work locations/ });
      expect(await heading.evaluate(e => e === document.activeElement)).toBe(true);
      expect(await contained(heading)).toBe(true);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  }, 15000);

  it("does not steal an independent close control when suspension removes an editor", async () => {
    const page = await open();
    try {
      await addAtCanal(page);
      const close = page.getByRole("button", { name: "Close dialog", exact: true }); await close.focus();
      await page.evaluate(() => { const w = window as unknown as { state: { member: object }; change: (patch: unknown) => void }; w.change({ member: { ...w.state.member, version: 8, status: "suspended" } }); });
      await settle(page);
      expect(await close.evaluate(e => document.activeElement === e)).toBe(true);
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  }, 15000);

  for (const kind of ["revision", "disappeared"]) it(`blocks a property that${kind} after editor entry`, async () => {
    const page = await open();
    try {
      await endAtHarbour(page);
      await page.evaluate(kind => { const w = window as unknown as { state: { properties: { propertyId: string; version: number }[] }; change: (patch: unknown) => void }; w.change({ properties: kind === "disappeared" ? w.state.properties.filter(p => p.propertyId !== "property-a") : w.state.properties.map(p => ({ ...p, version: p.version + 1 })) }); }, kind);
      await settle(page);
      expect(await writes(page)).toEqual([]);
      const submit = page.getByRole("button", { name: "End assignment", exact: true });
      expect(await submit.isDisabled()).toBe(true);
    } finally { await page.close(); }
  }, 15000);

  it("can end an existing retired-property assignment without offering retired properties for Add", async () => {
    const page = await open();
    try {
      await page.evaluate(() => { const w = window as unknown as { state: { properties: object[] }; change: (patch: unknown) => void }; w.change({ properties: w.state.properties.map((p, i) => ({ ...p, status: i === 0 ? "retired" : "active" })) }); });
      await settle(page); await endAtHarbour(page);
      expect(await page.getByRole("button", { name: "End assignment", exact: true }).isEnabled()).toBe(true);
      await activate(page, page.getByRole("button", { name: "Cancel", exact: true }));
      await addAtCanal(page);
      expect(await page.getByRole("button", { name: "Add assignment", exact: true }).isEnabled()).toBe(true);
    } finally { await page.close(); }
  }, 15000);

  for (const status of ["suspended", "departed"]) it(`does not expand${status} assignment actions`, async () => {
    const page = await open();
    try {
      await page.evaluate(status => { const w = window as unknown as { state: { member: object }; change: (patch: unknown) => void }; w.change({ member: { ...w.state.member, status } }); }, status);
      await settle(page);
      expect(await page.getByRole("button", { name: /End assignment|Add work location/ }).count()).toBe(0);
      expect(await page.getByRole("heading", { name: "Harbour House", exact: true }).count()).toBe(1);
    } finally { await page.close(); }
  });

  it("rechecks authority after asynchronous hash preparation before dispatch", async () => {
    const page = await open();
    try {
      await endAtHarbour(page);
      await page.evaluate(() => { (window as unknown as { holdHash: boolean }).holdHash = true; });
      await activate(page, page.getByRole("button", { name: "End assignment", exact: true }));
      await page.waitForFunction(() => Boolean((window as unknown as { releaseHash?: () => void }).releaseHash));
      await change(page, { denied: ["property-a"] });
      await page.evaluate(() => (window as unknown as { releaseHash: () => void }).releaseHash());
      await page.getByText("The assignment context changed before saving. Review it and try again.").waitFor();
      expect(await writes(page)).toEqual([]);
    } finally { await page.close(); }
  }, 15000);

  it("preserves the attempted operation on retry and changes it when the reason changes", async () => {
    const page = await open();
    try {
      await endAtHarbour(page);
      await page.evaluate(() => { (window as unknown as { saveStatus: number }).saveStatus = 503; });
      const save = page.getByRole("button", { name: "End assignment", exact: true });
      await activate(page, save); await page.getByText("Synthetic assignment failure").waitFor();
      await activate(page, save); await page.waitForFunction(() => (window as unknown as { writes: unknown[] }).writes.length === 2);
      await page.getByRole("textbox", { name: "Reason", exact: true }).fill("Different agreed rotation");
      await activate(page, save); await page.waitForFunction(() => (window as unknown as { writes: unknown[] }).writes.length === 3);
      const requests = await writes(page);
      expect(requests[0].payload.operationId).toBe(requests[1].payload.operationId);
      expect(requests[2].payload.operationId).not.toBe(requests[1].payload.operationId);
      expect(requests.every(r => r.payload.expectedVersion === 7 && r.method === "POST" && r.path.endsWith("/property-a/members/member/unassign"))).toBe(true);
    } finally { await page.close(); }
  }, 15000);

  it("does not replace a pending operation or let its late receipt close a different context", async () => {
    const page = await open();
    try {
      await addAtCanal(page);
      await page.evaluate(() => { (window as unknown as { holdSave: boolean }).holdSave = true; });
      await activate(page, page.getByRole("button", { name: "Add assignment", exact: true }));
      await page.waitForFunction(() => Boolean((window as unknown as { releaseSave?: () => void }).releaseSave));
      expect(await page.getByRole("button", { name: "Cancel", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Work location", exact: true }).isDisabled()).toBe(true);
      await change(page, { tenantId: "other-tenant" });
      expect(await page.getByRole("button", { name: "Add assignment", exact: true }).count()).toBe(0);
      await page.evaluate(() => (window as unknown as { releaseSave: () => void }).releaseSave());
      await page.waitForFunction(() => (window as unknown as { refreshes: unknown[] }).refreshes.length === 1);
      expect(await page.evaluate(() => (window as unknown as { refreshes: unknown[] }).refreshes)).toEqual([{ tenant: "tenant", id: "member" }]);
      const requests = await writes(page);
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe("PUT");
      expect(requests[0].path).toContain("/property-b/");
    } finally { await page.close(); }
  }, 15000);

  it("keeps authorized last-confirmed history stable and never labels unavailable history empty", async () => {
    const page = await open();
    try {
      await change(page, { history: [{ assignmentId: "old", propertyId: "property-c", isCurrent: false, isPrimary: false, effectiveFrom: "2026-08-01", effectiveTo: "2026-08-31", assignedAtUtc: "2026-08-01T00:00:00Z" }] });
      const summary = page.locator("summary"); await activate(page, summary);
      expect(await page.getByRole("heading", { name: "Garden Lodge", exact: true }).count()).toBe(1);
      await change(page, { historyStale: true });
      expect(await page.getByRole("heading", { name: "Garden Lodge", exact: true }).count()).toBe(1);
      expect(await page.getByText(/Last confirmed history/).count()).toBe(1);
      await change(page, { history: null, historyRestricted: true });
      expect(await page.getByRole("heading", { name: "Garden Lodge", exact: true }).count()).toBe(0);
      expect(await page.getByText(/history is not available with your current access/).count()).toBe(1);
      expect(await page.getByText("No ended assignments.", { exact: true }).count()).toBe(0);
    } finally { await page.close(); }
  }, 15000);
});
