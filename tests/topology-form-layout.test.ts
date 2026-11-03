import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real RoomDetail, TopologyEditorForm, workspace, styles and native browser.
// The editor controller/receipts below are explicitly controlled, not API proof.
// The private composition is exported only by this test server's virtual load.
const fixture = `
import React,{useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter} from "react-router";
import {RoomDetail} from "/src/features/spaces/SpacesPage.tsx";
import {SpacesRoomWorkspace} from "/src/features/spaces/SpacesRoomWorkspace.tsx";
import {TopologyEditorForm} from "/src/features/properties/TopologyEditorForm.tsx";
import "/src/styles.css";
const params=new URLSearchParams(location.search), physicalRoom={propertyId:"property",roomId:"room",name:"Dorm 104 — quiet courtyard",buildingLabel:"Demo House",floorLabel:"First floor",status:"active",version:1};
const beds=[{...physicalRoom,bedId:"bed",label:"104-D",name:undefined}],property={propertyId:"property",name:"Synthetic layout property"};
const unit={propertyId:"property",roomId:"room",bedId:"bed",inventoryUnitId:"unit",kind:"bed",label:"104-D",isSellable:true,isTopologyActive:true,key:"bed:bed",physicalState:"present",physicalStatus:"active"};
const room={...physicalRoom,location:"Demo House · First floor",physicalStatus:"active",inventoryState:"present",salesMode:"bedLevel",inventoryUnits:[unit]};
function Siblings(){const [history,setHistory]=useState(false);return <section aria-label="Selected holds" className="p-4"><h4>Holds · Dorm 104</h4><button className="btn btn-sm" onClick={()=>setHistory(!history)}>{history?"Selected dates":"All history"}</button><p>{history?"Historical synthetic hold retained":"No holds for these dates"}</p></section>;}
function Fixture(){
 const [target,setTarget]=useState(null),[instance,setInstance]=useState(0),[current,setCurrent]=useState(true),[mode,setMode]=useState("ready"),[receipt,setReceipt]=useState(null),[saved,setSaved]=useState(null);
 const [selected,setSelected]=useState(params.has("bed")?unit:null),[filter,setFilter]=useState(""),[range,setRange]=useState({arrival:"2026-09-23",departure:"2026-09-25"});
 const opener=useRef(null),formDraft=useRef(null);const heading=useRef(null);
 function open(next,button){opener.current=button;formDraft.current=null;setInstance(n=>n+1);setTarget(next);}
 const editor={target,instance,opener,formDraft,busy:mode==="pending",canSubmit:current&&(mode==="ready"||mode==="pending"),mayManageRooms:!params.has("viewer"),mayManageBeds:!params.has("viewer"),canEditRoom:current,canEditBed:()=>current,canAddBeds:current,
 openRoom:(value,button)=>open({kind:"room",property,room:value},button),openBeds:(bed,button)=>open({kind:"bed",property,room:physicalRoom,bed},button),
 close:()=>setTarget(null),save:draft=>{setSaved(draft);setTarget(null);setReceipt("Synthetic save confirmed");},mutation:{error:mode==="conflict"||mode==="unknown"?new Error("Controlled failure"):null},conflict:mode==="conflict",inputRejected:false,canRetry:current,canUseCurrentVersion:false,refresh:async()=>{},retry:()=>setMode("pending")};
 window.topologyHarness={setCurrent,setMode,rerender:()=>setReceipt("Controlled rerender"),saved:()=>saved,draft:()=>formDraft.current};
 const source={label:"Physical bed details",state:current?"ready":"stale",isFetching:false,refetch:async()=>{}};
 return <><header className="app-topbar fixed inset-x-0 top-0 z-30 h-16 border-b bg-base-100 p-4">Synthetic BunkFy station</header><main className="mx-auto max-w-7xl px-4 pb-24 pt-20"><h1 className="mb-4 text-2xl font-semibold">Spaces</h1><p className="mb-4">Synthetic layout property · 1 room</p>{!params.has("viewer")&&<button className="btn btn-sm mb-3" disabled={!!target} onClick={event=>editor.openRoom(undefined,event.currentTarget)}>Add room</button>}<section data-topology-region className="spaces-room-frame rounded-lg border border-base-300 bg-base-100"><h2 ref={heading} className="sr-only">Rooms & beds</h2>{receipt&&<p role="status">{receipt}</p>}
 {target?.kind==="room"&&!target.room&&<TopologyEditorForm editor={editor} beds={beds} inline/>}
 <SpacesRoomWorkspace rooms={[room]} selectedRoom={room} selectedUnit={selected} selectedUnits={[unit]} physicalBedCount={1} inventoryCurrent mayReadInventory range={range} timeZoneId="Europe/London" locked={!!target} filter={filter} onFilterChange={setFilter} onRangeChange={setRange} onSelectRoom={()=>setSelected(null)} onSelectUnit={setSelected} requestedTarget selectionKey={selected?.key??"room"} availability={{rows:[],total:0,reportedAvailable:0,reportedUnavailable:0,unresolvedTargets:0,contextMismatch:false}}
 inspector={<RoomDetail room={room} units={[unit]} unitSelection={{status:selected?"selected":"none",unit:selected}} bedSource={source} inventorySource={source} bedEvidence={current?"current":"stale"} inventoryEvidence="current" editor={editor} physicalRoom={physicalRoom} physicalBeds={beds} mayRetireInventory={!params.has("viewer")} retirementEditor={{target:null,propertyId:"property",canOpen:()=>true,open:()=>{}}} mayConfigureInventory={!params.has("viewer")} salesEditor={{target:null,canOpen:()=>true,open:()=>{}}} salesRoom={room} salesOrigin={new URLSearchParams()} mayReadReservations issueCount={0} onSelectUnit={setSelected} onClearUnavailableTarget={()=>{}} operationalContent={<Siblings/>} otherEditorOpen={false}/>}/>
 </section><button className="btn mt-4">Independent destination</button></main><nav aria-label="Mobile navigation" className="fixed inset-x-0 bottom-0 z-30 h-16 border-t bg-base-100 p-4 lg:hidden">Today · Calendar · Spaces</nav></>;
}
createRoot(document.getElementById("root")).render(<MemoryRouter><Fixture/></MemoryRouter>);
`;
let server: ViteDevServer, browser: Browser, origin: string;
const runtimeErrors: string[] = [];
beforeAll(async () => {
  const entry = normalizePath(process.cwd() + "/__topology_layout_fixture.tsx");
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir: mkdtempSync(join(tmpdir(), "bunkfy-topology-layout-vite-")), logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "react-router", "@tanstack/react-query", "lucide-react", "@radix-ui/react-popover", "@radix-ui/react-select", "@daypicker/react"] },
    plugins: [react(), tailwindcss(), { name: "topology-layout-test-fixture",
      resolveId: id => id === "/__topology_layout_fixture.tsx" || id === entry ? entry : undefined,
      load(id) { if (id === entry) return fixture; if (id === normalizePath(process.cwd() + "/src/features/spaces/SpacesPage.tsx")) return readFileSync(id,"utf8") + "\nexport {RoomDetail};"; },
      configureServer(vite) { vite.middlewares.use((req,res,next) => {
        if (!req.url?.startsWith("/__topology-layout")) return next();
        void vite.transformIndexHtml(req.url,'<!doctype html><html><body><div id="root"></div><script type="module" src="/__topology_layout_fixture.tsx"></script></body></html>').then(html => {res.setHeader("Content-Type","text/html");res.end(html);});
      }); },
    }], server: {host:"127.0.0.1",port:0},
  });
  await server.listen(); origin=server.resolvedUrls!.local[0]; browser=await launchNativeChromium();
},60000);
afterAll(async()=>{await browser?.close();await server?.close();expect(runtimeErrors).toEqual([]);});
async function open(width:number,query="") {
  const page=await browser.newPage({viewport:{width,height:800}});page.setDefaultTimeout(5000);
  const startup:string[]=[];
  page.on("pageerror",e=>runtimeErrors.push(e.message));page.on("console",e=>{if(e.type()==="error")runtimeErrors.push(e.text());});
  page.on("requestfailed",r=>startup.push(r.failure()?.errorText+" "+r.url()));
  await page.goto(origin+"__topology-layout"+query);
  try{await page.getByRole("region",{name:"Rooms and beds comparison"}).waitFor();}catch(error){await page.close();throw new Error("Topology fixture startup failed: "+JSON.stringify(startup),{cause:error});}
  return page;
}
async function settle(page:Page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function capture(page:Page,name:string){if(process.env.TOPOLOGY_LAYOUT_EVIDENCE){mkdirSync(process.env.TOPOLOGY_LAYOUT_EVIDENCE,{recursive:true});await page.screenshot({path:join(process.env.TOPOLOGY_LAYOUT_EVIDENCE,name+".png")});}}
const taskNames={room:"Edit room",bed:"Edit bed 104-D",add:"Add beds"};
async function enter(page:Page,kind:keyof typeof taskNames){const button=page.getByRole("button",{name:taskNames[kind],exact:true});await button.focus();await button.evaluate(node=>{(window as unknown as {exactTopologyOpener:Element}).exactTopologyOpener=node;});await page.keyboard.press("Enter");await settle(page);}
async function visibleAboveChrome(page:Page,selector:string){return page.locator(selector).first().evaluate(node=>{const box=node.getBoundingClientRect(),footer=document.querySelector('nav[aria-label="Mobile navigation"]')!,bottom=footer.getClientRects().length?footer.getBoundingClientRect().top:innerHeight;return box.top>=64&&box.bottom<=bottom&&box.width>0;});}

describe("Focused topology task — mounted composition",()=>{
  it.each([320,1024,1440].flatMap(width=>(["room","bed","add"] as const).map(kind=>({width,kind}))))("$kind at $width keeps identity and exact opener, hides mounted siblings, and returns Cancel",async({width,kind})=>{
    const page=await open(width,kind==="bed"?"?bed":"");try{
      await page.getByRole("button",{name:"All history",exact:true}).click();
      await page.getByRole("region",{name:"Selected holds"}).evaluate(node=>{(window as unknown as {holdsNode:Element}).holdsNode=node;});
      await enter(page,kind);await capture(page,`${kind}-${width}`);
      expect(await page.locator('[data-topology-editor]').count()).toBe(1);
      expect(await page.evaluate(()=>{const opener=(window as unknown as {exactTopologyOpener:HTMLElement}).exactTopologyOpener;return opener.isConnected&&opener.getClientRects().length===0;})).toBe(true);
      expect(await page.getByRole("region",{name:"Selected holds"}).count()).toBe(0);
      expect(await page.getByRole("region",{name:"Selling"}).count()).toBe(0);
      expect(await page.getByRole("region",{name:"Retirement actions"}).count()).toBe(0);
      expect(await page.locator('[aria-label="Selected holds"]').evaluate(node=>node===(window as unknown as {holdsNode:Element}).holdsNode)).toBe(true);
      expect(await page.locator('[aria-label="Selected holds"] button').evaluate(node=>{(node as HTMLElement).focus();return document.activeElement===node;})).toBe(false);
      expect(await visibleAboveChrome(page,'[data-topology-editor] h3')).toBe(true);
      expect(await visibleAboveChrome(page,'[data-topology-editor] input')).toBe(true);
      expect(await visibleAboveChrome(page,'[data-inspector-heading]')).toBe(true);
      expect(await visibleAboveChrome(page,'[data-topology-editor] button[type="submit"]')).toBe(true);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const cancel=page.getByRole("button",{name:"Cancel",exact:true});await cancel.focus();await settle(page);
      expect(await visibleAboveChrome(page,'[data-topology-editor] :focus')).toBe(true);
      await page.keyboard.press("Enter");await settle(page);
      expect(await page.evaluate(()=>document.activeElement===(window as unknown as {exactTopologyOpener:Element}).exactTopologyOpener)).toBe(true);
      expect(await page.getByRole("button",{name:taskNames[kind],exact:true}).isVisible()).toBe(true);
      expect(await page.getByText("Historical synthetic hold retained").isVisible()).toBe(true);
    }finally{await page.close();}
  },30000);
  it("keeps the real editor/input and dirty draft through 320↔1024 resize and currentness loss",async()=>{
    const page=await open(1024);try{await enter(page,"room");const input=page.getByRole("textbox",{name:"Room name or number"});await input.fill("Long unchanged draft — ".repeat(5));await input.evaluate(node=>{(window as unknown as {draftInput:Element}).draftInput=node;});
      for(const width of [320,1024,320]){await page.setViewportSize({width,height:800});await settle(page);expect(await input.evaluate(node=>node===(window as unknown as {draftInput:Element}).draftInput)).toBe(true);expect(await input.inputValue()).toBe("Long unchanged draft — ".repeat(5));expect(await visibleAboveChrome(page,'[data-topology-editor] input')).toBe(true);}
      await page.evaluate(()=>{(window as unknown as {topologyHarness:{setCurrent(v:boolean):void}}).topologyHarness.setCurrent(false);});await settle(page);
      expect(await page.getByText("Physical bed details are not current").isVisible()).toBe(true);expect(await page.getByRole("button",{name:"Save room",exact:true}).isDisabled()).toBe(true);expect(await input.inputValue()).toBe("Long unchanged draft — ".repeat(5));
      expect(await page.getByText(/Current access or the exact room\/bed details/).isVisible()).toBe(true);
    }finally{await page.close();}
  },30000);
  it("clearly separates bed count from generated/custom labels and retains duplicate validation",async()=>{
    const page=await open(320);try{await enter(page,"add");expect(await page.getByText("Labels to create",{exact:true}).isVisible()).toBe(true);expect(await page.getByRole("spinbutton",{name:"Number of beds"}).inputValue()).toBe("1");
      await page.getByRole("spinbutton",{name:"Number of beds"}).fill("0");expect(await page.getByRole("spinbutton",{name:"Number of beds"}).inputValue()).toBe("1");
      await page.getByRole("spinbutton",{name:"Number of beds"}).fill("101");expect(await page.getByRole("spinbutton",{name:"Number of beds"}).inputValue()).toBe("100");
      await page.getByRole("spinbutton",{name:"Number of beds"}).fill("3");await page.getByRole("button",{name:"Customize labels",exact:true}).click();
      await page.getByRole("textbox",{name:"Bed 1",exact:true}).fill("Courtyard lower");await page.getByRole("textbox",{name:"Bed 2",exact:true}).fill("Courtyard lower");await page.getByRole("button",{name:"Add 3 beds",exact:true}).click();
      expect(await page.getByRole("alert").textContent()).toContain("used more than once");expect(await page.getByText(/automatic labels/).count()).toBe(0);
      await capture(page,"custom-labels-320");
      await page.getByRole("textbox",{name:"Bed 2",exact:true}).fill("Courtyard upper");await page.getByRole("button",{name:"Add 3 beds",exact:true}).click();await settle(page);
      expect(await page.getByText("Synthetic save confirmed").isVisible()).toBe(true);expect(await page.getByRole("region",{name:"Selected holds"}).isVisible()).toBe(true);
      expect(await page.evaluate(()=>(window as unknown as {topologyHarness:{saved():unknown}}).topologyHarness.saved())).toEqual({labels:["Courtyard lower","Courtyard upper","3"]});
    }finally{await page.close();}
  },30000);
  it.each(["conflict","unknown","pending"])("keeps draft and governing %s recovery in the focused task",async mode=>{
    const page=await open(320);try{await enter(page,"room");await page.getByRole("textbox",{name:"Room name or number"}).fill("Draft retained in recovery");
      await page.evaluate(mode=>{(window as unknown as {topologyHarness:{setMode(v:string):void}}).topologyHarness.setMode(mode);},mode);await settle(page);
      expect(await page.getByRole("textbox",{name:"Room name or number"}).inputValue()).toBe("Draft retained in recovery");expect(await page.getByRole("region",{name:"Selected holds"}).count()).toBe(0);expect(await page.getByRole("button",{name:mode==="pending"?"Saving…":"Save room",exact:true}).isDisabled()).toBe(true);
      if(mode==="conflict")expect(await page.getByRole("button",{name:"Refresh current details",exact:true}).isVisible()).toBe(true);
      if(mode==="unknown")expect(await page.getByRole("button",{name:"Retry same save",exact:true}).isVisible()).toBe(true);
      if(mode==="pending")expect(await page.getByRole("button",{name:"Cancel",exact:true}).isDisabled()).toBe(true);
      await capture(page,"recovery-"+mode+"-320");
    }finally{await page.close();}
  },30000);
  it("ordinary rerenders do not repeat entry focus or scroll after independent movement",async()=>{
    const page=await open(320);try{await enter(page,"room");const destination=page.getByRole("button",{name:"Independent destination",exact:true});await destination.focus();await settle(page);const before=await page.evaluate(()=>({scroll:scrollY,inspector:document.querySelector("#spaces-selection-inspector")!.scrollTop}));
      await page.evaluate(()=>(window as unknown as {topologyHarness:{rerender():void}}).topologyHarness.rerender());await settle(page);
      expect(await destination.evaluate(node=>node===document.activeElement)).toBe(true);expect(await page.evaluate(()=>({scroll:scrollY,inspector:document.querySelector("#spaces-selection-inspector")!.scrollTop}))).toEqual(before);
    }finally{await page.close();}
  },30000);
  it("shared Add room form and read-only composition retain their boundaries",async()=>{
    const page=await open(320);try{await page.getByRole("button",{name:"Add room",exact:true}).press("Enter");await settle(page);expect(await page.getByRole("textbox",{name:"Room name or number"}).isVisible()).toBe(true);await page.getByRole("button",{name:"Cancel",exact:true}).press("Enter");await settle(page);expect(await page.getByRole("button",{name:"Add room",exact:true}).evaluate(node=>node===document.activeElement)).toBe(true);}finally{await page.close();}
    const viewer=await open(320,"?viewer");try{expect(await viewer.getByRole("button",{name:"Edit room",exact:true}).count()).toBe(0);expect(await viewer.getByRole("button",{name:"Edit bed 104-D",exact:true}).count()).toBe(0);expect(await viewer.getByRole("region",{name:"Selling"}).isVisible()).toBe(true);}finally{await viewer.close();}
  },30000);
});
