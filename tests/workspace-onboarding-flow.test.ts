import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client";
import type { OrganizationMembershipSummary } from "../src/api/types";
import {
  continueWorkspaceOnboarding,
  recoverCreatedWorkspace,
} from "../src/features/workspaces/workspaceOnboardingFlow";
import {
  clearWorkspaceCreationAttempt,
  readWorkspaceCreationAttempt,
  resolveWorkspaceCreationAttempt,
} from "../src/features/workspaces/workspaceCreationAttempt";

const accountId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000001";
const payload = { name: "Harbor House", slug: "harbor-house" };
const staffProfile = {
  displayName: "Ada Lovelace",
  legalName: "",
  workEmail: "ada@example.com",
  workPhone: "",
  jobTitle: "Owner",
  department: "Operations",
};

describe("workspace onboarding recovery", () => {
  it("keeps a pre-send marker when reload reconciliation returns 404", async () => {
    const memory = storage();
    const attempt = await resolveWorkspaceCreationAttempt(
      null,
      accountId,
      payload,
      { storage: memory, createOperationId: () => operationId },
    );
    const request = async <T,>(path: string): Promise<T> => {
      expect(path).toBe(`/api/organizations/${operationId}`);
      throw new ApiError("Not found", 404);
    };

    await expect(recoverCreatedWorkspace(request, attempt)).resolves.toBeNull();
    await expect(readWorkspaceCreationAttempt(accountId, memory))
      .resolves.toEqual(attempt);

    const afterReload = await resolveWorkspaceCreationAttempt(
      null,
      accountId,
      payload,
      { storage: memory, createOperationId: () => crypto.randomUUID() },
    );
    expect(afterReload.operationId).toBe(operationId);
  });

  it("restores the created organization from its durable operation id", async () => {
    const memory = storage();
    const attempt = await resolveWorkspaceCreationAttempt(
      null,
      accountId,
      payload,
      { storage: memory, createOperationId: () => operationId },
    );
    const restored = workspace(operationId);
    const request = async <T,>(path: string): Promise<T> => {
      expect(path).toBe(`/api/organizations/${operationId}`);
      return restored as T;
    };

    await expect(recoverCreatedWorkspace(request, attempt)).resolves.toEqual(restored);
    await expect(readWorkspaceCreationAttempt(accountId, memory))
      .resolves.toEqual(attempt);
  });

  it("fails closed when recovery returns a different organization", async () => {
    const attempt = await resolveWorkspaceCreationAttempt(
      null,
      accountId,
      payload,
      { storage: storage(), createOperationId: () => operationId },
    );
    const request = async <T,>(): Promise<T> =>
      workspace("20000000-0000-4000-8000-000000000099") as T;

    await expect(recoverCreatedWorkspace(request, attempt)).rejects.toThrow(
      "did not match the pending creation attempt",
    );
  });

  it.each(["access", "refetch", "staff"] as const)(
    "retains the same marker across a reload at the %s stage and clears it only after completion",
    async (failureStage) => {
      const memory = storage();
      const attempt = await resolveWorkspaceCreationAttempt(
        null,
        accountId,
        payload,
        { storage: memory, createOperationId: () => operationId },
      );
      let failOnce = true;
      const events: string[] = [];
      const continuation = {
        request: async <T,>(): Promise<T> => ({} as T),
        workspaceId: operationId,
        staffProfile,
        selectWorkspace: (workspaceId: string) => {
          events.push(`select:${workspaceId}`);
        },
        refetchWorkspaces: async () => {
          events.push("refetch");
          if (failOnce && failureStage === "refetch") {
            throw new Error("refetch interrupted");
          }
        },
        setSelectedWorkspaceId: (workspaceId: string) => {
          events.push(`selected:${workspaceId}`);
        },
        clearCreationAttempt: async () => {
          events.push("clear");
          await clearWorkspaceCreationAttempt(accountId, memory);
        },
      };
      const services = {
        waitForAccess: async () => {
          events.push("access");
          if (failOnce && failureStage === "access") {
            throw new Error("access interrupted");
          }
        },
        completeStaffProfile: async () => {
          events.push("staff");
          if (failOnce && failureStage === "staff") {
            throw new Error("staff interrupted");
          }
          return {} as never;
        },
      };

      await expect(continueWorkspaceOnboarding(continuation, services))
        .rejects.toThrow(`${failureStage} interrupted`);
      expect(events).not.toContain("clear");
      await expect(readWorkspaceCreationAttempt(accountId, memory))
        .resolves.toEqual(attempt);

      // A same-tab reload loses React refs but restores the persisted identity.
      const afterReload = await readWorkspaceCreationAttempt(accountId, memory);
      expect(afterReload?.operationId).toBe(operationId);
      failOnce = false;
      events.length = 0;
      await continueWorkspaceOnboarding(continuation, services);

      expect(events).toEqual([
        `select:${operationId}`,
        "access",
        "refetch",
        `selected:${operationId}`,
        "staff",
        "clear",
      ]);
      await expect(readWorkspaceCreationAttempt(accountId, memory))
        .resolves.toBeNull();
    },
  );
});

function workspace(organizationId: string): OrganizationMembershipSummary {
  return {
    organization: {
      organizationId,
      scopeId: organizationId,
      name: "Harbor House",
      slug: "harbor-house",
      status: "active",
      activeOwnerCount: 1,
      version: 1,
      createdAtUtc: "2026-08-11T00:00:00Z",
      lastChangedAtUtc: "2026-08-11T00:00:00Z",
    },
    membership: {
      membershipId: "30000000-0000-4000-8000-000000000001",
      organizationId,
      subjectId: accountId,
      role: "owner",
      status: "active",
      version: 1,
      joinedAtUtc: "2026-08-11T00:00:00Z",
      lastChangedAtUtc: "2026-08-11T00:00:00Z",
    },
  };
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}
