import { warmNativeFixture } from "./support/warmNativeFixture";
import { launchNativeChromium } from "./support/nativeChromium";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mounted production form/frame/styles; synthetic controller, inventory and
// command counters. Native keyboard/geometry proof, not backend or route proof.
const fixture=`
import React,{useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter} from "react-router";
import {BlockInventoryModal} from "/src/features/inventory/BlockInventoryModal.tsx";
import {BlockReleaseForm} from "/src/features/inventory/BlockReleaseForm.tsx";
import {buildBlockTargetOptions} from "/src/features/inventory/inventoryBlocking.ts";
import {selectedBlockTargetCurrent} from "/src/features/inventory/blockEditorModel.ts";
import "/src/styles.css";
const params=new URLSearchParams(location.search);
const rooms=Array.from({length:17},(_,r)=>({propertyId:"property",roomId:"room"+r,roomName:"Dorm "+(101+r),buildingLabel:r<9?"Demo House":"Courtyard Annex",floorLabel:r<9?"1":"2",salesMode:"bedLevel",version:1,units:Array.from({length:r<7?4:3},(_,u)=>({propertyId:"property",roomId:"room"+r,inventoryUnitId:"unit"+r+"-"+u,bedId:"bed"+r+"-"+u,kind:"bed",label:(101+r)+"-"+String.fromCharCode(65+u)+" · Lower bunk beside the accessible courtyard entrance",isSellable:true,isTopologyActive:true}))}));
function Fixture(){
 const [open,setOpen]=useState(false),[session,setSession]=useState(0),[current,setCurrent]=useState(true),[mode,setMode]=useState("ready"),[membership,setMembership]=useState(false),[commands,setCommands]=useState(0),[retries,setRetries]=useState(0);
 const opener=useRef(null);const options=buildBlockTargetOptions("Synthetic training hostel",rooms.map(room=>({...room,units:membership?room.units.slice(1):room.units})));
 const releaseTarget={label:"Courtyard dorm 104",detail:"Demo House · First floor",unitCount:4,intervals:[{arrival:"2026-09-24",departure:"2026-09-26"}],reasons:["Synthetic window maintenance; keep the accessible courtyard route clear. ".repeat(5)]};
 const mutation={error:mode==="error"?new Error("Controlled uncertain result"):null,isPending:mode==="pending"};
 const editor={editor:open?{kind:params.has("release")?"release":"create",editorSession:session,target:releaseTarget}:null,options,ready:current,opener,busy:mode==="pending",createMutation:mutation,releaseMutation:mutation,releaseCanSubmit:current&&!membership,releaseTargetCurrent:!membership,release:()=>setCommands(n=>n+1),retryRelease:()=>setRetries(n=>n+1),
 createCanSubmit:selected=>current&&selectedBlockTargetCurrent(options,selected),close:()=>{if(mode!=="pending")setOpen(false);},create:()=>setCommands(n=>n+1),retryCreate:()=>setRetries(n=>n+1),editCreateDraft:()=>setMode("ready"),refresh:async()=>{}};
 window.blockHarness={setCurrent,setMode,setMembership,commands:()=>commands,retries:()=>retries,rerender:()=>setRetries(n=>n+1),unmount:()=>setOpen(false)};
 return <><header className="app-topbar fixed inset-x-0 top-0 z-30 h-16 border-b bg-base-100 p-4">Synthetic BunkFy station</header><main className="mx-auto max-w-4xl px-4 pb-24 pt-20"><h1 className="text-2xl font-semibold">Spaces / All holds</h1><p className="my-3">Synthetic training hostel · 17 rooms</p><section data-blocks-region className="rounded-lg border border-base-300 bg-base-100"><header className="border-b border-base-300 p-4"><h2>All holds</h2><p className="my-3 text-sm">All spaces in this property · dates, scope, reason and history.</p><button className="btn btn-primary btn-sm" disabled={open} onClick={event=>{opener.current=event.currentTarget;setSession(n=>n+1);setOpen(true);}}>Add block</button></header>
 <style>{'@media(min-width:1024px){[data-test-scrollport="true"]{height:380px;overflow-y:auto;scroll-padding-block:16px}}'}</style><div data-test-scrollport={params.has("clipped")?"true":"false"}>{params.has("release")?<BlockReleaseForm editor={editor}/>:<BlockInventoryModal inline editor={editor} initialRange={{arrival:"2026-09-24",departure:"2026-09-26"}} initialTargetId={params.get("target")??undefined} sources={current?[]:[{label:"Inventory",state:"stale",isFetching:false,refetch:async()=>{}}]}/>}</div></section><button className="btn my-4">Independent destination</button></main><nav aria-label="Mobile navigation" className="fixed inset-x-0 bottom-0 z-30 h-16 border-t bg-base-100 p-4 lg:hidden">Today · Calendar · Spaces</nav></>;
}
createRoot(document.getElementById("root")).render(<MemoryRouter><Fixture/></MemoryRouter>);
`;
let server:ViteDevServer,browser:Browser,origin:string;const runtimeErrors:string[]=[];
beforeAll(async()=>{
 const entry=normalizePath(process.cwd()+"/__block_inventory_fixture.tsx");
 server=await createServer({configFile:false,root:process.cwd(),cacheDir:mkdtempSync(join(tmpdir(),"bunkfy-block-layout-vite-")),logLevel:"error",optimizeDeps:{noDiscovery:true,include:["react","react/jsx-runtime","react/jsx-dev-runtime","react-dom","react-dom/client","react-router","@tanstack/react-query","lucide-react","@radix-ui/react-popover","@radix-ui/react-select","@daypicker/react"]},plugins:[react(),tailwindcss(),{name:"block-inventory-layout-fixture",resolveId:id=>id==="/__block_inventory_fixture.tsx"||id===entry?entry:undefined,load:id=>id===entry?fixture:undefined,configureServer(vite){vite.middlewares.use((req,res,next)=>{if(!req.url?.startsWith("/__block-inventory"))return next();void vite.transformIndexHtml(req.url,'<!doctype html><html><body><div id="root"></div><script type="module" src="/__block_inventory_fixture.tsx"></script></body></html>').then(html=>{res.setHeader("Content-Type","text/html");res.end(html);});});}}],server:{host:"127.0.0.1",port:0}});
 await server.listen();origin=server.resolvedUrls!.local[0];browser=await launchNativeChromium();
  await warmNativeFixture(browser, new URL("/__block-inventory?target=unit%3Aunit3-3", origin).href);
},60000);
afterAll(async()=>{await browser?.close();await server?.close();expect(runtimeErrors).toEqual([]);});
async function settle(page:Page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function capture(page:Page,name:string){if(process.env.BLOCK_LAYOUT_EVIDENCE){mkdirSync(process.env.BLOCK_LAYOUT_EVIDENCE,{recursive:true});await page.screenshot({path:join(process.env.BLOCK_LAYOUT_EVIDENCE,name+".png")});}}
async function open(width=320,height=800,target="",extra=""){
 const page=await browser.newPage({viewport:{width,height}});page.setDefaultTimeout(5000);const startup:string[]=[];
 page.on("pageerror",error=>runtimeErrors.push(error.message));page.on("console",message=>{if(message.type()==="error")runtimeErrors.push(message.text());});page.on("requestfailed",r=>startup.push(r.failure()?.errorText+" "+r.url()));
 await page.goto(origin+"__block-inventory"+"?"+new URLSearchParams({...(target?{target}:{}),...Object.fromEntries(new URLSearchParams(extra))}));
 try{await page.getByRole("heading",{name:"Spaces / All holds",exact:true}).waitFor();}catch(error){await page.close();throw new Error("Block fixture startup failed: "+JSON.stringify(startup),{cause:error});}
 const opener=page.getByRole("button",{name:"Add block",exact:true});await opener.focus();await opener.evaluate(node=>{(window as unknown as {blockOpener:Element}).blockOpener=node;});await page.keyboard.press("Enter");await settle(page);return page;
}
async function focusGeometry(page:Page){return page.evaluate(()=>{const node=document.activeElement as HTMLElement,box=node.getBoundingClientRect(),nav=document.querySelector('nav[aria-label="Mobile navigation"]')!,bottom=nav.getClientRects().length?nav.getBoundingClientRect().top:innerHeight;const hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);return{top:box.top,bottom:box.bottom,safe:box.top>=64&&box.bottom<=bottom,hit:hit===node||node.contains(hit),tag:node.tagName};});}
async function chooseRoom(page:Page){const search=page.getByRole("searchbox",{name:"Search room",exact:true});await search.fill("Dorm 104");await page.keyboard.press("Tab");await settle(page);expect((await focusGeometry(page)).tag).toBe("INPUT");await page.keyboard.press("Space");await settle(page);}
async function commit(page:Page){
 const use=page.getByRole("button",{name:"Use selected target",exact:true});
 // From the focused search/radio, traverse the actual native tab order.
 for(let step=0;step<3&&!await use.evaluate(node=>node===document.activeElement);step++){await page.keyboard.press("Tab");await settle(page);}
 expect(await use.evaluate(node=>node===document.activeElement)).toBe(true);expect((await focusGeometry(page)).safe).toBe(true);
 await page.keyboard.press("Shift+Tab");await settle(page);expect(await page.getByRole("radio",{checked:true}).evaluate(node=>node===document.activeElement)).toBe(true);expect((await focusGeometry(page)).safe).toBe(true);
 await page.keyboard.press("Tab");await settle(page);expect(await use.evaluate(node=>node===document.activeElement)).toBe(true);expect((await focusGeometry(page)).safe).toBe(true);
 await page.keyboard.press("Enter");await settle(page);expect(await page.locator('[data-selected-block-target] h4').evaluate(node=>node===document.activeElement)).toBe(true);expect((await focusGeometry(page)).safe).toBe(true);expect((await focusGeometry(page)).hit).toBe(true);
}
async function noCommands(page:Page){expect(await page.evaluate(()=>(window as unknown as {blockHarness:{commands():number}}).blockHarness.commands())).toBe(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}

describe("C04 inventory block target disclosure — native controlled fixture",()=>{
 it.each([{width:1024,height:800},{width:1440,height:640}])("R2 wide focused Reason stays visible through320×$height and both wide sizes",async({width,height})=>{
  const page=await open(width,900,"unit:unit3-3");try{const reason=page.getByRole("textbox",{name:"Reason",exact:true}),draft="Long exact draft for window maintenance — ".repeat(10);await reason.fill(draft);await reason.evaluate(node=>{const input=node as HTMLTextAreaElement;input.setSelectionRange(7,19);(window as unknown as {resizeReason:Element}).resizeReason=node;});await settle(page);expect((await focusGeometry(page)).safe&&(await focusGeometry(page)).hit).toBe(true);await capture(page,"r2-before-"+width+"-"+height);
   await page.setViewportSize({width:320,height});await settle(page);await capture(page,"r2-after-320-"+height);expect((await focusGeometry(page)).safe&&(await focusGeometry(page)).hit).toBe(true);
   for(const next of [1024,1440]){await page.setViewportSize({width:next,height:900});await settle(page);expect((await focusGeometry(page)).safe&&(await focusGeometry(page)).hit).toBe(true);}
   expect(await reason.evaluate(node=>node===(window as unknown as {resizeReason:Element}).resizeReason&&node===document.activeElement)).toBe(true);expect(await reason.inputValue()).toBe(draft);expect(await reason.evaluate(node=>[(node as HTMLTextAreaElement).selectionStart,(node as HTMLTextAreaElement).selectionEnd])).toEqual([7,19]);await noCommands(page);
  }finally{await page.close();}
 },30000);
 it("R2 reuses the native clipped wide scrollport without changing focus or draft",async()=>{
  const page=await open(1024,900,"unit:unit3-3","clipped=1");try{const reason=page.getByRole("textbox",{name:"Reason",exact:true});await reason.fill("Keep the same clipped-editor draft");await settle(page);expect((await focusGeometry(page)).hit).toBe(true);
   for(const size of [{width:320,height:640},{width:1440,height:900},{width:1024,height:900}]){await page.setViewportSize(size);await settle(page);expect((await focusGeometry(page)).safe&&(await focusGeometry(page)).hit).toBe(true);expect(await reason.evaluate(node=>node===document.activeElement)).toBe(true);expect(await reason.inputValue()).toBe("Keep the same clipped-editor draft");}await noCommands(page);
  }finally{await page.close();}
 },30000);
 it.each([640,800])("R2 real release frame preserves confirmation, visible Cancel and exact opener across resize to%i",async height=>{
  const page=await open(1024,900,"","release=1&clipped=1");try{expect(await page.getByRole("heading",{name:"Release Courtyard dorm 104?",exact:true}).isVisible()).toBe(true);const cancel=page.getByRole("button",{name:"Cancel",exact:true});await cancel.focus();await settle(page);expect((await focusGeometry(page)).safe&&(await focusGeometry(page)).hit).toBe(true);
   for(const size of [{width:320,height},{width:1440,height:900},{width:320,height}]){await page.setViewportSize(size);await settle(page);expect(await cancel.evaluate(node=>node===document.activeElement)).toBe(true);expect((await focusGeometry(page)).safe&&(await focusGeometry(page)).hit).toBe(true);}await capture(page,"r2-release-cancel-320-"+height);await page.keyboard.press("Enter");await settle(page);expect(await page.evaluate(()=>document.activeElement===(window as unknown as {blockOpener:Element}).blockOpener)).toBe(true);await noCommands(page);
  }finally{await page.close();}
 },30000);
 it.each(["stale","membership","pending","error"])("R2 release retains %s guards and confirmation through reflow without commands",async mode=>{
  const page=await open(1024,900,"","release=1&clipped=1");try{
   await page.evaluate(mode=>{const harness=(window as unknown as {blockHarness:{setCurrent(v:boolean):void;setMembership(v:boolean):void;setMode(v:string):void}}).blockHarness;if(mode==="stale")harness.setCurrent(false);else if(mode==="membership")harness.setMembership(true);else harness.setMode(mode);},mode);await settle(page);
   for(const width of [320,1440]){await page.setViewportSize({width,height:800});await settle(page);expect(await page.getByRole("button",{name:"Confirm release",exact:true}).isDisabled()).toBe(true);expect(await page.getByText(/Synthetic window maintenance;/).textContent()).toContain("courtyard route clear");}
   const cancel=page.getByRole("button",{name:"Cancel",exact:true});expect(await cancel.isDisabled()).toBe(mode==="pending");
   if(mode==="stale")expect(await page.getByText(/Current access and inventory are required/).count()).toBe(1);
   if(mode==="membership")expect(await page.getByText(/This exact group changed/).count()).toBe(1);
   if(mode==="error")expect(await page.getByText(/Try again repeats the same release/).count()).toBe(1);
   if(mode!=="pending"){await cancel.focus();await page.keyboard.press("Enter");await settle(page);expect(await page.evaluate(()=>document.activeElement===(window as unknown as {blockOpener:Element}).blockOpener)).toBe(true);}await noCommands(page);
  }finally{await page.close();}
 },30000);
 it("R2 neither ordinary rerenders nor outside-owned focus cause programmatic scrolling",async()=>{
  const page=await open(1024,900,"unit:unit3-3");try{const reason=page.getByRole("textbox",{name:"Reason",exact:true});await reason.fill("Do not move this draft");await settle(page);await page.evaluate(()=>{const original=HTMLElement.prototype.scrollIntoView;(window as unknown as {blockScrollCalls:number}).blockScrollCalls=0;HTMLElement.prototype.scrollIntoView=function(...args){(window as unknown as {blockScrollCalls:number}).blockScrollCalls++;return original.apply(this,args);};});
   await page.evaluate(()=>(window as unknown as {blockHarness:{rerender():void}}).blockHarness.rerender());await settle(page);expect(await page.evaluate(()=>(window as unknown as {blockScrollCalls:number}).blockScrollCalls)).toBe(0);expect(await reason.evaluate(node=>node===document.activeElement)).toBe(true);
   const outside=page.getByRole("button",{name:"Independent destination",exact:true});await outside.focus();await settle(page);await page.setViewportSize({width:320,height:640});await settle(page);expect(await outside.evaluate(node=>node===document.activeElement)).toBe(true);expect(await page.evaluate(()=>(window as unknown as {blockScrollCalls:number}).blockScrollCalls)).toBe(0);await noCommands(page);
  }finally{await page.close();}
 },30000);
 it.each([640,800])("native Space and arrows keep selection focus painted at320×%i",async height=>{
  const page=await open(320,height);try{const search=page.getByRole("searchbox",{name:"Search room",exact:true});expect(await search.evaluate(node=>node===document.activeElement)).toBe(true);expect(await page.getByRole("radio",{checked:true}).count()).toBe(0);await search.fill("Dorm 104");await page.keyboard.press("Tab");await settle(page);const before=await focusGeometry(page);expect(before.safe&&before.hit).toBe(true);await capture(page,"before-space-320-"+height);await page.keyboard.press("Space");await settle(page);const after=await focusGeometry(page);await capture(page,"after-space-320-"+height);expect(after.safe&&after.hit).toBe(true);expect(after.top).toBe(before.top);expect(await search.isVisible()).toBe(true);expect(await page.locator('[data-selected-block-target]').isVisible()).toBe(false);
   await search.fill("Dorm 10");await page.keyboard.press("Tab");await page.keyboard.press("ArrowDown");await settle(page);expect((await focusGeometry(page)).safe).toBe(true);expect(await page.getByRole("radio",{checked:true}).evaluate(node=>node===document.activeElement)).toBe(true);await commit(page);await noCommands(page);
  }finally{await page.close();}
 },30000);
 it.each([320,1024,1440])("global selection becomes compact only on Use; preserves draft and exact Cancel at%i",async width=>{
  const page=await open(width);try{await chooseRoom(page);await commit(page);expect(await page.getByRole("searchbox").count()).toBe(0);expect(await page.getByText("4 units will be blocked.",{exact:true}).isVisible()).toBe(true);await capture(page,"global-summary-"+width);
   const reason=page.getByRole("textbox",{name:"Reason",exact:true});await reason.fill("Synthetic window maintenance — keep courtyard access clear. ".repeat(4));const from=page.getByRole("button",{name:/^From:/});const originalDate=await from.getAttribute("aria-label");await from.press("Enter");await page.keyboard.press("Escape");await settle(page);expect(await from.evaluate(node=>node===document.activeElement)).toBe(true);
   await page.getByRole("button",{name:"Change target",exact:true}).press("Enter");await settle(page);expect(await page.getByRole("searchbox",{name:"Search room"}).inputValue()).toBe("Dorm 104");expect(await page.getByRole("radio",{checked:true}).count()).toBe(1);expect(await reason.inputValue()).toContain("Synthetic window maintenance");expect(await from.getAttribute("aria-label")).toBe(originalDate);
   await commit(page);await page.getByRole("button",{name:"Cancel",exact:true}).focus();await page.keyboard.press("Enter");await settle(page);expect(await page.evaluate(()=>document.activeElement===(window as unknown as {blockOpener:Element}).blockOpener)).toBe(true);await noCommands(page);
  }finally{await page.close();}
 },30000);
 it.each(["room:room3","unit:unit3-3"])("contextual %s stays compact; change and resize keep the same form fields",async target=>{
  const page=await open(320,800,target);try{expect(await page.getByRole("searchbox").count()).toBe(0);expect(await page.locator('[data-selected-block-target] h4').evaluate(node=>node===document.activeElement)).toBe(true);const reason=page.getByRole("textbox",{name:"Reason",exact:true});await reason.fill("Keep this exact draft");await reason.evaluate(node=>{(window as unknown as {blockReason:Element}).blockReason=node;});
   for(const width of [1024,320]){await page.setViewportSize({width,height:800});await settle(page);expect(await reason.inputValue()).toBe("Keep this exact draft");expect(await reason.evaluate(node=>node===(window as unknown as {blockReason:Element}).blockReason)).toBe(true);}
   await page.getByRole("button",{name:"Change target",exact:true}).press("Enter");await settle(page);expect(await page.getByRole("radio",{checked:true}).count()).toBe(1);await commit(page);await capture(page,"contextual-"+target.replace(":","-")+"-320");await noCommands(page);
  }finally{await page.close();}
 },30000);
 it("retains all five scopes with explicit confirmation and truthful affected counts",async()=>{
  const page=await open(320,640);try{for(const label of ["Property","Building","Floor","Room","Bed / unit"]){if(await page.getByRole("button",{name:"Change target",exact:true}).count())await page.getByRole("button",{name:"Change target",exact:true}).press("Enter");await page.getByRole("button",{name:label,exact:true}).press("Enter");const radio=page.getByRole("radio").first();await radio.focus();await page.keyboard.press("Space");await settle(page);expect((await focusGeometry(page)).safe).toBe(true);const count=await radio.locator("..").locator("span.shrink-0").textContent();await commit(page);expect(await page.locator('[data-selected-block-target]').textContent()).toContain(count?.trim()+((count?.trim()==="1")?" unit will be blocked.":" units will be blocked."));await noCommands(page);}
  }finally{await page.close();}
 },30000);
 it("withholds hidden, changed-membership and stale targets without discarding dates or reason",async()=>{
  const page=await open();try{await chooseRoom(page);const use=page.getByRole("button",{name:"Use selected target",exact:true}),search=page.getByRole("searchbox",{name:"Search room",exact:true}),reason=page.getByRole("textbox",{name:"Reason",exact:true});await reason.fill("Retained reason");await search.fill("No such room");expect(await use.isDisabled()).toBe(true);expect(await page.getByText("No matching inventory. Change the search or scope.").isVisible()).toBe(true);await search.fill("Dorm 104");expect(await use.isEnabled()).toBe(true);
   await page.evaluate(()=>(window as unknown as {blockHarness:{setMembership(v:boolean):void}}).blockHarness.setMembership(true));await settle(page);expect(await use.isDisabled()).toBe(true);expect(await page.getByRole("alert").textContent()).toContain("changed or is no longer eligible");await page.getByRole("radio").first().focus();await page.keyboard.press("Space");await settle(page);expect(await use.isEnabled()).toBe(true);
   await page.evaluate(()=>(window as unknown as {blockHarness:{setCurrent(v:boolean):void}}).blockHarness.setCurrent(false));await settle(page);expect(await use.isDisabled()).toBe(true);expect(await page.getByRole("button",{name:/^Block \d+ units$/}).isDisabled()).toBe(true);expect(await reason.inputValue()).toBe("Retained reason");await noCommands(page);
  }finally{await page.close();}
 },30000);
 it.each(["pending","error"])("%s keeps draft and locks disclosure while preserving recovery",async mode=>{
  const page=await open(320,800,"room:room3");try{await page.getByRole("textbox",{name:"Reason",exact:true}).fill("Retained failed draft");await page.evaluate(mode=>(window as unknown as {blockHarness:{setMode(v:string):void}}).blockHarness.setMode(mode),mode);await settle(page);expect(await page.getByRole("button",{name:"Change target",exact:true}).isDisabled()).toBe(true);expect(await page.getByRole("textbox",{name:"Reason",exact:true}).inputValue()).toBe("Retained failed draft");if(mode==="pending")expect(await page.getByRole("button",{name:"Cancel",exact:true}).isDisabled()).toBe(true);else{expect(await page.getByRole("button",{name:"Edit draft",exact:true}).isVisible()).toBe(true);expect(await page.getByText(/Try again repeats this exact attempt/).isVisible()).toBe(true);}await noCommands(page);
  }finally{await page.close();}
 },30000);
});
