import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RoomInventory } from "../src/api/types";
import { BlockInventoryModal } from "../src/features/inventory/BlockInventoryModal";
import { buildBlockTargetOptions, type BlockTargetOption } from "../src/features/inventory/inventoryBlocking";
import type { useManualBlockEditor } from "../src/features/inventory/useManualBlockEditor";

const room: RoomInventory = { propertyId: "p", roomId: "r", roomName: "Dorm 104", buildingLabel: "Demo House", floorLabel: "1", salesMode: "bedLevel", version: 1,
  units: ["104-A", "104-B", "104-C", "104-D"].map((label, index) => ({ inventoryUnitId: `u${index}`, propertyId: "p", roomId: "r", bedId: `b${index}`, kind: "bed" as const, label, isSellable: true, isTopologyActive: true })) };
const options = buildBlockTargetOptions("Synthetic hostel", [room]);
const range = { arrival: "2026-09-06", departure: "2026-09-08" };
function markup(initialTargetId?: string, ready = true) {
  const editor = { editor: { kind: "create", editorSession: 1 }, options, ready,
    createMutation: { error: null, isPending: false }, opener: { current: null }, close: () => {},
    createCanSubmit: (selected: BlockTargetOption | null) => ready && Boolean(selected),
  } as unknown as ReturnType<typeof useManualBlockEditor>;
  return renderToStaticMarkup(createElement(BlockInventoryModal, { editor, initialRange: range, initialTargetId, sources: [], inline: true }));
}

describe("contextual block entry presentation (static markup, not browser evidence)", () => {
  it("puts the exact contextual bed and scope before the dates with the general picker disclosed", () => {
    const html = markup("unit:u3");
    const summary = html.slice(html.indexOf("data-selected-block-target"), html.indexOf('role="radiogroup"'));
    expect(summary).toContain("104-D");
    expect(summary).toContain("Dorm 104 - bed");
    expect(summary).toContain("Selected target");
    expect(summary).toContain("Bed or unit");
    expect(summary).toContain("Change target");
    expect(summary).toContain('data-autofocus="true"');
    expect(summary).toMatch(/<div id="[^"]+" hidden="" class="space-y-4">/);
    expect(html).toContain('value="unit:u3"');
    expect(html).toMatch(/checked=""[^>]*value="unit:u3"|value="unit:u3"[^>]*checked=""/);
    expect(html).toContain('aria-label="From:');
    expect(html).toContain('aria-label="Until:');
    expect(html).toContain("2026");
    expect(html.indexOf("data-selected-block-target")).toBeLessThan(html.indexOf('aria-label="From:'));
  });
  it("keeps contextual room membership visible rather than disguising a multi-unit block", () => {
    const html = markup("room:r");
    expect(html).toContain("Selected target · Room");
    expect(html).toContain("Dorm 104");
    expect(html).toContain("4 units will be blocked.");
    expect(html).toContain("Change target");
  });
  it.each([undefined, "missing-unit"])("keeps an unprefilled or unresolved entry fully unselected: %s", (target) => {
    const html = markup(target);
    expect(html).not.toContain("data-selected-block-target");
    expect(html).not.toContain("Change target");
    expect(html).not.toMatch(/<div id="[^"]+" hidden="" class="space-y-4">/);
    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain('checked=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Use selected target<\/button>/);
    for (const scope of ["Property", "Building", "Floor", "Room", "Bed / unit"]) expect(html).toContain(scope);
  });
  it("qualifies a cached selection while current submission authority is unavailable", () => {
    const html = markup("unit:u3", false);
    expect(html).toContain("Selection unconfirmed");
    expect(html).toContain("in the last selected scope; confirm current records before submitting.");
    expect(html).not.toContain("will be blocked.");
    expect(html).toContain("Your draft is kept.");
  });
  it("does not reset draft, retry or exact target gates when opening or closing target disclosure", () => {
    const source = readFileSync(new URL("../src/features/inventory/BlockInventoryModal.tsx", import.meta.url), "utf8");
    expect(source).toContain("const [choosingTarget, setChoosingTarget] = useState(() => !initialTarget)");
    expect(source).toContain("selectedBlockTargetCurrent(options, selected)");
    expect(source).toContain("editor.createCanSubmit(selected) && selectedVisible && rangeValid");
    expect(source).toContain("key={editor.editor.editorSession}");
    expect(source).toContain("Use selected target");
    expect(source).not.toContain("contextualEntry && <button");
    expect(source).not.toContain("contextualEntry && !choosingTarget");
    expect(source).toContain("targetSummary.current?.focus()");
    expect(source).not.toContain("editor.openCreate(");
  });
});
