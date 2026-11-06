import { describe, expect, it } from "vitest";
import { parseAuthenticationChallenge } from "../src/api/authenticationChallenge";
import { ApiError } from "../src/api/client";
import { authenticationRecoveryMethods } from "../src/app/authenticationAssurance";

const mfa = "urn:gma:acr:mfa";
const challenge = 'Bearer error="insufficient_user_authentication"';

describe("server-owned authentication challenge", () => {
  it("retains exact alternative contexts and freshness through quoted commas and escapes", () => {
    expect(parseAuthenticationChallenge(String.raw`${challenge}, error_description="A \"quoted\", stronger event", acr_values="${mfa} urn:gma:acr:two-step", max_age="600"`)).toEqual({
      acceptedContextReferences: [mfa, "urn:gma:acr:two-step"], maxAuthenticationAgeSeconds: 600,
    });
  });

  it("supports case-insensitive names and an immediate-freshness token value", () => {
    expect(parseAuthenticationChallenge('bEaReR ERROR="insufficient_user_authentication", MAX_AGE=0')).toEqual({ acceptedContextReferences: [], maxAuthenticationAgeSeconds: 0 });
  });

  it.each([
    null, "", 'Basic realm="private"', 'Bearer error="invalid_token"',
    `${challenge}, acr_values="${mfa}", ACR_VALUES="urn:gma:acr:password"`,
    `${challenge}, error="insufficient_user_authentication"`,
    `${challenge}, acr_values=""`, `${challenge}, acr_values="${mfa}`,
    `${challenge}, max_age="-1"`, `${challenge}, max_age="1.5"`, `${challenge}, max_age="9007199254740992"`,
    `${challenge},`, `${challenge}, acr_values="${mfa}" trailing`, `${challenge}, Basic realm="other"`,
    `${challenge}\r\nInjected: yes`, `${challenge}\u0000`, `${challenge}, ignored="${"x".repeat(8192)}"`,
  ])("refuses malformed or ambiguous input without selecting a ceremony: %s", value => {
    expect(parseAuthenticationChallenge(value)).toBeUndefined();
  });

  it.each([
    [[], ["password", "mfa"]],
    [["urn:gma:acr:password"], ["password"]],
    [[mfa], ["mfa"]],
    [["urn:gma:acr:password", mfa], ["password", "mfa"]],
    [["urn:gma:acr:two-step"], []],
    [["urn:other:unsupported"], []],
  ])("offers only ceremonies producing an accepted context: %j", (contexts, expected) => {
    const error = new ApiError("Verification required", 401, "Security.InsufficientAuthentication", undefined, undefined, { acceptedContextReferences: contexts });
    expect(authenticationRecoveryMethods(error)).toEqual(expected);
  });
});
