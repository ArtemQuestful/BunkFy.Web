import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { accessChecksMatchTenant } from "../src/app/permissions";
import { waitForWorkspaceAccess, waitForWorkspaceMembership } from "../src/features/workspaces/workspaceAccess";
import type { OrganizationMembershipSummary } from "../src/api/types";

const membership = { organization: { organizationId: "approved-workspace" } } as OrganizationMembershipSummary;

describe("workspace membership catalogue convergence", () => {
  it("waits for the approved workspace rather than accepting an existing different membership", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockResolvedValueOnce([{ organization: { organizationId: "home" } }]).mockResolvedValueOnce([membership]);
      const ready = waitForWorkspaceMembership(load, "approved-workspace");
      await vi.advanceTimersByTimeAsync(399);
      expect(load).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await ready;
      expect(load).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("bounds missing-membership retries and reports a retryable failure", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockResolvedValue([]);
      const ready = waitForWorkspaceMembership(load, "approved-workspace", { timeoutMs: 1000 });
      const failure = expect(ready).rejects.toThrow("workspace membership is still being prepared");
      await vi.advanceTimersByTimeAsync(1000);
      await failure;
      expect(load).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("honors the actual known rate-limit Retry-After response", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockRejectedValueOnce(new ApiError("Limited", 429, "Http.RateLimitExceeded", 1500)).mockResolvedValueOnce([membership]);
      const ready = waitForWorkspaceMembership(load, "approved-workspace", { timeoutMs: 2000 });
      await vi.advanceTimersByTimeAsync(1499);
      expect(load).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await ready;
      expect(load).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it.each([401, 403, 500, 503])("does not retry or waive HTTP %s failures", async status => {
    const load = vi.fn().mockRejectedValue(new ApiError("Unavailable", status));
    await expect(waitForWorkspaceMembership(load, "approved-workspace")).rejects.toThrow("Unavailable");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not retry before a Retry-After that exceeds the membership deadline", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockRejectedValue(new ApiError("Limited", 429, "Http.RateLimitExceeded", 2000));
      const ready = waitForWorkspaceMembership(load, "approved-workspace", { timeoutMs: 1000 });
      const failure = expect(ready).rejects.toThrow("workspace membership is still being prepared");
      await vi.advanceTimersByTimeAsync(1000);
      await failure;
      expect(load).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("stops waiting when the user leaves or the joining account changes", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const load = vi.fn().mockResolvedValue([]);
      const ready = waitForWorkspaceMembership(load, "approved-workspace", { signal: controller.signal });
      const failure = expect(ready).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await failure;
      await vi.advanceTimersByTimeAsync(5000);
      expect(load).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("rejects an aborted late catalogue response before it can activate a workspace", async () => {
    const controller = new AbortController();
    let release!: (memberships: OrganizationMembershipSummary[]) => void;
    const load = () => new Promise<OrganizationMembershipSummary[]>(resolve => { release = resolve; });
    const ready = waitForWorkspaceMembership(load, "approved-workspace", { signal: controller.signal });
    const failure = expect(ready).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    release([membership]);
    await failure;
  });
});

describe("workspace access readiness", () => {
  it("does not retry early when access Retry-After exceeds the deadline", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockRejectedValue(new ApiError("Limited", 429, "Http.RateLimitExceeded", 2000));
      const ready = waitForWorkspaceAccess(request, "approved-workspace", { timeoutMs: 1000 });
      const failure = expect(ready).rejects.toThrow("Workspace access is still being prepared");
      await vi.advanceTimersByTimeAsync(1000);
      await failure;
      expect(request).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("does not evaluate tenant permissions until the session uses that workspace", () => {
    const checks = [{ permission: "properties.read", scope: "tenant:workspace-a" }];

    expect(accessChecksMatchTenant("global", checks)).toBe(false);
    expect(accessChecksMatchTenant("workspace-b", checks)).toBe(false);
    expect(accessChecksMatchTenant("workspace-a", checks)).toBe(true);
    expect(accessChecksMatchTenant("workspace-a", [{
      permission: "inventory.read",
      scope: "tenant:workspace-a/property:property-a",
    }])).toBe(true);
  });

  it("waits until visible properties can resolve property-scoped access", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new ApiError("Access denied.", 403, "Properties.AccessDenied"))
      .mockResolvedValueOnce({ items: [], page: 1, pageSize: 1, hasMore: false });

    await waitForWorkspaceAccess(request, "workspace-a", {
      timeoutMs: 1_000,
      retryDelayMs: 0,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(
      "/api/properties?page=1&pageSize=1",
    );
  });

  it("backs off repeated access denials while the workspace projection converges", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn()
        .mockRejectedValueOnce(new ApiError("Access denied.", 403, "Properties.AccessDenied"))
        .mockRejectedValueOnce(new ApiError("Access denied.", 403, "Properties.AccessDenied"))
        .mockResolvedValueOnce({ items: [], page: 1, pageSize: 1, hasMore: false });

      const ready = waitForWorkspaceAccess(request, "workspace-a", {
        timeoutMs: 5_000,
        retryDelayMs: 400,
        maximumRetryDelayMs: 1_600,
      });

      await vi.advanceTimersByTimeAsync(399);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(799);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await ready;
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors a known rate-limit response while access is converging", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new ApiError(
        "Too many requests.",
        429,
        "Http.RateLimitExceeded",
        0,
      ))
      .mockResolvedValueOnce({ items: [], page: 1, pageSize: 1, hasMore: false });

    await waitForWorkspaceAccess(request, "workspace-a", {
      timeoutMs: 1_000,
      retryDelayMs: 0,
    });

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reports a delayed projection instead of navigating into a denial", async () => {
    const request = vi.fn().mockRejectedValue(
      new ApiError("Access denied.", 403, "Properties.AccessDenied"),
    );

    await expect(waitForWorkspaceAccess(request, "workspace-a", {
      timeoutMs: 0,
      retryDelayMs: 0,
    })).rejects.toThrow("Workspace access is still being prepared");
  });

  it("does not retry authentication or server failures", async () => {
    const request = vi.fn().mockRejectedValue(new ApiError("Signed out.", 401));

    await expect(waitForWorkspaceAccess(request, "workspace-a", {
      timeoutMs: 1_000,
      retryDelayMs: 0,
    })).rejects.toThrow("Signed out.");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unrelated rate-limit contract", async () => {
    const request = vi.fn().mockRejectedValue(
      new ApiError("Try later.", 429, "Provider.RateLimitExceeded", 0),
    );

    await expect(waitForWorkspaceAccess(request, "workspace-a", {
      timeoutMs: 1_000,
      retryDelayMs: 0,
    })).rejects.toThrow("Try later.");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
