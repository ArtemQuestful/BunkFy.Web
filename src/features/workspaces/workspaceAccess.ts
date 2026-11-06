import { ApiError } from "../../api/client";
import type { OrganizationMembershipSummary } from "../../api/types";

type ApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

export async function waitForWorkspaceMembership(
  loadMemberships: () => Promise<OrganizationMembershipSummary[]>,
  workspaceId: string,
  options: { timeoutMs?: number; retryDelayMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  if (!workspaceId.trim()) throw new Error("A workspace is required.");
  const deadline = Date.now() + (options.timeoutMs ?? 75_000);
  const retryDelayMs = options.retryDelayMs ?? 400;
  let retryAttempt = 0;

  while (true) {
    options.signal?.throwIfAborted();
    if (retryAttempt > 0 && Date.now() >= deadline) {
      throw new Error("Your workspace membership is still being prepared. Try again in a moment.");
    }
    let nextDelayMs = Math.min(retryDelayMs * 2 ** Math.min(retryAttempt, 4), 1_600);
    try {
      const memberships = await loadMemberships();
      options.signal?.throwIfAborted();
      if (memberships.some(item => item.organization.organizationId === workspaceId)) return;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 429 || error.code !== "Http.RateLimitExceeded") throw error;
      nextDelayMs = Math.max(nextDelayMs, error.retryAfterMs ?? 0);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Your workspace membership is still being prepared. Try again in a moment.");
    }
    retryAttempt += 1;
    await waitForRetry(Math.min(nextDelayMs, remainingMs), options.signal);
  }
}

export async function waitForWorkspaceAccess(
  request: ApiRequest,
  workspaceId: string,
  options: {
    timeoutMs?: number;
    retryDelayMs?: number;
    maximumRetryDelayMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  if (!workspaceId.trim()) throw new Error("A workspace is required.");
  const timeoutMs = options.timeoutMs ?? 75_000;
  const retryDelayMs = options.retryDelayMs ?? 400;
  const maximumRetryDelayMs = Math.max(
    retryDelayMs,
    options.maximumRetryDelayMs ?? 1_600,
  );
  const deadline = Date.now() + timeoutMs;
  let retryAttempt = 0;

  while (true) {
    options.signal?.throwIfAborted();
    if (retryAttempt > 0 && Date.now() >= deadline) {
      throw new Error("Workspace access is still being prepared. Try again in a moment.");
    }
    let nextDelayMs: number;
    try {
      // The visible-properties query succeeds for both tenant-wide owners and
      // property-scoped staff once their access grants are available.
      if (options.signal) {
        await request<unknown>("/api/properties?page=1&pageSize=1", { signal: options.signal });
      } else {
        await request<unknown>("/api/properties?page=1&pageSize=1");
      }
      options.signal?.throwIfAborted();
      return;
    } catch (error) {
      if (!isWorkspaceAccessPending(error)) throw error;
      nextDelayMs = Math.max(
        error.retryAfterMs ?? 0,
        Math.min(
          retryDelayMs * 2 ** Math.min(retryAttempt, 4),
          maximumRetryDelayMs,
        ),
      );
      retryAttempt += 1;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Workspace access is still being prepared. Try again in a moment.");
    }

    await waitForRetry(Math.min(nextDelayMs, remainingMs), options.signal);
  }
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(signal?.reason);
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function isWorkspaceAccessPending(error: unknown): error is ApiError {
  return error instanceof ApiError && (
    error.status === 403 ||
    (error.status === 429 && error.code === "Http.RateLimitExceeded")
  );
}
