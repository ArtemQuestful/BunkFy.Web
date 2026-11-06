import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client";
import type { WorkspaceStaffOnboarding, WorkspaceStaffOnboardingSummary, WorkspaceStaffOnboardingRecoveryAttempt } from "../src/api/types";
import { loadWorkspaceJoinReviews, WorkspaceJoinRecoveryOperations, attemptWorkspaceJoinRecovery } from "../src/features/workspaces/workspaceJoinReviews";

const application = (id = "application", status: 2 | 6 = 2): WorkspaceStaffOnboardingSummary => ({
  applicationId: id, sourceKind: 2, sourceId: "source", claimId: "claim", claimVersion: 1,
  status, version: 2, failureCode: null, createdAtUtc: "2026-11-06T00:00:00Z",
  lastChangedAtUtc: "2026-11-06T00:00:00Z", hasStaffTarget: false,
});
const review = (item = application()): WorkspaceStaffOnboarding => ({
  ...item, organizationId: "workspace", subjectId: "subject", verifiedAccountEmail: "applicant@example.test",
  displayName: "Applicant Name", legalName: "Legal Name", workEmail: null, workPhone: null,
  employeeNumber: null, jobTitle: "Front desk", department: null, staffMemberId: null,
});
const page = (items: WorkspaceStaffOnboardingSummary[]) => ({ items, page: 1, pageSize: 25, hasMore: false });
const receipt = (operationId: string, extra: Partial<WorkspaceStaffOnboardingRecoveryAttempt> = {}): WorkspaceStaffOnboardingRecoveryAttempt => ({
  operationId, applicationId: "application", outcome: 1, reason: 1, applicationStatus: 5,
  applicationVersion: 3, retryDirective: 0, retryAfterSeconds: null,
  recordedAtUtc: "2026-11-06T00:00:00Z", ...extra,
});

describe("bounded applicant review and Staff ownership", () => {
  it("hydrates one visible page with at most four concurrent profile reads", async () => {
    const items = Array.from({ length: 25 }, (_, i) => application(String(i)));
    let active = 0; let maximum = 0; let calls = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let fourStarted!: () => void;
    const started = new Promise<void>(resolve => { fourStarted = resolve; });
    const pending = loadWorkspaceJoinReviews(async <T>(path: string): Promise<T> => {
      if (path.includes("/summary?")) return page(items) as T;
      active++; calls++; maximum = Math.max(maximum, active);
      if (calls === 4) fourStarted();
      await barrier; active--;
      return review(items.find(item => path.includes(`/${item.applicationId}/review`))!) as T;
    }, 1, new AbortController().signal);
    await started;
    expect(calls).toBe(4);
    release();
    const result = await pending;
    expect(calls).toBe(25); expect(maximum).toBe(4);
    expect(Object.keys(result.reviews)).toHaveLength(25);
  });

  it("drops the previous profile when Staff takes ownership without a version change", async () => {
    let staffOwns = false; let profileReads = 0;
    const request = async <T>(path: string): Promise<T> => {
      if (path.includes("/summary?")) return page([application()]) as T;
      profileReads++;
      if (staffOwns) throw new ApiError("No longer available", 409);
      return review() as T;
    };
    const first = await loadWorkspaceJoinReviews(request, 1, new AbortController().signal);
    expect(first.reviews.application?.displayName).toBe("Applicant Name");
    staffOwns = true;
    const second = await loadWorkspaceJoinReviews(request, 1, new AbortController().signal);
    expect(second.items[0].version).toBe(first.items[0].version);
    expect(second.reviews.application).toBeUndefined();
    expect(second.reviewErrors.application).toContain("unavailable");
    expect(profileReads).toBe(2);
  });

  it.each([401, 403])("rejects the entire page when review authority returns %i", async status => {
    await expect(loadWorkspaceJoinReviews(async <T>(path: string): Promise<T> => {
      if (path.includes("/summary?")) return page([application()]) as T;
      throw new ApiError("Denied", status);
    }, 1, new AbortController().signal)).rejects.toMatchObject({ status });
  });

  it("stops queued reviews after one in-flight read loses authority", async () => {
    let reads = 0; let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const items = Array.from({ length: 25 }, (_, i) => application(String(i)));
    const pending = loadWorkspaceJoinReviews(async <T>(path: string): Promise<T> => {
      if (path.includes("/summary?")) return page(items) as T;
      reads++;
      if (reads === 1) throw new ApiError("Revoked", 403);
      await held;
      return review(items.find(item => path.includes(`/${item.applicationId}/review`))!) as T;
    }, 1, new AbortController().signal);
    await expect(pending).rejects.toMatchObject({ status: 403 });
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(reads).toBe(4);
  });

  it.each([{ version: 3 }, { claimVersion: 2 }, { applicationId: "someone-else" }, { staffMemberId: "staff" }])(
    "withholds a review which no longer matches its row: %j", async change => {
      const result = await loadWorkspaceJoinReviews(async <T>(path: string): Promise<T> =>
        (path.includes("/summary?") ? page([application()]) : { ...review(), ...change }) as T,
      1, new AbortController().signal);
      expect(result.reviews.application).toBeUndefined();
      expect(result.reviewErrors.application).toContain("changed");
    },
  );

  it("refuses oversized pages before issuing any profile reads", async () => {
    let calls = 0;
    await expect(loadWorkspaceJoinReviews(async <T>(): Promise<T> => {
      calls++; return page(Array.from({ length: 26 }, (_, i) => application(String(i)))) as T;
    }, 1, new AbortController().signal)).rejects.toThrow("Refresh");
    expect(calls).toBe(1);
  });

  it("keeps a reviewed pre-Staff failure independent of the receipted recovery rollout", async () => {
    const calls: string[] = []; const item = application("application", 6);
    const result = await loadWorkspaceJoinReviews(async <T>(path: string): Promise<T> => {
      calls.push(path);
      if (path.includes("/summary?")) return page([item]) as T;
      if (path.endsWith("/review")) return review(item) as T;
      throw new ApiError("Receipted recovery disabled", 404);
    }, 1, new AbortController().signal);
    expect(result.reviews.application?.displayName).toBe("Applicant Name");
    expect(calls).toHaveLength(2);
    expect(calls.some(path => path.includes("/recovery-attempts"))).toBe(false);
  });

  it("loads a recovery receipt after review refuses uncertain Staff ownership", async () => {
    const calls: string[] = []; const item = application("application", 6);
    const result = await loadWorkspaceJoinReviews(async <T>(path: string): Promise<T> => {
      calls.push(path);
      if (path.includes("/summary?")) return page([item]) as T;
      if (path.endsWith("/review")) throw new ApiError("Staff ownership changed", 409);
      return receipt("recorded-operation") as T;
    }, 1, new AbortController().signal);
    expect(result.reviews.application).toBeUndefined();
    expect(result.receipts.application?.operationId).toBe("recorded-operation");
    expect(calls.at(-1)).toMatch(/\/recovery-attempts\/latest$/);
  });

  it("does not fetch staging for a known Staff target, and distinguishes unavailable recovery status", async () => {
    const calls: string[] = [];
    const result = await loadWorkspaceJoinReviews(async <T>(path: string): Promise<T> => {
      calls.push(path);
      if (path.includes("/summary?")) return page([{ ...application("application", 6), hasStaffTarget: true }]) as T;
      throw new ApiError("Unavailable", 503);
    }, 1, new AbortController().signal);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/\/recovery-attempts\/latest$/);
    expect(result.reviews.application).toBeUndefined();
    expect(result.receiptErrors.application).toContain("unavailable");
  });

  it("stops queued profile work after the page is abandoned", async () => {
    const controller = new AbortController(); let profileReads = 0;
    await expect(loadWorkspaceJoinReviews(async <T>(path: string): Promise<T> => {
      if (path.includes("/summary?")) return page(Array.from({ length: 25 }, (_, i) => application(String(i)))) as T;
      profileReads++; controller.abort(); throw new Error("Abandoned");
    }, 1, controller.signal)).rejects.toThrow();
    expect(profileReads).toBeLessThanOrEqual(4);
  });
});

describe("receipted setup recovery", () => {
  it("replays the same operation and original expected version after a lost response", async () => {
    const operations = new WorkspaceJoinRecoveryOperations(); const bodies: string[] = [];
    const request = async <T>(_path: string, options?: RequestInit): Promise<T> => {
      bodies.push(String(options?.body));
      if (bodies.length === 1) throw new Error("Response lost");
      const intent = JSON.parse(bodies[1]); return receipt(intent.operationId) as T;
    };
    await expect(attemptWorkspaceJoinRecovery(request, operations, application("application", 6))).rejects.toThrow("Response lost");
    await attemptWorkspaceJoinRecovery(request, operations, { ...application("application", 6), version: 3 });
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[1]).expectedApplicationVersion).toBe(2);
  });

  it("waits for the receipt's delay, then uses a new operation and current version", () => {
    const operations = new WorkspaceJoinRecoveryOperations(); const item = application("application", 6);
    const first = operations.begin(item, undefined, 1_000);
    operations.record(item.applicationId, receipt(first.operationId, {
      outcome: 3, applicationVersion: 2, applicationStatus: 6, retryDirective: 1, retryAfterSeconds: 5,
    }), 1_000);
    expect(() => operations.begin(item, undefined, 5_999)).toThrow("Wait");
    const second = operations.begin({ ...item, version: 3 }, undefined, 6_000);
    expect(second.operationId).not.toBe(first.operationId);
    expect(second.expectedApplicationVersion).toBe(3);
  });

  it("requires an administrator's review instead of repeatedly retrying a definitive receipt", () => {
    const operations = new WorkspaceJoinRecoveryOperations();
    expect(() => operations.begin({ ...application("application", 6), version: 3 }, receipt("previous", { outcome: 2 })))
      .toThrow("administrator");
  });

  it("does not fall back to the unreceipted retry when recovery is disabled", async () => {
    const paths: string[] = [];
    await expect(attemptWorkspaceJoinRecovery(async <T>(path: string): Promise<T> => {
      paths.push(path); throw new ApiError("Not found", 404);
    }, new WorkspaceJoinRecoveryOperations(), application("application", 6))).rejects.toThrow("unavailable");
    expect(paths).toEqual(["/api/workspace-staff-enrollment/applications/application/recovery-attempts"]);
  });

  it("rejects another operation's response and retains the original retry intent", () => {
    const operations = new WorkspaceJoinRecoveryOperations(); const item = application("application", 6);
    const intent = operations.begin(item);
    expect(() => operations.record(item.applicationId, receipt("another-operation"))).toThrow("did not match");
    expect(operations.begin(item)).toEqual(intent);
  });
});
