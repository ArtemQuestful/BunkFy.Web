import { describe, expect, it } from "vitest";
import {
  clearWorkspaceUpdateAttempt,
  resolveWorkspaceUpdateAttempt,
  type WorkspaceUpdatePayload,
} from "../src/features/workspaces/workspaceUpdateAttempt";

const payload: WorkspaceUpdatePayload = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  expectedVersion: 7,
  name: "Harbor House",
  slug: "harbor-house",
};
const accountId = "20000000-0000-4000-8000-000000000001";

describe("workspace update attempts", () => {
  it("restores one operation id after a lost response and settings reload", async () => {
    const memory = storage();
    let allocations = 0;
    const options = {
      storage: memory,
      createOperationId: () => uuid(++allocations),
    };
    const first = await resolveWorkspaceUpdateAttempt(
      null,
      accountId,
      payload,
      options,
    );
    const afterReload = await resolveWorkspaceUpdateAttempt(
      null,
      accountId,
      {
        ...payload,
        name: "  Harbor House  ",
        slug: " HARBOR-HOUSE ",
      },
      options,
    );

    expect(afterReload.operationId).toBe(first.operationId);
    expect(allocations).toBe(1);
  });

  it("allocates a new operation for changed intent or version", async () => {
    const memory = storage();
    let allocations = 0;
    const options = {
      storage: memory,
      createOperationId: () => uuid(++allocations),
    };
    const first = await resolveWorkspaceUpdateAttempt(
      null,
      accountId,
      payload,
      options,
    );
    const changed = await resolveWorkspaceUpdateAttempt(
      first,
      accountId,
      { ...payload, name: "Harbor Annex" },
      options,
    );
    const newerVersion = await resolveWorkspaceUpdateAttempt(
      changed,
      accountId,
      { ...payload, name: "Harbor Annex", expectedVersion: 8 },
      options,
    );

    expect(changed.operationId).toBe(uuid(2));
    expect(newerVersion.operationId).toBe(uuid(3));
  });

  it("isolates workspace scope and clears only a definitive success", async () => {
    const memory = storage();
    const first = await resolveWorkspaceUpdateAttempt(
      null,
      accountId,
      payload,
      { storage: memory, createOperationId: () => uuid(1) },
    );
    const otherWorkspace = await resolveWorkspaceUpdateAttempt(
      null,
      accountId,
      { ...payload, organizationId: "10000000-0000-4000-8000-000000000002" },
      { storage: memory, createOperationId: () => uuid(2) },
    );

    expect(otherWorkspace.operationId).not.toBe(first.operationId);
    await clearWorkspaceUpdateAttempt(
      accountId,
      payload.organizationId,
      memory,
    );
    const restoredOther = await resolveWorkspaceUpdateAttempt(
      null,
      accountId,
      { ...payload, organizationId: "10000000-0000-4000-8000-000000000002" },
      { storage: memory, createOperationId: () => uuid(3) },
    );
    expect(restoredOther.operationId).toBe(otherWorkspace.operationId);
  });
});

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
