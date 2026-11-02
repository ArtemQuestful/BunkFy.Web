import { describe, expect, it } from "vitest";
import { accessTokenSubjectId } from "../src/api/client";

describe("authenticated session subject", () => {
  it("uses the immutable token subject rather than a display username", () => {
    const subjectId = "10000000-0000-4000-8000-000000000001";
    const token = jwt({ sub: subjectId, label: "GitHub account" });

    expect(accessTokenSubjectId(token)).toBe(subjectId);
  });

  it.each([
    "not-a-jwt",
    jwt({}),
    jwt({ sub: "GitHub account" }),
  ])("fails closed for an unusable token subject", (token) => {
    expect(() => accessTokenSubjectId(token))
      .toThrow("authenticated account identity is unavailable");
  });
});

function jwt(payload: object): string {
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode(payload),
    "signature",
  ].join(".");
}

function encode(value: object): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
