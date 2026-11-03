import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real components, React, modal footer, styles and browser focus. Only session/API
// data and the direct picker/editor parent are synthetic. Not live-API UX acceptance.
const fixture = `
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {ApiError} from "/src/api/client.ts";
import {MemoryRouter} from "react-router";
import {CreateReservationModal} from "/src/features/reservations/CreateReservationModal.tsx";
import {GuestDetailsForm, ReservationDetail} from "/src/features/reservations/ReservationDetail.tsx";
import {ReservationInventoryPicker} from "/src/features/reservations/ReservationInventoryPicker.tsx";
import {Modal, ModalActions} from "/src/components/ui/primitives.tsx";
import "/src/styles.css";
const params=new URLSearchParams(location.search);
const rooms=Array.from({length:17},(_,r)=>({propertyId:"property",roomId:"room"+r,roomName:"Dorm "+String(r+1).padStart(2,"0")+" · Riverside house, quiet courtyard wing", units:Array.from({length:r<7?4:3},(_,u)=>({propertyId:"property",roomId:"room"+r,inventoryUnitId:"unit"+r+"-"+u,bedId:"bed"+r+"-"+u,kind:"bed",label:"Bed "+(u+1)+" · Lower bunk near the accessible courtyard entrance",isSellable:true,isTopologyActive:true}))}));
const availability=rooms.flatMap(room=>room.units.map(unit=>({unit,isAvailable:true,activeAllocationIds:[],activeBlockIds:[]})));
const groups=rooms.map(room=>({...room,availableCount:room.units.length,totalCount:room.units.length,units:availability.filter(item=>item.unit.roomId===room.roomId)}));
const reservation={propertyId:"property",reservationId:"reservation",primaryGuestName:"Alexandra María Nguyễn — returning guest",guestCount:2,email:params.has("missing")?null:"long.reservation.contact@example.invalid",phone:null,notes:"First line of staff instructions.\\n"+"Courtyard entrance and late arrival details. ".repeat(4),arrival:"2026-09-18",departure:"2026-09-23",expectedArrivalTime:"14:30:00",expectedDepartureTime:"10:00:00",detailsRevision:3,version:7,status:params.get("status")||"checkedIn",holdsInventory:params.get("status")!=="checkedOut",inventoryUnitIds:["unit0-0"],guests:[],sourceKind:"external",sourceSystem:"Partner booking system",sourceReference:"SOURCE-REFERENCE-"+"1234567890".repeat(6),createdAtUtc:"2026-09-07T00:00:00Z",updatedAtUtc:null,allocationRequestId:"allocation-request",allocationId:"allocation",allocationVersion:1,allocationRejection:0,pendingAllocationAmendmentId:null,lastAllocationAmendmentRejection:0,lastDetailsChangeOrigin:1,pendingStayBusinessDate:null,pendingStayActorId:null,checkedInBusinessDate:"2026-09-18",checkedInAtUtc:"2026-09-18T14:30:00Z",checkedInBy:"staff",noShowBusinessDate:null,noShowAtUtc:null,noShowBy:null,checkedOutBusinessDate:params.get("status")==="checkedOut"?"2026-09-23":null,checkedOutAtUtc:null,checkedOutBy:null};
if(reservation.status==="confirmed") {reservation.checkedInBusinessDate=null;reservation.checkedInAtUtc=null;reservation.checkedInBy=null;}
window.reservationFixtureRequests=[];
window.reservationRead={status:Number(params.get("read-status")||200),pending:params.has("read-pending")};
window.reservationHistoryStatus=200;
window.permissionRetries=0;
window.reservationFixtureRequest=async(path,options)=>{
 window.reservationFixtureRequests.push({path,method:options?.method||"GET"});
 if(params.has("uncertain-save") && path.endsWith("/guest-details") && options?.method==="PUT") throw new ApiError("Request failed with HTTP 503",503);
 if(options?.method && options.method!=="GET") throw Error("No fixture writes permitted");
 if(path.includes("/details-history?") && window.reservationHistoryStatus!==200) throw new ApiError("Request failed with HTTP "+window.reservationHistoryStatus,window.reservationHistoryStatus);
 if(path.includes("/details-history?")) return {items:[{changeId:"change",fromRevision:2,toRevision:3,changedFields:["notes","email"],before:{...reservation,notes:"Earlier instructions",email:null},after:reservation,origin:1,occurredAtUtc:"2026-09-19T14:30:00Z",actorId:"staff"}],hasMore:false,page:1,pageSize:20};
 if(path==="/api/reservations/properties/property/reservation"){
  const {status,pending}=window.reservationRead;
  if(pending)await new Promise(resolve=>{window.releaseReservationRead=resolve;});
  if(status!==200)throw new ApiError("Request failed with HTTP "+status,status,undefined,Number(params.get("retry-after"))||undefined);
  return reservation;
 }
 if(path.includes("/availability?")){const url=new URL(path,location.origin);return {propertyId:"property",arrival:url.searchParams.get("arrival"),departure:url.searchParams.get("departure"),units:availability};}
 if(path.includes("/rooms?"))return {rooms,hasMore:false,page:1,pageSize:100};
 if(path.includes("/guests/"))return {guests:[],hasMore:false,page:1,pageSize:8};
 throw Error("Unexpected fixture request: "+path);
};
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
function Fixture(){
 const [open,setOpen]=useState(true);
 const [identity,setIdentity]=useState("fixture:property:reservation"),[nested,setNested]=useState(false);
 const [selected,setSelected]=useState(params.has("preselected")?["unit0-0"]:[]);
 const [current,setCurrent]=useState(true),[visible,setVisible]=useState(true),[version,setVersion]=useState(0),[missing,setMissing]=useState(false),[unavailable,setUnavailable]=useState(false);
 const [permissionState,setPermissionState]=useState("ready");
 const [name,setName]=useState("");
 const [draft,setDraft]=useState({primaryGuestName:"Initial guest",guestCount:"2",email:"guest@example.invalid",phone:"+44123456789",expectedArrivalTime:"16:45",expectedDepartureTime:"10:00",notes:"Existing notes"});
 const source={label:"Permissions",state:permissionState,isFetching:false,refetch:async()=>{window.permissionRetries++;setPermissionState("ready");}};
 window.reservationHarness={setCurrent,setVisible,setSelected,setMissing,setUnavailable,setOpen,setIdentity,setNested,setPermissionState,reset:()=>{setSelected([]);setVersion(n=>n+1);},rerender:()=>setVersion(n=>n),refetch:()=>client.invalidateQueries({queryKey:["availability"]}),refetchRead:()=>client.invalidateQueries({queryKey:["reservation","property","reservation"],exact:true}),resetRead:()=>client.resetQueries({queryKey:["reservation","property","reservation"],exact:true})};
 const modifiedGroups=groups.map(group=>{const units=group.units.filter(item=>!missing||!selected.includes(item.unit.inventoryUnitId)).map(item=>({...item,isAvailable:!unavailable||(params.has("whole-room-unavailable")?item.unit.roomId!=="room0":item.unit.inventoryUnitId!=="unit0-0")}));return {...group,units,availableCount:units.filter(item=>item.isAvailable).length,totalCount:units.length};});
 const capabilities={manage:!params.has("viewer"),manageGuests:!params.has("viewer"),readGuests:!params.has("viewer"),createGuests:!params.has("viewer"),cancel:!params.has("viewer"),checkIn:!params.has("viewer"),noShow:!params.has("viewer"),checkOut:!params.has("viewer")};
 const navigation={reportOwner:()=>{},paused:false,expanded:false};
 function applyBoundary(event){
  const boundary=window.reservationBoundary;
  if(!boundary||event.target.textContent!=="Keep reservation")return;
  delete window.reservationBoundary;
  window.reservationBoundaryProof={activeText:document.activeElement?.textContent,keepConnected:event.target.isConnected};
  if(boundary==="authority")setCurrent(false);
  if(boundary==="identity")setIdentity("different-owner");
  if(boundary==="unmount")setOpen(false);
  if(boundary==="independent focus")document.querySelector('button[aria-controls="booking-details-history"]').focus({preventScroll:true});
  if(boundary==="top modal")setNested(true);
 }
 return <QueryClientProvider client={client}><div onClick={applyBoundary}><button onClick={()=>setOpen(true)}>Open reservation form</button>{open && (params.has("detail")?
 <ReservationDetail propertyId="property" reservationId="reservation" editorIdentity={identity} navigation={navigation} capabilities={capabilities} permissionSource={{...source,isFetching:!current}} canReadInventory={!params.has("viewer")} businessDateToday="2026-09-20" onClose={()=>setOpen(false)}/>
 :params.has("create")?
  <CreateReservationModal propertyId="property" propertyTimeZoneId="UTC" permissionSource={source} canCreateReservation canReadInventory canReadReservations canReadGuests canCreateGuests canManageGuests onClose={()=>setOpen(false)} onCreated={async()=>{}}/>
 :params.has("edit")?<Modal open title="Edit booking details" onClose={()=>setOpen(false)}><GuestDetailsForm details={{editor:{draft,sending:false,error:null},dirty:true,unresolved:false,revisionChanged:false,change:(key,value)=>setDraft(d=>({...d,[key]:value})),submit:async()=>{},cancel:()=>setOpen(false)}} authorityCurrent={current} onRefresh={()=>setCurrent(true)}/></Modal>
 :<Modal open title="New reservation" description="Native layout regression fixture" onClose={()=>setOpen(false)}><form onSubmit={event=>event.preventDefault()}>
  <ReservationInventoryPicker key={version} groups={visible?modifiedGroups:[]} visible={visible} current={current} loading={false} error={null} selectedUnits={visible?selected:[]} selectionEnabled={current} onToggle={id=>setSelected(ids=>ids.includes(id)?ids.filter(i=>i!==id):[...ids,id])}/>
  <label className="mt-5 block">Primary guest<input className="input w-full" required value={name} onChange={event=>setName(event.target.value)}/></label>
  <ModalActions><button type="button" className="btn" onClick={()=>setOpen(false)}>Cancel</button><button type="submit" className="btn btn-primary">Create reservation</button></ModalActions>
 </form></Modal>)}{nested&&<Modal open title="Independent dialog" onClose={()=>setNested(false)}><button onClick={()=>setNested(false)}>Dismiss independent dialog</button></Modal>}</div></QueryClientProvider>;
}
createRoot(document.getElementById("root")).render(<MemoryRouter><Fixture/></MemoryRouter>);
`;
let server: ViteDevServer;
let browser: Browser;
let origin: string;
const runtimeErrors: string[] = [];
beforeAll(async () => {
  const entry = normalizePath(process.cwd() + "/__reservation_layout_fixture.tsx");
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-reservation-layout-vite-")), logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "react-router", "@tanstack/react-query", "lucide-react", "@radix-ui/react-popover", "@radix-ui/react-select", "@daypicker/react"] },
    plugins: [react(), tailwindcss(), {
      name: "reservation-layout-test-fixture",
      resolveId: id => id === "/__reservation_layout_fixture.tsx" || id === entry ? entry : undefined,
      load(id) {
        if (id === entry) return fixture;
        if (id === normalizePath(process.cwd() + "/src/app/session.tsx")) return 'const session={tenantId:"tenant",subjectId:"subject",sessionId:"session",accessToken:"synthetic"}; const request=(...args)=>window.reservationFixtureRequest(...args); export function useSession(){return {session,request};}';
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__reservation-layout")) return next();
        void vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__reservation_layout_fixture.tsx"></script></body></html>')
          .then(html => { res.setHeader("Content-Type", "text/html"); res.end(html); });
      }); },
    }], server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen(); origin = server.resolvedUrls!.local[0]; browser = await launchNativeChromium();
}, 60000);
afterAll(async () => { await browser?.close(); await server?.close(); expect(runtimeErrors).toEqual([]); });
async function open(width = 320, query = "", height = 640) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => runtimeErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") runtimeErrors.push(message.text()); });
  await page.goto(origin + "__reservation-layout" + query);
  await page.getByRole("dialog").waitFor();
  if (query.includes("create")) await page.getByText("58 available across 17 rooms").waitFor();
  if (query.includes("detail") && !query.includes("read-")) await page.getByRole("region",{name:"Stay summary",exact:true}).waitFor();
  return page;
}
const room = (page: Page, number = "01") => page.getByRole("button", { name: new RegExp("^Dorm " + number) });
const unit = (page: Page, index = 0) => page.getByRole("checkbox", { name: /^Bed / }).nth(index);
const summary = (page: Page) => page.locator("[data-inventory-selection-summary]");
type Harness = { setCurrent: (v: boolean) => void; setVisible: (v: boolean) => void; setSelected: (v: string[]) => void; setMissing: (v: boolean) => void; setUnavailable: (v: boolean) => void; reset: () => void; refetch: () => void };
async function change(page: Page, action: keyof Harness, value?: boolean | string[]) {
  await page.evaluate(({ action, value }) => { const fn = (window as unknown as { reservationHarness: Record<string, (v?: boolean | string[]) => void> }).reservationHarness[action]; fn(value); }, { action, value });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function focusedAndRevealed(page: Page, selector: string) {
  return page.locator(selector).evaluate(element => {
    const box=element.closest("[data-bunkfy-modal-box]")!;
    const scroller=box.children[1].getBoundingClientRect(), rect=element.getBoundingClientRect();
    const modalBox=box as HTMLElement, bounds=box.getBoundingClientRect(),header=box.children[0].getBoundingClientRect();
    return document.activeElement===element && rect.top>=scroller.top+3 && rect.bottom<=scroller.bottom-3
      && modalBox.scrollTop===0 && header.top>=bounds.top-1 && header.bottom<=scroller.top+1
      && window.scrollY===0 && document.documentElement.scrollTop===0
      && (box.closest('[data-bunkfy-modal]') as HTMLElement).scrollTop===0;
  });
}
async function capture(page: Page, name: string) {
  const directory=process.env.BUNKFY_RESERVATION_LAYOUT_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory,{recursive:true});
  await page.screenshot({path:join(directory,name),fullPage:true});
}
async function revealInModal(page: Page, selector: string) {
  await page.locator(selector).evaluate(element=>{
    const port=element.closest('[data-bunkfy-modal-box]')!.children[1] as HTMLElement;
    port.scrollTop+=element.getBoundingClientRect().top-port.getBoundingClientRect().top-16;
  });
}
function record(name: string, value: unknown) {
  const directory=process.env.BUNKFY_RESERVATION_LAYOUT_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,name),JSON.stringify(value,null,2)+"\n");
}
async function tabToButton(page: Page,name: string) {
  const button=page.getByRole("button",{name,exact:true});
  for(let count=0;count<50 && !await button.evaluate(element=>document.activeElement===element);count++) await page.keyboard.press("Tab");
  expect(await button.evaluate(element=>document.activeElement===element)).toBe(true);
  return button;
}
async function noFixtureCommands(page: Page) {
  expect(await page.evaluate(()=>(window as unknown as {reservationFixtureRequests:{method:string}[]}).reservationFixtureRequests.filter(request=>request.method!=="GET"))).toEqual([]);
}

type RecoveryWindow = {
  reservationRead: { status: number; pending: boolean };
  reservationHistoryStatus: number;
  releaseReservationRead: () => void;
  reservationHarness: Record<string, (value?: string | boolean) => unknown>;
  reservationFixtureRequests: { path: string; method: string }[];
};
async function setReservationRead(page: Page, status: number, pending = false) {
  await page.evaluate(read => { (window as unknown as RecoveryWindow).reservationRead = read; }, { status, pending });
}
async function recoveryAction(page: Page, action: string, value?: string | boolean) {
  await page.evaluate(({ action, value }) => { void (window as unknown as RecoveryWindow).reservationHarness[action](value); }, { action, value });
}
async function reservationReadCount(page: Page) {
  return page.evaluate(() => (window as unknown as RecoveryWindow).reservationFixtureRequests.filter(request => request.path === "/api/reservations/properties/property/reservation" && request.method === "GET").length);
}
async function releaseReservationRead(page: Page) {
  await page.evaluate(() => (window as unknown as RecoveryWindow).releaseReservationRead());
}

describe("REC003 primary reservation recovery", () => {
  it.each([320, 1440])("%i: one cold failure recovers through its native Retry", async width => {
    const page = await open(width, "?detail&read-status=503", width === 320 ? 640 : 800);
    try {
      await page.getByText("Reservation could not be opened", { exact: true }).waitFor();
      expect(await page.getByRole("alert").count()).toBe(1);
      expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(1);
      expect(await page.getByRole("heading", { name: "Booking details", exact: true }).count()).toBe(0);
      expect(await page.getByRole("region", { name: "Stay summary", exact: true }).count()).toBe(0);
      expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await capture(page, `rec003-cold-503-${width}.png`);
      await setReservationRead(page, 200, true);
      await tabToButton(page, "Try again");
      await page.keyboard.press("Enter");
      await page.getByText("Loading reservation details", { exact: true }).last().waitFor();
      expect(await page.getByRole("heading", { name: "Booking details", exact: true }).count()).toBe(0);
      await page.keyboard.press("Enter"); await page.keyboard.press("Space");
      expect(await reservationReadCount(page)).toBe(2);
      await releaseReservationRead(page);
      await page.getByRole("region", { name: "Stay summary", exact: true }).waitFor();
      await expect.poll(() => focusedAndRevealed(page, 'section[aria-label="Stay summary"] h3[tabindex="-1"]')).toBe(true);
      expect(await page.getByRole("heading", { name: "Booking details", exact: true }).count()).toBe(1);
      expect(await page.getByRole("alert").count()).toBe(0);
      expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(0);
      await capture(page, `rec003-native-recovered-${width}.png`);
      await noFixtureCommands(page);
    } finally { await page.close(); }
  }, 30000);

  it("keeps the cold loading state free of empty booking details", async () => {
    const page = await open(320, "?detail&read-pending");
    try {
      await page.getByText("Loading reservation details", { exact: true }).last().waitFor();
      expect(await page.getByRole("heading", { name: "Booking details", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(0);
      await releaseReservationRead(page);
      await page.getByRole("region", { name: "Stay summary", exact: true }).waitFor();
      await noFixtureCommands(page);
    } finally { await page.close(); }
  });

  it("blocks offline retry without queuing another read", async () => {
    const page = await open(320, "?detail&read-status=503");
    try {
      const retry = page.getByRole("button", { name: "Try again", exact: true });
      await retry.waitFor();
      await page.context().setOffline(true);
      await page.getByText("Reconnect before retrying reservation details.", { exact: true }).waitFor();
      expect(await retry.isDisabled()).toBe(true);
      await retry.evaluate(button => { (button as HTMLButtonElement).click(); });
      expect(await reservationReadCount(page)).toBe(1);
      await setReservationRead(page, 200);
      await page.context().setOffline(false);
      // React Query's normal reconnect policy may recover the existing read.
      await page.getByRole("region", { name: "Stay summary", exact: true }).waitFor();
      expect(await reservationReadCount(page)).toBe(2);
      await noFixtureCommands(page);
    } finally { await page.close(); }
  });

  it("distinguishes primary 403 access denial and keeps independent history and Guest state", async () => {
    const page = await open(320, "?detail&read-status=403");
    try {
      await page.getByText("Reservation access denied", { exact: true }).waitFor();
      expect(await page.getByText("Your current workspace role does not allow this action.", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Reservation could not be opened", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(1);
      await page.getByRole("button", { name: "Booking details history", exact: true }).click();
      await page.getByText("Earlier instructions", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Guest record", exact: true }).click();
      await page.getByText("Refresh current reservation details before opening its Guest Record.", { exact: true }).waitFor();
      await noFixtureCommands(page);
    } finally { await page.close(); }
  });

  it("preserves Retry-After and hides cached data after a definitive 403", async () => {
    const throttled = await open(320, "?detail&read-status=429&retry-after=30000");
    try {
      const retry = throttled.getByRole("button", { name: /^Try again in \d+s$/ });
      await retry.waitFor();
      expect(await retry.isDisabled()).toBe(true);
      expect(await throttled.getByText("BunkFy is receiving too many requests. Try again in about 30 seconds.", { exact: true }).count()).toBe(1);
      await retry.evaluate(button => { (button as HTMLButtonElement).click(); });
      expect(await reservationReadCount(throttled)).toBe(1);
    } finally { await throttled.close(); }
    const denied = await open(320, "?detail");
    try {
      await setReservationRead(denied, 403);
      await recoveryAction(denied, "refetchRead");
      await denied.getByText("Reservation access denied", { exact: true }).waitFor();
      expect(await denied.getByRole("region", { name: "Stay summary", exact: true }).count()).toBe(0);
      expect(await denied.getByRole("heading", { name: "Booking details", exact: true }).count()).toBe(0);
      expect(await denied.getByText("Reservation details are delayed", { exact: true }).count()).toBe(0);
      await noFixtureCommands(denied);
    } finally { await denied.close(); }
  });

  it("retains separate permission and history failures during a primary outage", async () => {
    const page = await open(320, "?detail&read-status=503");
    try {
      await page.getByText("Reservation could not be opened", { exact: true }).waitFor();
      await page.evaluate(() => { (window as unknown as RecoveryWindow).reservationHistoryStatus = 503; });
      await page.getByRole("button", { name: "Booking details history", exact: true }).click();
      await page.getByText("Reservation history is delayed", { exact: true }).waitFor();
      await recoveryAction(page, "setPermissionState", "stale");
      await page.getByText("Reservation access is delayed", { exact: true }).waitFor();
      expect(await page.getByText("Permissions is showing its last confirmed snapshot.", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Reservation could not be opened", { exact: true }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(3);
      const permissionNotice = page.getByRole("status").filter({ hasText: "Reservation access is delayed" });
      await permissionNotice.getByRole("button", { name: "Try again", exact: true }).click();
      await expect.poll(() => permissionNotice.count()).toBe(0);
      // Restoring permission re-enables the normal reservation query.
      await expect.poll(() => reservationReadCount(page)).toBe(2);
      await expect.poll(() => page.getByText("Reservation history is delayed", { exact: true }).count()).toBe(1);
      await noFixtureCommands(page);
    } finally { await page.close(); }
  });

  it("keeps usable stale details visible and prevents repeated pending retry", async () => {
    const page = await open(320, "?detail");
    try {
      await setReservationRead(page, 503);
      await recoveryAction(page, "refetchRead");
      await page.getByText("Reservation details are delayed", { exact: true }).waitFor();
      expect(await page.getByRole("region", { name: "Stay summary", exact: true }).count()).toBe(1);
      expect(await page.getByRole("heading", { name: "Booking details", exact: true }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Edit booking details", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Check out", exact: true }).isDisabled()).toBe(true);
      await setReservationRead(page, 200, true);
      const retry = page.getByRole("button", { name: "Try again", exact: true });
      await retry.focus(); await page.keyboard.press("Enter");
      await expect.poll(() => retry.getAttribute("aria-disabled")).toBe("true");
      await page.keyboard.press("Enter"); await page.keyboard.press("Space");
      expect(await reservationReadCount(page)).toBe(3);
      await releaseReservationRead(page);
      await expect.poll(() => retry.count()).toBe(0);
      expect(await page.getByRole("button", { name: "Edit booking details", exact: true }).isEnabled()).toBe(true);
      await noFixtureCommands(page);
    } finally { await page.close(); }
  });

  it.each([false, true])("preserves an editor without a usable item (unresolved save: %s)", async unresolved => {
    const page = await open(320, "?detail" + (unresolved ? "&uncertain-save" : ""));
    try {
      await page.getByRole("button", { name: "Edit booking details", exact: true }).click();
      const notes = page.getByRole("textbox", { name: "Notes", exact: true });
      await notes.fill("Keep this locally edited arrival note");
      if (unresolved) {
        await page.getByRole("button", { name: "Save booking details", exact: true }).click();
        await page.getByRole("button", { name: "Retry same change", exact: true }).waitFor();
      }
      await setReservationRead(page, 503);
      await recoveryAction(page, "resetRead");
      await page.getByText("Reservation could not be opened", { exact: true }).waitFor();
      expect(await page.getByRole("region", { name: "Stay summary", exact: true }).count()).toBe(0);
      expect(await page.getByRole("heading", { name: "Booking details", exact: true }).count()).toBe(1);
      expect(await notes.inputValue()).toBe("Keep this locally edited arrival note");
      expect(await notes.isDisabled()).toBe(true);
      const save = page.getByRole("button", { name: unresolved ? "Retry same change" : "Save booking details", exact: true });
      expect(await save.isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Refresh current details", exact: true }).count()).toBe(1);
      await setReservationRead(page, 200);
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await page.getByRole("region", { name: "Stay summary", exact: true }).waitFor();
      await expect.poll(() => save.isEnabled()).toBe(true);
      expect(await notes.inputValue()).toBe("Keep this locally edited arrival note");
      if (unresolved) {
        expect(await page.getByRole("button", { name: "Cancel", exact: true }).isDisabled()).toBe(true);
        expect(await notes.isDisabled()).toBe(true);
        const writes = await page.evaluate(() => (window as unknown as RecoveryWindow).reservationFixtureRequests.filter(request => request.method !== "GET"));
        expect(writes).toEqual([{ path: "/api/reservations/properties/property/reservation/guest-details", method: "PUT" }]);
      } else {
        expect(await notes.isEnabled()).toBe(true);
        await noFixtureCommands(page);
      }
    } finally { await page.close(); }
  });

  it("does not move focus away from an independent control after recovery", async () => {
    const page = await open(320, "?detail&read-status=503");
    try {
      await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
      await setReservationRead(page, 200, true);
      await tabToButton(page, "Try again"); await page.keyboard.press("Enter");
      await page.getByText("Loading reservation details", { exact: true }).last().waitFor();
      const history = page.getByRole("button", { name: "Booking details history", exact: true });
      await history.focus();
      await releaseReservationRead(page);
      await page.getByRole("region", { name: "Stay summary", exact: true }).waitFor();
      expect(await history.evaluate(element => document.activeElement === element)).toBe(true);
      await noFixtureCommands(page);
    } finally { await page.close(); }
  });
});

describe("B2 R2 lifecycle keyboard return",()=>{
  const actions=[{name:"Check out",status:"checkedIn",key:"Enter"},{name:"Check in",status:"confirmed",key:"Enter"},{name:"Mark no-show",status:"confirmed",key:"Space"},{name:"Cancel",status:"confirmed",key:"Enter"}];
  it.each([320,1440].flatMap(width=>actions.map(action=>({...action,width}))))("$width $name returns from keyboard Keep to its action",async({width,name,status,key})=>{
    const page=await open(width,"?detail&status="+status,width===320?640:800);
    try {
      await tabToButton(page,name); await page.keyboard.press(key);
      await tabToButton(page,"Keep reservation"); await page.keyboard.press("Enter");
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const slug=name.toLowerCase().replaceAll(" ","-");
      await capture(page,`focus-${slug}-${width}.png`);
      const active=await page.evaluate(()=>({tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute("aria-label"),text:document.activeElement?.textContent?.slice(0,100)}));
      record(`focus-${slug}-${width}.json`,active);
      await noFixtureCommands(page);
      expect(await focusedAndRevealed(page,`[aria-label="Reservation actions"] button:has-text("${name}")`)).toBe(true);
    } finally {await page.close();}
  },30000);
  it("pointer entry followed by keyboard Keep also returns to the action",async()=>{
    const page=await open(320,"?detail",640);
    try {
      await revealInModal(page,'[aria-label="Reservation actions"]');
      await page.getByRole("button",{name:"Check out",exact:true}).click();
      await tabToButton(page,"Keep reservation"); await page.keyboard.press("Space");
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await capture(page,"focus-pointer-entry-keyboard-keep-320.png");
      expect(await focusedAndRevealed(page,'[aria-label="Reservation actions"] button:has-text("Check out")')).toBe(true);
      await noFixtureCommands(page);
    } finally {await page.close();}
  },30000);
  it.each(["authority","identity","unmount","independent focus","top modal"])("rejects return across %s boundary",async boundary=>{
    const page=await open(320,"?detail",640);
    try {
      await tabToButton(page,"Check out"); await page.keyboard.press("Enter");
      await tabToButton(page,"Keep reservation");
      // A React ancestor shares the cancellation event's batch, after the child
      // captures intent and before its queued update commits. Prove that timing.
      await page.evaluate(boundary=>{(window as unknown as {reservationBoundary:string}).reservationBoundary=boundary;},boundary);
      await page.keyboard.press("Enter");
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const proof=await page.evaluate(()=>(window as unknown as {reservationBoundaryProof:unknown}).reservationBoundaryProof);
      record("boundary-"+boundary.replaceAll(" ","-")+".json",proof);
      expect(proof).toEqual({activeText:"Keep reservation",keepConnected:true});
      const action=page.getByRole("button",{name:"Check out",exact:true});
      expect(await action.count()===0 || !await action.evaluate(element=>document.activeElement===element)).toBe(true);
      if(boundary==="authority") {
        expect(await action.isDisabled()).toBe(true); await change(page,"setCurrent",true);
        expect(await action.evaluate(element=>document.activeElement===element)).toBe(false);
      }
      if(boundary==="independent focus") expect(await page.getByRole("button",{name:"Booking details history",exact:true}).evaluate(element=>document.activeElement===element)).toBe(true);
      if(boundary==="top modal")expect(await page.getByRole("dialog").last().evaluate(element=>element.contains(document.activeElement))).toBe(true);
      if(boundary==="unmount")expect(await page.getByRole("dialog").count()).toBe(0);
      await noFixtureCommands(page);
    } finally {await page.close();}
  },30000);
  it("Escape retains whole-modal close instead of becoming confirmation cancellation",async()=>{
    const page=await open(320,"?detail",640);
    try {
      await page.keyboard.press("Escape");
      const opener=page.getByRole("button",{name:"Open reservation form",exact:true});await opener.click();
      await tabToButton(page,"Check out");await page.keyboard.press("Enter");
      await tabToButton(page,"Keep reservation");await page.keyboard.press("Escape");
      expect(await page.getByRole("dialog").count()).toBe(0);
      expect(await opener.evaluate(element=>document.activeElement===element)).toBe(true);
      await noFixtureCommands(page);
    } finally {await page.close();}
  },30000);
});

describe("B2 reservation read layout",()=>{
  it.each([320,1024,1440])("%i: stay owns lifecycle controls and disclosure edges align",async width=>{
    const page=await open(width,"?detail",800);
    try {
      const stay=page.getByRole("region",{name:"Stay summary",exact:true});
      const action=page.getByRole("button",{name:"Check out",exact:true});
      await action.evaluate(element=>{
        const port=element.closest('[data-bunkfy-modal-box]')!.children[1] as HTMLElement;
        port.scrollTop+=Math.max(0,element.getBoundingClientRect().bottom-port.getBoundingClientRect().bottom+16);
      });
      await capture(page,`b2-001-stay-${width}.png`);
      const grouping=await action.evaluate(element=>{
        const section=element.closest('section[aria-label="Stay summary"]');
        return {inside:!!section,actionBottom:element.getBoundingClientRect().bottom,stayBottom:section?.getBoundingClientRect().bottom??null};
      });
      record(`b2-001-stay-${width}.json`,grouping);
      // Capture both independent baselines before either fail-before assertion.
      const alignment=[];
      for(const [title,id] of [["Booking details history","booking-details-history"],["Guest record","booking-guest-record"]]) {
        const toggle=page.getByRole("button",{name:title,exact:true});
        await revealInModal(page,`button[aria-controls="${id}"]`); await toggle.click();
        const geometry=await toggle.evaluate((button,contentId)=>{
          const span=button.querySelector("span")!,body=document.getElementById(contentId)!;
          return {labelLeft:span.getBoundingClientRect().left,bodyLeft:body.getBoundingClientRect().left,height:button.getBoundingClientRect().height};
        },id);
        alignment.push(geometry);
        if(title==="Booking details history") await page.getByText("Earlier instructions",{exact:true}).waitFor();
        await revealInModal(page,`button[aria-controls="${id}"]`);
        await toggle.press("Space"); await toggle.press("Space");
        expect(await focusedAndRevealed(page,`button[aria-controls="${id}"]`)).toBe(true);
        await capture(page,`b2-${title==="Guest record"?"003-guest":"002-history"}-${width}.png`);
      }
      record(`b2-002-alignment-${width}.json`,alignment);
      expect.soft(grouping.inside).toBe(true);
      expect.soft(grouping.stayBottom).not.toBeNull();
      if(grouping.stayBottom!==null) expect(grouping.actionBottom).toBeLessThan(grouping.stayBottom);
      for(const geometry of alignment) {expect.soft(Math.abs(geometry.labelLeft-geometry.bodyLeft)).toBeLessThanOrEqual(2);expect(geometry.height).toBeGreaterThanOrEqual(44);}
      expect(await page.getByRole("dialog").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
      await revealInModal(page,'[aria-label="Reservation actions"]'); await action.click();
      const confirm=page.getByRole("button",{name:"Confirm checkout",exact:true});
      expect(await confirm.evaluate(element=>!!element.closest('section[aria-label="Stay summary"]'))).toBe(true);
      expect(await stay.getByText("BunkFy will release the occupied inventory.",{exact:false}).count()).toBe(1);
      await page.getByRole("button",{name:"Keep reservation",exact:true}).click();
      expect(await confirm.count()).toBe(0);
      expect(await page.evaluate(()=>(window as unknown as {reservationFixtureRequests:{method:string}[]}).reservationFixtureRequests.filter(request=>request.method!=="GET"))).toEqual([]);
    } finally {await page.close();}
  },30000);
  it.each(["confirmed","checkedOut","viewer"])("retains %s read semantics without an empty lifecycle shell",async state=>{
    const page=await open(320,"?detail&missing&"+(state==="viewer"?"viewer":"status="+state),800);
    try {
      const stay=page.getByRole("region",{name:"Stay summary",exact:true});
      if(state==="confirmed") expect(await stay.getByRole("button",{name:"Check in",exact:true}).count()).toBe(1);
      else {
        expect(await page.locator('[aria-label="Reservation actions"]').count()).toBe(0);
        expect(await stay.evaluate(element=>element.children.length)).toBe(2);
      }
      expect(await page.getByText("Not provided",{exact:true}).count()).toBe(2);
      expect(await page.getByRole("dialog").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
      if(state==="viewer") {
        expect(await page.getByRole("button",{name:"Edit booking details",exact:true}).count()).toBe(0);
        expect(await page.getByText("inventory access is not assigned",{exact:false}).count()).toBe(1);
      }
      await capture(page,`b2-004-${state}-320.png`);
      expect(await page.evaluate(()=>(window as unknown as {reservationFixtureRequests:{method:string}[]}).reservationFixtureRequests.filter(request=>request.method!=="GET"))).toEqual([]);
    } finally {await page.close();}
  },30000);
});

describe("R2 reservation repair regressions", () => {
  it.each([false,true])("R2 explicitly removes a freshly unavailable selected bed and preserves local focus (room gone: %s)",async wholeRoom=>{
    const page=await open(320,"?preselected"+(wholeRoom?"&whole-room-unavailable":""),640);
    try {
      const selected=unit(page);
      expect(await selected.isChecked()).toBe(true);
      await change(page,"setUnavailable",true);
      expect(await selected.isChecked()).toBe(true);
      await change(page,"setCurrent",false);
      expect(await selected.isDisabled()).toBe(true); expect(await selected.isChecked()).toBe(true);
      await change(page,"setCurrent",true);
      if(!wholeRoom) {
        await capture(page,"r2-before-001-selected-unavailable-320.png");
        record("r2-before-001-selected-unavailable.json",{checked:await selected.isChecked(),disabled:await selected.isDisabled(),roomExpanded:await room(page).getAttribute("aria-expanded")});
      }
      expect(await selected.isEnabled()).toBe(true);
      await selected.press("Space");
      expect(await page.getByRole("button",{name:"Done choosing",exact:true}).count()).toBe(0);
      expect(await focusedAndRevealed(page,wholeRoom?'h3[tabindex="-1"]':'button[data-inventory-room="room0"]')).toBe(true);
      await capture(page,wholeRoom?"r2-after-005-removed-room-focus-320.png":"r2-after-004-removed-bed-focus-320.png");
      await page.getByRole("checkbox",{name:"Show unavailable inventory"}).check();
      await room(page).click();
      const unavailable=page.getByRole("checkbox",{name:/^Bed 1 .*Unavailable/}).first();
      expect(await unavailable.isChecked()).toBe(false); expect(await unavailable.isDisabled()).toBe(true);
    } finally { await page.close(); }
  },30000);

  it("R2 leaves viewport growth, ordinary edits and an active pointer gesture alone",async()=>{
    const page=await open(1440,"?edit",800);
    try {
      const notes=page.getByRole("textbox",{name:"Notes",exact:true});
      await notes.click(); await page.keyboard.type(" retained native draft");
      const port=page.locator('[data-bunkfy-modal-box] > div').nth(1);
      expect(await port.evaluate(element=>element.scrollTop)).toBe(0);
      await page.setViewportSize({width:1600,height:900});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      expect(await notes.evaluate(element=>document.activeElement===element)).toBe(true);
      expect(await port.evaluate(element=>element.scrollTop)).toBe(0);
      const rect=await notes.boundingBox();
      await page.mouse.move(rect!.x+20,rect!.y+20); await page.mouse.down();
      await page.setViewportSize({width:320,height:640});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      expect(await port.evaluate(element=>element.scrollTop)).toBe(0);
      expect(await notes.inputValue()).toContain("retained native draft");
      await page.mouse.up();
      await page.setViewportSize({width:320,height:600});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      expect(await port.evaluate(element=>element.scrollTop)).toBe(0); // Already offscreen focus is not a reveal request.
      expect(await page.locator('[data-bunkfy-modal-box]').evaluate(element=>element.scrollTop)).toBe(0);
    } finally { await page.close(); }
  },30000);

  it("R2 keeps native-Tab-focused visible Notes painted after desktop-to-mobile shrink",async()=>{
    const page=await open(1440,"?edit",800);
    try {
      const notes=page.getByRole("textbox",{name:"Notes",exact:true});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      for(let index=0;index<24 && !await notes.evaluate(element=>document.activeElement===element);index++) await page.keyboard.press("Tab");
      expect(await notes.evaluate(element=>document.activeElement===element)).toBe(true);
      await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.type("Native keyboard draft remains visible while the viewport shrinks.");
      await notes.evaluate(element=>{(window as unknown as {r2FocusedNotes:Element}).r2FocusedNotes=element;});
      const geometry=()=>notes.evaluate(element=>{
        const input=element as HTMLTextAreaElement,box=element.closest('[data-bunkfy-modal-box]') as HTMLElement,port=box.children[1] as HTMLElement;
        const rect=input.getBoundingClientRect(),bounds=port.getBoundingClientRect();
        return {active:document.activeElement===input,sameNode:input===(window as unknown as {r2FocusedNotes:Element}).r2FocusedNotes,
          value:input.value,selectionStart:input.selectionStart,selectionEnd:input.selectionEnd,
          field:{top:rect.top,bottom:rect.bottom},port:{top:bounds.top,bottom:bounds.bottom,scrollTop:port.scrollTop},
          documentScroll:window.scrollY,modalScroll:box.scrollTop,visible:rect.top>=bounds.top&&rect.bottom<=bounds.bottom};
      });
      const before=await geometry();
      record("r2-before-002-notes-desktop.json",before);
      await capture(page,"r2-before-002-notes-visible-1440.png");
      expect(before.visible).toBe(true); expect(before.modalScroll).toBe(0);
      await page.setViewportSize({width:320,height:640});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const after=await geometry();
      record("r2-before-003-notes-shrink.json",{before,after});
      await capture(page,"r2-before-003-notes-shrink-320.png");
      expect(after.active).toBe(true); expect(after.sameNode).toBe(true); expect(after.value).toBe(before.value);
      expect(after.selectionStart).toBe(before.selectionStart); expect(after.selectionEnd).toBe(before.selectionEnd);
      expect(after.documentScroll).toBe(before.documentScroll); expect(after.modalScroll).toBe(before.modalScroll);
      expect(after.visible).toBe(true);
    } finally { await page.close(); }
  },30000);
});

describe("reservation form native content layout", () => {
  it.each([320, 1024, 1440])("%i: deliberate selection summary, focus, 58-unit grouping and fixed footer", async width => {
    const page=await open(width);
    try {
      expect(await page.getByRole("button",{name:/^Dorm /}).count()).toBe(17);
      expect(await page.getByRole("checkbox",{name:/^Bed /}).count()).toBe(0);
      await room(page).press("Enter"); await unit(page).check(); await unit(page,1).check();
      expect(await unit(page).isChecked()).toBe(true); expect(await unit(page,1).isChecked()).toBe(true);
      expect(await page.getByRole("button",{name:"Done choosing"}).isVisible()).toBe(true);
      await page.getByRole("button",{name:"Done choosing"}).press("Space");
      expect(await summary(page).getByRole("listitem").count()).toBe(2);
      expect(await summary(page).innerText()).toContain("Dorm 01 · Riverside house");
      expect(await focusedAndRevealed(page,"[data-inventory-selection-summary] button")).toBe(true);
      if(width===320) await capture(page,"001-picker-summary-320-short.png");
      const distance=await page.getByRole("textbox",{name:"Primary guest"}).evaluate(element=>{
        const scroller=element.closest("[data-bunkfy-modal-box]")!.children[1];
        return {distance:element.getBoundingClientRect().bottom-document.querySelector('[data-inventory-selection-summary]')!.getBoundingClientRect().bottom,viewport:scroller.clientHeight};
      });
      expect(distance.distance).toBeLessThan(distance.viewport);
      expect(await page.getByRole("dialog").evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
      await page.getByRole("button",{name:"Change rooms or beds"}).press("Enter");
      expect(await focusedAndRevealed(page,'h3[tabindex="-1"]')).toBe(true);
      expect(await unit(page).isChecked()).toBe(true); expect(await unit(page,1).isChecked()).toBe(true);
      await page.getByRole("button",{name:"Expand all",exact:true}).click();
      expect(await page.getByRole("checkbox",{name:/^Bed /}).count()).toBe(58);
      await page.getByRole("button",{name:"Collapse all",exact:true}).press("Enter");
      expect(await page.getByRole("checkbox",{name:/^Bed /}).count()).toBe(0);
    } finally { await page.close(); }
  },30000);

  it("preselection, currentness loss, hidden preference owner, unavailable exact replay and key reset",async()=>{
    const page=await open(320,"?preselected");
    try {
      expect(await room(page).getAttribute("aria-expanded")).toBe("true");
      expect(await unit(page).isChecked()).toBe(true);
      await room(page,"02").click();
      await page.getByRole("button",{name:"Done choosing"}).click();
      await change(page,"setCurrent",false);
      expect(await summary(page).innerText()).toContain("awaiting current confirmation");
      expect(await summary(page).innerText()).not.toContain("Dorm 01");
      await change(page,"setVisible",false); expect(await summary(page).count()).toBe(0);
      await change(page,"setCurrent",true); await change(page,"setVisible",true);
      expect(await summary(page).innerText()).toContain("Dorm 01");
      await change(page,"setUnavailable",true);
      expect(await summary(page).innerText()).toContain("Unavailable for a new booking");
      await page.getByRole("button",{name:"Change rooms or beds"}).click();
      await page.getByRole("checkbox",{name:"Show unavailable inventory"}).check();
      expect(await room(page,"02").getAttribute("aria-expanded")).toBe("true");
      expect(await unit(page).isChecked()).toBe(true); expect(await unit(page).isEnabled()).toBe(true);
      await page.getByRole("button",{name:"Done choosing"}).click();
      await page.getByRole("button",{name:"Change rooms or beds"}).click();
      expect(await page.getByRole("checkbox",{name:"Show unavailable inventory"}).isChecked()).toBe(true);
      await page.getByRole("button",{name:"Done choosing"}).click(); await change(page,"setMissing",true);
      expect(await summary(page).innerText()).toContain("not in the current inventory result");
      expect(await summary(page).innerText()).not.toContain("Dorm 01");
      await change(page,"setMissing",false); await change(page,"setSelected",[]);
      expect(await summary(page).count()).toBe(0);
      await change(page,"setUnavailable",false); await room(page).click(); await unit(page).check();
      expect(await summary(page).count()).toBe(0); // A new checkbox must not auto-complete an emptied selection.
      await change(page,"reset");
      expect(await room(page).getAttribute("aria-expanded")).toBe("false");
      expect(await page.getByRole("button",{name:"Done choosing"}).count()).toBe(0);
    } finally { await page.close(); }
  },30000);

  it.each([320,1024,1440])("%i: real creation grouping, dirty resize and deliberate Continue/Back orientation",async width=>{
    const page=await open(width,"?create",800);
    try {
      await room(page).click(); await unit(page).check(); await page.getByRole("button",{name:"Done choosing"}).click();
      const guest=page.getByRole("textbox",{name:"Primary guest",exact:true});
      const distance=await guest.evaluate(element=>({distance:element.getBoundingClientRect().bottom-document.querySelector('[data-inventory-selection-summary]')!.getBoundingClientRect().bottom,viewport:element.closest('[data-bunkfy-modal-box]')!.children[1].clientHeight}));
      expect(distance.distance).toBeLessThan(distance.viewport);
      if(width===320) await capture(page,"002-create-summary-guest-320.png");
      const longName="Alexandra María Nguyễn Петрова — returning guest with a long family name";
      await guest.fill(longName); await page.getByRole("textbox",{name:"Email (optional)",exact:true}).fill("reservation.layout@example.invalid");
      await page.getByRole("radio",{name:"External",exact:true}).check();
      await page.getByRole("textbox",{name:"Source system",exact:true}).fill("Partner booking system");
      await page.getByRole("textbox",{name:"Source reference",exact:true}).fill("LONG-REFERENCE-2026-000000000001");
      const notes=page.getByRole("textbox",{name:"Reservation notes (optional)",exact:true}); await notes.fill("Late arrival\nKeep the selected rooms and this draft.");
      for(const next of [320,1024,width]){await page.setViewportSize({width:next,height:800});expect(await guest.inputValue()).toBe(longName);expect(await notes.inputValue()).toContain("Late arrival");}
      await page.getByRole("checkbox",{name:/Save as a Guest Record/}).check();
      if(width===320) await page.setViewportSize({width,height:640});
      await page.getByRole("button",{name:"Continue",exact:true}).click();
      expect(await focusedAndRevealed(page,'h3[tabindex="-1"]')).toBe(true);
      expect(await page.getByRole("heading",{name:"Guest Record",exact:true}).isVisible()).toBe(true);
      if(width===320) await capture(page,"003-create-guest-step-320.png");
      if(width===1024) await capture(page,"004-create-guest-step-1024.png");
      await page.keyboard.press("Tab");
      expect(await page.getByRole("textbox",{name:"Legal name (optional)",exact:true}).evaluate(e=>document.activeElement===e)).toBe(true);
      await page.getByRole("textbox",{name:"Legal name (optional)",exact:true}).fill("Saved optional legal name draft");
      await page.getByRole("button",{name:"Back",exact:true}).click();
      expect(await focusedAndRevealed(page,'h3:has-text("Stay")')).toBe(true);
      expect(await guest.inputValue()).toBe(longName);expect(await notes.inputValue()).toContain("Late arrival");
      await page.getByRole("button",{name:"Continue",exact:true}).click();
      expect(await page.getByRole("textbox",{name:"Legal name (optional)",exact:true}).inputValue()).toBe("Saved optional legal name draft");
      expect(await page.getByRole("dialog").evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
    } finally { await page.close(); }
  },30000);

  it("real inline editor preserves dirty contact/notes and currentness through resize",async()=>{
    const page=await open(1440,"?edit");
    try {
      const name=page.getByRole("textbox",{name:"Primary guest",exact:true});
      const notes=page.getByRole("textbox",{name:"Notes",exact:true});
      await name.fill("Very long guest name Nguyễn Мария ".repeat(5));await notes.fill("Long notes withoutspaces".repeat(25));
      await name.evaluate(e=>{(window as unknown as {draftInput:Element}).draftInput=e;});
      for(const width of [320,1024]){await page.setViewportSize({width,height:640});expect(await name.inputValue()).toContain("Nguyễn");expect(await name.evaluate(e=>e===(window as unknown as {draftInput:Element}).draftInput)).toBe(true);expect(await page.getByRole("dialog").evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);}
      await capture(page,"005-inline-edit-1024.png");
      await change(page,"setCurrent",false);expect(await name.isDisabled()).toBe(true);expect(await notes.inputValue()).toContain("withoutspaces");
      expect(await page.getByRole("button",{name:"Save booking details",exact:true}).isDisabled()).toBe(true);
      await change(page,"setCurrent",true);expect(await name.isEnabled()).toBe(true);
    } finally { await page.close(); }
  },30000);
});
