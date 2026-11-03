import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real Calendar/table/grid/CSS and native scrolling. Synthetic source records
// and preview adapter do not replace the real API and operational-preview gate.
const provider = `
import React,{createContext,useContext,useState,useRef} from "react";
const Context=createContext(null);
export const useOperationalPreview=()=>useContext(Context);
export function TestPreviewProvider({children}) {
 const [activeRoute,setRoute]=useState(null),trigger=useRef(null);
 const close=()=>{setRoute(null);trigger.current?.focus({preventScroll:true});};
 const openPreview=value=>{trigger.current=value.trigger;setRoute(value.route);window.lastPreview=value.route;};
 return <Context.Provider value={{activeRoute,openPreview}}>{children}{activeRoute&&<aside role="dialog" aria-label="Synthetic preview" onKeyDown={event=>{if(event.key==="Escape")close();}}><button autoFocus onClick={close}>Close synthetic preview</button></aside>}</Context.Provider>;
}`;
const fixture = `
import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {BrowserRouter} from "react-router";
import {CalendarWeekView} from "/src/features/calendar/CalendarWeekView.tsx";
import {calendarSegmentFor,calendarWindowDays} from "/src/features/calendar/calendarWindow.ts";
import {TestPreviewProvider} from "/src/features/operational-preview/OperationalPreviewProvider.tsx";
import "/src/styles.css";
const propertyId="11111111-1111-4111-8111-111111111111",roomId="22222222-2222-4222-8222-222222222222";
const units=Array.from({length:5},(_,i)=>({propertyId,roomId,bedId:"bed"+i,inventoryUnitId:"33333333-3333-4333-8333-"+String(i+1).padStart(12,"0"),label:"Bed "+(i+1),kind:"bed",isSellable:true,isTopologyActive:true}));
const room={propertyId,roomId,roomName:"Synthetic dorm",salesMode:"bedLevel",units};
const stay=(id,bed,name,status="confirmed",arrival="2026-09-08",departure="2026-09-20")=>({propertyId,reservationId:"44444444-4444-4444-8444-"+String(id).padStart(12,"0"),primaryGuestName:name,guestCount:1,inventoryUnitCount:1,inventoryUnitIds:[units[bed-1].inventoryUnitId],arrival,departure,holdsInventory:status!=="checkedOut"&&status!=="requested",status,sourceKind:"direct"});
const reservations=[stay(1,1,"Active Élodie"),stay(2,2,"Completed Søren long-stay guest","checkedOut"),stay(3,3,"Short guest","confirmed","2026-09-15","2026-09-16"),stay(4,4,"Attention guest","checkedIn"),stay(5,5,"Requested guest","requested")];
const blocks=[{propertyId,blockId:"55555555-5555-4555-8555-555555555555",blockGroupId:"66666666-6666-4666-8666-666666666666",inventoryUnitId:units[4].inventoryUnitId,arrival:"2026-09-08",departure:"2026-09-20",reason:"Maintenance block",status:"active",version:1}];
const first=calendarSegmentFor("2026-09-08"),second=calendarSegmentFor(first.to),days=calendarWindowDays([first,second]);
function Fixture(){const [viewport,setViewport]=useState({date:first.from,offset:0}),[stale,setStale]=useState(false),[longNames,setLongNames]=useState(false);window.calendarHarness={setStale,setLongNames};
 const records=longNames?reservations.map(item=>({...item,primaryGuestName:item.primaryGuestName+" with an exceptionally long international family name requiring more than 384 pixels"})):reservations;
 return <BrowserRouter><TestPreviewProvider><main style={{padding:16}}><CalendarWeekView propertyId={propertyId} dateKey={first.from} selectedDay={first.from} todayKey={first.from} from={first.from} to={second.to} days={days} viewport={viewport} onViewport={setViewport} onSelectDay={()=>{}} rooms={[room]} roomState="ready" reservations={records} blocks={blocks} availabilityCurrent={!stale} coverage={[first,second].map(segment=>({...segment,current:!stale,reservationsCurrent:!stale,blocksCurrent:true,conflict:false,label:"Schedule unavailable",retry:()=>{}}))} canOpenSpaces={false} attentionOperatingDate="2026-09-22" attentionReservationIds={new Set([reservations[3].reservationId])}/></main></TestPreviewProvider></BrowserRouter>;
}createRoot(document.getElementById("root")).render(<Fixture/>);
`;
let server: ViteDevServer, browser: Browser, origin: string;
const errors: string[] = [];
beforeAll(async () => {
  const fixturePath = normalizePath(process.cwd() + "/__calendar_label_fixture.tsx"), providerPath = normalizePath(process.cwd() + "/__calendar_label_provider.tsx");
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-calendar-label-vite-")), logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom/client", "react-router", "lucide-react"] },
    plugins: [react(), tailwindcss(), {
      name: "calendar-label-native-fixture", enforce: "pre",
      resolveId: id => id === providerPath || id.endsWith("OperationalPreviewProvider") || id.endsWith("OperationalPreviewProvider.tsx") ? providerPath : id === "/__calendar_label_fixture.tsx" || id === fixturePath ? fixturePath : undefined,
      load: id => id === fixturePath ? fixture : id === providerPath ? provider : undefined,
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__calendar-label")) return next();
        void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__calendar_label_fixture.tsx"></script></body></html>')
          .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
      }); },
    }], server: { host: "127.0.0.1", port: 0 } });
  await server.listen(); origin = server.resolvedUrls!.local[0]; browser = await launchNativeChromium();
}, 60000);
afterAll(async () => { await browser?.close(); await server?.close(); expect(errors).toEqual([]); });
async function open(width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } }); page.setDefaultTimeout(3000); page.setDefaultNavigationTimeout(15000);
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(origin + "__calendar-label"); await page.locator(".calendar-timeline").waitFor();
  await page.locator(".calendar-timeline").evaluate(el => document.fonts.ready.then(() => el.scrollLeft)); return page;
}
const names = { active: "Active Élodie", completed: "Completed Søren long-stay guest", attention: "Attention guest" };
const target = (page: Page, kind: keyof typeof names) => page.locator(".calendar-timeline").getByRole("button", { name: new RegExp("^" + names[kind]) });
async function pan(page: Page, left: number) {
  await page.locator(".calendar-timeline").evaluate((el, value) => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); el.scrollLeft = value; el.dispatchEvent(new Event("scroll")); }, left);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function geometry(page: Page, kind: keyof typeof names) {
  return target(page, kind).evaluate((button, name) => {
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT); let text: Node | null = null;
    while (walker.nextNode()) if (walker.currentNode.textContent?.startsWith(name)) { text = walker.currentNode; break; }
    if (!text) throw Error("Guest text not mounted");
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, Math.min(12, name.length));
    const glyph = range.getBoundingClientRect(), bar = button.getBoundingClientRect();
    const heading = document.querySelector("#calendar-resource-heading")!.getBoundingClientRect();
    let paintLeft = Math.max(glyph.left, bar.left, heading.right), paintRight = Math.min(glyph.right, bar.right);
    for (let node = text.parentElement; node && node !== button; node = node.parentElement) {
      if (getComputedStyle(node).overflowX !== "visible") { const box = node.getBoundingClientRect(); paintLeft = Math.max(paintLeft, box.left); paintRight = Math.min(paintRight, box.right); }
    }
    return { glyph: { left: glyph.left, right: glyph.right, top: glyph.top, bottom: glyph.bottom }, paintLeft, paintRight, bar: { left: bar.left, right: bar.right }, pane: heading.right,
      hit: document.elementFromPoint(Math.max(glyph.left, heading.right) + 3, glyph.top + glyph.height / 2)?.closest("button") === button,
      overflow: [...function* () { let node: Element | null = text.parentElement; while (node && node !== button) { yield getComputedStyle(node).overflowX; node = node.parentElement; } }()] };
  }, names[kind]);
}
async function capture(page: Page, label: string, measurements?: unknown) {
  const dir = process.env.BUNKFY_CALENDAR_EVIDENCE_DIR;
  if (dir) { mkdirSync(dir, { recursive: true }); await page.screenshot({ path: join(dir, label + ".png"), fullPage: true }); if (measurements) writeFileSync(join(dir, label + ".json"), JSON.stringify(measurements, null, 2)); }
}

describe("native reservation label containment during Calendar panning", () => {
  for (const width of [1440, 1024]) for (const kind of ["active", "completed"] as const) {
    it(`keeps the beginning of ${kind} guest text in the visible date pane at ${width}`, async () => {
      const page = await open(width);
      try {
        await pan(page, 25 * 112); const g = await geometry(page, kind); await capture(page, `${kind}-${width}-mid`, g);
        console.info("Calendar label geometry", { kind, width, ...g });
        expect(g.bar.left).toBeLessThan(g.pane); expect(g.bar.right).toBeGreaterThan(g.pane + 220);
        expect(g.glyph.left).toBeGreaterThanOrEqual(g.pane + 2); expect(g.glyph.left).toBeLessThanOrEqual(g.pane + 16);
        expect(g.glyph.right).toBeLessThanOrEqual(g.bar.right); expect(g.hit).toBe(true);
      } finally { await page.close(); }
    }, 30000);
  }

  it.each(["active", "completed"] as const)("releases %s text inside its trailing edge and preserves one parent action", async kind => {
    const page = await open();
    try {
      const button = target(page, kind), identity = await button.getAttribute("data-operational-preview-trigger"), name = await button.getAttribute("aria-label");
      await button.evaluate(el => { (window as unknown as { savedBar: Element }).savedBar = el; });
      await pan(page, 25 * 112); const middle = await geometry(page, kind);
      // Leave a small real label slot after the fixed trailing controls. The
      // following 27-day pan covers the zero-room release boundary separately.
      await pan(page, 25.75 * 112); const end = await geometry(page, kind); await capture(page, `${kind}-trailing`, end);
      expect(end.bar.right).toBeGreaterThan(end.pane + 50); expect(end.bar.right).toBeLessThan(end.pane + 210);
      expect(Math.abs(end.glyph.left - middle.glyph.left)).toBeLessThan(1); expect(end.paintRight).toBeLessThanOrEqual(end.bar.right);
      expect(end.paintRight - end.paintLeft).toBeGreaterThan(2);
      await pan(page, 27 * 112); const gone = await geometry(page, kind);
      expect(gone.glyph.left).toBeLessThan(middle.glyph.left); expect(gone.hit).toBe(false);
      expect(await button.evaluate(el => el === (window as unknown as { savedBar: Element }).savedBar)).toBe(true);
      expect(await button.getAttribute("data-operational-preview-trigger")).toBe(identity); expect(await button.getAttribute("aria-label")).toBe(name);
      expect(await button.locator("button,a,[tabindex]").count()).toBe(0);
      await pan(page, 25 * 112);
      for (const input of ["click", "Enter", "Space"]) {
        if (input === "click") { const g = await geometry(page, kind); await page.mouse.click(g.glyph.left + 8, (g.glyph.top + g.glyph.bottom) / 2); }
        else await button.press(input);
        await page.getByRole("dialog", { name: "Synthetic preview" }).waitFor();
        expect(await button.getAttribute("aria-expanded")).toBe("true");
        await page.keyboard.press("Escape"); expect(await button.evaluate(el => el === document.activeElement)).toBe(true);
        expect(await button.getAttribute("data-operational-preview-trigger")).toBe(identity);
      }
    } finally { await page.close(); }
  }, 30000);

  it.each(([1440, 1024] as const).flatMap(width => (["active", "completed", "attention"] as const).map(kind => ({ width, kind }))))("keeps the prefix of a >384px $kind name at $width and clips only at its reserved edge", async ({ width, kind }) => {
    const page = await open(width);
    try {
      await page.evaluate(() => (window as unknown as { calendarHarness: { setLongNames(value: boolean): void } }).calendarHarness.setLongNames(true));
      const button = target(page, kind);
      await button.getByText(/exceptionally long international/).waitFor();
      const siblings = () => button.locator("[data-calendar-endpoint], [data-reservation-attention]").evaluateAll(nodes => nodes.map(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })));
      // Leave a real prefix slot even with the wider Linux fallback font and
      // both attention markers. The separate trailing-edge test covers the
      // point where the remaining interval has no readable label room.
      await pan(page, 23.5 * 112); const initial = await siblings();
      await pan(page, 24.5 * 112); const g = await geometry(page, kind), after = await siblings();
      await capture(page, `long-${kind}-${width}-near-end`, g);
      expect(g.glyph.left).toBeGreaterThanOrEqual(g.pane + 2); expect(g.glyph.left).toBeLessThanOrEqual(g.pane + 16);
      expect(g.paintRight - g.paintLeft).toBeGreaterThan(20); expect(g.hit).toBe(true);
      after.forEach((box, index) => expect(Math.abs(box.left - initial[index].left + 112)).toBeLessThan(1));
      const visibleAfter = after.filter(box => box.left > g.pane);
      if (visibleAfter.length) expect(g.paintRight).toBeLessThanOrEqual(Math.min(...visibleAfter.map(box => box.left)));
      await page.mouse.click(g.glyph.left + 4, (g.glyph.top + g.glyph.bottom) / 2); await page.getByRole("dialog", { name: "Synthetic preview" }).waitFor();
      await page.keyboard.press("Escape"); expect(await button.evaluate(el => el === document.activeElement)).toBe(true);
    } finally { await page.close(); }
  }, 30000);

  it("retains endpoints, attention, short-bar bounds and cached-source identity without changing blocks", async () => {
    const page = await open();
    try {
      const timeline = page.locator(".calendar-timeline"), active = target(page, "active");
      const endpoints = () => active.locator("[data-calendar-endpoint]").evaluateAll(nodes => nodes.map(node => ({ kind: node.getAttribute("data-calendar-endpoint"), left: node.getBoundingClientRect().left })));
      const initial = await endpoints(); await pan(page, 25 * 112); const moved = await endpoints();
      expect(moved.map(node => node.kind)).toEqual(initial.map(node => node.kind)); moved.forEach((node, index) => expect(Math.abs(node.left - initial[index].left + 25 * 112)).toBeLessThan(1));
      expect(await timeline.locator("[data-reservation-attention]").count()).toBeGreaterThan(0);
      const block = timeline.getByRole("button", { name: /^Maintenance block,/ }); expect(await block.locator("[data-calendar-endpoint]").count()).toBe(2);
      expect(await block.locator("[data-calendar-visible-label]").count()).toBe(0);
      const short = timeline.getByRole("button", { name: /^Short guest,/ });
      expect(await short.locator("[data-calendar-endpoint]").count()).toBe(2); expect(await short.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await active.evaluate(el => { (window as unknown as { savedBar: Element }).savedBar = el; });
      await page.evaluate(() => (window as unknown as { calendarHarness: { setStale(value: boolean): void } }).calendarHarness.setStale(true));
      await page.getByText("Dates unconfirmed", { exact: true }).waitFor();
      expect(await active.evaluate(el => el === (window as unknown as { savedBar: Element }).savedBar)).toBe(true);
      const g = await geometry(page, "active"); expect(g.glyph.left).toBeGreaterThanOrEqual(g.pane + 2); expect(g.hit).toBe(true);
      await page.setViewportSize({ width: 320, height: 800 }); expect(await timeline.isVisible()).toBe(false);
      expect(await page.locator("body").evaluate(el => el.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); }
  }, 30000);
});
