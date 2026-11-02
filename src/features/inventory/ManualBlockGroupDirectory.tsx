import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Blocks, ChevronRight, CircleSlash2, History } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { ManualBlockGroup, ManualBlockGroupMutationReceipt, RoomInventory } from "../../api/types";
import { compositeSourceCurrent, compositeSourceUsable, createCompositeSource, type CompositeSource } from "../../app/compositeSourceState";
import { focusedResourceClass } from "../../app/resourceFocus";
import { useSession } from "../../app/session";
import { CompositeSourceFallback, CompositeSourceNotice } from "../../components/ui/CompositeSourceNotice";
import { PaginationBar } from "../../components/ui/PaginationBar";
import { SegmentedTabs } from "../../components/ui/SegmentedTabs";
import { EmptyState, StatusBadge } from "../../components/ui/primitives";
import { canAdvanceCursor, initialCursorPage, nextCursorPage, previousCursorPage } from "./cursorPaging";
import { buildBlockTargetOptions, findBlockTargetOption } from "./inventoryBlocking";
import { loadManualBlockGroupPage, MANUAL_BLOCK_GROUP_PAGE_SIZE } from "./inventoryApi";
import { ManualBlockGroupDetailsModal } from "./ManualBlockGroupDetailsModal";
import { ManualBlockGroupWorkflowModal, type ManualBlockGroupWorkflow } from "./ManualBlockGroupWorkflowModal";
import { manualBlockGroupStatusLabel, manualBlockGroupTargetLabel } from "./manualBlockGroupWorkflow";
import type { ManualBlockMutationAttempt } from "./manualBlockMutationAttempt";
import { ReleaseManualBlockGroupModal } from "./ReleaseManualBlockGroupModal";

type View = "active" | "partial" | "all";

export function ManualBlockGroupDirectory(props: {
  propertyId: string; propertyName: string; propertyTimeZoneId: string;
  rooms: RoomInventory[]; mayReadCurrent: boolean; mayManage: boolean;
  sources: CompositeSource[]; focusedBlockGroupId: string | null;
}) {
  const [params, setParams] = useSearchParams();
  const view: View = params.get("history") === "all" ? "all" : params.get("history") === "partial" ? "partial" : "active";
  // Changing a filter creates a fresh cursor chain instead of sending a cursor
  // from a different server-bound status filter during an effect transition.
  return <DirectoryPage key={view} {...props} view={view} onViewChange={(nextView) => {
    const next = new URLSearchParams(params);
    if (nextView === "active") next.delete("history"); else next.set("history", nextView);
    next.delete("focus"); next.delete("blockGroup");
    setParams(next, { replace: true });
  }} />;
}

function DirectoryPage({ propertyId, propertyName, propertyTimeZoneId, rooms, mayReadCurrent, mayManage, sources, focusedBlockGroupId, view, onViewChange }: Parameters<typeof ManualBlockGroupDirectory>[0] & { view: View; onViewChange: (view: View) => void }) {
  const { request } = useSession();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(initialCursorPage);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<ManualBlockGroupWorkflow | null>(null);
  const [release, setRelease] = useState<ManualBlockGroup | null>(null);
  const attempt = useRef<ManualBlockMutationAttempt | null>(null);
  const releaseAttempt = useRef<ManualBlockMutationAttempt | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const groups = useQuery({
    queryKey: ["inventory-block-groups", propertyId, view, page.cursor],
    queryFn: ({ signal }) => loadManualBlockGroupPage(request, propertyId, view === "all" ? null : view === "partial" ? 2 : 1, page.cursor, signal),
    enabled: mayReadCurrent,
  });
  const source = createCompositeSource({ label: "Block groups", hasData: groups.data !== undefined,
    isLoading: groups.isLoading, error: groups.error, isFetching: groups.isFetching, refetch: () => groups.refetch() });
  const usable = compositeSourceUsable(source.state);
  const current = mayManage && mayReadCurrent && sources.every(compositeSourceCurrent) && compositeSourceCurrent(source);
  const options = useMemo(() => buildBlockTargetOptions(propertyName, rooms), [propertyName, rooms]);
  const targetId = params.get("blockGroup");
  async function refresh(receipt?: ManualBlockGroupMutationReceipt) {
    if (!mounted.current) return;
    await Promise.all(["inventory-block-groups", "inventory-block-group", "inventory-block-group-members", "blocks", "availability"].map(
      (key) => queryClient.invalidateQueries({ queryKey: [key, propertyId] })));
    if (!mounted.current || !receipt) return;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("property", propertyId); next.set("blockGroup", receipt.blockGroupId); next.set("focus", receipt.blockGroupId);
      if (receipt.activeBlockCount === 0) next.set("history", "all");
      return next;
    }, { replace: true });
  }
  return <section data-blocks-region className="card border border-base-300 bg-base-100 shadow-sm">
    <div className="flex flex-col gap-3 border-b border-base-300 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div><h2 className="font-display text-xl font-semibold">Inventory blocks</h2><p className="mt-1 text-sm text-base-content/50">Current holds and released-block history.</p></div>
      <SegmentedTabs value={view} ariaLabel="Inventory block view" onValueChange={onViewChange} options={[
        { value: "active", label: "Active", icon: <Blocks size={14} /> },
        { value: "partial", label: "Partial", icon: <CircleSlash2 size={14} /> },
        { value: "all", label: "All", icon: <History size={14} /> },
      ]} />
    </div>
    <CompositeSourceNotice sources={[...sources, source]} title="Block information is refreshing or unavailable" />
    {!usable ? <CompositeSourceFallback state={source.state} label="block groups" /> : <>
      {!groups.data?.blockGroups.length ? <div className="p-6"><EmptyState icon={<Blocks />} title={view === "active" ? "No active block groups" : view === "partial" ? "No partially released groups" : "No block history"}
        description={view === "active" ? "Check Partial for groups that still have some active members, or All for retained history." : "No block groups match this view."} /></div> :
        <div className="divide-y divide-base-300">{groups.data.blockGroups.map((group) => {
          const target = findBlockTargetOption(options, group.target);
          return <div key={group.blockGroupId} tabIndex={group.blockGroupId === focusedBlockGroupId ? -1 : undefined} className={`px-5 py-4 sm:px-6 ${group.blockGroupId === focusedBlockGroupId ? focusedResourceClass : ""}`}>
            <div className="flex items-start justify-between gap-3"><div className="min-w-0">
              <p className="truncate font-semibold">{target?.label ?? manualBlockGroupTargetLabel(group.target)}</p>
              <p className="mt-1 text-xs text-base-content/45">{group.activeBlockCount} active of {group.initialBlockCount} · {formatDate(group.arrival)} to {formatDate(group.departure)}</p>
            </div><button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={() => setDetailsId(group.blockGroupId)} aria-label={`View details for ${target?.label ?? "inventory block group"}`}>Details <ChevronRight size={15} /></button></div>
            <div className="mt-3 flex flex-wrap items-center gap-2"><StatusBadge status={manualBlockGroupStatusLabel(group.status)} />
              {group.replacesGroupId && <span className="badge badge-ghost badge-sm">Replacement</span>}
              <p className="min-w-0 flex-1 break-words rounded-lg bg-base-200 px-3 py-2 text-xs text-base-content/60">{group.reason || "No reason recorded"}</p>
            </div>
          </div>;
        })}</div>}
      <PaginationBar page={page.page} pageSize={groups.data?.pageSize ?? MANUAL_BLOCK_GROUP_PAGE_SIZE} itemCount={groups.data?.blockGroups.length ?? 0} itemLabel="block group"
        hasMore={canAdvanceCursor(page, groups.data?.nextCursor ?? null)} disabled={groups.isFetching}
        onPageChange={(next) => setPage((previous) => next > previous.page ? nextCursorPage(previous, groups.data?.nextCursor ?? null) : previousCursorPage(previous))} />
      {targetId && !groups.data?.blockGroups.some((group) => group.blockGroupId === targetId) && <button type="button" className="btn btn-ghost btn-sm m-3" onClick={() => setDetailsId(targetId)}>View the referenced block group</button>}
    </>}
    {detailsId && <ManualBlockGroupDetailsModal key={detailsId} propertyId={propertyId} blockGroupId={detailsId} propertyName={propertyName} rooms={rooms} canManage={current}
      onReplace={(group) => { if (!current) return; setDetailsId(null); attempt.current = null; setWorkflow({ kind: "replace", group }); }}
      onRelease={(group) => { if (!current) return; setDetailsId(null); releaseAttempt.current = null; setRelease(group); }} onNavigateGroup={setDetailsId} onClose={() => setDetailsId(null)} />}
    {workflow && <ManualBlockGroupWorkflowModal key={workflow.kind === "replace" ? `${workflow.group.blockGroupId}:${workflow.group.version}` : "create"}
      workflow={workflow} propertyId={propertyId} propertyName={propertyName} propertyTimeZoneId={propertyTimeZoneId} rooms={rooms} attemptRef={attempt} authorityCurrent={current}
      onCompleted={(receipt) => void refresh(receipt)} onRefreshRequired={() => void refresh()} onClose={() => setWorkflow(null)} />}
    {release && <ReleaseManualBlockGroupModal key={`${release.blockGroupId}:${release.version}`} group={release} propertyId={propertyId} attemptRef={releaseAttempt} authorityCurrent={current}
      onCompleted={(receipt) => void refresh(receipt)} onRefreshRequired={() => void refresh()} onClose={() => setRelease(null)} />}
  </section>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
}
