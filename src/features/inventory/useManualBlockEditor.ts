import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ManualBlock, ManualBlockGroupSelectionPreview, ManualBlockMutationReceipt, RoomInventory } from "../../api/types";
import { useSession } from "../../app/session";
import { sessionIdentityKey } from "../../app/singleFlightRefresh";
import { buildBlockTargetOptions, type BlockTargetOption } from "./inventoryBlocking";
import { blockTargetIsCurrent, inventoryMutationAllowed, type InventoryMutationEvidence } from "./inventoryMutationAuthority";
import { createManualBlockGroup, getManualBlockGroup, manualBlockListMatchesProperty, previewManualBlockGroup, releaseManualBlockGroup, roomInventoryMatchesProperty } from "./inventoryApi";
import { buildCreateManualBlockGroupRequest, buildManualBlockGroupPreviewRequest, manualBlockGroupDraftFingerprint } from "./manualBlockGroupWorkflow";
import { resolveManualBlockCreateAttempt, resolveManualBlockGroupReleaseAttempt, type ManualBlockMutationAttempt } from "./manualBlockMutationAttempt";
import {
  blockEditorScopeCurrent, blockGroupRecords, blockReleaseTargetCurrent, makeBlockReleaseTarget, selectedBlockTargetCurrent,
  validCreateBlockPayload, validCreateBlockReceipt, type BlockEditorScope, type BlockReleaseTarget, type CreateBlockPayload, type BlockMutationReceipt,
} from "./blockEditorModel";

type CreateInput = BlockEditorScope & { payload: CreateBlockPayload; selected: BlockTargetOption };
type ConfirmedCreateInput = CreateInput & { preview: ManualBlockGroupSelectionPreview | null };
type ReleaseInput = BlockEditorScope & { target: BlockReleaseTarget; expectedVersion: number; unit: ManualBlock | null };
export type BlockEditorNotice = { action: "created" | "released"; receipt: BlockMutationReceipt;
  createdTarget?: BlockTargetOption; createdRange?: { arrival: string; departure: string } };

export function useManualBlockEditor(input: {
  propertyId: string;
  propertyName: string;
  rooms: RoomInventory[];
  blocks: ManualBlock[];
  mayManage: boolean;
  mayManageGroups?: boolean;
  selectionKey?: string;
  evidence: InventoryMutationEvidence;
  onSuccess: (notice: BlockEditorNotice) => void;
}) {
  const { request, session } = useSession();
  const queryClient = useQueryClient();
  const contextKey = `${sessionIdentityKey(session)}:${input.propertyId}:${input.selectionKey ?? ""}`;
  const latest = useRef(input);
  latest.current = input;
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const mounted = useRef(true);
  const sequence = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const createAttempt = useRef<ManualBlockMutationAttempt | null>(null);
  const releaseAttempt = useRef<ManualBlockMutationAttempt | null>(null);
  const [editor, setEditor] = useState<({ kind: "create" } | { kind: "release"; target: BlockReleaseTarget }) & BlockEditorScope | null>(null);
  const [notice, setNotice] = useState<BlockEditorNotice | null>(null);
  const [createReview, setCreateReview] = useState<{ candidate: CreateInput; preview: ManualBlockGroupSelectionPreview } | null>(null);
  const options = useMemo(() => buildBlockTargetOptions(input.propertyName, input.rooms)
    .filter((option) => input.mayManageGroups || option.kind === "unit"), [input.propertyName, input.rooms, input.mayManageGroups]);

  function scope(): BlockEditorScope {
    return { contextKey: currentContext.current, editorSession: sequence.current, propertyId: latest.current.propertyId };
  }
  function scopeCurrent(candidate: BlockEditorScope) {
    return mounted.current && blockEditorScopeCurrent(candidate, scope());
  }
  function authorityCurrent(action: "create-block" | "release-block") {
    const current = latest.current;
    return Boolean(current.propertyId && (current.mayManage || current.mayManageGroups)
      && roomInventoryMatchesProperty(current.rooms, current.propertyId)
      && manualBlockListMatchesProperty(current.blocks, current.propertyId)
      && inventoryMutationAllowed(action, { ...current.evidence, targetCurrent: true }));
  }
  function targetCurrent(target: BlockTargetOption) {
    const current = latest.current;
    return Boolean((current.mayManageGroups || target.kind === "unit")
      && selectedBlockTargetCurrent(buildBlockTargetOptions(current.propertyName, current.rooms), target));
  }
  async function invalidate(propertyId: string) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["blocks", propertyId] }),
      queryClient.invalidateQueries({ queryKey: ["availability", propertyId] }),
      queryClient.invalidateQueries({ queryKey: ["inventory-block-groups", propertyId] }),
      queryClient.invalidateQueries({ queryKey: ["inventory-block-group", propertyId] }),
    ]);
  }
  async function complete(receipt: BlockMutationReceipt, candidate: CreateInput | ReleaseInput, action: BlockEditorNotice["action"]) {
    await invalidate(candidate.propertyId);
    if (!scopeCurrent(candidate)) return;
    createAttempt.current = null;
    releaseAttempt.current = null;
    setCreateReview(null);
    setEditor(null);
    const next: BlockEditorNotice = { action, receipt, ...("payload" in candidate
      ? { createdTarget: candidate.selected, createdRange: { arrival: candidate.payload.arrival, departure: candidate.payload.departure } } : {}) };
    setNotice(next);
    latest.current.onSuccess(next);
  }
  const createMutation = useMutation({
    mutationFn: async (candidate: ConfirmedCreateInput): Promise<BlockMutationReceipt> => {
      requireCurrent(scopeCurrent(candidate) && authorityCurrent("create-block") && targetCurrent(candidate.selected)
        && blockTargetIsCurrent([candidate.selected], candidate.payload.target)
        && validCreateBlockPayload(candidate.payload), "Refresh access and inventory, then review the exact target, dates and reason before adding this block.");
      createAttempt.current = resolveManualBlockCreateAttempt(createAttempt.current, { propertyId: candidate.propertyId, ...candidate.payload,
        expectedSelectionDigest: candidate.preview?.selectionDigest, expectedAffectedBlockCount: candidate.preview?.affectedBlockCount });
      let receipt: BlockMutationReceipt;
      if (candidate.preview) {
        requireCurrent(Boolean(latest.current.mayManageGroups), "Current block-group management access is required.");
        receipt = await createManualBlockGroup(request, candidate.propertyId,
          buildCreateManualBlockGroupRequest(candidate.payload, candidate.preview, createAttempt.current.operationId));
      } else {
        requireCurrent(latest.current.mayManage && candidate.selected.kind === "unit" && Boolean(candidate.payload.target.inventoryUnitId),
          "Individual block access only permits one selected inventory unit.");
        const unit = await request<ManualBlockMutationReceipt>(`/api/inventory/properties/${candidate.propertyId}/blocks`, {
          method: "POST", cache: "no-store", body: JSON.stringify({ operationId: createAttempt.current.operationId,
            inventoryUnitId: candidate.payload.target.inventoryUnitId, arrival: candidate.payload.arrival,
            departure: candidate.payload.departure, reason: candidate.payload.reason }),
        });
        requireCurrent(unit.propertyId === candidate.propertyId && Boolean(unit.blockId) && unit.version > 0,
          "The individual block receipt did not match this property.");
        receipt = { propertyId: unit.propertyId, blockGroupId: unit.blockGroupId, affectedBlockCount: 1 };
      }
      requireCurrent(validCreateBlockReceipt(receipt, candidate.propertyId), "The block receipt could not be confirmed. Refresh to check the outcome before starting another block.");
      return receipt;
    },
    onSuccess: (receipt, candidate) => complete(receipt, candidate, "created"),
    onError: async (_error, candidate) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inventory-rooms", candidate.propertyId] }),
        invalidate(candidate.propertyId),
      ]);
    },
  });
  const previewMutation = useMutation({
    mutationFn: async (candidate: CreateInput) => {
      requireCurrent(scopeCurrent(candidate) && authorityCurrent("create-block") && Boolean(latest.current.mayManageGroups)
        && targetCurrent(candidate.selected) && validCreateBlockPayload(candidate.payload),
      "Refresh access and inventory before previewing this exact block definition.");
      return previewManualBlockGroup(request, candidate.propertyId, buildManualBlockGroupPreviewRequest(candidate.payload));
    },
    onSuccess: (preview, candidate) => { if (scopeCurrent(candidate)) setCreateReview({ candidate, preview }); },
  });
  const releaseGroup = useQuery({
    queryKey: ["inventory-block-group", input.propertyId, editor?.kind === "release" ? editor.target.blockGroupId : null],
    enabled: Boolean(input.mayManageGroups && editor?.kind === "release" && scopeCurrent(editor) && authorityCurrent("release-block")),
    queryFn: async ({ signal }) => {
      if (editor?.kind !== "release") throw new Error("No block group is selected.");
      const group = await getManualBlockGroup(request, editor.propertyId, editor.target.blockGroupId, signal);
      requireCurrent(group.propertyId === editor.propertyId && group.blockGroupId === editor.target.blockGroupId,
        "The block group response did not match the selected property and group.");
      return group;
    },
  });
  const releaseMutation = useMutation({
    mutationFn: async (candidate: ReleaseInput): Promise<BlockMutationReceipt> => {
      requireCurrent(scopeCurrent(candidate) && authorityCurrent("release-block")
        && (blockReleaseTargetCurrent(latest.current.blocks, candidate.target) || Boolean(releaseAttempt.current)),
      "This block group or your access changed. Refresh and review the exact group before releasing it.");
      requireCurrent(Boolean(candidate.unit ? latest.current.mayManage : latest.current.mayManageGroups), "Current access to this exact block action is required.");
      releaseAttempt.current = resolveManualBlockGroupReleaseAttempt(releaseAttempt.current, candidate.propertyId,
        candidate.unit?.blockId ?? candidate.target.blockGroupId, candidate.expectedVersion);
      let receipt: BlockMutationReceipt;
      if (candidate.unit) {
        const unit = await request<ManualBlockMutationReceipt>(`/api/inventory/properties/${candidate.propertyId}/blocks/${candidate.unit.blockId}/release`, {
          method: "POST", cache: "no-store", body: JSON.stringify({ operationId: releaseAttempt.current.operationId, expectedVersion: candidate.expectedVersion }),
        });
        requireCurrent(unit.blockId === candidate.unit.blockId && unit.propertyId === candidate.propertyId
          && unit.blockGroupId === candidate.target.blockGroupId, "The individual release receipt did not match the selected block.");
        receipt = { propertyId: unit.propertyId, blockGroupId: unit.blockGroupId, affectedBlockCount: 1 };
      } else {
        receipt = await releaseManualBlockGroup(request, candidate.propertyId, candidate.target.blockGroupId,
          { operationId: releaseAttempt.current.operationId, expectedVersion: candidate.expectedVersion, confirmed: true });
      }
      requireCurrent(receipt.propertyId === candidate.propertyId && receipt.blockGroupId === candidate.target.blockGroupId,
        "The release receipt did not match this group. Refresh to check the outcome.");
      return receipt;
    },
    onSuccess: (receipt, candidate) => complete(receipt, candidate, "released"),
    onError: (_error, candidate) => invalidate(candidate.propertyId),
  });
  const busy = createMutation.isPending || previewMutation.isPending || releaseMutation.isPending;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  function reset() {
    sequence.current += 1;
    createAttempt.current = null;
    releaseAttempt.current = null;
    createMutation.reset();
    previewMutation.reset();
    setCreateReview(null);
    releaseMutation.reset();
    setEditor(null);
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; opener.current = null; sequence.current += 1; };
  }, []);
  useEffect(() => {
    opener.current = null;
    reset();
    setNotice(null);
  }, [contextKey]);
  useEffect(() => {
    if (input.evidence.permissionsCurrent && !input.mayManage && !input.mayManageGroups) {
      opener.current = null;
      reset();
      setNotice(null);
    }
  }, [input.evidence.permissionsCurrent, input.mayManage, input.mayManageGroups]);

  const visibleEditor = editor && scopeCurrent(editor) ? editor : null;
  const releaseRecords = visibleEditor?.kind === "release" ? blockGroupRecords(input.blocks, visibleEditor.target.blockGroupId) : [];
  const groupCurrent = Boolean(input.mayManageGroups && releaseGroup.data && !releaseGroup.isFetching && !releaseGroup.error
    && releaseGroup.data.activeBlockCount > 0 && releaseGroup.data.activeBlockCount === releaseRecords.length);
  // A selected space may show only one member of a larger group. It must never
  // turn a one-unit confirmation into a release of the whole property group.
  const unitRelease = input.mayManage && releaseRecords.length === 1 && (!input.mayManageGroups
    || Boolean(releaseGroup.data && !releaseGroup.isFetching && !releaseGroup.error && !groupCurrent));
  function reviewMatches(payload: CreateBlockPayload, selected: BlockTargetOption | null) {
    return Boolean(createReview && selected && scopeCurrent(createReview.candidate) && targetCurrent(selected)
      && manualBlockGroupDraftFingerprint(input.propertyId, payload) === manualBlockGroupDraftFingerprint(createReview.candidate.propertyId, createReview.candidate.payload));
  }
  return {
    editor: visibleEditor, options, notice, opener, busy, createMutation, releaseMutation, previewMutation, createReview, reviewMatches,
    mayManageGroups: Boolean(input.mayManageGroups), releaseGroup,
    releaseGroupId: visibleEditor?.kind === "release" ? visibleEditor.target.blockGroupId : null,
    ready: authorityCurrent(visibleEditor?.kind === "release" ? "release-block" : "create-block"),
    createCanSubmit: (selected: BlockTargetOption | null) => Boolean(visibleEditor?.kind === "create"
      && authorityCurrent("create-block") && selected && targetCurrent(selected)),
    releaseCanSubmit: Boolean(visibleEditor?.kind === "release" && authorityCurrent("release-block")
      && blockReleaseTargetCurrent(input.blocks, visibleEditor.target) && (groupCurrent || unitRelease)),
    releaseTargetCurrent: visibleEditor?.kind === "release" && blockReleaseTargetCurrent(input.blocks, visibleEditor.target),
    openCreate: (trigger: HTMLElement) => {
      if (busyRef.current || !authorityCurrent("create-block") || !options.length) return;
      reset(); opener.current = trigger; setNotice(null);
      setEditor({ kind: "create", ...scope() });
    },
    openRelease: (blockGroupId: string, label: string, detail: string, trigger: HTMLElement) => {
      if (busyRef.current || !authorityCurrent("release-block")) return;
      const target = makeBlockReleaseTarget(latest.current.blocks, blockGroupId, label, detail);
      if (!target) return;
      reset(); opener.current = trigger; setNotice(null);
      setEditor({ kind: "release", target, ...scope() });
    },
    close: () => { if (!busyRef.current) reset(); },
    create: (payload: CreateBlockPayload, selected: BlockTargetOption) => {
      if (visibleEditor?.kind !== "create" || busyRef.current) return;
      const candidate = { ...visibleEditor, payload: { ...payload, target: { ...payload.target }, reason: payload.reason.trim() }, selected };
      if (input.mayManageGroups) { setCreateReview(null); previewMutation.mutate(candidate); }
      else createMutation.mutate({ ...candidate, preview: null });
    },
    confirmCreate: (payload: CreateBlockPayload, selected: BlockTargetOption | null) => {
      if (!createReview || busyRef.current || !reviewMatches(payload, selected)) return;
      createMutation.mutate({ ...createReview.candidate, preview: createReview.preview });
    },
    release: () => {
      if (visibleEditor?.kind !== "release" || busyRef.current) return;
      if (groupCurrent && releaseGroup.data) releaseMutation.mutate({ ...visibleEditor, expectedVersion: releaseGroup.data.version, unit: null });
      else if (unitRelease) releaseMutation.mutate({ ...visibleEditor, expectedVersion: releaseRecords[0].version, unit: releaseRecords[0] });
    },
    retryCreate: () => {
      const candidate = createMutation.variables;
      if (candidate && !busyRef.current && scopeCurrent(candidate)) createMutation.mutate(candidate);
    },
    retryRelease: () => {
      const candidate = releaseMutation.variables;
      if (candidate && !busyRef.current && scopeCurrent(candidate)) releaseMutation.mutate(candidate);
    },
    editCreateDraft: () => {
      if (busyRef.current) return;
      createAttempt.current = null;
      createMutation.reset();
      previewMutation.reset();
      setCreateReview(null);
    },
    refresh: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ["inventory-rooms", input.propertyId] }),
      invalidate(input.propertyId),
    ]),
  };
}

function requireCurrent(allowed: boolean, message: string) {
  if (!allowed) throw new Error(message);
}
