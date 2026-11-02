export type WorkspaceJoinResolution =
  | { kind: "joined"; workspaceId: string }
  | { kind: "pending-approval"; workspaceId: string };

export type WorkspaceJoinSecret = {
  kind: "invitation" | "enrollment";
  token: string;
};

const WORKSPACE_JOIN_SECRET_KEY = "bunkfy.join.secret.v1";
let preservedJoinSecret: WorkspaceJoinSecret | null | undefined;

export function parseWorkspaceJoinSecret(hash: string): WorkspaceJoinSecret | null {
  const parameters = new URLSearchParams(hash.replace(/^#/, ""));
  const invitation = parameters.get("invitation")?.trim();
  if (invitation) return { kind: "invitation", token: invitation };
  const enrollment = parameters.get("enrollment")?.trim();
  return enrollment ? { kind: "enrollment", token: enrollment } : null;
}

export function preserveWorkspaceJoinSecret(hash: string): WorkspaceJoinSecret | null {
  const secret = parseWorkspaceJoinSecret(hash);
  if (secret) {
    preservedJoinSecret = { ...secret };
    try {
      window.sessionStorage.setItem(WORKSPACE_JOIN_SECRET_KEY, JSON.stringify(secret));
    } catch {
      // Keep the current join usable while the URL fragment is scrubbed.
    }
  }
  return secret;
}

export function readPreservedWorkspaceJoinSecret(): WorkspaceJoinSecret | null {
  if (preservedJoinSecret !== undefined) return preservedJoinSecret ? { ...preservedJoinSecret } : null;
  try {
    const value = window.sessionStorage.getItem(WORKSPACE_JOIN_SECRET_KEY);
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

export function clearPreservedWorkspaceJoinSecret(): void {
  preservedJoinSecret = null;
  try {
    window.sessionStorage.removeItem(WORKSPACE_JOIN_SECRET_KEY);
  } catch {
    // Clearing the current join must finish even when browser storage is blocked.
  }
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
