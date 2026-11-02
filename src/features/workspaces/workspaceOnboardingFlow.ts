import { ApiError } from "../../api/client";
import type { OrganizationMembershipSummary } from "../../api/types";
import { completeCurrentStaffProfile, type StaffProfileDraft } from "./staffOnboarding";
import { waitForWorkspaceAccess } from "./workspaceAccess";
import type { WorkspaceCreationAttempt } from "./workspaceCreationAttempt";

type ApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

export type WorkspaceOnboardingContinuation = {
  request: ApiRequest;
  workspaceId: string;
  staffProfile: StaffProfileDraft;
  selectWorkspace: (workspaceId: string) => void;
  refetchWorkspaces: () => Promise<void>;
  setSelectedWorkspaceId: (workspaceId: string) => void;
  clearCreationAttempt: () => Promise<void>;
};

export type WorkspaceOnboardingContinuationServices = {
  waitForAccess?: typeof waitForWorkspaceAccess;
  completeStaffProfile?: typeof completeCurrentStaffProfile;
};

/**
 * The create operation id is also the organization id. A persisted attempt can
 * therefore reconcile an acknowledged create after a same-tab page reload,
 * without storing the workspace name or slug in browser storage.
 */
export async function recoverCreatedWorkspace(
  request: ApiRequest,
  attempt: WorkspaceCreationAttempt,
): Promise<OrganizationMembershipSummary | null> {
  try {
    const workspace = await request<OrganizationMembershipSummary>(
      `/api/organizations/${encodeURIComponent(attempt.operationId)}`,
    );
    if (
      workspace.organization.organizationId.toLowerCase() !==
      attempt.operationId.toLowerCase()
    ) {
      throw new Error(
        "The recovered workspace did not match the pending creation attempt.",
      );
    }
    return workspace;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The creation marker is deliberately cleared last. Every earlier step is
 * safe to resume after a same-tab reload using the persisted operation id.
 */
export async function continueWorkspaceOnboarding(
  continuation: WorkspaceOnboardingContinuation,
  services: WorkspaceOnboardingContinuationServices = {},
): Promise<void> {
  const waitForAccess = services.waitForAccess ?? waitForWorkspaceAccess;
  const completeStaffProfile =
    services.completeStaffProfile ?? completeCurrentStaffProfile;

  continuation.selectWorkspace(continuation.workspaceId);
  await waitForAccess(continuation.request, continuation.workspaceId);
  await continuation.refetchWorkspaces();
  continuation.setSelectedWorkspaceId(continuation.workspaceId);
  await completeStaffProfile(continuation.request, continuation.staffProfile);
  await continuation.clearCreationAttempt();
}
