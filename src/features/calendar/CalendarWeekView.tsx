import { applicationPath } from "../../app/deploymentBase";
import {
  BedDouble,
  Blocks,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  DoorOpen,
  Hourglass,
  LogIn,
  LogOut,
  Plus,
  Settings2,
  UserRound,
} from "lucide-react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type {
  ManualBlock,
  ReservationListItem,
  RoomInventory,
} from "../../api/types";
import { reservationStatusLabel } from "../../api/labels";
import type { CompositeSourceState } from "../../app/compositeSourceState";
import { reservationStatusKey } from "../../app/liveUpdates";
import { reservationAttentionReasons, reservationPendingAttention, type ReservationAttention } from "../reservations/reservationOperationalView";
import { ReservationAttentionIndicators } from "../reservations/ReservationAttentionIndicators";
import { parseDateKey, toDateKey } from "../../components/ui/DatePicker";
import { EmptyState, InitialAvatar, Modal, StatusBadge } from "../../components/ui/primitives";
import {
  calendarDayMovementCounts,
  isCalendarCompletedReservation,
  reservationCalendarEventKind,
  reservationMovementLabel,
  reservationStayPhaseLabel,
  reservationsForCalendarDay,
  weekWindow,
  type CalendarEventKind,
} from "./calendarModel";
import {
  layoutCalendarIntervals,
  type CalendarIntervalKind,
  type CalendarIntervalLayout,
  type CalendarIntervalTimeline,
} from "./calendarIntervals";
import {
  buildCalendarResourceGroups,
  buildCalendarUnitDayStates,
  completedReservationsOutsideLayout,
  indexCalendarSchedule,
  requestedNotHeldReservations,
  reservationHoldsInventory,
  scheduleDayCounts,
  unmappedReservationCount,
  type CalendarResource,
  type CalendarResourceGroup,
  type CalendarUnitDayState,
} from "./calendarSchedule";
import { useOperationalPreview } from "../operational-preview/OperationalPreviewProvider";
import { inventoryContextFromRooms } from "../operational-preview/operationalPreviewModel";
import { operationalSpacesHref } from "../operational-preview/operationalSurfaceReturn";
import {
  operationalPreviewTriggerKey,
  type OperationalPreviewRoute,
} from "../operational-preview/operationalPreviewRoute";
import { calendarBookingTriggerKey } from "./calendarBookingRoute";
import { CALENDAR_PRESENTATION_SETTLE_MS, calendarDateHasRichPresentation, calendarPresentationWindow, calendarTimelineKeyScroll, type CalendarPresentationWindow } from "./calendarPresentationWindow";
import { CALENDAR_DAY_WIDTH, CALENDAR_RESOURCE_WIDTH, calendarDayCoverage, calendarViewportAt, calendarViewportScroll, writeCalendarViewport, type CalendarCoverage, type CalendarViewport } from "./calendarWindow";

type CalendarBookAction = (resource: CalendarResource, day: string, viewport?: CalendarViewport) => void;
const CalendarAttentionContext = createContext<ReadonlyMap<string, readonly ReservationAttention[]>>(new Map());
const calendarVisibleLabelStyle = { left: CALENDAR_RESOURCE_WIDTH + 8 };

type QuickLookKey =
  | { kind: "reservation"; id: string; day: string; resourceId?: string }
  | { kind: "block"; id: string; day: string; resourceId: string };

type ReservationTimelineSource = {
  key: string;
  kind: "reservation" | "request";
  arrival: string;
  departure: string;
  reservation: ReservationListItem;
};

type BlockTimelineSource = {
  key: string;
  kind: "block";
  arrival: string;
  departure: string;
  block: ManualBlock;
};

type CalendarTimelineSource = ReservationTimelineSource | BlockTimelineSource;

const CalendarPresentationContext = createContext<CalendarPresentationWindow | null>(null);
const CalendarBookReturnContext = createContext<{ key: string | null; frozen: boolean }>({ key: null, frozen: false });

// Only the Book lists/header buttons subscribe; summaries and intervals do not.
function CalendarPresentationOwner({ from, to, left, width, update, stop, children }: {
  from: string; to: string; left: RefObject<number>; width: RefObject<number>;
  update: RefObject<(immediate?: boolean) => void>; stop: RefObject<() => void>; children: ReactNode;
}) {
  const [window, setWindow] = useState(() => calendarPresentationWindow({ from, to, scrollLeft: left.current, width: width.current }));
  const current = useRef(window);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const next = () => calendarPresentationWindow({ from, to, scrollLeft: left.current, width: width.current, current: current.current });
    const commit = () => {
      const value = next();
      if (value !== current.current) { current.current = value; setWindow(value); }
    };
    const cancel = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
    stop.current = cancel;
    update.current = (immediate = false) => {
      cancel();
      if (immediate) commit();
      else timer.current = setTimeout(() => { timer.current = null; commit(); }, CALENDAR_PRESENTATION_SETTLE_MS);
    };
    return () => { cancel(); update.current = () => {}; stop.current = () => {}; };
  }, [from, to, left, width, update, stop]);
  return <CalendarPresentationContext value={window}>{children}</CalendarPresentationContext>;
}

export function CalendarWeekView({
  propertyId,
  dateKey,
  days,
  from,
  to,
  selectedDay,
  onSelectDay,
  reservations,
  rooms,
  roomState,
  roomCurrent = roomState === "ready",
  blocks,
  availabilityCurrent,
  canOpenSpaces,
  todayKey,
  attentionOperatingDate = null,
  attentionReservationIds,
  onBook,
  bookingFocus,
  bookingEnabled = false,
  bookingFocusReady = true,
  coverage,
  viewport,
  viewportFrozen = false,
  onViewport,
  onExtend,
}: {
  propertyId: string;
  dateKey: string;
  days: Date[];
  from: string;
  to: string;
  selectedDay: string;
  onSelectDay: (date: Date) => void;
  reservations: ReservationListItem[];
  rooms: RoomInventory[];
  roomState: CompositeSourceState;
  roomCurrent?: boolean;
  blocks: ManualBlock[];
  availabilityCurrent: boolean;
  canOpenSpaces: boolean;
  todayKey: string;
  attentionOperatingDate?: string | null;
  attentionReservationIds?: ReadonlySet<string>;
  onBook?: CalendarBookAction;
  bookingFocus?: { unitId: string | null; roomId: string | null } | null;
  bookingEnabled?: boolean;
  bookingFocusReady?: boolean;
  coverage?: CalendarCoverage[];
  viewport?: CalendarViewport;
  viewportFrozen?: boolean;
  onViewport?: (viewport: CalendarViewport) => void;
  onExtend?: (direction: -1 | 1) => void;
}) {
  const { activeRoute, openPreview } = useOperationalPreview();
  const previewAction = useRef(openPreview);
  useLayoutEffect(() => { previewAction.current = openPreview; }, [openPreview]);
  const navigate = useNavigate();
  const location = useLocation();
  const pendingPreviewIntent = useRef(false);
  useLayoutEffect(() => { pendingPreviewIntent.current = false; }, [location]);
  const attentionByReservation = useMemo(() => new Map(reservations
    .filter(reservation => reservation.propertyId === propertyId && attentionReservationIds?.has(reservation.reservationId))
    .map(reservation => [reservation.reservationId, reservationAttentionReasons(reservation, attentionOperatingDate)] as const)),
  [reservations, propertyId, attentionReservationIds, attentionOperatingDate]);
  const scroller = useRef<HTMLDivElement>(null);
  const position = useRef(viewport ?? { date: selectedDay, offset: 0 });
  const restoredViewport = useRef("");
  const restorationInputs = useRef<{ from: string; to: string; key: string; selectedDay: string; roomState: CompositeSourceState; roomCount: number } | null>(null);
  const restoringScroll = useRef(false);
  const previousScroll = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportCallback = useRef(onViewport);
  viewportCallback.current = onViewport;
  const presentationWidth = useRef(0);
  const presentationLeft = useRef(calendarViewportScroll(from, viewport ?? { date: selectedDay, offset: 0 }));
  const presentationUpdate = useRef<(immediate?: boolean) => void>(() => {});
  const presentationStop = useRef<() => void>(() => {});
  const focusNavigation = useRef(false);
  const mountedGeneration = useRef({});
  const focusViewportEcho = useRef<{
    propertyId: string; from: string; to: string; dateKey: string; selectedDay: string;
    roomState: CompositeSourceState; roomCount: number; generation: object; viewport: CalendarViewport;
  } | null>(null);
  const retainedKeyNavigation = useRef(false);
  const bookReturn = useMemo(() => ({ key: bookingFocus?.unitId ? calendarBookingTriggerKey(bookingFocus.unitId, selectedDay) : null, frozen: viewportFrozen }), [bookingFocus?.unitId, selectedDay, viewportFrozen]);
  const edgeIntent = useRef<{ key: string; directions: Set<-1 | 1> } | null>(null);
  const edgeKey = `${propertyId}:${from}:${to}:${viewportFrozen}`;
  // The Page keys this view by authority and unmounts it when reads are denied.
  // Background query renders must not re-arm the same retained edge.
  if (edgeIntent.current?.key !== edgeKey) {
    edgeIntent.current = { key: edgeKey, directions: new Set() };
  }
  const extendAtEdge = (element: HTMLDivElement, direction: -1 | 1, threshold: number) => {
    if (viewportFrozen) return;
    if (pendingPreviewIntent.current) return;
    if (restoringScroll.current || !onExtend) return;
    const remaining = direction < 0 ? element.scrollLeft : element.scrollWidth - element.clientWidth - element.scrollLeft;
    if (remaining > threshold || edgeIntent.current!.directions.has(direction)) return;
    edgeIntent.current!.directions.add(direction);
    position.current = calendarViewportAt(from, element.scrollLeft);
    onExtend(direction);
  };
  const queueViewportUpdate = () => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    const ownedLocation = location;
    scrollTimer.current = setTimeout(() => {
      scrollTimer.current = null;
      // Focus reveal may deliver a new scroll after the preview click, while
      // its route render is still pending. Keep tracking position, not old URLs.
      if (pendingPreviewIntent.current) return;
      // A lazy destination can leave Calendar mounted after browser navigation.
      // This publication owns only the location at which it was scheduled.
      if (window.location.pathname !== ownedLocation.pathname
        || window.location.search !== ownedLocation.search
        || window.location.hash !== ownedLocation.hash) return;
      const callback = viewportCallback.current;
      if (!callback) return;
      const published = { ...position.current };
      focusViewportEcho.current = focusNavigation.current ? {
        propertyId, from, to, dateKey, selectedDay, roomState, roomCount: rooms.length,
        generation: mountedGeneration.current, viewport: published,
      } : null;
      callback(published);
    }, 180);
  };
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const key = viewport ? `${viewport.date}:${viewport.offset}` : selectedDay;
    const requested = viewport ?? { date: selectedDay, offset: 0 };
    const echo = focusViewportEcho.current;
    focusViewportEcho.current = null;
    // A real focus-scroll updates URL orientation, but its own exact echo must
    // not expand the frozen Tab window or restore an older physical position.
    const ownFocusEcho = viewport && echo && echo.generation === mountedGeneration.current
      && echo.propertyId === propertyId && echo.from === from && echo.to === to
      && echo.dateKey === dateKey && echo.selectedDay === selectedDay
      && echo.roomState === roomState && echo.roomCount === rooms.length
      && echo.viewport.date === viewport.date && echo.viewport.offset === viewport.offset;
    if (ownFocusEcho) {
      restoredViewport.current = key;
      restorationInputs.current = { from, to, key, selectedDay, roomState, roomCount: rooms.length };
      restoringScroll.current = false;
      return;
    }
    // A divergent route, range or owner input supersedes a queued old write.
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = null;
    const newlyAdmitted = restoredViewport.current !== key && requested.date >= from && requested.date < to;
    if (newlyAdmitted) {
      position.current = requested;
      restoredViewport.current = key;
    }
    const outsideWindow = position.current.date < from || position.current.date >= to;
    if (outsideWindow) position.current = { date: selectedDay >= from && selectedDay < to ? selectedDay : from, offset: 0 };
    const previous = restorationInputs.current;
    restorationInputs.current = { from, to, key, selectedDay, roomState, roomCount: rooms.length };
    // Right append leaves the existing columns at the same physical offset.
    // Decide without reading scrollLeft: even an equality read can flush layout.
    if (previous && previous.from === from && previous.to < to && previous.key === key
      && previous.selectedDay === selectedDay && previous.roomState === roomState && previous.roomCount === rooms.length
      && !newlyAdmitted && !outsideWindow) {
      restoringScroll.current = false;
      presentationUpdate.current(true);
      return;
    }
    restoringScroll.current = true;
    element.scrollLeft = Math.max(0, calendarViewportScroll(from, position.current));
    previousScroll.current = element.scrollLeft;
    presentationLeft.current = previousScroll.current;
    presentationUpdate.current(true);
    const frame = requestAnimationFrame(() => { restoringScroll.current = false; });
    return () => cancelAnimationFrame(frame);
  }, [propertyId, dateKey, from, to, viewport?.date, viewport?.offset, selectedDay, roomState, rooms.length]);
  useLayoutEffect(() => () => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = null;
  }, []);
  useEffect(() => () => {
    pendingPreviewIntent.current = false;
    focusViewportEcho.current = null;
    mountedGeneration.current = {};
  }, []);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth;
      if (!width) return;
      presentationWidth.current = width;
      restoringScroll.current = true;
      element.scrollLeft = Math.max(0, calendarViewportScroll(from, position.current));
      previousScroll.current = element.scrollLeft;
      presentationLeft.current = previousScroll.current;
      presentationUpdate.current(true);
      restoringScroll.current = false;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [from, roomState, rooms.length]);
  const spacesHref = (roomId?: string) => operationalSpacesHref({ surface: "calendar", propertyId, date: dateKey, day: selectedDay, ...(viewport ? { viewport: position.current } : {}) }, "layout", roomId);
  const dayCurrent = (day: string) => coverage ? calendarDayCoverage(coverage, day)?.current === true : availabilityCurrent;
  const confirmedDays = days.filter((day) => dayCurrent(toDateKey(day))).length;
  const legendAvailability = confirmedDays === 0 ? "unconfirmed" : confirmedDays === days.length ? "current" : "mixed";
  const dispatchBook = useCallback<CalendarBookAction>((resource, day) => {
    if (coverage ? calendarDayCoverage(coverage, day)?.current === true : availabilityCurrent) onBook?.(resource, day, position.current);
  }, [coverage, availabilityCurrent, onBook]);
  const book = onBook ? dispatchBook : undefined;
  const groups = useMemo(() => buildCalendarResourceGroups(rooms), [rooms]);
  const resources = useMemo(
    () => groups.flatMap((group) => group.resources),
    [groups],
  );
  const resourceById = useMemo(
    () => new Map(resources.map((resource) => [resource.inventoryUnitId, resource])),
    [resources],
  );
  const unitSchedule = useMemo(() => indexCalendarSchedule(resources, reservations, blocks, days.map(toDateKey)),
    [resources, reservations, blocks, days]);
  const completed = useMemo(() => reservations.filter(isCalendarCompletedReservation), [reservations]);
  const formerCompleted = useMemo(() => completedReservationsOutsideLayout(reservations, resources), [reservations, resources]);
  const completedByUnit = useMemo(() => new Map([...unitSchedule].map(([id, model]) => [id, model.completed])), [unitSchedule]);
  const requested = useMemo(
    () => requestedNotHeldReservations(reservations),
    [reservations],
  );
  const unmapped = useMemo(
    () => unmappedReservationCount(reservations, resources),
    [reservations, resources],
  );
  const unmappedReservationIds = useMemo(() => {
    const visibleIds = new Set(resources.map((resource) => resource.inventoryUnitId));
    return reservations
      .filter(reservationHoldsInventory)
      .filter((reservation) => reservation.inventoryUnitIds.length === 0
        || reservation.inventoryUnitIds.some((unitId) => !visibleIds.has(unitId)))
      .map((reservation) => reservation.reservationId)
      .slice(0, 25);
  }, [reservations, resources]);
  const selectedDate = useMemo(() => parseDateKey(selectedDay) ?? days[0], [selectedDay, days]);
  const selectedKey = toDateKey(selectedDate);
  const selectedCurrent = dayCurrent(selectedKey);
  const mobileDays = useMemo(() => weekWindow(selectedDate).days, [selectedDate]);
  const counts = useMemo(
    () => scheduleDayCounts(resources, reservations, blocks, selectedKey),
    [resources, reservations, blocks, selectedKey],
  );
  const selectedMovements = useMemo(
    () => calendarDayMovementCounts(reservations, selectedKey),
    [reservations, selectedKey],
  );
  const selectedReservations = useMemo(
    () => reservationsForCalendarDay(reservations, selectedKey),
    [reservations, selectedKey],
  );
  const selectedUnitStates = useMemo(
    () => buildCalendarUnitDayStates(resources, reservations, blocks, selectedKey),
    [resources, reservations, blocks, selectedKey],
  );
  const selectedRequested = useMemo(
    () => requestedNotHeldReservations(selectedReservations),
    [selectedReservations],
  );
  const selectedUnmappedReservations = useMemo(
    () => selectedReservations.filter((reservation) => reservationHoldsInventory(reservation)
      && !reservation.inventoryUnitIds.some((unitId) => resourceById.has(unitId))),
    [selectedReservations, resourceById],
  );
  const defaultMobileExpandedRooms = useMemo(() => {
    const active = groups
      .filter((group) => {
        const groupCounts = scheduleDayCounts(group.resources, reservations, blocks, selectedKey);
        const groupUnitIds = new Set(group.resources.map((resource) => resource.inventoryUnitId));
        const hasMovement = reservations.some((reservation) => reservationHoldsInventory(reservation)
          && reservation.inventoryUnitIds.some((unitId) => groupUnitIds.has(unitId))
          && (reservation.arrival === selectedKey || reservation.departure === selectedKey));
        return hasMovement
          || completed.some((reservation) => reservation.inventoryUnitIds.some((id) => groupUnitIds.has(id))
            && reservation.arrival <= selectedKey && reservation.departure >= selectedKey)
          || groupCounts.occupied > 0
          || groupCounts.blocked > 0
          || groupCounts.conflicts > 0;
      })
      .map((group) => group.roomId);
    if (!active.length && groups[0]) active.push(groups[0].roomId);
    return new Set(active);
  }, [groups, reservations, completed, blocks, selectedKey]);
  const [desktopCollapsedRooms, setDesktopCollapsedRooms] = useState<Set<string>>(() => new Set());
  const [mobileExpansion, setMobileExpansion] = useState<{ day: string; roomIds: Set<string> }>({
    day: "",
    roomIds: new Set(),
  });
  const quickLookKey = useMemo(() => calendarQuickLookKey(activeRoute, propertyId), [activeRoute, propertyId]);
  const mobileExpandedRooms = mobileExpansion.day === selectedKey
    ? mobileExpansion.roomIds
    : defaultMobileExpandedRooms;
  const allDesktopCollapsed = groups.length > 0
    && groups.every((group) => desktopCollapsedRooms.has(group.roomId));
  const allMobileExpanded = groups.length > 0
    && groups.every((group) => mobileExpandedRooms.has(group.roomId));
  const restoredFocus = useRef("");
  const focusKey = bookingFocus ? `${propertyId}:${dateKey}:${selectedKey}:${bookingFocus.unitId ?? "new"}` : "";
  useEffect(() => {
    if (!focusKey || restoredFocus.current === focusKey || roomState === "loading" || !bookingFocusReady) return;
    if (bookingFocus?.roomId) {
      setDesktopCollapsedRooms((current) => { const next = new Set(current); next.delete(bookingFocus.roomId!); return next; });
      setMobileExpansion((current) => ({ day: selectedKey, roomIds: new Set([
        ...(current.day === selectedKey ? current.roomIds : defaultMobileExpandedRooms), bookingFocus.roomId!,
      ]) }));
    }
    let secondFrame = 0;
    let revealFrame = 0;
    const frame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(() => {
      const key = bookingFocus?.unitId ? calendarBookingTriggerKey(bookingFocus.unitId, selectedKey) : null;
      const candidate = key
        ? Array.from(document.querySelectorAll<HTMLElement>("[data-calendar-booking-trigger]")).find((element) => element.dataset.calendarBookingTrigger === key && element.getClientRects().length > 0 && element.getAttribute("aria-disabled") !== "true")
        : document.querySelector<HTMLElement>("[data-calendar-new-reservation]");
      const target = candidate ?? document.getElementById("calendar-heading");
      if (target) {
        // Restoring focus is not an operator scroll. Keep the saved comparison
        // position unless the exact target is obscured, and never publish the
        // intermediate restore/reveal position back to the route.
        restoringScroll.current = true;
        if (scrollTimer.current) clearTimeout(scrollTimer.current);
        const timeline = scroller.current;
        if (timeline?.contains(target)) revealCalendarTimelineAction(target, timeline);
        const frame = target.getBoundingClientRect();
        const topbar = document.querySelector(".app-topbar")?.getBoundingClientRect();
        const pageDelta = calendarTimelineFocusAdjustment(frame, {
          left: frame.left, right: frame.right,
          top: Math.max(8, (topbar?.bottom ?? 0) + 2), bottom: window.innerHeight - 8,
        });
        if (pageDelta.top) window.scrollBy({ top: pageDelta.top, behavior: "instant" });
        target.focus({ preventScroll: true });
        if (timeline?.clientWidth) {
          previousScroll.current = timeline.scrollLeft;
          position.current = calendarViewportAt(from, timeline.scrollLeft);
          presentationLeft.current = previousScroll.current;
          presentationUpdate.current(true);
        }
        revealFrame = requestAnimationFrame(() => { restoringScroll.current = false; revealFrame = 0; });
        restoredFocus.current = focusKey;
      }
    }); });
    return () => {
      cancelAnimationFrame(frame); cancelAnimationFrame(secondFrame);
      if (revealFrame) { cancelAnimationFrame(revealFrame); restoringScroll.current = false; }
    };
  }, [focusKey, bookingFocus?.roomId, bookingFocus?.unitId, selectedKey, defaultMobileExpandedRooms, roomState, bookingFocusReady, from]);

  function toggleDesktopRoom(roomId: string) {
    setDesktopCollapsedRooms((current) => toggleSetValue(current, roomId));
  }

  function toggleMobileRoom(roomId: string) {
    setMobileExpansion({
      day: selectedKey,
      roomIds: toggleSetValue(mobileExpandedRooms, roomId),
    });
  }

  const capturePreviewViewport = useCallback((trigger: HTMLButtonElement) => {
    // The preview route owns this position now, before its React render commits.
    // A queued pre-open publication must not replace that route with old params.
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = null;
    pendingPreviewIntent.current = true;
    focusViewportEcho.current = null;
    const timeline = scroller.current;
    if (timeline?.contains(trigger)) position.current = calendarViewportAt(from, timeline.scrollLeft);
    return { ...position.current };
  }, [from]);

  const openReservation = useCallback((
    reservation: ReservationListItem,
    resource: CalendarResource | undefined,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    const route: OperationalPreviewRoute = {
      selection: {
        kind: "reservation",
        propertyId,
        reservationId: reservation.reservationId,
        date: day,
        inventoryUnitId: resource?.inventoryUnitId,
        roomId: resource?.roomId,
        bedId: resource?.bedId,
      },
      origin: { surface: "calendar", propertyId, date: dateKey, day: selectedDay, viewport: capturePreviewViewport(event.currentTarget) },
    };
    previewAction.current({
      route,
      seed: {
        kind: "reservation",
        reservation,
        inventory: resource ? calendarInventoryContext(resource) : undefined,
      },
      trigger: event.currentTarget,
    });
  }, [propertyId, dateKey, selectedDay, capturePreviewViewport]);

  const openBlock = useCallback((
    block: ManualBlock,
    resource: CalendarResource,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    const route: OperationalPreviewRoute = {
      selection: {
        kind: "inventoryBlock",
        propertyId,
        blockGroupId: block.blockGroupId || block.blockId,
        blockId: block.blockId,
        date: day,
        inventoryUnitId: resource.inventoryUnitId,
        roomId: resource.roomId,
        bedId: resource.bedId,
      },
      origin: { surface: "calendar", propertyId, date: dateKey, day: selectedDay, viewport: capturePreviewViewport(event.currentTarget) },
    };
    previewAction.current({
      route,
      seed: {
        kind: "inventoryBlock",
        block,
        inventory: calendarInventoryContext(resource),
      },
      trigger: event.currentTarget,
    });
  }, [propertyId, dateKey, selectedDay, capturePreviewViewport]);

  const completedFallback = (items: ReservationListItem[], knownRooms: RoomInventory[]) => (
    <CalendarCompletedFallback reservations={items} rooms={knownRooms} from={from} to={to} selectedDay={selectedDay}
      propertyId={propertyId} dateKey={dateKey} selected={quickLookKey} onOpen={openReservation} />
  );

  if (roomState === "loading") {
    return <div className="p-8 text-center text-sm text-base-content/50">Preparing the room schedule...</div>;
  }

  if (roomState === "unavailable") {
    return (
      <><EmptyState
        icon={<DoorOpen />}
        title="Room schedule unavailable"
        description="The reservation dates are available, but room and bed topology could not be loaded."
      />{completedFallback(completed, [])}</>
    );
  }

  if (!resources.length) {
    if (!roomCurrent) return <><EmptyState icon={<DoorOpen />} title="Room layout unconfirmed" description="Wait for the current room layout or retry its source above. An empty layout has not been confirmed." />{completedFallback(completed, [])}</>;
    return (
      <><EmptyState
        icon={<DoorOpen />}
        title="No sellable rooms yet"
        description="Set up rooms, beds and how they are sold in Spaces to build the operating schedule."
        action={canOpenSpaces
          ? <Link to={spacesHref()} className="btn btn-primary btn-sm"><Blocks size={16} />Rooms & beds</Link>
          : undefined}
      />{completedFallback(completed, roomCurrent ? rooms : [])}</>
    );
  }

  return (
    <CalendarAttentionContext value={attentionByReservation}><div onClickCapture={(event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link) return;
      const destination = new URL(link.href, window.location.origin);
      if (applicationPath(destination.pathname) !== "/spaces" || destination.searchParams.get("surfaceReturn") !== "calendar") return;
      event.preventDefault();
      writeCalendarViewport(destination.searchParams, viewport ? position.current : undefined, "surfaceReturnViewport");
      navigate(`${applicationPath(destination.pathname)}?${destination.searchParams}`);
    }}>
      {coverage && <CalendarCoverageStatus coverage={coverage} viewportFrozen={viewportFrozen} selectedDate={selectedDate} onShowSelectedDay={() => onSelectDay(selectedDate)} />}
      <CalendarScheduleLegend availability={legendAvailability} />
      {unmapped > 0 && (
        <Link
          to={`/reservations?affected=${unmappedReservationIds.join(",")}`}
          className="flex items-center gap-3 border-b border-warning/35 bg-warning/12 px-4 py-3 text-warning-content transition hover:bg-warning/18 sm:px-6"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-warning/20"><CircleAlert size={17} /></span>
          <span className="min-w-0 flex-1 text-sm"><strong>{unmapped} {unmapped === 1 ? "reservation has" : "reservations have"} held inventory outside the current layout.</strong> Review the affected stay before assigning inventory again.</span>
          <ChevronRight size={17} className="shrink-0" />
        </Link>
      )}

      {!coverage && !availabilityCurrent && (
        <div
          className="flex items-start gap-2.5 border-b border-warning/30 bg-warning/9 px-4 py-2.5 text-sm text-warning-content sm:px-6"
          role="status"
        >
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span><strong>Availability gaps are unconfirmed.</strong> Known reservations and blocks stay visible while schedule sources refresh or recover.</span>
        </div>
      )}

      <div className="lg:hidden">
        <div className="grid grid-cols-7 border-b border-base-300 bg-base-200/55 p-1.5">
          {mobileDays.map((date) => {
            const key = toDateKey(date);
            const selected = key === selectedKey;
            const today = key === todayKey;
            return (
              <button
                key={key}
                type="button"
                aria-label={`Show ${formatFullDate(date)}`}
                aria-pressed={selected}
                disabled={viewportFrozen}
                className={`min-w-0 rounded-lg px-0.5 py-2 text-center transition ${selected ? "bg-primary text-primary-content shadow-sm" : "hover:bg-base-100"}`}
                onClick={() => onSelectDay(date)}
              >
                <span className={`block text-[0.62rem] font-semibold uppercase ${selected ? "opacity-75" : "text-base-content/45"}`}>{formatNarrowWeekday(date)}</span>
                <span className={`mt-1 block text-sm font-semibold ${today && !selected ? "text-primary" : ""}`}>{date.getDate()}</span>
              </button>
            );
          })}
        </div>

        <div className="border-b border-base-300 px-4 py-4 sm:px-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase text-primary">{formatWeekday(selectedDate)}</p>
              <h2 className="mt-1 font-display text-lg font-semibold">{formatMonthDay(selectedDate)}</h2>
            </div>
            <div className="text-right text-xs text-base-content/50">
              <strong className="block text-lg leading-none text-base-content">{selectedCurrent ? counts.free : "-"}</strong>
              <span className="mt-1 block">{selectedCurrent ? "units free" : "availability unconfirmed"}</span>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium">
            <DayCount icon={<LogIn size={13} />} label={selectedCurrent ? `${selectedMovements.arrivals} arriving` : "Arrivals unconfirmed"} tone="bg-success/10 text-success" />
            <DayCount icon={<LogOut size={13} />} label={selectedCurrent ? `${selectedMovements.departures} departing` : "Departures unconfirmed"} tone="bg-primary/9 text-primary" />
            <DayCount icon={<UserRound size={13} />} label={`${counts.occupied} occupied`} tone="bg-secondary/10 text-secondary" />
            <DayCount icon={<Blocks size={13} />} label={selectedCurrent ? `${counts.blocked} blocked` : "Blocks unconfirmed"} tone="bg-warning/16 text-warning-content" />
            {selectedMovements.attention > 0 && <DayCount icon={<CircleAlert size={13} />} label={`${selectedMovements.attention} · attention on this date`} tone="bg-warning/18 text-warning-content" />}
            {counts.conflicts > 0 && <DayCount icon={<CircleAlert size={13} />} label={`${counts.conflicts} conflicts`} tone="bg-error/10 text-error" />}
          </div>
        </div>

        {selectedRequested.length > 0 && (
          <ReservationReviewSection
            id="calendar-requested-heading"
            icon={<Hourglass size={16} />}
            title="Requested inventory — not held"
            description="These requests do not reserve a room or bed yet. Confirm allocation before relying on availability."
            reservations={selectedRequested}
            day={selectedKey}
            from={from}
            to={to}
            resources={resourceById}
            onOpen={openReservation}
            requested
          />
        )}

        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-base-300 bg-base-200/35 px-4 py-2 sm:px-5">
          <div>
            <p className="text-sm font-semibold">Rooms and beds</p>
            <p className="text-xs text-base-content/50">{groups.length} {groups.length === 1 ? "room" : "rooms"} · {resources.length} sellable {resources.length === 1 ? "unit" : "units"}</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm min-h-11"
            onClick={() => setMobileExpansion({
              day: selectedKey,
              roomIds: allMobileExpanded ? new Set() : new Set(groups.map((group) => group.roomId)),
            })}
          >
            {allMobileExpanded ? "Collapse all" : "Expand all"}
          </button>
        </div>

        <div className="divide-y divide-base-300">
          {groups.map((group) => (
            <MobileRoomGroup
              key={group.roomId}
              group={group}
              day={selectedKey}
              from={from}
              to={to}
              expanded={mobileExpandedRooms.has(group.roomId)}
              unitStates={selectedUnitStates}
              completedByUnit={completedByUnit}
              propertyId={propertyId}
              dateKey={dateKey}
              availabilityCurrent={selectedCurrent}
              roomSpacesHref={canOpenSpaces ? spacesHref(group.roomId) : null}
              selected={quickLookKey}
              onOpenReservation={openReservation}
              onOpenBlock={openBlock}
              onToggle={() => toggleMobileRoom(group.roomId)}
              onBook={selectedKey >= todayKey ? book : undefined}
              bookingEnabled={bookingEnabled && selectedCurrent}
            />
          ))}
        </div>

        {selectedUnmappedReservations.length > 0 && (
          <ReservationReviewSection
            id="calendar-unplaced-heading"
            icon={<CircleAlert size={16} />}
            title="Held inventory needs review"
            description="These stays hold inventory that is no longer attached to a visible room or bed."
            reservations={selectedUnmappedReservations}
            day={selectedKey}
            from={from}
            to={to}
            resources={resourceById}
            onOpen={openReservation}
          />
        )}
      </div>

      <div className="hidden lg:block">
        <div
          ref={scroller}
          className="calendar-timeline min-h-[26rem] max-h-[calc(100vh-18rem)] overflow-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
          role="region"
          aria-label="Room and bed occupancy timeline"
          aria-describedby="calendar-timeline-navigation"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const element = event.currentTarget;
            const left = calendarTimelineKeyScroll(event.key, element.scrollLeft, element.clientWidth, element.scrollWidth);
            if (left === null) return;
            focusViewportEcho.current = null;
            focusNavigation.current = false;
            retainedKeyNavigation.current = event.key === "Home" || event.key === "End";
            if (!retainedKeyNavigation.current) extendAtEdge(element, event.key === "ArrowLeft" || event.key === "PageUp" ? -1 : 1, 1);
            event.preventDefault(); element.scrollTo({ left, behavior: "instant" });
            previousScroll.current = element.scrollLeft;
            position.current = calendarViewportAt(from, element.scrollLeft);
            presentationLeft.current = element.scrollLeft;
            presentationUpdate.current(true);
            queueViewportUpdate();
          }}
          onPointerDown={() => { focusViewportEcho.current = null; focusNavigation.current = false; retainedKeyNavigation.current = false; }}
          onWheel={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
            focusViewportEcho.current = null;
            focusNavigation.current = false;
            retainedKeyNavigation.current = false;
            // A native wheel at a clamp produces no scroll event. Observe only
            // horizontal intent; leave native horizontal/vertical motion alone.
            extendAtEdge(event.currentTarget, event.deltaX < 0 ? -1 : 1, 1);
          }}
          onScroll={(event) => {
            const element = event.currentTarget;
            if (restoringScroll.current) return;
            const movement = element.scrollLeft - previousScroll.current;
            previousScroll.current = element.scrollLeft;
            if (!movement) return;
            position.current = calendarViewportAt(from, element.scrollLeft);
            presentationLeft.current = previousScroll.current;
            queueViewportUpdate();
            if (focusNavigation.current) return;
            presentationUpdate.current();
            if (!retainedKeyNavigation.current) extendAtEdge(element, movement < 0 ? -1 : 1, CALENDAR_DAY_WIDTH * 3);
          }}
          onFocusCapture={(event) => {
            // Native Tab reveal must not grow the very Tab sequence being used.
            focusNavigation.current = event.target !== event.currentTarget;
            if (focusNavigation.current) {
              presentationStop.current();
            }
            if (restoringScroll.current) return;
            const viewport = event.currentTarget;
            const action = event.target instanceof HTMLElement
              ? event.target.closest<HTMLElement>("[data-operational-preview-trigger], [data-calendar-booking-trigger], [data-calendar-header-action]") : null;
            if (!action || !viewport.contains(action)) return;
            revealCalendarTimelineAction(action, viewport);
          }}
        >
          <p id="calendar-timeline-navigation" className="sr-only">When the timeline is focused, Left and Right move one day; Page Up and Page Down move one visible page; Home and End move to the retained date edges. Tab visits presented dates and booking actions, plus all stay and hold controls, then leaves the timeline. Use the date jump for another date.</p>
          <CalendarBookReturnContext value={bookReturn}>
          <CalendarPresentationOwner from={from} to={to} left={presentationLeft} width={presentationWidth} update={presentationUpdate} stop={presentationStop}>
          <table className="min-w-[64rem] table-fixed border-collapse" style={{ width: CALENDAR_RESOURCE_WIDTH + days.length * CALENDAR_DAY_WIDTH }} aria-colcount={days.length + 1} aria-label="Room and bed occupancy by date">
            <caption className="sr-only">Room and bed occupancy from {from} through the dates ending before {to}. Departures remain visible but do not occupy the departure night.</caption>
            <colgroup>
              <col className="w-60" />
              {days.map((date) => <col key={toDateKey(date)} style={{ width: CALENDAR_DAY_WIDTH }} />)}
            </colgroup>
            <thead className="sticky top-0 z-30 bg-base-200/95 shadow-[0_1px_0_var(--color-base-300)] backdrop-blur-sm">
              <tr className="border-b border-base-300">
                <th id="calendar-resource-heading" scope="col" aria-colindex={1} className="sticky left-0 z-30 border-r border-base-300 bg-base-200 px-3 py-2 text-left">
                  <span className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase text-base-content/50"><BedDouble size={15} />Rooms and beds</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs min-h-8 px-2 text-[0.68rem]"
                      onClick={() => setDesktopCollapsedRooms(allDesktopCollapsed
                        ? new Set()
                        : new Set(groups.map((group) => group.roomId)))}
                    >
                      {allDesktopCollapsed ? "Expand all" : "Collapse all"}
                    </button>
                  </span>
                </th>
                {days.map((date) => {
                  const key = toDateKey(date);
                  const today = key === todayKey;
                  const selected = key === selectedDay;
                  return (
                    <th
                      key={key}
                      id={`calendar-day-${key}`}
                      scope="col"
                      data-calendar-day-header={key}
                      className={`border-r border-base-300 p-0 text-center last:border-r-0 ${selected ? "bg-primary/12 text-primary" : today ? "bg-secondary/10 text-secondary" : ""}`}
                    >
                      <CalendarDateHeaderButton date={date} today={today} selected={selected} frozen={viewportFrozen} onSelectDay={onSelectDay} />
                    </th>
                  );
                })}
              </tr>
            </thead>

            {requested.length > 0 && (
              <tbody className="border-b-2 border-warning/25 bg-warning/5" aria-label="Requested inventory not held">
                <tr className="border-b border-warning/20">
                  <th id="calendar-request-summary-heading" scope="row" aria-colindex={1} className="sticky left-0 z-[25] border-r border-warning/25 bg-[color-mix(in_oklab,var(--color-base-100)_88%,var(--color-warning)_12%)] px-3 py-2 text-left">
                    <span className="flex items-center gap-2 text-sm font-semibold text-warning-content"><Hourglass size={16} />Requested — not held</span>
                    <span className="mt-1 block text-xs font-normal leading-4 text-base-content/55">Requests are not occupancy.</span>
                  </th>
                  <RequestedSummaryCells days={days} requested={requested} coverage={coverage} availabilityCurrent={availabilityCurrent} />
                </tr>
                {requested.map((reservation) => (
                  <RequestedReservationRow
                    key={reservation.reservationId}
                    reservation={reservation}
                    days={days}
                    from={from}
                    to={to}
                    todayKey={todayKey}
                    resources={resourceById}
                    calendarSelectedDay={selectedDay}
                    selected={quickLookKey?.kind === "reservation" && quickLookKey.id === reservation.reservationId}
                    propertyId={propertyId}
                    dateKey={dateKey}
                    onOpen={openReservation}
                  />
                ))}
              </tbody>
            )}

            {groups.map((group) => {
              const contentId = `calendar-room-units-${group.roomId}`;
              const collapsed = desktopCollapsedRooms.has(group.roomId);
              return (
                <tbody key={group.roomId} id={contentId} aria-labelledby={`calendar-room-${group.roomId}`}>
                  <tr className="border-b border-base-300 bg-[color-mix(in_oklab,var(--color-base-100)_82%,var(--color-accent)_18%)]">
                    <th id={`calendar-room-heading-${group.roomId}`} scope="row" aria-colindex={1} className="sticky left-0 z-20 border-r border-base-300 bg-[color-mix(in_oklab,var(--color-base-100)_82%,var(--color-accent)_18%)] px-2 py-1.5 text-left">
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left transition hover:bg-base-100/65 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                          aria-expanded={!collapsed}
                          aria-controls={contentId}
                          onClick={() => toggleDesktopRoom(group.roomId)}
                        >
                          {collapsed
                            ? <ChevronRight size={16} className="shrink-0 text-base-content/45" />
                            : <ChevronDown size={16} className="shrink-0 text-base-content/45" />}
                          <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${group.isPrivateRoom ? "bg-secondary/12 text-secondary" : "bg-primary/9 text-primary"}`}>
                            {group.isPrivateRoom ? <DoorOpen size={17} /> : <BedDouble size={17} />}
                          </span>
                          <span className="min-w-0">
                            <strong id={`calendar-room-${group.roomId}`} className="block truncate text-sm">{group.roomName}</strong>
                            <span className="mt-0.5 block truncate text-[0.68rem] font-normal text-base-content/45">{group.location}</span>
                          </span>
                        </button>
                        {canOpenSpaces && (
                          <Link
                            to={spacesHref(group.roomId)}
                            className="btn btn-circle btn-ghost btn-sm shrink-0"
                            aria-label={`Open ${group.roomName} in Spaces`}
                            title="Open room in Spaces"
                          >
                            <Settings2 size={16} />
                          </Link>
                        )}
                      </span>
                    </th>
                    <RoomSummaryCells group={group} days={days} reservations={reservations} blocks={blocks} coverage={coverage} availabilityCurrent={availabilityCurrent} />
                  </tr>
                  {!collapsed && group.resources.map((resource) => (
                    <ScheduleResourceRow
                      key={resource.inventoryUnitId}
                      resource={resource}
                      days={days}
                      from={from}
                      to={to}
                      selectedDay={selectedDay}
                      todayKey={todayKey}
                      propertyId={propertyId}
                      dateKey={dateKey}
                      reservations={unitSchedule.get(resource.inventoryUnitId)!.reservations}
                      completed={unitSchedule.get(resource.inventoryUnitId)!.completed}
                      blocks={unitSchedule.get(resource.inventoryUnitId)!.blocks}
                      dayStates={unitSchedule.get(resource.inventoryUnitId)!.days}
                      selected={quickLookKey}
                      onOpenReservation={openReservation}
                      onOpenBlock={openBlock}
                      onBook={book}
                      bookingEnabled={bookingEnabled}
                      availabilityCurrent={availabilityCurrent}
                      coverage={coverage}
                    />
                  ))}
                </tbody>
              );
            })}
          </table>
          </CalendarPresentationOwner>
          </CalendarBookReturnContext>
        </div>
      </div>
      {completedFallback(formerCompleted, roomCurrent ? rooms : [])}
    </div></CalendarAttentionContext>
  );
}

function CalendarDateHeaderButton({ date, today, selected, frozen, onSelectDay }: {
  date: Date; today: boolean; selected: boolean; frozen: boolean; onSelectDay: (date: Date) => void;
}) {
  const window = useContext(CalendarPresentationContext);
  const [focused, setFocused] = useState(false);
  const day = toDateKey(date);
  return <button
    type="button" data-calendar-header-action={day}
    tabIndex={!window || focused || calendarDateHasRichPresentation(window, day) ? 0 : -1}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    className="min-h-14 w-full px-2 py-2 text-center transition hover:bg-base-100/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
    onClick={() => onSelectDay(date)}
    aria-label={`Show ${formatFullDate(date)}${today ? ", today" : ""}${selected ? ", selected" : ""}`}
    aria-current={today ? "date" : undefined} aria-pressed={selected} disabled={frozen}
  >
    <span className="flex items-center justify-center gap-1 text-[0.65rem] font-semibold uppercase opacity-60">
      {formatNarrowWeekday(date)}{today && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
    </span>
    <span className="mt-1 block text-sm font-semibold">{formatShortMonthDay(date)}</span>
  </button>;
}

const RoomSummaryCells = memo(function RoomSummaryCells({ group, days, reservations, blocks, coverage, availabilityCurrent }: {
  group: CalendarResourceGroup; days: Date[]; reservations: ReservationListItem[];
  blocks: ManualBlock[]; coverage?: CalendarCoverage[]; availabilityCurrent: boolean;
}) {
  return <>{days.map((date, index) => <RoomDaySummaryCell
    key={toDateKey(date)} group={group} date={date} column={index + 2} reservations={reservations} blocks={blocks}
    availabilityCurrent={coverage ? calendarDayCoverage(coverage, toDateKey(date))?.current === true : availabilityCurrent}
  />)}</>;
});

const RequestedSummaryCells = memo(function RequestedSummaryCells({ days, requested, coverage, availabilityCurrent }: {
  days: Date[]; requested: ReservationListItem[]; coverage?: CalendarCoverage[]; availabilityCurrent: boolean;
}) {
  return <>{days.map((date, index) => {
    const day = toDateKey(date), requests = reservationsForCalendarDay(requested, day);
    const current = coverage ? calendarDayCoverage(coverage, day)?.current === true : availabilityCurrent;
    return <td key={day} headers={`calendar-request-summary-heading calendar-day-${day}`} aria-colindex={index + 2} className="border-r border-warning/20 px-2 py-2 align-middle last:border-r-0">
      <span className="block text-xs font-semibold text-warning-content">{current ? requests.length || "—" : "Unconfirmed"}</span>
      {requests.length > 0 && <MovementSummary counts={calendarDayMovementCounts(requests, day)} compact />}
    </td>;
  })}</>;
});

const RoomDaySummaryCell = memo(function RoomDaySummaryCell({
  group,
  date,
  reservations,
  blocks,
  availabilityCurrent,
  column,
}: {
  group: CalendarResourceGroup;
  date: Date;
  reservations: ReservationListItem[];
  blocks: ManualBlock[];
  availabilityCurrent: boolean;
  column: number;
}) {
  const day = toDateKey(date);
  const groupUnitIds = new Set(group.resources.map((resource) => resource.inventoryUnitId));
  const groupReservations = reservations.filter((reservation) => reservationHoldsInventory(reservation)
    && reservation.inventoryUnitIds.some((unitId) => groupUnitIds.has(unitId)));
  const counts = scheduleDayCounts(group.resources, groupReservations, blocks, day);
  const movements = calendarDayMovementCounts(groupReservations, day);
  const primary = !availabilityCurrent
    ? counts.occupied > 0 ? `${counts.occupied} occupied` : "Unconfirmed"
    : counts.conflicts > 0
      ? `${counts.conflicts} ${counts.conflicts === 1 ? "conflict" : "conflicts"}`
      : counts.free > 0
        ? `${counts.free} free`
        : counts.blocked === counts.total
          ? "Blocked"
          : "Full";
  const tone = !availabilityCurrent
    ? "bg-warning/7 text-warning-content"
    : counts.conflicts > 0
      ? "bg-error/9 text-error"
      : counts.free === 0
        ? "bg-base-200/75 text-base-content/70"
        : "text-success";
  const Icon = !availabilityCurrent || counts.conflicts > 0
    ? CircleAlert
    : counts.free > 0
      ? CheckCircle2
      : counts.blocked === counts.total
        ? Blocks
        : UserRound;

  return (
    <td
      headers={`calendar-room-heading-${group.roomId} calendar-day-${day}`}
      aria-colindex={column}
      className={`h-14 border-r border-base-300 px-2 py-1 align-middle last:border-r-0 ${tone}`}
      aria-label={`${group.roomName}, ${formatFullDate(date)}: ${primary}; ${movements.arrivals} arrivals; ${movements.departures} departures${!availabilityCurrent ? "; availability unconfirmed" : ""}`}
    >
      <span className="flex items-center gap-1.5 text-[0.7rem] font-semibold"><Icon size={13} className="shrink-0" />{primary}</span>
      <MovementSummary counts={movements} compact />
    </td>
  );
});

const ScheduleResourceRow = memo(function ScheduleResourceRow({
  resource,
  days,
  from,
  to,
  selectedDay,
  todayKey,
  propertyId,
  dateKey,
  reservations,
  completed,
  blocks,
  dayStates,
  selected,
  onOpenReservation,
  onOpenBlock,
  onBook,
  bookingEnabled,
  availabilityCurrent,
  coverage,
}: {
  resource: CalendarResource;
  days: Date[];
  from: string;
  to: string;
  selectedDay: string;
  todayKey: string;
  propertyId: string;
  dateKey: string;
  reservations: ReservationListItem[];
  completed: ReservationListItem[];
  blocks: ManualBlock[];
  dayStates: Map<string, CalendarUnitDayState>;
  selected: QuickLookKey | null;
  onBook?: CalendarBookAction;
  bookingEnabled: boolean;
  availabilityCurrent: boolean;
  coverage?: CalendarCoverage[];
  onOpenReservation: (
    reservation: ReservationListItem,
    resource: CalendarResource,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
  onOpenBlock: (
    block: ManualBlock,
    resource: CalendarResource,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
}) {
  const timeline = useMemo(() => {
    const sources: CalendarTimelineSource[] = [
    ...reservations.map((reservation) => ({
      key: `reservation:${reservation.reservationId}`,
      kind: "reservation" as const,
      arrival: reservation.arrival,
      departure: reservation.departure,
      reservation,
    })),
    ...blocks.map((block) => ({
      key: `block:${block.blockId}`,
      kind: "block" as const,
      arrival: block.arrival,
      departure: block.departure,
      block,
    })),
  ];
    return layoutCalendarIntervals(sources, from, to);
  }, [reservations, blocks, from, to]);
  const narrowDisclosures = useMemo(() => timeline.intervals
    .map((interval) => calendarNarrowIntervalDisclosure({
      key: interval.key,
      label: interval.kind === "block"
        ? interval.block.reason
        : interval.reservation.primaryGuestName,
      arrival: interval.arrival,
      departure: interval.departure,
      columnSpan: interval.columnSpan,
      startsBeforeWindow: interval.startsBeforeWindow,
      endsAfterWindow: interval.endsAfterWindow,
    }))
    .filter((item): item is NonNullable<typeof item> => item !== null), [timeline]);

  return (
    <tr className="border-b border-base-300 last:border-b-0">
      <th id={`calendar-unit-${resource.inventoryUnitId}`} scope="row" data-calendar-row-label={resource.inventoryUnitId} className="sticky left-0 z-[25] border-r border-base-300 bg-base-100 px-3 py-2 text-left [contain:paint]">
        <span className="flex min-w-0 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-base-200 text-primary">
            {resource.isPrivateRoom ? <DoorOpen size={15} /> : <BedDouble size={15} />}
          </span>
          <span className="min-w-0">
            <strong className="block truncate text-sm leading-4">{resource.label}</strong>
            <span className="block truncate text-[0.68rem] font-normal leading-3 text-base-content/45">{resource.detail}</span>
            {narrowDisclosures.map((disclosure) => (
              <span
                key={disclosure.key}
                className="mt-1 flex items-start gap-1 text-[0.64rem] font-semibold leading-3.5 text-base-content/65"
                data-calendar-edge-disclosure
              >
                {disclosure.direction === "before"
                  ? <ChevronLeft size={11} className="mt-px shrink-0" aria-hidden="true" />
                  : disclosure.direction === "after"
                    ? <ChevronRight size={11} className="mt-px shrink-0" aria-hidden="true" />
                    : <CalendarDays size={11} className="mt-px shrink-0" aria-hidden="true" />}
                <span className="whitespace-normal break-words">{disclosure.label} · {disclosure.range}</span>
              </span>
            ))}
            {completed.filter(reservation => reservation.arrival < to && reservation.departure > from).map(reservation => (
              <span key={`history:${reservation.reservationId}`} data-calendar-history-disclosure className="mt-1 block text-[13px] leading-4 text-base-content/70">
                <span className="block whitespace-normal break-words font-medium">{reservation.primaryGuestName}</span>
                <span className="block font-normal">Completed · scheduled</span>
              </span>
            ))}
          </span>
        </span>
      </th>
      <td
        colSpan={days.length}
        headers={`calendar-unit-${resource.inventoryUnitId} ${days.map((date) => `calendar-day-${toDateKey(date)}`).join(" ")}`}
        className="border-r-0 p-0 align-middle"
        aria-label={`${resource.roomName}, ${resource.label}, ${days.length}-day schedule`}
      >
        {timeline.sourceIssues.length > 0 && (
          <div className="flex min-h-8 items-center gap-2 border-b border-error/25 bg-error/8 px-2 text-xs font-semibold text-error" role="status">
            <CircleAlert size={14} />{timeline.sourceIssues.length} invalid schedule {timeline.sourceIssues.length === 1 ? "item needs" : "items need"} review
          </div>
        )}
        <CalendarTimelineGrid
          days={days}
          laneCount={timeline.laneCount}
          selectedDay={selectedDay}
          todayKey={todayKey}
          coverage={coverage}
        >
          {onBook && timeline.sourceIssues.length === 0 && <CalendarBookControls
            days={days} resource={resource} dayStates={dayStates} todayKey={todayKey} coverage={coverage}
            availabilityCurrent={availabilityCurrent} bookingEnabled={bookingEnabled} onBook={onBook}
          />}
          {timeline.intervals.map((interval) => (
            <ScheduleIntervalButton
              key={interval.key}
              interval={interval}
              resource={resource}
              from={from}
              to={to}
              selectedDay={selectedDay}
              propertyId={propertyId}
              dateKey={dateKey}
              selected={selected}
              onOpenReservation={onOpenReservation}
              onOpenBlock={onOpenBlock}
            />
          ))}
          {timeline.departureMarkers.map((marker) => (
            <ScheduleDepartureMarker
              key={`departure:${marker.key}`}
              marker={marker}
              resource={resource}
              propertyId={propertyId}
              dateKey={dateKey}
              day={from}
              selected={selected}
              onOpenReservation={onOpenReservation}
            />
          ))}
        </CalendarTimelineGrid>
        <CalendarCompletedTrack reservations={completed} resource={resource} days={days} from={from} to={to}
          selectedDay={selectedDay} propertyId={propertyId} dateKey={dateKey} selected={selected} onOpen={onOpenReservation} />
      </td>
    </tr>
  );
});

function CalendarCompletedButton({ reservation, resource, day, propertyId, dateKey, selected, layout, onClick }: {
  reservation: ReservationListItem; resource?: CalendarResource; day: string; propertyId: string; dateKey: string;
  selected: QuickLookKey | null; layout?: CalendarIntervalLayout; onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const expanded = selected?.kind === "reservation" && selected.id === reservation.reservationId
    && selected.resourceId === resource?.inventoryUnitId;
  const label = `${reservation.primaryGuestName}, Completed booking, scheduled dates ${formatCalendarDateRange(reservation.arrival, reservation.departure)}${resource ? `, ${resource.roomName}, ${resource.label}` : ", former or unavailable space; assignment needs review"}; not current occupancy${layout?.startsBeforeWindow ? "; starts before displayed dates" : ""}${layout?.endsAfterWindow ? "; ends after displayed dates" : ""}`;
  return <button type="button" data-calendar-completed-history={reservation.reservationId}
    className={`relative min-h-[44px] min-w-0 rounded-md border border-base-300 bg-base-200 px-2 py-1 text-left text-[13px] leading-4 text-base-content/80 hover:bg-base-300/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${layout?.startsBeforeWindow ? "rounded-l-none border-l-2 border-l-dashed" : ""} ${layout?.endsAfterWindow ? "rounded-r-none border-r-2 border-r-dashed" : ""} ${expanded ? "ring-2 ring-primary/55" : ""}`}
    style={layout ? { gridColumn: `${layout.startColumn + 1} / span ${layout.columnSpan}`, gridRow: layout.lane + 1 } : undefined}
    aria-label={label} title={label} aria-expanded={expanded} aria-controls="operational-preview"
    data-operational-preview-trigger={calendarTriggerKey("reservation", reservation.reservationId, day, resource?.inventoryUnitId, propertyId, dateKey)}
    onClick={onClick}>
    <span className={layout ? "block overflow-clip" : "block"}>
    <span data-calendar-history-label className={layout ? "sticky block w-0" : "block"}
      style={layout ? calendarVisibleLabelStyle : undefined}>
    <span className={layout ? "block w-max max-w-96" : "block"}>
    <span className="flex min-w-0 items-center gap-1">
      {layout?.startsBeforeWindow && <ChevronLeft size={12} className="shrink-0" aria-hidden="true" />}
      <strong className={layout ? "min-w-0 flex-1 truncate font-medium" : "min-w-0 flex-1 break-words font-medium"}>{reservation.primaryGuestName}</strong>
      {layout?.endsAfterWindow && <ChevronRight size={12} className="shrink-0" aria-hidden="true" />}
    </span>
    <span className={layout ? "block truncate" : "block break-words"}>Completed · scheduled {formatCalendarDateRange(reservation.arrival, reservation.departure)}</span>
    </span>
    </span>
    </span>
  </button>;
}

function CalendarCompletedTrack({ reservations, resource, days, from, to, selectedDay, propertyId, dateKey, selected, onOpen }: {
  reservations: ReservationListItem[]; resource: CalendarResource; days: Date[]; from: string; to: string;
  selectedDay: string; propertyId: string; dateKey: string; selected: QuickLookKey | null;
  onOpen: (reservation: ReservationListItem, resource: CalendarResource, day: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const history = useMemo(() => layoutCalendarIntervals(reservations.map(reservation => ({ key: reservation.reservationId,
    kind: "history" as const, arrival: reservation.arrival, departure: reservation.departure, reservation })), from, to), [reservations, from, to]);
  if (!history.intervals.length && !history.sourceIssues.length) return null;
  return <div data-calendar-history-track aria-label={`${resource.label} completed bookings; scheduled dates, not current occupancy`} className="border-t border-base-300 bg-base-200/35">
    {history.sourceIssues.length > 0 && <p role="status" className="px-2 py-1 text-[13px]">Completed booking dates need review.</p>}
    <div className="grid gap-y-1 px-0.5 py-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${history.laneCount}, minmax(44px, auto))` }}>
      {history.intervals.map(interval => {
        const day = intervalInteractionDay(interval, from, to, selectedDay);
        return <CalendarCompletedButton key={interval.key} reservation={interval.reservation} resource={resource} day={day}
          propertyId={propertyId} dateKey={dateKey} selected={selected} layout={interval}
          onClick={event => onOpen(interval.reservation, resource, day, event)} />;
      })}
    </div>
  </div>;
}

function CalendarCompletedFallback({ reservations, rooms, from, to, selectedDay, propertyId, dateKey, selected, onOpen }: {
  reservations: ReservationListItem[]; rooms: RoomInventory[]; from: string; to: string; selectedDay: string;
  propertyId: string; dateKey: string; selected: QuickLookKey | null;
  onOpen: (reservation: ReservationListItem, resource: CalendarResource | undefined, day: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  if (!reservations.length) return null;
  const labels = new Map<string, string>(rooms.flatMap(room => room.units.map(unit => {
    const context = inventoryContextFromRooms([room], unit.inventoryUnitId)!;
    return [unit.inventoryUnitId, `${context.roomName} · ${context.unitLabel}`] as const;
  })));
  return <section aria-label="Former or unavailable spaces — completed bookings" className="border-t border-base-300 bg-base-200/35 p-4">
    <h3 className="text-[14px] font-semibold">Former or unavailable spaces</h3>
    <p className="mt-1 text-[13px] leading-5 text-base-content/70">Completed bookings · scheduled dates. Some recorded spaces are not in the current sellable layout; this history does not hold inventory.</p>
    <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">{reservations.map(reservation => {
      const names = reservation.inventoryUnitIds.map(id => labels.get(id)).filter((label): label is string => Boolean(label));
      const unknown = reservation.inventoryUnitIds.length - names.length;
      const day = intervalInteractionDay(reservation, from, to, selectedDay);
      return <div key={reservation.reservationId} className="min-w-0">
        <p className="mb-1 break-words text-[13px] text-base-content/70">{names.length ? names.join("; ") : "Recorded space label unavailable"}{unknown && names.length ? `; ${unknown} other ${unknown === 1 ? "label" : "labels"} unavailable` : ""}</p>
        <div className="grid"><CalendarCompletedButton reservation={reservation} day={day} propertyId={propertyId} dateKey={dateKey} selected={selected}
          onClick={event => onOpen(reservation, undefined, day, event)} /></div>
      </div>;
    })}</div>
  </section>;
}

function CalendarBookControls({ days, resource, dayStates, todayKey, coverage, availabilityCurrent, bookingEnabled, onBook }: {
  days: Date[]; resource: CalendarResource; dayStates: Map<string, CalendarUnitDayState>; todayKey: string;
  coverage?: CalendarCoverage[]; availabilityCurrent: boolean; bookingEnabled: boolean; onBook: CalendarBookAction;
}) {
  const window = useContext(CalendarPresentationContext);
  const returnTarget = useContext(CalendarBookReturnContext);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const focusOwner = useRef<{ node: HTMLButtonElement; timeline: HTMLElement | null } | null>(null);
  const [openerKey, setOpenerKey] = useState<string | null>(null);
  const [dismissedReturnKey, setDismissedReturnKey] = useState<string | null>(null);
  useEffect(() => { if (!returnTarget.frozen) setOpenerKey(null); }, [returnTarget.frozen, openerKey]);
  const available = useMemo(() => days.flatMap((date, index) => {
    const day = toDateKey(date);
    const current = coverage ? calendarDayCoverage(coverage, day)?.current === true : availabilityCurrent;
    return day >= todayKey && current && dayStates.get(day)?.availability === "free"
      ? [{ date, day, index, key: calendarBookingTriggerKey(resource.inventoryUnitId, day) }] : [];
  }), [days, resource.inventoryUnitId, dayStates, todayKey, coverage, availabilityCurrent]);
  useLayoutEffect(() => {
    const owner = focusOwner.current;
    if (!owner || !focusedKey || available.some(item => item.key === focusedKey)) return;
    focusOwner.current = null;
    setFocusedKey(null);
    if (returnTarget.key === focusedKey) setDismissedReturnKey(focusedKey);
    // Data can remove an exact focused action. Only repair lost focus in this
    // still-mounted owner; external focus and authority/page unmount win.
    if (!owner.node.isConnected && owner.timeline?.isConnected && document.activeElement === document.body) {
      owner.timeline.focus({ preventScroll: true });
    }
  }, [available, focusedKey, returnTarget.key]);
  return <>{available.map(({ date, day, index, key }) => {
    const pinned = focusedKey === key || openerKey === key
      || (returnTarget.key === key && dismissedReturnKey !== key);
    if (window && !pinned && !calendarDateHasRichPresentation(window, day)) return null;
    return <button
      key={`book:${day}`} type="button" data-calendar-booking-trigger={key}
      aria-disabled={!bookingEnabled}
      aria-label={`Book ${resource.roomName}, ${resource.label}, arriving ${formatFullDate(date)}${bookingEnabled ? "" : ". Availability unconfirmed"}`}
      title={bookingEnabled ? `Book ${resource.label} from ${day}` : "Availability unconfirmed"}
      className="z-[1] mx-1 flex min-h-8 items-center justify-center rounded text-primary/55 hover:bg-primary/10 hover:text-primary aria-disabled:opacity-35 focus-visible:bg-primary/10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
      style={{ gridColumn: index + 1, gridRow: 1 }}
      onFocus={(event) => { focusOwner.current = { node: event.currentTarget, timeline: event.currentTarget.closest<HTMLElement>(".calendar-timeline") }; setFocusedKey(key); }}
      onBlur={() => { focusOwner.current = null; setFocusedKey(null); if (returnTarget.key === key) setDismissedReturnKey(key); }}
      onClick={() => { if (bookingEnabled) { setDismissedReturnKey(null); setOpenerKey(key); onBook(resource, day); } }}
    ><Plus size={15} aria-hidden="true" /><span className="sr-only">Book</span></button>;
  })}</>;
}

export function calendarNarrowIntervalDisclosure({
  key,
  label,
  arrival,
  departure,
  columnSpan,
  startsBeforeWindow,
  endsAfterWindow,
}: {
  key: string;
  label: string;
  arrival: string;
  departure: string;
  columnSpan: number;
  startsBeforeWindow: boolean;
  endsAfterWindow: boolean;
}) {
  if (columnSpan !== 1) return null;
  return {
    key,
    label,
    range: formatCalendarDateRange(arrival, departure),
    direction: startsBeforeWindow
      ? "before" as const
      : endsAfterWindow
        ? "after" as const
        : "within" as const,
  };
}

export function CalendarTimelineGrid({
  days,
  laneCount,
  selectedDay,
  todayKey,
  children,
  coverage,
}: {
  days: Date[];
  laneCount: number;
  selectedDay: string;
  todayKey: string;
  children: ReactNode;
  coverage?: CalendarCoverage[];
}) {
  return (
    <div
      className="relative grid gap-y-1 py-1"
      style={{ gridTemplateRows: `repeat(${laneCount}, 2rem)`, gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
    >
      <CalendarTimelineBackground days={days} laneCount={laneCount} selectedDay={selectedDay} todayKey={todayKey} coverage={coverage} />
      {children}
    </div>
  );
}

const CalendarTimelineBackground = memo(function CalendarTimelineBackground({ days, laneCount, selectedDay, todayKey, coverage }: {
  days: Date[]; laneCount: number; selectedDay: string; todayKey: string; coverage?: CalendarCoverage[];
}) {
  return <>
      {days.map((date, index) => {
        const day = toDateKey(date);
        const weekend = date.getDay() === 0 || date.getDay() === 6;
        const selected = day === selectedDay;
        const today = day === todayKey;
        const source = coverage ? calendarDayCoverage(coverage, day) : undefined;
        const unknown = Boolean(coverage && !source?.current);
        return (
          <span
            key={day}
            aria-hidden={unknown ? undefined : true}
            aria-label={unknown ? `${day}: ${source?.label ?? "Schedule not loaded"}` : undefined}
            data-calendar-day-current={unknown ? "false" : "true"}
            className={`z-0 border-r border-base-300 last:border-r-0 ${unknown ? "bg-warning/12 text-warning-content" : selected ? "bg-primary/7" : today ? "bg-secondary/7" : weekend ? "bg-base-200/35" : "bg-base-100"}`}
            style={{ gridColumn: index + 1, gridRow: `1 / span ${laneCount}` }}
          >{unknown && <span className="block px-1 text-center text-[0.65rem] leading-8">Unconfirmed</span>}</span>
        );
      })}
    </>;
});

function ScheduleIntervalButton({
  interval,
  resource,
  from,
  to,
  selectedDay,
  propertyId,
  dateKey,
  selected,
  onOpenReservation,
  onOpenBlock,
}: {
  interval: CalendarIntervalLayout<CalendarTimelineSource>;
  resource: CalendarResource;
  from: string;
  to: string;
  selectedDay: string;
  propertyId: string;
  dateKey: string;
  selected: QuickLookKey | null;
  onOpenReservation: (
    reservation: ReservationListItem,
    resource: CalendarResource,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
  onOpenBlock: (
    block: ManualBlock,
    resource: CalendarResource,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
}) {
  const day = intervalInteractionDay(interval, from, to, selectedDay);
  const selectedInterval = interval.kind === "block"
    ? selected?.kind === "block"
      && selected.id === interval.block.blockId
      && selected.resourceId === resource.inventoryUnitId
    : selected?.kind === "reservation"
      && selected.id === interval.reservation.reservationId
      && selected.resourceId === resource.inventoryUnitId;
  const triggerKey = interval.kind === "block"
    ? calendarTriggerKey("inventoryBlock", interval.block.blockId, day, resource.inventoryUnitId, propertyId, dateKey)
    : calendarTriggerKey("reservation", interval.reservation.reservationId, day, resource.inventoryUnitId, propertyId, dateKey);

  const reservation = interval.kind === "block" ? null : interval.reservation;
  const status = reservation ? reservationStatusKey(reservation.status) : "";
  const attentionByReservation = useContext(CalendarAttentionContext);
  const reasons = reservation ? attentionByReservation.get(reservation.reservationId) ?? [] : [];
  const attention = reasons.length > 0;
  const pendingState = reservation ? reservationPendingAttention(reservation.status) : undefined;
  const inHouse = reservation ? ["checkedIn", "checkoutPending"].includes(status) : false;
  const tone = interval.conflict
    ? "border-error/55 bg-[color-mix(in_oklab,var(--color-base-100)_86%,var(--color-error)_14%)] text-base-content"
    : interval.kind === "block"
      ? "border-warning/45 bg-[color-mix(in_oklab,var(--color-base-100)_84%,var(--color-warning)_16%)] text-warning-content"
      : attention || pendingState
        ? "border-warning/45 bg-[color-mix(in_oklab,var(--color-base-100)_80%,var(--color-warning)_20%)] text-warning-content"
        : inHouse
          ? "border-secondary/35 bg-[color-mix(in_oklab,var(--color-base-100)_85%,var(--color-secondary)_15%)] text-base-content"
          : "border-success/35 bg-[color-mix(in_oklab,var(--color-base-100)_87%,var(--color-success)_13%)] text-base-content";
  const label = interval.kind === "block" ? interval.block.reason : interval.reservation.primaryGuestName;
  const operation = interval.kind === "block"
    ? "Inventory block"
    : attention
      ? reasons[0].label
      : pendingState
        ? pendingState.label
      : inHouse
        ? "In house"
        : "Reserved";
  const statusLabel = interval.kind === "block"
    ? "Blocked"
    : reservationStatusLabel(interval.reservation.status);
  const endpointSummary = [
    interval.startsBeforeWindow
      ? "continues from the previous week"
      : interval.showsArrival
        ? interval.kind === "block" ? "block start visible" : "scheduled check-in visible"
        : "",
    interval.endsAfterWindow
      ? "continues into the next week"
      : interval.showsDeparture
        ? interval.kind === "block" ? "block end visible" : "scheduled checkout visible"
        : "",
  ].filter(Boolean).join(", ");

  return (
    <button
      type="button"
      className={`relative z-10 mx-0.5 flex h-8 min-w-0 items-center gap-1.5 border px-2 text-left text-[0.8125rem] font-semibold shadow-xs transition hover:brightness-95 focus-visible:z-20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${interval.kind === "block" ? "border-dashed" : ""} ${interval.startsBeforeWindow ? "rounded-l-none border-l-2 border-l-dashed" : "rounded-l-md"} ${interval.endsAfterWindow ? "rounded-r-none border-r-2 border-r-dashed" : "rounded-r-md"} ${selectedInterval ? "ring-2 ring-primary/55" : ""} ${tone}`}
      style={{
        gridColumn: `${interval.startColumn + 1} / span ${interval.columnSpan}`,
        gridRow: interval.lane + 1,
      }}
      aria-label={`${label}, ${operation}, ${statusLabel}, ${interval.arrival} to ${interval.departure}${endpointSummary ? `, ${endpointSummary}` : ""}${interval.conflict ? `, conflict with ${interval.conflictWith.length} other schedule item${interval.conflictWith.length === 1 ? "" : "s"}` : ""}${reasons.length ? `, ${reasons.map(reason => reason.label).join(", ")}` : ""}`}
      aria-expanded={selectedInterval}
      aria-controls="operational-preview"
      data-operational-preview-trigger={triggerKey}
      title={`${label} · ${operation} · ${interval.arrival} to ${interval.departure}${interval.conflict ? " · Conflict" : ""}${reasons.length ? ` · ${reasons.map(reason => reason.label).join(" · ")}` : ""}`}
      onClick={(event) => interval.kind === "block"
        ? onOpenBlock(interval.block, resource, day, event)
        : onOpenReservation(interval.reservation, resource, day, event)}
    >
      <CalendarIntervalContent
        kind={interval.kind === "block" ? "block" : "reservation"}
        label={label}
        operation={operation}
        conflict={interval.conflict}
        columnSpan={interval.columnSpan}
        startsBeforeWindow={interval.startsBeforeWindow}
        endsAfterWindow={interval.endsAfterWindow}
        showsArrival={interval.showsArrival}
        showsDeparture={interval.showsDeparture}
        attention={reasons}
      />
    </button>
  );
}

export function CalendarCoverageStatus({ coverage, viewportFrozen, selectedDate, onShowSelectedDay }: {
  coverage: CalendarCoverage[];
  viewportFrozen: boolean;
  selectedDate: Date;
  onShowSelectedDay: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const current = coverage.filter((segment) => segment.current).length;
  const summary = viewportFrozen ? "Date loading paused"
    : current === coverage.length && current > 0 ? "Dates loaded"
      : current > 0 ? "Some dates unconfirmed" : "Dates unconfirmed";
  return (
    <div className="flex h-14 items-center justify-between gap-2 border-b border-base-300 px-4" data-calendar-coverage-status data-calendar-segment-count={coverage.length}>
      <p className="min-w-0 text-sm font-medium leading-4" role="status" aria-atomic="true">{summary}</p>
      <button type="button" className="btn btn-ghost btn-sm min-h-11 shrink-0" aria-haspopup="dialog" onClick={() => setDetailsOpen(true)}>Details<ChevronRight size={15} aria-hidden="true" /></button>
      <Modal open={detailsOpen} title="Calendar date status" description="Only current dates can be used to start a booking. Known stays and holds remain visible while other dates are unconfirmed." onClose={() => setDetailsOpen(false)}>
        <CalendarCoverageDetails coverage={coverage} viewportFrozen={viewportFrozen} selectedDate={selectedDate} onShowSelectedDay={() => { setDetailsOpen(false); onShowSelectedDay(); }} />
      </Modal>
    </div>
  );
}

export function CalendarCoverageDetails({ coverage, viewportFrozen, selectedDate, onShowSelectedDay }: {
  coverage: CalendarCoverage[];
  viewportFrozen: boolean;
  selectedDate: Date;
  onShowSelectedDay: () => void;
}) {
  return (
    <div className="space-y-4 text-sm">
      {viewportFrozen && <p role="status">Date loading is paused while this action owns its Calendar context.</p>}
      {!calendarDayCoverage(coverage, toDateKey(selectedDate)) && <div>
        <p>Selected day {formatFullDate(selectedDate)} is outside the loaded dates.</p>
        <button type="button" className="btn btn-ghost btn-sm mt-2 min-h-11" disabled={viewportFrozen} onClick={onShowSelectedDay}>Show selected day</button>
      </div>}
      {coverage.map((segment) => {
        const end = parseDateKey(segment.to)!;
        end.setDate(end.getDate() - 1);
        const range = formatCalendarDateRange(segment.from, toDateKey(end));
        return <section key={segment.from} data-calendar-segment={segment.from} data-calendar-segment-current={segment.current} className={`rounded-lg border p-3 ${segment.current ? "border-base-300" : "border-warning/40 bg-warning/10"}`} aria-label={range}>
          <h3 className="font-semibold">{range}</h3>
          <p className="mt-1" role="status">{segment.current ? "Dates loaded" : segment.label}</p>
          <ul className="mt-2 space-y-1 text-base-content/65">
            <li>Reservations: {segment.reservationsCurrent ? "current" : "unconfirmed"}</li>
            <li>Manual holds: {segment.blocksCurrent ? "current" : "unconfirmed"}</li>
          </ul>
          <button type="button" className="btn btn-ghost btn-sm mt-2 min-h-11" aria-label={`${segment.current ? "Refresh" : "Retry"} ${range}`} onClick={segment.retry}>{segment.current ? "Refresh dates" : "Retry dates"}</button>
        </section>;
      })}
    </div>
  );
}

function revealCalendarTimelineAction(action: HTMLElement, viewport: HTMLDivElement) {
  const heading = viewport.querySelector("#calendar-resource-heading");
  if (!heading) return;
  const frame = viewport.getBoundingClientRect();
  const pinned = heading.getBoundingClientRect();
  const delta = calendarTimelineFocusAdjustment(action.getBoundingClientRect(), {
    left: pinned.right + 2,
    right: frame.left + viewport.clientLeft + viewport.clientWidth - 2,
    top: pinned.bottom + 2,
    bottom: frame.top + viewport.clientTop + viewport.clientHeight - 2,
  });
  if (delta.left || delta.top) viewport.scrollBy({ ...delta, behavior: "instant" });
}

// Browser focus scrolling considers a target behind a sticky heading visible.
// Reveal only the focused action, without changing focus, selection or dates.
export function calendarTimelineFocusAdjustment(
  action: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  visible: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
): { left: number; top: number } {
  const offset = (start: number, end: number, min: number, max: number) => {
    // A long interval already spanning the usable viewport cannot fit; moving
    // either edge into view would only displace the operator's comparison.
    if (start < min && end > max) return 0;
    if (end - start > max - min) return start < min ? end - max : start - min;
    if (start < min) return start - min;
    return end > max ? end - max : 0;
  };
  return {
    left: offset(action.left, action.right, visible.left, visible.right),
    top: offset(action.top, action.bottom, visible.top, visible.bottom),
  };
}

export function CalendarIntervalContent({
  kind,
  label,
  operation,
  conflict,
  columnSpan,
  startsBeforeWindow,
  endsAfterWindow,
  showsArrival,
  showsDeparture,
  attention = [],
}: {
  kind: "reservation" | "block" | "request";
  label: string;
  operation: string;
  conflict: boolean;
  columnSpan: number;
  startsBeforeWindow: boolean;
  endsAfterWindow: boolean;
  showsArrival: boolean;
  showsDeparture: boolean;
  attention?: readonly ReservationAttention[];
}) {
  const StartIcon = startsBeforeWindow
    ? ChevronLeft
    : kind === "block"
      ? Blocks
      : showsArrival
        ? LogIn
        : BedDouble;
  const startLabel = startsBeforeWindow
    ? "Before"
    : kind === "block"
      ? "Start"
      : showsArrival
        ? "In"
        : "Stay";
  const EndIcon = endsAfterWindow
    ? ChevronRight
    : kind === "block"
      ? Blocks
      : LogOut;
  const endLabel = endsAfterWindow
    ? "After"
    : kind === "block"
      ? "End"
      : "Out";
  const showEnd = endsAfterWindow || showsDeparture;

  return (
    <>
      <span
        className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded-sm bg-base-100/55 px-1 text-[0.58rem] font-bold uppercase tracking-wide"
        data-calendar-endpoint="start"
      >
        <StartIcon size={11} aria-hidden="true" />
        <span className={columnSpan === 1 && attention.length ? "sr-only" : undefined}>{startLabel}</span>
      </span>
      {conflict && <CircleAlert size={13} className="shrink-0" aria-hidden="true" />}
      {kind === "reservation" ? (
        // A zero-width anchor keeps the name's beginning at the readable edge.
        // Clip its text at the reserved controls, without a new scroll container
        // (overflow-hidden would prevent stickiness to the timeline viewport).
        <span className="min-w-0 flex-1 overflow-clip">
          <span data-calendar-visible-label className="sticky block w-0" style={calendarVisibleLabelStyle}>
            <span className="block w-max max-w-96 truncate">{label}</span>
          </span>
        </span>
      ) : <span className="min-w-0 flex-1 truncate">{label}</span>}
      {columnSpan >= 3 && (
        <span className="shrink-0 text-[0.6rem] font-bold uppercase tracking-wide opacity-70">
          {conflict ? "Conflict" : operation}
        </span>
      )}
      {showEnd && (
        <span
          className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded-sm bg-base-100/55 px-1 text-[0.58rem] font-bold uppercase tracking-wide"
          data-calendar-endpoint="end"
        >
          <EndIcon size={11} aria-hidden="true" />
          <span className={columnSpan === 1 && attention.length ? "sr-only" : undefined}>{endLabel}</span>
        </span>
      )}
      <ReservationAttentionIndicators reasons={attention} compact={columnSpan < 2} />
    </>
  );
}

export function CompactCalendarInterval({
  arrival,
  departure,
  from,
  to,
  kind,
}: {
  arrival: string;
  departure: string;
  from: string;
  to: string;
  kind: CalendarIntervalKind;
}) {
  const timeline = layoutCalendarIntervals([{
    key: "compact-interval",
    kind,
    arrival,
    departure,
  }], from, to);
  const interval = timeline.intervals[0];
  const departureOnly = timeline.departureMarkers[0];
  if (!interval && !departureOnly) return null;

  const startColumn = interval?.startColumn ?? departureOnly!.column;
  const columnSpan = interval?.columnSpan ?? 1;
  const StartIcon = departureOnly
    ? LogOut
    : interval!.startsBeforeWindow
      ? ChevronLeft
      : kind === "block"
        ? Blocks
        : LogIn;
  const EndIcon = interval?.endsAfterWindow
    ? ChevronRight
    : kind === "block"
      ? Blocks
      : LogOut;
  const showEnd = Boolean(interval && (interval.endsAfterWindow || interval.showsDeparture));
  const tone = departureOnly
    ? "border-primary/40 border-dashed bg-base-100 text-primary"
    : kind === "block"
      ? "border-warning/55 border-dashed bg-warning/18 text-warning-content"
      : kind === "request"
        ? "border-warning/50 border-dashed bg-warning/14 text-warning-content"
        : "border-success/40 bg-success/16 text-success";

  return (
    <span
      className="relative mt-2 grid h-5 grid-cols-7 gap-px overflow-hidden rounded-md border border-base-300 bg-base-300"
      data-calendar-compact-interval={kind}
      aria-hidden="true"
    >
      {Array.from({ length: 7 }, (_, index) => (
        <span key={index} className="bg-base-100" style={{ gridColumn: index + 1, gridRow: 1 }} />
      ))}
      <span
        className={`relative z-10 flex h-5 min-w-0 items-center justify-between gap-0.5 border px-1 ${tone}`}
        style={{ gridColumn: `${startColumn + 1} / span ${columnSpan}`, gridRow: 1 }}
      >
        <StartIcon size={10} className="shrink-0" />
        {columnSpan >= 2 && !departureOnly && (
          <span className="truncate text-[0.58rem] font-bold uppercase tracking-wide">{columnSpan} nights</span>
        )}
        {showEnd && <EndIcon size={10} className="shrink-0" />}
      </span>
    </span>
  );
}

function ScheduleDepartureMarker({
  marker,
  resource,
  propertyId,
  dateKey,
  day,
  selected,
  onOpenReservation,
}: {
  marker: CalendarIntervalTimeline<CalendarTimelineSource>["departureMarkers"][number];
  resource: CalendarResource;
  propertyId: string;
  dateKey: string;
  day: string;
  selected: QuickLookKey | null;
  onOpenReservation: (
    reservation: ReservationListItem,
    resource: CalendarResource,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
}) {
  const attentionByReservation = useContext(CalendarAttentionContext);
  if (marker.kind !== "reservation") return null;
  const reasons = attentionByReservation.get(marker.reservation.reservationId) ?? [];
  const isSelected = selected?.kind === "reservation"
    && selected.id === marker.reservation.reservationId
    && selected.resourceId === resource.inventoryUnitId;
  return (
    <button
      type="button"
      className={`relative z-10 mx-0.5 flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-primary/35 border-dashed bg-base-100 px-2 text-left text-[0.8125rem] font-semibold text-primary shadow-xs transition hover:bg-primary/8 focus-visible:z-20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${isSelected ? "ring-2 ring-primary/55" : ""}`}
      style={{ gridColumn: 1, gridRow: marker.lane + 1 }}
      aria-label={`${marker.reservation.primaryGuestName}, scheduled checkout on ${day}; no occupied night in this week${reasons.length ? `, ${reasons.map(reason => reason.label).join(", ")}` : ""}`}
      aria-expanded={isSelected}
      aria-controls="operational-preview"
      data-operational-preview-trigger={calendarTriggerKey("reservation", marker.reservation.reservationId, day, resource.inventoryUnitId, propertyId, dateKey)}
      title={`Scheduled checkout · ${marker.reservation.primaryGuestName} · ${day}`}
      onClick={(event) => onOpenReservation(marker.reservation, resource, day, event)}
    >
      <span className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded-sm bg-primary/8 px-1 text-[0.58rem] font-bold uppercase tracking-wide">
        <LogOut size={11} aria-hidden="true" />Out
      </span>
      <span className="truncate">{marker.reservation.primaryGuestName}</span>
      <ReservationAttentionIndicators reasons={reasons} compact />
    </button>
  );
}

function RequestedReservationRow({
  reservation,
  days,
  from,
  to,
  todayKey,
  resources,
  calendarSelectedDay,
  selected,
  propertyId,
  dateKey,
  onOpen,
}: {
  reservation: ReservationListItem;
  days: Date[];
  from: string;
  to: string;
  todayKey: string;
  resources: Map<string, CalendarResource>;
  calendarSelectedDay: string;
  selected: boolean;
  propertyId: string;
  dateKey: string;
  onOpen: (
    reservation: ReservationListItem,
    resource: CalendarResource | undefined,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
}) {
  const reasons = useContext(CalendarAttentionContext).get(reservation.reservationId) ?? [];
  const requestedResource = reservation.inventoryUnitIds
    .map((unitId) => resources.get(unitId))
    .find(Boolean);
  const timeline = layoutCalendarIntervals<ReservationTimelineSource>([{
    key: `request:${reservation.reservationId}`,
    kind: "request",
    arrival: reservation.arrival,
    departure: reservation.departure,
    reservation,
  }], from, to);
  return (
    <tr className="border-b border-warning/20 last:border-b-0">
      <th id={`calendar-request-${reservation.reservationId}`} scope="row" className="sticky left-0 z-[25] border-r border-warning/20 bg-[color-mix(in_oklab,var(--color-base-100)_95%,var(--color-warning)_5%)] px-3 py-2 text-left">
        <span className="block truncate text-sm font-semibold">{reservation.primaryGuestName}</span>
        <span className="mt-0.5 block truncate text-[0.68rem] font-normal text-base-content/55">{requestedUnitLabel(reservation, resources)}</span>
      </th>
      <td
        colSpan={days.length}
        headers={`calendar-request-${reservation.reservationId} ${days.map((date) => `calendar-day-${toDateKey(date)}`).join(" ")}`}
        className="border-r-0 p-0 align-middle"
      >
        {timeline.sourceIssues.length > 0 && (
          <div className="flex min-h-8 items-center gap-2 bg-error/8 px-2 text-xs font-semibold text-error" role="status"><CircleAlert size={14} />Invalid request dates need review</div>
        )}
        <CalendarTimelineGrid days={days} laneCount={timeline.laneCount} selectedDay={calendarSelectedDay} todayKey={todayKey}>
          {timeline.intervals.map((interval) => {
            const day = intervalInteractionDay(interval, from, to, calendarSelectedDay);
            return (
              <button
                key={interval.key}
                type="button"
                className={`relative z-10 mx-0.5 flex h-8 min-w-0 items-center gap-1.5 border border-warning/45 border-dashed bg-warning/12 px-2 text-left text-[0.8125rem] font-semibold text-warning-content shadow-xs transition hover:bg-warning/18 focus-visible:z-20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${interval.startsBeforeWindow ? "rounded-l-none border-l-2" : "rounded-l-md"} ${interval.endsAfterWindow ? "rounded-r-none border-r-2" : "rounded-r-md"} ${selected ? "ring-2 ring-primary/55" : ""}`}
                style={{ gridColumn: `${interval.startColumn + 1} / span ${interval.columnSpan}`, gridRow: interval.lane + 1 }}
                aria-label={`${reservation.primaryGuestName}, requested inventory not held, ${reservation.arrival} to ${reservation.departure}${reasons.length ? `, ${reasons.map(reason => reason.label).join(", ")}` : ""}`}
                aria-expanded={selected}
                aria-controls="operational-preview"
                data-operational-preview-trigger={calendarTriggerKey("reservation", reservation.reservationId, day, requestedResource?.inventoryUnitId, propertyId, dateKey)}
                onClick={(event) => onOpen(reservation, requestedResource, day, event)}
              >
                <CalendarIntervalContent
                  kind="request"
                  attention={reasons}
                  label="Requested"
                  operation="Not held"
                  conflict={false}
                  columnSpan={interval.columnSpan}
                  startsBeforeWindow={interval.startsBeforeWindow}
                  endsAfterWindow={interval.endsAfterWindow}
                  showsArrival={interval.showsArrival}
                  showsDeparture={interval.showsDeparture}
                />
              </button>
            );
          })}
          {timeline.departureMarkers.map((marker) => (
            <button
              key={`departure:${marker.key}`}
              type="button"
              className={`relative z-10 mx-0.5 flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-warning/45 border-dashed bg-base-100 px-2 text-left text-[0.8125rem] font-semibold text-warning-content ${selected ? "ring-2 ring-primary/55" : ""}`}
              style={{ gridColumn: 1, gridRow: marker.lane + 1 }}
              aria-label={`${reservation.primaryGuestName}, requested stay scheduled checkout on ${from}; inventory was not held${reasons.length ? `, ${reasons.map(reason => reason.label).join(", ")}` : ""}`}
              aria-expanded={selected}
              aria-controls="operational-preview"
              data-operational-preview-trigger={calendarTriggerKey("reservation", reservation.reservationId, from, requestedResource?.inventoryUnitId, propertyId, dateKey)}
              onClick={(event) => onOpen(reservation, requestedResource, from, event)}
            >
              <span className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded-sm bg-warning/10 px-1 text-[0.58rem] font-bold uppercase tracking-wide">
                <LogOut size={11} aria-hidden="true" />Out
              </span>
              <span className="truncate">Requested · not held</span>
              <ReservationAttentionIndicators reasons={reasons} compact />
            </button>
          ))}
        </CalendarTimelineGrid>
      </td>
    </tr>
  );
}

function MobileRoomGroup({
  group,
  day,
  from,
  to,
  expanded,
  unitStates,
  completedByUnit,
  propertyId,
  dateKey,
  availabilityCurrent,
  roomSpacesHref,
  selected,
  onOpenReservation,
  onOpenBlock,
  onToggle,
  onBook,
  bookingEnabled,
}: {
  group: CalendarResourceGroup;
  day: string;
  from: string;
  to: string;
  expanded: boolean;
  unitStates: Map<string, CalendarUnitDayState>;
  completedByUnit: Map<string, ReservationListItem[]>;
  propertyId: string;
  dateKey: string;
  availabilityCurrent: boolean;
  roomSpacesHref: string | null;
  selected: QuickLookKey | null;
  onBook?: CalendarBookAction;
  bookingEnabled: boolean;
  onOpenReservation: (
    reservation: ReservationListItem,
    resource: CalendarResource,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
  onOpenBlock: (
    block: ManualBlock,
    resource: CalendarResource,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
  onToggle: () => void;
}) {
  const roomStates = group.resources.map((resource) =>
    unitStates.get(resource.inventoryUnitId)?.availability ?? "free");
  const counts = {
    occupied: roomStates.filter((state) => state === "occupied" || state === "conflict").length,
    blocked: roomStates.filter((state) => state === "blocked" || state === "conflict").length,
    conflicts: roomStates.filter((state) => state === "conflict").length,
    free: roomStates.filter((state) => state === "free").length,
  };
  const roomReservations = group.resources.flatMap((resource) =>
    unitStates.get(resource.inventoryUnitId)?.reservations ?? []);
  const movements = calendarDayMovementCounts(roomReservations, day);
  const summary = !availabilityCurrent
    ? `${counts.occupied} occupied · gaps unconfirmed`
    : counts.conflicts > 0
      ? `${counts.conflicts} conflict · ${counts.free} free`
      : `${counts.free} free · ${counts.occupied} occupied${counts.blocked ? ` · ${counts.blocked} blocked` : ""}`;
  const contentId = `calendar-mobile-room-${group.roomId}`;

  return (
    <section aria-labelledby={`${contentId}-heading`}>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-md px-2 text-left transition hover:bg-base-200/55 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={onToggle}
        >
          {expanded
            ? <ChevronDown size={18} className="shrink-0 text-base-content/45" />
            : <ChevronRight size={18} className="shrink-0 text-base-content/45" />}
          <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${group.isPrivateRoom ? "bg-secondary/12 text-secondary" : "bg-primary/9 text-primary"}`}>
            {group.isPrivateRoom ? <DoorOpen size={18} /> : <BedDouble size={18} />}
          </span>
          <span className="min-w-0 flex-1">
            <strong id={`${contentId}-heading`} className="block truncate text-sm">{group.roomName}</strong>
            <span className="mt-0.5 block truncate text-xs text-base-content/50">{group.location}</span>
            <span className={`mt-1 block text-xs font-medium ${counts.conflicts > 0 ? "text-error" : "text-base-content/60"}`}>{summary}</span>
            {(movements.arrivals > 0 || movements.departures > 0) && <MovementSummary counts={movements} />}
          </span>
        </button>
        {roomSpacesHref && (
          <Link
            to={roomSpacesHref}
            className="btn btn-circle btn-ghost btn-sm min-h-11 min-w-11 shrink-0"
            aria-label={`Open ${group.roomName} in Spaces`}
          >
            <Settings2 size={17} />
          </Link>
        )}
      </div>
      {expanded && (
        <div id={contentId} className="border-t border-base-300 bg-base-200/22 pl-4">
          {group.resources.map((resource) => (
            <MobileUnitRow
              key={resource.inventoryUnitId}
              resource={resource}
              day={day}
              from={from}
              to={to}
              state={unitStates.get(resource.inventoryUnitId) ?? emptyUnitState()}
              completed={(completedByUnit.get(resource.inventoryUnitId) ?? []).filter(reservation => reservation.arrival <= day && reservation.departure >= day)}
              propertyId={propertyId}
              dateKey={dateKey}
              availabilityCurrent={availabilityCurrent}
              selected={selected}
              onOpenReservation={onOpenReservation}
              onOpenBlock={onOpenBlock}
              onBook={onBook}
              bookingEnabled={bookingEnabled}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MobileUnitRow({
  resource,
  day,
  from,
  to,
  state,
  completed,
  propertyId,
  dateKey,
  availabilityCurrent,
  selected,
  onOpenReservation,
  onOpenBlock,
  onBook,
  bookingEnabled,
}: {
  resource: CalendarResource;
  day: string;
  from: string;
  to: string;
  state: CalendarUnitDayState;
  completed: ReservationListItem[];
  propertyId: string;
  dateKey: string;
  availabilityCurrent: boolean;
  selected: QuickLookKey | null;
  onBook?: CalendarBookAction;
  bookingEnabled: boolean;
  onOpenReservation: (
    reservation: ReservationListItem,
    resource: CalendarResource,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
  onOpenBlock: (
    block: ManualBlock,
    resource: CalendarResource,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
}) {
  const attentionByReservation = useContext(CalendarAttentionContext);
  const stateLabel = unitAvailabilityLabel(state, availabilityCurrent);
  const StateIcon = unitAvailabilityIcon(state.availability, availabilityCurrent);

  return (
    <div className="border-b border-base-300 last:border-b-0">
      <div className="flex min-h-14 items-center gap-3 px-3 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-base-100 text-primary shadow-sm">
          {resource.isPrivateRoom ? <DoorOpen size={16} /> : <BedDouble size={16} />}
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-sm">{resource.label}</strong>
          <span className="mt-0.5 block text-xs text-base-content/45">{resource.detail}{!availabilityCurrent ? " · availability unconfirmed" : ""}</span>
        </span>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold ${unitAvailabilityBadgeTone(state.availability, availabilityCurrent)}`}>
          <StateIcon size={13} />{stateLabel}
        </span>
      </div>
      {onBook && state.availability === "free" && <button
        type="button"
        className="btn btn-ghost btn-sm mb-2 ml-3 min-h-11 text-primary"
        data-calendar-booking-trigger={calendarBookingTriggerKey(resource.inventoryUnitId, day)}
        aria-disabled={!bookingEnabled}
        aria-label={`Book ${resource.roomName}, ${resource.label}, arriving ${day}${bookingEnabled ? "" : ". Availability unconfirmed"}`}
        onClick={() => { if (bookingEnabled) onBook(resource, day); }}
      ><Plus size={15} />Book from {formatMonthDay(parseDateKey(day)!)}</button>}

      {(state.reservations.length > 0 || state.blocks.length > 0) && (
        <div className="border-t border-base-300/70 bg-base-100/75">
          {state.reservations.map((reservation) => {
            const reasons = attentionByReservation.get(reservation.reservationId) ?? [];
            const kind = reservationCalendarEventKind(reservation, day);
            const movement = reservationMovementLabel(reservation, day);
            const Icon = movement === "Departs" ? LogOut : movement?.startsWith("Arrives") ? LogIn : eventIcon(kind);
            return (
              <button
                type="button"
                key={reservation.reservationId}
                className={`flex min-h-11 w-full items-center gap-2.5 border-b border-base-300/60 px-3 py-2 text-left text-sm transition last:border-b-0 hover:bg-base-200/55 ${selected?.kind === "reservation" && selected.id === reservation.reservationId && selected.day === day ? "bg-primary/8 ring-2 ring-inset ring-primary/35" : ""}`}
                aria-label={`${reservation.primaryGuestName}, ${movement ?? eventTimeLabel(reservation, kind)}, ${reservationStatusLabel(reservation.status)}, scheduled ${reservation.arrival} to ${reservation.departure}, ${resource.roomName}, ${resource.label}${reasons.length ? `, ${reasons.map(reason => reason.label).join(", ")}` : ""}`}
                aria-expanded={selected?.kind === "reservation" && selected.id === reservation.reservationId && selected.day === day}
                aria-controls="operational-preview"
                data-operational-preview-trigger={calendarTriggerKey("reservation", reservation.reservationId, day, resource.inventoryUnitId)}
                onClick={(event) => onOpenReservation(reservation, resource, day, event)}
              >
                <span className={`grid size-7 shrink-0 place-items-center rounded-md ${eventIconTone(kind)}`}><Icon size={14} /></span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-xs">{reservation.primaryGuestName}</strong>
                  {reasons.length > 0 && <span className="mt-1 flex items-start gap-1.5 text-xs font-semibold text-warning-content"><ReservationAttentionIndicators reasons={reasons} /><span>{reasons.map(reason => reason.label).join(" · ")}</span></span>}
                  <span className="mt-0.5 block text-[0.7rem] leading-4 text-base-content/55">{movement ?? eventTimeLabel(reservation, kind)} · {reservationStatusLabel(reservation.status)}</span>
                  <span className="mt-0.5 block whitespace-normal break-words text-[0.7rem] leading-4 text-base-content/45">Scheduled · {formatCalendarDateRange(reservation.arrival, reservation.departure)}</span>
                  <CompactCalendarInterval
                    arrival={reservation.arrival}
                    departure={reservation.departure}
                    from={from}
                    to={to}
                    kind="reservation"
                  />
                </span>
                <ChevronRight size={15} className="shrink-0 text-base-content/35" />
              </button>
            );
          })}
          {state.blocks.map((block) => (
            <button
              type="button"
              key={block.blockId}
              className={`flex min-h-11 w-full items-center gap-2.5 border-b border-base-300/60 px-3 py-2 text-left text-sm transition last:border-b-0 hover:bg-base-200/55 ${selected?.kind === "block" && selected.id === block.blockId && selected.day === day ? "bg-primary/8 ring-2 ring-inset ring-primary/35" : ""}`}
              aria-label={`${block.reason}, inventory block, ${block.arrival} to ${block.departure}, ${resource.roomName}, ${resource.label}`}
              aria-expanded={selected?.kind === "block" && selected.id === block.blockId && selected.day === day}
              aria-controls="operational-preview"
              data-operational-preview-trigger={calendarTriggerKey("inventoryBlock", block.blockId, day, resource.inventoryUnitId)}
              onClick={(event) => onOpenBlock(block, resource, day, event)}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-error/9 text-error"><Blocks size={14} /></span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-xs">{block.reason}</strong>
                <span className="mt-0.5 block text-[0.7rem] leading-4 text-base-content/55">Inventory block</span>
                <span className="mt-0.5 block whitespace-normal break-words text-[0.7rem] leading-4 text-base-content/45">Blocked · {formatCalendarDateRange(block.arrival, block.departure)}</span>
                <CompactCalendarInterval
                  arrival={block.arrival}
                  departure={block.departure}
                  from={from}
                  to={to}
                  kind="block"
                />
              </span>
              <ChevronRight size={15} className="shrink-0 text-base-content/35" />
            </button>
          ))}
        </div>
      )}
      {completed.length > 0 && <div data-calendar-history-track className="grid gap-2 border-t border-base-300 bg-base-200/35 p-2">
        {completed.map(reservation => <CalendarCompletedButton key={reservation.reservationId} reservation={reservation} resource={resource}
          day={day} propertyId={propertyId} dateKey={dateKey} selected={selected} onClick={event => onOpenReservation(reservation, resource, day, event)} />)}
      </div>}
    </div>
  );
}

function ReservationReviewSection({
  id,
  icon,
  title,
  description,
  reservations,
  day,
  from,
  to,
  resources,
  onOpen,
  requested = false,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  reservations: ReservationListItem[];
  day: string;
  from: string;
  to: string;
  resources: Map<string, CalendarResource>;
  onOpen: (
    reservation: ReservationListItem,
    resource: CalendarResource | undefined,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
  requested?: boolean;
}) {
  return (
    <section className="border-b border-warning/35 bg-warning/8" aria-labelledby={id}>
      <div className="px-4 pb-1 pt-4 sm:px-5">
        <h3 id={id} className="flex items-center gap-2 text-sm font-semibold text-warning-content">{icon}{title}</h3>
        <p className="mt-1 text-xs leading-5 text-base-content/55">{description}</p>
      </div>
      <div className="divide-y divide-warning/20">
        {reservations.map((reservation) => (
          <MobileReservationRow
            key={reservation.reservationId}
            reservation={reservation}
            day={day}
            from={from}
            to={to}
            resources={resources}
            onOpen={onOpen}
            requested={requested}
          />
        ))}
      </div>
    </section>
  );
}

function MobileReservationRow({
  reservation,
  day,
  from,
  to,
  resources,
  onOpen,
  requested,
}: {
  reservation: ReservationListItem;
  day: string;
  from: string;
  to: string;
  resources: Map<string, CalendarResource>;
  onOpen: (
    reservation: ReservationListItem,
    resource: CalendarResource | undefined,
    day: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
  requested: boolean;
}) {
  const reasons = useContext(CalendarAttentionContext).get(reservation.reservationId) ?? [];
  const kind = reservationCalendarEventKind(reservation, day);
  const movement = reservationMovementLabel(reservation, day);
  const Icon = requested ? Hourglass : movement === "Departs" ? LogOut : movement?.startsWith("Arrives") ? LogIn : eventIcon(kind);
  const resource = reservation.inventoryUnitIds
    .map((unitId) => resources.get(unitId))
    .find(Boolean);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-base-200/55 sm:px-5"
      aria-label={`${reservation.primaryGuestName}, ${requested ? "requested inventory not held" : movement ?? eventTimeLabel(reservation, kind)}, ${reservationStatusLabel(reservation.status)}, ${reservation.arrival} to ${reservation.departure}, ${requested ? requestedUnitLabel(reservation, resources) : assignedUnitLabel(reservation, resources)}${reasons.length ? `, ${reasons.map(reason => reason.label).join(", ")}` : ""}`}
      aria-controls="operational-preview"
      data-operational-preview-trigger={calendarTriggerKey("reservation", reservation.reservationId, day, resource?.inventoryUnitId)}
      onClick={(event) => onOpen(reservation, resource, day, event)}
    >
      <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${requested ? "bg-warning/18 text-warning-content" : eventIconTone(kind)}`}><Icon size={17} /></span>
      <span className="hidden sm:contents"><InitialAvatar name={reservation.primaryGuestName} size="sm" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{reservation.primaryGuestName}</span>
        {reasons.length > 0 && <span className="mt-1 flex items-start gap-1.5 text-xs font-semibold text-warning-content"><ReservationAttentionIndicators reasons={reasons} /><span>{reasons.map(reason => reason.label).join(" · ")}</span></span>}
        <span className="mt-0.5 block text-xs leading-4 text-base-content/50">{requested ? "Requested — not held" : movement ?? eventTimeLabel(reservation, kind)} · {requested ? requestedUnitLabel(reservation, resources) : assignedUnitLabel(reservation, resources)} · {reservationStatusLabel(reservation.status)}</span>
        <span className="mt-0.5 block whitespace-normal break-words text-xs leading-4 text-base-content/45">{requested ? "Requested stay" : "Scheduled"} · {formatCalendarDateRange(reservation.arrival, reservation.departure)}</span>
        <CompactCalendarInterval
          arrival={reservation.arrival}
          departure={reservation.departure}
          from={from}
          to={to}
          kind={requested ? "request" : "reservation"}
        />
      </span>
      <span className="hidden sm:inline-flex"><StatusBadge status={reservationStatusLabel(reservation.status)} /></span>
      <ChevronRight size={16} className="shrink-0 text-base-content/35" />
    </button>
  );
}

export function MovementSummary({
  counts,
  compact = false,
}: {
  counts: { arrivals: number; departures: number; attention: number };
  compact?: boolean;
}) {
  if (!counts.arrivals && !counts.departures && !counts.attention) {
    return <span className="mt-0.5 block text-[0.62rem] text-base-content/40">No movements</span>;
  }
  const accessibleSummary = [
    counts.arrivals ? `${counts.arrivals} ${counts.arrivals === 1 ? "arrival" : "arrivals"}` : "",
    counts.departures ? `${counts.departures} ${counts.departures === 1 ? "departure" : "departures"}` : "",
    counts.attention ? `${counts.attention} ${counts.attention === 1 ? "item" : "items"} needing attention` : "",
  ].filter(Boolean).join(", ");
  return (
    <span
      className={`mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.62rem] ${compact ? "text-base-content/55" : "text-base-content/60"}`}
      aria-label={accessibleSummary}
      role="group"
    >
      {counts.arrivals > 0 && <span className="inline-flex items-center gap-0.5"><LogIn size={10} aria-hidden="true" />{counts.arrivals} in</span>}
      {counts.departures > 0 && <span className="inline-flex items-center gap-0.5"><LogOut size={10} aria-hidden="true" />{counts.departures} out</span>}
      {counts.attention > 0 && <span className="inline-flex items-center gap-0.5 text-warning-content"><CircleAlert size={10} aria-hidden="true" />{counts.attention} attention</span>}
    </span>
  );
}

function CalendarScheduleLegend({ availability }: { availability: "current" | "mixed" | "unconfirmed" }) {
  return (
    <div aria-label="Calendar legend" className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-base-300 bg-base-100 px-4 py-3 text-xs font-medium text-base-content/65 sm:px-6">
      <Legend icon={<LogIn size={14} />} label="Scheduled check-in" tone="text-success" />
      <Legend icon={<LogOut size={14} />} label="Scheduled checkout" tone="text-primary" />
      <Legend icon={<BedDouble size={14} />} label="Reserved" tone="text-success" />
      <Legend icon={<UserRound size={14} />} label="In house" tone="text-secondary" />
      <Legend icon={<Hourglass size={14} />} label="Requested — not held" tone="text-warning-content" />
      <Legend icon={<Blocks size={14} />} label="Blocked" tone="text-warning-content" />
      <Legend icon={<CircleAlert size={14} />} label="Conflict" tone="text-error" />
      <Legend icon={<span className="grid size-5 place-items-center rounded-full border border-warning/60"><CircleAlert size={13} /></span>} label="Needs attention" tone="text-warning-content" />
      <span data-calendar-legend-availability={availability} className={`inline-flex min-h-8 w-[21rem] max-w-full items-center gap-1.5 leading-4 ${availability === "current" ? "text-success" : "text-warning-content"}`}>
        {availability === "current" ? <CheckCircle2 size={14} className="shrink-0" /> : <CircleAlert size={14} className="shrink-0" />}
        <span>{availability === "current" ? "Blank gap is available" : availability === "mixed" ? "Blank gaps are available only on confirmed dates" : "Blank gaps are unconfirmed"}</span>
      </span>
    </div>
  );
}

export function unitAvailabilityLabel(
  state: CalendarUnitDayState,
  availabilityCurrent: boolean,
) {
  if (state.availability === "conflict") return "Conflict";
  if (state.availability === "blocked") return "Blocked";
  if (state.availability === "occupied") {
    return state.reservations.some((reservation) =>
      ["checkedIn", "checkoutPending"].includes(reservationStatusKey(reservation.status)))
      ? "In house"
      : "Reserved";
  }
  return availabilityCurrent ? "Free" : "Unconfirmed";
}

function unitAvailabilityIcon(
  availability: CalendarUnitDayState["availability"],
  availabilityCurrent: boolean,
) {
  if (availability === "conflict") return CircleAlert;
  if (availability === "blocked") return Blocks;
  if (availability === "occupied") return UserRound;
  return availabilityCurrent ? CheckCircle2 : CircleAlert;
}

function unitAvailabilityBadgeTone(
  availability: CalendarUnitDayState["availability"],
  availabilityCurrent: boolean,
) {
  if (availability === "conflict") return "border-error/25 bg-error/10 text-error";
  if (availability === "blocked") return "border-error/20 bg-error/8 text-error";
  if (availability === "occupied") return "border-secondary/20 bg-secondary/10 text-secondary";
  return availabilityCurrent
    ? "border-success/20 bg-success/9 text-success"
    : "border-warning/25 bg-warning/12 text-warning-content";
}

function DayCount({ icon, label, tone }: { icon: ReactNode; label: string; tone: string }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 ${tone}`}>{icon}{label}</span>;
}

function Legend({ icon, label, tone }: { icon: ReactNode; label: string; tone: string }) {
  return <span className={`inline-flex items-center gap-1.5 ${tone}`}>{icon}{label}</span>;
}

function assignedUnitLabel(
  reservation: ReservationListItem,
  resources: Map<string, CalendarResource>,
) {
  return unitListLabel(reservation.inventoryUnitIds, resources, "Inventory needs review");
}

function requestedUnitLabel(
  reservation: ReservationListItem,
  resources: Map<string, CalendarResource>,
) {
  return unitListLabel(reservation.inventoryUnitIds, resources, "Requested inventory needs review");
}

function unitListLabel(
  unitIds: string[],
  resources: Map<string, CalendarResource>,
  fallback: string,
) {
  const matched = unitIds.map((unitId) => resources.get(unitId)).filter(Boolean) as CalendarResource[];
  if (!matched.length) return fallback;
  const rooms = [...new Set(matched.map((resource) => resource.roomName))];
  if (rooms.length === 1) {
    const labels = matched.map((resource) => resource.label);
    return matched[0].isPrivateRoom ? rooms[0] : `${rooms[0]} · ${labels.join(", ")}`;
  }
  return `${rooms.length} rooms requested`;
}

function eventTimeLabel(reservation: ReservationListItem, kind: CalendarEventKind) {
  if (kind === "arrival") return reservation.expectedArrivalTime ? `Arrives ${formatTime(reservation.expectedArrivalTime)}` : "Arrival";
  if (kind === "departure") return reservation.expectedDepartureTime ? `Departs ${formatTime(reservation.expectedDepartureTime)}` : "Departure";
  return reservationStayPhaseLabel(reservation);
}

function eventIcon(kind: CalendarEventKind) {
  return kind === "arrival" ? LogIn : kind === "departure" ? LogOut : kind === "attention" ? CircleAlert : BedDouble;
}

function eventIconTone(kind: CalendarEventKind) {
  if (kind === "attention") return "bg-warning/20 text-warning-content";
  if (kind === "departure") return "bg-primary/10 text-primary";
  if (kind === "stay") return "bg-secondary/12 text-secondary";
  return "bg-success/10 text-success";
}

function emptyUnitState(): CalendarUnitDayState {
  return { availability: "free", reservations: [], blocks: [] };
}

function toggleSetValue(values: Set<string>, value: string) {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function calendarQuickLookKey(
  route: OperationalPreviewRoute | null,
  propertyId: string,
): QuickLookKey | null {
  if (!route
    || route.origin.surface !== "calendar"
    || route.selection.propertyId !== propertyId) return null;
  const day = route.selection.date ?? route.origin.day;
  if (route.selection.kind === "reservation") {
    return {
      kind: "reservation",
      id: route.selection.reservationId,
      day,
      resourceId: route.selection.inventoryUnitId,
    };
  }
  if (route.selection.kind === "inventoryBlock") {
    return {
      kind: "block",
      id: route.selection.blockId ?? route.selection.blockGroupId,
      day,
      resourceId: route.selection.inventoryUnitId ?? "",
    };
  }
  return null;
}

function calendarTriggerKey(
  kind: "reservation" | "inventoryBlock",
  entityId: string,
  day: string,
  inventoryUnitId?: string,
  propertyId = "calendar-trigger",
  dateKey = day,
) {
  const route: OperationalPreviewRoute = {
    selection: kind === "reservation"
      ? {
        kind,
        propertyId,
        reservationId: entityId,
        inventoryUnitId,
        date: day,
      }
      : {
        kind,
        propertyId,
        blockGroupId: entityId,
        blockId: entityId,
        inventoryUnitId,
        date: day,
      },
    origin: {
      surface: "calendar",
      propertyId,
      date: dateKey,
      day,
    },
  };
  return operationalPreviewTriggerKey(route);
}

function intervalInteractionDay(
  interval: Pick<CalendarIntervalLayout, "arrival" | "departure">,
  from: string,
  to: string,
  selectedDay: string,
) {
  if (selectedDay >= from
    && selectedDay < to
    && interval.arrival <= selectedDay
    && interval.departure >= selectedDay) return selectedDay;
  return interval.arrival < from ? from : interval.arrival;
}

function calendarInventoryContext(resource: CalendarResource) {
  return {
    inventoryUnitId: resource.inventoryUnitId,
    roomId: resource.roomId,
    bedId: resource.bedId,
    roomName: resource.roomName,
    unitLabel: resource.label,
    unitDetail: resource.detail,
  };
}

// Fixed browser-locale options are shared by every cell, not reconstructed for
// each accessible label on every pan/render. No formatted dates are cached.
const calendarFormatters = {
  time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }),
  range: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }),
  full: new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
  weekday: new Intl.DateTimeFormat(undefined, { weekday: "long" }),
  narrowWeekday: new Intl.DateTimeFormat(undefined, { weekday: "short" }),
  monthDay: new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }),
  shortMonthDay: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }),
};
let explicitRangeFormatter: { key: string; formatter: Intl.DateTimeFormat } | undefined;

function formatTime(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return calendarFormatters.time.format(new Date(1970, 0, 1, hours, minutes));
}

export function formatCalendarDateRange(
  arrival: string,
  departure: string,
  locale?: Intl.LocalesArgument,
) {
  return `${formatCalendarDateKey(arrival, locale)} – ${formatCalendarDateKey(departure, locale)}`;
}

function formatCalendarDateKey(value: string, locale?: Intl.LocalesArgument) {
  const date = parseDateKey(value);
  if (!date) return value;
  if (locale === undefined) return calendarFormatters.range.format(date);
  const locales = Intl.getCanonicalLocales((Array.isArray(locale) ? locale : [locale]).map(String));
  const key = JSON.stringify(locales);
  if (explicitRangeFormatter?.key !== key) explicitRangeFormatter = {
    key, formatter: new Intl.DateTimeFormat(locales, { month: "short", day: "numeric", year: "numeric" }),
  };
  return explicitRangeFormatter.formatter.format(date);
}

function formatFullDate(date: Date) {
  return calendarFormatters.full.format(date);
}

function formatWeekday(date: Date) {
  return calendarFormatters.weekday.format(date);
}

function formatNarrowWeekday(date: Date) {
  return calendarFormatters.narrowWeekday.format(date);
}

function formatMonthDay(date: Date) {
  return calendarFormatters.monthDay.format(date);
}

function formatShortMonthDay(date: Date) {
  return calendarFormatters.shortMonthDay.format(date);
}
