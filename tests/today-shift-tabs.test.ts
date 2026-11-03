import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Actual Dashboard, router, queue controls and CSS. Synthetic read/permission
// adapters test ownership/reflow, not real API, authentication or preview acceptance.
const stateModule = `
import React,{useEffect} from "react";
export const property="11111111-1111-4111-8111-111111111111",other="22222222-2222-4222-8222-222222222222",date="2026-09-19";
export const state={property,generation:1,quality:"ready",canRead:true};
export let update=()=>{};export function bind(fn){update=fn;}
export function useTargetProperty(id){useEffect(()=>{if(id&&id!==state.property)update({property:id});},[id]);}
export const permissions={inventoryRead:"inventory.read",reservationsRead:"reservations.read",reservationsCreate:"reservations.create",propertiesRead:"properties.read",reservationsCheckIn:"reservations.checkin",reservationsCheckOut:"reservations.checkout"};
export const propertyAccessScope=(_tenant,p)=>p;
export const usePermissions=()=>({hasData:true,error:null,isFetching:false,allows:()=>state.canRead,refetch:async()=>{}});
export const useSession=()=>({request:async()=>{throw Error("Unexpected request in synthetic fixture")},session:{tenantId:property,subjectId:property,sessionId:property,generation:state.generation}});
export const useWorkspace=()=>({selectedPropertyId:state.property,selectedProperty:{propertyId:state.property,name:"Synthetic hostel"},properties:[property,other].map(propertyId=>({propertyId,name:"Synthetic hostel"})),propertiesLoading:false,propertiesError:null,refetchProperties:async()=>{}});
export function useQuery({queryKey}){
 const p=state.property,roomId="33333333-3333-4333-8333-333333333333",unit="44444444-4444-4444-8444-444444444444";
 const item=(n,name,status,arrival,departure)=>({propertyId:p,reservationId:"55555555-5555-4555-8555-"+String(n).padStart(12,"0"),primaryGuestName:name,status,arrival,departure,expectedArrivalTime:null,expectedDepartureTime:null,guestCount:1,inventoryUnitCount:1,inventoryUnitIds:[unit],holdsInventory:true,sourceKind:"direct"});
 const records=[...Array.from({length:56},(_,i)=>item(i+1,"Attention "+(i+1),"confirmed","2026-09-17","2026-09-21")),item(57,"Arrival one","confirmed",date,"2026-09-21"),item(58,"Arrival two","confirmed",date,"2026-09-21"),item(59,"Departure one","checkedIn","2026-09-17",date),item(60,"Departure two","checkedIn","2026-09-17",date),item(61,"Staying one","checkedIn",date,"2026-09-21")];
 const count=n=>({reservationCount:n,guestCount:n,inventoryUnitCount:n});
 records[56].primaryGuestName="Arrival one — Synthetic Alexandra-Marie Konstantinopoulos";
 const snapshot={propertyId:p,localDate:date,timeZoneId:"Europe/London",cohorts:{confirmedArrivalsOnLocalDate:count(2),scheduledDeparturesOnLocalDate:count(2),currentlyInHouse:count(3)},attention:{total:count(56)},upcoming:[item(62,"Synthetic Maximilian-Alexander Konstantinopoulos","confirmed","2026-09-21","2026-09-24")]};
 const room={propertyId:p,roomId,roomName:"Synthetic courtyard accessible mixed dormitory",salesMode:"bedLevel",version:1,units:[{propertyId:p,roomId,inventoryUnitId:unit,bedId:unit,kind:"bed",label:"Lower bunk beside courtyard window",isSellable:true,isTopologyActive:true}]};
 const schedule=queryKey[0]==="reservations",quality=schedule?state.quality:"ready";
 const data=queryKey[0]==="reservation-operations"?snapshot:queryKey[0]==="inventory-rooms"?{rooms:[room]}:schedule?{propertyId:p,localDate:date,reservations:records,conflictingIds:[]}:queryKey[0]==="blocks"?{blocks:[]}:{propertyId:p,arrival:date,departure:"2026-09-20",units:[]};
 return {data:["missing","loading"].includes(quality)?undefined:data,error:["missing","stale"].includes(quality)?new Error("Synthetic source unavailable"):null,isLoading:quality==="loading",errorUpdatedAt:quality==="missing"?1:0,isFetching:quality==="refresh",isPaused:false,refetch:async()=>update({quality:"ready"})};
}`;
const previewModule = `
import React,{createContext,useContext,useState,useRef} from "react";
const Context=createContext(null);export const useOperationalPreview=()=>useContext(Context);
export function PreviewAdapter({children}){const [route,setRoute]=useState(null),trigger=useRef(null);
 const close=()=>{setRoute(null);trigger.current?.focus();};
 return <Context.Provider value={{activeRoute:route,openPreview:value=>{trigger.current=value.trigger;setRoute(value.route);window.lastPreview=value.route;}}}>{children}{route&&<aside role="dialog" aria-label="Synthetic preview" onKeyDown={e=>{if(e.key==="Escape")close();}}><button autoFocus onClick={close}>Close synthetic preview</button></aside>}</Context.Provider>;}
`;
const fixture = `
import React,{useState} from "react";import{createRoot}from"react-dom/client";import{BrowserRouter,useNavigate}from"react-router";
import{DashboardPage}from"/src/features/dashboard/DashboardPage.tsx";import{PreviewAdapter}from"/__today_tabs_preview.tsx";import{state,bind,property,other}from"/__today_tabs_state.tsx";import"/src/styles.css";
function Fixture(){const [,render]=useState(0),navigate=useNavigate();bind(patch=>{Object.assign(state,patch);render(n=>n+1);});window.todayHarness={update:patch=>{Object.assign(state,patch);render(n=>n+1);},navigate,property,other};return <PreviewAdapter><div data-fixture-shell className="min-h-screen overflow-x-hidden"><main style={{padding:16,paddingBottom:80}}><DashboardPage/></main><nav aria-label="Synthetic mobile navigation" className="fixed inset-x-0 bottom-0 z-20 h-16 bg-base-100 lg:hidden"/></div></PreviewAdapter>;}
createRoot(document.getElementById("root")).render(<BrowserRouter><Fixture/></BrowserRouter>);
`;
let server: ViteDevServer, browser: Browser, origin: string;
const errors: string[] = [];
beforeAll(async () => {
  const statePath = normalizePath(process.cwd() + "/__today_tabs_state.tsx"), previewPath = normalizePath(process.cwd() + "/__today_tabs_preview.tsx"), fixturePath = normalizePath(process.cwd() + "/__today_tabs_fixture.tsx");
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-today-tabs-vite-")), logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom/client", "react-router", "lucide-react"] },
    plugins: [react(), tailwindcss(), { name: "today-tabs-native-fixture", enforce: "pre",
      resolveId(id) {
        if (id === "/__today_tabs_state.tsx" || id === statePath || id === "@tanstack/react-query" || /(?:\/app\/(?:session|workspace|permissions|resourceFocus))(?:\.tsx?)?$/.test(id)) return statePath;
        if (id === "/__today_tabs_preview.tsx" || id === previewPath || /OperationalPreviewProvider(?:\.tsx)?$/.test(id)) return previewPath;
        if (id === "/__today_tabs_fixture.tsx" || id === fixturePath) return fixturePath;
      },
      load: id => id === statePath ? stateModule : id === previewPath ? previewModule : id === fixturePath ? fixture : undefined,
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__today-tabs")) return next();
        void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__today_tabs_fixture.tsx"></script></body></html>').then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
      }); },
    }], server: { host: "127.0.0.1", port: 0 } });
  await server.listen(); origin = server.resolvedUrls!.local[0]; browser = await launchNativeChromium();
}, 60000);
afterAll(async () => { await browser?.close(); await server?.close(); expect(errors).toEqual([]); });
const property = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
async function open(width = 320, query = "") {
  const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(20000);
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(origin + "__today-tabs?" + query); await page.getByRole("tablist", { name: "Shift queue" }).waitFor({ timeout: 20000 }); return page;
}
type Harness = { update(patch: Record<string, unknown>): void; navigate(href: string): void };
async function update(page: Page, patch: Record<string, unknown>) { await page.evaluate(patch => (window as unknown as { todayHarness: Harness }).todayHarness.update(patch), patch); }
const tabs = (page: Page) => page.getByRole("tablist", { name: "Shift queue" });
const panel = (page: Page) => page.locator("[data-today-queue]");

async function expectContained(page: Page) {
  const geometry = await page.getByRole("link", { name: "Calendar", exact: true }).evaluate(link => {
    const card = link.parentElement!.parentElement!, grid = card.parentElement!;
    const track = grid.getBoundingClientRect(), shell = document.querySelector<HTMLElement>("[data-fixture-shell]")!;
    const elements = [link, link.parentElement!, card, ...grid.children, ...grid.querySelectorAll('[role="tablist"], [role="tab"], [data-operational-preview-trigger]')];
    return {
      track: { left: track.left, right: track.right }, shellLeft: shell.scrollLeft,
      shellWidth: shell.scrollWidth, shellClientWidth: shell.clientWidth,
      bounds: elements.map(element => { const b = element.getBoundingClientRect(); return { label: element.textContent?.slice(0, 60), left: b.left, right: b.right }; }),
    };
  });
  expect(geometry.shellLeft).toBe(0);
  expect(geometry.shellWidth).toBeLessThanOrEqual(geometry.shellClientWidth);
  for (const box of geometry.bounds) {
    expect(box.left, box.label).toBeGreaterThanOrEqual(geometry.track.left - 1);
    expect(box.right, box.label).toBeLessThanOrEqual(geometry.track.right + 1);
  }
}

describe("Today shift queue ownership and mounted controls", () => {
  it("reveals keyboard queues and restored rows above fixed mobile navigation", async () => {
    const page = await open(320);
    const visibleFocus = async () => {
      const bounds = await page.evaluate(() => {
        const target = document.activeElement!, rect = target.getBoundingClientRect();
        const nav = document.querySelector('[aria-label="Synthetic mobile navigation"]')!.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, navTop: nav.top,
          painted: target.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) };
      });
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.navTop - 4);
      expect(bounds.painted).toBe(true);
      await expectContained(page);
    };
    try {
      // Reproduce the real shell edge: the tab is inside the geometric viewport
      // but would be behind the fixed navigation without focus-aware revealing.
      await tabs(page).getByRole("tab", { selected: true }).evaluate(e => {
        window.scrollTo(0, scrollY + e.getBoundingClientRect().top - (innerHeight - 52));
      });
      await tabs(page).getByRole("tab", { selected: true }).focus();
      await visibleFocus();
      for (const [key, queue] of [["ArrowRight", "arrivals"], ["End", "staying"], ["Home", "attention"], ["ArrowLeft", "staying"]] as const) {
        await page.keyboard.press(key); await page.locator(`[data-today-queue="${queue}"]`).waitFor();
        await visibleFocus();
      }
      const row = panel(page).getByRole("button").first();
      await row.focus(); await visibleFocus();
      await row.press("Enter"); await page.getByRole("dialog", { name: "Synthetic preview" }).waitFor();
      await page.keyboard.press("Escape"); expect(await row.evaluate(e => e === document.activeElement)).toBe(true);
      await visibleFocus();
    } finally { await page.close(); }
  }, 60000);
  it.each([320, 1024, 1440])("keeps all queues and complete Calendar link contained with native keyboard selection at %i", async width => {
    const page = await open(width);
    try {
      expect(await tabs(page).getByRole("tab").allTextContents()).toEqual(["Needs attention · 56", "Arrivals · 2", "Departures · 2", "Staying tonight · 1"]);
      await expectContained(page);
      const link = page.getByRole("link", { name: "Calendar", exact: true });
      const geometry = await link.evaluate(e => { const a=e.getBoundingClientRect(),b=e.parentElement!.parentElement!.getBoundingClientRect(); return { left:a.left,right:a.right,top:a.top,bottom:a.bottom,width:a.width,height:a.height,cardLeft:b.left,cardRight:b.right }; });
      expect(geometry.left).toBeGreaterThanOrEqual(geometry.cardLeft); expect(geometry.right).toBeLessThanOrEqual(geometry.cardRight); expect(geometry.width).toBeGreaterThanOrEqual(44); expect(geometry.height).toBeGreaterThanOrEqual(44);
      for (const tab of await tabs(page).getByRole("tab").all()) { const b=await tab.boundingBox(); expect(b!.height).toBeGreaterThanOrEqual(44); expect(b!.x).toBeGreaterThanOrEqual(0); expect(b!.x+b!.width).toBeLessThanOrEqual(width); }
      await tabs(page).getByRole("tab", { name: "Needs attention · 56", exact: true }).focus();
      for (const [key,count] of [["arrivals",2],["departures",2],["staying",1],["attention",56]] as const) {
        await page.keyboard.press("ArrowRight"); await page.locator(`[data-today-queue="${key}"]`).waitFor();
        expect(await panel(page).count()).toBe(1); expect(await panel(page).locator("[data-operational-preview-trigger]").count()).toBe(count);
        expect(new URL(page.url()).searchParams.get("todayQueue")).toBe(key === "attention" ? null : key);
        expect(await tabs(page).getByRole("tab", { selected:true }).evaluate(e=>e===document.activeElement)).toBe(true);
        await expectContained(page);
        const row = panel(page).getByRole("button").first();
        await row.focus(); await row.scrollIntoViewIfNeeded(); await expectContained(page);
        await row.press("Enter"); await page.getByRole("dialog", { name: "Synthetic preview" }).waitFor();
        await page.keyboard.press("Escape"); expect(await row.evaluate(e=>e===document.activeElement)).toBe(true);
        await expectContained(page);
        await tabs(page).getByRole("tab", { selected:true }).focus();
      }
      expect(await page.locator("body").evaluate(e=>e.scrollWidth<=innerWidth)).toBe(true);
    } finally { await page.close(); }
  }, 60000);
  it("preserves an authorized initial other-property queue, then resets on later property and actor changes", async () => {
    const page = await open(1024, `property=${other}&todayQueue=departures`);
    try {
      await page.locator('[data-today-queue="departures"]').waitFor(); expect(new URL(page.url()).searchParams.get("todayQueue")).toBe("departures");
      await page.evaluate(p=>{const h=(window as unknown as {todayHarness:Harness}).todayHarness;h.update({property:p});h.navigate(`?property=${p}&todayQueue=departures`);},property);
      await page.locator('[data-today-queue="attention"]').waitFor(); await expect.poll(() => new URL(page.url()).searchParams.has("todayQueue")).toBe(false);
      await tabs(page).getByRole("tab",{name:"Arrivals · 2",exact:true}).click();
      await page.locator('[data-today-queue="arrivals"]').waitFor();
      await update(page,{generation:2}); await page.locator('[data-today-queue="attention"]').waitFor();
      // Authority immediately gates the rendered queue; its effect canonicalizes
      // the URL in the following commit. Assert both, without racing that commit.
      await expect.poll(() => new URL(page.url()).searchParams.has("todayQueue")).toBe(false);
    } finally { await page.close(); }
  }, 60000);
  it.each(["todayQueue=", "todayQueue=ARRIVALS", "todayQueue=arrivals&todayQueue=departures", "todayQueue=unknown"])("normalizes malformed queue without leaving phantom selection: %s", async query => {
    const page = await open(320,query);
    try { expect(await panel(page).getAttribute("data-today-queue")).toBe("attention"); expect(new URL(page.url()).searchParams.has("todayQueue")).toBe(false); } finally { await page.close(); }
  }, 60000);
  it("resets Operations/Rooms switching, retains selected preview identity, and qualifies unavailable counts", async () => {
    const page = await open(320,`property=${property}&todayQueue=arrivals`);
    try {
      const row=panel(page).getByRole("button",{name:/Arrival one/}); await row.press("Enter");
      expect(await page.evaluate(()=>(window as unknown as {lastPreview:{origin:{queue:string}}}).lastPreview.origin.queue)).toBe("arrivals");
      await page.keyboard.press("Escape"); expect(await row.evaluate(e=>e===document.activeElement)).toBe(true); expect(await panel(page).getAttribute("data-today-queue")).toBe("arrivals");
      await update(page,{quality:"refresh"}); expect(await tabs(page).getByRole("tab",{name:"Arrivals · 2",exact:true}).isVisible()).toBe(true);
      await update(page,{quality:"stale"}); await tabs(page).getByRole("tab",{name:"Arrivals · —",exact:true}).waitFor(); expect(await panel(page).getByRole("button").count()).toBe(2);
      await update(page,{quality:"missing"}); await tabs(page).waitFor({state:"hidden"}); expect(await page.getByText("The detailed shift schedule is temporarily unavailable.",{exact:true}).isVisible()).toBe(true);
      await update(page,{quality:"ready"}); await tabs(page).waitFor();
      await page.getByRole("tablist",{name:"Today view"}).getByRole("tab",{name:"Rooms",exact:true}).click(); expect(new URL(page.url()).searchParams.has("todayQueue")).toBe(false);
      await page.getByRole("tablist",{name:"Today view"}).getByRole("tab",{name:"Operations",exact:true}).click(); await page.locator('[data-today-queue="attention"]').waitFor();
      await update(page,{canRead:false}); await page.getByText("Today access is not assigned",{exact:true}).waitFor(); expect(await panel(page).count()).toBe(0);
    } finally { await page.close(); }
  }, 60000);
});
