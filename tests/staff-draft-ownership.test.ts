import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffProfileDraft } from "../src/features/workspaces/staffOnboarding";

const subjectA = "11111111-1111-4111-8111-111111111111";
const subjectB = "33333333-3333-4333-8333-333333333333";
const profile: StaffProfileDraft = {
  displayName: "Synthetic A", legalName: "Synthetic Legal Person A",
  workEmail: "synthetic-a@example.invalid", workPhone: "", jobTitle: "Synthetic role", department: "",
};
let values: Map<string, string>;
let store: Storage;
let drafts: typeof import("../src/features/workspaces/staffOnboarding");

beforeEach(async () => {
  vi.resetModules();
  values = new Map();
  store = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
  vi.stubGlobal("window", { sessionStorage: store });
  drafts = await import("../src/features/workspaces/staffOnboarding");
});
afterEach(() => vi.unstubAllGlobals());

describe("authenticated invitation draft ownership", () => {
  it("keeps two subjects separate when their fallback display username is identical", () => {
    drafts.saveInviteStaffDraft(profile, subjectA);
    expect(drafts.readInviteStaffDraft(subjectB, "GitHub account")).toEqual(drafts.defaultStaffProfile());
    expect(drafts.readInviteStaffDraft(subjectA, "GitHub account")).toEqual(profile);
    expect([...values.keys()]).toEqual([`bunkfy.invite.staff-profile.v3:${subjectA}`]);
  });

  it("recovers the same subject after a module reload without a display-name binding", async () => {
    drafts.saveInviteStaffDraft(profile, subjectA);
    vi.resetModules();
    const reloaded = await import("../src/features/workspaces/staffOnboarding");
    expect(reloaded.readInviteStaffDraft(subjectA, "Renamed account")).toEqual(profile);
    expect(reloaded.readInviteStaffDraft(subjectB, "GitHub account").legalName).toBe("");
  });

  it("rejects a stored envelope attributed to a different authenticated subject", () => {
    values.set(`bunkfy.invite.staff-profile.v3:${subjectB}`, JSON.stringify({ version: 1, subjectId: subjectA, profile }));
    expect(drafts.readInviteStaffDraft(subjectB)).toEqual(drafts.defaultStaffProfile());
  });

  it("does not infer ownership of legacy drafts from a reusable username", () => {
    const legacy = JSON.stringify(profile);
    values.set("bunkfy.invite.staff-profile.v1", legacy);
    values.set("bunkfy.invite.staff-profile.v2:github%20account", legacy);
    expect(drafts.readInviteStaffDraft(subjectB, "GitHub account")).toEqual(drafts.defaultStaffProfile());
    expect(values.get("bunkfy.invite.staff-profile.v1")).toBe(legacy);
  });

  it("does not save an anonymous or display-name-only owner", () => {
    drafts.saveInviteStaffDraft(profile, "GitHub account");
    drafts.saveInviteStaffDraft(profile);
    expect(values.size).toBe(0);
  });

  it("keeps the authenticated handoff usable and clearable when browser storage is blocked", () => {
    const blocked = () => { throw new DOMException("Storage blocked", "SecurityError"); };
    vi.stubGlobal("window", { sessionStorage: { getItem: blocked, setItem: blocked, removeItem: blocked } });
    expect(() => drafts.saveInviteStaffDraft(profile, subjectA)).not.toThrow();
    expect(drafts.readInviteStaffDraft(subjectA)).toEqual(profile);
    expect(drafts.readInviteStaffDraft(subjectB)).toEqual(drafts.defaultStaffProfile());
    expect(() => drafts.clearInviteStaffDraft(subjectA)).not.toThrow();
    expect(drafts.readInviteStaffDraft(subjectA)).toEqual(drafts.defaultStaffProfile());
  });

  it("does not resurrect a cleared draft if removal is denied while reads still work", async () => {
    drafts.saveInviteStaffDraft(profile, subjectA);
    vi.resetModules();
    drafts = await import("../src/features/workspaces/staffOnboarding");
    store.removeItem = () => { throw new DOMException("Removal blocked", "SecurityError"); };
    drafts.clearInviteStaffDraft(subjectA);
    expect(drafts.readInviteStaffDraft(subjectA)).toEqual(drafts.defaultStaffProfile());
  });

});
