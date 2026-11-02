import { Blocks, CircleAlert, History, Plus, ShieldCheck, Unlock } from "lucide-react";
import type { ManualBlock, RoomInventory } from "../../api/types";
import type { StayDateRange } from "../../app/propertyDate";
import type { CompositeSource } from "../../app/compositeSourceState";
import { compositeSourceUsable } from "../../app/compositeSourceState";
import { focusedResourceClass } from "../../app/resourceFocus";
import { CompositeSourceFallback, CompositeSourceNotice } from "../../components/ui/CompositeSourceNotice";
import { EmptyState } from "../../components/ui/primitives";
import { SegmentedTabs } from "../../components/ui/SegmentedTabs";
import { spacesBlockNoticeSources, type SpacesBlockGroup } from "./spacesBlocks";
import { useManualBlockEditor, type BlockEditorNotice } from "../inventory/useManualBlockEditor";
import { BlockInventoryModal } from "../inventory/BlockInventoryModal";
import { BlockReleaseForm } from "../inventory/BlockReleaseForm";
import { BlockMutationNotice } from "../inventory/BlockEditorFrame";
import type { InventoryMutationEvidence } from "../inventory/inventoryMutationAuthority";

type SpacesBlocksProps = Parameters<typeof SpacesBlocksContent>[0];

export function SpacesBlocksSection(props: Omit<SpacesBlocksProps, "editor">) {
  const editor = useManualBlockEditor({ propertyId: props.propertyId, propertyName: props.propertyName, rooms: props.rooms, blocks: props.blocks, mayManage: props.mayManageBlocks, mayManageGroups: props.mayManageGroups, evidence: props.mutationEvidence, onSuccess: props.onMutationSuccess });
  return <SpacesBlocksContent {...props} editor={editor} />;
}

export function SpacesBlocksContent({
  editor,
  embedded = false,
  initialTargetId,
  heading = "Blocks",
  scope = "all",
  otherEditorOpen = false,
  createTargetUnavailable = false,
  view,
  source,
  sourceError,
  sources,
  groups,
  evidenceCurrent,
  contextMismatch,
  selectedBlockGroupId,
  targetStatus,
  mayManageBlocks,
  initialRange,
  onViewChange,
}: {
  editor: ReturnType<typeof useManualBlockEditor>;
  embedded?: boolean;
  initialTargetId?: string;
  heading?: string;
  scope?: "selected" | "all";
  otherEditorOpen?: boolean;
  createTargetUnavailable?: boolean;
  view: "active" | "all";
  source: CompositeSource;
  sourceError: unknown;
  sources: CompositeSource[];
  groups: SpacesBlockGroup[];
  evidenceCurrent: boolean;
  contextMismatch: boolean;
  selectedBlockGroupId: string | null;
  targetStatus: "none" | "selected" | "unconfirmed" | "unavailable";
  mayManageBlocks: boolean;
  mayManageGroups?: boolean;
  propertyId: string;
  propertyName: string;
  rooms: RoomInventory[];
  blocks: ManualBlock[];
  initialRange: StayDateRange;
  mutationEvidence: InventoryMutationEvidence;
  onMutationSuccess: (notice: BlockEditorNotice) => void;
  onViewChange: (view: "active" | "all") => void;
}) {
  const releaseGroupId = editor.editor?.kind === "release" ? editor.editor.target.blockGroupId : null;
  const noticeSources = spacesBlockNoticeSources(sources, source, contextMismatch);
  const viewLocked = editor.busy || Boolean(editor.editor) || otherEditorOpen;
  return (
    <section data-blocks-region className={embedded ? "min-w-0 border-t border-base-300 bg-base-100" : "overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-sm"} aria-labelledby="spaces-blocks-heading">
      <div className={`flex flex-col gap-3 border-b border-base-300 px-4 py-3 sm:px-5 ${embedded ? "" : "lg:flex-row lg:items-start lg:justify-between"}`}>
        <div className="min-w-0">
          <h2 id="spaces-blocks-heading" tabIndex={-1} className="text-base font-semibold outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary">{heading}</h2>
          <p className="mt-1 text-xs leading-5 text-base-content/55">{scope === "selected" ? "This selected space only. Released records do not widen the scope." : "All spaces in this property · dates, scope, reason and history."}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedTabs
            value={view}
            ariaLabel="Spaces block view"
            onValueChange={onViewChange}
            options={[
              { value: "active", label: scope === "selected" ? "Selected dates" : "Unreleased", icon: <Blocks size={14} />, disabled: viewLocked },
              { value: "all", label: "All history", icon: <History size={14} />, disabled: viewLocked },
            ]}
          />
          {mayManageBlocks && (
            <button type="button" className="btn btn-primary btn-sm" disabled={createTargetUnavailable || !editor.ready || !editor.options.length || editor.busy || Boolean(editor.editor) || otherEditorOpen} onClick={(event) => editor.openCreate(event.currentTarget)}>
              <Plus size={14} />Add block
            </button>
          )}
        </div>
      </div>

      <BlockMutationNotice notice={editor.notice} />
      <BlockInventoryModal inline editor={editor} initialRange={initialRange} initialTargetId={initialTargetId} sources={noticeSources} />
      {releaseGroupId && !groups.some((group) => group.blockGroupId === releaseGroupId) && <BlockReleaseForm editor={editor} />}

      {editor.editor?.kind !== "create" && <CompositeSourceNotice className="mx-4 mt-4 sm:mx-5" sources={noticeSources} title="Block evidence is not current" />}
      {!evidenceCurrent && compositeSourceUsable(source.state) && (
        <div className="mt-4 flex items-start gap-2 border-y border-warning/25 bg-warning/10 px-4 py-3 text-xs leading-5 text-warning-content sm:px-5" role="status">
          <CircleAlert className="mt-0.5 shrink-0" size={16} />
          These are last-loaded block records. Status and target labels remain unconfirmed until both sources are current.
        </div>
      )}
      {targetStatus === "unconfirmed" && (
        <TargetNotice title="Confirming the requested block group" description="The exact group remains in the URL while current block evidence is delayed. No other group has been substituted." />
      )}
      {targetStatus === "unavailable" && (
        <TargetNotice warning title="Requested block group changed or is unavailable" description="The exact group is not present in the current selected view. Switch between Unreleased and All deliberately or return to the origin." />
      )}

      {contextMismatch && (
        <TargetNotice warning title="Block response rejected" description="One or more records did not belong to the selected property, so no block scope, dates, or status is shown. Retry before acting." />
      )}

      {contextMismatch ? (
        <div className="p-4 sm:p-5">
          <EmptyState icon={<ShieldCheck />} title="No trusted blocks to show" description="BunkFy kept the selected property but rejected mismatched source data." />
        </div>
      ) : !compositeSourceUsable(source.state) ? (
        <CompositeSourceFallback error={sourceError} state={source.state} label="inventory blocks" retry={() => void source.refetch()} title="Inventory blocks could not be loaded" />
      ) : groups.length === 0 ? (
        <div className="p-4 sm:p-5">
          {!evidenceCurrent ? <p className="text-sm text-base-content/60" role="status">Hold details are unconfirmed.</p> : embedded ? <p className="text-sm text-base-content/60" role="status">{view === "active" ? "No holds for this selection in these dates." : "No hold history recorded for this selected space."}</p> : <EmptyState
            icon={<Blocks />}
            title={view === "active" ? "No unreleased blocks" : "No block history"}
            description={view === "active" ? "Choose All to see released blocks." : "No manual holds have been recorded."}
          />}
        </div>
      ) : (
        <div className="divide-y divide-base-300">
          {groups.map((group) => (
            <article
              key={group.blockGroupId}
              tabIndex={group.blockGroupId === selectedBlockGroupId ? -1 : undefined}
              className={`px-4 py-4 outline-none outline-offset-[-3px] focus:outline-2 focus:outline-primary sm:px-5 ${group.blockGroupId === selectedBlockGroupId ? `bg-primary/8 shadow-[inset_3px_0_0_var(--color-primary)] ${focusedResourceClass}` : ""}`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="whitespace-normal break-words text-sm font-semibold leading-5">{group.label}</h3>
                    <BlockStatus group={group} evidenceCurrent={evidenceCurrent} />
                    {group.targetEvidence !== "resolved" && (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-warning-content"><ShieldCheck size={13} />Target {group.targetEvidence}</span>
                    )}
                  </div>
                  <p className="mt-1 whitespace-normal break-words text-xs leading-5 text-base-content/50">{group.detail}</p>
                </div>
                {mayManageBlocks && group.status === "active" && (
                  <button type="button" className="btn btn-ghost btn-sm self-start text-primary" disabled={!editor.ready || editor.busy || Boolean(editor.editor) || otherEditorOpen}
                    onClick={(event) => editor.openRelease(group.blockGroupId, group.label, group.detail, event.currentTarget)}>
                    <Unlock size={14} />Release
                  </button>
                )}
              </div>
              <dl className={`mt-3 grid gap-x-5 gap-y-3 border-t border-base-300 pt-3 ${embedded ? "" : "sm:grid-cols-[minmax(11rem,0.8fr)_minmax(0,1.2fr)_auto]"}`}>
                <div>
                  <dt className="text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-base-content/40">Dates</dt>
                  <dd className="mt-1 space-y-1 text-sm font-medium">
                    {group.intervals.map((interval) => <span key={`${interval.arrival}-${interval.departure}`} className="block">{formatDate(interval.arrival)} to {formatDate(interval.departure)}</span>)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-base-content/40">Reason</dt>
                  <dd className="mt-1 space-y-1 text-sm leading-5">{group.reasons.map((reason) => <span key={reason} className="block whitespace-normal break-words">{reason}</span>)}</dd>
                </div>
                <div>
                  <dt className="text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-base-content/40">Rows</dt>
                  <dd className="mt-1 text-sm font-medium">{group.blockCount}</dd>
                </div>
              </dl>
              {releaseGroupId === group.blockGroupId && <div className="mt-4"><BlockReleaseForm editor={editor} /></div>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function BlockStatus({ group, evidenceCurrent }: { group: SpacesBlockGroup; evidenceCurrent: boolean }) {
  const lifecycle = group.status === "active" ? "unreleased" : group.status;
  const label = evidenceCurrent ? lifecycle : `Unconfirmed · ${lifecycle}`;
  const tone = group.status === "active"
    ? "bg-warning/18 text-warning-content"
    : group.status === "released"
      ? "bg-base-200 text-base-content/60"
      : "bg-error/10 text-error";
  return <span className={`rounded-md px-2 py-1 text-xs font-semibold ${tone}`}>{capitalize(label)}</span>;
}

function TargetNotice({ title, description, warning = false }: { title: string; description: string; warning?: boolean }) {
  return (
    <div className={`flex gap-3 border-b px-4 py-3 sm:px-5 ${warning ? "border-warning/25 bg-warning/10 text-warning-content" : "border-info/25 bg-info/8 text-info-content"}`} role={warning ? "alert" : "status"}>
      <CircleAlert className="mt-0.5 shrink-0" size={17} />
      <div><p className="text-sm font-semibold">{title}</p><p className="mt-0.5 text-xs leading-5 opacity-80">{description}</p></div>
    </div>
  );
}

function formatDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf())
    ? value
    : new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(parsed);
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
