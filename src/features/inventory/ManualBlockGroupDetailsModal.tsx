import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Blocks, History, RefreshCw, Repeat2, Unlock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ManualBlock, ManualBlockGroup, RoomInventory } from "../../api/types";
import { manualBlockStatusLabel } from "../../api/labels";
import { useSession } from "../../app/session";
import { PaginationBar } from "../../components/ui/PaginationBar";
import { ErrorState, LoadingState, Modal, ModalActions, StatusBadge } from "../../components/ui/primitives";
import { canAdvanceCursor, initialCursorPage, nextCursorPage, previousCursorPage, type CursorPageState } from "./cursorPaging";
import { buildBlockTargetOptions, findBlockTargetOption } from "./inventoryBlocking";
import { getManualBlockGroup, loadManualBlockGroupMemberPage, MANUAL_BLOCK_GROUP_PAGE_SIZE } from "./inventoryApi";
import { manualBlockGroupStatusLabel, manualBlockGroupTargetLabel } from "./manualBlockGroupWorkflow";
import { BlockReleaseForm } from "./BlockReleaseForm";
import { useManualBlockEditor } from "./useManualBlockEditor";

export function ManualBlockGroupDetailsModal({
  blockGroupId,
  propertyId,
  propertyName,
  rooms,
  canManage,
  canManageIndividual,
  onReplace,
  onRelease,
  onNavigateGroup,
  onClose,
}: {
  blockGroupId: string;
  propertyId: string;
  propertyName: string;
  rooms: RoomInventory[];
  canManage: boolean;
  canManageIndividual: boolean;
  onReplace: (group: ManualBlockGroup) => void;
  onRelease: (group: ManualBlockGroup) => void;
  onNavigateGroup: (blockGroupId: string) => void;
  onClose: () => void;
}) {
  const { request } = useSession();
  const [memberPage, setMemberPage] = useState(initialCursorPage);
  useEffect(() => setMemberPage(initialCursorPage()), [blockGroupId]);

  const group = useQuery({
    queryKey: ["inventory-block-group", propertyId, blockGroupId],
    queryFn: ({ signal }) => getManualBlockGroup(request, propertyId, blockGroupId, signal),
  });
  const members = useQuery({
    queryKey: ["inventory-block-group-members", propertyId, blockGroupId, memberPage.cursor],
    queryFn: ({ signal }) => loadManualBlockGroupMemberPage(
      request,
      propertyId,
      blockGroupId,
      memberPage.cursor,
      signal,
    ),
  });
  const options = useMemo(() => buildBlockTargetOptions(propertyName, rooms), [propertyName, rooms]);
  const unitDirectory = useMemo(() => new Map(rooms.flatMap((room) => room.units.map((unit) => [
    unit.inventoryUnitId,
    { roomName: room.roomName, unitLabel: unit.label },
  ] as const))), [rooms]);

  return (
    <Modal
      open
      size="lg"
      title="Inventory block group"
      description="Authoritative definition, lineage, member state, and actor provenance."
      onClose={onClose}
    >
      {group.isLoading ? <LoadingState label="Loading block group" /> : group.error ? (
        <ErrorState error={group.error} retry={() => group.refetch()} title="Couldn't load the block group" />
      ) : group.data ? (
        <GroupDetails
          group={group.data}
          targetOption={findBlockTargetOption(options, group.data.target)}
          unitDirectory={unitDirectory}
          members={members.data?.blocks ?? []}
          membersLoading={members.isLoading}
          membersError={members.error}
          memberPage={memberPage}
          memberPageSize={members.data?.pageSize ?? MANUAL_BLOCK_GROUP_PAGE_SIZE}
          nextMemberCursor={members.data?.nextCursor ?? null}
          canManage={canManage && !group.isFetching && !group.error && !members.isFetching && !members.error}
          canManageIndividual={canManageIndividual && !group.isFetching && !group.error && !members.isFetching && !members.error}
          propertyName={propertyName}
          rooms={rooms}
          onMemberPageChange={(page) => setMemberPage((current) => page > current.page
            ? nextCursorPage(current, members.data?.nextCursor ?? null)
            : previousCursorPage(current))}
          onRetryMembers={() => members.refetch()}
          onReplace={() => onReplace(group.data!)}
          onRelease={() => onRelease(group.data!)}
          onNavigateGroup={onNavigateGroup}
          onClose={onClose}
        />
      ) : null}
    </Modal>
  );
}

function GroupDetails({
  group,
  targetOption,
  unitDirectory,
  members,
  membersLoading,
  membersError,
  memberPage,
  memberPageSize,
  nextMemberCursor,
  canManage,
  canManageIndividual,
  propertyName,
  rooms,
  onMemberPageChange,
  onRetryMembers,
  onReplace,
  onRelease,
  onNavigateGroup,
  onClose,
}: {
  group: ManualBlockGroup;
  targetOption: ReturnType<typeof findBlockTargetOption>;
  unitDirectory: Map<string, { roomName: string; unitLabel: string }>;
  members: ManualBlock[];
  membersLoading: boolean;
  membersError: Error | null;
  memberPage: CursorPageState;
  memberPageSize: number;
  nextMemberCursor: string | null;
  canManage: boolean;
  canManageIndividual: boolean;
  propertyName: string;
  rooms: RoomInventory[];
  onMemberPageChange: (page: number) => void;
  onRetryMembers: () => void;
  onReplace: () => void;
  onRelease: () => void;
  onNavigateGroup: (blockGroupId: string) => void;
  onClose: () => void;
}) {
  const open = group.status === 1 || group.status === 2;
  const [individual, setIndividual] = useState<{ blockId: string; trigger: HTMLElement } | null>(null);
  const selectedMember = members.find(member => member.blockId === individual?.blockId);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-semibold">{targetOption?.label ?? manualBlockGroupTargetLabel(group.target)}</p>
          <p className="mt-1 text-sm text-base-content/55">{targetOption?.detail ?? `${group.initialBlockCount} inventory units`}</p>
        </div>
        <StatusBadge status={manualBlockGroupStatusLabel(group.status)} />
      </div>

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DetailValue label="Stay range" value={`${formatDate(group.arrival)} – ${formatDate(group.departure)}`} />
        <DetailValue label="Initial members" value={String(group.initialBlockCount)} />
        <DetailValue label="Active members" value={String(group.activeBlockCount)} />
        <DetailValue label="Version" value={String(group.version)} />
      </dl>

      <div className="rounded-lg bg-base-200 p-4 text-sm">
        <p className="font-semibold">Reason</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-base-content/65">{group.reason || "No reason recorded"}</p>
      </div>

      {(group.replacesGroupId || group.replacedByGroupId) && (
        <section className="rounded-lg border border-base-300 p-4">
          <div className="flex items-center gap-2"><History size={17} className="text-primary" /><h3 className="font-semibold">Replacement lineage</h3></div>
          <div className="mt-3 flex flex-wrap gap-2">
            {group.replacesGroupId && (
              <button type="button" className="btn btn-outline btn-sm" onClick={() => onNavigateGroup(group.replacesGroupId!)}>
                Previous {shortId(group.replacesGroupId)}
              </button>
            )}
            {group.replacedByGroupId && (
              <button type="button" className="btn btn-outline btn-sm" onClick={() => onNavigateGroup(group.replacedByGroupId!)}>
                Successor {shortId(group.replacedByGroupId)} <ArrowRight size={15} />
              </button>
            )}
          </div>
        </section>
      )}

      <section className="rounded-lg border border-base-300">
        <div className="flex items-center justify-between gap-3 border-b border-base-300 px-4 py-3">
          <div className="flex items-center gap-2"><Blocks size={17} className="text-primary" /><h3 className="font-semibold">Members</h3></div>
          <span className="text-xs text-base-content/45">Exact persisted state</span>
        </div>
        {membersLoading ? <LoadingState label="Loading group members" /> : membersError ? (
          <div className="p-4"><ErrorState error={membersError} retry={onRetryMembers} title="Couldn't load group members" /></div>
        ) : members.length ? (
          <>
            <ul className="divide-y divide-base-300">
              {members.map((member) => {
                const resolved = unitDirectory.get(member.inventoryUnitId);
                return (
                  <li key={member.blockId} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{resolved?.unitLabel ?? `Unit ${shortId(member.inventoryUnitId)}`}</span>
                      <span className="mt-0.5 block truncate text-xs text-base-content/50">{resolved?.roomName ?? `Inventory ID ${shortId(member.inventoryUnitId)}`}</span>
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusBadge status={capitalize(manualBlockStatusLabel(member.status))} />
                      {canManageIndividual && manualBlockStatusLabel(member.status) === "active" && (
                        <button type="button" className="btn btn-ghost btn-sm text-primary"
                          disabled={individual !== null}
                          onClick={event => setIndividual({ blockId: member.blockId, trigger: event.currentTarget })}>
                          <Unlock size={15} />Release {resolved?.unitLabel ?? `unit ${shortId(member.inventoryUnitId)}`}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <PaginationBar
              page={memberPage.page}
              pageSize={memberPageSize}
              itemCount={members.length}
              itemLabel="member"
              hasMore={canAdvanceCursor(memberPage, nextMemberCursor)}
              onPageChange={onMemberPageChange}
            />
          </>
        ) : <p className="px-4 py-8 text-center text-sm text-base-content/50">No persisted members were returned.</p>}
      </section>

      {individual && <IndividualBlockRelease key={individual.blockId}
        member={selectedMember} propertyId={group.propertyId} propertyName={propertyName} rooms={rooms}
        authorityCurrent={canManageIndividual} trigger={individual.trigger}
        onCompleted={() => { setIndividual(null); onRetryMembers(); }} onClose={() => setIndividual(null)} />}

      <section className="grid gap-3 text-xs text-base-content/55 sm:grid-cols-2">
        <p><span className="font-semibold text-base-content/75">Created:</span> {formatTimestamp(group.createdAtUtc)} by {group.createdByActorId || "unknown actor"}</p>
        <p><span className="font-semibold text-base-content/75">Last changed:</span> {group.updatedAtUtc ? formatTimestamp(group.updatedAtUtc) : "never"}{group.lastModifiedByActorId ? ` by ${group.lastModifiedByActorId}` : ""}</p>
      </section>

      <ModalActions>
        <button type="button" className="btn btn-ghost btn-sm sm:btn-md" onClick={onClose}>Close</button>
        {canManage && open && (
          <>
            <button type="button" className="btn btn-outline btn-sm sm:btn-md" onClick={onReplace}><Repeat2 size={16} />Replace</button>
            <button type="button" className="btn btn-error btn-sm text-white sm:btn-md" onClick={onRelease}><Unlock size={16} />Release</button>
          </>
        )}
        {!open && <button type="button" className="btn btn-outline btn-sm sm:btn-md" onClick={onRetryMembers}><RefreshCw size={16} />Refresh members</button>}
      </ModalActions>
    </div>
  );
}

function IndividualBlockRelease({ member, propertyId, propertyName, rooms, authorityCurrent, trigger, onCompleted, onClose }: {
  member: ManualBlock | undefined; propertyId: string; propertyName: string; rooms: RoomInventory[];
  authorityCurrent: boolean; trigger: HTMLElement; onCompleted: () => void; onClose: () => void;
}) {
  const editor = useManualBlockEditor({ propertyId, propertyName, rooms, blocks: member ? [member] : [],
    mayManage: authorityCurrent, mayManageGroups: false,
    evidence: { permissionsCurrent: authorityCurrent, propertyCurrent: authorityCurrent, inventoryCurrent: authorityCurrent, blocksCurrent: authorityCurrent },
    onSuccess: onCompleted });
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!member || !authorityCurrent) { onClose(); return; }
    if (opened) return;
    const unit = rooms.flatMap(room => room.units).find(unit => unit.inventoryUnitId === member.inventoryUnitId);
    editor.openRelease(member.blockGroupId, unit?.label ?? "inventory unit", "Release only this selected inventory unit.", trigger);
    setOpened(true);
  }, [opened, member, authorityCurrent, rooms, editor, trigger, onClose]);
  useEffect(() => { if (opened && !editor.editor) onClose(); }, [opened, editor.editor, onClose]);
  return <BlockReleaseForm editor={editor} />;
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-base-200 p-4"><dt className="text-xs font-semibold uppercase tracking-wide text-base-content/45">{label}</dt><dd className="mt-1 break-words text-sm font-semibold">{value}</dd></div>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 8) : value;
}

function capitalize(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
