import { useMutation, useQuery } from "@tanstack/react-query";
import { RotateCw, UserCheck, UserX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceStaffOnboardingSummary } from "../../api/types";
import {
  compositeSourceCurrent,
  compositeSourceUsable,
  createCompositeSource,
} from "../../app/compositeSourceState";
import { useSession } from "../../app/session";
import {
  CompositeSourceFallback,
  CompositeSourceNotice,
} from "../../components/ui/CompositeSourceNotice";
import { PaginationBar } from "../../components/ui/PaginationBar";
import { ErrorState } from "../../components/ui/primitives";
import { workspaceAccessActionAllowed } from "./workspaceAccessAuthority";

import {
  JOIN_REQUEST_PAGE_SIZE as PAGE_SIZE,
  WorkspaceJoinRecoveryOperations,
  attemptWorkspaceJoinRecovery,
  loadWorkspaceJoinReviews,
  workspaceJoinReviewMatches,
} from "./workspaceJoinReviews";

export function WorkspaceJoinRequestSettings({
  workspaceId,
  canGrant,
  onMembershipChanged,
}: {
  workspaceId: string;
  canGrant: boolean;
  onMembershipChanged: () => Promise<void>;
}) {
  const { request, session } = useSession();
  const identity = JSON.stringify([workspaceId, session?.tenantId, session?.subjectId, session?.sessionId, session?.generation]);
  const liveIdentity = useRef(identity);
  liveIdentity.current = identity;
  const recoveryOperations = useMemo(() => new WorkspaceJoinRecoveryOperations(), [identity]);
  const [page, setPage] = useState(1);
  const joinRequests = useQuery({
    queryKey: ["workspace-staff-onboarding", workspaceId, "actionable", identity, canGrant, page],
    queryFn: ({ signal }) => loadWorkspaceJoinReviews(request, page, signal),
    enabled: session?.tenantId === workspaceId,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  const requestSource = createCompositeSource({
    label: "Join requests",
    hasData: joinRequests.data !== undefined,
    isLoading: joinRequests.isLoading,
    error: joinRequests.error,
    isFetching: joinRequests.isFetching,
    refetch: () => joinRequests.refetch(),
  });
  const requestsUsable = compositeSourceUsable(requestSource.state);
  const requestsCurrent = compositeSourceCurrent(requestSource);
  const grantResolutionAllowed = workspaceAccessActionAllowed(
    "grant",
    canGrant,
    requestsCurrent,
  );
  const resolution = useMutation({
    mutationFn: ({ application, action, boundary }: {
      application: WorkspaceStaffOnboardingSummary;
      action: "approve" | "reject" | "retry";
      boundary: string;
    }) => {
      if (boundary !== liveIdentity.current) throw new Error("Refresh join requests after changing accounts or workspaces.");
      if (!workspaceAccessActionAllowed(
        action === "reject" ? "deny" : "grant",
        canGrant,
        requestsCurrent,
      )) {
        throw new Error("Refresh join requests and workspace authority before granting access.");
      }
      if (action === "retry") {
        const review = joinRequests.data?.reviews[application.applicationId];
        if (!application.hasStaffTarget && review) {
          if (!workspaceJoinReviewMatches(application, review)) {
            throw new Error("Refresh this request before retrying setup.");
          }
          // Preserve the established early-failure retry only after a fresh
          // exact-absence review. The server rechecks Staff ownership under
          // its mutation locks. Never downgrade a receipted recovery failure.
          return request(`/api/workspace-staff-enrollment/applications/${application.applicationId}/retry`, { method: "POST" });
        }
        const receiptError = joinRequests.data?.receiptErrors[application.applicationId];
        if (receiptError) throw new Error(receiptError);
        return attemptWorkspaceJoinRecovery(
          request, recoveryOperations, application,
          joinRequests.data?.receipts[application.applicationId],
        );
      }
      const review = joinRequests.data?.reviews[application.applicationId];
      if (!requestsCurrent || !review || !workspaceJoinReviewMatches(application, review)) {
        throw new Error("Refresh the applicant's details before reviewing this request.");
      }
      if (!application.claimId || !application.claimVersion) {
        throw new Error("This join request is still being prepared.");
      }
      return request(`/api/organizations/${workspaceId}/join-requests/${application.claimId}/${action}`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: application.claimVersion }),
      });
    },
    onSuccess: async (_result, variables) => {
      if (variables.boundary !== liveIdentity.current) return;
      await Promise.all([joinRequests.refetch(), onMembershipChanged()]);
    },
  });

  useEffect(() => {
    if (!joinRequests.isFetching && page > 1 && joinRequests.data?.items.length === 0) {
      setPage((current) => Math.max(1, current - 1));
    }
  }, [joinRequests.data?.items.length, joinRequests.isFetching, page]);

  return (
    <section className="mt-6">
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <UserCheck size={20} />
        </span>
        <div>
          <h2 className="font-display text-xl font-semibold">Join requests</h2>
          <p className="mt-1 text-sm leading-6 text-base-content/55">
            Review applicants before provisioning Staff and operational access.
          </p>
        </div>
      </div>
      <div className="mt-5">
        <CompositeSourceNotice
          sources={[requestSource]}
          title="Join requests are delayed"
        />
      </div>
      {requestsUsable ? (
        <>
          <div className="mt-5 divide-y divide-base-300 border-y border-base-300">
            {!joinRequests.data?.items.length && (
              <p className="py-8 text-center text-sm text-base-content/50">No join requests need attention.</p>
            )}
            {(joinRequests.data?.items ?? []).map((application) => {
              const review = requestsCurrent ? joinRequests.data?.reviews[application.applicationId] : undefined;
              const receipt = recoveryOperations.receipt(application.applicationId) ?? joinRequests.data?.receipts[application.applicationId];
              return <article
                key={application.applicationId}
                className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold">
                    {review?.displayName ?? review?.verifiedAccountEmail ?? (application.status === 6 ? "Staff setup needs attention" : "Applicant details unavailable")}
                  </p>
                  <p className="mt-1 truncate text-xs text-base-content/50">
                    {review?.workEmail ?? review?.verifiedAccountEmail}
                    {review?.jobTitle ? ` / ${review.jobTitle}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-base-content/45">
                    {application.status === 6 ? "Provisioning needs attention" : "Requested"}{" "}
                    {new Date(application.createdAtUtc).toLocaleString()}
                  </p>
                  {!review && !application.hasStaffTarget && (
                    <p className="mt-1 text-xs text-base-content/55">
                      {requestsCurrent ? joinRequests.data?.reviewErrors[application.applicationId] : "Refreshing applicant details…"}
                    </p>
                  )}
                  {joinRequests.data?.receiptErrors[application.applicationId] && (
                    <p className="mt-1 text-xs text-warning">{joinRequests.data.receiptErrors[application.applicationId]}</p>
                  )}
                  {receipt && (
                    <p className="mt-1 text-xs text-base-content/55">
                      {receipt.outcome === 2 ? "An administrator needs to review this setup." : receipt.retryDirective === 1 ? "Setup is still being checked. Wait a few seconds before retrying." : "Setup recovery was recorded. Refresh to see the latest status."}
                    </p>
                  )}
                  {application.failureCode && (
                    <p className="mt-1 text-xs font-medium text-warning">{application.failureCode}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {application.status === 6 ? (
                    <button
                      className="btn btn-primary btn-sm text-white"
                      onClick={() => resolution.mutate({ application, action: "retry", boundary: identity })}
                      disabled={resolution.isPending || !grantResolutionAllowed || Boolean(joinRequests.data?.receiptErrors[application.applicationId])}
                    >
                      <RotateCw size={15} />Retry setup
                    </button>
                  ) : (
                    <>
                      <button
                        className="btn btn-ghost btn-sm text-error"
                        onClick={() => resolution.mutate({ application, action: "reject", boundary: identity })}
                        disabled={resolution.isPending || !application.claimId || !review}
                      >
                        <UserX size={15} />Reject
                      </button>
                      <button
                        className="btn btn-primary btn-sm text-white"
                        onClick={() => resolution.mutate({ application, action: "approve", boundary: identity })}
                        disabled={resolution.isPending || !application.claimId || !review || !grantResolutionAllowed}
                      >
                        <UserCheck size={15} />Approve
                      </button>
                    </>
                  )}
                </div>
              </article>;
            })}
          </div>
          <PaginationBar
            page={page}
            pageSize={PAGE_SIZE}
            itemCount={joinRequests.data?.items.length ?? 0}
            itemLabel="request"
            hasMore={joinRequests.data?.hasMore}
            disabled={!requestsCurrent || resolution.isPending}
            onPageChange={setPage}
          />
          {resolution.error && <SettingsError error={resolution.error} />}
        </>
      ) : (
        <CompositeSourceFallback state={requestSource.state} label="join requests" />
      )}
    </section>
  );
}

function SettingsError({ error }: { error: unknown }) {
  return <div className="mt-5"><ErrorState error={error} /></div>;
}
