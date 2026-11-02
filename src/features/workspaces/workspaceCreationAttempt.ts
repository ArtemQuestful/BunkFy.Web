import {
  clearOrganizationOperationAttempt,
  readOrganizationOperationAttempt,
  resolveOrganizationOperationAttempt,
  type OrganizationOperationAttempt,
  type OrganizationOperationAttemptOptions,
  type OrganizationOperationScope,
} from "./organizationOperationAttempt";

export type WorkspaceCreationPayload = {
  name: string;
  slug: string;
};

export type WorkspaceCreationAttempt = OrganizationOperationAttempt;

export async function resolveWorkspaceCreationAttempt(
  current: WorkspaceCreationAttempt | null,
  accountId: string,
  payload: WorkspaceCreationPayload,
  options: OrganizationOperationAttemptOptions = {},
): Promise<WorkspaceCreationAttempt> {
  return resolveOrganizationOperationAttempt(
    current,
    workspaceCreationScope(accountId),
    [workspaceCreationFingerprint(payload)],
    options,
  );
}

export async function clearWorkspaceCreationAttempt(
  accountId: string,
  storage?: Pick<Storage, "removeItem">,
  assertCurrent?: () => void,
): Promise<void> {
  return clearOrganizationOperationAttempt(
    workspaceCreationScope(accountId),
    storage,
    assertCurrent,
  );
}

export async function readWorkspaceCreationAttempt(
  accountId: string,
  storage?: Parameters<typeof readOrganizationOperationAttempt>[1],
): Promise<WorkspaceCreationAttempt | null> {
  return readOrganizationOperationAttempt(
    workspaceCreationScope(accountId),
    storage,
  );
}

export function workspaceCreationFingerprint(
  payload: WorkspaceCreationPayload,
): string {
  return JSON.stringify({
    name: payload.name.trim(),
    slug: payload.slug.trim().toLowerCase(),
  });
}

function workspaceCreationScope(accountId: string): OrganizationOperationScope {
  return {
    accountId,
    workspaceId: "new-workspace",
    action: "create-workspace",
  };
}
