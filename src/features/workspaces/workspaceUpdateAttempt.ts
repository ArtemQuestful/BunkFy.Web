import {
  clearOrganizationOperationAttempt,
  resolveOrganizationOperationAttempt,
  type OrganizationOperationAttempt,
  type OrganizationOperationAttemptOptions,
  type OrganizationOperationScope,
} from "./organizationOperationAttempt";

export type WorkspaceUpdatePayload = {
  organizationId: string;
  expectedVersion: number;
  name: string;
  slug: string;
};

export type WorkspaceUpdateAttempt = OrganizationOperationAttempt;

export async function resolveWorkspaceUpdateAttempt(
  current: WorkspaceUpdateAttempt | null,
  accountId: string,
  payload: WorkspaceUpdatePayload,
  options: OrganizationOperationAttemptOptions = {},
): Promise<WorkspaceUpdateAttempt> {
  return resolveOrganizationOperationAttempt(
    current,
    workspaceUpdateScope(accountId, payload.organizationId),
    [workspaceUpdateFingerprint(payload)],
    options,
  );
}

export async function clearWorkspaceUpdateAttempt(
  accountId: string,
  workspaceId: string,
  storage?: Pick<Storage, "removeItem">,
  assertCurrent?: () => void,
): Promise<void> {
  return clearOrganizationOperationAttempt(
    workspaceUpdateScope(accountId, workspaceId),
    storage,
    assertCurrent,
  );
}

export function workspaceUpdateFingerprint(
  payload: WorkspaceUpdatePayload,
): string {
  return JSON.stringify({
    organizationId: payload.organizationId,
    expectedVersion: payload.expectedVersion,
    name: payload.name.trim(),
    slug: payload.slug.trim().toLowerCase(),
  });
}

function workspaceUpdateScope(
  accountId: string,
  workspaceId: string,
): OrganizationOperationScope {
  return {
    accountId,
    workspaceId,
    action: "update-workspace",
  };
}
