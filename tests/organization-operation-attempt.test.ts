import { describe, expect, it } from "vitest";
import {
  clearOrganizationOperationAttempt,
  readOrganizationOperationAttempt,
  resolveOrganizationOperationAttempt,
  type OrganizationOperationScope,
} from "../src/features/workspaces/organizationOperationAttempt";

const scope: OrganizationOperationScope = {
  accountId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000001",
  action: "issue-invitation",
};

describe("organization operation attempt storage", () => {
  it("stores only a version, opaque digests, and a random operation id", async () => {
    const memory = storage();
    const attempt = await resolveOrganizationOperationAttempt(
      null,
      scope,
      ["member@example.com", "front-desk", "property-secret-scope"],
      { storage: memory.api, createOperationId: () => uuid(1) },
    );
    const persisted = [...memory.values.entries()].flat().join(" ");

    expect(attempt.intentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted).not.toContain("member@example.com");
    expect(persisted).not.toContain("front-desk");
    expect(persisted).not.toContain("property-secret-scope");
    expect(persisted).not.toContain(scope.accountId);
    expect(persisted).not.toContain(scope.workspaceId);
  });

  it("removes corrupt and obsolete-version records instead of reusing them", async () => {
    const memory = storage();
    const attempt = await resolveOrganizationOperationAttempt(
      null,
      scope,
      ["intent"],
      { storage: memory.api, createOperationId: () => uuid(1) },
    );
    const key = [...memory.values.keys()][0]!;

    memory.values.set(key, "not-json");
    expect(await readOrganizationOperationAttempt(scope, memory.api)).toBeNull();
    expect(memory.values.size).toBe(0);

    memory.values.set(key, JSON.stringify({ ...attempt, version: 2 }));
    expect(await readOrganizationOperationAttempt(scope, memory.api)).toBeNull();
    expect(memory.values.size).toBe(0);
  });

  it("fails before a request can proceed when the attempt cannot persist", async () => {
    await expect(resolveOrganizationOperationAttempt(
      null,
      scope,
      ["intent"],
      {
        storage: {
          getItem: () => null,
          setItem: () => {
            throw new DOMException("storage disabled", "SecurityError");
          },
          removeItem: () => undefined,
        },
        createOperationId: () => uuid(1),
      },
    )).rejects.toMatchObject({ name: "SecurityError" });
  });

  it("clears only the exact account-workspace-action namespace", async () => {
    const memory = storage();
    const otherScope = { ...scope, action: "issue-enrollment" };
    await resolveOrganizationOperationAttempt(
      null,
      scope,
      ["intent"],
      { storage: memory.api, createOperationId: () => uuid(1) },
    );
    const other = await resolveOrganizationOperationAttempt(
      null,
      otherScope,
      ["intent"],
      { storage: memory.api, createOperationId: () => uuid(2) },
    );

    await clearOrganizationOperationAttempt(scope, memory.api);
    expect(await readOrganizationOperationAttempt(scope, memory.api)).toBeNull();
    expect(await readOrganizationOperationAttempt(otherScope, memory.api))
      .toEqual(other);
  });

  it("does not persist an intent if its actor changes while hashes are pending", async () => {
    const memory = storage();
    let current = true;
    const pending = resolveOrganizationOperationAttempt(null, scope, ["intent"], {
      storage: memory.api,
      assertCurrent: () => { if (!current) throw new Error("superseded"); },
    });
    current = false;
    await expect(pending).rejects.toThrow("superseded");
    expect(memory.values.size).toBe(0);
  });

  it("retains the retry marker if its actor changes during asynchronous cleanup", async () => {
    const memory = storage();
    const attempt = await resolveOrganizationOperationAttempt(null, scope, ["intent"], { storage: memory.api });
    let current = true;
    const clearing = clearOrganizationOperationAttempt(scope, memory.api, () => {
      if (!current) throw new Error("superseded");
    });
    current = false;
    await expect(clearing).rejects.toThrow("superseded");
    expect(await readOrganizationOperationAttempt(scope, memory.api)).toEqual(attempt);
  });
});

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    api: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  };
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
