import { describe, expect, it } from "vitest";
import {
  clearWorkspaceCreationAttempt,
  readWorkspaceCreationAttempt,
  resolveWorkspaceCreationAttempt,
  type WorkspaceCreationPayload,
} from "../src/features/workspaces/workspaceCreationAttempt";

const payload: WorkspaceCreationPayload = {
  name: "Harbor House",
  slug: "harbor-house",
};
const accountId = "10000000-0000-4000-8000-000000000001";

describe("workspace creation attempt", () => {
  it("restores one operation id after a lost response and page reload", async () => {
    const memory = storage();
    let allocations = 0;
    const options = {
      storage: memory,
      createOperationId: () => uuid(++allocations),
    };
    const first = await resolveWorkspaceCreationAttempt(
      null,
      accountId,
      payload,
      options,
    );
    const afterReload = await resolveWorkspaceCreationAttempt(
      null,
      accountId,
      { name: "  Harbor House  ", slug: " HARBOR-HOUSE " },
      options,
    );

    expect(afterReload.operationId).toBe(first.operationId);
    expect(allocations).toBe(1);
  });

  it("allocates a new operation id when normalized intent changes", async () => {
    const memory = storage();
    let allocations = 0;
    const options = {
      storage: memory,
      createOperationId: () => uuid(++allocations),
    };
    const first = await resolveWorkspaceCreationAttempt(
      null,
      accountId,
      payload,
      options,
    );
    const changedName = await resolveWorkspaceCreationAttempt(
      first,
      accountId,
      { ...payload, name: "Harbor Annex" },
      options,
    );
    const changedSlug = await resolveWorkspaceCreationAttempt(
      changedName,
      accountId,
      { ...payload, name: "Harbor Annex", slug: "harbor-annex" },
      options,
    );

    expect(changedName.operationId).toBe(uuid(2));
    expect(changedSlug.operationId).toBe(uuid(3));
  });

  it("isolates accounts and clears only the requested account", async () => {
    const memory = storage();
    const otherAccountId = "10000000-0000-4000-8000-000000000002";
    const first = await resolveWorkspaceCreationAttempt(
      null,
      accountId,
      payload,
      { storage: memory, createOperationId: () => uuid(1) },
    );
    const other = await resolveWorkspaceCreationAttempt(
      null,
      otherAccountId,
      payload,
      { storage: memory, createOperationId: () => uuid(2) },
    );

    expect(other.operationId).not.toBe(first.operationId);
    await clearWorkspaceCreationAttempt(accountId, memory);
    expect(await readWorkspaceCreationAttempt(accountId, memory)).toBeNull();
    expect(await readWorkspaceCreationAttempt(otherAccountId, memory))
      .toEqual(other);
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
