import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mounted real Today component, native controls, React/router and shipped CSS.
// Synthetic parent data and preview adapter are not real API/preview acceptance.
const provider = `
import React,{createContext,useContext,useState,useRef} from "react";
const Context=createContext(null);
export const useOperationalPreview=()=>useContext(Context);
export function TestPreviewProvider({children}) {
 const [activeRoute,setRoute]=useState(null),trigger=useRef(null);
 const openPreview=value=>{trigger.current=value.trigger;setRoute(value.route);window.lastPreview=value.route;};
 return <Context.Provider value={{activeRoute,openPreview}}>{children}{activeRoute&&<aside role="dialog" aria-label="Synthetic preview"><button autoFocus onClick={()=>{setRoute(null);trigger.current?.focus();}}>Close synthetic preview</button></aside>}</Context.Provider>;
}`;
const fixture = `
import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {BrowserRouter} from "react-router";
import {TodayVisualView} from "/src/features/dashboard/TodayVisualView.tsx";
import {TestPreviewProvider} from "/src/features/operational-preview/OperationalPreviewProvider.tsx";
import "/src/styles.css";
const propertyId="11111111-1111-4111-8111-111111111111",roomId="22222222-2222-4222-8222-222222222222",date="2026-09-13";
const units=Array.from({length:8},(_,i)=>({propertyId,roomId,inventoryUnitId:"33333333-3333-4333-8333-"+String(i+1).padStart(12,"0"),bedId:"bed"+i,kind:"bed",label:"Shift "+(i+1),isSellable:true,isTopologyActive:true}));
const room={propertyId,roomId,roomName:"Demo shift",buildingLabel:"Synthetic shift demo",floorLabel:"Demo floor",salesMode:"bedLevel",version:1,units};
const second={...room,roomId:"55555555-5555-4555-8555-555555555555",roomName:"Other room",units:[]};
const stay=(id,bed,name,arrival,departure,status="confirmed",holdsInventory=true)=>({propertyId,reservationId:"44444444-4444-4444-8444-"+String(id).padStart(12,"0"),arrival,departure,expectedArrivalTime:null,expectedDepartureTime:null,primaryGuestName:name,guestCount:1,inventoryUnitCount:1,inventoryUnitIds:[units[bed-1].inventoryUnitId],holdsInventory,sourceKind:"direct",status});
const reservations=[stay(1,2,"Synthetic arrival","2026-09-13","2026-09-15"),stay(2,3,"Synthetic in house","2026-09-13","2026-09-14","checkedIn"),stay(3,4,"Synthetic departure","2026-09-12","2026-09-13","checkedIn"),stay(4,5,"Synthetic overdue","2026-09-11","2026-09-12","checkedIn"),stay(5,7,"Synthetic future","2026-09-14","2026-09-16"),stay(6,8,"Turnover departure","2026-09-12","2026-09-13","checkedIn"),stay(7,8,"Turnover arrival","2026-09-13","2026-09-15"),stay(8,6,"Requested blocked bed","2026-09-13","2026-09-14","allocationRejected",false)];
const blocks=[{propertyId,blockId:"66666666-6666-4666-8666-666666666666",blockGroupId:"77777777-7777-4777-8777-777777777777",inventoryUnitId:units[5].inventoryUnitId,arrival:date,departure:"2026-09-14",status:"active",reason:"Maintenance hold",version:1}];
const availability={propertyId,arrival:date,departure:"2026-09-14",units:units.map((unit,i)=>({unit,isAvailable:![1,2,5,7].includes(i),activeAllocationIds:[1,2,7].includes(i)?["allocation"+i]:[],activeBlockIds:i===5?[blocks[0].blockId]:[]}))};
function Fixture(){const [quality,setQuality]=useState("ready"),[owner,setOwner]=useState(0),[records,setRecords]=useState(reservations);window.todayHarness={setQuality,setOwner,setRecords,records};
 return <BrowserRouter><TestPreviewProvider><main style={{padding:16}}><TodayVisualView key={owner} propertyId={propertyId} propertyName="Synthetic QA" rooms={[room,second]} roomState="ready" availability={quality==="missing"?undefined:availability} availabilityState={quality==="missing"?"unavailable":quality==="stale"?"stale":"ready"} reservations={records} reservationState="ready" blocks={blocks} blockState="ready" localDate={quality==="no-date"?undefined:date} current={quality==="ready"} reservationCurrent={quality==="ready"} routineRefresh={quality==="refresh"} sourceStatus={quality==="refresh"?"Reservations: updating":null} canOpenSpaces={!location.search.includes("viewer")}/></main></TestPreviewProvider></BrowserRouter>;
}createRoot(document.getElementById("root")).render(<Fixture/>);
`;
let server: ViteDevServer, browser: Browser, origin: string;
const errors: string[] = [];
beforeAll(async () => {
  const fixturePath = normalizePath(process.cwd() + "/__today_rooms_fixture.tsx"), providerPath = normalizePath(process.cwd() + "/__today_rooms_provider.tsx");
  // Other mounted suites have different virtual entries. Their optimizer must
  // not replace this server's cached dependency generation during a page load.
  const cacheDir = mkdtempSync(join(tmpdir(), "bunkfy-today-rooms-vite-"));
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir, logLevel: "error",
    // This virtual fixture does not use index.html or App.tsx. Optimize its
    // runtime imports explicitly instead of scanning the unrelated app entry.
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom/client", "react-router", "lucide-react"] },
    plugins: [react(), tailwindcss(), {
    name: "today-rooms-native-fixture", enforce: "pre",
    resolveId: id => id === providerPath || id === "/__today_rooms_provider.tsx" || id.endsWith("OperationalPreviewProvider") || id.endsWith("OperationalPreviewProvider.tsx") ? providerPath : id === "/__today_rooms_fixture.tsx" || id === fixturePath ? fixturePath : undefined,
    load: id => id === fixturePath ? fixture : id === providerPath || id.endsWith("/OperationalPreviewProvider.tsx") ? provider : undefined,
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/__today-rooms")) return next();
      void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__today_rooms_fixture.tsx"></script></body></html>')
        .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
    }); },
  }], server: { host: "127.0.0.1", port: 0 } });
  await server.listen(); origin = server.resolvedUrls!.local[0]; browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); await server?.close(); expect(errors).toEqual([]); });
async function open(width = 320, suffix = "", touch = false) {
  const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: touch }); page.setDefaultTimeout(3000);
  // Cold isolated dependency/CSS compilation is startup, not interaction time.
  page.setDefaultNavigationTimeout(15000);
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const navigationStarted = performance.now();
  await page.goto(origin + "__today-rooms?property=11111111-1111-4111-8111-111111111111&view=visual" + suffix);
  console.info("Today fixture navigation ms:", Math.round(performance.now() - navigationStarted));
  await page.getByRole("tabpanel", { name: "Today Rooms" }).waitFor(); return page;
}
const toggle = (page: Page) => page.getByRole("button", { name: "Filters", exact: true });
const search = (page: Page) => page.getByRole("searchbox", { name: "Find room, bed or guest" });
const room = (page: Page) => page.getByRole("combobox", { name: "Room", exact: true });
const show = (page: Page) => page.getByRole("combobox", { name: "Show", exact: true });
const row = (page: Page, bed: number) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Shift " + bed, exact: true }) });
async function resize(page: Page, width: number) { await page.setViewportSize({ width, height: 800 }); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function quality(page: Page, value: string) { await page.evaluate(value => (window as unknown as { todayHarness: { setQuality(value: string): void } }).todayHarness.setQuality(value), value); }

describe("Today Rooms mounted responsive controls and row continuity", () => {
  it("keeps one control set, active summary, source reserve and Clear outside narrow secondary filters", async () => {
    const page = await open(320, "&todayRoom=22222222-2222-4222-8222-222222222222");
    try {
      expect(await toggle(page).getAttribute("aria-expanded")).toBe("false"); expect(await search(page).isVisible()).toBe(true);
      expect(await page.locator("select").count()).toBe(2); expect(await room(page).isVisible()).toBe(false);
      const controls = await toggle(page).getAttribute("aria-controls"); expect(controls).toBeTruthy(); expect(await page.locator("#" + controls).count()).toBe(1);
      expect(await page.locator("[data-today-active-filters]").textContent()).toContain("Demo shift");
      expect(await page.getByRole("button", { name: "Clear", exact: true }).isVisible()).toBe(true); expect(await page.getByRole("link", { name: "Manage rooms" }).isVisible()).toBe(true);
      expect(await page.locator("#today-source-status").evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(40);
      await toggle(page).click(); expect(await room(page).isVisible()).toBe(true); expect(await show(page).isVisible()).toBe(true);
      await show(page).selectOption("blocked"); await toggle(page).click();
      expect(await page.locator("[data-today-active-filters]").textContent()).toContain("Blocked tonight"); expect(await row(page, 6).isVisible()).toBe(true);
      await page.getByRole("button", { name: "Clear", exact: true }).click(); expect(new URL(page.url()).searchParams.has("todayRoom")).toBe(false); expect(new URL(page.url()).searchParams.has("todayFilter")).toBe(false);
      expect(await page.locator("body").evaluate(el => el.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); }
  }, 30000);

  it.each(["Room", "Show"])("retains exact focused %s node and value on wide-to-narrow resize, then closes with one click", async name => {
    const page = await open(1024);
    try {
      const control = name === "Room" ? room(page) : show(page);
      await control.focus(); await control.evaluate(el => { (window as unknown as { savedControl: Element }).savedControl = el; });
      const value = await control.inputValue(); await resize(page, 320);
      expect(await control.isVisible()).toBe(true); expect(await control.inputValue()).toBe(value); expect(await control.evaluate(el => el === document.activeElement && el === (window as unknown as { savedControl: Element }).savedControl)).toBe(true);
      expect(await toggle(page).getAttribute("aria-expanded")).toBe("true"); await toggle(page).click(); expect(await toggle(page).getAttribute("aria-expanded")).toBe("false"); expect(await toggle(page).evaluate(el => el === document.activeElement)).toBe(true);
      await toggle(page).click(); await resize(page, 1440); await resize(page, 320);
      expect(await control.evaluate(el => el === (window as unknown as { savedControl: Element }).savedControl)).toBe(true); expect(await page.locator("select").count()).toBe(2);
    } finally { await page.close(); }
  }, 30000);

  it.each(["Enter", "Space", "touch"])("toggles secondary filters once with native %s and returns focus before hiding", async input => {
    const page = await open(320, "", input === "touch");
    try {
      for (const expanded of ["true", "false", "true"]) { if (input === "touch") await toggle(page).tap(); else await toggle(page).press(input); expect(await toggle(page).getAttribute("aria-expanded")).toBe(expanded); }
      await room(page).focus(); await toggle(page).click(); expect(await toggle(page).evaluate(el => el === document.activeElement)).toBe(true); expect(await room(page).isVisible()).toBe(false);
    } finally { await page.close(); }
  }, 30000);

  it("retains ephemeral search and preview trigger across resize, while search focus does not open secondary controls", async () => {
    const page = await open(1024);
    try {
      await search(page).fill("Synthetic arrival"); await search(page).evaluate(el => { (window as unknown as { savedSearch: Element }).savedSearch = el; }); await resize(page, 320);
      expect(await toggle(page).getAttribute("aria-expanded")).toBe("false"); expect(await search(page).evaluate(el => el === document.activeElement && el === (window as unknown as { savedSearch: Element }).savedSearch)).toBe(true);
      const trigger = row(page, 2).getByRole("button", { name: /Synthetic arrival/ }); await trigger.evaluate(el => { (window as unknown as { savedTrigger: Element }).savedTrigger = el; }); await trigger.click();
      expect(await page.evaluate(() => JSON.stringify((window as unknown as { lastPreview: unknown }).lastPreview))).not.toContain("Synthetic arrival"); expect(page.url()).not.toContain("Synthetic");
      await page.getByRole("button", { name: "Close synthetic preview" }).click(); expect(await search(page).inputValue()).toBe("Synthetic arrival"); expect(await trigger.evaluate(el => el === document.activeElement && el === (window as unknown as { savedTrigger: Element }).savedTrigger)).toBe(true);
      await page.evaluate(() => (window as unknown as { todayHarness: { setOwner(value: number): void } }).todayHarness.setOwner(1));
      // The synthetic owner change schedules a React remount; observe its commit.
      await expect.poll(() => search(page).inputValue()).toBe("");
    } finally { await page.close(); }
  }, 30000);

  it.each([320, 1024, 1440])("keeps Space→Tonight→movements DOM and native Tab order aligned at %i", async width => {
    const page = await open(width);
    try {
      const target = row(page, 2), tonight = target.getByRole("button", { name: "Reserved tonight", exact: true }), guest = target.getByRole("button", { name: /Synthetic arrival/ });
      const identityBox = await target.getByRole("heading").boundingBox(), tonightBox = await tonight.boundingBox(), guestBox = await guest.boundingBox(); expect(identityBox && tonightBox && guestBox).toBeTruthy();
      expect(Math.abs(identityBox!.y - tonightBox!.y)).toBeLessThan(25);
      if (width < 768) expect(guestBox!.y).toBeGreaterThanOrEqual(tonightBox!.y + tonightBox!.height); else expect(guestBox!.x).toBeGreaterThan(tonightBox!.x);
      await tonight.focus(); await page.keyboard.press("Tab"); expect(await guest.evaluate(el => el === document.activeElement)).toBe(true); await page.keyboard.press("Shift+Tab"); expect(await tonight.evaluate(el => el === document.activeElement)).toBe(true);
      expect(await tonight.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44); expect(await guest.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      expect(await page.locator('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])').count()).toBe(0); expect(await page.locator("body").evaluate(el => el.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); }
  }, 30000);

  it("preserves turnover, blocked, rejected and overdue meanings plus exact trigger identity through refresh", async () => {
    const page = await open();
    try {
      expect(await row(page, 4).textContent()).toContain("Departure today"); expect(await row(page, 4).textContent()).toContain("Available tonight"); expect(await row(page, 5).textContent()).toContain("Checkout overdue");
      expect(await row(page, 6).textContent()).toContain("Maintenance hold"); expect(await row(page, 6).textContent()).not.toContain("Requested blocked bed"); expect(await page.getByRole("region", { name: "Reservations needing space review" }).textContent()).toContain("Requested, not held");
      expect(await row(page, 8).getByRole("button").allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("Turnover departure"), expect.stringContaining("Turnover arrival")]));
      const before = await row(page, 2).innerHTML(), box = await row(page, 2).boundingBox(); await row(page, 2).getByRole("button").first().evaluate(el => { (window as unknown as { savedTrigger: Element }).savedTrigger = el; });
      await quality(page, "refresh"); await page.getByText("Reservations: updating", { exact: true }).waitFor(); expect(await row(page, 2).innerHTML()).toBe(before); expect(await row(page, 2).boundingBox()).toEqual(box);
      expect(await row(page, 2).getByRole("button").first().evaluate(el => el === (window as unknown as { savedTrigger: Element }).savedTrigger)).toBe(true);
      await quality(page, "stale"); await page.getByText(/Last known availability and guest records/).waitFor(); expect(await row(page, 2).textContent()).toContain("Last known");
      await quality(page, "missing"); expect(await row(page, 2).textContent()).toContain("Tonight unconfirmed");
      await quality(page, "no-date"); expect(await row(page, 1).getByRole("button").first().isDisabled()).toBe(true);
    } finally { await page.close(); }
  }, 30000);

  it("retains Viewer restrictions, explicit invalid context and wrapping long guest text", async () => {
    const page = await open(320, "&viewer=1");
    try {
      expect(await page.getByRole("link", { name: "Manage rooms" }).count()).toBe(0); expect(await page.getByRole("button", { name: "Clear", exact: true }).isVisible()).toBe(true);
      await page.evaluate(() => { const h = (window as unknown as { todayHarness: { records: Record<string, unknown>[]; setRecords(value: unknown): void } }).todayHarness; h.setRecords(h.records.map(r => ({ ...r, primaryGuestName: "Synthetic exceptionally long guest name with accented Élodie and multiple words" }))); });
      expect(await page.locator("body").evaluate(el => el.scrollWidth <= innerWidth)).toBe(true);
      await page.goto(origin + "__today-rooms?todayRoom=11111111-1111-4111-8111-111111111111"); await page.getByText("This room or filter is not available for the current property. Use Clear to show this property’s rooms.").waitFor(); expect(await page.getByRole("listitem").count()).toBe(0);
    } finally { await page.close(); }
  }, 30000);
});
