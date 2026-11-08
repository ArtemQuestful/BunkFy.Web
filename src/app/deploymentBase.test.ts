import { afterEach, describe, expect, it, vi } from "vitest";
import { applicationPath, applicationUrl } from "./deploymentBase";
afterEach(() => vi.unstubAllEnvs());
describe("deployment base", () => {
  it("preserves default root routes", () => {
    vi.stubEnv("BASE_URL", "/");
    expect(applicationUrl("/account?section=security")).toBe("/account?section=security");
    expect(applicationPath("/station")).toBe("/station");
  });
  it("prefixes full navigation and removes only a complete matching path segment", () => {
    vi.stubEnv("BASE_URL", "/example/");
    expect(applicationUrl("/auth/complete")).toBe("/example/auth/complete");
    expect(applicationUrl("/")).toBe("/example/");
    expect(applicationPath("/example/station")).toBe("/station");
    expect(applicationPath("/examples/station")).toBe("/examples/station");
  });
});
