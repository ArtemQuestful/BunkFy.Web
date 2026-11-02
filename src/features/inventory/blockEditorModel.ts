import type { ManualBlock, ManualBlockGroupMutationReceipt } from "../../api/types";
import { manualBlockStatusLabel } from "../../api/labels";
import { validStayDateRange } from "../../app/propertyDate";
import type { BlockTargetOption } from "./inventoryBlocking";
import { blockTargetIsCurrent } from "./inventoryMutationAuthority";

export type BlockEditorScope = { contextKey: string; editorSession: number; propertyId: string };
export type CreateBlockPayload = { target: BlockTargetOption["target"]; arrival: string; departure: string; reason: string };
export type BlockMutationReceipt = Pick<ManualBlockGroupMutationReceipt,
  "propertyId" | "blockGroupId" | "affectedBlockCount">;
export type BlockReleaseTarget = {
  blockGroupId: string;
  label: string;
  detail: string;
  intervals: { arrival: string; departure: string }[];
  reasons: string[];
  unitCount: number;
  fingerprint: string;
};

export function blockEditorScopeCurrent(input: BlockEditorScope, current: BlockEditorScope) {
  return input.contextKey === current.contextKey && input.editorSession === current.editorSession
    && input.propertyId === current.propertyId;
}

export function selectedBlockTargetCurrent(options: BlockTargetOption[], selected: BlockTargetOption | null) {
  if (!selected || !blockTargetIsCurrent(options, selected.target)) return false;
  const current = options.find((option) => option.id === selected.id);
  return Boolean(current && sameIds(current.unitIds, selected.unitIds));
}

export function validCreateBlockPayload(payload: CreateBlockPayload) {
  return validStayDateRange(payload) && payload.reason.trim().length > 0;
}

export function validCreateBlockReceipt(receipt: unknown, propertyId: string): receipt is BlockMutationReceipt {
  if (!receipt || typeof receipt !== "object") return false;
  const candidate = receipt as Partial<ManualBlockGroupMutationReceipt>;
  // Backend contract: non-empty Guid group ID and signed int32 affected row count.
  return candidate.propertyId === propertyId
    && typeof candidate.blockGroupId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.blockGroupId)
    && candidate.blockGroupId !== "00000000-0000-0000-0000-000000000000"
    && typeof candidate.affectedBlockCount === "number"
    && Number.isInteger(candidate.affectedBlockCount)
    && candidate.affectedBlockCount > 0 && candidate.affectedBlockCount <= 2_147_483_647;
}

export function blockGroupRecords(blocks: ManualBlock[], blockGroupId: string) {
  return blocks.filter((block) => (block.blockGroupId || block.blockId) === blockGroupId);
}

export function blockGroupFingerprint(blocks: ManualBlock[]) {
  return JSON.stringify(blocks.map((block) => ({
    blockId: block.blockId, propertyId: block.propertyId, unitId: block.inventoryUnitId,
    version: block.version, status: manualBlockStatusLabel(block.status),
    arrival: block.arrival, departure: block.departure, reason: block.reason,
  })).sort((a, b) => a.blockId.localeCompare(b.blockId)));
}

export function blockReleaseTargetCurrent(blocks: ManualBlock[], target: BlockReleaseTarget) {
  const current = blockGroupRecords(blocks, target.blockGroupId);
  return current.length > 0 && current.every((block) => manualBlockStatusLabel(block.status) === "active")
    && blockGroupFingerprint(current) === target.fingerprint;
}

export function makeBlockReleaseTarget(blocks: ManualBlock[], blockGroupId: string, label: string, detail: string): BlockReleaseTarget | null {
  const records = blockGroupRecords(blocks, blockGroupId);
  if (!records.length || !records.every((block) => manualBlockStatusLabel(block.status) === "active")) return null;
  return {
    blockGroupId, label, detail,
    intervals: [...new Set(records.map((block) => `${block.arrival}|${block.departure}`))].map((value) => {
      const [arrival, departure] = value.split("|");
      return { arrival, departure };
    }),
    reasons: [...new Set(records.map((block) => block.reason))],
    unitCount: new Set(records.map((block) => block.inventoryUnitId)).size,
    fingerprint: blockGroupFingerprint(records),
  };
}

function sameIds(left: string[], right: string[]) {
  const sortedRight = [...right].sort();
  return left.length === right.length && [...left].sort().every((id, index) => id === sortedRight[index]);
}
