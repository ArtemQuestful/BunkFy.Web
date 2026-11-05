const PENDING_ENROLLMENT_KEY = "bunkfy.join.pending-enrollment.v3:";
const LEGACY_PENDING_ENROLLMENT_KEY = "bunkfy.join.pending-enrollment.v2";

// This is only a recovery hint. The application endpoint remains authoritative
// for status, ownership and access. Never retain a join credential here.
export function hasPendingEnrollment(
  sourceId: string | null | undefined,
  subjectId: string | undefined,
): boolean {
  clearLegacyPendingEnrollment();
  if (!sourceId || !subjectId) return false;
  try {
    return window.sessionStorage.getItem(pendingEnrollmentKey(subjectId)) === sourceId;
  } catch {
    return false;
  }
}

export function rememberPendingEnrollment(
  sourceId: string | null | undefined,
  subjectId: string | undefined,
): void {
  clearLegacyPendingEnrollment();
  if (!sourceId || !subjectId) return;
  try {
    window.sessionStorage.setItem(pendingEnrollmentKey(subjectId), sourceId);
  } catch {
    // Storage can be disabled or full. Server application polling still works.
  }
}

export function forgetPendingEnrollment(
  sourceId: string | null | undefined,
  subjectId: string | undefined,
): void {
  if (!hasPendingEnrollment(sourceId, subjectId) || !subjectId) return;
  try {
    window.sessionStorage.removeItem(pendingEnrollmentKey(subjectId));
  } catch {
    // A failed local cleanup cannot change the authoritative application.
  }
}

function pendingEnrollmentKey(subjectId: string): string {
  return PENDING_ENROLLMENT_KEY + encodeURIComponent(subjectId);
}

export function clearLegacyPendingEnrollment(): void {
  try {
    // Old markers contain reusable tokens. Remove every account's old marker
    // without reading it; recovery uses the source ID and server application.
    const keys = Object.keys(window.sessionStorage).filter(key =>
      key === LEGACY_PENDING_ENROLLMENT_KEY || key.startsWith(LEGACY_PENDING_ENROLLMENT_KEY + ":"),
    );
    for (const key of keys) window.sessionStorage.removeItem(key);
  } catch {
    // The marker is optional when browser storage is unavailable.
  }
}
