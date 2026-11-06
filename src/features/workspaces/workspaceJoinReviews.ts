import type {
  WorkspaceStaffOnboarding,
  WorkspaceStaffOnboardingSummary,
  WorkspaceStaffOnboardingSummaryListResponse,
  WorkspaceStaffOnboardingRecoveryAttempt,
} from "../../api/types";
import { ApiError } from "../../api/client";

export const JOIN_REQUEST_PAGE_SIZE = 25;
const REVIEW_CONCURRENCY = 4;
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
export type WorkspaceJoinReviewPage = WorkspaceStaffOnboardingSummaryListResponse & {
  reviews: Record<string, WorkspaceStaffOnboarding | undefined>;
  reviewErrors: Record<string, string | undefined>;
  receipts: Record<string, WorkspaceStaffOnboardingRecoveryAttempt | undefined>;
  receiptErrors: Record<string, string | undefined>;
};

export function workspaceJoinReviewMatches(
  summary: WorkspaceStaffOnboardingSummary,
  review: WorkspaceStaffOnboarding,
): boolean {
  return !summary.hasStaffTarget && review.staffMemberId === null &&
    Boolean(review.subjectId && (review.displayName || review.verifiedAccountEmail)) &&
    review.applicationId === summary.applicationId &&
    review.sourceKind === summary.sourceKind && review.sourceId === summary.sourceId &&
    review.claimId === summary.claimId && review.claimVersion === summary.claimVersion &&
    review.status === summary.status && review.version === summary.version;
}

// A fresh page always obtains fresh reviews, even when the local version did not
// change: Staff can commit ownership before the Workspaces continuation arrives.
export async function loadWorkspaceJoinReviews(
  request: Request,
  page: number,
  signal: AbortSignal,
): Promise<WorkspaceJoinReviewPage> {
  const summary = await request<WorkspaceStaffOnboardingSummaryListResponse>(
    `/api/workspace-staff-enrollment/applications/summary?page=${page}&pageSize=${JOIN_REQUEST_PAGE_SIZE}`,
    { signal },
  );
  if (summary.items.length > JOIN_REQUEST_PAGE_SIZE ||
    new Set(summary.items.map(item => item.applicationId)).size !== summary.items.length) {
    throw new Error("Refresh the join requests before reviewing applicants.");
  }
  const result: WorkspaceJoinReviewPage = { ...summary, reviews: {}, reviewErrors: {}, receipts: {}, receiptErrors: {} };
  let next = 0;
  let authorityLost = false;
  await Promise.all(Array.from({ length: Math.min(REVIEW_CONCURRENCY, summary.items.length) }, async () => {
    while (!authorityLost && next < summary.items.length) {
      signal.throwIfAborted();
      const item = summary.items[next++];
      const path = `/api/workspace-staff-enrollment/applications/${item.applicationId}`;
      if (!item.hasStaffTarget) {
        try {
          const review = await request<WorkspaceStaffOnboarding>(`${path}/review`, { signal });
          signal.throwIfAborted();
          if (workspaceJoinReviewMatches(item, review)) result.reviews[item.applicationId] = review;
          else result.reviewErrors[item.applicationId] = "This request changed. Refresh before reviewing it.";
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
            authorityLost = true;
            throw error;
          }
          result.reviewErrors[item.applicationId] = "Applicant details are unavailable. Refresh before reviewing this request.";
        }
      }
      if (item.status === 6 && !result.reviews[item.applicationId]) {
        try {
          const receipt = await request<WorkspaceStaffOnboardingRecoveryAttempt>(`${path}/recovery-attempts/latest`, { signal });
          signal.throwIfAborted();
          if (receipt.applicationId === item.applicationId) result.receipts[item.applicationId] = receipt;
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
            authorityLost = true;
            throw error;
          }
          if (!(error instanceof ApiError && error.status === 404)) {
            result.receiptErrors[item.applicationId] = "Recovery status is unavailable. Refresh before retrying setup.";
          }
          // An absent receipt is normal. A write must still pass the server's
          // feature gate, authority and idempotency checks; never use /retry.
        }
      }
    }
  }));
  return result;
}

type RecoveryIntent = { operationId: string; expectedApplicationVersion: number };
type RecoveryOperation = { intent: RecoveryIntent; receipt?: WorkspaceStaffOnboardingRecoveryAttempt; retryAt?: number };

// Owned by one mounted account/session/workspace boundary, memory only. A lost
// response retains the exact operation and expected version for an explicit retry.
export class WorkspaceJoinRecoveryOperations {
  private readonly operations = new Map<string, RecoveryOperation>();

  begin(
    application: WorkspaceStaffOnboardingSummary,
    latest?: WorkspaceStaffOnboardingRecoveryAttempt,
    now = Date.now(),
  ): RecoveryIntent {
    if (application.status !== 6 || !Number.isSafeInteger(application.version) || application.version < 1) {
      throw new Error("Refresh this request before retrying setup.");
    }
    const previous = this.operations.get(application.applicationId);
    if (previous && !previous.receipt) return previous.intent;
    const receipt = previous?.receipt ?? latest;
    if (receipt) {
      if (receipt.applicationId !== application.applicationId || application.version < receipt.applicationVersion) {
        throw new Error("Refresh setup recovery before continuing.");
      }
      if (receipt.retryDirective === 1) {
        const seconds = receipt.retryAfterSeconds;
        if (!Number.isSafeInteger(seconds) || seconds === null || seconds < 1 ||
          !Number.isFinite(Date.parse(receipt.recordedAtUtc))) {
          throw new Error("Refresh setup recovery before continuing.");
        }
        const retryAt = previous?.retryAt ?? Date.parse(receipt.recordedAtUtc) + seconds * 1_000;
        if (now < retryAt) throw new Error("Setup is still being checked. Wait a few seconds before retrying.");
      } else if (application.version <= receipt.applicationVersion) {
        throw new Error(receipt.outcome === 2
          ? "Setup needs an administrator's review before it can continue."
          : "Refresh this request to see its latest setup status.");
      }
    }
    const intent = { operationId: crypto.randomUUID(), expectedApplicationVersion: application.version };
    this.operations.set(application.applicationId, { intent });
    return intent;
  }

  record(applicationId: string, receipt: WorkspaceStaffOnboardingRecoveryAttempt, now = Date.now()): void {
    const operation = this.operations.get(applicationId);
    if (!operation || receipt.applicationId !== applicationId || receipt.operationId !== operation.intent.operationId) {
      throw new Error("The setup response did not match this request. Refresh before continuing.");
    }
    this.operations.set(applicationId, {
      ...operation,
      receipt,
      retryAt: receipt.retryDirective === 1 && receipt.retryAfterSeconds !== null
        ? now + receipt.retryAfterSeconds * 1_000 : undefined,
    });
  }

  receipt(applicationId: string): WorkspaceStaffOnboardingRecoveryAttempt | undefined {
    return this.operations.get(applicationId)?.receipt;
  }
}

export async function attemptWorkspaceJoinRecovery(
  request: Request,
  operations: WorkspaceJoinRecoveryOperations,
  application: WorkspaceStaffOnboardingSummary,
  latest?: WorkspaceStaffOnboardingRecoveryAttempt,
): Promise<WorkspaceStaffOnboardingRecoveryAttempt> {
  const intent = operations.begin(application, latest);
  try {
    const receipt = await request<WorkspaceStaffOnboardingRecoveryAttempt>(
      `/api/workspace-staff-enrollment/applications/${application.applicationId}/recovery-attempts`,
      { method: "POST", body: JSON.stringify(intent) },
    );
    operations.record(application.applicationId, receipt);
    return receipt;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new Error("Setup recovery is unavailable. Ask your administrator to review this request.", { cause: error });
    }
    throw error;
  }
}
