import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ManualBlock, RoomInventory } from "../src/api/types";
import { sessionIdentityKey } from "../src/app/singleFlightRefresh";
import {
  blockEditorScopeCurrent, blockGroupFingerprint, blockReleaseTargetCurrent,
  makeBlockReleaseTarget, selectedBlockTargetCurrent, validCreateBlockPayload, validCreateBlockReceipt,
} from "../src/features/inventory/blockEditorModel";
import { buildBlockTargetOptions } from "../src/features/inventory/inventoryBlocking";
import { inventoryMutationAllowed } from "../src/features/inventory/inventoryMutationAuthority";
import { resolveManualBlockCreateAttempt, resolveManualBlockGroupReleaseAttempt } from "../src/features/inventory/manualBlockMutationAttempt";

const room: RoomInventory = {
  propertyId: "property-a", roomId: "room-a", roomName: "Garden dorm", buildingLabel: "Main", floorLabel: "1",
  salesMode: "bedLevel", version: 1,
  units: ["A", "B"].map((label) => ({
    inventoryUnitId: `unit-${label}`, propertyId: "property-a", roomId: "room-a", bedId: `bed-${label}`,
    kind: "bed", label, isSellable: true, isTopologyActive: true,
  })),
};
const options = buildBlockTargetOptions("Harbour QA", [room]);
const selected = options.find((option) => option.kind === "room")!;
const payload = { target: selected.target, arrival: "2026-09-10", departure: "2026-09-12", reason: "Repair window latch" };
const session = { tenantId: "tenant-a", username: "owner", subjectId: "actor-a", sessionId: "session-a", generation: "generation-a" };
const scope = { contextKey: `${sessionIdentityKey(session)}:property-a`, propertyId: "property-a", editorSession: 3 };

describe("manual block editor scope and current evidence", () => {
  it("accepts only the current editor, property, actor, session and generation", () => {
    expect(blockEditorScopeCurrent(scope, { ...scope })).toBe(true);
    expect(blockEditorScopeCurrent(scope, { ...scope, editorSession: 4 })).toBe(false);
    expect(blockEditorScopeCurrent(scope, { ...scope, propertyId: "property-b" })).toBe(false);
    for (const identity of [{ subjectId: "actor-b" }, { sessionId: "session-b" }, { generation: "generation-b" }, { tenantId: "tenant-b" }]) {
      expect(blockEditorScopeCurrent(scope, { ...scope, contextKey: `${sessionIdentityKey({ ...session, ...identity })}:property-a` })).toBe(false);
    }
  });

  it("withholds create and release while any authority source is not current", () => {
    const evidence = { permissionsCurrent: true, propertyCurrent: true, inventoryCurrent: true, blocksCurrent: true, targetCurrent: true };
    for (const action of ["create-block", "release-block"] as const) {
      expect(inventoryMutationAllowed(action, evidence)).toBe(true);
      for (const key of Object.keys(evidence)) expect(inventoryMutationAllowed(action, { ...evidence, [key]: false })).toBe(false);
    }
  });

  it("supports every existing target kind without selecting a substitute", () => {
    expect(options.map((option) => option.kind)).toEqual(expect.arrayContaining(["property", "building", "floor", "room", "unit"]));
    for (const option of options) expect(selectedBlockTargetCurrent(options, option)).toBe(true);
    expect(selectedBlockTargetCurrent(options, null)).toBe(false);
    expect(selectedBlockTargetCurrent([], selected)).toBe(false);
  });

  it("preserves a deliberately selected room through label and response-order refreshes", () => {
    const refreshed = buildBlockTargetOptions("Harbour renamed", [{ ...room, roomName: "Garden dorm refreshed", version: 2, units: [...room.units].reverse() }]);
    expect(selectedBlockTargetCurrent(refreshed, selected)).toBe(true);
    expect(selected.label).toBe("Garden dorm");
  });

  it("requires deliberate review after selected scope membership changes", () => {
    const fewer = buildBlockTargetOptions("Harbour QA", [{ ...room, units: [room.units[0]] }]);
    const retired = buildBlockTargetOptions("Harbour QA", [{ ...room, units: room.units.map((unit) => ({ ...unit, isTopologyActive: false })) }]);
    expect(selectedBlockTargetCurrent(fewer, selected)).toBe(false);
    expect(selectedBlockTargetCurrent(retired, selected)).toBe(false);
    expect(selectedBlockTargetCurrent(fewer, options.find((option) => option.id === "unit:unit-A")!)).toBe(true);
    expect(selectedBlockTargetCurrent(fewer, options.find((option) => option.id === "unit:unit-B")!)).toBe(false);
  });

  it.each([
    { arrival: "2026-09-12" }, { departure: "2026-09-09" }, { arrival: "2026-02-30" },
    { departure: "" }, { reason: "" }, { reason: " \n\t " },
  ])("rejects invalid dates or an empty reason: %j", (change) => {
    expect(validCreateBlockPayload({ ...payload, ...change })).toBe(false);
  });

  it("keeps exact retry identities while separating edited intent and release groups", () => {
    expect(validCreateBlockPayload(payload)).toBe(true);
    const first = resolveManualBlockCreateAttempt(null, { propertyId: scope.propertyId, ...payload }, () => "create-1");
    expect(resolveManualBlockCreateAttempt(first, { propertyId: scope.propertyId, ...payload }, () => "create-2")).toBe(first);
    expect(resolveManualBlockCreateAttempt(first, { propertyId: scope.propertyId, ...payload, reason: "Different work" }, () => "create-2").operationId).toBe("create-2");
    const release = resolveManualBlockGroupReleaseAttempt(null, scope.propertyId, "group-a", () => "release-1");
    expect(resolveManualBlockGroupReleaseAttempt(release, scope.propertyId, "group-a", () => "release-2")).toBe(release);
    expect(resolveManualBlockGroupReleaseAttempt(release, scope.propertyId, "group-b", () => "release-2").operationId).toBe("release-2");
  });
});

describe("create receipt validation before success navigation", () => {
  const receipt = { propertyId: "property-a", blockGroupId: "5a737810-754f-4f97-9a29-c7dfb4e4e6b7", affectedBlockCount: 2 };

  it("accepts a matching non-empty UUID and positive int32 count", () => {
    expect(validCreateBlockReceipt(receipt, "property-a")).toBe(true);
    expect(validCreateBlockReceipt({ ...receipt, blockGroupId: receipt.blockGroupId.toUpperCase(), affectedBlockCount: 1 }, "property-a")).toBe(true);
    expect(validCreateBlockReceipt({ ...receipt, affectedBlockCount: 2_147_483_647 }, "property-a")).toBe(true);
  });

  it.each([null, undefined, "", [], {}, { ...receipt, propertyId: "property-b" }])("rejects absent or wrong-property receipts: %j", (candidate) => {
    expect(validCreateBlockReceipt(candidate, "property-a")).toBe(false);
  });

  it.each([undefined, null, "", " ", "not-a-group", "00000000-0000-0000-0000-000000000000", "5a737810754f4f979a29c7dfb4e4e6b7", `${receipt.blockGroupId}/other`])("rejects missing, empty or malformed group IDs: %j", (blockGroupId) => {
    expect(validCreateBlockReceipt({ ...receipt, blockGroupId }, "property-a")).toBe(false);
  });

  it.each([undefined, null, "2", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])("rejects invalid affected count: %j", (affectedBlockCount) => {
    expect(validCreateBlockReceipt({ ...receipt, affectedBlockCount }, "property-a")).toBe(false);
  });
});

describe("exact release confirmation snapshot", () => {
  const records = [block("a", "unit-A"), block("b", "unit-B")];
  const target = makeBlockReleaseTarget(records, "group-a", "Garden dorm", "Main / 1")!;
  it("summarizes all selected rows without pretending the group has an expectedVersion", () => {
    expect(target).toMatchObject({ blockGroupId: "group-a", unitCount: 2, intervals: [{ arrival: payload.arrival, departure: payload.departure }], reasons: [payload.reason] });
    expect(target).not.toHaveProperty("expectedVersion");
    expect(blockReleaseTargetCurrent([...records].reverse(), target)).toBe(true);
    expect(blockGroupFingerprint(records)).toBe(blockGroupFingerprint([...records].reverse()));
  });
  it.each([
    { version: 2 }, { status: "released" as const }, { arrival: "2026-09-11" }, { departure: "2026-09-13" },
    { reason: "Revised work" }, { inventoryUnitId: "unit-C" }, { propertyId: "property-b" },
  ])("rejects current records changed after the confirmation opened: %j", (change) => {
    expect(blockReleaseTargetCurrent([{ ...records[0], ...change }, records[1]], target)).toBe(false);
  });
  it("does not substitute a surviving or unrelated group after rows disappear", () => {
    expect(blockReleaseTargetCurrent([], target)).toBe(false);
    expect(blockReleaseTargetCurrent([records[0]], target)).toBe(false);
    expect(blockReleaseTargetCurrent(records.map((item) => ({ ...item, blockGroupId: "group-b" })), target)).toBe(false);
    expect(makeBlockReleaseTarget(records, "group-missing", "Missing", "")).toBeNull();
    expect(makeBlockReleaseTarget([{ ...records[0], status: "released" }, records[1]], "group-a", "Mixed", "")).toBeNull();
  });
});

describe("shared editor source wiring (runtime review remains required)", () => {
  const source = (path: string) => readFileSync(new URL(`../src/features/${path}`, import.meta.url), "utf8");
  it("keeps both block requests in one controller used by both routes", () => {
    const controller = source("inventory/useManualBlockEditor.ts");
    expect(controller.match(/request<ManualBlockMutationReceipt>/g)).toHaveLength(2);
    expect(controller).toContain("createManualBlockGroup(request,");
    expect(controller).toContain("releaseManualBlockGroup(request,");
    for (const path of ["inventory/InventoryPage.tsx", "spaces/SpacesBlocksSection.tsx"]) {
      const page = source(path);
      expect(page).toContain("useManualBlockEditor(");
      expect(page).not.toContain("request<ManualBlockGroupMutationReceipt>");
      expect(page).toContain("<BlockMutationNotice");
      expect(page).toContain(path.startsWith("spaces/") ? "<BlockReleaseForm" : "<ManualBlockGroupDirectory");
    }
    expect(controller).toContain("blockEditorScopeCurrent(candidate, scope())");
    expect(controller).toContain("if (!scopeCurrent(candidate)) return;");
    expect(controller).toContain('queryKey: ["blocks", propertyId]');
    expect(controller).toContain('queryKey: ["availability", propertyId]');
    expect(controller).toContain('scopeCurrent(candidate) && authorityCurrent("release-block")');
    expect(controller).toContain('inventoryMutationAllowed(action,');
    expect(controller).toContain("requireCurrent(validCreateBlockReceipt(receipt, candidate.propertyId)");
  });
  it("keeps local fields mounted through source refresh and avoids the old refresh reset", () => {
    const form = source("inventory/BlockInventoryModal.tsx");
    expect(form).toContain("key={editor.editor.editorSession}");
    expect(form).toContain("No matching inventory");
    expect(form).toContain("Until must be after From");
    expect(form).toContain("Enter a reason, not only spaces");
    expect(form).toContain("selected && !selectedCurrent");
    expect(form).toContain("selectedVisible && rangeValid");
    expect(form).toContain("const locked = editor.busy || Boolean(mutation.error)");
    expect(source("inventory/BlockEditorFrame.tsx")).toContain("useCallback(() => closeRef.current(), [])");
  });
  it("retains the exact confirmation when its row disappears and keeps history contract values", () => {
    const spaces = source("spaces/SpacesBlocksSection.tsx");
    expect(spaces).toContain("releaseGroupId && !groups.some");
    expect(spaces).toContain('{ value: "active", label: scope === "selected" ? "Selected dates" : "Unreleased"');
    expect(spaces).not.toContain("Review release");
    expect(spaces).not.toContain("Manage blocks");
    const directory = source("inventory/ManualBlockGroupDirectory.tsx");
    expect(directory).toContain("release && <ReleaseManualBlockGroupModal");
    expect(directory).toContain('{ value: "active", label: "Active"');
    expect(directory).toContain('{ value: "partial", label: "Partial"');
    expect(directory).toContain('{ value: "all", label: "All"');
    expect(directory).toContain("Check Partial for groups that still have some active members");
  });
  it("lets the open inline creation form own source recovery without hiding stale row labels", () => {
    const spaces = source("spaces/SpacesBlocksSection.tsx");
    expect(spaces).toContain('{editor.editor?.kind !== "create" && <CompositeSourceNotice');
    expect(spaces).toContain('<BlockInventoryModal inline editor={editor} initialRange={initialRange} initialTargetId={initialTargetId} sources={noticeSources}');
    expect(spaces).toContain('These are last-loaded block records. Status and target labels remain unconfirmed');
    expect(source("inventory/BlockInventoryModal.tsx")).toContain('<CompositeSourceNotice className="mb-3" sources={sources}');
  });
  it("keeps inline focus scrolling scoped and ignores detached, replaced and portal targets", () => {
    const frame = source("inventory/BlockEditorFrame.tsx");
    expect(frame).toContain("onFocusCapture={inline ?");
    expect(frame).toContain("!target.isConnected || target !== document.activeElement");
    expect(frame).toContain("!element.current?.contains(target)");
    expect(frame).toContain('nav[aria-label="Mobile navigation"]');
    expect(frame).toContain('target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" })');
    expect(frame).toContain('!candidate.matches(":disabled") && !candidate.closest("[inert]") && candidate.getClientRects().length');
    expect(frame).toContain('available(trigger) ? trigger : available(returnHeading) ? returnHeading : null');
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(styles).toContain("[data-inline-block-editor] :is(input, textarea, button, a, [tabindex])");
    expect(styles).toContain("scroll-margin-block: 5rem calc(5rem + env(safe-area-inset-bottom))");
  });
});

function block(blockId: string, inventoryUnitId: string): ManualBlock {
  return { blockId, blockGroupId: "group-a", propertyId: "property-a", inventoryUnitId,
    arrival: payload.arrival, departure: payload.departure, reason: payload.reason, status: "active", version: 1,
    createdAtUtc: "2026-09-05T02:00:00Z", releasedAtUtc: null };
}
