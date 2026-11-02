import type {
  OrganizationListResponse,
  OrganizationMembershipSummary,
} from "../../api/types";

type ApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export async function loadAllWorkspaces(
  request: ApiRequest,
  signal?: AbortSignal,
): Promise<OrganizationMembershipSummary[]> {
  const byId = new Map<string, OrganizationMembershipSummary>();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    throwIfAborted(signal);
    const response = await request<OrganizationListResponse>(
      `/api/organizations?page=${page}&pageSize=${PAGE_SIZE}`,
      { signal },
    );
    throwIfAborted(signal);

    const previousCount = byId.size;
    for (const item of response.items) {
      const id = item.organization.organizationId;
      if (!byId.has(id)) byId.set(id, item);
    }

    if (!response.hasMore) {
      return [...byId.values()];
    }

    if (byId.size === previousCount) {
      throw new Error(
        `Workspace pagination made no progress on page ${page}.`,
      );
    }
  }

  throw new Error(`Workspace pagination exceeded ${MAX_PAGES} pages.`);
}

export function resolveSelectedWorkspaceId(
  workspaces: OrganizationMembershipSummary[],
  selectedWorkspaceId: string,
): string {
  return workspaces.some(
    (item) => item.organization.organizationId === selectedWorkspaceId,
  )
    ? selectedWorkspaceId
    : workspaces[0]?.organization.organizationId ?? "";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The workspace request was aborted.", "AbortError");
}
