import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client";
import type {
  InventoryBlockTarget,
  ManualBlockGroup,
  ManualBlockGroupSelectionPreview,
} from "../src/api/types";
import {
  buildCreateManualBlockGroupRequest,
  buildManualBlockGroupPreviewRequest,
  buildReplaceManualBlockGroupRequest,
  isNoOpManualBlockGroupReplacementReceipt,
  manualBlockGroupDraftFingerprint,
  manualBlockGroupMutationRecoveryAction,
  presentManualBlockGroupPreview,
  type ManualBlockGroupDraft,
} from "../src/features/inventory/manualBlockGroupWorkflow";

const target: InventoryBlockTarget = {
  kind: 4,
  buildingLabel: null,
  floorLabel: null,
  roomId: "ROOM-A",
  inventoryUnitId: null,
};
const draft: ManualBlockGroupDraft = {
  target,
  arrival: "2026-08-20",
  departure: "2026-08-23",
  reason: "  Deep clean  ",
};

describe("manual block-group confirmation workflow", () => {
  it("binds replacement preview and confirmation to the current group version", () => {
    const group = blockGroup();
    expect(buildManualBlockGroupPreviewRequest(draft, group)).toMatchObject({
      blockGroupId: group.blockGroupId,
      expectedVersion: group.version,
      reason: "Deep clean",
    });

    expect(buildReplaceManualBlockGroupRequest(draft, readyPreview(), group, "operation-a")).toMatchObject({
      operationId: "operation-a",
      expectedVersion: 7,
      expectedSelectionDigest: "a".repeat(64),
      expectedAffectedBlockCount: 2,
      confirmed: true,
      reason: "Deep clean",
    });
  });

  it("refuses stale or non-confirmable previews", () => {
    expect(() => buildReplaceManualBlockGroupRequest(
      draft,
      { ...readyPreview(), blockGroupVersion: 6 },
      blockGroup(),
      "operation-a",
    )).toThrow(/not bound/i);
    expect(() => buildCreateManualBlockGroupRequest(
      draft,
      { ...readyPreview(), status: 3, selectionDigest: null },
      "operation-a",
    )).toThrow(/current ready preview/i);
    expect(() => buildCreateManualBlockGroupRequest(
      draft,
      { ...readyCreatePreview(), departure: "2026-08-24" },
      "operation-a",
    )).toThrow(/does not match/i);
  });

  it("presents exact bounded states without allowing unsafe confirmation", () => {
    expect(presentManualBlockGroupPreview(readyPreview())).toMatchObject({
      kind: "ready",
      impactLabel: "2 inventory units",
      canConfirm: true,
    });
    expect(presentManualBlockGroupPreview({
      ...readyPreview(),
      selectionDigest: "not-a-sha256",
    }).canConfirm).toBe(false);
    expect(presentManualBlockGroupPreview({
      ...readyPreview(),
      status: 4,
      affectedBlockCount: null,
      atLeastAffectedBlockCount: 501,
      maximumAffectedBlockCount: 500,
      exceedsMaximumAffectedBlockCount: true,
      selectionDigest: null,
      membershipDigest: null,
      members: [],
    })).toMatchObject({
      kind: "tooLarge",
      impactLabel: "At least 501 inventory units",
      canConfirm: false,
    });
  });

  it("normalizes semantically identical drafts into one intent fingerprint", () => {
    const first = manualBlockGroupDraftFingerprint("PROPERTY-A", draft, blockGroup());
    const retry = manualBlockGroupDraftFingerprint("property-a", {
      ...draft,
      target: { ...target, roomId: "room-a", buildingLabel: "ignored" },
      reason: "Deep clean",
    }, { blockGroupId: "group-a", version: 7 });

    expect(retry).toBe(first);
  });

  it("routes deterministic confirmation failures to current evidence", () => {
    expect(manualBlockGroupMutationRecoveryAction(
      new ApiError("changed", 409, "Inventory.BlockGroupSelectionMismatch"),
    )).toBe("repreview");
    expect(manualBlockGroupMutationRecoveryAction(
      new ApiError("version", 409, "Inventory.VersionConflict"),
    )).toBe("refresh");
    expect(manualBlockGroupMutationRecoveryAction(
      new ApiError("operation", 409, "Inventory.ManagementOperationConflict"),
    )).toBe("restart");
    expect(manualBlockGroupMutationRecoveryAction(new TypeError("network reset"))).toBe("retry");
  });

  it("distinguishes an exact no-op receipt from a real successor", () => {
    expect(isNoOpManualBlockGroupReplacementReceipt({
      ...blockGroupReceipt(),
      affectedBlockCount: 0,
      previousBlockGroupId: "group-a",
      resultBlockGroupId: "GROUP-A",
      releasedNowBlockCount: 0,
      createdNowBlockCount: 0,
    })).toBe(true);
    expect(isNoOpManualBlockGroupReplacementReceipt({
      ...blockGroupReceipt(),
      previousBlockGroupId: "group-a",
      resultBlockGroupId: "group-b",
      releasedNowBlockCount: 2,
      createdNowBlockCount: 2,
    })).toBe(false);
  });
});

function readyPreview(): ManualBlockGroupSelectionPreview {
  return {
    propertyId: "property-a",
    target,
    arrival: draft.arrival,
    departure: draft.departure,
    status: 1,
    maximumAffectedBlockCount: 500,
    affectedBlockCount: 2,
    atLeastAffectedBlockCount: 2,
    exceedsMaximumAffectedBlockCount: false,
    selectionDigest: "a".repeat(64),
    membershipDigest: "membership-v1",
    membershipDigestVersion: 1,
    hasManualBlockConflict: false,
    hasActiveAllocationConflict: false,
    members: [],
    hasMoreMembers: false,
    blockGroupId: "group-a",
    blockGroupVersion: 7,
    isNoOpReplacement: false,
  };
}

function readyCreatePreview(): ManualBlockGroupSelectionPreview {
  return {
    ...readyPreview(),
    blockGroupId: null,
    blockGroupVersion: null,
  };
}

function blockGroup(): ManualBlockGroup {
  return {
    blockGroupId: "group-a",
    propertyId: "property-a",
    target,
    arrival: draft.arrival,
    departure: draft.departure,
    reason: "Deep clean",
    selectionDigest: "a".repeat(64),
    membershipDigest: "membership-v1",
    membershipDigestVersion: 1,
    initialBlockCount: 2,
    activeBlockCount: 2,
    status: 1,
    version: 7,
    replacesGroupId: null,
    replacedByGroupId: null,
    createdAtUtc: "2026-08-13T00:00:00Z",
    updatedAtUtc: null,
    releasedAtUtc: null,
    createdByActorId: "staff:a",
    lastModifiedByActorId: "staff:a",
  };
}

function blockGroupReceipt() {
  return {
    blockGroupId: "group-a",
    propertyId: "property-a",
    affectedBlockCount: 2,
    status: 1 as const,
    version: 7,
    previousBlockGroupId: null,
    releasedBlockCount: null,
    createdBlockCount: 2,
    totalBlockCount: 2,
    activeBlockCount: 2,
    alreadyReleasedBlockCount: 0,
    membershipDigest: "membership-v1",
    resultBlockGroupId: "group-a",
    releasedNowBlockCount: null,
    createdNowBlockCount: 2,
  };
}
