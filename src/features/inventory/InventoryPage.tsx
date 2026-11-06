import { useQuery } from "@tanstack/react-query";
import {
  BedDouble,
  CalendarSearch,
  CheckCircle2,
  CircleSlash2,
  DoorOpen,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type {
  RoomInventory,
} from "../../api/types";
import {
  compositeSourceCurrent,
  compositeSourceUsable,
  createCompositeSource,
  type CompositeSource,
  type CompositeSourceState,
} from "../../app/compositeSourceState";
import { permissions, propertyAccessScope, usePermissions } from "../../app/permissions";
import {
  defaultPropertyStayRange,
  validStayDateRange,
  type StayDateRange,
} from "../../app/propertyDate";
import { focusedResourceClass, useScrollToTransientResourceFocus, useTargetProperty, useTransientResourceFocus } from "../../app/resourceFocus";
import { useSession } from "../../app/session";
import { useWorkspace } from "../../app/workspace";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from "../../components/ui/primitives";
import { DatePicker } from "../../components/ui/DatePicker";
import { CompositeSourceFallback, CompositeSourceNotice } from "../../components/ui/CompositeSourceNotice";
import { BlockInventoryModal } from "./BlockInventoryModal";
import { BlockMutationNotice } from "./BlockEditorFrame";
import { useManualBlockEditor } from "./useManualBlockEditor";
import { buildBlockTargetOptions } from "./inventoryBlocking";
import {
  inventoryAvailabilityMatchesContext,
  loadAllManualInventoryBlocks,
  loadAllRoomInventory,
  loadInventoryAvailability,
  manualBlockListMatchesProperty,
  roomInventoryMatchesProperty,
} from "./inventoryApi";
import { sellableInventorySummary } from "./inventorySummary";
import { SalesModeChangeModal, SalesModeNotice } from "./SalesModeChangeModal";
import { useSalesModeEditor } from "./useSalesModeEditor";
import { ManualBlockGroupDirectory } from "./ManualBlockGroupDirectory";
import { sessionIdentityKey } from "../../app/singleFlightRefresh";
import { OwnerOriginLink } from "../spaces/OwnerOriginLink";

export function InventoryPage() {
  const { request, session } = useSession();
  const workspace = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const hasRequestedProperty = searchParams.has("property");
  const requestedPropertyId = searchParams.get("property");
  const selectedPropertyId = hasRequestedProperty
    ? requestedPropertyId ?? ""
    : workspace.selectedPropertyId;
  const selectedProperty = workspace.properties.find(
    (property) => property.propertyId === selectedPropertyId,
  );
  useTargetProperty(hasRequestedProperty ? requestedPropertyId : null);
  const targetArrival = searchParams.get("arrival");
  const targetDeparture = searchParams.get("departure");
  const [range, setRange] = useState<StayDateRange>({ arrival: "", departure: "" });
  const accessScope = session && selectedPropertyId
    ? propertyAccessScope(session.tenantId, selectedPropertyId)
    : "";
  const access = usePermissions(accessScope ? [
    { permission: permissions.inventoryRead, scope: accessScope },
    { permission: permissions.inventoryConfigure, scope: accessScope },
    { permission: permissions.reservationsRead, scope: accessScope },
    { permission: permissions.inventoryBlocksManage, scope: accessScope },
    { permission: permissions.inventoryBlockGroupsManage, scope: accessScope },
  ] : []);
  const mayRead = access.allows(permissions.inventoryRead, accessScope);
  const canConfigure = access.allows(permissions.inventoryConfigure, accessScope);
  const canManageBlocks = access.allows(permissions.inventoryBlocksManage, accessScope);
  const canManageGroups = access.allows(permissions.inventoryBlockGroupsManage, accessScope);
  const permissionSource = createCompositeSource({
    label: "Inventory permissions",
    hasData: access.hasData,
    isLoading: access.isLoading,
    error: access.error,
    isFetching: access.isFetching,
    refetch: access.refetch,
  });
  const propertySource = createCompositeSource({
    label: "Property directory",
    hasData: workspace.propertiesLoaded,
    isLoading: workspace.propertiesLoading,
    error: workspace.propertiesError,
    isFetching: workspace.propertiesFetching,
    refetch: workspace.refetchProperties,
  });
  const permissionsCurrent = compositeSourceCurrent(permissionSource);
  const propertyCurrent = compositeSourceCurrent(propertySource);
  const mayReadCurrent = mayRead && permissionsCurrent && propertyCurrent;
  const enabled = Boolean(selectedPropertyId && selectedProperty && mayReadCurrent);
  const propertyTimeZoneId = selectedProperty?.canonicalTimeZoneId || selectedProperty?.timeZoneId || "";
  const propertyDefaultRange = useMemo(
    () => propertyTimeZoneId ? defaultPropertyStayRange(propertyTimeZoneId) : null,
    [propertyTimeZoneId],
  );

  const inventory = useQuery({
    queryKey: ["inventory-rooms", selectedPropertyId],
    queryFn: ({ signal }) => loadAllRoomInventory(request, selectedPropertyId!, signal),
    enabled,
  });
  const availability = useQuery({
    queryKey: ["availability", selectedPropertyId, range.arrival, range.departure],
    queryFn: ({ signal }) => loadInventoryAvailability(
      request,
      selectedPropertyId,
      range.arrival,
      range.departure,
      signal,
    ),
    enabled: enabled && validStayDateRange(range),
  });
  const blocks = useQuery({
    queryKey: ["blocks", selectedPropertyId, "active", range.arrival, range.departure],
    queryFn: ({ signal }) => loadAllManualInventoryBlocks(
      request,
      selectedPropertyId!,
      false,
      signal,
      { from: range.arrival, to: range.departure },
    ),
    enabled: enabled && validStayDateRange(range),
  });
  const inventoryContextMismatch = Boolean(
    inventory.data && !roomInventoryMatchesProperty(inventory.data.rooms, selectedPropertyId),
  );
  const availabilityContextMismatch = !inventoryAvailabilityMatchesContext(
    availability.data,
    selectedPropertyId,
    range.arrival,
    range.departure,
  );
  const blockContextMismatch = Boolean(
    blocks.data && !manualBlockListMatchesProperty(blocks.data.blocks, selectedPropertyId),
  );
  const inventorySource = createCompositeSource({
    label: "Sales setup",
    hasData: inventory.data !== undefined && !inventoryContextMismatch,
    isLoading: inventory.isLoading,
    error: inventoryContextMismatch
      ? new Error("The sales setup response did not match the selected property.")
      : inventory.error,
    isFetching: inventory.isFetching,
    refetch: () => inventory.refetch(),
  });
  const availabilitySource = createCompositeSource({
    label: "Availability",
    hasData: availability.data !== undefined && !availabilityContextMismatch,
    isLoading: availability.isLoading,
    error: availabilityContextMismatch
      ? new Error("The availability response did not match the selected property and dates.")
      : availability.error,
    isFetching: availability.isFetching,
    refetch: () => availability.refetch(),
  });
  const blockSource = createCompositeSource({
    label: "Inventory blocks",
    hasData: blocks.data !== undefined && !blockContextMismatch,
    isLoading: blocks.isLoading,
    error: blockContextMismatch
      ? new Error("The block response did not match the selected property.")
      : blocks.error,
    isFetching: blocks.isFetching,
    refetch: () => blocks.refetch(),
  });
  const primarySources = [permissionSource, propertySource, inventorySource, availabilitySource, blockSource];
  const inventoryUsable = compositeSourceUsable(inventorySource.state);
  const availabilityUsable = compositeSourceUsable(availabilitySource.state);
  const blocksUsable = compositeSourceUsable(blockSource.state);
  const inventoryCurrent = compositeSourceCurrent(inventorySource);
  const blocksCurrent = compositeSourceCurrent(blockSource);
  const rooms = inventoryUsable ? inventory.data?.rooms ?? [] : [];
  const targetUnitId = searchParams.get("unit");
  const targetRoomId = searchParams.get("room")
    ?? rooms.find((room) => room.units.some((unit) => unit.inventoryUnitId === targetUnitId))?.roomId
    ?? null;
  const requestedRoomMissing = Boolean(targetRoomId && inventoryUsable && !inventoryContextMismatch
    && !rooms.some((room) => room.roomId === targetRoomId));
  const targetBlockGroupId = searchParams.get("blockGroup");
  const focusedTargetReady = targetBlockGroupId ? blocksUsable : inventoryUsable && !requestedRoomMissing;
  const focusedResourceId = useTransientResourceFocus(focusedTargetReady);
  const focusedRoomId = focusedResourceId && (
    focusedResourceId === targetRoomId ||
    focusedResourceId === targetUnitId
  ) ? targetRoomId : null;
  const focusedBlockGroupId = focusedResourceId === targetBlockGroupId ? targetBlockGroupId : null;
  useScrollToTransientResourceFocus(focusedResourceId, focusedTargetReady);
  const targetOptions = useMemo(
    () => buildBlockTargetOptions(selectedProperty?.name ?? "Property", rooms),
    [rooms, selectedProperty?.name],
  );
  useEffect(() => {
    const targetedRange = targetArrival && targetDeparture
      ? { arrival: targetArrival, departure: targetDeparture }
      : null;
    const nextRange = validStayDateRange(targetedRange)
      ? targetedRange
      : propertyDefaultRange;
    if (!nextRange) {
      setRange({ arrival: "", departure: "" });
      return;
    }
    setRange((current) => current.arrival === nextRange.arrival && current.departure === nextRange.departure
      ? current
      : nextRange);
  }, [propertyDefaultRange, selectedPropertyId, targetArrival, targetDeparture]);

  function setAvailabilityRange(nextRange: StayDateRange) {
    if (!validStayDateRange(nextRange)) return;
    setRange(nextRange);
    const next = new URLSearchParams(searchParams);
    next.set("arrival", nextRange.arrival);
    next.set("departure", nextRange.departure);
    setSearchParams(next, { replace: true });
  }

  const salesEditor = useSalesModeEditor({
    evidence: { propertyId: selectedPropertyId, rooms, mayRead, mayConfigure: canConfigure, permissionsCurrent, propertyCurrent, inventoryCurrent },
    selectionKey: [targetRoomId ?? "", targetUnitId ?? ""].join(":"),
    refreshAuthority: () => Promise.all([access.refetch(), workspace.refetchProperties()]),
  });
  const blockEditor = useManualBlockEditor({
    propertyId: selectedPropertyId,
    propertyName: selectedProperty?.name ?? "Property",
    rooms,
    blocks: blocks.data?.blocks ?? [],
    mayManage: mayRead && canManageBlocks,
    mayManageGroups: mayRead && canManageGroups,
    evidence: { permissionsCurrent, propertyCurrent, inventoryCurrent, blocksCurrent },
    onSuccess: ({ action, receipt }) => setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("property", receipt.propertyId);
      next.set("blockGroup", receipt.blockGroupId);
      next.set("focus", receipt.blockGroupId);
      if (action === "released") next.set("history", "all");
      return next;
    }),
  });

  if (!selectedProperty) {
    return (
      <InventoryPageFrame>
        <EmptyState icon={<DoorOpen />} title="Choose a property first" description="Inventory is managed within a property. Create or select one to continue." />
      </InventoryPageFrame>
    );
  }
  if (!access.hasData) {
    return (
      <InventoryPageFrame>
        <PageHeader eyebrow={selectedProperty.name} title="Inventory" description="Control how rooms are sold, check availability, and take physical areas out of service." />
        <section className="overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-sm">
          {access.error
            ? <div className="p-4 sm:p-6"><ErrorState error={access.error} retry={() => void access.refetch()} title="Inventory access could not be checked" /></div>
            : <LoadingState label="Checking inventory access" />}
        </section>
      </InventoryPageFrame>
    );
  }
  if (!mayRead) {
    return (
      <InventoryPageFrame>
        <PageHeader eyebrow={selectedProperty.name} title="Inventory" description="Control how rooms are sold, check availability, and take physical areas out of service." />
        <section className="overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-sm">
          <EmptyState
            icon={<ShieldCheck />}
            title="Inventory access is not assigned"
            description="Ask a workspace administrator for inventory read access to this property."
          />
        </section>
      </InventoryPageFrame>
    );
  }
  const availableCount = availabilityUsable
    ? availability.data?.units.filter((item) => item.isAvailable).length ?? 0
    : 0;
  const unavailableCount = availabilityUsable
    ? availability.data?.units.filter((item) => !item.isAvailable).length ?? 0
    : 0;

  return (
    <InventoryPageFrame>
      <PageHeader
        eyebrow={selectedProperty.name}
        title="Inventory"
        description="Control how rooms are sold, check availability, and take physical areas out of service."
        action={canManageBlocks || canManageGroups ? (
          <button
            className="btn btn-primary"
            onClick={(event) => blockEditor.openCreate(event.currentTarget)}
            disabled={!blockEditor.ready || !targetOptions.length || Boolean(blockEditor.editor) || blockEditor.busy}
          >
            <Plus size={17} />
            Block inventory
          </button>
        ) : undefined}
      />

      <CompositeSourceNotice sources={primarySources} title="Some inventory data is delayed" />
      {requestedRoomMissing && <div role="status" className="mb-4 space-y-2 rounded-lg border border-base-300 bg-base-100 p-4 text-sm">
        <p>The requested room is not in the current inventory. It may still be updating. Refresh to check again.</p>
      </div>}
      <BlockMutationNotice notice={blockEditor.notice} />
      <SalesModeNotice notice={salesEditor.notice} />

      <AvailabilitySection
        range={range}
        timeZoneId={propertyTimeZoneId}
        source={availabilitySource}
        authorityCurrent={mayReadCurrent}
        onRangeChange={setAvailabilityRange}
        availableCount={availableCount}
        unavailableCount={unavailableCount}
        totalCount={availabilityUsable ? availability.data?.units.length ?? 0 : 0}
      />

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.35fr_1fr]">
        <SalesSetupSection
          rooms={rooms}
          state={inventorySource.state}
          focusedRoomId={focusedRoomId}
          canConfigure={canConfigure}
          configurationCurrent={permissionsCurrent && propertyCurrent && inventoryCurrent}
          canEditRoom={salesEditor.canOpen}
          pending={salesEditor.busy || Boolean(salesEditor.target)}
          onEdit={(room, trigger) => salesEditor.open(room, trigger, searchParams)}
          mayRefresh={mayReadCurrent}
          refreshing={inventory.isFetching || availability.isFetching}
          onRefresh={() => {
            if (!mayReadCurrent || inventory.isFetching || availability.isFetching) return;
            void Promise.all([inventory.refetch(), ...(validStayDateRange(range) ? [availability.refetch()] : [])]);
          }}
        />

        <ManualBlockGroupDirectory key={`${sessionIdentityKey(session)}:${selectedPropertyId}`}
          propertyId={selectedPropertyId} propertyName={selectedProperty.name} propertyTimeZoneId={propertyTimeZoneId}
          rooms={rooms} mayReadCurrent={mayReadCurrent} mayManage={canManageGroups} mayManageIndividual={canManageBlocks}
          sources={[permissionSource, propertySource, inventorySource, blockSource]} focusedBlockGroupId={focusedBlockGroupId} />
      </div>

      <BlockInventoryModal
        editor={blockEditor}
        initialRange={range}
        sources={[permissionSource, propertySource, inventorySource, blockSource]}
      />
      <SalesModeChangeModal editor={salesEditor} mayReadReservations={permissionsCurrent && access.allows(permissions.reservationsRead, accessScope)} />
    </InventoryPageFrame>
  );
}

function InventoryPageFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <OwnerOriginLink />
      {children}
    </>
  );
}

function AvailabilitySection({
  range,
  timeZoneId,
  source,
  authorityCurrent,
  onRangeChange,
  availableCount,
  unavailableCount,
  totalCount,
}: {
  range: StayDateRange;
  timeZoneId: string;
  source: CompositeSource;
  authorityCurrent: boolean;
  onRangeChange: (range: StayDateRange) => void;
  availableCount: number;
  unavailableCount: number;
  totalCount: number;
}) {
  const [arrival, setArrival] = useState(range.arrival);
  const [departure, setDeparture] = useState(range.departure);

  useEffect(() => {
    setArrival(range.arrival);
    setDeparture(range.departure);
  }, [range.arrival, range.departure]);
  const draftRange = { arrival, departure };
  const canCheck = authorityCurrent && validStayDateRange(draftRange);

  return (
    <section className="card border border-base-300 bg-base-100 shadow-sm">
      <div className="flex flex-col gap-4 border-b border-base-300 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <h2 className="font-display text-xl font-semibold">Availability check</h2>
          <p className="mt-1 text-sm text-base-content/50">See what can be assigned for a stay range.</p>
          {timeZoneId && <p className="mt-1 text-xs text-base-content/40">Property time · {timeZoneId}</p>}
        </div>
        <form
          className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (canCheck) onRangeChange(draftRange);
          }}
        >
          <DatePicker value={arrival} onChange={setArrival} ariaLabel="Arrival date" size="sm" className="w-full sm:w-44" required />
          <span className="hidden self-center text-base-content/30 sm:block">to</span>
          <DatePicker value={departure} onChange={setDeparture} ariaLabel="Departure date" min={arrival} size="sm" className="w-full sm:w-44" required />
          <button className="btn btn-secondary btn-sm shrink-0 text-white" disabled={!canCheck}><CalendarSearch size={16} />Check</button>
        </form>
      </div>
      {source.state === "loading" ? (
        <LoadingState label="Checking availability" />
      ) : !compositeSourceUsable(source.state) ? (
        <CompositeSourceFallback state={source.state} label="availability" />
      ) : (
        <div className="grid gap-px overflow-hidden border-t border-base-300 bg-base-300 sm:grid-cols-3">
          <AvailabilityStat icon={<CheckCircle2 />} label="Available" value={availableCount} tone="success" />
          <AvailabilityStat icon={<CircleSlash2 />} label="Unavailable" value={unavailableCount} tone="error" />
          <AvailabilityStat icon={<BedDouble />} label="Total sellable" value={totalCount} tone="primary" />
        </div>
      )}
    </section>
  );
}

function SalesSetupSection({
  rooms,
  state,
  focusedRoomId,
  canConfigure,
  configurationCurrent,
  canEditRoom,
  pending,
  onEdit,
  mayRefresh,
  refreshing,
  onRefresh,
}: {
  rooms: RoomInventory[];
  state: CompositeSourceState;
  focusedRoomId: string | null;
  canConfigure: boolean;
  configurationCurrent: boolean;
  canEditRoom: (room: RoomInventory) => boolean;
  pending: boolean;
  onEdit: (room: RoomInventory, trigger: HTMLElement) => void;
  mayRefresh: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <section data-sales-region className="card border border-base-300 bg-base-100 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-base-300 px-5 py-5 sm:px-6">
        <h2 className="font-display text-xl font-semibold">Sales setup</h2>
        <button type="button" className="btn btn-outline btn-sm" disabled={!mayRefresh || refreshing || pending}
          onClick={onRefresh}>Refresh room inventory</button>
      </div>
      {!compositeSourceUsable(state) ? (
        <CompositeSourceFallback state={state} label="sales setup" />
      ) : rooms.length === 0 ? (
        <div className="p-3 sm:p-4">
          <EmptyState icon={<DoorOpen />} title="No rooms available" description="Set up rooms and beds in Properties before configuring inventory." />
        </div>
      ) : (
        <div className="divide-y divide-base-300">
          {rooms.map((room) => {
            const mode = normalizeSalesMode(room.salesMode);
            const location = [room.buildingLabel, room.floorLabel].filter(Boolean).join(" / ");
            return (
              <div key={room.roomId} tabIndex={room.roomId === focusedRoomId ? -1 : undefined} className={`flex flex-col gap-4 px-5 py-4 outline-none sm:flex-row sm:items-center sm:justify-between sm:px-6 ${room.roomId === focusedRoomId ? focusedResourceClass : ""}`}>
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary/15 text-secondary"><DoorOpen size={18} /></div>
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-normal break-words font-semibold leading-5">{room.roomName}</p>
                    <p className="mt-1 whitespace-normal break-words text-xs leading-4 text-base-content/45">
                      {[location, sellableInventorySummary(room.units)].filter(Boolean).join(" - ")}
                    </p>
                  </div>
                </div>
                <div className="flex min-w-0 flex-col items-start gap-2 sm:shrink-0 sm:flex-row sm:items-center sm:gap-3">
                  <SalesModeBadge mode={mode} />
                  {canConfigure && (
                    <button type="button" className="btn btn-outline btn-sm" disabled={pending || !configurationCurrent || !canEditRoom(room)} onClick={(event) => onEdit(room, event.currentTarget)}>Change selling setup</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AvailabilityStat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "success" | "error" | "primary";
}) {
  const tones = {
    success: "bg-success/12 text-success",
    error: "bg-error/12 text-error",
    primary: "bg-primary/12 text-primary",
  };
  return (
    <div className="flex min-h-20 items-center gap-4 bg-base-100 px-5 py-4 sm:px-6">
      <div className={`grid size-11 place-items-center rounded-lg ${tones[tone]}`}>{icon}</div>
      <div>
        <p className="text-2xl font-semibold">{value}</p>
        <p className="text-xs text-base-content/45">{label}</p>
      </div>
    </div>
  );
}

function SalesModeBadge({ mode }: { mode: "unconfigured" | "roomLevel" | "bedLevel" }) {
  if (mode === "roomLevel") {
    return <span className="badge badge-sm whitespace-nowrap border-0 bg-secondary font-semibold text-white">Whole room</span>;
  }
  if (mode === "bedLevel") {
    return <span className="badge badge-sm whitespace-nowrap border-0 bg-primary font-semibold text-white">Individual beds</span>;
  }
  return <span className="badge badge-sm whitespace-nowrap border-0 bg-warning-content font-semibold text-white">Not configured</span>;
}

function normalizeSalesMode(value: RoomInventory["salesMode"]): "unconfigured" | "roomLevel" | "bedLevel" {
  if (value === 2 || String(value).toLowerCase() === "roomlevel") return "roomLevel";
  if (value === 3 || String(value).toLowerCase() === "bedlevel") return "bedLevel";
  return "unconfigured";
}
