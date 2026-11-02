import { describe, expect, it } from "vitest";
import type {
  OrganizationListResponse,
  OrganizationMembershipSummary,
} from "../src/api/types";
import {
  loadAllWorkspaces,
  resolveSelectedWorkspaceId,
} from "../src/features/workspaces/workspacesApi";

describe("workspace API pagination", () => {
  it("stops after one full page when there is no continuation", async () => {
    const paths: string[] = [];
    const result = await loadAllWorkspaces(async <T>(path: string): Promise<T> => {
      paths.push(path);
      return page(range(1, 100), false) as T;
    });

    expect(result).toHaveLength(100);
    expect(paths).toEqual(["/api/organizations?page=1&pageSize=100"]);
  });

  it("loads workspace 101 and preserves it as the selected tenant", async () => {
    const responses = [
      page(range(1, 100), true),
      page([101], false),
    ];
    const result = await loadAllWorkspaces(async <T>(): Promise<T> =>
      responses.shift() as T);

    expect(result).toHaveLength(101);
    expect(result.at(-1)?.organization.organizationId)
      .toBe(workspaceId(101));
    expect(resolveSelectedWorkspaceId(result, workspaceId(101)))
      .toBe(workspaceId(101));
  });

  it("passes one abort signal through and stops before another page", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    let calls = 0;

    await expect(loadAllWorkspaces(async <T>(
      _path: string,
      options?: RequestInit,
    ): Promise<T> => {
      calls += 1;
      signals.push(options?.signal);
      controller.abort(new DOMException("cancelled", "AbortError"));
      return page([1], true) as T;
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    expect(calls).toBe(1);
    expect(signals).toEqual([controller.signal]);
  });

  it("deduplicates page-boundary overlap in first-seen order", async () => {
    const responses = [
      page([1, 2], true),
      page([2, 3], false),
    ];
    const result = await loadAllWorkspaces(async <T>(): Promise<T> =>
      responses.shift() as T);

    expect(result.map((item) => item.organization.organizationId))
      .toEqual([workspaceId(1), workspaceId(2), workspaceId(3)]);
  });

  it("fails instead of looping when a continued page adds no workspace", async () => {
    const responses = [
      page([1, 2], true),
      page([1, 2], true),
    ];

    await expect(loadAllWorkspaces(async <T>(): Promise<T> =>
      responses.shift() as T))
      .rejects.toThrow("made no progress on page 2");
  });
});

function page(ids: number[], hasMore: boolean): OrganizationListResponse {
  return {
    items: ids.map(summary),
    page: 1,
    pageSize: 100,
    hasMore,
  };
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function summary(id: number): OrganizationMembershipSummary {
  const organizationId = workspaceId(id);
  return {
    organization: {
      organizationId,
      scopeId: organizationId,
      name: `Workspace ${id}`,
      slug: `workspace-${id}`,
      status: "active",
      activeOwnerCount: 1,
      version: 1,
      createdAtUtc: "2026-08-11T00:00:00Z",
      lastChangedAtUtc: "2026-08-11T00:00:00Z",
    },
    membership: {
      membershipId: `20000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
      organizationId,
      subjectId: "member-1",
      role: "owner",
      status: "active",
      version: 1,
      joinedAtUtc: "2026-08-11T00:00:00Z",
      lastChangedAtUtc: "2026-08-11T00:00:00Z",
    },
  };
}

function workspaceId(id: number): string {
  return `10000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
}
