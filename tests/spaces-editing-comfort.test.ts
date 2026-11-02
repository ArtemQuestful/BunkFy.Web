import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpacesPage } from "../src/features/spaces/SpacesPage";
import { permissions } from "../src/app/permissions";
import type { Property } from "../src/api/types";
import type { TopologyEditorTarget } from "../src/features/properties/topologyEditorModel";
import { RouteNavigationLeaseProvider } from "../src/app/routeNavigationLease";

// Real Spaces page, workspace, forms and controller calculations; only session,
// query transport and one explicit engaged-editor seed are doubled. SSR verifies
// composition/currentness contracts, not mounted focus, CSS pixels or API writes.
const state = vi.hoisted(() => ({
  grants: new Set<string>(), permissionFetching: false, roomMode: "current",
  inventoryMode: "current", blockMode: "current", propertyStatus: "active",
  queries: [] as { key: unknown[]; enabled: boolean }[],
  target: null as TopologyEditorTarget | null, pending: false,
  heldSearch: "", pausedExpanded: true,
  draft: { current: null as unknown },
}));
const id = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const propertyId = id(1), roomId = id(2), bedId = id(3), unitId = id(4);
const range = { arrival: "2026-09-07", departure: "2026-09-09" };
const physicalRoom = { propertyId, roomId, name: "Dorm 104 — quiet courtyard", buildingLabel: "Demo House", floorLabel: "First floor", status: "active" as const, version: 1 };
const bed = { propertyId, roomId, bedId, label: "104-D long exact label", status: "active", version: 1 };
const unit = { propertyId, roomId, bedId, inventoryUnitId: unitId, kind: "bed", label: bed.label, isSellable: true, isTopologyActive: true };
const inventory = { propertyId, roomId, roomName: physicalRoom.name, buildingLabel: physicalRoom.buildingLabel, floorLabel: physicalRoom.floorLabel, salesMode: "bedLevel", version: 1,
  units: [unit, { ...unit, bedId: null, inventoryUnitId: id(5), kind: "room", label: "Dorm 104", isSellable: false }] };
const property = () => ({ propertyId, name: "Synthetic comfort property", code: "COMFORT", timeZoneId: "Europe/London", canonicalTimeZoneId: "Europe/London", timeZoneStatus: "valid", status: state.propertyStatus, processingStatus: "enabled", version: 1 });
const block = { propertyId, inventoryUnitId: unitId, blockId: id(6), blockGroupId: id(7), ...range, reason: "Exact selected hold reason", status: "active" };
const foreign = { ...block, blockId: id(8), blockGroupId: id(9), inventoryUnitId: id(10), reason: "Different space hold reason" };
vi.mock("../src/app/session", () => ({ useSession: () => ({
  request: vi.fn(), session: { tenantId: id(20), subjectId: id(21), sessionId: id(22), username: "synthetic", accessToken: "not-a-token" },
}) }));
vi.mock("../src/app/workspace", () => ({ useWorkspace: () => ({
  selectedPropertyId: propertyId, selectedProperty: property(), properties: [property()],
  propertiesLoaded: true, propertiesLoading: false, propertiesFetching: false, propertiesError: null,
  setSelectedPropertyId: vi.fn(), refetchProperties: vi.fn(),
}) }));
vi.mock("../src/app/permissions", async (load) => ({
  ...await load<typeof import("../src/app/permissions")>(),
  usePermissions: () => ({ allows: (permission: string) => state.grants.has(permission),
    hasData: true, isLoading: false, isFetching: state.permissionFetching, error: null, refetch: vi.fn() }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), cancelQueries: vi.fn(), getQueryCache: () => ({ subscribe: () => () => {}, findAll: () => [] }) }),
  useMutation: () => ({ isPending: state.pending, error: null, data: undefined, mutate: vi.fn(), reset: vi.fn() }),
  useQuery: ({ queryKey, enabled }: { queryKey: unknown[]; enabled: boolean }) => {
    state.queries.push({ key: queryKey, enabled: Boolean(enabled) });
    const key = queryKey[0], mode = key === "rooms" || key === "beds" ? state.roomMode : key === "blocks" ? state.blockMode : state.inventoryMode;
    let data: unknown;
    if (enabled && mode !== "missing" && mode !== "loading") {
      if (key === "rooms") data = { rooms: [physicalRoom] };
      if (key === "beds") data = { beds: [bed] };
      if (key === "inventory-rooms") data = { rooms: [inventory] };
      if (key === "availability") data = { propertyId, ...range, units: [{ unit, isAvailable: false, activeBlockIds: [block.blockId], activeAllocationIds: [] }] };
      if (key === "blocks") data = { blocks: [block, foreign] };
      if (key === "property-processing") data = { propertyId, configuredStatus: "enabled", effectiveStatus: state.propertyStatus === "retired" ? "suspended" : "enabled", reasonCode: state.propertyStatus === "retired" ? "Properties.PropertyRetired" : null, governancePolicy: null, propertyVersion: 1 };
      if (key === "country-policies") data = { items: [] };
    }
    return { data, error: mode === "stale" || mode === "missing" ? new Error("Controlled read failure") : null,
      isLoading: enabled && mode === "loading", isFetching: mode === "fetching" || enabled && mode === "loading", dataUpdatedAt: 1, refetch: vi.fn() };
  },
}));
vi.mock("../src/features/properties/useTopologyEditor", async (load) => {
  const actual = await load<typeof import("../src/features/properties/useTopologyEditor")>();
  return { ...actual, useTopologyEditor: (input: Parameters<typeof actual.useTopologyEditor>[0]) => {
    const editor = actual.useTopologyEditor(input);
    return state.target ? { ...editor, target: state.target, busy: state.pending, formDraft: state.draft } : editor;
  } };
});
vi.mock("../src/features/spaces/useSpacesNavigationGuard", async (load) => {
  const actual = await load<typeof import("../src/features/spaces/useSpacesNavigationGuard")>();
  return { ...actual, useSpacesNavigationGuard: (...args: Parameters<typeof actual.useSpacesNavigationGuard>) => {
    const navigation = actual.useSpacesNavigationGuard(...args);
    return state.heldSearch ? { ...navigation, params: new URLSearchParams(state.heldSearch), engaged: true,
      paused: true, expanded: state.pausedExpanded, pending: state.pending, ownerLabel: "104-D long exact label" } : navigation;
  } };
});
const route = (extra = "") => "/spaces?section=layout&property=" + propertyId + "&room=" + roomId + "&bed=" + bedId + "&unit=" + unitId + "&arrival=" + range.arrival + "&departure=" + range.departure + extra;
const render = (url = route()) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] }, createElement(RouteNavigationLeaseProvider, { children: createElement(SpacesPage) })));
const button = (html: string, text: string) => (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).find((tag) => tag.replace(/<[^>]*>/g, "").trim() === text);

beforeEach(() => {
  state.grants = new Set(Object.values(permissions)); state.permissionFetching = false;
  state.roomMode = state.inventoryMode = state.blockMode = "current"; state.propertyStatus = "active";
  state.queries = []; state.target = null; state.pending = false; state.draft = { current: null };
  state.heldSearch = ""; state.pausedExpanded = true;
});
describe("Spaces editing comfort — rendered composition, not browser acceptance", () => {
  it.each(['room', 'bed', 'whole-room'])('R2: %s has one routine Holds section before Selling and Retirement', target => {
    const url = target === 'room' ? route().replace('&bed=' + bedId, '').replace('&unit=' + unitId, '')
      : target === 'whole-room' ? route().replace('&bed=' + bedId, '').replace('unit=' + unitId, 'unit=' + id(5)) : route();
    const html = render(url);
    const inspector = html.slice(html.indexOf('id="spaces-selection-inspector"'));
    expect(html.match(/id="spaces-blocks-heading"/g)).toHaveLength(1);
    const holds = inspector.indexOf('id="spaces-blocks-heading"');
    expect(holds).toBeGreaterThan(0);
    expect(holds).toBeLessThan(inspector.indexOf('aria-label="Selling"'));
    expect(holds).toBeLessThan(inspector.indexOf('aria-label="Retirement actions"'));
  });
  it('UR038: routine selling facts and direct edit are visible; retirement is separate and secondary',()=>{
    const html=render();const inspector=html.slice(html.indexOf('id="spaces-selection-inspector"'));
    expect(inspector).toContain('aria-label="Selling"');
    expect(inspector).toContain('Whole room not offered separately');
    expect(inspector).toContain('Whole-room inventory is separate from the physical bed count.');
    expect(inspector).not.toContain('<details');expect(inspector).not.toContain('<summary');
    expect(button(inspector,'Edit selling setup')).toBeDefined();
    expect(button(inspector,'Inspect whole-room option')).toBeDefined();
    expect(inspector).toContain('aria-label="Retirement actions"');
    expect(inspector.indexOf('aria-label="Retirement actions"')).toBeGreaterThan(inspector.indexOf('aria-label="Selling"'));
    expect(button(inspector,'Retire room')).toContain('btn-ghost');
    expect(button(inspector,'Retire bed')).toContain('aria-label="Retire bed 104-D long exact label"');
  });
  it('UR038: denied selling and retirement authority never exposes their actions',()=>{
    state.grants.delete(permissions.inventoryConfigure);state.grants.delete(permissions.inventoryRetire);
    const html=render();expect(button(html,'Edit selling setup')).toBeUndefined();
    expect(button(html,'Retire room')).toBeUndefined();expect(button(html,'Retire bed')).toBeUndefined();
    expect(html).not.toContain('aria-label="Retirement actions"');
  });
  it('UR038: each opener retains its own source-currentness contract',()=>{
    state.inventoryMode='stale';const html=render();
    expect(html).toContain('Selling setup unconfirmed');
    expect(button(html,'Edit selling setup')).toContain('disabled');
    // Retirement opens its own fresh impact read. The existing opener requires
    // current physical topology, not an unrelated sellability read; it sends
    // no command until the separate retirement context/confirmation allows it.
    expect(button(html,'Retire room')).not.toContain('disabled');
    state.roomMode='stale';const topologyStale=render();
    expect(button(topologyStale,'Retire room')).toContain('disabled');
    expect(button(topologyStale,'Retire bed')).toContain('disabled');
  });
  it("uses one compact title/action header and one search/night-range toolbar", () => {
    const html = render();
    const header = html.slice(html.indexOf('<header class="spaces-room-heading'), html.indexOf("</header>"));
    expect(header).toContain("Property settings"); expect(header).toContain("All holds"); expect(header).toContain("Add room");
    expect(html.match(/spaces-room-toolbar/g)).toHaveLength(1);
    expect(html.match(/type="search"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Night availability dates"');
    const inspector = html.slice(html.indexOf('id="spaces-selection-inspector"'));
    expect(inspector.match(/data-inspector-heading/g)).toHaveLength(1);
    expect(inspector).not.toContain(">Room</dt>");
    expect(inspector.match(/Demo House · First floor/g)).toHaveLength(1);
  });
  it.each(["room", "bed"] as const)("focuses the %s task while retaining hidden read siblings and its exact opener", kind => {
    const before = render();
    state.target = kind === "room" ? { kind, property: property() as Property, room: physicalRoom }
      : { kind, property: property() as Property, room: physicalRoom, bed: bed as never };
    const editing = render();
    expect(editing.match(/data-topology-editor=/g)).toHaveLength(1);
    expect(editing).toContain('data-space-room-facts');
    expect(editing).toContain('data-space-bed-facts');
    expect(editing).toMatch(/<div[^>]*data-topology-read-siblings[^>]*hidden=""[^>]*inert=""/);
    expect(editing).toMatch(/data-space-room-facts[^>]*hidden=""/);
    expect(editing).toMatch(/data-space-bed-facts[^>]*hidden=""/);
    expect(button(editing, "Edit " + kind)).toContain("disabled");
    expect(editing.indexOf(button(editing, "Edit " + kind)!)).toBeLessThan(editing.indexOf("data-topology-editor"));
    expect(button(editing, "Save " + kind)).toBeDefined(); expect(button(editing, "Cancel")).toBeDefined();
    state.target = null;
    expect(render()).toBe(before);
  });
  it("renders the held bed and its query keys while naming a different raw destination", () => {
    state.heldSearch = route().split("?")[1];
    state.target = { kind: "bed", property: property() as Property, room: physicalRoom, bed: bed as never };
    const html = render(route().replace("section=layout", "section=blocks").replace("room=" + roomId, "room=" + id(50)));
    expect(html).toContain("Navigation to All holds is paused while you edit 104-D long exact label.");
    expect(html).toContain('data-space-selection="bed:' + bedId + '"');
    expect(state.queries.filter((q) => q.enabled && q.key[0] === "beds").map((q) => q.key)).toEqual([["beds", propertyId, roomId]]);
    expect(html).toContain("Navigation paused"); expect(button(html, "Stay editing")).toBeDefined();
    expect(button(html, "Discard and continue")).not.toContain("disabled");
  });
  it("disables pending Discard and keeps a compact honest indication after Stay", () => {
    state.heldSearch = route().split("?")[1]; state.pending = true;
    expect(button(render(), "Discard and continue")).toContain("disabled");
    state.pausedExpanded = false; const collapsed = render();
    expect(collapsed).toContain('aria-label="Paused Spaces navigation"');
    expect(button(collapsed, "Review paused navigation")).toBeDefined();
    expect(button(collapsed, "Discard and continue")).toBeUndefined();
    expect(collapsed).not.toContain('role="dialog"');
  });
  it("does not turn held coordinates into permission or current-source authority", () => {
    state.heldSearch = route().split("?")[1]; state.permissionFetching = true;
    const unconfirmed = render(); expect(button(unconfirmed, "Edit bed")).toBeUndefined();
    expect(state.queries.filter((q) => q.enabled)).toHaveLength(0);
    state.permissionFetching = false; state.grants.delete(permissions.propertiesRead);
    const denied = render(); expect(denied).toContain("Spaces access is not assigned"); expect(button(denied, "Edit bed")).toBeUndefined();
  });
  it("renders the held retirement origin rather than the browser's queued origin", () => {
    const heldReturn = "/spaces?" + new URLSearchParams({ property: propertyId, section: "property", retire: "property" });
    const rawReturn = "/spaces?" + new URLSearchParams({ property: propertyId, room: roomId, retire: "room" });
    state.heldSearch = route().split("?")[1] + "&propertyRetirementReturn=" + encodeURIComponent(heldReturn);
    const html = render(route("&retirementReturn=" + encodeURIComponent(rawReturn)));
    expect(html).toContain('href="' + heldReturn.replaceAll("&", "&amp;") + '"');
    expect(html).not.toContain('href="' + rawReturn.replaceAll("&", "&amp;") + '"');
  });
  it("puts exact target in one stable target-first workspace with full ordinary facts and inline Edit", () => {
    const html = render();
    expect(html).toContain('data-spaces-view="selection"');
    expect(html.match(/id="spaces-selection-inspector"/g)).toHaveLength(1);
    expect(html).toContain("Back to rooms &amp; beds");
    expect(html).toContain('aria-label="Room facts"');
    expect(html).toContain("Dorm 104 — quiet courtyard");
    expect(html).toContain("104-D long exact label");
    expect(html.indexOf('aria-label="Room facts"')).toBeLessThan(html.indexOf('aria-label="Selling"'));
    expect(button(html, "Edit room")).toBeDefined(); expect(button(html, "Edit bed")).toBeDefined();
    expect(html).not.toContain("Room setup &amp; selling");
    expect(html).not.toContain('role="grid"');
  });
  it("keeps a filtered selection anchored instead of silently selecting another row", () => {
    const html = render(route("&q=No+matching+room"));
    expect(html).toContain("is outside this search. Your selection is kept.");
    expect(html).toContain("Open selected 104-D long exact label");
    expect(html).toContain("No matching rooms or beds");
    expect(html).toContain('data-space-selection="bed:' + bedId + '"');
    expect(html.match(/id="spaces-selection-inspector"/g)).toHaveLength(1);
  });
  it("explains a missing exact target without substituting the loaded room", () => {
    const html = render(route().replace("room=" + roomId, "room=" + id(40)));
    expect(html).toContain("Requested room changed or is unavailable");
    expect(html).toContain("no other room has been substituted");
    expect(html).toContain('data-spaces-view="selection"');
    expect(button(html, "Edit bed")).toBeUndefined();
  });
  it.each([false, true])("MAIN-002: describes denied inventory as access, not pending, and restores the exact target (bed coordinate: %s)", withBed => {
    const requested = route("&history=all&blockGroup=" + block.blockGroupId).replace("&room=" + roomId, "");
    const exact = withBed ? requested : requested.replace("&bed=" + bedId, "");
    const before = render(exact);
    state.queries = [];
    state.grants.delete(permissions.inventoryRead);
    const denied = render(exact);
    const inspector = denied.slice(denied.indexOf('id="spaces-selection-inspector"'));
    expect(inspector).toContain("Inventory access is not assigned");
    expect(inspector).toContain("This requested unit cannot be confirmed with your current inventory access.");
    expect(inspector).toContain("The exact link is kept; no substitute has been selected.");
    expect(inspector).not.toContain("Confirming requested");
    expect(inspector).not.toContain("animate-spin");
    expect(inspector).not.toContain('aria-label="Room facts"');
    for (const action of ["Try again", "Edit room", "Edit bed", "Add block", "Release"]) expect(button(inspector, action)).toBeUndefined();
    expect(button(denied, "Back to rooms &amp; beds")).toBeDefined();
    expect(button(denied, "Back to rooms &amp; beds")).not.toContain("disabled");
    expect(state.queries.some(q => q.enabled && ["inventory-rooms", "availability", "blocks"].includes(String(q.key[0])))).toBe(false);
    state.grants.add(permissions.inventoryRead);
    state.queries = [];
    const recovered = render(exact);
    expect(recovered).toBe(before);
    expect(recovered).toContain('data-space-selection="bed:' + bedId + '"');
    expect(recovered).toContain("Exact selected hold reason");
    expect(recovered).not.toContain("Different space hold reason");
    expect(state.queries.filter(q => q.enabled && q.key[0] === "beds").map(q => q.key)).toEqual([["beds", propertyId, roomId]]);
  });
  it("MAIN-002: keeps genuine initial loading distinct from a denied exact unit", () => {
    state.inventoryMode = "loading";
    const html = render(route().replace("&room=" + roomId, "").replace("&bed=" + bedId, ""));
    const inspector = html.slice(html.indexOf('id="spaces-selection-inspector"'));
    expect(inspector).toContain("Confirming requested unit");
    expect(inspector).toContain("The source needed for this exact target is not current. No substitute has been selected.");
    expect(inspector).toContain("animate-spin");
    expect(inspector).not.toContain("Inventory access is not assigned");
    expect(inspector).not.toContain('aria-label="Room facts"');
    expect(state.queries.some(q => q.enabled && q.key[0] === "inventory-rooms")).toBe(true);
  });
  it.each(["missing", "stale"])("MAIN-002: preserves %s source-error recovery without inventing an access denial", mode => {
    state.inventoryMode = mode;
    const html = render(route().replace("&room=" + roomId, "").replace("&bed=" + bedId, ""));
    expect(html).not.toContain("Inventory access is not assigned");
    expect(html).toContain(mode === "missing" ? "could not be confirmed" : "is showing its last confirmed snapshot");
    expect(button(html, "Try again")).toBeDefined();
    expect(button(html, "Add block")).toContain("disabled");
  });
  it("MAIN-002: keeps a currently missing exact unit unavailable rather than restricted or loading", () => {
    const html = render(route().replace("&room=" + roomId, "").replace("&bed=" + bedId, "").replace("unit=" + unitId, "unit=" + id(40)));
    expect(html).toContain("Requested unit changed or is unavailable");
    expect(html).not.toContain("Inventory access is not assigned");
    expect(html).not.toContain("Confirming requested unit");
    expect(button(html, "Edit bed")).toBeUndefined();
    expect(html.match(/id="spaces-blocks-heading"/g)).toHaveLength(1);
  });
  it("shows settings as a named focused surface with one visible processing panel and exact Back", () => {
    const html = render(route().replace("section=layout", "section=property"));
    expect(html).toContain("Spaces / Property settings");
    expect(html).toMatch(/<section hidden="" data-topology-region/);
    expect(button(html, "Back to 104-D long exact label")).toBeDefined();
    expect(html).toContain("Synthetic comfort property");
    expect(html).toContain("Europe / London");
    expect(state.queries.filter((q) => q.enabled && q.key[0] === "property-processing")).toHaveLength(1);
    expect(html).toContain("Property retirement");
  });
  it.each(["identity", "timezone"] as const)("keeps the %s property grant independent", (grant) => {
    state.grants.delete(grant === "identity" ? permissions.propertyTimeZonesManage : permissions.propertiesManage);
    const html = render(route().replace("section=layout", "section=property"));
    expect(Boolean(button(html, "Edit details"))).toBe(grant === "identity");
    expect(Boolean(button(html, "Change"))).toBe(grant === "timezone");
    expect(html).toContain("Europe / London"); expect(html).toContain("COMFORT");
  });
  it("keeps history readable without block-management actions and distinguishes all from selected scope", () => {
    state.grants.delete(permissions.inventoryBlocksManage);
    state.grants.delete(permissions.inventoryBlockGroupsManage);
    const selected = render(route("&history=all"));
    expect(selected).toContain("Exact selected hold reason"); expect(selected).not.toContain("Different space hold reason");
    expect(button(selected, "Add block")).toBeUndefined(); expect(button(selected, "Release")).toBeUndefined();
    const all = render(route("&history=all").replace("section=layout", "section=blocks"));
    expect(all).toContain("Spaces / All holds"); expect(all).toContain("Different space hold reason");
    expect(all.match(/id="spaces-blocks-heading"/g)).toHaveLength(1);
    expect(button(all, "Back to 104-D long exact label")).toBeDefined();
  });
  it("does not expose an all-holds entry or false empty history without inventory read", () => {
    state.grants.delete(permissions.inventoryRead);
    expect(button(render(), "All holds")).toBeUndefined();
    const denied = render(route().replace("section=layout", "section=blocks"));
    expect(denied).toContain("Hold history access is not assigned");
    expect(denied).not.toContain("No block history"); expect(denied).not.toContain("Different space hold reason");
    expect(state.queries.some((q) => q.enabled && ["inventory-rooms", "availability", "blocks"].includes(String(q.key[0])))).toBe(false);
  });
  it("keeps retired processing truth and does not offer property identity reactivation", () => {
    state.propertyStatus = "retired";
    const html = render(route().replace("section=layout", "section=property"));
    expect(html).toContain("Stored configuration is retained; effective processing is suspended.");
    expect(button(html, "Edit details")).toBeUndefined(); expect(button(html, "Retire property")).toBeUndefined();
  });
  it.each(["stale", "missing", "fetching"])("withholds available/empty claims under %s block or inventory evidence", (mode) => {
    state.inventoryMode = state.blockMode = mode;
    const html = render(route().replace("section=layout", "section=blocks"));
    expect(html).not.toContain("No block history");
    expect(html).toMatch(/unconfirmed|could not be loaded|not current/);
    expect(button(html, "Add block")).toContain("disabled");
  });
  it("keeps one real inline room form and locks surface switches while an editor is engaged or pending", () => {
    state.target = { kind: "room", property: property() as Property, room: physicalRoom };
    state.pending = true;
    const html = render();
    expect(html.match(/data-topology-editor=/g)).toHaveLength(1);
    expect(button(html, "Property settings")).toContain("disabled");
    expect(button(html, "All holds")).toContain("disabled");
    expect(button(html, "Back to rooms &amp; beds")).toContain("disabled");
    expect(button(html, "Cancel")).toContain("disabled");
  });
  it("rejects duplicate identity before primary queries or mutation controls", () => {
    const html = render(route("&room=" + id(40)));
    expect(html).toContain("Spaces link needs one exact context");
    expect(button(html, "Edit room")).toBeUndefined();
    expect(state.queries.filter((q) => q.enabled)).toHaveLength(0);
  });
  it("retains bulk read shape and only one selected-room physical-bed read", () => {
    render();
    expect(state.queries.filter((q) => q.enabled && q.key[0] === "rooms")).toHaveLength(1);
    expect(state.queries.filter((q) => q.enabled && q.key[0] === "beds").map((q) => q.key)).toEqual([["beds", propertyId, roomId]]);
  });
  it("loads a retained exact receipt after Back without widening the selected dates view", () => {
    const html = render(route("&blockGroup=" + block.blockGroupId));
    expect(state.queries.filter((q) => q.enabled && q.key[0] === "blocks").map((q) => q.key)).toEqual([["blocks", propertyId, "all"]]);
    expect(html).toContain("Exact selected hold reason");
    expect(html).not.toContain("Different space hold reason");
    expect(html).toContain("This selected space only.");
  });
});
