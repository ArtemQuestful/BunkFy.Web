import { applicationUrl } from "../../app/deploymentBase";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  Clock3,
  Link2,
  LogOut,
  MailCheck,
  ShieldCheck,
  UserRound,
  XCircle,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { ApiError } from "../../api/client";
import type {
  AuthenticationMethods,
  OrganizationEnrollmentOutcome,
  OrganizationEnrollmentPreview,
  OrganizationInvitationAcceptance,
  OrganizationInvitationPreview,
  WorkspaceStaffOnboarding,
} from "../../api/types";
import { useProductCapabilities } from "../../app/productCapabilities";
import { useSession } from "../../app/session";
import { useWorkspace } from "../../app/workspace";
import { StaffProfileFields } from "./StaffProfileFields";
import {
  clearInviteStaffDraft,
  readInviteStaffDraft,
  saveInviteStaffDraft,
  type StaffProfileDraft,
} from "./staffOnboarding";
import { waitForWorkspaceAccess } from "./workspaceAccess";
import { WorkspaceCatalogueNotice } from "./WorkspaceCatalogueNotice";
import {
  clearPreservedWorkspaceJoinContext,
  isWorkspaceStaffOnboardingExpired,
  isWorkspaceStaffOnboardingInProgress,
  isWorkspaceStaffOnboardingTerminallyDenied,
  isWorkspaceStaffOnboardingWithdrawn,
  readPreservedWorkspaceJoinContext,
  resolveEnrollmentJoin,
  workspaceJoinContextPath,
  workspaceJoinContextHeaders,
  workspaceJoinVerificationCopy,
  workspaceJoinSourceKind,
  type WorkspaceJoinContext,
  type WorkspaceJoinResolution,
} from "./workspaceJoin";
import {
  forgetPendingEnrollment,
  hasPendingEnrollment,
  rememberPendingEnrollment,
} from "./workspaceJoinPending";

export function JoinWorkspacePage() {
  const navigate = useNavigate();
  const { captureRequestContext, logout, request, selectWorkspace, session } = useSession();
  const {
    ensureWorkspaceVisible,
    setSelectedWorkspaceId,
    workspaces,
  } = useWorkspace();
  // Keep public metadata for the active page's terminal result after durable
  // recovery and its protected cookie are cleared. No reusable token is held.
  const [secret] = useState<WorkspaceJoinContext | null>(readPreservedWorkspaceJoinContext);
  const secretKey = secret ? `${secret.kind}:${secret.contextId}` : "missing";
  const accountKey = session?.subjectId ?? "";
  const subjectId = session?.subjectId;
  const activationController = useRef<AbortController | null>(null);
  const activeJoinPage = useRef(false);
  useLayoutEffect(() => {
    activeJoinPage.current = true;
    return () => {
      activeJoinPage.current = false;
      activationController.current?.abort();
    };
  }, []);
  const isEnrollment = secret?.kind === "enrollment";
  const [staffDraft, setStaffDraft] = useState(() => ({
    subjectId: accountKey,
    profile: readInviteStaffDraft(accountKey, session?.username),
  }));
  const ownerDraft = useMemo(
    () => readInviteStaffDraft(accountKey, session?.username),
    [accountKey, session?.username],
  );
  // Hide the previous actor's form during render, before effects can reset it.
  const staffProfile = staffDraft.subjectId === accountKey
    ? staffDraft.profile
    : ownerDraft;
  const [pendingApproval, setPendingApproval] = useState(false);
  const [withdrawalConfirmation, setWithdrawalConfirmation] = useState(false);
  const [withdrawalResolution, setWithdrawalResolution] = useState<
    "withdrawn" | "expired" | null
  >(null);
  const preview = useQuery<
    OrganizationInvitationPreview | OrganizationEnrollmentPreview
  >({
    queryKey: ["workspace-join-preview", secret?.kind, secret?.contextId],
    queryFn: () => {
      if (!secret) throw new Error("This invitation link is incomplete.");
      return request<OrganizationInvitationPreview | OrganizationEnrollmentPreview>(
        workspaceJoinContextPath(secret) + "/preview",
        { method: "POST", headers: workspaceJoinContextHeaders(secret) },
      );
    },
    enabled: Boolean(secret),
    retry: false,
  });
  const data = preview.data;
  const recipientBound = secret?.kind === "invitation" &&
    (data as OrganizationInvitationPreview | undefined)?.recipientBound === true;
  const sourceId = data && secret
    ? secret.kind === "invitation"
      ? (data as OrganizationInvitationPreview).invitationId
      : (data as OrganizationEnrollmentPreview).enrollmentLinkId
    : null;
  const pendingSourceId = isEnrollment ? sourceId : null;
  const staffApplication = useQuery<WorkspaceStaffOnboarding>({
    queryKey: [
      "workspace-staff-onboarding",
      data?.organizationId,
      secret?.kind,
      sourceId,
      subjectId,
      accountKey,
    ],
    queryFn: () => request<WorkspaceStaffOnboarding>(
      `/api/workspace-staff-enrollment/${data?.organizationId}/applications/current` +
        `?sourceKind=${workspaceJoinSourceKind(secret!.kind)}&sourceId=${sourceId}`,
    ),
    enabled: Boolean(isEnrollment && data?.organizationId && sourceId),
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (pendingApproval || isWorkspaceStaffOnboardingInProgress(status)) return 15_000;
      return status === 6 ? 30_000 : false;
    },
    refetchIntervalInBackground: false,
  });
  const workspaceActivation = useMutation({
    mutationFn: async (workspaceId: string) => {
      await activateWorkspace(workspaceId);
      return workspaceId;
    },
    onSuccess: () => {
      if (!activeJoinPage.current) return;
      forgetPendingEnrollment(pendingSourceId, subjectId);
      setPendingApproval(false);
      clearPreservedWorkspaceJoinContext(secret);
      window.history.replaceState(null, "", applicationUrl("/"));
      navigate("/", { replace: true });
    },
  });
  const join = useMutation<WorkspaceJoinResolution>({
    mutationFn: async () => {
      if (!secret) throw new Error("This invitation link is incomplete.");
      const context = captureRequestContext();
      const assertJoinCurrent = () => {
        context.assertCurrent();
        if (!activeJoinPage.current) throw new Error("This invitation page has been closed.");
      };

      try {
        await context.request<WorkspaceStaffOnboarding>(
          workspaceJoinContextPath(secret) + "/applications",
          {
            method: "POST",
            headers: workspaceJoinContextHeaders(secret),
            body: JSON.stringify({
              displayName: staffProfile.displayName.trim(),
              legalName: emptyToNull(staffProfile.legalName),
              workEmail: emptyToNull(staffProfile.workEmail),
              workPhone: emptyToNull(staffProfile.workPhone),
              employeeNumber: null,
              jobTitle: emptyToNull(staffProfile.jobTitle),
              department: emptyToNull(staffProfile.department),
            }),
          },
        );
      } catch (error) {
        assertJoinCurrent();
        if (
          secret.kind !== "invitation" ||
          !(error instanceof ApiError) ||
          error.status !== 409 ||
          error.code !== "Workspaces.StaffOnboardingProfileMutationAuthorityUnavailable" ||
          !data?.organizationId || !sourceId || !subjectId
        ) throw error;

        // Staff owns a completed profile. Read only the applicant's current
        // status, then let the protected invitation endpoint revalidate replay.
        const application = await context.request<WorkspaceStaffOnboarding>(
          `/api/workspace-staff-enrollment/${encodeURIComponent(data.organizationId)}/applications/current` +
            `?sourceKind=1&sourceId=${encodeURIComponent(sourceId)}`,
        );
        assertJoinCurrent();
        if (
          application.status !== 5 || !application.applicationId || !application.staffMemberId ||
          application.organizationId !== data.organizationId || application.sourceKind !== 1 ||
          application.sourceId !== sourceId || application.subjectId !== subjectId
        ) throw error;
      }
      assertJoinCurrent();

      if (secret.kind === "invitation") {
        const acceptance = await context.request<OrganizationInvitationAcceptance>(
          workspaceJoinContextPath(secret) + "/join",
          { method: "POST", headers: workspaceJoinContextHeaders(secret) },
        );
        const workspaceId = acceptance.membership.organization.organizationId;
        return { kind: "joined", workspaceId };
      }

      const outcome = await context.request<OrganizationEnrollmentOutcome>(
        workspaceJoinContextPath(secret) + "/join",
        { method: "POST", headers: workspaceJoinContextHeaders(secret) },
      );
      const resolution = resolveEnrollmentJoin(outcome);
      return resolution;
    },
    onSuccess: (resolution) => {
      if (!activeJoinPage.current) return;
      if (resolution.kind === "pending-approval") {
        rememberPendingEnrollment(pendingSourceId, subjectId);
        setPendingApproval(true);
        void staffApplication.refetch();
        return;
      }

      workspaceActivation.mutate(resolution.workspaceId);
    },
    onError: (error) => {
      if (!activeJoinPage.current) return;
      if (
        error instanceof ApiError &&
        error.code === "Organizations.EnrollmentClaimUnavailable"
      ) {
        forgetPendingEnrollment(pendingSourceId, subjectId);
        setPendingApproval(false);
      }
    },
  });
  const withdraw = useMutation<OrganizationEnrollmentOutcome>({
    mutationFn: async () => {
      const application = staffApplication.data;
      if (
        !application?.claimId ||
        !application.claimVersion ||
        application.status !== 2
      ) {
        throw new Error("This access request is no longer awaiting approval.");
      }

      const outcome = await request<OrganizationEnrollmentOutcome>(
        `/api/organization-enrollment/${encodeURIComponent(application.organizationId)}` +
          `/join-requests/${encodeURIComponent(application.claimId)}/withdraw`,
        {
          method: "POST",
          body: JSON.stringify({ expectedVersion: application.claimVersion }),
        },
      );
      const status = outcome.claim.status;
      if (status !== "withdrawn" && status !== "expired") {
        throw new Error("The access request changed while it was being withdrawn.");
      }
      return outcome;
    },
    onSuccess: (outcome) => {
      if (!activeJoinPage.current) return;
      forgetPendingEnrollment(pendingSourceId, subjectId);
      setPendingApproval(false);
      setWithdrawalConfirmation(false);
      setWithdrawalResolution(
        outcome.claim.status === "expired" ? "expired" : "withdrawn",
      );
      clearPreservedWorkspaceJoinContext(secret);
      window.history.replaceState(null, "", applicationUrl("/join"));
      void staffApplication.refetch();
    },
    onError: () => {
      if (!activeJoinPage.current) return;
      void staffApplication.refetch();
    },
  });
  const resetJoin = join.reset;
  const resetWorkspaceActivation = workspaceActivation.reset;
  const resetWithdraw = withdraw.reset;

  // The protected context identifies an invitation's source. Activating its
  // workspace evicts scoped preview data; that temporary gap must not cancel
  // this page's own activation. Actor, session and context changes still reset.
  useEffect(() => {
    activationController.current?.abort();
    setPendingApproval(hasPendingEnrollment(pendingSourceId, subjectId));
    resetJoin();
    resetWorkspaceActivation();
    resetWithdraw();
    setWithdrawalConfirmation(false);
    setWithdrawalResolution(null);
    return () => { activationController.current?.abort(); };
  }, [
    accountKey,
    subjectId,
    pendingSourceId,
    session?.sessionId,
    resetWorkspaceActivation,
    resetJoin,
    resetWithdraw,
    secret?.kind,
    secret?.contextId,
    secretKey,
  ]);

  useEffect(() => {
    const application = staffApplication.data;
    if (!application) return;

    if (withdrawalResolution) return;

    if (isWorkspaceStaffOnboardingWithdrawn(application.status)) {
      forgetPendingEnrollment(pendingSourceId, subjectId);
      setPendingApproval(false);
      setWithdrawalResolution("withdrawn");
      clearPreservedWorkspaceJoinContext(secret);
      window.history.replaceState(null, "", applicationUrl("/join"));
      return;
    }

    if (isWorkspaceStaffOnboardingExpired(application.status)) {
      forgetPendingEnrollment(pendingSourceId, subjectId);
      setPendingApproval(false);
      setWithdrawalResolution("expired");
      clearPreservedWorkspaceJoinContext(secret);
      window.history.replaceState(null, "", applicationUrl("/join"));
      return;
    }

    if (isWorkspaceStaffOnboardingInProgress(application.status)) {
      setPendingApproval(true);
      return;
    }

    if (isWorkspaceStaffOnboardingTerminallyDenied(application.status)) {
      forgetPendingEnrollment(pendingSourceId, subjectId);
      setPendingApproval(false);
      clearPreservedWorkspaceJoinContext(secret);
      return;
    }

    if (application.status === 6) {
      setPendingApproval(false);
      return;
    }

    if (
      application.status === 5 &&
      workspaceActivation.isIdle
    ) {
      workspaceActivation.mutate(application.organizationId);
    }
  }, [
    subjectId,
    pendingSourceId,
    workspaceActivation,
    secret?.contextId,
    staffApplication.data,
    withdrawalResolution,
  ]);

  async function activateWorkspace(workspaceId: string) {
    // The catalogue may briefly lag provisioning. Keep the current scope until
    // it contains the approved membership, then update selection and session
    // together so catalogue reconciliation cannot restore the old workspace.
    activationController.current?.abort();
    const controller = new AbortController();
    activationController.current = controller;
    try {
      await ensureWorkspaceVisible(workspaceId, controller.signal);
      controller.signal.throwIfAborted();
      setSelectedWorkspaceId(workspaceId);
      await waitForWorkspaceAccess(request, workspaceId, { signal: controller.signal });
      controller.signal.throwIfAborted();
      clearInviteStaffDraft(accountKey);
    } finally {
      if (activationController.current === controller) activationController.current = null;
    }
  }

  const alreadyJoined =
    join.error instanceof ApiError &&
    join.error.code === "Organizations.MembershipConflict";
  const verificationRequired =
    join.error instanceof ApiError &&
    (join.error.code === "Organizations.RecipientVerificationRequired" ||
      join.error.code === "Workspaces.VerifiedIdentityRequired");
  const requestRejected =
    (join.error instanceof ApiError &&
      join.error.code === "Organizations.EnrollmentClaimUnavailable") ||
    isWorkspaceStaffOnboardingTerminallyDenied(staffApplication.data?.status);
  const provisioningFailed = staffApplication.data?.status === 6;
  const accessApproved = staffApplication.data?.status === 5;
  const openingWorkspace = accessApproved ||
    workspaceActivation.isPending ||
    workspaceActivation.isError;
  const showAccessProgress = pendingApproval || openingWorkspace;
  const canWithdraw =
    isEnrollment &&
    pendingApproval &&
    staffApplication.data?.status === 2 &&
    Boolean(staffApplication.data.claimId) &&
    Boolean(staffApplication.data.claimVersion);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (showAccessProgress || requestRejected || withdrawalResolution) return;
    join.mutate();
  }

  function updateStaffProfile(profile: StaffProfileDraft) {
    setStaffDraft({ subjectId: accountKey, profile });
    saveInviteStaffDraft(profile, accountKey);
  }

  function openWorkspace() {
    const workspaceId = data?.organizationId;
    if (
      workspaceId &&
      workspaces.some(
        (item) => item.organization.organizationId === workspaceId,
      )
    ) {
      selectWorkspace(workspaceId);
      setSelectedWorkspaceId(workspaceId);
    }
    clearPreservedWorkspaceJoinContext(secret);
    navigate("/", { replace: true });
  }

  function leaveJoin() {
    clearPreservedWorkspaceJoinContext(secret);
    navigate("/", { replace: true });
  }

  return (
    <main className="min-h-screen bg-base-200 p-4 sm:p-8">
      <section className="mx-auto w-full max-w-2xl rounded-lg border border-base-300 bg-base-100 p-6 shadow-sm sm:p-10">
        <div className="flex items-center justify-between gap-3">
          <button
            className="btn btn-circle btn-ghost btn-sm"
            onClick={leaveJoin}
            aria-label="Back to BunkFy"
          >
            <ArrowLeft size={19} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void logout()}
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
        <WorkspaceCatalogueNotice
          className="mt-5"
          title="Your existing workspace list is delayed"
        />
        <div className="mt-6 flex items-center gap-3 text-primary">
          {data ? <Building2 size={26} /> : <Link2 size={26} />}
          <p className="text-xs font-bold uppercase">
            {isEnrollment ? "Team access" : "Workspace invitation"}
          </p>
        </div>
        <h1 className="mt-4 font-display text-3xl font-semibold">
          {data ? `Join ${data.organizationName}` : "Open an invitation"}
        </h1>

        {!secret && (
          <p className="mt-4 text-sm leading-6 text-base-content/60">
            Open the complete link or scan the QR code provided by your
            workspace owner.
          </p>
        )}
        {preview.isLoading && (
          <div className="mt-8 flex items-center gap-3 text-sm text-base-content/60">
            <span className="loading loading-spinner loading-sm" />
            Checking the invitation
          </div>
        )}
        {preview.error && (
          <div className="alert alert-error mt-6 text-sm">
            {preview.error instanceof Error
              ? preview.error.message
              : "The invitation is unavailable."}
          </div>
        )}
        {data && (
          <form className="mt-6" onSubmit={submit}>
            <div className="border-y border-base-300 py-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-display text-lg font-semibold">{data.organizationName}</p>
                  <p className="mt-1 text-sm text-base-content/50">{data.organizationSlug}</p>
                </div>
                <span className="badge badge-outline shrink-0">
                  {isEnrollment ? "Team QR" : "Single-use invite"}
                </span>
              </div>
              <dl className="mt-5 divide-y divide-base-300/70 border-t border-base-300/70">
                <JoinContextRow
                  icon={<UserRound size={16} />}
                  label="Signing in as"
                  value={session?.username ?? "Current account"}
                />
                <JoinContextRow
                  icon={<ShieldCheck size={16} />}
                  label="Approval"
                  value={joinApprovalLabel(secret, data)}
                />
                <JoinContextRow
                  icon={<Link2 size={16} />}
                  label="Access"
                  value="Role and property scope set by the workspace owner"
                />
              </dl>
              <p className="mt-4 text-xs leading-5 text-base-content/45">
                {recipientBound
                  ? "This invitation can only be accepted by the verified invited account. "
                  : "This link carries a fixed access plan and cannot be broadened while joining. "}
                It expires {new Date(data.expiresAtUtc).toLocaleString()}.
              </p>
            </div>
            {!withdrawalResolution && !showAccessProgress && (
              <div className="py-6">
                <h2 className="font-display text-xl font-semibold">
                  Your staff profile
                </h2>
                <p className="mb-5 mt-1 text-sm leading-6 text-base-content/50">
                  Review the contact details your team will see after you join.
                </p>
                <StaffProfileFields
                  value={staffProfile}
                  onChange={updateStaffProfile}
                />
              </div>
            )}

            {withdrawalResolution && (
              <div
                className={`rounded-lg border p-5 ${
                  withdrawalResolution === "withdrawn"
                    ? "border-success/25 bg-success/8"
                    : "border-warning/30 bg-warning/8"
                }`}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`grid size-10 shrink-0 place-items-center rounded-lg ${
                      withdrawalResolution === "withdrawn"
                        ? "bg-success/12 text-success"
                        : "bg-warning/12 text-warning"
                    }`}
                  >
                    {withdrawalResolution === "withdrawn" ? (
                      <CheckCircle2 size={19} />
                    ) : (
                      <Clock3 size={19} />
                    )}
                  </span>
                  <div>
                    <h2 className="font-display text-lg font-semibold">
                      {withdrawalResolution === "withdrawn"
                        ? "Request withdrawn"
                        : "Request expired"}
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-base-content/60">
                      {withdrawalResolution === "withdrawn"
                        ? "This request is no longer waiting for approval. BunkFy is clearing the staged staff profile as the update is processed."
                        : "The approval window ended before withdrawal completed. Ask the workspace owner for a new team link if you still need access."}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {showAccessProgress && (
              <div className="rounded-lg border border-info/25 bg-info/8 p-5">
                <div className="flex items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-info/12 text-info">
                    <Clock3 size={19} />
                  </span>
                  <div>
                    <h2 className="font-display text-lg font-semibold">
                      {openingWorkspace ? "Opening workspace" : "Request sent"}
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-base-content/60">
                      {openingWorkspace
                        ? "Your request was approved. BunkFy is finishing your access and will open the workspace automatically."
                        : "A workspace owner must approve this QR request. BunkFy checks periodically while this page is open."}
                    </p>
                  </div>
                </div>
                {!openingWorkspace && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => void staffApplication.refetch()}
                      disabled={staffApplication.isFetching}
                    >
                      {staffApplication.isFetching && (
                        <span className="loading loading-spinner loading-xs" />
                      )}
                      Check approval now
                    </button>
                    {canWithdraw && !withdrawalConfirmation && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm text-error"
                        onClick={() => {
                          withdraw.reset();
                          setWithdrawalConfirmation(true);
                        }}
                      >
                        <XCircle size={16} />
                        Withdraw request
                      </button>
                    )}
                  </div>
                )}
                {withdrawalConfirmation && (
                  <div className="mt-4 border-t border-info/20 pt-4">
                    <p className="text-sm font-semibold">Withdraw this request?</p>
                    <p className="mt-1 text-sm leading-6 text-base-content/60">
                      Your staged staff details will be removed. You will need a
                      new team link to request access again.
                    </p>
                    {withdraw.error && (
                      <div className="alert alert-error mt-3 text-sm">
                        {withdraw.error.message}
                      </div>
                    )}
                    <div className="mt-4 flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={withdraw.isPending}
                        onClick={() => {
                          withdraw.reset();
                          setWithdrawalConfirmation(false);
                        }}
                      >
                        Keep waiting
                      </button>
                      <button
                        type="button"
                        className="btn btn-error btn-sm"
                        disabled={withdraw.isPending}
                        onClick={() => withdraw.mutate()}
                      >
                        {withdraw.isPending ? (
                          <span className="loading loading-spinner loading-xs" />
                        ) : (
                          <XCircle size={16} />
                        )}
                        Withdraw request
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {provisioningFailed && (
              <div className="rounded-lg border border-warning/30 bg-warning/8 p-5 text-sm text-base-content">
                <p>
                  Staff access could not be finished automatically. A workspace
                  owner can retry this request from Workspace settings.
                </p>
                <button
                  type="button"
                  className="btn btn-outline btn-sm mt-4"
                  onClick={() => void staffApplication.refetch()}
                  disabled={staffApplication.isFetching}
                >
                  {staffApplication.isFetching && (
                    <span className="loading loading-spinner loading-xs" />
                  )}
                  Check status
                </button>
              </div>
            )}

            {verificationRequired && (
              <InvitationVerificationRecovery
                request={request}
                recipientBound={recipientBound}
                onVerified={() => {
                  resetJoin();
                  join.mutate();
                }}
              />
            )}
            {requestRejected && (
              <div className="alert alert-error text-sm">
                This access request is no longer available. Ask the workspace
                owner to create a new team QR.
              </div>
            )}
            {join.error &&
              !verificationRequired &&
              !requestRejected &&
              !showAccessProgress && (
                <div className="alert alert-error text-sm">
                  {alreadyJoined
                    ? "You already belong to this workspace."
                    : join.error.message}
                </div>
              )}
            {workspaceActivation.error && (
              <div className="alert alert-error items-start text-sm">
                <div>
                  <p className="font-semibold">The workspace is ready, but it could not be opened.</p>
                  <p className="mt-1">{workspaceActivation.error.message}</p>
                </div>
                {workspaceActivation.variables && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => workspaceActivation.mutate(
                      workspaceActivation.variables,
                    )}
                  >
                    Try opening workspace
                  </button>
                )}
              </div>
            )}
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={leaveJoin}
              >
                Back to BunkFy
              </button>
              {alreadyJoined ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={openWorkspace}
                >
                  Open workspace
                </button>
              ) : !showAccessProgress && !requestRejected && !withdrawalResolution ? (
                <button
                  className="btn btn-primary"
                  disabled={
                    join.isPending ||
                    workspaceActivation.isPending ||
                    !staffProfile.displayName.trim()
                  }
                >
                  {join.isPending ? (
                    <span className="loading loading-spinner loading-sm" />
                  ) : (
                    <CheckCircle2 size={18} />
                  )}
                  {isEnrollment ? "Request access" : "Join workspace"}
                </button>
              ) : null}
            </div>
          </form>
        )}
      </section>
    </main>
  );
}

type VerificationAction =
  | { kind: "send"; emailId: string }
  | { kind: "confirm"; code: string };

function InvitationVerificationRecovery({
  request,
  recipientBound,
  onVerified,
}: {
  request: ReturnType<typeof useSession>["request"];
  recipientBound: boolean;
  onVerified: () => void;
}) {
  const { emailVerificationEnabled } = useProductCapabilities();
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const methods = useQuery({
    queryKey: ["auth", "methods", "workspace-invitation"],
    queryFn: () => request<AuthenticationMethods>("/api/auth/methods"),
    enabled: emailVerificationEnabled,
    retry: false,
  });
  const activeEmail = methods.data?.emails.find(
    (email) => email.isActive && !email.isVerified,
  );
  const copy = workspaceJoinVerificationCopy(recipientBound);
  const verification = useMutation({
    mutationFn: (action: VerificationAction) =>
      action.kind === "send"
        ? request<void>("/api/auth/email-verification", {
            method: "POST",
            body: JSON.stringify({ emailId: action.emailId }),
          })
        : request<void>("/api/auth/email-verification/confirm", {
            method: "POST",
            body: JSON.stringify({ code: action.code }),
          }),
    onSuccess: async (_result, action) => {
      if (action.kind === "send") {
        setCodeSent(true);
        return;
      }
      await methods.refetch();
      onVerified();
    },
  });

  if (!emailVerificationEnabled) {
    return (
      <div className="alert border border-warning/30 bg-warning/8 text-sm text-base-content">
        <MailCheck className="text-warning" size={19} />
        <span>
          This workspace requires a verified email, but email delivery is
          disabled in this deployment. Sign in with an identity provider that
          supplies a verified email, or ask the administrator to enable email
          delivery.
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-warning/30 bg-warning/8 p-5">
      <div className="flex items-start gap-3">
        <MailCheck className="mt-0.5 shrink-0 text-warning" size={19} />
        <div>
          <h2 className="font-display text-lg font-semibold">
            {copy.title}
          </h2>
          <p className="mt-1 text-sm leading-6 text-base-content/60">
            {copy.description}
          </p>
        </div>
      </div>

      {methods.isLoading && (
        <span className="loading loading-spinner loading-sm mt-4 text-primary" />
      )}
      {methods.error && (
        <div className="alert alert-error mt-4 text-sm">
          {methods.error.message}
        </div>
      )}
      {!methods.isLoading && !activeEmail && (
        <p className="mt-4 text-sm leading-6 text-base-content/60">
          This account has no active unverified email. Sign out and use the
          invited account, or ask the owner to issue another link.
        </p>
      )}
      {activeEmail && !codeSent && (
        <button
          type="button"
          className="btn btn-outline btn-sm mt-4 h-auto min-h-8 w-full justify-start whitespace-normal py-2 text-left leading-5 [overflow-wrap:anywhere] sm:w-auto sm:justify-center sm:text-center"
          disabled={verification.isPending}
          onClick={() =>
            verification.mutate({ kind: "send", emailId: activeEmail.id })
          }
        >
          {verification.isPending && (
            <span className="loading loading-spinner loading-xs" />
          )}
          Send code to {activeEmail.email}
        </button>
      )}
      {activeEmail && codeSent && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            className="input input-bordered flex-1 bg-base-100"
            aria-label="Verification code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Verification code"
            autoComplete="one-time-code"
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={verification.isPending || !code.trim()}
            onClick={() =>
              verification.mutate({ kind: "confirm", code: code.trim() })
            }
          >
            {verification.isPending && (
              <span className="loading loading-spinner loading-xs" />
            )}
            Verify and continue
          </button>
        </div>
      )}
      {verification.error && (
        <div className="alert alert-error mt-4 text-sm">
          {verification.error.message}
        </div>
      )}
    </div>
  );
}

function JoinContextRow({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:items-start sm:gap-4">
      <dt className="flex items-center gap-2 text-xs font-semibold uppercase text-base-content/45">
        <span className="text-primary">{icon}</span>
        {label}
      </dt>
      <dd className="break-words text-sm font-medium sm:text-right">{value}</dd>
    </div>
  );
}

function joinApprovalLabel(
  secret: WorkspaceJoinContext | null,
  preview: OrganizationInvitationPreview | OrganizationEnrollmentPreview,
): string {
  if (secret?.kind !== "enrollment") return "Immediate after account checks";
  return (preview as OrganizationEnrollmentPreview).approvalMode === "automatic"
    ? "Automatic after account checks"
    : "Workspace owner review required";
}

function emptyToNull(value: string): string | null {
  return value.trim() || null;
}
