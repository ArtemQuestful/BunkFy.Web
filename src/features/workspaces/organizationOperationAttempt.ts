const STORAGE_KEY_PREFIX = "bunkfy.organizations.pending-operation.v1";

export type OrganizationOperationScope = {
  accountId: string;
  workspaceId: string;
  action: string;
};

export type OrganizationOperationAttempt = {
  version: 1;
  scopeDigest: string;
  intentDigest: string;
  operationId: string;
};

export type OrganizationOperationAttemptStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type OrganizationOperationAttemptOptions = {
  storage?: OrganizationOperationAttemptStorage;
  createOperationId?: () => string;
  assertCurrent?: () => void;
};

export async function resolveOrganizationOperationAttempt(
  current: OrganizationOperationAttempt | null,
  scope: OrganizationOperationScope,
  intentValues: string[],
  options: OrganizationOperationAttemptOptions = {},
): Promise<OrganizationOperationAttempt> {
  const storage = options.storage ?? window.sessionStorage;
  const scopeDigest = await organizationOperationScopeDigest(scope);
  const intentDigest = await organizationOperationIntentDigest(
    scopeDigest,
    intentValues,
  );
  options.assertCurrent?.();
  const candidate = isOrganizationOperationAttempt(current, scopeDigest)
    ? current
    : readAttempt(storage, scopeDigest);

  const attempt = candidate?.intentDigest === intentDigest
    ? candidate
    : {
        version: 1 as const,
        scopeDigest,
        intentDigest,
        operationId: (options.createOperationId ?? (() => crypto.randomUUID()))(),
      };

  // Persistence happens before the caller sends the request. If browser storage
  // is unavailable, setItem throws and the mutation fails closed without a send.
  storage.setItem(attemptStorageKey(scopeDigest), JSON.stringify(attempt));
  return attempt;
}

export async function readOrganizationOperationAttempt(
  scope: OrganizationOperationScope,
  storage: OrganizationOperationAttemptStorage = window.sessionStorage,
): Promise<OrganizationOperationAttempt | null> {
  return readAttempt(
    storage,
    await organizationOperationScopeDigest(scope),
  );
}

export async function clearOrganizationOperationAttempt(
  scope: OrganizationOperationScope,
  storage: Pick<Storage, "removeItem"> = window.sessionStorage,
  assertCurrent?: () => void,
): Promise<void> {
  const key = attemptStorageKey(await organizationOperationScopeDigest(scope));
  assertCurrent?.();
  storage.removeItem(key);
}

export async function organizationOperationScopeDigest(
  scope: OrganizationOperationScope,
): Promise<string> {
  return hashValues([
    "bunkfy-organizations-operation-scope-v1",
    scope.accountId.trim().toLowerCase(),
    scope.workspaceId.trim().toLowerCase(),
    scope.action.trim().toLowerCase(),
  ]);
}

async function organizationOperationIntentDigest(
  scopeDigest: string,
  intentValues: string[],
): Promise<string> {
  return hashValues([
    "bunkfy-organizations-operation-intent-v1",
    scopeDigest,
    ...intentValues,
  ]);
}

async function hashValues(values: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const chunks = values.map((value) => encoder.encode(value));
  const byteLength = chunks.reduce(
    (total, chunk) => total + 4 + chunk.byteLength,
    0,
  );
  const input = new Uint8Array(byteLength);
  const view = new DataView(input.buffer);
  let offset = 0;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.byteLength);
    offset += 4;
    input.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function readAttempt(
  storage: OrganizationOperationAttemptStorage,
  scopeDigest: string,
): OrganizationOperationAttempt | null {
  const key = attemptStorageKey(scopeDigest);
  const raw = storage.getItem(key);
  if (raw === null) return null;

  try {
    const value = JSON.parse(raw) as Partial<OrganizationOperationAttempt>;
    if (isOrganizationOperationAttempt(value, scopeDigest)) return value;
  } catch {
    // Corrupt records are removed below and are never reused.
  }

  storage.removeItem(key);
  return null;
}

function isOrganizationOperationAttempt(
  value: Partial<OrganizationOperationAttempt> | null,
  scopeDigest: string,
): value is OrganizationOperationAttempt {
  return value?.version === 1 &&
    value.scopeDigest === scopeDigest &&
    isDigest(value.intentDigest) &&
    isOperationId(value.operationId);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isOperationId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function attemptStorageKey(scopeDigest: string): string {
  return `${STORAGE_KEY_PREFIX}:${scopeDigest}`;
}
