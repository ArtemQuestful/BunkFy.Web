import { applicationUrl } from "../../app/deploymentBase";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound, Monitor, ShieldCheck } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { ApiError } from "../../api/client";
import type { AuthenticationSessions, StaffPropertyDirectoryListResponse, StationWorkspaceSettings } from "../../api/types";
import { OfflineRequestError, assertRequestCanStart } from "../../api/requestConnectivity";
import { useSession } from "../../app/session";
import { permissions, tenantAccessScope, usePermissions } from "../../app/permissions";
import { useWorkspace } from "../../app/workspace";
import { FormSection } from "../../components/ui/FormLayout";
import { Modal, ModalActions } from "../../components/ui/primitives";
import { enterStation } from "../stations/stationHandoff";
import type { StationList, StationManagementResult, StationStaffStatus } from "../stations/stationTypes";
import { readManagementRecovery, saveManagementRecovery, readPairingContext, savePairingContext,
  type ManagementCommand as Command, type PairingContext } from "../stations/stationManagementRecovery";

type WorkspaceStationsSettingsProps = {
  settings: StationWorkspaceSettings | null;
  settingsLoaded: boolean;
  settingsLoading: boolean;
  settingsError: unknown;
  canManageSettings: boolean;
  onSettingsChanged: () => Promise<void>;
};

export function WorkspaceStationsSettings(props: Partial<WorkspaceStationsSettingsProps> = {}) {
  const {
    settings = { sharedStationPinEnabled: true, revision: 0 },
    settingsLoaded = true,
    settingsLoading = false,
    settingsError = null,
    canManageSettings = true,
    onSettingsChanged = async () => undefined,
  } = props;
  const { selectedProperty } = useWorkspace();
  const { session } = useSession();
  return <div className="space-y-6">
    <StationFeatureSettings
      settings={settings}
      settingsLoaded={settingsLoaded}
      settingsLoading={settingsLoading}
      settingsError={settingsError}
      canManage={canManageSettings}
      onSaved={onSettingsChanged}
    />
    {!settingsLoaded || settingsError || settings?.sharedStationPinEnabled !== true
      ? <p className="text-sm leading-6 text-base-content/65">
          {settingsLoading
            ? "Checking workspace station access…"
            : settingsError
              ? "Station access could not be checked. Refresh before managing stations."
              : "Shared station PIN access is disabled for this workspace."}
        </p>
      : !selectedProperty || !session
        ? <p className="text-sm leading-6">Choose a property to set up its shared stations.</p>
        : <StationsManager key={`${session.generation}:${selectedProperty.propertyId}`}
          propertyId={selectedProperty.propertyId} propertyName={selectedProperty.name} />}
  </div>;
}

function StationFeatureSettings({
  settings,
  settingsLoaded,
  settingsLoading,
  settingsError,
  canManage,
  onSaved,
}: {
  settings: StationWorkspaceSettings | null;
  settingsLoaded: boolean;
  settingsLoading: boolean;
  settingsError: unknown;
  canManage: boolean;
  onSaved: () => Promise<void>;
}) {
  const { request } = useSession();
  const [message, setMessage] = useState("");
  const update = useMutation({
    mutationFn: (enabled: boolean) => request<StationWorkspaceSettings>(
      "/api/station-settings/workspace",
      {
        method: "PUT",
        body: JSON.stringify({
          sharedStationPinEnabled: enabled,
          expectedRevision: settings?.revision ?? 0,
        }),
      },
    ),
    onSuccess: async () => {
      setMessage("Workspace station access updated.");
      await onSaved();
    },
    onError: (error: unknown) => {
      setMessage(error instanceof ApiError && error.status === 409
        ? "The workspace setting changed elsewhere. Refresh and try again."
        : "The workspace station setting could not be saved.");
      void onSaved();
    },
  });
  const enabled = settings?.sharedStationPinEnabled === true;
  return <section className="rounded-lg border border-base-300 bg-base-200/35 p-4 sm:p-5">
    <div className="flex items-start gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><KeyRound size={18} /></span>
      <div className="min-w-0">
        <h2 className="font-display text-lg font-semibold">Shared station PIN access</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-base-content/65">
          Allow staff to use shared browsers and their workspace PINs. Disabling this hides PIN controls and rejects station sessions for this workspace.
        </p>
      </div>
    </div>
    <label className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-base-300 bg-base-100 p-3">
      <span className="text-sm font-semibold">Enable shared station access</span>
      <input
        type="checkbox"
        className="toggle toggle-primary"
        checked={enabled}
        disabled={!settingsLoaded || settingsLoading || Boolean(settingsError) || !canManage || update.isPending}
        onChange={(event) => { setMessage(""); update.mutate(event.target.checked); }}
        aria-label="Enable shared station access"
      />
    </label>
    {!canManage && <p className="mt-3 text-sm text-base-content/60">A workspace owner or shared-station manager can change this setting.</p>}
    {message && <p className="mt-3 text-sm" role="status">{message}</p>}
  </section>;
}

function StationsManager({ propertyId, propertyName }: { propertyId: string; propertyName: string }) {
  const { request, session, completeConfirmedBrowserSignOut } = useSession();
  const scope = tenantAccessScope(session!.tenantId);
  const access = usePermissions([{ permission: permissions.stationsManage, scope }]);
  const rootManager = access.hasData && !access.error && access.allows(permissions.stationsManage, scope);
  const endpoint = `/api/station-management/properties/${propertyId}`;
  const recoveryKey = `bunkfy.station-manager.v1:${session!.subjectId}:${session!.tenantId}:${propertyId}`;
  const [page, setPage] = useState(1);
  const [staffPage, setStaffPage] = useState(1);
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [operation, setOperation] = useState(() => readManagementRecovery(recoveryKey));
  const [retryOriginal, setRetryOriginal] = useState(false);
  const [retryName, setRetryName] = useState("");
  const [paired, setPaired] = useState<PairingContext | null>(() => readPairingContext(recoveryKey));
  const [setupGrant, setSetupGrant] = useState<string | undefined>();
  const [accepted, setAccepted] = useState(false);
  const [confirmation, setConfirmation] = useState<{ command: Command; title: string; consequence: string } | null>(null);
  const stations = useQuery({ queryKey: ["stations", "management", session?.generation, propertyId, page],
    queryFn: ({ signal }) => request<StationList>(`${endpoint}/stations?page=${page}&pageSize=25`, { signal }), retry: false });
  const staff = useQuery({ queryKey: ["stations", "staff-directory", session?.generation, propertyId, search, staffPage],
    queryFn: ({ signal }) => request<StaffPropertyDirectoryListResponse>(`/api/staff/properties/${propertyId}/members?${new URLSearchParams({ search, page: String(staffPage), pageSize: "25" })}`, { signal }),
    enabled: stations.data?.state === 0 && !stations.error, retry: false });
  const status = useQuery({ queryKey: ["stations", "staff-status", session?.generation, propertyId, chosen?.id],
    queryFn: ({ signal }) => request<StationStaffStatus>(`${endpoint}/staff/${chosen!.id}`, { signal }), enabled: Boolean(chosen), retry: false });
  const currentStaff = !status.error && !status.isFetching && status.data?.state === 0 ? status.data.item : null;
  const hasStationOnlyTask = Boolean(currentStaff && (
    currentStaff.localGrantPresent && !currentStaff.localGrantRevoked ||
    currentStaff.checkOutGrantPresent && !currentStaff.checkOutGrantRevoked));
  const usable = stations.data?.state === 0 && !stations.error && !stations.isFetching;

  function applied(result: StationManagementResult, command: Command, recovered = false) {
    if (result.state !== 0 || !result.receipt || result.receipt.kind !== command.kind) throw new Error("The server did not confirm this change.");
    const receipt = result.receipt;
    if (command.kind === 1 || command.kind === 9) {
      if (recovered) {
        setMessage("The station record was saved, but a pairing credential cannot be recovered from this result. Select the station below to explicitly pair this browser again.");
        setPaired(null);
      } else if (!receipt.stationId || !receipt.browserSessionId || receipt.originalIssuerSessionId !== session?.sessionId) {
        throw new Error("Pairing could not be matched to your current sign-in. Do not hand this device to staff yet.");
      } else {
        const context = { stationId: receipt.stationId, browserSessionId: receipt.browserSessionId, originalIssuerSessionId: receipt.originalIssuerSessionId };
        setPaired(context);
        try { savePairingContext(recoveryKey, context); } catch { /* Finish must retry saving before any sign-out. */ }
        setMessage("Browser prepared. Finish below to sign out your account before staff use it.");
      }
    } else if (command.kind === 13) {
      if (!receipt.setupGrantId) throw new Error("The PIN setup was not confirmed.");
      setSetupGrant(receipt.setupGrantId); setMessage("PIN setup is ready. Sign out below, then let the staff member enter their new PIN privately.");
    } else setMessage("Change saved.");
    setOperation(null); setRetryOriginal(false); setRetryName("");
    try { saveManagementRecovery(recoveryKey, null); } catch { /* Receipt success remains terminal. */ }
    void stations.refetch();
    if (chosen) void status.refetch();
  }

  async function execute(command: Command) {
    if (inFlight.current || operation || !usable) return;
    if (command.kind === 13 && !hasStationOnlyTask) return;
    inFlight.current = true; setPending(true); setMessage("");
    const id = crypto.randomUUID(); let sent = false;
    try {
      assertRequestCanStart({ method: "POST" });
      saveManagementRecovery(recoveryKey, { id, command });
      setOperation({ id, command }); sent = true;
      applied(await request<StationManagementResult>(`${endpoint}/operations`, { method: "POST", body: JSON.stringify({ ...command, operationId: id }) }), command);
    }
    catch (error) {
      if (!sent) setMessage(error instanceof OfflineRequestError ? error.message : "The browser could not save a recovery reference. No change was sent.");
      else if (error instanceof ApiError && [400, 403, 409].includes(error.status)) {
        try { saveManagementRecovery(recoveryKey, null); } catch { /* Keep conservative receipt recovery if storage fails. */ }
        setOperation(null); setMessage(error.status === 409 ? "This record changed. Refresh before trying again."
          : "This change was not allowed. Check your current manager access, staff eligibility and recent multi-factor sign-in.");
        void stations.refetch(); if (chosen) void status.refetch();
      } else setMessage("Result not confirmed. Check the original operation before starting another change.");
    } finally { inFlight.current = false; setPending(false); }
  }

  function ask(command: Command, title: string, consequence: string) { setConfirmation({ command, title, consequence }); }

  async function recover() {
    if (!operation || inFlight.current) return;
    inFlight.current = true; setPending(true);
    try { applied(await request<StationManagementResult>(`${endpoint}/operations/${operation.id}`), operation.command, true); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setRetryOriginal(true);
        setMessage("No result is recorded yet. Check again, or retry the original operation with the same reference. A delayed successful change will not be repeated.");
      } else setMessage("The result is unavailable. Check your connection and current manager access, then check again.");
    }
    finally { inFlight.current = false; setPending(false); }
  }

  async function retryOperation() {
    if (!operation || !retryOriginal || inFlight.current || !usable) return;
    const command = operation.command.kind === 1 && !operation.command.label
      ? { ...operation.command, label: retryName.trim() } : operation.command;
    if (command.kind === 1 && !command.label || command.kind === 14) return;
    inFlight.current = true; setPending(true);
    try {
      // The server fingerprint enforces the original payload. Never mint a second ID.
      applied(await request<StationManagementResult>(`${endpoint}/operations`, {
        method: "POST", body: JSON.stringify({ ...command, operationId: operation.id }),
      }), command, true);
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 409
        ? "The original operation conflicts with the current record or entered details. Check the original result; do not create a second change."
        : "The original result is still unconfirmed. Retry uses the same reference; no second operation will be created.");
    } finally { inFlight.current = false; setPending(false); }
  }

  async function finish() {
    if (!paired || operation || inFlight.current) return;
    const currentSessionId = session?.sessionId;
    if (!currentSessionId) { setMessage("Your sign-in could not be identified. Refresh and finish manager setup before handing over this device."); return; }
    inFlight.current = true; setPending(true); setMessage("Signing out your account and securing the station…");
    try {
      savePairingContext(recoveryKey, paired);
      if (session?.sessionId !== paired.originalIssuerSessionId) {
        // A new same-manager session can resolve a lost original sign-out, never sign-out-all.
        const before = await request<AuthenticationSessions>("/api/auth/sessions");
        if (before.sessions.some(item => item.sessionId === paired.originalIssuerSessionId)) {
          await request<void>(`/api/auth/sessions/${paired.originalIssuerSessionId}/sign-out`, { method: "POST" });
        }
        const after = await request<AuthenticationSessions>("/api/auth/sessions");
        if (after.sessions.some(item => item.sessionId === paired.originalIssuerSessionId)) throw new Error("Original session is still active.");
      }
      // A local logout is insufficient. Require an acknowledged server sign-out first.
      await request<void>("/api/auth/browser/sign-out", { method: "POST" });
      try { savePairingContext(recoveryKey, null); } catch { /* Server acknowledgement remains definitive. */ }
      completeConfirmedBrowserSignOut(currentSessionId);
      await enterStation(setupGrant);
    } catch { setMessage("Sign-out is not confirmed. Do not hand over this device. Retry here; if you are asked to sign in, use the same manager account and reopen Shared stations to finish the exact original session. PIN setup must be prepared again if this page was reloaded."); }
    finally { inFlight.current = false; setPending(false); }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accepted) return;
    const label = String(new FormData(event.currentTarget).get("label") ?? "").trim();
    if (label) void execute({ kind: 1, expectedVersion: 0, label });
  }

  if (stations.error || stations.data?.state !== undefined && stations.data.state !== 0) return <div className="space-y-4">
    <h2 className="text-lg font-semibold">Shared stations</h2>
    <p className="text-sm leading-6">Station settings are unavailable. A current station-management permission is required for this property.</p>
    <button className="btn btn-outline" onClick={() => void stations.refetch()}>Refresh access</button>
  </div>;

  return <div className="divide-y divide-base-300">
    <Modal open={Boolean(confirmation)} title={confirmation?.title ?? "Confirm change"} onClose={() => setConfirmation(null)} closeDisabled={pending}>
      <p className="text-sm leading-6">{confirmation?.consequence}</p>
      <ModalActions><button className="btn btn-ghost" disabled={pending} onClick={() => setConfirmation(null)}>Keep current access</button>
        <button className="btn btn-error" disabled={pending || Boolean(operation)} onClick={() => {
          if (confirmation) { const command = confirmation.command; setConfirmation(null); void execute(command); }
        }}>Confirm change</button></ModalActions>
    </Modal>
    <FormSection title="Shared stations" icon={<Monitor size={18} />} description={`Set up a shared browser at ${propertyName}. Staff use their own PIN; each guest action is recorded under their identity.`}>
      <p className="text-sm leading-6">Do this on the physical device staff will use. A manager’s recent multi-factor sign-in is required. Pairing does not grant staff permission.</p>
      {message && <p role="status" className="mt-4 rounded-lg border border-base-300 bg-base-200/40 p-3 text-sm leading-6">{message}</p>}
      {operation && <button className="btn btn-outline mt-3" disabled={pending} onClick={() => void recover()}>Check original result</button>}
      {operation && retryOriginal && operation.command.kind !== 14 && <div className="mt-3 space-y-3">
        {operation.command.kind === 1 && !operation.command.label && <label className="block text-sm font-medium">Original station name
          <input className="input input-bordered mt-2 w-full max-w-md" maxLength={100} value={retryName} onChange={event => setRetryName(event.target.value)} />
          <span className="mt-1 block font-normal">Re-enter the exact name used before. Its temporary recovery copy has expired.</span>
        </label>}
        <button className="btn btn-outline" disabled={pending || !usable || operation.command.kind === 1 && !operation.command.label && !retryName.trim()}
          onClick={() => void retryOperation()}>Retry original operation</button>
      </div>}
    </FormSection>
    {paired ? <FormSection title="Finish preparing this browser" icon={<ShieldCheck size={18} />}>
      <p className="text-sm leading-6">Your account is still signed in. Staff cannot unlock the station until your server session ends.</p>
      {chosen && currentStaff?.canIssueStationOnlySetup && rootManager && !setupGrant && <div className="mt-4 space-y-3">
        {hasStationOnlyTask ? <>
          <p className="text-sm leading-6">For <strong>{chosen.name}</strong> without a linked account, prepare a private PIN-creation step. Linked staff set their own PIN in Account → Security.</p>
          <button className="btn btn-outline" disabled={pending || Boolean(operation)} onClick={() => void execute({ kind: 13, expectedVersion: currentStaff.pinRevision,
            stationId: paired.stationId, browserSessionId: paired.browserSessionId, staffMemberId: chosen.id })}>Prepare staff PIN creation</button>
        </> : <p className="text-sm leading-6">Allow check-in or checkout for this staff member before preparing PIN creation. Pairing this browser does not grant task access.</p>}
      </div>}
      {!rootManager && chosen && <p className="mt-3 text-sm">PIN creation for staff without accounts needs a workspace-level station manager.</p>}
      <button className="btn btn-primary mt-5" disabled={pending || Boolean(operation)} onClick={() => void finish()}>{pending ? "Securing…" : "Sign out and open station"}</button>
    </FormSection> : <>
      <FormSection title="1. Staff access" description="Register staff assigned to this property, then allow the station tasks they need. Registration alone grants no guest access.">
        <label className="block text-sm font-medium">Find staff<input className="input input-bordered mt-2 w-full" type="search" maxLength={100} value={search}
          onChange={event => { setSearch(event.target.value); setStaffPage(1); setChosen(null); }} /></label>
        {staff.error ? <p className="mt-3 text-sm">The staff directory is unavailable. You also need permission to read staff for this property.</p>
          : staff.isLoading ? <p className="mt-3 text-sm">Loading staff…</p>
            : <div className="my-3 flex max-h-60 flex-col overflow-y-auto rounded border border-base-300">
              {staff.data?.items.map(person => <button key={person.staffMemberId} type="button" className={`px-3 py-3 text-left text-sm hover:bg-base-200 ${chosen?.id === person.staffMemberId ? "bg-primary/10 font-semibold" : ""}`}
                aria-pressed={chosen?.id === person.staffMemberId} onClick={() => setChosen({ id: person.staffMemberId, name: person.displayName })}>{person.displayName}</button>)}
              {staff.data?.items.length === 0 && <p className="p-3 text-sm">No staff match. Add or assign staff in the Staff page first.</p>}
            </div>}
        {(staffPage > 1 || staff.data?.hasMore) && <div className="flex flex-wrap gap-3">
          <button className="btn btn-outline btn-sm" disabled={staffPage === 1} onClick={() => setStaffPage(staffPage - 1)}>Previous staff</button>
          <button className="btn btn-outline btn-sm" disabled={!staff.data?.hasMore} onClick={() => setStaffPage(staffPage + 1)}>Next staff</button>
        </div>}
        {chosen && (status.isLoading || status.isFetching ? <p className="mt-3 text-sm">Checking PIN access…</p>
          : !currentStaff ? status.data?.state === 0 && !status.error ? <div className="mt-4 space-y-3">
              <p className="text-sm">{chosen.name} has no station registration for this property.</p>
              <button className="btn btn-outline" disabled={pending || Boolean(operation)} onClick={() => void execute({ kind: 10, expectedVersion: 0, staffMemberId: chosen.id })}>Register for stations</button>
            </div> : <p className="mt-3 text-sm">Staff access is unavailable. <button className="link" onClick={() => void status.refetch()}>Refresh</button></p>
            : <div className="mt-4 space-y-3 border-t border-base-300 pt-4">
              <h3 className="font-semibold">{chosen.name}</h3>
              <p className="text-sm">{currentStaff.registered ? "Registered for this property" : "Not registered for this property"} · {currentStaff.pin === 1 ? "PIN set" : "PIN needs setup"}</p>
              <div className="flex flex-wrap gap-3">
                <button className="btn btn-outline btn-sm" disabled={pending || Boolean(operation)} onClick={() => currentStaff.registered
                  ? ask({ kind: 11, expectedVersion: currentStaff.registrationVersion, staffMemberId: chosen.id }, `Remove station access for ${chosen.name}?`, "Their station sessions for this property will be locked. This does not remove their staff record or personal account.")
                  : void execute({ kind: 10, expectedVersion: currentStaff.registrationVersion, staffMemberId: chosen.id })}>
                  {currentStaff.registered ? "Remove station access" : "Register for stations"}</button>
                {currentStaff.canIssueStationOnlySetup && <button className="btn btn-outline btn-sm" disabled={pending || Boolean(operation)} onClick={() => currentStaff.localGrantPresent && !currentStaff.localGrantRevoked
                  ? ask({ kind: 6, expectedVersion: currentStaff.localGrantRevision ?? 0, staffMemberId: chosen.id }, `Remove check-in access for ${chosen.name}?`, currentStaff.checkOutGrantPresent && !currentStaff.checkOutGrantRevoked
                    ? "They will no longer be able to check in guests at this property. Checkout access and pending PIN setup are unchanged."
                    : "This removes their last station task at this property. Any pending PIN setup will be cancelled. Their existing PIN and staff record are unchanged.")
                  : void execute({ kind: 12, expectedVersion: currentStaff.localGrantRevision ?? 0, staffMemberId: chosen.id })}>
                  {currentStaff.localGrantPresent && !currentStaff.localGrantRevoked ? "Remove station-only check-in" : "Allow check-in without an account"}</button>}
                {currentStaff.canIssueStationOnlySetup && <button className="btn btn-outline btn-sm" disabled={pending || Boolean(operation)} onClick={() => currentStaff.checkOutGrantPresent && !currentStaff.checkOutGrantRevoked
                  ? ask({ kind: 17, expectedVersion: currentStaff.checkOutGrantRevision ?? 0, staffMemberId: chosen.id }, `Remove checkout access for ${chosen.name}?`, currentStaff.localGrantPresent && !currentStaff.localGrantRevoked
                    ? "They will no longer be able to check out guests at this property. Check-in access and pending PIN setup are unchanged."
                    : "This removes their last station task at this property. Any pending PIN setup will be cancelled. Their existing PIN and staff record are unchanged.")
                  : void execute({ kind: 16, expectedVersion: currentStaff.checkOutGrantRevision ?? 0, staffMemberId: chosen.id })}>
                  {currentStaff.checkOutGrantPresent && !currentStaff.checkOutGrantRevoked ? "Remove station-only checkout" : "Allow checkout without an account"}</button>}
                {rootManager && currentStaff.pinRevision > 0 && <button className="btn btn-outline btn-sm" disabled={pending || Boolean(operation)} onClick={() => ask({ kind: 5, expectedVersion: currentStaff.pinRevision, staffMemberId: chosen.id }, `Reset ${chosen.name}’s PIN?`, "Their old PIN will stop working and their station sessions across this workspace will lock. They will need to create a new PIN before working at a station again.")}>Reset PIN and lock sessions</button>}
              </div>
              <p className="text-sm leading-6 text-base-content/65">Linked staff use their existing check-in and checkout permissions separately. These extra grants apply only to staff without accounts. Removing station registration or resetting a PIN locks affected sessions; removing one task does not grant or remove another.</p>
            </div>)}
      </FormSection>
      <FormSection title="2. Prepare this browser" description="This browser will be tied to the selected property. Finish by signing out your personal account.">
        <label className="mb-4 flex items-start gap-3 text-sm leading-6"><input className="checkbox checkbox-sm mt-1" type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />
          I’m on the shared device and ready to sign out before staff use it.</label>
        <form className="flex flex-wrap items-end gap-3" onSubmit={create}>
          <label className="min-w-0 flex-1 text-sm font-medium">Station name<input name="label" className="input input-bordered mt-2 w-full" required maxLength={100} placeholder="For example, Reception desk" /></label>
          <button className="btn btn-primary" disabled={!accepted || !usable || pending || Boolean(operation)}>Create and prepare</button>
        </form>
        <div className="mt-5 divide-y divide-base-300">
          {stations.isLoading ? <p className="py-3 text-sm">Loading stations…</p> : stations.data?.items?.filter(item => !item.revoked).map(item => <div key={item.stationId} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{item.label}</span>
            <button className="btn btn-outline btn-sm" disabled={!accepted || !usable || pending || Boolean(operation)} onClick={() => void execute({ kind: 9, expectedVersion: item.version, stationId: item.stationId })}>Prepare this browser</button>
            <button className="btn btn-ghost btn-sm text-error" disabled={!usable || pending || Boolean(operation)} onClick={() => ask({ kind: 7, expectedVersion: item.version, stationId: item.stationId }, `Unpair ${item.label}?`, "Every browser paired with this station will lose access immediately. Staff will need a manager to prepare a station again. Reservation history is kept.")}>Unpair station</button>
          </div>)}
        </div>
        {(page > 1 || stations.data?.hasMore) && <div className="mt-3 flex flex-wrap gap-3">
          <button className="btn btn-outline btn-sm" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous stations</button>
          <button className="btn btn-outline btn-sm" disabled={!stations.data?.hasMore} onClick={() => setPage(page + 1)}>Next stations</button>
        </div>}
      </FormSection>
    </>}
    <FormSection title="Using your own PIN" icon={<KeyRound size={18} />}>
      <p className="text-sm leading-6">Set or change your linked staff PIN in <a className="link" href={applicationUrl("/account?section=security")}>Account → Security</a>. Recover a forgotten linked PIN with a new multi-factor sign-in. Never ask another staff member to share theirs.</p>
    </FormSection>
  </div>;
}
