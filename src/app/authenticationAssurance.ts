import { ApiError } from "../api/client";

export function isInsufficientAuthenticationError(error: unknown): boolean {
  return error instanceof ApiError &&
    error.code === "Security.InsufficientAuthentication";
}

export function authenticationRecoveryMethods(error: unknown): ("password" | "mfa")[] {
  const contexts = error instanceof ApiError ? error.authenticationChallenge?.acceptedContextReferences : undefined;
  if (!contexts?.length) return ["password", "mfa"];
  const methods: ("password" | "mfa")[] = [];
  if (contexts.includes("urn:gma:acr:password")) methods.push("password");
  // Password + factor emits the Auth owner's MFA context. An external-primary
  // two-step context is distinct and needs a fresh external sign-in instead.
  if (contexts.includes("urn:gma:acr:mfa")) methods.push("mfa");
  return methods;
}
