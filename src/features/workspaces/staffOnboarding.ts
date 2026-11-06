import { ApiError } from "../../api/client";
import type {
  StaffMember,
  StaffMemberMutationReceipt,
} from "../../api/types";
import {
  clearStaffProfileUpdateAttempt,
  readStaffProfileUpdateAttempt,
  resolveDurableStaffProfileUpdateAttempt,
  saveStaffProfileUpdateAttempt,
} from "../staff/staffProfileUpdateAttempt";

const INVITE_STAFF_DRAFT_KEY = "bunkfy.invite.staff-profile.v3";
const inviteDraftMemory = new Map<string, StaffProfileDraft | null>();

export type StaffProfileDraft = {
  displayName: string;
  legalName: string;
  workEmail: string;
  workPhone: string;
  jobTitle: string;
  department: string;
};

export function defaultStaffProfile(email = ""): StaffProfileDraft {
  const localPart = email.split("@")[0] ?? "";
  const suggestedName = localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return {
    displayName: suggestedName,
    legalName: "",
    workEmail: email,
    workPhone: "",
    jobTitle: "",
    department: "",
  };
}

export function saveInviteStaffDraft(
  profile: StaffProfileDraft,
  subjectId = "",
): void {
  const owner = draftSubject(subjectId);
  if (!owner) return;
  const ownedProfile = { ...profile };
  inviteDraftMemory.set(owner, ownedProfile);
  try {
    window.sessionStorage.setItem(
      staffDraftKey(owner),
      JSON.stringify({ version: 1, subjectId: owner, profile: ownedProfile }),
    );
  } catch {
    // The authenticated owner's draft remains usable in this page when storage is blocked.
  }
}

export function readInviteStaffDraft(subjectId = "", email = ""): StaffProfileDraft {
  const fallback = defaultStaffProfile(email.includes("@") ? email : "");
  const owner = draftSubject(subjectId);
  if (!owner) return fallback;
  if (inviteDraftMemory.has(owner)) {
    const memory = inviteDraftMemory.get(owner);
    return memory ? { ...memory } : fallback;
  }
  try {
    const stored = window.sessionStorage.getItem(staffDraftKey(owner));
    if (!stored || stored.length > 16_384) return fallback;
    const parsed = JSON.parse(stored) as {
      version?: unknown;
      subjectId?: unknown;
      profile?: Partial<Record<keyof StaffProfileDraft, unknown>>;
    } | null;
    if (parsed?.version !== 1 || parsed.subjectId !== owner || !parsed.profile) return fallback;
    const profile = parsed.profile;
    return {
      displayName: typeof profile.displayName === "string" ? profile.displayName : fallback.displayName,
      legalName: typeof profile.legalName === "string" ? profile.legalName : fallback.legalName,
      workEmail: typeof profile.workEmail === "string" ? profile.workEmail : fallback.workEmail,
      workPhone: typeof profile.workPhone === "string" ? profile.workPhone : fallback.workPhone,
      jobTitle: typeof profile.jobTitle === "string" ? profile.jobTitle : fallback.jobTitle,
      department: typeof profile.department === "string" ? profile.department : fallback.department,
    };
  } catch {
    return fallback;
  }
}

export function clearInviteStaffDraft(subjectId = ""): void {
  const owner = draftSubject(subjectId);
  if (!owner) return;
  inviteDraftMemory.set(owner, null);
  try {
    window.sessionStorage.removeItem(staffDraftKey(owner));
  } catch {
    // Clearing in-memory ownership must still complete when storage is unavailable.
  }
}

export async function completeCurrentStaffProfile(
  request: <T>(path: string, options?: RequestInit) => Promise<T>,
  profile: StaffProfileDraft,
): Promise<StaffMember> {
  const current = await waitForCurrentStaffProfile(request);
  const payload = {
    displayName: profile.displayName.trim(),
    legalName: emptyToNull(profile.legalName),
    workEmail: emptyToNull(profile.workEmail),
    workPhone: emptyToNull(profile.workPhone),
    jobTitle: emptyToNull(profile.jobTitle),
    department: emptyToNull(profile.department),
  };
  const attempt = await resolveDurableStaffProfileUpdateAttempt(
    readStaffProfileUpdateAttempt(current.staffMemberId),
    current.staffMemberId,
    current.version,
    payload,
  );
  saveStaffProfileUpdateAttempt(attempt);
  try {
    await request<StaffMemberMutationReceipt>("/api/staff/me", {
      method: "PUT",
      body: JSON.stringify({
        ...payload,
        operationId: attempt.operationId,
        expectedVersion: attempt.expectedVersion,
      }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      clearStaffProfileUpdateAttempt(current.staffMemberId);
    }
    throw error;
  }

  const updated = await waitForCurrentStaffProfile(request);
  clearStaffProfileUpdateAttempt(current.staffMemberId);
  return updated;
}

async function waitForCurrentStaffProfile(
  request: <T>(path: string, options?: RequestInit) => Promise<T>,
): Promise<StaffMember> {
  const deadline = Date.now() + 12_000;
  while (true) {
    try {
      return await request<StaffMember>("/api/staff/me");
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404 || Date.now() >= deadline) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
  }
}

function emptyToNull(value: string): string | null {
  return value.trim() || null;
}

function staffDraftKey(subjectId: string): string {
  return `${INVITE_STAFF_DRAFT_KEY}:${subjectId}`;
}

function draftSubject(value: string): string | null {
  // Legacy username-only entries have no authenticated owner binding. Keep
  // them untouched and never infer their owner from a reusable display label.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}
