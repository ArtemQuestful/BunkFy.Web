import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  BedDouble,
  Building2,
  CheckCircle2,
  DoorOpen,
  Layers3,
  MapPinned,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import type {
  ManualBlockGroup,
  ManualBlockGroupMutationReceipt,
  ManualBlockGroupSelectionPreview,
  RoomInventory,
} from "../../api/types";
import { useSession } from "../../app/session";
import { DatePicker } from "../../components/ui/DatePicker";
import { ErrorState, Modal, ModalActions } from "../../components/ui/primitives";
import {
  buildBlockTargetOptions,
  findBlockTargetOption,
  type BlockTargetKind,
  type BlockTargetOption,
} from "./inventoryBlocking";
import {
  createManualBlockGroup,
  previewManualBlockGroup,
  replaceManualBlockGroup,
} from "./inventoryApi";
import {
  buildCreateManualBlockGroupRequest,
  buildManualBlockGroupPreviewRequest,
  buildReplaceManualBlockGroupRequest,
  isNoOpManualBlockGroupReplacementReceipt,
  manualBlockGroupMutationRecoveryAction,
  manualBlockGroupDraftFingerprint,
  presentManualBlockGroupPreview,
  type ManualBlockGroupDraft,
} from "./manualBlockGroupWorkflow";
import {
  resolveManualBlockCreateAttempt,
  resolveManualBlockReplaceAttempt,
  type ManualBlockMutationAttempt,
} from "./manualBlockMutationAttempt";
import { defaultInventoryRange } from "./inventoryDates";

export type ManualBlockGroupWorkflow =
  | { kind: "create" }
  | { kind: "replace"; group: ManualBlockGroup };

export function ManualBlockGroupWorkflowModal({
  workflow,
  propertyId,
  propertyName,
  propertyTimeZoneId,
  rooms,
  attemptRef,
  authorityCurrent,
  onCompleted,
  onRefreshRequired,
  onClose,
}: {
  workflow: ManualBlockGroupWorkflow;
  propertyId: string;
  propertyName: string;
  propertyTimeZoneId: string;
  rooms: RoomInventory[];
  attemptRef: MutableRefObject<ManualBlockMutationAttempt | null>;
  authorityCurrent: boolean;
  onCompleted: (receipt: ManualBlockGroupMutationReceipt) => void;
  onRefreshRequired: () => void;
  onClose: () => void;
}) {
  const { request } = useSession();
  const authority = useRef(authorityCurrent);
  authority.current = authorityCurrent;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function requireAuthority() {
    if (!mounted.current || !authority.current) throw new Error("Refresh current access and Inventory evidence before continuing. Your draft is kept.");
  }
  const options = useMemo(
    () => buildBlockTargetOptions(propertyName, rooms),
    [propertyName, rooms],
  );
  const replacing = workflow.kind === "replace" ? workflow.group : null;
  const initialOption = replacing
    ? findBlockTargetOption(options, replacing.target)
    : options.find((option) => option.kind === "room") ?? options[0] ?? null;
  const [draft, setDraft] = useState<ManualBlockGroupDraft>(() => {
    const initialRange = replacing ?? defaultInventoryRange(propertyTimeZoneId);
    return {
    target: initialOption?.target ?? replacing?.target ?? emptyTarget(),
    arrival: replacing?.arrival ?? initialRange.arrival,
    departure: replacing?.departure ?? initialRange.departure,
    reason: replacing?.reason ?? "",
    };
  });
  const [selectedOptionId, setSelectedOptionId] = useState(initialOption?.id ?? "");
  const [targetKind, setTargetKind] = useState<BlockTargetKind>(initialOption?.kind ?? "room");
  const [search, setSearch] = useState("");
  const [step, setStep] = useState<"edit" | "review" | "result">("edit");
  const [previewFingerprint, setPreviewFingerprint] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ManualBlockGroupMutationReceipt | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const previewMutation = useMutation({
    mutationFn: (candidate: ManualBlockGroupDraft) => {
      requireAuthority();
      return previewManualBlockGroup(request, propertyId, buildManualBlockGroupPreviewRequest(candidate, replacing));
    },
    onSuccess: (_preview, candidate) => {
      if (!mounted.current) return;
      setPreviewFingerprint(manualBlockGroupDraftFingerprint(propertyId, candidate, replacing));
      setStep("review");
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async ({
      candidate,
      preview,
    }: {
      candidate: ManualBlockGroupDraft;
      preview: ManualBlockGroupSelectionPreview;
    }) => {
      requireAuthority();
      const currentFingerprint = manualBlockGroupDraftFingerprint(propertyId, candidate, replacing);
      if (currentFingerprint !== previewFingerprint) {
        throw new Error("This definition changed after preview. Preview the current definition again.");
      }

      if (replacing) {
        attemptRef.current = resolveManualBlockReplaceAttempt(attemptRef.current, {
          propertyId,
          blockGroupId: replacing.blockGroupId,
          expectedVersion: replacing.version,
          ...candidate,
          expectedSelectionDigest: preview.selectionDigest,
          expectedAffectedBlockCount: preview.affectedBlockCount,
        });
        return replaceManualBlockGroup(
          request,
          propertyId,
          replacing.blockGroupId,
          buildReplaceManualBlockGroupRequest(
            candidate,
            preview,
            replacing,
            attemptRef.current.operationId,
          ),
        );
      }

      attemptRef.current = resolveManualBlockCreateAttempt(attemptRef.current, {
        propertyId,
        ...candidate,
        expectedSelectionDigest: preview.selectionDigest,
        expectedAffectedBlockCount: preview.affectedBlockCount,
      });
      return createManualBlockGroup(
        request,
        propertyId,
        buildCreateManualBlockGroupRequest(candidate, preview, attemptRef.current.operationId),
      );
    },
    onSuccess: (nextReceipt) => {
      if (!mounted.current) return;
      attemptRef.current = null;
      setReceipt(nextReceipt);
      setStep("result");
      onCompleted(nextReceipt);
    },
  });

  useEffect(() => {
    if (workflow.kind !== "replace") return;
    const matched = findBlockTargetOption(options, workflow.group.target);
    if (!matched) return;
    setSelectedOptionId((current) => current || matched.id);
  }, [options, workflow]);

  const selectedOption = options.find((option) => option.id === selectedOptionId) ?? null;
  const availableKinds = targetKinds.filter(({ kind }) => options.some((option) => option.kind === kind));
  const kindOptions = options.filter((option) => option.kind === targetKind);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleOptions = normalizedSearch
    ? kindOptions.filter((option) => option.searchText.includes(normalizedSearch))
    : kindOptions;
  const preview = previewMutation.data;
  const presentation = preview ? presentManualBlockGroupPreview(preview) : null;
  const confirmationRecovery = confirmMutation.error
    ? manualBlockGroupMutationRecoveryAction(confirmMutation.error)
    : null;
  const busy = previewMutation.isPending || confirmMutation.isPending;

  function updateDraft(change: Partial<ManualBlockGroupDraft>) {
    setDraft((current) => ({ ...current, ...change }));
    invalidatePreview();
  }

  function invalidatePreview() {
    setValidationError(null);
    setPreviewFingerprint(null);
    if (step !== "result") setStep("edit");
    previewMutation.reset();
    confirmMutation.reset();
    attemptRef.current = null;
  }

  function chooseKind(kind: BlockTargetKind) {
    setTargetKind(kind);
    setSelectedOptionId("");
    setSearch("");
    invalidatePreview();
  }

  function chooseOption(option: BlockTargetOption) {
    setSelectedOptionId(option.id);
    updateDraft({ target: option.target });
  }

  function submitPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = validateDraft(draft, selectedOption);
    setValidationError(error);
    if (error) return;
    previewMutation.mutate({ ...draft, reason: draft.reason.trim() });
  }

  function confirm() {
    if (!preview || !presentation?.canConfirm) return;
    confirmMutation.mutate({ candidate: { ...draft, reason: draft.reason.trim() }, preview });
  }

  function previewAgain() {
    attemptRef.current = null;
    confirmMutation.reset();
    setPreviewFingerprint(null);
    setStep("edit");
    previewMutation.reset();
  }

  const title = workflow.kind === "replace" ? "Replace inventory block group" : "Block inventory";
  return (
    <Modal
      open
      size="lg"
      title={title}
      description={step === "edit"
        ? "Define a bounded physical scope, then preview the server-resolved inventory before confirming."
        : step === "review"
          ? "Review the exact, current inventory impact before one atomic change."
          : "The confirmed operation has a durable, recoverable receipt."}
      onClose={() => { if (!busy) onClose(); }}
    >
      {step === "edit" ? (
        <form className="space-y-4" onSubmit={submitPreview}>
          {workflow.kind === "replace" && (
            <div className="flex gap-3 rounded-lg border border-warning/25 bg-warning/10 p-4 text-sm">
              <AlertTriangle className="mt-0.5 shrink-0 text-warning-content" size={18} />
              <p>Replacement is atomic: the current group is released only if its complete successor can be created from this preview.</p>
            </div>
          )}
          <fieldset>
            <legend className="mb-1.5 text-sm font-semibold">Scope</legend>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-base-200 p-1 sm:grid-cols-5" aria-label="Inventory block scope">
              {availableKinds.map(({ kind, label, icon: Icon }) => (
                <button
                  key={kind}
                  type="button"
                  className={`btn btn-sm w-full rounded-md border-0 ${targetKind === kind ? "bg-base-100 shadow-sm" : "btn-ghost"}`}
                  aria-pressed={targetKind === kind}
                  onClick={() => chooseKind(kind)}
                >
                  <Icon size={15} />
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          {targetKind !== "property" && (
            <label className="input input-bordered flex items-center gap-2">
              <Search size={17} className="text-base-content/40" />
              <input
                type="search"
                className="grow"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={`Search ${targetLabel(targetKind).toLocaleLowerCase()}`}
                aria-label={`Search ${targetLabel(targetKind).toLocaleLowerCase()}`}
              />
            </label>
          )}

          <div className="max-h-64 overflow-y-auto rounded-lg border border-base-300" role="radiogroup" aria-label={`${targetLabel(targetKind)} target`}>
            {visibleOptions.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-base-content/50">No matching sellable inventory</p>
            ) : visibleOptions.map((option) => (
              <TargetRow
                key={option.id}
                option={option}
                selected={selectedOption?.id === option.id}
                onSelect={() => chooseOption(option)}
              />
            ))}
          </div>

          {selectedOption && (
            <div className="flex items-center justify-between gap-4 rounded-lg bg-primary/8 px-4 py-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-semibold">{selectedOption.label}</p>
                <p className="mt-0.5 text-xs text-base-content/55">{selectedOption.detail}</p>
              </div>
              <span className="badge badge-primary badge-outline shrink-0">Candidate scope</span>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <DateInput label="From" value={draft.arrival} onChange={(arrival) => updateDraft({ arrival })} />
            <DateInput label="Until" value={draft.departure} min={draft.arrival} onChange={(departure) => updateDraft({ departure })} />
          </div>
          <label className="form-control block">
            <span className="label-text mb-1.5 block text-sm font-semibold">Reason</span>
            <textarea
              className="textarea textarea-bordered min-h-20 w-full"
              value={draft.reason}
              onChange={(event) => updateDraft({ reason: event.target.value })}
              maxLength={500}
              placeholder="Maintenance, private use, deep clean..."
              required
            />
            <span className="mt-1 block text-right text-xs text-base-content/40">{draft.reason.length}/500</span>
          </label>
          {validationError && <div role="alert" className="alert alert-warning text-sm">{validationError}</div>}
          {previewMutation.error && <ErrorState error={previewMutation.error} retry={() => previewMutation.mutate({ ...draft, reason: draft.reason.trim() })} title="Couldn't preview the block group" />}
          <ModalActions>
            <button type="button" className="btn btn-ghost btn-sm sm:btn-md" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary btn-sm min-w-32 sm:btn-md" disabled={busy || !selectedOption || !authorityCurrent}>
              {previewMutation.isPending && <span className="loading loading-spinner loading-sm" />}
              Preview impact
            </button>
          </ModalActions>
        </form>
      ) : step === "review" && preview && presentation ? (
        <div className="space-y-5" aria-live="polite">
          <div className={`flex gap-3 rounded-lg border p-4 ${presentation.canConfirm ? "border-success/25 bg-success/10" : "border-warning/25 bg-warning/10"}`}>
            {presentation.canConfirm
              ? <CheckCircle2 className="mt-0.5 shrink-0 text-success" size={19} />
              : <AlertTriangle className="mt-0.5 shrink-0 text-warning-content" size={19} />}
            <div>
              <p className="font-semibold">{presentation.title}</p>
              <p className="mt-1 text-sm leading-6 text-base-content/60">{presentation.description}</p>
            </div>
          </div>
          <dl className="grid gap-3 sm:grid-cols-3">
            <ReviewValue label="Impact" value={presentation.impactLabel} />
            <ReviewValue label="Dates" value={`${formatDate(draft.arrival)} – ${formatDate(draft.departure)}`} />
            <ReviewValue label="Operation" value={workflow.kind === "replace" ? "Atomic replacement" : "Atomic creation"} />
          </dl>
          <section>
            <h3 className="text-sm font-semibold">Resolved inventory</h3>
            {preview.members.length ? (
              <ul className="mt-2 max-h-64 divide-y divide-base-300 overflow-y-auto rounded-lg border border-base-300">
                {preview.members.map((member) => (
                  <li key={member.inventoryUnitId} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{member.unitLabel || `Unit ${shortId(member.inventoryUnitId)}`}</span>
                      <span className="mt-0.5 block truncate text-xs text-base-content/50">{member.roomName || `Room ${shortId(member.roomId)}`}</span>
                    </span>
                    <span className="shrink-0 font-mono text-xs text-base-content/40">{shortId(member.inventoryUnitId)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-2 rounded-lg bg-base-200 p-4 text-sm text-base-content/55">No inventory members were returned.</p>}
            {preview.hasMoreMembers && <p className="mt-2 text-xs text-base-content/50">The preview shows a sample. The exact impact count above covers the complete atomic selection.</p>}
          </section>
          <div className="rounded-lg bg-base-200 p-4 text-sm">
            <p className="font-semibold">Reason</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-base-content/65">{draft.reason.trim()}</p>
          </div>
          {confirmMutation.error && <ErrorState error={confirmMutation.error} title="Couldn't confirm the block group" />}
          <ModalActions>
            {confirmationRecovery === "refresh" ? (
              <button type="button" className="btn btn-primary btn-sm sm:btn-md" onClick={() => { onRefreshRequired(); onClose(); }}>Close and refresh the group</button>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm sm:btn-md" onClick={previewAgain} disabled={busy}><ArrowLeft size={16} />{confirmationRecovery === "repreview" || confirmationRecovery === "restart" ? "Preview current inventory" : "Edit and preview again"}</button>
            )}
            {presentation.canConfirm && confirmationRecovery !== "repreview" && confirmationRecovery !== "restart" && confirmationRecovery !== "refresh" && (
              <button type="button" className="btn btn-primary btn-sm min-w-36 sm:btn-md" onClick={confirm} disabled={busy || !authorityCurrent}>
                {confirmMutation.isPending && <span className="loading loading-spinner loading-sm" />}
                {confirmMutation.error ? "Retry confirmation" : workflow.kind === "replace" ? "Confirm replacement" : "Confirm block"}
              </button>
            )}
          </ModalActions>
        </div>
      ) : receipt ? (
        <MutationReceiptOutcome workflow={workflow} receipt={receipt} onClose={onClose} />
      ) : null}
    </Modal>
  );
}

function MutationReceiptOutcome({
  workflow,
  receipt,
  onClose,
}: {
  workflow: ManualBlockGroupWorkflow;
  receipt: ManualBlockGroupMutationReceipt;
  onClose: () => void;
}) {
  const noOpReplacement = workflow.kind === "replace" && isNoOpManualBlockGroupReplacementReceipt(receipt);
  return (
        <div className="space-y-5" aria-live="polite">
          <div className="flex gap-3 rounded-lg border border-success/25 bg-success/10 p-4">
            <CheckCircle2 className="mt-0.5 shrink-0 text-success" size={20} />
            <div>
              <p className="font-semibold">{noOpReplacement ? "No inventory change recorded" : workflow.kind === "replace" ? "Replacement completed" : "Block group created"}</p>
              <p className="mt-1 text-sm text-base-content/60">{noOpReplacement
                ? "The confirmed definition already matched this group. Its members and version were unchanged, and the server recorded an exact no-op receipt."
                : "The server returned the durable result for this exact operation."}</p>
            </div>
          </div>
          <dl className="grid gap-3 sm:grid-cols-3">
            <ReviewValue label={workflow.kind === "replace" ? "Released now" : "Created now"} value={String(workflow.kind === "replace" ? receipt.releasedNowBlockCount ?? 0 : receipt.createdNowBlockCount ?? receipt.affectedBlockCount)} />
            {workflow.kind === "replace" && <ReviewValue label="Created now" value={String(receipt.createdNowBlockCount ?? 0)} />}
            <ReviewValue label="Active now" value={String(receipt.activeBlockCount ?? receipt.affectedBlockCount)} />
            {workflow.kind !== "replace" && <ReviewValue label="Result group" value={shortId(receipt.resultBlockGroupId)} />}
          </dl>
          {receipt.previousBlockGroupId && !noOpReplacement && (
            <p className="rounded-lg bg-base-200 p-4 text-sm text-base-content/60">Previous group <span className="font-mono">{shortId(receipt.previousBlockGroupId)}</span> remains in history and points to this successor.</p>
          )}
          <ModalActions>
            <button type="button" className="btn btn-primary btn-sm sm:btn-md" onClick={onClose}>Done</button>
          </ModalActions>
        </div>
  );
}

const targetKinds: Array<{ kind: BlockTargetKind; label: string; icon: typeof DoorOpen }> = [
  { kind: "property", label: "Property", icon: MapPinned },
  { kind: "building", label: "Building", icon: Building2 },
  { kind: "floor", label: "Floor", icon: Layers3 },
  { kind: "room", label: "Room", icon: DoorOpen },
  { kind: "unit", label: "Bed / unit", icon: BedDouble },
];

function TargetRow({ option, selected, onSelect }: { option: BlockTargetOption; selected: boolean; onSelect: () => void }) {
  return (
    <label className={`flex cursor-pointer items-center gap-3 border-b border-base-300 px-4 py-3 last:border-b-0 hover:bg-base-200/60 ${selected ? "bg-primary/8" : ""}`}>
      <input type="radio" className="radio radio-primary radio-sm" name="blockGroupTarget" value={option.id} checked={selected} onChange={onSelect} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{option.label}</span>
        <span className="mt-0.5 block truncate text-xs text-base-content/50">{option.detail}</span>
      </span>
      <span className="text-xs tabular-nums text-base-content/45">{option.unitIds.length}</span>
    </label>
  );
}

function DateInput({ label, value, min, onChange }: { label: string; value: string; min?: string; onChange: (value: string) => void }) {
  return (
    <div className="form-control block">
      <span className="label-text mb-1.5 block text-sm font-semibold">{label}</span>
      <DatePicker className="w-full" value={value} min={min} onChange={onChange} ariaLabel={label} required />
    </div>
  );
}

function ReviewValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-base-200 p-4"><dt className="text-xs font-semibold uppercase tracking-wide text-base-content/45">{label}</dt><dd className="mt-1 break-words text-sm font-semibold">{value}</dd></div>;
}

function validateDraft(draft: ManualBlockGroupDraft, selectedOption: BlockTargetOption | null): string | null {
  if (!selectedOption) return "Choose an inventory target.";
  if (!draft.arrival || !draft.departure || draft.arrival >= draft.departure) return "The end date must be after the start date.";
  const reason = draft.reason.trim();
  if (!reason || reason.length > 500) return "Enter a reason of 500 characters or fewer.";
  return null;
}

function emptyTarget(): ManualBlockGroup["target"] {
  return { kind: 0, buildingLabel: null, floorLabel: null, roomId: null, inventoryUnitId: null };
}

function targetLabel(kind: BlockTargetKind): string {
  return ({ property: "Property", building: "Building", floor: "Floor", room: "Room", unit: "Bed or unit" } as const)[kind];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 8) : value;
}
