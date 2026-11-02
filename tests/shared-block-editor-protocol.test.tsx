// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualBlock, ManualBlockGroup, ManualBlockGroupMutationReceipt, ManualBlockGroupSelectionPreview, RoomInventory } from "../src/api/types";
import { useManualBlockEditor } from "../src/features/inventory/useManualBlockEditor";

const transport = vi.hoisted(() => ({ request: vi.fn<(path: string, options?: RequestInit) => Promise<unknown>>() }));
vi.mock("../src/app/session", () => ({ useSession: () => ({ request: transport.request,
  session: { tenantId: "synthetic-workspace", username: "fixture@example.test", subjectId: "synthetic-actor", sessionId: "synthetic-session", generation: "fixture" } }) }));

const propertyId = "10000000-0000-4000-8000-000000000001";
const roomId = "20000000-0000-4000-8000-000000000001";
const unitId = "30000000-0000-4000-8000-000000000001";
const groupId = "40000000-0000-4000-8000-000000000001";
const blockId = "50000000-0000-4000-8000-000000000001";
const rooms: RoomInventory[] = [{ propertyId, roomId, roomName: "Garden", buildingLabel: null, floorLabel: null, salesMode: 3, version: 1,
  units: [{ inventoryUnitId: unitId, propertyId, roomId, bedId: unitId, kind: 2, label: "A", isSellable: true, isTopologyActive: true }] }];
const definition = { arrival: "2026-11-05", departure: "2026-11-07", reason: "Maintenance" };
const block: ManualBlock = { blockId, blockGroupId: groupId, propertyId, inventoryUnitId: unitId, ...definition,
  status: 1, version: 4, createdAtUtc: "2026-11-01T12:00:00Z", releasedAtUtc: null };
const group: ManualBlockGroup = { blockGroupId: groupId, propertyId, target: { kind: 4, roomId, inventoryUnitId: null, buildingLabel: null, floorLabel: null },
  ...definition, selectionDigest: "a".repeat(64), membershipDigest: "b".repeat(64), membershipDigestVersion: 1, initialBlockCount: 1, activeBlockCount: 1,
  status: 1, version: 9, replacesGroupId: null, replacedByGroupId: null, createdAtUtc: block.createdAtUtc, updatedAtUtc: null, releasedAtUtc: null,
  createdByActorId: "fixture-actor", lastModifiedByActorId: "fixture-actor" };
const receipt: ManualBlockGroupMutationReceipt = { blockGroupId: groupId, propertyId, affectedBlockCount: 1, status: 1, version: 1,
  previousBlockGroupId: null, releasedBlockCount: 0, createdBlockCount: 1, totalBlockCount: 1, activeBlockCount: 1, alreadyReleasedBlockCount: 0,
  membershipDigest: "b".repeat(64), resultBlockGroupId: groupId, releasedNowBlockCount: 0, createdNowBlockCount: 1 };

let root: Root;
let query: QueryClient;
let editor: ReturnType<typeof useManualBlockEditor>;
let input: Parameters<typeof useManualBlockEditor>[0];
let host: HTMLDivElement;
function Harness() { editor = useManualBlockEditor(input); return <div />; }
async function render() {
  await act(async () => root.render(<QueryClientProvider client={query}><Harness /></QueryClientProvider>));
}
async function waitFor(check: () => void) { await act(async () => { await vi.waitFor(check); }); }
function preview(target: ManualBlockGroup["target"]): ManualBlockGroupSelectionPreview {
  return { propertyId, target, ...definition, status: 1, maximumAffectedBlockCount: 500, affectedBlockCount: 1, atLeastAffectedBlockCount: 1,
    exceedsMaximumAffectedBlockCount: false, selectionDigest: "a".repeat(64), membershipDigest: "b".repeat(64), membershipDigestVersion: 1,
    hasManualBlockConflict: false, hasActiveAllocationConflict: false, members: [], hasMoreMembers: false, blockGroupId: null, blockGroupVersion: null, isNoOpReplacement: false };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  input = { propertyId, propertyName: "Fixture property", rooms, blocks: [], mayManage: true, mayManageGroups: true,
    evidence: { permissionsCurrent: true, propertyCurrent: true, inventoryCurrent: true, blocksCurrent: true }, onSuccess: vi.fn() };
  transport.request.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); query.clear(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("current shared Spaces/Inventory editor against the group protocol", () => {
  it("previews without creating, then sends only the explicitly confirmed server digest and count", async () => {
    transport.request.mockImplementation(async (path, options) => path.endsWith("/preview") ? preview(JSON.parse(String(options?.body)).target) : receipt);
    await render(); await act(async () => editor.openCreate(host));
    const selected = editor.options.find(option => option.kind === "room")!;
    const payload = { ...definition, target: selected.target };
    await act(async () => editor.create(payload, selected));
    await waitFor(() => expect(editor.createReview).not.toBeNull());
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(transport.request.mock.calls[0][0]).toMatch(/\/preview$/);
    await act(async () => editor.confirmCreate(payload, selected));
    await waitFor(() => expect(editor.createMutation.isSuccess).toBe(true));
    const sent = JSON.parse(String(transport.request.mock.calls[1][1]?.body));
    expect(sent).toMatchObject({ expectedSelectionDigest: "a".repeat(64), expectedAffectedBlockCount: 1, confirmed: true });
    expect(sent.operationId).toBeTruthy();
  });

  it("keeps the draft but refuses confirmation after fields or permission evidence change", async () => {
    transport.request.mockImplementation(async (_path, options) => preview(JSON.parse(String(options?.body)).target));
    await render(); await act(async () => editor.openCreate(host));
    const selected = editor.options.find(option => option.kind === "room")!;
    const payload = { ...definition, target: selected.target };
    await act(async () => editor.create(payload, selected));
    await waitFor(() => expect(editor.createReview).not.toBeNull());
    await act(async () => editor.confirmCreate({ ...payload, reason: "Changed definition" }, selected));
    expect(transport.request).toHaveBeenCalledTimes(1);
    input = { ...input, evidence: { ...input.evidence, permissionsCurrent: false } }; await render();
    await act(async () => editor.confirmCreate(payload, selected));
    await waitFor(() => expect(editor.createMutation.isError).toBe(true));
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(editor.editor?.kind).toBe("create");
    expect(editor.createReview?.candidate.payload.reason).toBe(definition.reason);
  });

  it("preserves BlocksManage individual-unit creation without using the new group permission", async () => {
    input.mayManageGroups = false;
    transport.request.mockResolvedValue({ blockId, blockGroupId: groupId, propertyId, status: 1, version: 1 });
    await render(); expect(editor.options.every(option => option.kind === "unit")).toBe(true);
    await act(async () => editor.openCreate(host));
    await act(async () => editor.create({ ...definition, target: editor.options[0].target }, editor.options[0]));
    await waitFor(() => expect(editor.createMutation.isSuccess).toBe(true));
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(transport.request.mock.calls[0][0]).toBe(`/api/inventory/properties/${propertyId}/blocks`);
    expect(JSON.parse(String(transport.request.mock.calls[0][1]?.body))).toMatchObject({ inventoryUnitId: unitId, ...definition });
  });

  it("never widens a selected one-unit release into the larger group's three active units", async () => {
    input.blocks = [block];
    transport.request.mockImplementation(async (_path, options) => options?.method === "POST"
      ? { blockId, blockGroupId: groupId, propertyId, status: 2, version: 5 } : { ...group, activeBlockCount: 3, initialBlockCount: 3 });
    await render(); await act(async () => editor.openRelease(groupId, "Selected bed", "One selected unit", host));
    await waitFor(() => expect(editor.releaseCanSubmit).toBe(true));
    await act(async () => editor.release());
    await waitFor(() => expect(editor.releaseMutation.isSuccess).toBe(true));
    const writes = transport.request.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(`/api/inventory/properties/${propertyId}/blocks/${blockId}/release`);
    expect(JSON.parse(String(writes[0][1]?.body)).expectedVersion).toBe(block.version);
    expect(editor.notice?.receipt.affectedBlockCount).toBe(1);
  });

  it("binds whole-group release to its authoritative version and recovers a lost response", async () => {
    input.blocks = [block];
    let sentOperation = "";
    const released = { ...receipt, status: 3 as const, version: 10, activeBlockCount: 0, releasedBlockCount: 1, releasedNowBlockCount: 1, createdBlockCount: 0, createdNowBlockCount: 0 };
    transport.request.mockImplementation(async (path, options) => {
      if (options?.method === "POST") { sentOperation = JSON.parse(String(options.body)).operationId; throw new TypeError("lost after commit"); }
      if (path.includes("/operations/")) return { operationId: sentOperation, propertyId, requestedBlockGroupId: groupId, kind: 3, status: 1, receipt: released, completedAtUtc: "2026-11-02T12:00:00Z" };
      return group;
    });
    await render(); await act(async () => editor.openRelease(groupId, "Whole group", "One active member", host));
    await waitFor(() => expect(editor.releaseCanSubmit).toBe(true));
    await act(async () => editor.release());
    await waitFor(() => expect(editor.releaseMutation.isSuccess).toBe(true));
    const writes = transport.request.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(`/api/inventory/properties/${propertyId}/block-groups/${groupId}/release`);
    expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ expectedVersion: 9, confirmed: true, operationId: sentOperation });
    expect(editor.notice?.receipt).toEqual(released);
  });
});
