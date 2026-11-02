import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../api/client";
import type { Bed, Room, RoomInventory } from "../../api/types";
import {
  AlertTriangle,
  ArrowLeft,
  Blocks,
  Building2,
  DoorOpen,
  Layers3,
  LoaderCircle,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  compositeSourceCurrent,
  compositeSourceNeedsRetry,
  compositeSourceUsable,
  createCompositeSource,
  type CompositeSource,
} from "../../app/compositeSourceState";
import {
  permissions,
  propertyAccessScope,
  usePermissions,
} from "../../app/permissions";
import {
  defaultPropertyStayRange,
  validStayDateRange,
  type StayDateRange,
} from "../../app/propertyDate";
import {
  useScrollToTransientResourceFocus,
  useTargetProperty,
  useTransientResourceFocus,
} from "../../app/resourceFocus";
import { useSession } from "../../app/session";
import { sessionIdentityKey } from "../../app/singleFlightRefresh";
import { useWorkspace } from "../../app/workspace";
import {
  Modal,
  EmptyState,
  LoadingState,
  PageHeader,
  StatusBadge,
} from "../../components/ui/primitives";
import {
  CompositeSourceFallback,
  CompositeSourceNotice,
} from "../../components/ui/CompositeSourceNotice";
import {
  loadAllManualInventoryBlocks,
  loadAllRoomInventory,
  loadInventoryAvailability,
  roomInventoryMatchesProperty,
  manualBlockListMatchesProperty,
} from "../inventory/inventoryApi";
import { OperationalOriginLink } from "../operational-preview/OperationalOriginLink";
import {
  loadAllBeds,
  loadAllRooms,
  bedListMatchesContext,
  roomListMatchesProperty,
} from "../properties/propertiesApi";
import { useTopologyEditor, type TopologyEditor } from "../properties/useTopologyEditor";
import { TopologyEditorForm, TopologyMutationNotice } from "../properties/TopologyEditorForm";
import {
  buildSpacesRooms,
  buildSpacesUnits,
  resolveSpacesRoomSelection,
  resolveSpacesUnitSelection,
  type SpacesEvidenceState,
  type SpacesRoom,
  type SpacesUnit,
} from "./spacesLayout";
import {
  buildSpacesAvailability,
} from "./spacesAvailability";
import { buildSpacesBlockGroups, resolveSpacesBlockTarget } from "./spacesBlocks";
import { SpacesBlocksContent } from "./SpacesBlocksSection";
import { useManualBlockEditor } from "../inventory/useManualBlockEditor";
import { SpacesRoomWorkspace } from "./SpacesRoomWorkspace";
import { spacesBlockSuccessParams, spacesHasCurrentAllocation, spacesRelevantHolds, spacesUnitAvailability } from "./spacesWorkspace";
import { SpacesPropertySection } from "./SpacesPropertySection";
import { withSpacesReturnRoute, type SpacesReturnRoute } from "./spacesReturnRoute";
import { useSalesModeEditor, type SalesModeEditor } from "../inventory/useSalesModeEditor";
import { SalesModeChangeModal, SalesModeNotice } from "../inventory/SalesModeChangeModal";
import { salesModeLabel } from "../inventory/salesModeEditorModel";
import { useTopologyRetirementEditor, type TopologyRetirementEditor } from "../properties/useTopologyRetirementEditor";
import { TopologyRetirementPanel } from "../properties/TopologyRetirementPanel";
import { parseRetirementReturn, withRetirementReturn } from "../properties/topologyRetirementRoutes";
import { parsePropertyRetirementReturn } from "../properties/propertyRetirementRoutes";
import { OwnerOriginLink } from "./OwnerOriginLink";
import {
  parseSpacesSection,
  spacesContextIssue,
  spacesFocusedBackParams,
  spacesNavigationLabel,
  type SpacesEditorNavigationState,
  withSpacesFocusedSurface,
} from "./spacesSectionRoute";
import { useSpacesNavigationGuard, type SpacesNavigationGuard } from "./useSpacesNavigationGuard";
import { useSpacesRetryFocus } from "./useSpacesRetryFocus";

export function SpacesPage() {
  const navigation = useSpacesNavigationGuard();
  return <SpacesWorkspace key={navigation.editorKey} navigation={navigation} />;
}

function SpacesWorkspace({ navigation }: { navigation: SpacesNavigationGuard }) {
  const { request, session } = useSession();
  const workspace = useWorkspace();
  const { params: searchParams, setParams: setSearchParams } = navigation;
  const [propertyNavigation, setPropertyNavigation] = useState<SpacesEditorNavigationState>({ engaged: false, pending: false, label: "Property settings", authorityLost: false });
  const propertyEditorEngaged = propertyNavigation.engaged;
  const section = parseSpacesSection(searchParams);
  const routeIssue = spacesContextIssue(searchParams);
  const hasRequestedProperty = searchParams.has("property");
  const hasRequestedRoom = searchParams.has("room");
  const hasRequestedBed = searchParams.has("bed");
  const hasRequestedUnit = searchParams.has("unit");
  const requestedPropertyId = searchParams.get("property");
  const requestedRoomId = searchParams.get("room");
  const requestedBedId = searchParams.get("bed");
  const requestedUnitId = searchParams.get("unit");
  useTargetProperty(hasRequestedProperty ? requestedPropertyId : null);

  const targetPropertyId = hasRequestedProperty
    ? requestedPropertyId ?? ""
    : workspace.selectedPropertyId;
  const targetProperty = workspace.properties.find(
    (property) => property.propertyId === targetPropertyId,
  ) ?? null;
  const propertyScope = session && targetPropertyId && !routeIssue
    ? propertyAccessScope(session.tenantId, targetPropertyId)
    : "";
  const access = usePermissions(propertyScope ? [
    { permission: permissions.propertiesRead, scope: propertyScope },
    { permission: permissions.propertiesManage, scope: propertyScope },
    { permission: permissions.propertyTimeZonesManage, scope: propertyScope },
    { permission: permissions.roomsManage, scope: propertyScope },
    { permission: permissions.bedsManage, scope: propertyScope },
    { permission: permissions.inventoryRead, scope: propertyScope },
    { permission: permissions.inventoryConfigure, scope: propertyScope },
    { permission: permissions.reservationsRead, scope: propertyScope },
    { permission: permissions.inventoryBlocksManage, scope: propertyScope },
    { permission: permissions.inventoryBlockGroupsManage, scope: propertyScope },
    { permission: permissions.inventoryRetire, scope: propertyScope },
  ] : []);
  const mayReadProperties = access.allows(permissions.propertiesRead, propertyScope);
  const mayManageIdentity = access.allows(permissions.propertiesManage, propertyScope);
  const mayManageTimeZone = access.allows(permissions.propertyTimeZonesManage, propertyScope);
  const mayManageRooms = access.allows(permissions.roomsManage, propertyScope);
  const mayManageBeds = access.allows(permissions.bedsManage, propertyScope);
  const mayRetireInventory = access.allows(permissions.inventoryRetire, propertyScope);
  const mayReadInventory = access.allows(permissions.inventoryRead, propertyScope);
  const mayConfigureInventory = access.allows(permissions.inventoryConfigure, propertyScope);
  const mayManageIndividualBlocks = access.allows(permissions.inventoryBlocksManage, propertyScope);
  const mayManageBlockGroups = access.allows(permissions.inventoryBlockGroupsManage, propertyScope);
  const mayManageBlocks = mayManageIndividualBlocks || mayManageBlockGroups;
  const permissionSource = createCompositeSource({
    label: "Spaces permissions",
    hasData: access.hasData,
    isLoading: access.isLoading,
    error: access.error,
    isFetching: access.isFetching,
    refetch: access.refetch,
  });
  const permissionCurrent = compositeSourceCurrent(permissionSource);
  const propertySource = createCompositeSource({
    label: "Property directory",
    hasData: workspace.propertiesLoaded,
    isLoading: workspace.propertiesLoading,
    error: workspace.propertiesError,
    isFetching: workspace.propertiesFetching,
    refetch: permissionCurrent ? workspace.refetchProperties : access.refetch,
  });
  const propertyCatalogueUsable = compositeSourceUsable(propertySource.state);
  const canLoadProperty = Boolean(
    targetPropertyId
    && !routeIssue
    && targetProperty
    && permissionCurrent
    && mayReadProperties,
  );
// Legacy section values remain valid deep links; their operational sources now share one workspace.
  const layoutOpen = true;
  const availabilityOpen = true;
  const blocksOpen = true;

  const roomsQuery = useQuery({
    queryKey: ["rooms", targetPropertyId],
    queryFn: (context) => loadAllRooms(request, targetPropertyId, context.signal),
    enabled: canLoadProperty && layoutOpen,
  });
  const roomsMismatch = Boolean(roomsQuery.data && !roomListMatchesProperty(roomsQuery.data.rooms, targetPropertyId));
  const roomSource = createCompositeSource({
    label: "Room topology",
    hasData: roomsQuery.data !== undefined && !roomsMismatch,
    isLoading: roomsQuery.isLoading,
    error: roomsMismatch ? new Error("The rooms did not match this property.") : roomsQuery.error,
    isFetching: roomsQuery.isFetching,
    refetch: permissionCurrent ? () => roomsQuery.refetch() : access.refetch,
  });
  const inventoryQuery = useQuery({
    queryKey: ["inventory-rooms", targetPropertyId],
    queryFn: (context) => loadAllRoomInventory(request, targetPropertyId, context.signal),
    enabled: canLoadProperty && mayReadInventory && (layoutOpen || availabilityOpen || blocksOpen),
  });
  const inventoryMismatch = Boolean(inventoryQuery.data && !roomInventoryMatchesProperty(inventoryQuery.data.rooms, targetPropertyId));
  const inventorySource = createCompositeSource({
    label: "Sellability",
    hasData: permissionCurrent && inventoryQuery.data !== undefined && !inventoryMismatch,
    isLoading: inventoryQuery.isLoading,
    error: inventoryMismatch ? new Error("The selling setup did not match this property.") : permissionCurrent ? inventoryQuery.error : access.error ?? new Error("Current Spaces access is unavailable."),
    isFetching: inventoryQuery.isFetching,
    refetch: permissionCurrent ? () => inventoryQuery.refetch() : access.refetch,
  });
  const propertyTimeZoneId = targetProperty?.canonicalTimeZoneId
    || targetProperty?.timeZoneId
    || "";
  const propertyDefaultRange = useMemo(
    () => propertyTimeZoneId ? defaultPropertyStayRange(propertyTimeZoneId) : null,
    [propertyTimeZoneId],
  );
  const hasRequestedRange = searchParams.has("arrival") || searchParams.has("departure");
  const requestedRange: StayDateRange = {
    arrival: searchParams.get("arrival") ?? "",
    departure: searchParams.get("departure") ?? "",
  };
  const availabilityRange = hasRequestedRange
    ? requestedRange
    : propertyDefaultRange ?? requestedRange;
  const availabilityRangeValid = validStayDateRange(availabilityRange);
  const availabilityQuery = useQuery({
    queryKey: ["availability", targetPropertyId, availabilityRange.arrival, availabilityRange.departure],
    queryFn: (context) => loadInventoryAvailability(
      request,
      targetPropertyId,
      availabilityRange.arrival,
      availabilityRange.departure,
      context.signal,
    ),
    enabled: canLoadProperty && mayReadInventory && availabilityOpen && availabilityRangeValid,
  });
  const availabilityMismatch = Boolean(availabilityQuery.data && (availabilityQuery.data.propertyId !== targetPropertyId || availabilityQuery.data.arrival !== availabilityRange.arrival || availabilityQuery.data.departure !== availabilityRange.departure || availabilityQuery.data.units.some((item) => item.unit.propertyId !== targetPropertyId)));
  const availabilitySource = createCompositeSource({
    label: "Availability",
    hasData: permissionCurrent && availabilityQuery.data !== undefined && !availabilityMismatch,
    isLoading: availabilityQuery.isLoading,
    error: availabilityMismatch ? new Error("The availability did not match this property and date range.") : permissionCurrent ? availabilityQuery.error : access.error ?? new Error("Current Spaces access is unavailable."),
    isFetching: availabilityQuery.isFetching,
    refetch: permissionCurrent ? () => availabilityQuery.refetch() : access.refetch,
  });
  const blockView = searchParams.get("history") === "all" ? "all" : "active";
  // An exact released receipt still needs its record after returning to selected
  // dates. Loading that record does not switch the selected-space display scope.
  const blockReadView = blockView === "all" || searchParams.has("blockGroup") ? "all" : "active";
  const blocksQuery = useQuery({
    queryKey: ["blocks", targetPropertyId, blockReadView],
    queryFn: (context) => loadAllManualInventoryBlocks(
      request,
      targetPropertyId,
      blockReadView === "all",
      context.signal,
    ),
    enabled: canLoadProperty && mayReadInventory && blocksOpen,
  });
  const blocksMismatch = Boolean(blocksQuery.data && !manualBlockListMatchesProperty(blocksQuery.data.blocks, targetPropertyId));
  const blockSource = createCompositeSource({
    label: "Inventory blocks",
    hasData: permissionCurrent && blocksQuery.data !== undefined && !blocksMismatch,
    isLoading: blocksQuery.isLoading,
    error: blocksMismatch ? new Error("The holds did not match this property.") : permissionCurrent ? blocksQuery.error : access.error ?? new Error("Current Spaces access is unavailable."),
    isFetching: blocksQuery.isFetching,
    refetch: permissionCurrent ? () => blocksQuery.refetch() : access.refetch,
  });
  const physicalEvidence = evidenceState(roomSource, mayReadProperties, permissionCurrent);
  const inventoryEvidence = evidenceState(inventorySource, mayReadInventory, permissionCurrent);
  const layout = useMemo(() => buildSpacesRooms({
    propertyId: targetPropertyId,
    physicalRooms: compositeSourceUsable(roomSource.state) ? roomsQuery.data?.rooms : undefined,
    inventoryRooms: mayReadInventory && compositeSourceUsable(inventorySource.state)
      ? inventoryQuery.data?.rooms
      : undefined,
    physicalEvidence,
    inventoryEvidence,
  }), [
    inventoryQuery.data?.rooms,
    inventoryEvidence,
    physicalEvidence,
    roomsQuery.data?.rooms,
    targetPropertyId,
  ]);
  const roomSelection = useMemo(() => resolveSpacesRoomSelection(
    layout.rooms,
    hasRequestedRoom ? requestedRoomId : null,
    hasRequestedBed ? requestedBedId : null,
    hasRequestedUnit ? requestedUnitId : null,
    { physical: physicalEvidence, inventory: inventoryEvidence },
  ), [
    hasRequestedBed,
    hasRequestedRoom,
    hasRequestedUnit,
    inventoryEvidence,
    layout.rooms,
    physicalEvidence,
    requestedBedId,
    requestedRoomId,
    requestedUnitId,
  ]);
  const selectedRoom = roomSelection.status === "selected" ? roomSelection.room : null;

  const bedsQuery = useQuery({
    queryKey: ["beds", targetPropertyId, selectedRoom?.roomId],
    queryFn: (context) => loadAllBeds(
      request,
      targetPropertyId,
      selectedRoom!.roomId,
      context.signal,
    ),
    enabled: Boolean(
      canLoadProperty
      && layoutOpen
      && selectedRoom
      && selectedRoom.physicalState === "present",
    ),
  });
  const bedsMismatch = Boolean(bedsQuery.data && selectedRoom && !bedListMatchesContext(bedsQuery.data.beds, targetPropertyId, selectedRoom.roomId));
  const bedSource = createCompositeSource({
    label: selectedRoom ? `Beds in ${selectedRoom.name}` : "Bed topology",
    hasData: bedsQuery.data !== undefined && !bedsMismatch,
    isLoading: bedsQuery.isLoading,
    error: bedsMismatch ? new Error("The beds did not match this room.") : bedsQuery.error,
    isFetching: bedsQuery.isFetching,
    refetch: permissionCurrent ? () => bedsQuery.refetch() : access.refetch,
  });
  const bedEvidence = evidenceState(bedSource, mayReadProperties, permissionCurrent);
  const unitLayout = useMemo(() => selectedRoom ? buildSpacesUnits({
    propertyId: targetPropertyId,
    room: selectedRoom,
    physicalBeds: compositeSourceUsable(bedSource.state) ? bedsQuery.data?.beds : undefined,
    physicalEvidence: bedEvidence,
    inventoryEvidence,
  }) : { units: [], issues: [] }, [
    bedEvidence,
    bedsQuery.data?.beds,
    inventoryEvidence,
    selectedRoom,
    targetPropertyId,
  ]);
  const unitSelection = useMemo(() => resolveSpacesUnitSelection(
    unitLayout.units,
    hasRequestedBed ? requestedBedId : null,
    hasRequestedUnit ? requestedUnitId : null,
    { physical: bedEvidence, inventory: inventoryEvidence },
  ), [
    bedEvidence,
    hasRequestedBed,
    hasRequestedUnit,
    inventoryEvidence,
    requestedBedId,
    requestedUnitId,
    unitLayout.units,
  ]);
  const propertyDirectoryCurrent = permissionCurrent && compositeSourceCurrent(propertySource);
  const physicalRooms = compositeSourceUsable(roomSource.state) ? roomsQuery.data?.rooms ?? [] : [];
  const physicalBeds = compositeSourceUsable(bedSource.state) ? bedsQuery.data?.beds ?? [] : [];
  const physicalRoom = physicalRooms.find((room) => room.roomId === selectedRoom?.roomId) ?? null;
  const topologyEditor = useTopologyEditor({
    property: targetProperty,
    room: physicalRoom,
    selectionKey: layoutOpen ? [requestedRoomId ?? "", requestedBedId ?? "", requestedUnitId ?? ""].join("|") : "closed-layout",
    evidence: {
      property: targetProperty, rooms: physicalRooms, beds: physicalBeds,
      permissionsCurrent: permissionCurrent, propertyCurrent: propertyDirectoryCurrent,
      roomsCurrent: compositeSourceCurrent(roomSource), bedsCurrent: compositeSourceCurrent(bedSource),
      mayManageRooms: layoutOpen && mayManageRooms, mayManageBeds: layoutOpen && mayManageBeds,
    },
    onSaved: (target, receipt) => setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("room", receipt.roomId); next.delete("edit");
      if (target.kind === "room" && !target.room) { next.delete("bed"); next.delete("unit"); }
      return next;
    }, { replace: true }),
  });
  const inventoryCurrent = permissionCurrent
    && propertyDirectoryCurrent
    && compositeSourceCurrent(inventorySource);
  const salesRooms = compositeSourceUsable(inventorySource.state) ? inventoryQuery.data?.rooms ?? [] : [];
  const salesEditor = useSalesModeEditor({
    evidence: { propertyId: targetPropertyId, rooms: salesRooms, mayRead: mayReadInventory, mayConfigure: mayConfigureInventory && (layoutOpen || availabilityOpen),
      permissionsCurrent: permissionCurrent, propertyCurrent: propertyDirectoryCurrent, inventoryCurrent },
    selectionKey: [requestedRoomId ?? "", requestedBedId ?? "", requestedUnitId ?? ""].join("|"),
    refreshAuthority: () => Promise.all([access.refetch(), workspace.refetchProperties()]),
  });
  const mayReadReservations = permissionCurrent && access.allows(permissions.reservationsRead, propertyScope);
  const retirementEditor = useTopologyRetirementEditor({
    routeInput: { params: searchParams, setParams: setSearchParams },
    evidence: { propertyId: targetPropertyId, permissionsCurrent: permissionCurrent, propertyCurrent: propertyDirectoryCurrent,
      roomsCurrent: compositeSourceCurrent(roomSource), bedsCurrent: compositeSourceCurrent(bedSource),
      mayRead: mayReadInventory, mayRetire: mayRetireInventory && layoutOpen },
    rooms: physicalRooms, beds: physicalBeds,
    selectionKey: [requestedRoomId ?? "", requestedBedId ?? "", requestedUnitId ?? ""].join("|"),
    refreshAuthority: () => Promise.all([access.refetch(), workspace.refetchProperties(), roomsQuery.refetch(), ...(selectedRoom ? [bedsQuery.refetch()] : [])]),
  });
  const retirementUnit = retirementEditor.target && inventoryCurrent ? salesRooms
    .find((room) => room.roomId === retirementEditor.target!.roomId)?.units
    .find((unit) => retirementEditor.target!.kind === "bed" ? unit.bedId === retirementEditor.target!.bedId : unit.kind === 1 || unit.kind === "room") : null;
  const retirementBlocksHref = retirementUnit && mayManageBlocks && inventoryCurrent
    ? "/spaces?" + withRetirementReturn(new URLSearchParams({ property: targetPropertyId, section: "blocks", room: retirementUnit.roomId,
      unit: retirementUnit.inventoryUnitId, ...(retirementUnit.bedId ? { bed: retirementUnit.bedId } : {}) }), "/spaces", searchParams) : null;
  const availabilityCurrent = inventoryCurrent && compositeSourceCurrent(availabilitySource);
  const blockCurrent = inventoryCurrent && compositeSourceCurrent(blockSource);
  const availabilityModel = useMemo(() => buildSpacesAvailability(
    compositeSourceUsable(inventorySource.state) ? inventoryQuery.data?.rooms ?? [] : [],
    compositeSourceUsable(availabilitySource.state) ? availabilityQuery.data : undefined,
    availabilityCurrent ? "current" : "unconfirmed",
    {
      propertyId: targetPropertyId,
      arrival: availabilityRange.arrival,
      departure: availabilityRange.departure,
    },
  ), [
    availabilityRange.arrival,
    availabilityRange.departure,
    availabilityCurrent,
    availabilityQuery.data,
    availabilitySource.state,
    inventoryQuery.data?.rooms,
    inventorySource.state,
    targetPropertyId,
  ]);
  const blockModel = useMemo(() => buildSpacesBlockGroups(
    targetProperty?.name ?? "Property",
    targetPropertyId,
    compositeSourceUsable(inventorySource.state) ? inventoryQuery.data?.rooms ?? [] : [],
    compositeSourceUsable(blockSource.state) ? blocksQuery.data?.blocks ?? [] : [],
    inventoryCurrent,
  ), [
    blockSource.state,
    blocksQuery.data?.blocks,
    inventoryCurrent,
    inventoryQuery.data?.rooms,
    inventorySource.state,
    targetProperty?.name,
    targetPropertyId,
  ]);
  const blockEvidenceCurrent = blockCurrent && !blockModel.contextMismatch;
  const requestedBlockGroupId = searchParams.get("blockGroup");
  const resourceFocusReady = compositeSourceUsable(roomSource.state)
    && (!mayReadInventory || compositeSourceUsable(inventorySource.state))
    && (!hasRequestedBed || compositeSourceUsable(bedSource.state))
    && (requestedBlockGroupId ? compositeSourceUsable(blockSource.state) : compositeSourceUsable(availabilitySource.state));
  const transientFocusedResourceId = useTransientResourceFocus(resourceFocusReady && !navigation.engaged);
  const focusedResourceId = navigation.engaged ? searchParams.get("focus") : transientFocusedResourceId;
  useScrollToTransientResourceFocus(focusedResourceId, resourceFocusReady && !navigation.paused);
  const canonicalRoomId = physicalEvidence === "current"
    ? layout.rooms.find((room) => room.physicalState === "present")?.roomId
      ?? (inventoryEvidence === "current" ? layout.rooms[0]?.roomId : undefined)
    : inventoryEvidence === "current"
      ? layout.rooms[0]?.roomId
      : undefined;

  useEffect(() => {
    if (routeIssue) return;
    if (searchParams.get("section") === section) return;
    const next = new URLSearchParams(searchParams);
    next.set("section", section);
    setSearchParams(next, { replace: true });
  }, [routeIssue, searchParams, section, setSearchParams]);

  useEffect(() => {
    if (routeIssue) return;
    if (hasRequestedProperty || !workspace.selectedPropertyId) return;
    const next = new URLSearchParams(searchParams);
    next.set("property", workspace.selectedPropertyId);
    next.set("section", section);
    setSearchParams(next, { replace: true });
  }, [routeIssue, hasRequestedProperty, searchParams, section, setSearchParams, workspace.selectedPropertyId]);

  useEffect(() => {
    if (routeIssue) return;
    if (!availabilityOpen || hasRequestedRange || !propertyDefaultRange) return;
    const next = new URLSearchParams(searchParams);
    next.set("property", targetPropertyId);
    next.set("section", section);
    next.set("arrival", propertyDefaultRange.arrival);
    next.set("departure", propertyDefaultRange.departure);
    setSearchParams(next, { replace: true });
  }, [
    availabilityOpen,
    routeIssue,
    hasRequestedRange,
    propertyDefaultRange,
    searchParams,
    setSearchParams,
    targetPropertyId,
  ]);

  const selectRoom = (roomId: string) => {
    const next = new URLSearchParams(searchParams);
    next.delete("retire"); next.delete("retirement");
    next.set("section", "layout");
    next.set("property", targetPropertyId);
    next.set("room", roomId);
    next.delete("bed");
    next.delete("unit");
    next.delete("focus");
    next.delete("blockGroup");
    setSearchParams(next);
  };
  const selectUnit = (unit: SpacesUnit) => {
    const next = new URLSearchParams(searchParams);
    next.delete("retire"); next.delete("retirement");
    next.set("section", "layout");
    next.set("property", targetPropertyId);
    next.set("room", unit.roomId);
    if (unit.bedId) next.set("bed", unit.bedId);
    else next.delete("bed");
    if (unit.inventoryUnitId) next.set("unit", unit.inventoryUnitId);
    else next.delete("unit");
    next.delete("focus");
    next.delete("blockGroup");
    setSearchParams(next);
  };
  const setAvailabilityRange = (nextRange: StayDateRange) => {
    if (!validStayDateRange(nextRange)) return;
    const next = new URLSearchParams(searchParams);
    next.set("section", "availability");
    next.set("property", targetPropertyId);
    next.set("arrival", nextRange.arrival);
    next.set("departure", nextRange.departure);
    next.delete("focus");
    setSearchParams(next);
  };
  const setBlockView = (view: "active" | "all") => {
    const next = new URLSearchParams(searchParams);
    if (view === "all") next.set("history", "all");
    else next.delete("history");
    next.delete("focus");
    setSearchParams(next);
  };

  const blockEditor = useManualBlockEditor({
    propertyId: targetPropertyId, propertyName: targetProperty?.name ?? "Property",
    selectionKey: [requestedRoomId, requestedBedId, requestedUnitId, availabilityRange.arrival, availabilityRange.departure].join("|"),
    rooms: salesRooms, blocks: compositeSourceUsable(blockSource.state) ? blocksQuery.data?.blocks ?? [] : [],
    mayManage: mayManageIndividualBlocks, mayManageGroups: mayManageBlockGroups,
    evidence: { permissionsCurrent: permissionCurrent, propertyCurrent: propertyDirectoryCurrent, inventoryCurrent, blocksCurrent: blockEvidenceCurrent },
    onSuccess: (notice) => setSearchParams((current) => spacesBlockSuccessParams(current, notice)),
  });
  const workspaceLocked = propertyEditorEngaged || Boolean(topologyEditor.target || salesEditor.target || retirementEditor.target || blockEditor.editor);
  const workspacePending = propertyNavigation.pending || topologyEditor.busy || salesEditor.busy || retirementEditor.busy || blockEditor.busy;
  const ownerLabel = propertyEditorEngaged ? propertyNavigation.label
    : topologyEditor.target?.kind === "bed" ? topologyEditor.target.bed?.label ?? `beds in ${topologyEditor.target.room.name}`
    : topologyEditor.target ? topologyEditor.target.room?.name ?? "a new room"
    : salesEditor.target ? salesEditor.target.room.roomName
    : retirementEditor.target?.label ?? (blockEditor.editor ? "the selected space hold" : "this task");
  const authorityLost = propertyNavigation.authorityLost || (permissionCurrent && (!mayReadProperties
    || Boolean(topologyEditor.target && !(topologyEditor.target.kind === "room" ? mayManageRooms : mayManageBeds))
    || Boolean(salesEditor.target && (!mayReadInventory || !mayConfigureInventory))
    || Boolean(retirementEditor.target && (!mayReadInventory || !mayRetireInventory))
    || Boolean(blockEditor.editor && (!mayReadInventory || !mayManageBlocks))))
    || (propertyDirectoryCurrent && (!targetProperty
      || (targetProperty.status !== "active" && Boolean(topologyEditor.target || salesEditor.target || blockEditor.editor))));
  useLayoutEffect(() => {
    navigation.reportOwner({ engaged: workspaceLocked || workspacePending, pending: workspacePending, label: ownerLabel, authorityLost });
  }, [authorityLost, navigation.reportOwner, ownerLabel, workspaceLocked, workspacePending]);
  const visibleSection = section;
  const propertyOpen = visibleSection === "property";
  const holdsOpen = visibleSection === "blocks";
  const focusedSurfaceOpen = propertyOpen || holdsOpen;
  const openFocusedSurface = (surface: "property" | "blocks") => {
    if (workspaceLocked || !permissionCurrent || (surface === "property" ? !mayReadProperties : !mayReadInventory)) return;
    const context = new URLSearchParams(searchParams);
    if (!context.has("property")) context.set("property", targetPropertyId);
    const next = withSpacesFocusedSurface(context, surface);
    if (!next) return;
    setSearchParams(next);
    requestAnimationFrame(() => document.getElementById(surface === "property" ? "spaces-property-heading" : "spaces-blocks-heading")?.focus());
  };
  const backToWorkspace = () => {
    if (workspaceLocked) return;
    const context = new URLSearchParams(searchParams);
    if (!context.has("property")) context.set("property", targetPropertyId);
    const next = spacesFocusedBackParams(context);
    if (!next) return;
    setSearchParams(next);
    requestAnimationFrame(() => {
      const inspector = document.getElementById("spaces-selection-inspector");
      const target = inspector?.getClientRects().length ? inspector.querySelector<HTMLElement>("[data-inspector-heading]") ?? inspector
        : document.querySelector<HTMLElement>('[aria-label="Rooms and beds navigator"] [role="status"]');
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest" });
    });
  };
  const roomFilter = searchParams.get("q") ?? "";
  const setRoomFilter = (value: string) => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    if (value) next.set("q", value); else next.delete("q");
    return next;
  }, { replace: true });
  const primarySources = [permissionSource, ...(propertyOpen ? [] : [propertySource, roomSource])];
  if (mayReadInventory && !propertyOpen) primarySources.push(inventorySource);
  const hasUsableLayoutSource = compositeSourceUsable(roomSource.state)
    || (mayReadInventory && compositeSourceUsable(inventorySource.state));
  const layoutNoticeSources = primarySources.filter((source) => hasUsableLayoutSource || source !== roomSource);
  const awaitingDefaultRoom = !routeIssue && layoutOpen && !hasRequestedRoom && !hasRequestedBed && !hasRequestedUnit
    && !searchParams.has("blockGroup") && Boolean(canonicalRoomId)
    && !(topologyEditor.target?.kind === "room" && !topologyEditor.target.room);
  const retryFocus = useSpacesRetryFocus({
    owner: JSON.stringify([sessionIdentityKey(session), targetPropertyId,
      availabilityRange.arrival, availabilityRange.departure, mayReadProperties, mayReadInventory,
      mayManageRooms, mayManageBeds, mayConfigureInventory, mayManageBlocks, mayRetireInventory]),
    location: { ...navigation.rawLocation, effectiveSearch: searchParams.toString(), action: navigation.rawNavigationType },
    awaitingDefaultRoom,
    enabled: !routeIssue && !focusedSurfaceOpen && !workspaceLocked && !navigation.paused
      && mayReadProperties && Boolean(targetProperty),
    current: permissionCurrent && propertyDirectoryCurrent,
    ready: [roomSource, ...(mayReadInventory ? [inventorySource, ...(availabilityRangeValid ? [availabilitySource] : [])] : [])]
      .every(compositeSourceCurrent),
    denied: authorityLost || [access.error, workspace.propertiesError, roomsQuery.error, inventoryQuery.error, availabilityQuery.error]
      .some(error => error instanceof ApiError && (error.status === 401 || error.status === 403)),
    notices: {
      layout: { active: !focusedSurfaceOpen, pending: layoutNoticeSources.some(source => source.isFetching),
        retryable: layoutNoticeSources.some(source => compositeSourceNeedsRetry(source.state)),
        cold: { pending: roomSource.isFetching, retryable: compositeSourceNeedsRetry(roomSource.state) } },
      availability: { active: !focusedSurfaceOpen && mayReadInventory && availabilityRangeValid,
        pending: availabilitySource.isFetching, retryable: compositeSourceNeedsRetry(availabilitySource.state),
        cold: { pending: availabilitySource.isFetching, retryable: compositeSourceNeedsRetry(availabilitySource.state) } },
    },
  });
  const pendingDefaultRoom = useRef<string | null>(null);
  useEffect(() => {
    if (!awaitingDefaultRoom) pendingDefaultRoom.current = null;
    if (!awaitingDefaultRoom || !canonicalRoomId) return;
    const next = new URLSearchParams(searchParams);
    next.set("property", targetPropertyId);
    next.set("section", section);
    next.set("room", canonicalRoomId);
    const targetSearch = "?" + next.toString();
    if (navigation.rawLocation.search === targetSearch) return;
    const requestKey = JSON.stringify([navigation.rawLocation.key, navigation.rawLocation.pathname, targetSearch]);
    // Query updates can render again before the first REPLACE is committed.
    // Dispatch that automatic navigation once, preserving its recovery receipt.
    if (pendingDefaultRoom.current === requestKey) return;
    pendingDefaultRoom.current = requestKey;
    const recoveryReceipt = retryFocus.prepareDefaultRoom(canonicalRoomId, next);
    setSearchParams(next, { replace: true,
      state: recoveryReceipt ? { __bunkfySpacesRetryFocus: recoveryReceipt } : undefined });
  }, [awaitingDefaultRoom, canonicalRoomId, searchParams, section, targetPropertyId, retryFocus, setSearchParams,
    navigation.rawLocation.key, navigation.rawLocation.pathname, navigation.rawLocation.search]);

  if (routeIssue) return <TargetUnavailable title="Spaces link needs one exact context" description={routeIssue} />;

  if (!targetPropertyId && !hasRequestedProperty) {
    return workspace.propertiesLoading
      ? <LoadingState label="Loading property context" />
      : <EmptyState
          icon={<Building2 />}
          title="Choose a property first"
          description="Spaces are shown within one property. Select a property from the application menu to continue."
        />;
  }

  if (!propertyCatalogueUsable) {
    return (
      <>
        <PageHeader title="Spaces" description="Rooms, beds, and how they are sold." />
        <section className="overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-sm">
          <CompositeSourceFallback
            error={workspace.propertiesError}
            state={propertySource.state}
            label="property context"
            retry={() => void propertySource.refetch()}
            title="Property context could not be loaded"
          />
        </section>
      </>
    );
  }

  if (!targetProperty) {
    return (
      <TargetUnavailable
        title="Property changed or is unavailable"
        description="The requested property is not in the current property directory. The link has been kept unchanged so you can verify or replace it deliberately."
        action={workspace.selectedProperty ? (
          <button className="btn btn-primary btn-sm" onClick={() => {
            const next = new URLSearchParams(searchParams);
            next.set("property", workspace.selectedPropertyId);
            next.set("section", section);
            clearResourceTargets(next);
            setSearchParams(next);
          }}>
            Open {workspace.selectedProperty.name}
          </button>
        ) : undefined}
      />
    );
  }

  if (!access.hasData) {
    return (
      <>
        <PageHeader eyebrow={targetProperty.name} title="Spaces" description="Rooms, beds, and how they are sold." />
        <section className="overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-sm">
          <CompositeSourceFallback
            error={access.error}
            state={permissionSource.state}
            label="Spaces access"
            retry={() => void access.refetch()}
            title="Spaces access could not be checked"
          />
        </section>
      </>
    );
  }

  if (!mayReadProperties) {
    return (
      <>
        <PageHeader eyebrow={targetProperty.name} title="Spaces" description="Rooms, beds, and how they are sold." />
        <section className="overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-sm">
          <EmptyState
            icon={<ShieldCheck />}
            title="Spaces access is not assigned"
            description="The Spaces workspace requires current property context. Inventory-only discovery needs a minimized backend property-context source and is not inferred from old browser state."
          />
        </section>
      </>
    );
  }

  const layoutConfirmedEmpty = physicalEvidence === "current"
    && (inventoryEvidence === "current" || inventoryEvidence === "restricted");
  const selectedUnit = unitSelection.status === "selected" ? unitSelection.unit : null;
  const layoutReturn: SpacesReturnRoute = {
    section: "layout", propertyId: targetPropertyId,
    ...(selectedRoom ? { roomId: selectedRoom.roomId } : {}),
    ...(selectedUnit?.bedId ? { bedId: selectedUnit.bedId } : {}),
    ...(selectedUnit?.inventoryUnitId ? { inventoryUnitId: selectedUnit.inventoryUnitId } : {}),
    ...(requestedBlockGroupId ? { blockGroupId: requestedBlockGroupId } : {}),
    ...(blockView === "all" ? { history: "all" as const } : {}),
    ...(availabilityRangeValid ? availabilityRange : {}),
    ...(roomFilter ? { filter: roomFilter } : {}),
  };
  const scopedUnitIds = selectedUnit?.inventoryUnitId ? [selectedUnit.inventoryUnitId]
    : hasRequestedUnit || hasRequestedBed ? [] : selectedRoom?.inventoryUnits.map((unit) => unit.inventoryUnitId) ?? [];
  const visibleGroups = holdsOpen ? blockModel.groups
    : !selectedRoom && !hasRequestedRoom && !hasRequestedBed && !hasRequestedUnit && requestedBlockGroupId
      ? blockModel.groups.filter((group) => group.blockGroupId === requestedBlockGroupId)
      : spacesRelevantHolds(blockModel.groups, scopedUnitIds, availabilityRange, requestedBlockGroupId, blockView);
  const initialBlockTarget = ((hasRequestedUnit || hasRequestedBed) && !selectedUnit) ? undefined : blockEditor.options.find((option) => selectedUnit?.inventoryUnitId
    ? option.kind === "unit" && option.unitIds.length === 1 && option.unitIds[0] === selectedUnit.inventoryUnitId
    : option.kind === "room" && option.target.roomId === selectedRoom?.roomId);
  const holds = mayReadInventory ? <SpacesBlocksContent
    editor={blockEditor} embedded={!holdsOpen} scope={holdsOpen ? "all" : "selected"}
    heading={holdsOpen ? "All holds" : selectedUnit ? `Holds · ${selectedUnit.label}` : selectedRoom ? `Holds · ${selectedRoom.name}` : "Requested hold"}
    otherEditorOpen={propertyEditorEngaged || Boolean(topologyEditor.target || salesEditor.target || retirementEditor.target)}
    view={blockView} source={blockSource} sourceError={blocksMismatch ? new Error("The holds did not match this property.") : permissionCurrent ? blocksQuery.error : access.error}
    sources={[blockSource]} groups={visibleGroups}
    evidenceCurrent={blockEvidenceCurrent} contextMismatch={blockModel.contextMismatch}
    selectedBlockGroupId={requestedBlockGroupId} targetStatus={resolveSpacesBlockTarget(visibleGroups, requestedBlockGroupId, blockEvidenceCurrent, requestedUnitId)}
    mayManageBlocks={mayManageBlocks} propertyId={targetPropertyId} propertyName={targetProperty.name}
    rooms={salesRooms} blocks={blocksQuery.data?.blocks ?? []} initialRange={availabilityRange}
    initialTargetId={holdsOpen ? undefined : initialBlockTarget?.id}
    createTargetUnavailable={!holdsOpen && !initialBlockTarget}
    mutationEvidence={{ permissionsCurrent: permissionCurrent, propertyCurrent: propertyDirectoryCurrent, inventoryCurrent, blocksCurrent: blockEvidenceCurrent }}
    onMutationSuccess={() => undefined} onViewChange={setBlockView}
  /> : null;
  const availabilityNotice = mayReadInventory ? <>
    {!availabilityRangeValid ? <p role="status" className="px-4 py-3 text-sm">Choose valid dates to check availability.</p> : compositeSourceUsable(availabilitySource.state)
      ? <div ref={retryFocus.availabilityNotice} className="contents" onClickCapture={retryFocus.remember}><CompositeSourceNotice className="mx-4 my-3 flex sm:mx-5" sources={[availabilitySource]} title="Availability is not current" keepRetryFocusable /></div>
      : <div ref={retryFocus.availabilityFallback} className="contents" onClickCapture={retryFocus.remember}><CompositeSourceFallback error={availabilityMismatch ? new Error("The availability did not match these dates.") : permissionCurrent ? availabilityQuery.error : access.error} state={availabilitySource.state} label="availability" retry={() => void availabilitySource.refetch()} title="Availability could not be loaded" /></div>}
    {availabilityModel.contextMismatch && <p role="alert" className="px-4 py-3 text-sm text-warning-content">Availability could not be matched to the current selling setup. Dates and selection are kept; no availability is assumed.</p>}
  </> : null;
  const inspector = <>
    {roomSelection.status === "unconfirmed" ? <TargetUnconfirmedPanel
      title={roomSelection.reason === "restricted" ? "Inventory access is not assigned" : `Confirming requested ${roomSelection.targetKind}`}
      busy={roomSelection.reason !== "restricted"}
      description={roomSelection.reason === "restricted"
        ? `This requested ${roomSelection.targetKind} cannot be confirmed with your current inventory access. The exact link is kept; no substitute has been selected.`
        : "The source needed for this exact target is not current. No substitute has been selected."} />
      : roomSelection.status === "unavailable" ? <TargetUnavailablePanel title={`Requested ${roomSelection.targetKind} changed or is unavailable`}
        description="The exact target remains in the URL. Choose a room deliberately; no other room has been substituted." />
        : selectedRoom ? <RoomDetail
          room={selectedRoom} units={unitLayout.units} unitSelection={unitSelection} bedSource={bedSource} inventorySource={inventorySource}
          bedEvidence={bedEvidence} inventoryEvidence={inventoryEvidence}
          editor={topologyEditor} physicalRoom={physicalRoom} physicalBeds={physicalBeds}
          mayRetireInventory={mayRetireInventory && propertyDirectoryCurrent} retirementEditor={retirementEditor}
          mayConfigureInventory={mayConfigureInventory} salesEditor={salesEditor}
          salesRoom={salesRooms.find((room) => room.roomId === selectedRoom.roomId)}
          salesOrigin={withSpacesReturnRoute(searchParams, layoutReturn)} mayReadReservations={mayReadReservations}
          issueCount={unitLayout.issues.length} onSelectUnit={selectUnit}
          operationalContent={<>
            {selectedUnit && mayReadInventory && <div className="border-b border-base-300 px-4 py-3 sm:px-5">
              <p className="text-sm font-semibold text-base-content/65">Night availability · selected dates</p>
              <p className={`mt-1 font-semibold ${spacesUnitAvailability(selectedUnit, availabilityModel.rows, inventoryCurrent).tone}`}>{spacesUnitAvailability(selectedUnit, availabilityModel.rows, inventoryCurrent).label}</p>
              {spacesHasCurrentAllocation(selectedUnit, availabilityModel.rows, inventoryCurrent) ? <p className="mt-1 text-xs text-base-content/55">An active allocation holds this space. Guest and check-in details are not part of this availability source.</p> : null}
            </div>}
            {!holdsOpen && holds}
          </>}
          otherEditorOpen={propertyEditorEngaged || Boolean(blockEditor.editor)}
          onClearUnavailableTarget={() => { const next = new URLSearchParams(searchParams); next.delete("bed"); next.delete("unit"); next.delete("focus"); next.delete("blockGroup"); setSearchParams(next); }}
        /> : requestedBlockGroupId || blockView === "all" || !layout.rooms.length ? null : <TargetPromptPanel />}
    {!holdsOpen && !selectedRoom && holds}
    {retirementEditor.target && <TopologyRetirementPanel editor={retirementEditor} inline mayReadReservations={mayReadReservations} blocksHref={retirementBlocksHref} mayUseTemporaryBlock={Boolean(retirementUnit?.isTopologyActive && retirementUnit.isSellable)} />}
  </>;
  const layoutFeedback = !hasUsableLayoutSource ? <div ref={retryFocus.layoutFallback} className="contents" onClickCapture={retryFocus.remember}><CompositeSourceFallback error={roomsMismatch ? new Error("The rooms did not match this property.") : roomsQuery.error} state={roomSource.state} label="room layout" retry={() => void roomSource.refetch()} title="Room layout could not be loaded" /></div>
    : layout.rooms.length === 0 && !layoutConfirmedEmpty ? <TargetUnconfirmedPanel title="Confirming room layout" description="The required sources are not current. This property is not confirmed empty." />
      : layout.rooms.length === 0 ? <EmptyState icon={<Layers3 />} title="No rooms configured" description={mayManageRooms ? "Add the first room above, then give its beds recognizable labels." : "A property manager can add the first room."} /> : null;
  return <>
    {parsePropertyRetirementReturn(searchParams, targetPropertyId) || parseRetirementReturn(searchParams, targetPropertyId) ? <OwnerOriginLink params={searchParams} /> : <OperationalOriginLink params={searchParams} />}
    <header className="spaces-room-heading mb-3 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="break-words text-2xl font-semibold leading-tight">{propertyOpen ? "Spaces / Property settings" : holdsOpen ? "Spaces / All holds" : "Spaces"}</h1>
        <p className="mt-1 break-words text-sm text-base-content/65">{targetProperty.name}{focusedSurfaceOpen ? "" : ` · ${layout.rooms.length} ${layout.rooms.length === 1 ? "room" : "rooms"}`}</p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {focusedSurfaceOpen ? <button type="button" className="btn btn-ghost btn-sm" disabled={workspaceLocked} onClick={backToWorkspace}>
          <ArrowLeft size={16} />Back to {selectedUnit?.label ?? selectedRoom?.name ?? "rooms & beds"}</button> : <>
          {mayReadProperties && <button type="button" className="btn btn-ghost btn-sm" disabled={workspaceLocked || !permissionCurrent} onClick={() => openFocusedSurface("property")}><Building2 size={16} />Property settings</button>}
          {mayReadInventory && <button type="button" className="btn btn-ghost btn-sm" disabled={workspaceLocked || !permissionCurrent} onClick={() => openFocusedSurface("blocks")}><Blocks size={16} />All holds</button>}
          {mayManageRooms && <button className="btn btn-primary btn-sm" disabled={!topologyEditor.canCreateRoom || workspaceLocked}
            onClick={(event) => topologyEditor.openRoom(undefined, event.currentTarget)}>Add room</button>}
        </>}
      </div>
    </header>
    {navigation.paused && <section aria-label="Paused Spaces navigation" className="mb-3 rounded-lg border border-warning/30 p-3 text-sm">
      <p role="status">Navigation to {spacesNavigationLabel(navigation.rawParams, layout.rooms, navigation.rawLocation.pathname)} is paused while you edit {navigation.ownerLabel}.</p>
      {!navigation.expanded && <button type="button" className="btn btn-ghost btn-sm mt-2 min-h-11" onClick={navigation.review}>Review paused navigation</button>}
    </section>}
    <div id="spaces-property-settings" hidden={!propertyOpen}>
      {propertyOpen && <SpacesPropertySection key={`${sessionIdentityKey(session)}:${targetProperty.propertyId}`} property={targetProperty}
        directorySource={propertySource} permissionSource={permissionSource} permissionsCurrent={permissionCurrent} mayManageIdentity={mayManageIdentity}
        mayManageTimeZone={mayManageTimeZone} refreshPermissions={access.refetch} onNavigationStateChange={setPropertyNavigation}
        routeInput={{ params: searchParams, setParams: setSearchParams }}
        actionsDisabled={Boolean(topologyEditor.target || salesEditor.target || retirementEditor.target || blockEditor.editor)} />}
    </div>
    <div ref={retryFocus.layoutNotice} className="contents" onClickCapture={retryFocus.remember}><CompositeSourceNotice className="mb-4 flex" sources={layoutNoticeSources} title="Some Spaces information is delayed" keepRetryFocusable /></div>
    {holdsOpen && (mayReadInventory ? holds : <EmptyState icon={<ShieldCheck />} title="Hold history access is not assigned" description="Reading all holds requires inventory access. No empty history is inferred; return to the permitted room workspace." />)}
    <section ref={retryFocus.surface} hidden={focusedSurfaceOpen} data-topology-region data-sales-region className="spaces-room-frame overflow-clip rounded-lg border border-base-300 bg-base-100" aria-labelledby="spaces-layout-heading">
      <TopologyMutationNotice notice={topologyEditor.notice} /><SalesModeNotice notice={salesEditor.notice} />
      <h2 id="spaces-layout-heading" className="sr-only focus:not-sr-only focus:px-4 focus:py-2">Rooms &amp; beds</h2>
      {topologyEditor.target && (!topologyEditor.target.room || !selectedRoom) && <TopologyEditorForm editor={topologyEditor} beds={physicalBeds} inline />}
      {salesEditor.target && (!selectedRoom || selectedRoom.roomId !== salesEditor.target.room.roomId) && <SalesModeChangeModal editor={salesEditor} inline mayReadReservations={mayReadReservations} />}
      {layout.issues.length > 0 && <p role="status" className="border-b border-base-300 px-4 py-3 text-sm text-warning-content">Some room records could not be matched safely. Unmatched facts are not used for availability or editing.</p>}
      {/* Keep the editor anchor mounted through empty, failed and recovering layout reads. */}
      <SpacesRoomWorkspace key={`${sessionIdentityKey(session)}:${targetPropertyId}`} rooms={layout.rooms} selectedRoom={selectedRoom} selectedUnit={selectedUnit} selectedUnits={unitLayout.units}
              physicalBedCount={bedEvidence === "current" ? physicalBeds.length : undefined} availability={availabilityModel}
              inventoryCurrent={inventoryCurrent} mayReadInventory={mayReadInventory} range={availabilityRange} timeZoneId={propertyTimeZoneId}
              locked={workspaceLocked} onRangeChange={setAvailabilityRange} onSelectRoom={selectRoom} onSelectUnit={selectUnit} visible={!focusedSurfaceOpen}
              inspector={inspector} sourceNotice={<>{layoutFeedback}{availabilityNotice}</>} filter={roomFilter} onFilterChange={setRoomFilter} focusedResourceId={focusedResourceId}
              requestedTarget={hasRequestedRoom || hasRequestedBed || hasRequestedUnit || Boolean(requestedBlockGroupId)}
              selectionKey={[requestedRoomId, requestedBedId, requestedUnitId].join("|")} />
    </section>
    {/* Last modal in this owner: the existing topmost focus/Escape rules keep the
        paused choice reachable above time-zone or processing confirmations. */}
    <Modal open={navigation.paused && navigation.expanded} title="Navigation paused" onClose={navigation.stay}>
      <p>Navigation to {spacesNavigationLabel(navigation.rawParams, layout.rooms, navigation.rawLocation.pathname)} is paused while you edit {navigation.ownerLabel}.</p>
      <p className="mt-2 text-sm">Your current editor and exact request are kept here. {navigation.pending || workspacePending ? "Wait for this request or resolve its result before leaving." : "Stay here, or explicitly discard this editor and continue to the requested destination."}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn btn-ghost min-h-11" onClick={navigation.stay}>Stay editing</button>
        <button type="button" className="btn btn-outline min-h-11" disabled={navigation.pending || workspacePending} onClick={() => {
          if (!navigation.discard()) return;
          requestAnimationFrame(() => {
            const target = Array.from(document.querySelectorAll<HTMLElement>('#spaces-property-heading, #spaces-blocks-heading, [data-inspector-heading], #spaces-layout-heading, main h1'))
              .find((item) => item.getClientRects().length > 0);
            if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: "nearest" }); }
          });
        }}>Discard and continue</button>
      </div>
    </Modal>
  </>;
}

function RoomDetail({
  room, units, unitSelection, bedSource, bedEvidence, inventoryEvidence,
  editor, physicalRoom, physicalBeds, mayRetireInventory, retirementEditor, mayConfigureInventory,
  salesEditor, salesRoom, salesOrigin, mayReadReservations, issueCount, onSelectUnit, onClearUnavailableTarget,
  operationalContent, otherEditorOpen,
}: {
  room: SpacesRoom; units: SpacesUnit[]; unitSelection: ReturnType<typeof resolveSpacesUnitSelection>;
  bedSource: CompositeSource; inventorySource: CompositeSource; bedEvidence: SpacesEvidenceState; inventoryEvidence: SpacesEvidenceState;
  editor: TopologyEditor; physicalRoom: Room | null; physicalBeds: Bed[];
  mayRetireInventory: boolean; retirementEditor: TopologyRetirementEditor; mayConfigureInventory: boolean;
  salesEditor: SalesModeEditor; salesRoom?: RoomInventory; salesOrigin: URLSearchParams; mayReadReservations: boolean;
  issueCount: number; onSelectUnit: (unit: SpacesUnit) => void; onClearUnavailableTarget: () => void;
  operationalContent: React.ReactNode; otherEditorOpen: boolean;
}) {
  const selectedUnit = unitSelection.status === "selected" ? unitSelection.unit : null;
  const bed = physicalBeds.find((item) => item.bedId === selectedUnit?.bedId);
  const locked = editor.busy || Boolean(editor.target) || Boolean(salesEditor.target) || Boolean(retirementEditor.target) || otherEditorOpen;
  const detailSources = [bedSource];
  const wholeRoomUnits = units.filter((unit) => unit.kind === "room");
  const editingBed = editor.target?.kind === "bed" && Boolean(editor.target.bed);
  const editingRoom = editor.target?.kind === "room" && Boolean(editor.target.room);
  const addingBeds = editor.target?.kind === "bed" && !editor.target.bed;
  const topologyTask = editingBed || editingRoom || addingBeds;
  return <div data-topology-task={topologyTask || undefined} className="scroll-my-20">
    <div className="border-b border-base-300 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><h3 data-inspector-heading tabIndex={-1} className="break-words text-lg font-semibold outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary">{selectedUnit?.label ?? room.name}</h3>
          {selectedUnit && <p className="mt-1 break-words text-sm text-base-content/65">{room.name}</p>}</div>
        {bed && editor.mayManageBeds && <button className="btn btn-outline btn-sm" aria-label={"Edit bed " + bed.label}
          hidden={topologyTask}
          disabled={!editor.canEditBed(bed) || locked} onClick={(event) => editor.openBeds(bed, event.currentTarget)}>Edit bed</button>}
      </div>
      {selectedUnit && <p data-space-bed-facts hidden={topologyTask} className="mt-2 text-sm">Physical status: <PhysicalFact unit={selectedUnit} /></p>}
    </div>
    {editingBed && <TopologyEditorForm editor={editor} beds={physicalBeds} inline />}
    <CompositeSourceNotice className="m-4 flex" sources={detailSources} title="Physical bed details are not current" />
    {bedSource.state === "loading" && <SourceActivity className="mx-4 mb-3" label="Loading physical bed details" />}
    {bedSource.state === "ready" && bedSource.isFetching && <SourceActivity className="mx-4 mb-3" label="Refreshing physical bed details" />}
    {unitSelection.status === "unconfirmed" && <p role="status" className="px-4 py-3 text-sm text-warning-content">Confirming the exact requested space. No other bed or unit has been substituted.</p>}
    {unitSelection.status === "unavailable" && <div role="alert" className="px-4 py-3 text-sm">
      <p className="font-semibold">Requested space changed or is unavailable</p><p className="mt-1 text-base-content/60">The room remains exact, but no child matches every requested ID.</p>
      <button className="btn btn-ghost btn-sm mt-2" disabled={locked} onClick={onClearUnavailableTarget}>Clear unavailable target</button></div>}
    {issueCount > 0 && <p role="status" className="px-4 py-3 text-sm text-warning-content">Some child records could not be matched. Unmatched facts are not used for editing.</p>}
    <section aria-label={topologyTask ? undefined : "Room facts"} hidden={editingBed} inert={editingBed} className="border-t border-base-300">
        <div hidden={topologyTask} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <h4 className="text-base font-semibold">Room facts</h4>
        {/* The exact opener stays mounted; unrelated read state is only hidden. */}
        <div className="flex min-w-0 flex-wrap gap-2">
          {editor.mayManageRooms && physicalRoom && <button className="btn btn-outline btn-sm" disabled={!editor.canEditRoom || locked} onClick={(event) => editor.openRoom(physicalRoom, event.currentTarget)}>Edit room</button>}
          {editor.mayManageBeds && <button className="btn btn-outline btn-sm" disabled={!editor.canAddBeds || locked} onClick={(event) => editor.openBeds(undefined, event.currentTarget)}>Add beds</button>}
        </div>
        </div>
        {(editingRoom || addingBeds) && <TopologyEditorForm editor={editor} beds={physicalBeds} inline />}
        <dl data-space-room-facts hidden={topologyTask} className={(topologyTask ? "hidden " : "grid ") + "min-w-0 gap-3 px-4 pb-4 text-sm sm:grid-cols-2"}>
          <div className="min-w-0"><dt className="text-[0.8125rem] text-base-content/65">Location</dt><dd className="mt-1 break-words font-medium">{room.location || "Not specified"}</dd></div>
          <div className="min-w-0"><dt className="text-[0.8125rem] text-base-content/65">Physical room</dt><dd className="mt-1 break-words">{room.physicalStatus ?? "Unknown"}</dd></div>
          <div className="min-w-0"><dt className="text-[0.8125rem] text-base-content/65">Physical beds</dt><dd className="mt-1">{bedEvidence === "current" ? physicalBeds.length : "Unconfirmed"}</dd></div>
        </dl>
    </section>
    <div data-topology-read-siblings hidden={topologyTask} inert={topologyTask}>
    {operationalContent}
    <section aria-label="Selling" className="border-t border-base-300">
      <h4 className="px-4 py-3 text-base font-semibold">Selling</h4>
      <div className="px-4 pb-4">
        <p className="text-sm">{inventoryEvidence !== "current" ? "Selling setup unconfirmed" : room.salesMode === null ? "Unknown" : salesModeLabel(room.salesMode)}</p>
        {wholeRoomUnits.map((unit) => <div key={unit.key} className="mt-2 border-l-2 border-base-300 pl-3 text-xs">
          <p className="font-semibold">{inventoryEvidence !== "current" ? "Whole-room offering unconfirmed" : unit.isSellable ? "Whole room offered separately" : "Whole room not offered separately"}</p>
          <p className="mt-1 break-words text-base-content/60">Whole-room inventory is separate from the physical bed count.</p>
          <button type="button" className="btn btn-ghost btn-xs mt-1 min-h-9" disabled={locked} onClick={() => onSelectUnit(unit)}>Inspect whole-room option</button>
        </div>)}
        {mayConfigureInventory && salesRoom && <button type="button" className="btn btn-outline btn-sm mt-3" disabled={!salesEditor.canOpen(salesRoom) || locked}
          onClick={(event) => salesEditor.open(salesRoom, event.currentTarget, salesOrigin)}><SlidersHorizontal size={15} />Edit selling setup</button>}
      </div>
    </section>
    {salesEditor.target?.room.roomId === room.roomId && <SalesModeChangeModal editor={salesEditor} inline mayReadReservations={mayReadReservations} />}
        {mayRetireInventory && <section aria-label="Retirement actions" className="border-t border-base-300 px-4 py-3">
          <h4 className="text-sm font-medium text-base-content/65">Retirement actions</h4>
          <div className="mt-2 flex flex-wrap gap-2">
            {bed && <button type="button" className="btn btn-ghost btn-sm text-error" aria-label={"Retire bed " + bed.label}
              disabled={!retirementEditor.canOpen({ propertyId: bed.propertyId, roomId: room.roomId, bedId: bed.bedId, kind: "bed" }) || locked}
              onClick={(event) => retirementEditor.open({ propertyId: bed.propertyId, roomId: room.roomId, bedId: bed.bedId, kind: "bed", label: bed.label }, event.currentTarget)}>Retire bed</button>}
            <button type="button" className="btn btn-ghost btn-sm text-error" disabled={!retirementEditor.canOpen({ propertyId: retirementEditor.propertyId, roomId: room.roomId, kind: "room" }) || locked}
              onClick={(event) => retirementEditor.open({ propertyId: retirementEditor.propertyId, roomId: room.roomId, kind: "room", label: room.name }, event.currentTarget)}>Retire room</button>
          </div>
        </section>}
    </div>
  </div>;
}


function PhysicalFact({ unit }: { unit: SpacesUnit }) {
  if (unit.physicalState === "present" && unit.physicalStatus) return <StatusBadge status={unit.physicalStatus} />;
  if (unit.physicalState === "not-applicable") return <span className="text-base-content/60">Room record</span>;
  return <span className="text-warning-content">{unit.physicalState === "missing" ? "Record missing" : "Unknown"}</span>;
}

function TargetUnavailable({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <>
      <PageHeader eyebrow="Spaces" title={title} description={description} />
      <section className="overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-sm">
        <EmptyState icon={<AlertTriangle />} title={title} description={description} action={action} />
      </section>
    </>
  );
}

function TargetUnavailablePanel({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="grid min-h-[28rem] place-items-center p-5">
      <div className="max-w-md text-center" role="alert">
        <span className="mx-auto grid size-11 place-items-center rounded-lg bg-warning/15 text-warning"><AlertTriangle size={21} /></span>
        <h3 className="mt-4 font-display text-lg font-semibold">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-base-content/55">{description}</p>
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}

function TargetUnconfirmedPanel({ title, description, busy = true }: { title: string; description: string; busy?: boolean }) {
  return (
    <div className="grid min-h-[28rem] place-items-center p-5">
      <div className="max-w-md text-center" role="status" aria-live="polite">
        <span className="mx-auto grid size-11 place-items-center rounded-lg bg-info/12 text-info">
          {busy ? <LoaderCircle className="animate-spin" size={21} /> : <ShieldCheck size={21} />}
        </span>
        <h3 className="mt-4 font-display text-lg font-semibold">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-base-content/55">{description}</p>
      </div>
    </div>
  );
}

function TargetPromptPanel() {
  return (
    <div className="grid min-h-[28rem] place-items-center p-5">
      <div className="max-w-sm text-center">
        <span className="mx-auto grid size-11 place-items-center rounded-lg bg-secondary/12 text-secondary"><DoorOpen size={21} /></span>
        <h3 className="mt-4 font-display text-lg font-semibold">Choose a room</h3>
        <p className="mt-2 text-sm leading-6 text-base-content/55">Select a room to inspect its physical beds and sellability records.</p>
      </div>
    </div>
  );
}

function SourceActivity({ label, className = "mb-4" }: { label: string; className?: string }) {
  return (
    <div className={`flex min-h-10 items-center gap-2 rounded-lg border border-info/20 bg-info/8 px-3 py-2 text-xs font-medium text-info-content ${className}`} role="status" aria-live="polite">
      <LoaderCircle className="animate-spin" size={15} aria-hidden="true" />
      {label}
    </div>
  );
}

function evidenceState(source: CompositeSource, readable: boolean, authorityCurrent: boolean): SpacesEvidenceState {
  if (!readable) return "restricted";
  if (!authorityCurrent) return compositeSourceUsable(source.state) ? "stale" : "unavailable";
  if (compositeSourceCurrent(source)) return "current";
  if (compositeSourceUsable(source.state)) return "stale";
  return "unavailable";
}

function clearResourceTargets(params: URLSearchParams) {
  params.delete("q");
  params.delete("retire");
  params.delete("retirement");
  params.delete("room");
  params.delete("bed");
  params.delete("unit");
  params.delete("focus");
  params.delete("edit");
  params.delete("blockGroup");
  params.delete("history");
  params.delete("arrival");
  params.delete("departure");
  params.delete("spacesSurfaceFrom");
  params.delete("spacesSurfaceHistory");
}
