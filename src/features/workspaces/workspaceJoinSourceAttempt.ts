import type { IssueWorkspaceEnrollmentLinkRequest, WorkspaceStaffJoinSourceIssuance } from "../../api/types";
import {
  clearOrganizationOperationAttempt,
  resolveOrganizationOperationAttempt,
  type OrganizationOperationAttempt,
  type OrganizationOperationAttemptOptions,
  type OrganizationOperationScope,
} from "./organizationOperationAttempt";

export type WorkspaceJoinSourceKind = "invitation" | "enrollment";

export type WorkspaceJoinSourceIssuancePayload = {
  workspaceId: string;
  kind: WorkspaceJoinSourceKind;
  recipientEmail: string | null;
  lifetimeHours: number;
  profileKey: string;
  profileId: string;
  propertyIds: string[];
  maximumClaims: number | null;
  approvalMode: IssueWorkspaceEnrollmentLinkRequest["approvalMode"] | null;
};

export type WorkspaceJoinSourceIssuanceAttempt = OrganizationOperationAttempt;

export type WorkspaceJoinSourceReplacementPayload = {
  workspaceId: string;
  sourceId: string;
  sourceKind: number;
  expectedVersion: number;
  lifetimeHours: number;
};

export type WorkspaceJoinSourceReplacementAttempt = OrganizationOperationAttempt;

export type WorkspaceJoinSourceIssuanceOutcome =
  | { kind: "token"; token: string }
  | { kind: "reconciled" }
  | { kind: "invalid" };

/**
 * Persists only an opaque SHA-256 intent digest and random retry identity. The
 * UUID correlates retries; authorization still comes from the signed-in session.
 */
export async function resolveWorkspaceJoinSourceIssuanceAttempt(
  current: WorkspaceJoinSourceIssuanceAttempt | null,
  accountId: string,
  payload: WorkspaceJoinSourceIssuancePayload,
  options: OrganizationOperationAttemptOptions = {},
): Promise<WorkspaceJoinSourceIssuanceAttempt> {
  return resolveOrganizationOperationAttempt(
    current,
    issuanceScope(accountId, payload.workspaceId, payload.kind),
    [workspaceJoinSourceIssuanceFingerprint(payload)],
    options,
  );
}

export async function clearWorkspaceJoinSourceIssuanceAttempt(
  accountId: string,
  workspaceId: string,
  kind: WorkspaceJoinSourceKind,
  storage?: Pick<Storage, "removeItem">,
  assertCurrent?: () => void,
): Promise<void> {
  return clearOrganizationOperationAttempt(
    issuanceScope(accountId, workspaceId, kind),
    storage,
    assertCurrent,
  );
}

export function workspaceJoinSourceIssuanceFingerprint(
  payload: WorkspaceJoinSourceIssuancePayload,
): string {
  return JSON.stringify({
    workspaceId: payload.workspaceId.trim().toLowerCase(),
    kind: payload.kind,
    recipientEmail: payload.recipientEmail?.trim().toLowerCase() || null,
    lifetimeHours: payload.lifetimeHours,
    profileKey: payload.profileKey.trim().toLowerCase(),
    profileId: payload.profileId.trim().toLowerCase(),
    propertyIds: normalizeIds(payload.propertyIds),
    maximumClaims: payload.maximumClaims,
    approvalMode: payload.approvalMode,
  });
}

export async function resolveWorkspaceJoinSourceReplacementAttempt(
  current: WorkspaceJoinSourceReplacementAttempt | null,
  accountId: string,
  payload: WorkspaceJoinSourceReplacementPayload,
  options: OrganizationOperationAttemptOptions = {},
): Promise<WorkspaceJoinSourceReplacementAttempt> {
  return resolveOrganizationOperationAttempt(
    current,
    replacementScope(accountId, payload),
    [workspaceJoinSourceReplacementFingerprint(payload)],
    options,
  );
}

export async function clearWorkspaceJoinSourceReplacementAttempt(
  accountId: string,
  payload: WorkspaceJoinSourceReplacementPayload,
  storage?: Pick<Storage, "removeItem">,
  assertCurrent?: () => void,
): Promise<void> {
  return clearOrganizationOperationAttempt(
    replacementScope(accountId, payload),
    storage,
    assertCurrent,
  );
}

export function workspaceJoinSourceReplacementFingerprint(
  payload: WorkspaceJoinSourceReplacementPayload,
): string {
  return JSON.stringify({
    workspaceId: payload.workspaceId.trim().toLowerCase(),
    sourceId: payload.sourceId.trim().toLowerCase(),
    sourceKind: payload.sourceKind,
    expectedVersion: payload.expectedVersion,
    lifetimeHours: payload.lifetimeHours,
  });
}

function issuanceScope(
  accountId: string,
  workspaceId: string,
  kind: WorkspaceJoinSourceKind,
): OrganizationOperationScope {
  return {
    accountId,
    workspaceId,
    action: `issue-${kind}`,
  };
}

function replacementScope(
  accountId: string,
  payload: WorkspaceJoinSourceReplacementPayload,
): OrganizationOperationScope {
  return {
    accountId,
    workspaceId: payload.workspaceId,
    action: `replace-${payload.sourceKind}-${payload.sourceId}`,
  };
}

export function workspaceJoinSourceIssuanceOutcome(
  issuance: Pick<WorkspaceStaffJoinSourceIssuance, "alreadyIssued" | "token">,
): WorkspaceJoinSourceIssuanceOutcome {
  const token = issuance.token;
  if (issuance.alreadyIssued) {
    return token === null
      ? { kind: "reconciled" }
      : { kind: "invalid" };
  }

  if (!token || token.trim() !== token) {
    return { kind: "invalid" };
  }

  return { kind: "token", token };
}

export async function finalizeWorkspaceJoinSourceIssuance(
  issuance: Pick<WorkspaceStaffJoinSourceIssuance, "alreadyIssued" | "token">,
  clearAttempt: () => Promise<void>,
): Promise<WorkspaceJoinSourceIssuanceOutcome> {
  const outcome = workspaceJoinSourceIssuanceOutcome(issuance);
  if (outcome.kind !== "invalid") await clearAttempt();
  return outcome;
}

function normalizeIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean))]
    .sort();
}
