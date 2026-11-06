import {
  assertRequestCanStart,
  networkRequestFailure,
} from "./requestConnectivity";
import { parseAuthenticationChallenge, type AuthenticationChallenge } from "./authenticationChallenge";

export type ApiSession = {
  accessToken: string;
  tenantId: string;
  username: string;
  subjectId?: string;
  sessionId?: string;
  generation?: string;
};
export type ApiDownload = { blob: Blob; fileName: string | null; contentType: string | null };

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly retryAfterMs?: number,
    public readonly referenceId?: string,
    public readonly authenticationChallenge?: AuthenticationChallenge,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let rememberedBrowserTransport: { generation: number; csrfToken: string } | null = null;

// Non-authoritative, memory-only transport context returned by the Auth owner.
// It never holds an account list, PIN, bearer, refresh credential or device proof.
export function setRememberedBrowserTransport(context: { generation: number; csrfToken: string } | null): void {
  if (context && (!Number.isSafeInteger(context.generation) || context.generation < 0 ||
    !context.csrfToken || context.csrfToken.length > 4096)) throw new Error("Invalid shared-browser context.");
  rememberedBrowserTransport = context ? { ...context } : null;
}

function rememberedHeaders(headers: Headers): void {
  if (!rememberedBrowserTransport) return;
  headers.set("X-Gma-Remembered-Generation", String(rememberedBrowserTransport.generation));
  headers.set("X-Gma-Remembered-CSRF", rememberedBrowserTransport.csrfToken);
}

export function accessTokenSubjectId(accessToken: string): string {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3 || !parts[1]) throw new Error("Malformed token.");
    const base64 = parts[1].replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (parts[1].length % 4)) % 4);
    const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      sub?: unknown;
    };
    if (
      typeof payload.sub !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.sub)
    ) {
      throw new Error("Token subject is missing.");
    }
    return payload.sub.toLowerCase();
  } catch {
    throw new Error("The authenticated account identity is unavailable.");
  }
}

export function resolveApiBaseUrl(): string {
  return trimTrailingSlash(import.meta.env.VITE_BUNKFY_API_BASE_URL?.trim() || "http://localhost:5194");
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  session?: Pick<ApiSession, "accessToken" | "tenantId">,
  ownerOutcome?: { statuses: readonly number[]; parse: (payload: unknown, response: Response) => T },
): Promise<T> {
  const headers = new Headers(options.headers);
  rememberedHeaders(headers);
  headers.set("Accept", "application/json");

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (session?.tenantId) headers.set("X-Tenant-Id", session.tenantId);
  if (session?.accessToken) headers.set("Authorization", `Bearer ${session.accessToken}`);

  const response = await fetchWithConnectivity(`${resolveApiBaseUrl()}${path}`, {
    ...options,
    credentials: "include",
    headers,
  });

  // Explicit owner-outcome endpoints may return their typed result at declared
  // failure statuses. Callers must validate that DTO; ordinary requests retain
  // strict error handling and never turn an HTTP failure into success.
  if (!response.ok && !ownerOutcome?.statuses.includes(response.status)) {
    throw await toApiError(response);
  }

  if (ownerOutcome) return ownerOutcome.parse(await response.json(), response);

  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function apiDownload(
  path: string,
  options: RequestInit = {},
  session?: Pick<ApiSession, "accessToken" | "tenantId">,
): Promise<ApiDownload> {
  const headers = new Headers(options.headers);
  rememberedHeaders(headers);
  headers.set("Accept", "application/octet-stream");
  if (session?.tenantId) headers.set("X-Tenant-Id", session.tenantId);
  if (session?.accessToken) headers.set("Authorization", `Bearer ${session.accessToken}`);

  const response = await fetchWithConnectivity(`${resolveApiBaseUrl()}${path}`, {
    ...options,
    credentials: "include",
    headers,
  });
  if (!response.ok) throw await toApiError(response);
  return {
    blob: await response.blob(),
    fileName: fileNameFromDisposition(response.headers.get("content-disposition")),
    contentType: response.headers.get("content-type"),
  };
}

export async function apiStream(
  path: string,
  signal: AbortSignal,
  session?: Pick<ApiSession, "accessToken" | "tenantId">,
): Promise<Response> {
  const headers = new Headers({ Accept: "text/event-stream" });
  rememberedHeaders(headers);
  if (session?.tenantId) headers.set("X-Tenant-Id", session.tenantId);
  if (session?.accessToken) headers.set("Authorization", `Bearer ${session.accessToken}`);
  const response = await fetchWithConnectivity(`${resolveApiBaseUrl()}${path}`, { credentials: "include", headers, signal });
  if (!response.ok) throw await toApiError(response);
  return response;
}

async function toApiError(response: Response): Promise<ApiError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  const title = getString(payload, "title");
  const detail = getString(payload, "detail") || getString(payload, "message") || title;
  const code = getString(payload, "code") ||
    getNestedString(payload, "error", "code") ||
    (isErrorCode(title) ? title : undefined);
  const referenceId = safeReferenceId(
    getString(payload, "requestId") ||
      getString(payload, "traceId") ||
      getString(payload, "correlationId") ||
      getNestedString(payload, "extensions", "requestId") ||
      getNestedString(payload, "extensions", "traceId") ||
      response.headers.get("x-request-id") ||
      response.headers.get("x-correlation-id") ||
      undefined,
  );
  return new ApiError(
    detail || `Request failed with HTTP ${response.status}`,
    response.status,
    code,
    parseRetryAfterMilliseconds(response.headers.get("retry-after")),
    referenceId,
    response.status === 401 && code === "Security.InsufficientAuthentication"
      ? parseAuthenticationChallenge(response.headers.get("www-authenticate"))
      : undefined,
  );
}

async function fetchWithConnectivity(
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  assertRequestCanStart(init);
  try {
    return await fetch(input, init);
  } catch (error) {
    throw networkRequestFailure(error);
  }
}

export function parseRetryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function isErrorCode(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/.test(value));
}

function getString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function getNestedString(value: unknown, parent: string, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return getString((value as Record<string, unknown>)[parent], key);
}

function safeReferenceId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[A-Za-z0-9._:-]{4,128}$/.test(normalized)
    ? normalized
    : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function fileNameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (utf8) return decodeURIComponent(utf8);
  return /filename="?([^";]+)"?/i.exec(value)?.[1] ?? null;
}
