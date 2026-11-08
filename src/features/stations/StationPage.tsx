import { applicationUrl } from "../../app/deploymentBase";
import { ArrowLeft, Check, KeyRound, LockKeyhole, RefreshCw, UsersRound } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { PinFields } from "./PinFields";
import { StationDepartures } from "./StationDepartures";
import { StationCheckOutRecovery } from "./StationCheckOutRecovery";
import { StationTaskTabs, type StationTask } from "./StationTaskTabs";
import { stationApi, StationRequestError } from "./stationClient";
import { stationState, type StationArrival, type StationArrivals, type StationCurrent, type StationRoster } from "./stationTypes";
import { clearConfirmedCheckIn, hasStationLockBarrier, quarantineCheckIn, quarantineCheckOut, readQuarantinedCheckIn, readQuarantinedCheckOut, readStationAttempt, saveStationAttempt, STATION_LOCK_KEY, type StationAttempt } from "./stationRecovery";

const boundary = (view: StationCurrent) => {
  const session = view.runtime.session;
  return `${view.runtime.state}:${session?.browserSessionId}:${session?.generation}:${session?.actor?.actorSessionId}`;
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The station is unavailable. Try again.";
const day = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
const pageVisible = () => document.visibilityState === "visible";
const offlineNotice = "You’re offline. Guest details are hidden. Reconnect, then refresh the station.";
type StationJob = { view: StationCurrent; release: () => void };
export type BeginStationJob = () => Promise<StationJob | null>;

/** A separate application root: no primary SessionProvider, workspace queries or bearer token. */
export function StationPage({ setupGrantId }: { setupGrantId?: string }) {
  const [setup, setSetup] = useState(setupGrantId);
  const setupOperation = useRef<string | null>(null);
  const [view, setView] = useState<StationCurrent | null>(null);
  const viewRef = useRef<StationCurrent | null>(null);
  const epoch = useRef(0);
  const busy = useRef(false);
  const localLock = useRef(hasStationLockBarrier());
  const remoteHold = useRef(false);
  const readSequence = useRef(0);
  const activityTask = useRef<{ epoch: number; promise: Promise<void> } | null>(null);
  const activeJobs = useRef(new Set<symbol>());
  const pinInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const recoveryButton = useRef<HTMLButtonElement>(null);
  const focusIntent = useRef<"pin" | "search" | "recovery" | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const channel = useRef<BroadcastChannel | null>(null);
  const [roster, setRoster] = useState<StationRoster | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [staff, setStaff] = useState<{ id: string; name: string } | null>(null);
  const [arrivals, setArrivals] = useState<StationArrivals | null>(null);
  const [confirming, setConfirming] = useState<StationArrival | null>(null);
  const [jobBusy, setJobBusy] = useState(false);
  const [jobAttempt, setJobAttempt] = useState(() => readStationAttempt("check-in"));
  const [quarantined, setQuarantined] = useState(readQuarantinedCheckIn);
  const [task, setTask] = useState<StationTask>("check-in");
  const [checkOutAttempt, setCheckOutAttempt] = useState(() => readStationAttempt("check-out"));
  const [checkOutReview, setCheckOutReview] = useState(readQuarantinedCheckOut);
  const [checkOutFlights, setCheckOutFlights] = useState<ReadonlySet<string>>(() => new Set());
  const checkOutFlightChanged = useCallback((operationId: string, pending: boolean) => {
    setCheckOutFlights(previous => { const next = new Set(previous); if (pending) next.add(operationId); else next.delete(operationId); return next; });
  }, []);
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const refreshCheckOutRecovery = useCallback(() => {
    setCheckOutAttempt(readStationAttempt("check-out")); setCheckOutReview(readQuarantinedCheckOut());
    setRecoveryVersion(value => value + 1);
  }, []);
  const lastActivity = useRef(0);

  const hide = useCallback(() => {
    epoch.current += 1; readSequence.current += 1; viewRef.current = null; setView(null); setRoster(null);
    activityTask.current = null; activeJobs.current.clear();
    setStaff(null); setArrivals(null); setConfirming(null);
  }, []);

  const refresh = useCallback(async (clear = false, afterActivity = false) => {
    if (busy.current || remoteHold.current || !pageVisible() || activityTask.current && !afterActivity) return;
    if (clear) hide();
    const ticket = epoch.current;
    const sequence = ++readSequence.current;
    try {
      const next = await stationApi.current();
      if (ticket !== epoch.current || sequence !== readSequence.current || !pageVisible()) return;
      const heldLock = readStationAttempt("lock");
      if (hasStationLockBarrier()) localLock.current = true;
      if (heldLock) {
        localLock.current = true;
        const current = next.runtime.session;
        if (next.runtime.state === stationState.locked || (current &&
          (current.browserSessionId !== heldLock.browserSessionId || current.generation > heldLock.generation))) {
          try { saveStationAttempt("lock", null); } catch { /* Rechecked on every future read. */ }
          localLock.current = false;
        }
      }
      if (localLock.current && next.runtime.state === stationState.active) {
        setMessage("Guest details are hidden. The server has not confirmed the lock. Retry locking before leaving this device.");
        return;
      }
      if (next.runtime.state === stationState.locked) localLock.current = false;
      if (![stationState.active, stationState.locked, stationState.securing].includes(next.runtime.state as 1 | 2 | 5)) {
        hide(); setMessage(next.runtime.state === stationState.invalid ? "This browser needs manager setup."
          : "Station authority changed or is unavailable. Refresh to check again."); return;
      }
      const unlockAttempt = readStationAttempt("unlock");
      if (unlockAttempt && next.runtime.session && (next.runtime.session.browserSessionId !== unlockAttempt.browserSessionId ||
        next.runtime.session.generation > unlockAttempt.generation)) {
        try { saveStationAttempt("unlock", null); } catch { /* A later read can resolve the same terminal boundary. */ }
      }
      if (viewRef.current && boundary(viewRef.current) !== boundary(next)) hide();
      viewRef.current = next; setView(next);
      if (next.runtime.state === stationState.active) setMessage(previous => previous === offlineNotice ? "" : previous);
    } catch (error) {
      if (ticket !== epoch.current || sequence !== readSequence.current) return;
      hide(); setMessage(errorMessage(error));
      if (error instanceof StationRequestError && error.retryAt) setRetryAt(error.retryAt);
    }
  }, [hide]);

  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); void refresh(); }, 15_000);
    const visibility = () => { if (document.visibilityState === "hidden") hide(); else void refresh(); };
    const offline = () => { hide(); setMessage(offlineNotice); };
    const online = () => { void refresh(); };
    const stationChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("bunkfy.station.boundary.v1") : null;
    channel.current = stationChannel;
    if (stationChannel) stationChannel.onmessage = event => {
      hide();
      remoteHold.current = event.data === "changing";
      if (!remoteHold.current) void refresh();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === STATION_LOCK_KEY) { localLock.current = Boolean(event.newValue); hide(); void refresh(); }
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("offline", offline); window.addEventListener("online", online);
    window.addEventListener("storage", storage);
    void refresh();
    return () => {
      window.clearInterval(timer); stationChannel?.close(); channel.current = null; hide();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("offline", offline); window.removeEventListener("online", online);
      window.removeEventListener("storage", storage);
    };
  }, [hide, refresh]);

  const session = view?.runtime.session;
  const actor = session?.actor;
  const active = view?.runtime.state === stationState.active && actor;
  const locked = view?.runtime.state === stationState.locked;
  const generation = session?.generation;
  const actorId = actor?.actorSessionId;
  const canCheckIn = active && view?.jobs?.checkIn === 0;
  const canCheckOut = active && view?.jobs?.checkOut === 0;
  const selectedTask: StationTask = canCheckOut && (task === "check-out" || !canCheckIn) ? "check-out" : "check-in";
  const refreshAuthority = useCallback(() => { void refresh(); }, [refresh]);
  useLayoutEffect(() => {
    if (!canCheckIn) { setArrivals(null); setConfirming(null); }
  }, [canCheckIn]);
  useEffect(() => {
    if (!active || !jobAttempt || jobAttempt.actorSessionId === actorId && jobAttempt.generation === generation || quarantined) return;
    try {
      quarantineCheckIn(jobAttempt);
      setQuarantined(readQuarantinedCheckIn()); setJobAttempt(readStationAttempt("check-in"));
    } catch { setMessage("Two check-in results need review. No further check-ins will be sent until a result is confirmed."); }
  }, [active, actorId, generation, jobAttempt, quarantined]);
  useEffect(() => {
    // Keep an uncertain checkout local to its reservation. Two bounded slots
    // prevent overwriting an older action while allowing unrelated departures.
    if (!active || !checkOutAttempt || checkOutReview) return;
    try { quarantineCheckOut(checkOutAttempt); refreshCheckOutRecovery(); }
    catch { setMessage("Two checkout results need review. Resolve an original result before another checkout."); }
  }, [active, checkOutAttempt, checkOutReview, refreshCheckOutRecovery]);
  useLayoutEffect(() => {
    if (!focusIntent.current || pending) return;
    if (document.activeElement !== document.body) { focusIntent.current = null; return; }
    const target = focusIntent.current === "pin" ? pinInput.current : focusIntent.current === "search" ? searchInput.current : recoveryButton.current;
    if (target) { target.focus(); focusIntent.current = null; }
  }, [staff, view, pending]);
  useEffect(() => { lastActivity.current = 0; }, [actorId, generation]);

  useEffect(() => {
    if (!active || !session) return;
    const deadlines = [session.actorIdleExpiresAtUtc, session.actorAbsoluteExpiresAtUtc, session.pairingExpiresAtUtc]
      .filter((value): value is string => Boolean(value)).map(Date.parse);
    const deadline = Math.min(...deadlines);
    if (!Number.isFinite(deadline)) { hide(); return; }
    const timeout = window.setTimeout(() => { hide(); setMessage("Your station session has ended. Enter your PIN again."); void refresh(); }, Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [active, session, hide, refresh]);

  useEffect(() => {
    if (!locked || setup) return;
    const controller = new AbortController();
    const ticket = epoch.current;
    const timeout = window.setTimeout(() => {
      setRoster(null);
      void stationApi.roster(search, page, controller.signal).then(result => {
        if (ticket === epoch.current && !controller.signal.aborted) setRoster(result);
      }).catch(error => { if (!controller.signal.aborted && ticket === epoch.current) { hide(); setMessage(errorMessage(error)); } });
    }, search ? 250 : 0);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [locked, setup, generation, page, search, hide]);

  const beginJob: BeginStationJob = useCallback(async () => {
    const ticket = epoch.current;
    await activityTask.current?.promise;
    if (ticket !== epoch.current || !pageVisible() || localLock.current || remoteHold.current) return null;
    const current = viewRef.current;
    if (current?.runtime.state !== stationState.active || !current.runtime.session?.actor || !current.csrfToken) return null;
    const token = Symbol("station-job"); activeJobs.current.add(token);
    return { view: current, release: () => { activeJobs.current.delete(token); } };
  }, []);

  const loadArrivals = useCallback(async (cursor?: string) => {
    const ticket = epoch.current;
    setJobBusy(true); setArrivals(null); setConfirming(null);
    const job = await beginJob();
    if (!job) { if (ticket === epoch.current) setJobBusy(false); return; }
    try {
      const result = await stationApi.arrivals(job.view.runtime.session!.actor!, cursor);
      if (ticket === epoch.current && viewRef.current?.jobs?.checkIn === 0) {
        setArrivals(result);
        setMessage(previous => previous === "The station changed. Refresh before continuing." ? "" : previous);
      }
    } catch (error) { if (ticket === epoch.current) { hide(); setMessage(errorMessage(error)); } }
    finally { job.release(); if (ticket === epoch.current) setJobBusy(false); }
  }, [beginJob, hide]);

  useEffect(() => { if (actorId && canCheckIn) void loadArrivals(); }, [actorId, generation, canCheckIn, loadArrivals]);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!staff || !session || !view?.csrfToken || busy.current || Date.now() < retryAt) return;
    const pin = String(new FormData(event.currentTarget).get("pin") ?? "");
    event.currentTarget.reset();
    if (!/^[0-9]{6}$/.test(pin)) return;
    const previous = readStationAttempt("unlock");
    if (previous && (previous.browserSessionId !== session.browserSessionId || previous.generation !== session.generation || previous.staffMemberId !== staff.id)) {
      setMessage("Resolve the previous sign-in attempt before choosing another staff member. Refresh the station to check its result."); return;
    }
    const attempt: StationAttempt = previous ?? { kind: "unlock", operationId: crypto.randomUUID(),
      browserSessionId: session.browserSessionId, generation: session.generation, staffMemberId: staff.id };
    try { saveStationAttempt("unlock", attempt); } catch { setMessage("This browser cannot save a recovery reference. Sign-in was not sent."); return; }
    busy.current = true; setPending(true); setMessage("");
    const current = view; const selected = staff;
    hide(); channel.current?.postMessage("changing");
    try {
      const result = await stationApi.unlock({ operationId: attempt.operationId, staffMemberId: selected.id,
        expectedGeneration: session.generation, pin }, current.csrfToken!);
      if (result.state === stationState.active) try { saveStationAttempt("unlock", null); } catch { /* Terminal server success. */ }
    } catch (error) {
      setMessage(error instanceof StationRequestError && error.status === 403
        ? "Unable to unlock. Check your name and PIN; ask a manager if your access needs updating." : errorMessage(error));
      if (error instanceof StationRequestError && error.retryAt) setRetryAt(error.retryAt);
      if (error instanceof StationRequestError && [400, 403, 429].includes(error.status)) {
        try { saveStationAttempt("unlock", null); } catch { /* Preserve conservative recovery if storage is unavailable. */ }
      }
    } finally { busy.current = false; setPending(false); channel.current?.postMessage("changed"); void refresh(); }
  }

  async function lock() {
    if (busy.current) return;
    const previous = viewRef.current;
    localLock.current = true; hide(); setMessage("Locking station…");
    channel.current?.postMessage("changing"); busy.current = true; setPending(true);
    try {
      // Persist the privacy barrier before any asynchronous read, even if the old
      // view was already hidden. Only a confirmed server boundary releases it.
      if (!hasStationLockBarrier()) localStorage.setItem(STATION_LOCK_KEY, "pending");
      const current = previous ?? await stationApi.current();
      if (current.runtime.state === stationState.locked) { localLock.current = false; saveStationAttempt("lock", null); }
      else if (current.runtime.session && current.csrfToken) {
        const held = readStationAttempt("lock");
        const attempt: StationAttempt = held && held.browserSessionId === current.runtime.session.browserSessionId && held.generation === current.runtime.session.generation
          ? held : { kind: "lock", operationId: crypto.randomUUID(), browserSessionId: current.runtime.session.browserSessionId, generation: current.runtime.session.generation };
        saveStationAttempt("lock", attempt);
        const result = await stationApi.lock({ operationId: attempt.operationId, expectedGeneration: attempt.generation }, current.csrfToken);
        if (result.state === stationState.locked) { localLock.current = false; saveStationAttempt("lock", null); }
      }
      setMessage(localLock.current ? "Lock could not be confirmed. Keep this device with you and retry." : "Station locked. Choose the next staff member.");
    } catch (error) { setMessage(`Guest details are hidden. Lock not confirmed: ${errorMessage(error)}`); }
    // A confirmed lock must not wait behind the superseded actor's activity.
    finally {
      focusIntent.current = localLock.current ? "recovery" : "search";
      busy.current = false; setPending(false); channel.current?.postMessage("changed"); void refresh(false, true);
    }
  }

  function foregroundActivity() {
    const current = viewRef.current;
    const currentActor = current?.runtime.session?.actor;
    if (document.visibilityState !== "visible" || !currentActor || !current?.csrfToken || busy.current || activityTask.current || activeJobs.current.size || Date.now() - lastActivity.current < 60_000) return;
    lastActivity.current = Date.now();
    const ticket = epoch.current;
    const csrfToken = current.csrfToken;
    const task = { epoch: ticket, promise: Promise.resolve() }; activityTask.current = task;
    task.promise = (async () => {
      try {
        await stationApi.activity({ operationId: crypto.randomUUID(), actorSessionId: currentActor.actorSessionId,
          expectedGeneration: currentActor.generation }, csrfToken);
        if (ticket === epoch.current) await refresh(false, true);
      } catch (error) { if (ticket === epoch.current) { hide(); setMessage(errorMessage(error)); } }
      finally { if (activityTask.current === task) activityTask.current = null; }
    })();
  }

  async function redeemSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!setup || !view?.csrfToken || !locked || busy.current) return;
    const form = event.currentTarget; const data = new FormData(form);
    const pin = String(data.get("pin") ?? "");
    if (!/^[0-9]{6}$/.test(pin) || pin !== data.get("confirmPin")) {
      setMessage("Enter the same 6-digit PIN in both fields."); return;
    }
    form.reset(); busy.current = true; setPending(true);
    setupOperation.current ??= crypto.randomUUID();
    try {
      const result = await stationApi.redeem({ operationId: setupOperation.current, setupGrantId: setup, pin }, view.csrfToken);
      if (result.outcome !== 1) throw new Error("PIN creation is not confirmed.");
      setSetup(undefined); setupOperation.current = null;
      setMessage("Your PIN is ready. Choose your name and enter it to unlock the station.");
      focusIntent.current = "search";
    } catch (error) {
      setMessage(`${errorMessage(error)} Re-enter the same PIN to check the original setup. If access has expired, ask your manager to prepare it again.`);
    } finally { busy.current = false; setPending(false); void refresh(); }
  }

  return <main className="mx-auto min-h-dvh w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10"
    onPointerDown={event => { if (event.isTrusted && !(event.target as Element).closest("[data-station-boundary]")) void foregroundActivity(); }}
    onKeyDown={event => { if (event.isTrusted && !(event.target as Element).closest("[data-station-boundary]")) void foregroundActivity(); }}>
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-base-300 pb-5">
      <div className="min-w-0"><p className="mb-1 text-sm font-medium text-primary">BunkFy · Shared station</p>
        <h1 className="text-2xl font-semibold [overflow-wrap:anywhere]">{session?.stationLabel ?? "Staff sign-in"}</h1>
        {view?.propertyName && <p className="mt-1 text-sm text-base-content/70 [overflow-wrap:anywhere]">{view.propertyName}</p>}
      </div>
      {active && <button data-station-boundary className="btn btn-outline" onClick={() => { focusIntent.current = "search"; void lock(); }} disabled={pending}><LockKeyhole size={18} /> Lock / switch staff</button>}
    </header>
    {message && <p className="mb-5 rounded-lg border border-base-300 bg-base-100 px-4 py-3 text-sm leading-6" role="status">{message}</p>}
    {!view && <section className="max-w-xl space-y-4">
      <h2 className="text-lg font-semibold">{pending ? "Securing your station…" : "Station details are hidden"}</h2>
      <p className="text-sm leading-6">{pending ? "Please wait for confirmation." : "Refresh to check the current session. If this browser is not paired, a manager must set it up."}</p>
      <div className="flex flex-wrap gap-3">
        <button ref={recoveryButton} className="btn btn-outline" disabled={pending || now < retryAt} onClick={() => { remoteHold.current = false; focusIntent.current = "search"; void (localLock.current ? lock() : refresh(true)); }}>
          <RefreshCw size={16} /> {localLock.current ? "Retry locking" : "Refresh station"}</button>
        <a href={applicationUrl("/workspace?section=stations")} className="btn btn-ghost">Manager setup</a>
      </div>
    </section>}
    {view?.runtime.state === stationState.securing && <section className="max-w-xl space-y-4">
      <h2 className="text-lg font-semibold">Finish securing this browser</h2>
      <p className="text-sm leading-6">The manager’s original account session must end before staff can use this station. No guest information is available here yet.</p>
      <a className="btn btn-outline" href={applicationUrl("/workspace?section=stations")}>Return to manager setup</a>
      <button className="btn btn-ghost" onClick={() => void refresh()}>Check again</button>
    </section>}
    {locked && setup && <section className="mx-auto max-w-xl rounded-lg border border-base-300 bg-base-100 p-5 sm:p-6">
      <h2 className="text-lg font-semibold">Create your staff PIN</h2>
      <p className="mt-2 text-sm leading-6">Your manager prepared this browser for your staff profile. Enter the PIN privately; the manager does not need to see it.</p>
      <form className="mt-5 space-y-4" onSubmit={redeemSetup}><PinFields confirm disabled={pending} />
        <button className="btn btn-primary" disabled={pending}>{pending ? "Checking…" : setupOperation.current ? "Check original PIN setup" : "Save my PIN"}</button>
      </form>
    </section>}
    {locked && !setup && <section className="mx-auto max-w-xl rounded-lg border border-base-300 bg-base-100 p-5 sm:p-6">
      <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold"><UsersRound size={20} /> {staff ? `Sign in as ${staff.name}` : "Choose your name"}</h2>
      {!staff ? <>
        <label className="mt-4 block text-sm font-medium">Find staff
          <input ref={searchInput} className="input input-bordered mt-2 w-full" type="search" value={search} maxLength={100}
            onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Name or staff number" />
        </label>
        <div className="my-4 divide-y divide-base-300" aria-live="polite">
          {!roster ? <p className="py-4 text-sm">Loading staff…</p> : !roster.items?.length ? <p className="py-4 text-sm">{search ? "No matching staff. Try another name." : "No eligible staff. Ask a manager to register staff for this property."}</p>
            : roster.items.map(person => <button type="button" key={person.staffMemberId}
              className="flex w-full items-center justify-between gap-3 rounded px-2 py-4 text-left hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-primary"
              onClick={() => { focusIntent.current = "pin"; setStaff({ id: person.staffMemberId, name: person.displayName ?? `Staff ${person.rosterReference}` }); }}>
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{person.displayName}</span><span className="shrink-0 text-xs text-base-content/65">Staff {person.rosterReference}</span>
            </button>)}
        </div>
        {(page > 1 || roster?.hasMore) && <nav className="flex items-center justify-between gap-2" aria-label="Staff pages">
          <button className="btn btn-outline btn-sm" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="text-sm">Page {page}</span><button className="btn btn-outline btn-sm" disabled={!roster?.hasMore} onClick={() => setPage(page + 1)}>Next</button>
        </nav>}
      </> : <form onSubmit={unlock} className="mt-5 space-y-5">
        <PinFields inputRef={pinInput} disabled={pending || now < retryAt} />
        {readStationAttempt("unlock") && <p role="status" className="text-sm leading-6">A previous sign-in is unconfirmed. Choose the same name and re-enter the same PIN to check that attempt. This will not count as a new PIN attempt.</p>}
        <div className="flex flex-wrap gap-3"><button className="btn btn-primary" disabled={pending || now < retryAt}><KeyRound size={17} /> Unlock station</button>
          <button type="button" className="btn btn-ghost" onClick={() => { focusIntent.current = "search"; setStaff(null); }}><ArrowLeft size={16} /> Choose another name</button></div>
        {now < retryAt && <p role="status" className="text-sm">Try again after {new Date(retryAt).toLocaleTimeString()}.</p>}
        <p className="text-sm leading-6 text-base-content/65">Forgot your PIN? Use Account → Security on your personal device, or ask a manager for help. Never share a colleague’s PIN.</p>
      </form>}
    </section>}
    {active && <section>
      <p className="mb-4 text-sm text-base-content/70">Working as <strong className="font-semibold text-base-content">{view.staffDisplayName}</strong></p>
      {quarantined && <StationCheckInRecovery key={quarantined.operationId} attempt={quarantined} view={view} beginJob={beginJob} canRetry={Boolean(canCheckIn)} quarantined onResolved={() => {
        setQuarantined(readQuarantinedCheckIn()); if (canCheckIn) void loadArrivals();
      }} onUnavailable={error => { hide(); setMessage(error); }} />}
      {jobAttempt && !confirming && <StationCheckInRecovery key={jobAttempt.operationId} attempt={jobAttempt} view={view} beginJob={beginJob} canRetry={Boolean(canCheckIn)} onResolved={() => {
        setJobAttempt(readStationAttempt("check-in")); if (canCheckIn) void loadArrivals();
      }} onUnavailable={error => { hide(); setMessage(error); }} />}
      {checkOutFlights.size > 0 && <p role="status" className="mb-4 text-sm leading-6">A checkout request is in progress. Wait for its original result before retrying it.</p>}
      {[checkOutReview, checkOutAttempt].filter((item): item is StationAttempt => item !== null && !checkOutFlights.has(item.operationId)).map(operation =>
        <StationCheckOutRecovery key={operation.operationId} attempt={operation} view={view} canRetry={Boolean(canCheckOut)} beginJob={beginJob}
          onResolved={refreshCheckOutRecovery} onAuthorityChanged={refreshAuthority} />)}
      {(canCheckIn || canCheckOut) && <StationTaskTabs value={selectedTask} checkIn={Boolean(canCheckIn)} checkOut={Boolean(canCheckOut)}
        onChange={next => { setConfirming(null); setTask(next); }} />}
      {!canCheckIn && !canCheckOut && <div className="rounded-lg border border-base-300 bg-base-100 p-5">
        <h2 className="font-semibold">{view.jobs?.checkIn === 1 && view.jobs?.checkOut === 1 ? "No station tasks are assigned" : "Station tasks are unavailable"}</h2>
        <p className="mt-2 text-sm leading-6">{view.jobs?.checkIn === 1 && view.jobs?.checkOut === 1
          ? "Ask a manager to review your access at this property, or lock the station and choose another staff member."
          : "Refresh to check your current access and property configuration. Guest details remain hidden."}</p>
        <button className="btn btn-outline mt-4" onClick={refreshAuthority}><RefreshCw size={16} /> Refresh tasks</button>
      </div>}
      {canCheckIn && selectedTask === "check-in" && <section id="station-panel-check-in" role="tabpanel" aria-labelledby="station-tab-check-in" tabIndex={0}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-lg font-semibold">Due arrivals</h2>
          {arrivals?.propertyLocalDate && <p className="mt-1 text-sm text-base-content/70">{day(arrivals.propertyLocalDate)}</p>}</div>
        <button className="btn btn-outline btn-sm aria-disabled:opacity-50" aria-disabled={jobBusy} aria-busy={jobBusy}
          onClick={() => { if (!jobBusy) void loadArrivals(); }}><RefreshCw size={16} /> Refresh arrivals</button>
      </div>
      {jobBusy || !arrivals ? <p role="status" className="py-8 text-sm">Checking current arrivals…</p>
        : arrivals.state === 4 ? <div role="status" className="rounded-lg border border-base-300 bg-base-100 p-5">
          <h3 className="font-semibold">Arrival information is not ready</h3>
          <p className="mt-2 text-sm leading-6">Reservations and room information are still being checked. Refresh arrivals to try again. If this continues, ask a manager to review the reservations.</p>
        </div>
          : arrivals.state !== 0 ? <p role="status" className="py-8 text-sm">Arrivals are unavailable for this staff member. Ask a manager to check access and property configuration.</p>
          : !arrivals.items?.length ? <p className="rounded-lg border border-base-300 bg-base-100 p-6 text-sm">No reservations are currently eligible for check-in.</p>
            : <ul className="divide-y divide-base-300 rounded-lg border border-base-300 bg-base-100">
              {arrivals.items.map(item => <li key={item.reservation.reservationId} className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0"><h3 className="font-semibold [overflow-wrap:anywhere]">{item.reservation.primaryGuestName}</h3>
                    <p className="mt-1 text-sm text-base-content/70">{day(item.reservation.arrival)} – {day(item.reservation.departure)}</p>
                    <p className="mt-2 text-sm [overflow-wrap:anywhere]">{(item.places ?? []).map(place => `${place.roomName}${place.bedLabel ? ` · ${place.bedLabel}` : ""}`).join(", ")}</p></div>
                  <button className="btn btn-primary btn-sm" disabled={Boolean(jobAttempt) || quarantined?.reservationId === item.reservation.reservationId} onClick={() => setConfirming(item)}><Check size={16} /> Check in</button>
                </div>
                {quarantined?.reservationId === item.reservation.reservationId && <p className="mt-3 text-sm" role="status">An earlier check-in for this reservation still needs confirmation. Ask a manager to review its history.</p>}
                {confirming?.reservation.reservationId === item.reservation.reservationId && view.csrfToken &&
                  <StationCheckIn key={`${actorId}:${item.reservation.reservationId}`} item={item} view={view} beginJob={beginJob}
                    onCancel={() => setConfirming(null)} onIntent={setJobAttempt}
                    onChanged={() => { setJobAttempt(readStationAttempt("check-in")); setQuarantined(readQuarantinedCheckIn()); void loadArrivals(); }} onUnavailable={error => {
                      if (viewRef.current?.runtime.session?.actor?.actorSessionId === actorId) { hide(); setMessage(error); }
                    }} />}
              </li>)}
            </ul>}
      {arrivals?.continuation && <button className="btn btn-outline mt-4" onClick={() => void loadArrivals(arrivals.continuation!)}>Next arrivals</button>}
      </section>}
      {canCheckOut && selectedTask === "check-out" && <StationDepartures key={`${actorId}:${generation}`}
        view={view} beginJob={beginJob} onAuthorityChanged={refreshAuthority} attempt={checkOutAttempt} review={checkOutReview}
        recoveryVersion={recoveryVersion} onRecoveryChanged={refreshCheckOutRecovery} onFlightChanged={checkOutFlightChanged} />}
    </section>}
    <footer className="mt-8 border-t border-base-300 pt-4 text-sm leading-6 text-base-content/65">Lock this station whenever you step away. It also locks automatically after inactivity.</footer>
  </main>;
}

function StationCheckIn({ item, view, beginJob, onCancel, onChanged, onUnavailable, onIntent }: {
  item: StationArrival; view: StationCurrent; onCancel: () => void; onChanged: () => void; onUnavailable: (message: string) => void;
  onIntent: (attempt: StationAttempt) => void; beginJob: BeginStationJob;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const intent = useRef<string | null>(null);
  const inFlight = useRef(false);
  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true);
    const job = await beginJob();
    if (!job || boundary(job.view) !== boundary(view)) {
      job?.release(); inFlight.current = false; setPending(false); return;
    }
    const actor = job.view.runtime.session!.actor!;
    intent.current ??= crypto.randomUUID();
    const attempt: StationAttempt = { kind: "check-in", operationId: intent.current,
      browserSessionId: job.view.runtime.session!.browserSessionId, generation: actor.generation,
      actorSessionId: actor.actorSessionId, reservationId: item.reservation.reservationId, expectedVersion: item.reservation.expectedVersion };
    try { saveStationAttempt("check-in", attempt); }
    catch { job.release(); setMessage("This browser cannot save a recovery reference. Check-in was not sent."); inFlight.current = false; setPending(false); return; }
    onIntent(attempt);
    try {
      const result = await stationApi.checkIn({ operationId: intent.current, reservationId: item.reservation.reservationId,
        expectedVersion: item.reservation.expectedVersion, actorSessionId: actor.actorSessionId, expectedGeneration: actor.generation }, job.view.csrfToken!);
      if (result.state === 6 && result.receipt) {
        try { clearConfirmedCheckIn(attempt.operationId); } catch { /* A confirmed result remains terminal. */ }
        setMessage("Checked in."); onChanged();
      }
      else setMessage("Check-in was not confirmed. Refresh the arrivals list before continuing.");
    } catch (error) {
      if (error instanceof StationRequestError && [401, 403, 409].includes(error.status)) onUnavailable(errorMessage(error));
      else setMessage("Result not confirmed. Retry here to check the same operation. Do not start a second check-in.");
    } finally { job.release(); inFlight.current = false; setPending(false); }
  }
  return <div className="mt-4 border-t border-base-300 pt-4">
    <p className="text-sm leading-6">Confirm the guest has arrived and the assigned space is correct. This check-in will be recorded under {view.staffDisplayName}.</p>
    {message && <p className="mt-2 text-sm" role="status">{message}</p>}
    <div className="mt-3 flex flex-wrap gap-3"><button className="btn btn-primary" disabled={pending} onClick={() => void submit()}>{pending ? "Checking…" : intent.current ? "Check / retry original check-in" : "Confirm check-in"}</button>
      <button className="btn btn-ghost" disabled={pending} onClick={onCancel}>Close</button></div>
  </div>;
}

function StationCheckInRecovery({ attempt, view, beginJob, onResolved, onUnavailable, quarantined = false, canRetry = true }: {
  attempt: StationAttempt; view: StationCurrent; onResolved: () => void; onUnavailable: (message: string) => void;
  quarantined?: boolean; canRetry?: boolean; beginJob: BeginStationJob;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [needsReview, setNeedsReview] = useState(false);
  const inFlight = useRef(false);
  const actor = view.runtime.session?.actor;
  const sameBrowser = view.runtime.session?.browserSessionId === attempt.browserSessionId;
  const matches = canRetry && actor?.actorSessionId === attempt.actorSessionId && actor?.generation === attempt.generation &&
    sameBrowser;
  async function resolve() {
    if (!sameBrowser || needsReview || !view.csrfToken || !attempt.reservationId || !attempt.expectedVersion || !attempt.actorSessionId || inFlight.current) return;
    inFlight.current = true; setPending(true);
    const job = await beginJob();
    if (!job || boundary(job.view) !== boundary(view)) {
      job?.release(); inFlight.current = false; setPending(false); return;
    }
    try {
      if (!matches) {
        const result = await stationApi.checkInOutcome({ operationId: attempt.operationId, reservationId: attempt.reservationId,
          expectedVersion: attempt.expectedVersion, browserSessionId: attempt.browserSessionId,
          actorSessionId: attempt.actorSessionId, expectedGeneration: attempt.generation }, job.view.csrfToken!);
        if (result.state === 1) {
          try { clearConfirmedCheckIn(attempt.operationId); } catch { /* The server confirmed this exact historical operation. */ }
          onResolved();
        } else setMessage("The original check-in is not confirmed yet. Nothing was retried. Check again or ask a manager to review the reservation history.");
        return;
      }
      const result = await stationApi.checkIn({ operationId: attempt.operationId, reservationId: attempt.reservationId,
        expectedVersion: attempt.expectedVersion, actorSessionId: attempt.actorSessionId, expectedGeneration: attempt.generation }, job.view.csrfToken!);
      if (result.state === 6 && result.receipt) {
        try { clearConfirmedCheckIn(attempt.operationId); } catch { /* Server receipt proves the result. */ }
        onResolved();
      } else setMessage("The original check-in is still not confirmed. Ask a manager to inspect the reservation before another attempt.");
    } catch (error) {
      if (!matches && error instanceof StationRequestError && error.status === 409 && error.state === 2 && !error.code) {
        setNeedsReview(true);
        setMessage("This saved attempt does not match a confirmed check-in. Ask a manager to review the reservation history. The reservation remains held; other arrivals are available.");
        return;
      }
      if (error instanceof StationRequestError && [401, 403, 409].includes(error.status)) onUnavailable(errorMessage(error));
      else setMessage(matches ? "Result still unavailable. Retry checks the same operation; it will not create a second check-in."
        : "Result still unavailable. Nothing was retried. Check again when the station reconnects.");
    } finally { job.release(); inFlight.current = false; setPending(false); }
  }
  return <div className="mb-4 rounded-lg border border-warning/50 bg-base-100 p-4" role="status">
    <h3 className="text-sm font-semibold">A check-in needs its result confirmed</h3>
    <p className="mt-1 text-sm leading-6">{matches ? "Resolve the original operation before starting another check-in."
      : quarantined ? "The staff session changed. This reservation is held for review; you can check in other arrivals. Check the original result without repeating the check-in."
        : "The staff session changed and two results need review. No more check-ins will be sent until a result is confirmed. Ask a manager to review the reservation history."}</p>
    {message && <p className="mt-2 text-sm">{message}</p>}
    {sameBrowser && !needsReview && <button className="btn btn-outline btn-sm mt-3" disabled={pending} onClick={() => void resolve()}>{pending ? "Checking…" : matches ? "Check / retry original check-in" : "Check original result"}</button>}
  </div>;
}
