import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../src/api/client";
import {
  clearPreservedWorkspaceJoinContext,
  parseWorkspaceJoinSecret,
  prepareWorkspaceJoinContext,
  preserveWorkspaceJoinContext,
  readLegacyWorkspaceJoinSecret,
  readPreservedWorkspaceJoinContext,
  workspaceJoinAuthenticationDestination,
  workspaceJoinContextPath,
  type WorkspaceJoinContext,
} from "../src/features/workspaces/workspaceJoin";

vi.mock("../src/api/client", () => ({ apiRequest: vi.fn() }));

const api = vi.mocked(apiRequest);
const contextId = "11111111-1111-4111-8111-111111111111";
const context: WorkspaceJoinContext = { kind: "enrollment", contextId };
const legacyKey = "bunkfy.join.secret.v1";
const contextKey = "bunkfy.join.context.v2";
const preview = { organizationId: "22222222-2222-4222-8222-222222222222", enrollmentLinkId: contextId };
let storage: Storage;

beforeEach(() => {
  const entries: Record<string, string> = Object.create(null);
  storage = Object.defineProperties(entries, {
    getItem: { value: (key: string) => entries[key] ?? null },
    setItem: { value: (key: string, value: string) => { entries[key] = value; } },
    removeItem: { value: (key: string) => { delete entries[key]; } },
  }) as unknown as Storage;
  vi.stubGlobal("window", { sessionStorage: storage });
  api.mockReset();
  api.mockImplementation(async (path, options) => {
    if (options?.method === "DELETE") return undefined;
    if (path.endsWith("/preview")) return preview;
    return { contextId: path.split("/").at(-1), sourceKind: JSON.parse(options?.body as string).sourceKind };
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("workspace join credential custody and recovery", () => {
  it.each(["invitation", "enrollment"] as const)("confirms %s cookie custody before any durable metadata commit", async kind => {
    const secret = { kind, token: `synthetic-${kind}-credential` };
    const prepared = await prepareWorkspaceJoinContext(secret);
    expect(api).toHaveBeenCalledTimes(2);
    const [initialPath, initialOptions] = api.mock.calls[0]!;
    expect(JSON.parse(initialOptions?.body as string)).toEqual({ sourceKind: kind === "invitation" ? 1 : 2, token: secret.token });
    const [proofPath, proofOptions] = api.mock.calls[1]!;
    expect(proofPath).toBe(initialPath + "/preview");
    expect(proofOptions?.body).toBeUndefined();
    expect(initialOptions?.headers).toEqual(proofOptions?.headers);
    expect(Object.keys(storage)).toEqual([]);
    preserveWorkspaceJoinContext(prepared.context);
    expect(readPreservedWorkspaceJoinContext()).toEqual(prepared.context);
    expect(JSON.stringify(Object.entries(storage))).not.toContain(secret.token);
  });

  it.each(["invitation", "enrollment"] as const)("migrates the existing %s credential only after successful server custody", async kind => {
    const secret = { kind, token: `legacy-${kind}-synthetic` };
    storage.setItem(legacyKey, JSON.stringify(secret));
    expect(readLegacyWorkspaceJoinSecret()).toEqual(secret);
    const prepared = await prepareWorkspaceJoinContext(secret);
    expect(readLegacyWorkspaceJoinSecret()).toEqual(secret);
    expect(readPreservedWorkspaceJoinContext()).toBeNull();
    preserveWorkspaceJoinContext(prepared.context);
    expect(storage.getItem(legacyKey)).toBeNull();
    expect(readPreservedWorkspaceJoinContext()).toEqual(prepared.context);
  });

  it("retains the legacy recovery input if the browser cookie roundtrip fails", async () => {
    const secret = { kind: "enrollment" as const, token: "legacy-roundtrip-synthetic" };
    storage.setItem(legacyKey, JSON.stringify(secret));
    api.mockImplementation(async (path, options) => {
      if (path.endsWith("/preview")) throw new Error("Synthetic cookie rejected");
      return { contextId: path.split("/").at(-1), sourceKind: JSON.parse(options?.body as string).sourceKind };
    });
    await expect(prepareWorkspaceJoinContext(secret)).rejects.toThrow("Synthetic cookie rejected");
    expect(readLegacyWorkspaceJoinSecret()).toEqual(secret);
    expect(readPreservedWorkspaceJoinContext()).toBeNull();
  });

  it.each(["context", "kind"])("rejects a mismatched %s receipt without discarding recovery", async field => {
    const secret = { kind: "invitation" as const, token: `mismatch-${field}-synthetic` };
    storage.setItem(legacyKey, JSON.stringify(secret));
    api.mockImplementation(async path => ({ contextId: field === "context" ? contextId : path.split("/").at(-1), sourceKind: field === "kind" ? 2 : 1 }));
    await expect(prepareWorkspaceJoinContext(secret)).rejects.toThrow("could not be confirmed");
    expect(api).toHaveBeenCalledTimes(1);
    expect(readLegacyWorkspaceJoinSecret()).toEqual(secret);
  });

  it("shares an in-flight preparation without creating a second credential context", async () => {
    const secret = { kind: "enrollment" as const, token: "strict-mode-synthetic" };
    const first = prepareWorkspaceJoinContext(secret);
    const second = prepareWorkspaceJoinContext(secret);
    expect(second).toBe(first);
    const prepared = await first;
    expect(prepared).toEqual(await second);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("persists only the public projection even if a caller supplies extra credential fields", () => {
    preserveWorkspaceJoinContext({ ...context, token: "extra-field-synthetic" } as WorkspaceJoinContext);
    expect(JSON.parse(storage.getItem(contextKey)!)).toEqual(context);
    expect(JSON.stringify(Object.entries(storage))).not.toContain("extra-field-synthetic");
  });

  it("keeps an existing continuation if the new metadata cannot be saved", () => {
    storage.setItem(legacyKey, JSON.stringify({ kind: "enrollment", token: "storage-full-synthetic" }));
    vi.stubGlobal("window", { sessionStorage: {
      getItem: storage.getItem,
      setItem: () => { throw new DOMException("Full", "QuotaExceededError"); },
      removeItem: storage.removeItem,
    } });
    expect(() => preserveWorkspaceJoinContext(context)).toThrow("Full");
    expect(storage.getItem(legacyKey)).toContain("storage-full-synthetic");
  });

  it("resumes sign-in and MFA at the pending join without changing account-link destinations", () => {
    preserveWorkspaceJoinContext(context);
    expect(workspaceJoinAuthenticationDestination("/")).toBe("/join");
    expect(workspaceJoinAuthenticationDestination("/account?external=linked")).toBe("/account?external=linked");
  });

  it("resumes legacy external sign-in at migration and ignores invalid context metadata", () => {
    storage.setItem(contextKey, JSON.stringify({ kind: "enrollment", contextId: "../invalid" }));
    expect(readPreservedWorkspaceJoinContext()).toBeNull();
    expect(workspaceJoinAuthenticationDestination("/")).toBe("/");
    storage.setItem(legacyKey, JSON.stringify({ kind: "invitation", token: "legacy-sign-in-synthetic" }));
    expect(workspaceJoinAuthenticationDestination("/")).toBe("/join");
  });

  it("clears local recovery immediately and uses the same context path and header for cookie cleanup", async () => {
    preserveWorkspaceJoinContext(context);
    clearPreservedWorkspaceJoinContext(context);
    expect(readPreservedWorkspaceJoinContext()).toBeNull();
    expect(readLegacyWorkspaceJoinSecret()).toBeNull();
    expect(api).toHaveBeenCalledWith(workspaceJoinContextPath(context), {
      method: "DELETE", headers: { "X-BunkFy-Join-Context": contextId },
    });
    await Promise.resolve();
  });

  it("never uses an invalid or empty context as a request path", () => {
    expect(() => workspaceJoinContextPath({ kind: "enrollment", contextId: "../invalid" })).toThrow();
    expect(() => workspaceJoinContextPath({ kind: "enrollment", contextId: "00000000-0000-0000-0000-000000000000" })).toThrow();
    expect(parseWorkspaceJoinSecret("#invitation=%20")).toBeNull();
  });

  it("does not let late cleanup of an older page discard a newer continuation", () => {
    const newer: WorkspaceJoinContext = { kind: "invitation", contextId: "22222222-2222-4222-8222-222222222222" };
    preserveWorkspaceJoinContext(context);
    preserveWorkspaceJoinContext(newer);
    clearPreservedWorkspaceJoinContext(context);
    expect(readPreservedWorkspaceJoinContext()).toEqual(newer);
    expect(api).toHaveBeenCalledWith(workspaceJoinContextPath(context), {
      method: "DELETE", headers: { "X-BunkFy-Join-Context": contextId },
    });
  });
});
