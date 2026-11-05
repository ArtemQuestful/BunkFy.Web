import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetPendingEnrollment,
  hasPendingEnrollment,
  rememberPendingEnrollment,
} from "../src/features/workspaces/workspaceJoinPending";

const source = "11111111-1111-4111-8111-111111111111";
const otherSource = "22222222-2222-4222-8222-222222222222";
const subject = "33333333-3333-4333-8333-333333333333";
const otherSubject = "44444444-4444-4444-8444-444444444444";
const prefix = "bunkfy.join.pending-enrollment.v3:";
let storage: Storage;

beforeEach(() => {
  // Enumerate data keys as Web Storage does, without treating the methods as
  // stored data. The browser suite separately exercises the real storage API.
  const entries: Record<string, string> = Object.create(null);
  storage = Object.defineProperties(entries, {
    getItem: { value: (key: string) => entries[key] ?? null },
    setItem: { value: (key: string, value: string) => { entries[key] = value; } },
    removeItem: { value: (key: string) => { delete entries[key]; } },
  }) as unknown as Storage;
  vi.stubGlobal("window", { sessionStorage: storage });
});

afterEach(() => vi.unstubAllGlobals());

describe("pending workspace enrollment recovery hints", () => {
  it("records only the public source ID, scoped to the immutable subject ID", () => {
    rememberPendingEnrollment(source, subject);
    expect(Object.entries(storage)).toEqual([[prefix + subject, source]]);
    expect(hasPendingEnrollment(source, subject)).toBe(true);
    expect(hasPendingEnrollment(source, otherSubject)).toBe(false);
    expect(hasPendingEnrollment(otherSource, subject)).toBe(false);
  });

  it("does not erase another source or another account when an older request finishes", () => {
    rememberPendingEnrollment(source, subject);
    rememberPendingEnrollment(otherSource, subject);
    rememberPendingEnrollment(source, otherSubject);
    forgetPendingEnrollment(source, subject);
    expect(hasPendingEnrollment(otherSource, subject)).toBe(true);
    expect(hasPendingEnrollment(source, otherSubject)).toBe(true);
    forgetPendingEnrollment(otherSource, subject);
    expect(hasPendingEnrollment(otherSource, subject)).toBe(false);
    expect(hasPendingEnrollment(source, otherSubject)).toBe(true);
  });

  it("removes every legacy raw-token marker without touching separate recovery data", () => {
    storage.setItem("bunkfy.join.pending-enrollment.v2", "old-secret");
    storage.setItem("bunkfy.join.pending-enrollment.v2:one%40example.test", "one-secret");
    storage.setItem("bunkfy.join.pending-enrollment.v2:two%40example.test", "two-secret");
    storage.setItem("bunkfy.join.secret.v1", "separate-existing-continuation");
    storage.setItem("other.application.setting", "keep");
    expect(hasPendingEnrollment(source, subject)).toBe(false);
    expect(Object.entries(storage)).toEqual([
      ["bunkfy.join.secret.v1", "separate-existing-continuation"],
      ["other.application.setting", "keep"],
    ]);
  });

  it("does not create an anonymous or incomplete marker", () => {
    rememberPendingEnrollment(source, undefined);
    rememberPendingEnrollment(null, subject);
    expect(hasPendingEnrollment(source, undefined)).toBe(false);
    expect(hasPendingEnrollment(undefined, subject)).toBe(false);
    forgetPendingEnrollment(source, undefined);
    expect(Object.keys(storage)).toEqual([]);
  });

  it("keeps the server recovery path available when browser storage is disabled", () => {
    vi.stubGlobal("window", Object.defineProperty({}, "sessionStorage", {
      get() { throw new DOMException("Disabled", "SecurityError"); },
    }));
    expect(hasPendingEnrollment(source, subject)).toBe(false);
    expect(() => rememberPendingEnrollment(source, subject)).not.toThrow();
    expect(() => forgetPendingEnrollment(source, subject)).not.toThrow();
  });

  it("does not fail the successful server claim when storage is full", () => {
    vi.stubGlobal("window", { sessionStorage: {
      getItem: () => null,
      setItem: () => { throw new DOMException("Full", "QuotaExceededError"); },
    } });
    expect(() => rememberPendingEnrollment(source, subject)).not.toThrow();
    expect(hasPendingEnrollment(source, subject)).toBe(false);
  });
});
