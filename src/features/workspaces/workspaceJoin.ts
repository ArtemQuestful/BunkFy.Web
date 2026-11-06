import { apiRequest } from "../../api/client";
import type { components } from "../../api/contracts.generated";
import type { OrganizationEnrollmentPreview, OrganizationInvitationPreview } from "../../api/types";

export type WorkspaceJoinResolution =
  | { kind: "joined"; workspaceId: string }
  | { kind: "pending-approval"; workspaceId: string };

export type WorkspaceJoinSecret = {
  kind: "invitation" | "enrollment";
  token: string;
};

export type WorkspaceJoinContext = {
  kind: "invitation" | "enrollment";
  contextId: string;
};

export type WorkspaceJoinPreparation = {
  context: WorkspaceJoinContext;
  preview: OrganizationInvitationPreview | OrganizationEnrollmentPreview;
};

const WORKSPACE_JOIN_CONTEXT_KEY = "bunkfy.join.context.v2";
const LEGACY_WORKSPACE_JOIN_SECRET_KEY = "bunkfy.join.secret.v1";
export const WORKSPACE_JOIN_CONTEXT_HEADER = "X-BunkFy-Join-Context";
const contextIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const preparations = new Map<string, Promise<WorkspaceJoinPreparation>>();

export function parseWorkspaceJoinSecret(hash: string): WorkspaceJoinSecret | null {
  const parameters = new URLSearchParams(hash.replace(/^#/, ""));
  const invitation = parameters.get("invitation")?.trim();
  if (invitation) return { kind: "invitation", token: invitation };
  const enrollment = parameters.get("enrollment")?.trim();
  return enrollment ? { kind: "enrollment", token: enrollment } : null;
}

// Migration-only reader. New code never persists this reusable credential.
export function readLegacyWorkspaceJoinSecret(): WorkspaceJoinSecret | null {
  try {
    const value = window.sessionStorage.getItem(LEGACY_WORKSPACE_JOIN_SECRET_KEY);
    if (!value) return null;
    const secret = JSON.parse(value) as Partial<WorkspaceJoinSecret>;
    return (secret.kind === "invitation" || secret.kind === "enrollment") &&
      typeof secret.token === "string" && secret.token.trim()
      ? { kind: secret.kind, token: secret.token.trim() }
      : null;
  } catch {
    return null;
  }
}

export function readPreservedWorkspaceJoinContext(): WorkspaceJoinContext | null {
  try {
    const value = window.sessionStorage.getItem(WORKSPACE_JOIN_CONTEXT_KEY);
    if (!value) return null;
    const context = JSON.parse(value) as Partial<WorkspaceJoinContext>;
    return validContext(context) ? { kind: context.kind, contextId: context.contextId } : null;
  } catch {
    return null;
  }
}

// Commit only after the active page has confirmed server cookie custody. A
// superseded preparation must not replace a newer tab-local continuation.
export function preserveWorkspaceJoinContext(context: WorkspaceJoinContext): void {
  if (!validContext(context)) throw new Error("The invitation context is invalid.");
  window.sessionStorage.setItem(WORKSPACE_JOIN_CONTEXT_KEY, JSON.stringify({ kind: context.kind, contextId: context.contextId }));
  window.sessionStorage.removeItem(LEGACY_WORKSPACE_JOIN_SECRET_KEY);
}

export function prepareWorkspaceJoinContext(secret: WorkspaceJoinSecret): Promise<WorkspaceJoinPreparation> {
  const key = `${secret.kind}:${secret.token}`;
  const existing = preparations.get(key);
  if (existing) return existing;
  const context: WorkspaceJoinContext = { kind: secret.kind, contextId: crypto.randomUUID() };
  const operation = (async () => {
    const receipt = await apiRequest<components["schemas"]["WorkspaceJoinBrowserContextDto"]>(workspaceJoinContextPath(context), {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: workspaceJoinContextHeaders(context),
      body: JSON.stringify({ sourceKind: workspaceJoinSourceKind(secret.kind), token: secret.token }),
    });
    if (receipt.contextId !== context.contextId || receipt.sourceKind !== workspaceJoinSourceKind(context.kind)) {
      throw new Error("The invitation context could not be confirmed.");
    }
    // A second request proves that this browser retained the HttpOnly cookie
    // before the page removes its fragment or discards a legacy raw credential.
    const preview = await apiRequest<OrganizationInvitationPreview | OrganizationEnrollmentPreview>(
      workspaceJoinContextPath(context) + "/preview",
      { method: "POST", headers: workspaceJoinContextHeaders(context), signal: AbortSignal.timeout(30_000) },
    );
    return { context, preview };
  })().finally(() => { preparations.delete(key); });
  preparations.set(key, operation);
  return operation;
}

export function clearPreservedWorkspaceJoinContext(context: WorkspaceJoinContext | null): void {
  if (!context) return;
  // Late callbacks own their original context, never whichever invitation a
  // newer page has since prepared. Uncommitted legacy recovery is separate.
  if (readPreservedWorkspaceJoinContext()?.contextId === context.contextId) {
    window.sessionStorage.removeItem(WORKSPACE_JOIN_CONTEXT_KEY);
  }
  void apiRequest<void>(workspaceJoinContextPath(context), {
    method: "DELETE", headers: workspaceJoinContextHeaders(context),
  }).catch(() => {
    // An unreachable transport cookie remains HttpOnly/session-only; it never
    // changes source validity or membership.
  });
}

export function workspaceJoinContextPath(context: WorkspaceJoinContext): string {
  if (!validContext(context)) throw new Error("The invitation context is invalid.");
  return `/api/workspace-join/${encodeURIComponent(context.contextId)}`;
}

export function workspaceJoinContextHeaders(context: WorkspaceJoinContext): Record<string, string> {
  return { [WORKSPACE_JOIN_CONTEXT_HEADER]: context.contextId };
}

export function workspaceJoinAuthenticationDestination(destination: string): string {
  return destination === "/" && (readPreservedWorkspaceJoinContext() || readLegacyWorkspaceJoinSecret())
    ? "/join" : destination;
}

function validContext(context: Partial<WorkspaceJoinContext>): context is WorkspaceJoinContext {
  return (context.kind === "invitation" || context.kind === "enrollment") &&
    typeof context.contextId === "string" && contextIdPattern.test(context.contextId) &&
    context.contextId !== "00000000-0000-0000-0000-000000000000";
}

export function resolveEnrollmentJoin(
  outcome: {
    claim: { organizationId: string };
    membership: { organization: { organizationId: string } } | null;
  },
): WorkspaceJoinResolution {
  return outcome.membership
    ? {
        kind: "joined",
        workspaceId: outcome.membership.organization.organizationId,
      }
    : {
        kind: "pending-approval",
        workspaceId: outcome.claim.organizationId,
    };
}

export function workspaceJoinSourceKind(kind: "invitation" | "enrollment"): 1 | 2 {
  return kind === "invitation" ? 1 : 2;
}

export function workspaceJoinVerificationCopy(recipientBound: boolean): {
  title: string;
  description: string;
} {
  return recipientBound
    ? {
        title: "Verify the invited email",
        description:
          "This invitation is restricted to its recipient. Verify the matching active email on this account, then BunkFy will continue joining the workspace.",
      }
    : {
        title: "Verify your account email",
        description:
          "BunkFy requires a verified account email before staff access is created. Verify the active address on this account, then joining will continue automatically.",
      };
}

export function isWorkspaceStaffOnboardingInProgress(status: number | undefined): boolean {
  return status === 1 || status === 2 || status === 3 || status === 4;
}

export function isWorkspaceStaffOnboardingTerminallyDenied(status: number | undefined): boolean {
  return status === 7 || status === 8;
}

export function isWorkspaceStaffOnboardingExpired(status: number | undefined): boolean {
  return status === 9;
}

export function isWorkspaceStaffOnboardingWithdrawn(status: number | undefined): boolean {
  return status === 10;
}
