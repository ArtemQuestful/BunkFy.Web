import type {
  CreateManualBlockGroupRequest,
  InventoryBlockTarget,
  ManualBlockGroup,
  ManualBlockGroupMutationReceipt,
  ManualBlockGroupSelectionPreview,
  PreviewManualBlockGroupRequest,
  ReplaceManualBlockGroupRequest,
} from "../../api/types";
import { ApiError } from "../../api/client";

export const manualBlockGroupPreviewStatuses = {
  unknown: 0,
  ready: 1,
  empty: 2,
  conflicted: 3,
  tooLarge: 4,
} as const;

export type ManualBlockGroupDraft = {
  target: InventoryBlockTarget;
  arrival: string;
  departure: string;
  reason: string;
};

export type ManualBlockGroupPreviewPresentation = {
  kind: "ready" | "empty" | "conflicted" | "tooLarge" | "unknown";
  title: string;
  description: string;
  impactLabel: string;
  canConfirm: boolean;
};

export type ManualBlockGroupMutationRecoveryAction = "retry" | "restart" | "repreview" | "refresh";

export function manualBlockGroupMutationRecoveryAction(
  error: unknown,
): ManualBlockGroupMutationRecoveryAction {
  if (!(error instanceof ApiError)) return "retry";
  if (error.code === "Inventory.ManagementOperationConflict") return "restart";
  if (error.code === "Inventory.BlockGroupSelectionMismatch" ||
      error.code === "Inventory.BlockAllocationConflict" ||
      error.code === "Inventory.BlockOverlap" ||
      error.code === "Inventory.BlockGroupTargetTooLarge" ||
      error.code === "Inventory.BlockTargetEmpty") {
    return "repreview";
  }
  if (error.code === "Inventory.VersionConflict" ||
      error.code === "Inventory.BlockGroupAlreadyTerminal" ||
      error.code === "Inventory.BlockGroupNotFound") {
    return "refresh";
  }
  return "retry";
}

export function isNoOpManualBlockGroupReplacementReceipt(
  receipt: Pick<ManualBlockGroupMutationReceipt, "affectedBlockCount" | "previousBlockGroupId" | "resultBlockGroupId" | "releasedNowBlockCount" | "createdNowBlockCount">,
): boolean {
  return receipt.affectedBlockCount === 0 &&
    normalizeId(receipt.previousBlockGroupId) === normalizeId(receipt.resultBlockGroupId) &&
    (receipt.releasedNowBlockCount ?? 0) === 0 &&
    (receipt.createdNowBlockCount ?? 0) === 0;
}

export function buildManualBlockGroupPreviewRequest(
  draft: ManualBlockGroupDraft,
  replacing?: Pick<ManualBlockGroup, "blockGroupId" | "version"> | null,
): PreviewManualBlockGroupRequest {
  return {
    target: draft.target,
    arrival: draft.arrival,
    departure: draft.departure,
    reason: normalizeReason(draft.reason),
    blockGroupId: replacing?.blockGroupId ?? null,
    expectedVersion: replacing?.version ?? null,
  };
}

export function buildCreateManualBlockGroupRequest(
  draft: ManualBlockGroupDraft,
  preview: ManualBlockGroupSelectionPreview,
  operationId: string,
): CreateManualBlockGroupRequest {
  assertConfirmablePreview(preview);
  assertPreviewMatchesDraft(draft, preview, null);
  return {
    operationId,
    target: draft.target,
    arrival: draft.arrival,
    departure: draft.departure,
    reason: normalizeReason(draft.reason),
    expectedSelectionDigest: preview.selectionDigest,
    expectedAffectedBlockCount: preview.affectedBlockCount,
    confirmed: true,
  };
}

export function buildReplaceManualBlockGroupRequest(
  draft: ManualBlockGroupDraft,
  preview: ManualBlockGroupSelectionPreview,
  replacing: Pick<ManualBlockGroup, "blockGroupId" | "version">,
  operationId: string,
): ReplaceManualBlockGroupRequest {
  assertConfirmablePreview(preview);
  if (preview.blockGroupId?.toLocaleLowerCase() !== replacing.blockGroupId.toLocaleLowerCase() ||
      preview.blockGroupVersion !== replacing.version) {
    throw new Error("The replacement preview is not bound to the current block-group version.");
  }
  assertPreviewMatchesDraft(draft, preview, replacing);
  return {
    operationId,
    expectedVersion: replacing.version,
    target: draft.target,
    arrival: draft.arrival,
    departure: draft.departure,
    reason: normalizeReason(draft.reason),
    expectedSelectionDigest: preview.selectionDigest,
    expectedAffectedBlockCount: preview.affectedBlockCount,
    confirmed: true,
  };
}

function assertPreviewMatchesDraft(
  draft: ManualBlockGroupDraft,
  preview: ManualBlockGroupSelectionPreview,
  replacing: Pick<ManualBlockGroup, "blockGroupId" | "version"> | null,
): void {
  const expectedTarget = JSON.stringify(normalizeTarget(draft.target));
  const previewTarget = JSON.stringify(normalizeTarget(preview.target));
  if (expectedTarget !== previewTarget ||
      preview.arrival !== draft.arrival ||
      preview.departure !== draft.departure ||
      normalizeId(preview.blockGroupId) !== normalizeId(replacing?.blockGroupId ?? null) ||
      preview.blockGroupVersion !== (replacing?.version ?? null)) {
    throw new Error("The confirmation preview does not match the current block-group definition.");
  }
}

export function manualBlockGroupDraftFingerprint(
  propertyId: string,
  draft: ManualBlockGroupDraft,
  replacing?: Pick<ManualBlockGroup, "blockGroupId" | "version"> | null,
): string {
  return JSON.stringify({
    propertyId: normalizeId(propertyId),
    target: normalizeTarget(draft.target),
    arrival: draft.arrival,
    departure: draft.departure,
    reason: normalizeReason(draft.reason),
    blockGroupId: normalizeId(replacing?.blockGroupId ?? null),
    expectedVersion: replacing?.version ?? null,
  });
}

export function presentManualBlockGroupPreview(
  preview: ManualBlockGroupSelectionPreview,
): ManualBlockGroupPreviewPresentation {
  switch (preview.status) {
    case manualBlockGroupPreviewStatuses.ready:
      return {
        kind: "ready",
        title: preview.isNoOpReplacement ? "No inventory change" : "Ready to confirm",
        description: preview.isNoOpReplacement
          ? "This definition already matches the current group. Confirming records an exact no-op receipt without changing its members or version."
          : `The server resolved ${exactImpactLabel(preview.affectedBlockCount)} for one atomic change.`,
        impactLabel: exactImpactLabel(preview.affectedBlockCount),
        canConfirm: Boolean(
          preview.selectionDigest &&
          /^[0-9a-f]{64}$/.test(preview.selectionDigest) &&
          preview.affectedBlockCount !== null &&
          preview.affectedBlockCount > 0 &&
          preview.affectedBlockCount <= preview.maximumAffectedBlockCount &&
          !preview.exceedsMaximumAffectedBlockCount
        ),
      };
    case manualBlockGroupPreviewStatuses.empty:
      return {
        kind: "empty",
        title: "Nothing to block",
        description: "The selected scope currently has no sellable inventory. Change the scope or dates and preview again.",
        impactLabel: "0 inventory units",
        canConfirm: false,
      };
    case manualBlockGroupPreviewStatuses.conflicted:
      return {
        kind: "conflicted",
        title: "Inventory is already in use",
        description: conflictDescription(preview),
        impactLabel: preview.affectedBlockCount === null
          ? "Conflicting inventory"
          : exactImpactLabel(preview.affectedBlockCount),
        canConfirm: false,
      };
    case manualBlockGroupPreviewStatuses.tooLarge:
      return {
        kind: "tooLarge",
        title: "Scope is too large",
        description: `This scope contains at least ${preview.atLeastAffectedBlockCount} inventory units. The atomic limit is ${preview.maximumAffectedBlockCount}; narrow the scope and preview again.`,
        impactLabel: `At least ${preview.atLeastAffectedBlockCount} inventory units`,
        canConfirm: false,
      };
    default:
      return {
        kind: "unknown",
        title: "Preview unavailable",
        description: "The server returned an unknown preview state. Refresh before making a change.",
        impactLabel: "Unknown impact",
        canConfirm: false,
      };
  }
}

export function manualBlockGroupStatusLabel(status: ManualBlockGroup["status"]): string {
  return ({
    0: "Unknown",
    1: "Active",
    2: "Partially released",
    3: "Released",
    4: "Replaced",
  } as const)[status] ?? "Unknown";
}

export function manualBlockGroupTargetLabel(target: InventoryBlockTarget): string {
  switch (target.kind) {
    case 1:
      return "Entire property";
    case 2:
      return target.buildingLabel ? `Building ${target.buildingLabel}` : "Unknown building";
    case 3:
      return [target.buildingLabel && `Building ${target.buildingLabel}`, target.floorLabel && `Floor ${target.floorLabel}`]
        .filter(Boolean)
        .join(" / ") || "Unknown floor";
    case 4:
      return target.roomId ? `Room ${shortId(target.roomId)}` : "Unknown room";
    case 5:
      return target.inventoryUnitId ? `Inventory unit ${shortId(target.inventoryUnitId)}` : "Unknown inventory unit";
    default:
      return "Legacy target (unknown)";
  }
}

function assertConfirmablePreview(preview: ManualBlockGroupSelectionPreview): asserts preview is ManualBlockGroupSelectionPreview & {
  affectedBlockCount: number;
  selectionDigest: string;
} {
  const presentation = presentManualBlockGroupPreview(preview);
  if (!presentation.canConfirm || preview.affectedBlockCount === null || !preview.selectionDigest) {
    throw new Error("A current ready preview is required before confirmation.");
  }
}

function conflictDescription(preview: ManualBlockGroupSelectionPreview): string {
  if (preview.hasManualBlockConflict && preview.hasActiveAllocationConflict) {
    return "The selection overlaps existing manual blocks and active reservations. Adjust the scope or dates and preview again.";
  }
  if (preview.hasActiveAllocationConflict) {
    return "The selection overlaps active reservations. Adjust the scope or dates and preview again.";
  }
  if (preview.hasManualBlockConflict) {
    return "The selection overlaps existing manual blocks. Adjust the scope or dates and preview again.";
  }
  return "The selected inventory changed or conflicts with another operation. Preview the current selection again.";
}

function exactImpactLabel(count: number | null): string {
  if (count === null) return "Unknown inventory impact";
  return `${count} inventory ${count === 1 ? "unit" : "units"}`;
}

function normalizeTarget(target: InventoryBlockTarget) {
  const kind = Number(target.kind);
  switch (kind) {
    case 1:
      return { kind };
    case 2:
      return { kind, buildingLabel: target.buildingLabel?.trim() || null };
    case 3:
      return {
        kind,
        buildingLabel: target.buildingLabel?.trim() || null,
        floorLabel: target.floorLabel?.trim() || null,
      };
    case 4:
      return { kind, roomId: normalizeId(target.roomId) };
    case 5:
      return { kind, inventoryUnitId: normalizeId(target.inventoryUnitId) };
    default:
      return { kind };
  }
}

function normalizeReason(value: string): string {
  return value.trim();
}

function normalizeId(value: string | null | undefined): string | null {
  return value?.trim().toLocaleLowerCase() || null;
}

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 8) : value;
}
