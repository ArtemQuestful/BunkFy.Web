import { describe, expect, it } from "vitest";
import {
  clearWorkspaceJoinSourceIssuanceAttempt,
  clearWorkspaceJoinSourceReplacementAttempt,
  finalizeWorkspaceJoinSourceIssuance,
  resolveWorkspaceJoinSourceIssuanceAttempt,
  resolveWorkspaceJoinSourceReplacementAttempt,
  workspaceJoinSourceIssuanceOutcome,
  type WorkspaceJoinSourceIssuancePayload,
  type WorkspaceJoinSourceReplacementPayload,
} from "../src/features/workspaces/workspaceJoinSourceAttempt";

const accountId = "10000000-0000-4000-8000-000000000001";
const invitation: WorkspaceJoinSourceIssuancePayload = {
  workspaceId: "20000000-0000-4000-8000-000000000001",
  kind: "invitation",
  recipientEmail: "member@example.com",
  lifetimeHours: 72,
  profileKey: "front-desk",
  profileId: "30000000-0000-4000-8000-000000000001",
  propertyIds: [
    "40000000-0000-4000-8000-000000000001",
    "40000000-0000-4000-8000-000000000002",
  ],
  maximumClaims: null,
  approvalMode: null,
};

const replacement: WorkspaceJoinSourceReplacementPayload = {
  workspaceId: invitation.workspaceId,
  sourceId: "50000000-0000-4000-8000-000000000001",
  sourceKind: 1,
  expectedVersion: 7,
  lifetimeHours: 72,
};

describe("workspace join-source attempts", () => {
  it("restores one source id after a lost response and reload", async () => {
    const memory = storage();
    let allocations = 0;
    const options = {
      storage: memory,
      createOperationId: () => uuid(++allocations),
    };
    const first = await resolveWorkspaceJoinSourceIssuanceAttempt(
      null,
      accountId,
      invitation,
      options,
    );
    const afterReload = await resolveWorkspaceJoinSourceIssuanceAttempt(
      null,
      accountId,
      {
        ...invitation,
        recipientEmail: " MEMBER@EXAMPLE.COM ",
        profileKey: " FRONT-DESK ",
        propertyIds: [
          "40000000-0000-4000-8000-000000000002",
          "40000000-0000-4000-8000-000000000001",
          "40000000-0000-4000-8000-000000000001",
        ],
      },
      options,
    );

    expect(afterReload.operationId).toBe(first.operationId);
    expect(allocations).toBe(1);
    const persisted = memory.values();
    expect(persisted).not.toContain("member@example.com");
    expect(persisted).not.toContain("front-desk");
    expect(persisted).not.toContain(invitation.profileId);
  });

  it.each([
    ["workspace", { workspaceId: "20000000-0000-4000-8000-000000000002" }],
    ["source kind", { kind: "enrollment" as const }],
    ["recipient", { recipientEmail: "other@example.com" }],
    ["lifetime", { lifetimeHours: 24 }],
    ["profile key", { profileKey: "housekeeping" }],
    ["exact profile", { profileId: "30000000-0000-4000-8000-000000000002" }],
    ["property scope", { propertyIds: invitation.propertyIds.slice(0, 1) }],
    ["claim capacity", { maximumClaims: 20 }],
    ["approval mode", { approvalMode: "requires-approval" as const }],
  ])("allocates a new source id when %s intent changes", async (_label, change) => {
    const memory = storage();
    const first = await resolveWorkspaceJoinSourceIssuanceAttempt(
      null,
      accountId,
      invitation,
      { storage: memory, createOperationId: () => uuid(1) },
    );
    const changed = await resolveWorkspaceJoinSourceIssuanceAttempt(
      first,
      accountId,
      { ...invitation, ...change },
      { storage: memory, createOperationId: () => uuid(2) },
    );

    expect(changed.operationId).toBe(uuid(2));
  });

  it("isolates authenticated accounts and clears only after acknowledgement", async () => {
    const memory = storage();
    const first = await resolveWorkspaceJoinSourceIssuanceAttempt(
      null,
      accountId,
      invitation,
      { storage: memory, createOperationId: () => uuid(1) },
    );
    const other = await resolveWorkspaceJoinSourceIssuanceAttempt(
      null,
      "10000000-0000-4000-8000-000000000002",
      invitation,
      { storage: memory, createOperationId: () => uuid(2) },
    );
    expect(other.operationId).not.toBe(first.operationId);

    await clearWorkspaceJoinSourceIssuanceAttempt(
      accountId,
      invitation.workspaceId,
      invitation.kind,
      memory,
    );
    const next = await resolveWorkspaceJoinSourceIssuanceAttempt(
      null,
      accountId,
      invitation,
      { storage: memory, createOperationId: () => uuid(3) },
    );
    expect(next.operationId).toBe(uuid(3));
  });

  it("restores one replacement id after a lost response and reload", async () => {
    const memory = storage();
    let allocations = 0;
    const options = {
      storage: memory,
      createOperationId: () => uuid(++allocations),
    };
    const first = await resolveWorkspaceJoinSourceReplacementAttempt(
      null,
      accountId,
      replacement,
      options,
    );
    const afterReload = await resolveWorkspaceJoinSourceReplacementAttempt(
      null,
      accountId,
      { ...replacement, sourceId: replacement.sourceId.toUpperCase() },
      options,
    );

    expect(afterReload.operationId).toBe(first.operationId);
    expect(allocations).toBe(1);
  });

  it.each([
    ["workspace", { workspaceId: "20000000-0000-4000-8000-000000000002" }],
    ["predecessor", { sourceId: "50000000-0000-4000-8000-000000000002" }],
    ["source kind", { sourceKind: 2 }],
    ["predecessor version", { expectedVersion: 8 }],
    ["lifetime", { lifetimeHours: 24 }],
  ])("allocates a new replacement id when %s intent changes", async (_label, change) => {
    const memory = storage();
    const first = await resolveWorkspaceJoinSourceReplacementAttempt(
      null,
      accountId,
      replacement,
      { storage: memory, createOperationId: () => uuid(1) },
    );
    const changed = await resolveWorkspaceJoinSourceReplacementAttempt(
      first,
      accountId,
      { ...replacement, ...change },
      { storage: memory, createOperationId: () => uuid(2) },
    );

    expect(changed.operationId).toBe(uuid(2));
  });

  it("clears the exact replacement scope after a definitive response", async () => {
    const memory = storage();
    await resolveWorkspaceJoinSourceReplacementAttempt(
      null,
      accountId,
      replacement,
      { storage: memory, createOperationId: () => uuid(1) },
    );
    await clearWorkspaceJoinSourceReplacementAttempt(
      accountId,
      replacement,
      memory,
    );
    const next = await resolveWorkspaceJoinSourceReplacementAttempt(
      null,
      accountId,
      replacement,
      { storage: memory, createOperationId: () => uuid(2) },
    );

    expect(next.operationId).toBe(uuid(2));
  });

  it("distinguishes a lost-response reconciliation from a fresh token", () => {
    expect(workspaceJoinSourceIssuanceOutcome({
      alreadyIssued: false,
      token: "one-time-token",
    })).toEqual({ kind: "token", token: "one-time-token" });
    expect(workspaceJoinSourceIssuanceOutcome({
      alreadyIssued: true,
      token: null,
    })).toEqual({ kind: "reconciled" });
  });

  it.each([
    ["a missing fresh token", { alreadyIssued: false, token: null }],
    ["an empty fresh token", { alreadyIssued: false, token: "" }],
    ["a blank fresh token", { alreadyIssued: false, token: "   " }],
    ["a padded fresh token", { alreadyIssued: false, token: " token " }],
    ["a token on an already-issued receipt", {
      alreadyIssued: true,
      token: "contradictory-token",
    }],
    ["an empty token on an already-issued receipt", {
      alreadyIssued: true,
      token: "",
    }],
  ])("fails closed for %s", (_label, issuance) => {
    expect(workspaceJoinSourceIssuanceOutcome(issuance))
      .toEqual({ kind: "invalid" });
  });

  it("validates the receipt before clearing the durable attempt", async () => {
    const events: string[] = [];
    const issuance = {
      get alreadyIssued() {
        events.push("read-issued-state");
        return false;
      },
      get token() {
        events.push("read-token");
        return "one-time-token";
      },
    };

    await expect(finalizeWorkspaceJoinSourceIssuance(
      issuance,
      async () => {
        events.push("clear");
      },
    )).resolves.toEqual({ kind: "token", token: "one-time-token" });
    expect(events).toEqual(["read-token", "read-issued-state", "clear"]);
  });

  it("retains and reuses an issuance id after an invalid receipt", async () => {
    const memory = storage();
    let allocations = 0;
    const options = {
      storage: memory,
      createOperationId: () => uuid(++allocations),
    };
    const first = await resolveWorkspaceJoinSourceIssuanceAttempt(
      null,
      accountId,
      invitation,
      options,
    );
    const invalid = await finalizeWorkspaceJoinSourceIssuance(
      { alreadyIssued: true, token: "contradictory-token" },
      () => clearWorkspaceJoinSourceIssuanceAttempt(
        accountId,
        invitation.workspaceId,
        invitation.kind,
        memory,
      ),
    );

    expect(invalid).toEqual({ kind: "invalid" });
    const afterReload = await resolveWorkspaceJoinSourceIssuanceAttempt(
      null,
      accountId,
      invitation,
      options,
    );
    expect(afterReload.operationId).toBe(first.operationId);
    expect(allocations).toBe(1);

    await finalizeWorkspaceJoinSourceIssuance(
      { alreadyIssued: true, token: null },
      () => clearWorkspaceJoinSourceIssuanceAttempt(
        accountId,
        invitation.workspaceId,
        invitation.kind,
        memory,
      ),
    );
    const next = await resolveWorkspaceJoinSourceIssuanceAttempt(
      null,
      accountId,
      invitation,
      options,
    );
    expect(next.operationId).toBe(uuid(2));
  });

  it("retains and reuses a replacement id after an invalid receipt", async () => {
    const memory = storage();
    let allocations = 0;
    const options = {
      storage: memory,
      createOperationId: () => uuid(++allocations),
    };
    const first = await resolveWorkspaceJoinSourceReplacementAttempt(
      null,
      accountId,
      replacement,
      options,
    );
    await expect(finalizeWorkspaceJoinSourceIssuance(
      { alreadyIssued: false, token: "   " },
      () => clearWorkspaceJoinSourceReplacementAttempt(
        accountId,
        replacement,
        memory,
      ),
    )).resolves.toEqual({ kind: "invalid" });

    const afterReload = await resolveWorkspaceJoinSourceReplacementAttempt(
      null,
      accountId,
      replacement,
      options,
    );
    expect(afterReload.operationId).toBe(first.operationId);
    expect(allocations).toBe(1);

    await finalizeWorkspaceJoinSourceIssuance(
      { alreadyIssued: false, token: "replacement-token" },
      () => clearWorkspaceJoinSourceReplacementAttempt(
        accountId,
        replacement,
        memory,
      ),
    );
    const next = await resolveWorkspaceJoinSourceReplacementAttempt(
      null,
      accountId,
      replacement,
      options,
    );
    expect(next.operationId).toBe(uuid(2));
  });
});

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values: () => [...values.entries()].flat().join(" "),
  };
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
