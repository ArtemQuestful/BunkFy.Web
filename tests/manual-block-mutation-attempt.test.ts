import { describe, expect, it } from "vitest";
import type { InventoryBlockTarget } from "../src/api/types";
import {
  resolveManualBlockCreateAttempt,
  resolveManualBlockGroupReleaseAttempt,
  resolveManualBlockReplaceAttempt,
} from "../src/features/inventory/manualBlockMutationAttempt";

const roomTarget: InventoryBlockTarget = {
  kind: 4,
  buildingLabel: null,
  floorLabel: null,
  roomId: "ROOM-A",
  inventoryUnitId: null,
};

describe("manual block mutation attempts", () => {
  it("keeps one create operation id for a normalized exact retry", () => {
    const first = resolveManualBlockCreateAttempt(
      null,
      {
        propertyId: "PROPERTY-A",
        target: roomTarget,
        arrival: "2026-08-10",
        departure: "2026-08-12",
        reason: "  Deep clean  ",
      },
      () => "operation-1",
    );
    const retry = resolveManualBlockCreateAttempt(
      first,
      {
        propertyId: "property-a",
        target: { ...roomTarget, roomId: "room-a", buildingLabel: "ignored" },
        arrival: "2026-08-10",
        departure: "2026-08-12",
        reason: "Deep clean",
      },
      () => "operation-2",
    );

    expect(retry).toBe(first);
    expect(retry.operationId).toBe("operation-1");
  });

  it("rotates create identity when the intended mutation changes", () => {
    const first = resolveManualBlockCreateAttempt(
      null,
      {
        propertyId: "property-a",
        target: roomTarget,
        arrival: "2026-08-10",
        departure: "2026-08-12",
        reason: "Deep clean",
      },
      () => "operation-1",
    );

    const changedRange = resolveManualBlockCreateAttempt(
      first,
      {
        propertyId: "property-a",
        target: roomTarget,
        arrival: "2026-08-10",
        departure: "2026-08-13",
        reason: "Deep clean",
      },
      () => "operation-2",
    );
    const changedReason = resolveManualBlockCreateAttempt(
      first,
      {
        propertyId: "property-a",
        target: roomTarget,
        arrival: "2026-08-10",
        departure: "2026-08-12",
        reason: "Private use",
      },
      () => "operation-3",
    );

    expect(changedRange.operationId).toBe("operation-2");
    expect(changedReason.operationId).toBe("operation-3");
  });

  it("reuses exact release retries and separates different groups", () => {
    const first = resolveManualBlockGroupReleaseAttempt(
      null,
      "PROPERTY-A",
      "GROUP-A",
      7,
      () => "operation-1",
    );
    const retry = resolveManualBlockGroupReleaseAttempt(
      first,
      "property-a",
      "group-a",
      7,
      () => "operation-2",
    );
    const anotherGroup = resolveManualBlockGroupReleaseAttempt(
      first,
      "property-a",
      "group-b",
      7,
      () => "operation-3",
    );

    expect(retry).toBe(first);
    expect(anotherGroup.operationId).toBe("operation-3");
  });

  it("rotates release identity when the expected group version changes", () => {
    const first = resolveManualBlockGroupReleaseAttempt(
      null,
      "property-a",
      "group-a",
      7,
      () => "operation-1",
    );
    const changedVersion = resolveManualBlockGroupReleaseAttempt(
      first,
      "property-a",
      "group-a",
      8,
      () => "operation-2",
    );

    expect(changedVersion.operationId).toBe("operation-2");
  });

  it("keeps exact replacement retries and rotates on preview or version changes", () => {
    const input = {
      propertyId: "property-a",
      blockGroupId: "group-a",
      expectedVersion: 7,
      target: roomTarget,
      arrival: "2026-08-10",
      departure: "2026-08-12",
      reason: "Deep clean",
      expectedSelectionDigest: "ABCDEF",
      expectedAffectedBlockCount: 2,
    };
    const first = resolveManualBlockReplaceAttempt(null, input, () => "operation-1");
    const retry = resolveManualBlockReplaceAttempt(first, {
      ...input,
      propertyId: "PROPERTY-A",
      blockGroupId: "GROUP-A",
      target: { ...roomTarget, roomId: "room-a" },
      reason: "  Deep clean  ",
      expectedSelectionDigest: "abcdef",
    }, () => "operation-2");
    const changedPreview = resolveManualBlockReplaceAttempt(first, {
      ...input,
      expectedSelectionDigest: "fedcba",
    }, () => "operation-3");
    const changedVersion = resolveManualBlockReplaceAttempt(first, {
      ...input,
      expectedVersion: 8,
    }, () => "operation-4");

    expect(retry).toBe(first);
    expect(changedPreview.operationId).toBe("operation-3");
    expect(changedVersion.operationId).toBe("operation-4");
  });
});
