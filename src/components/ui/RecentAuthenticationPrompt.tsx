import { applicationUrl } from "../../app/deploymentBase";
import { KeyRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useSession } from "../../app/session";
import { authenticationRecoveryMethods, isInsufficientAuthenticationError } from "../../app/authenticationAssurance";
import { sessionIdentityKey } from "../../app/singleFlightRefresh";
import type { MultiFactorCodeType } from "../../api/types";
import { ApiError } from "../../api/client";
import { SegmentedTabs } from "./SegmentedTabs";
import { ErrorState } from "./primitives";

export function RecentAuthenticationPrompt({
  error,
  title = "Confirm your password to continue",
  description = "This sensitive action requires a recent sign-in.",
  submitLabel = "Confirm and retry",
  onAuthenticated,
}: {
  error: unknown;
  title?: string;
  description?: string;
  submitLabel?: string;
  onAuthenticated: () => void;
}) {
  const { session, stepUpWithPassword, stepUpWithMultiFactor } = useSession();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeType, setCodeType] = useState<MultiFactorCodeType>("totp");
  const [preferMfa, setPreferMfa] = useState(false);
  const [confirmationError, setConfirmationError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const methods = authenticationRecoveryMethods(error);
  const useMfa = methods.includes("mfa") && (!methods.includes("password") || preferMfa);
  const scopeKey = sessionIdentityKey(session ?? null);

  useEffect(() => {
    setPassword(""); setCode(""); setConfirmationError(null);
  }, [scopeKey]);

  if (!isInsufficientAuthenticationError(error)) return null;
  if (methods.length === 0) return (
    <div className="rounded-lg border border-warning/30 bg-warning/8 p-4">
      <p className="text-sm font-semibold">A different sign-in method is required</p>
      <p className="mt-1 text-xs leading-5">Sign in with the method required for this action, then try again.</p>
      <a className="link mt-2 inline-block text-sm" href={applicationUrl("/account?section=security")}>Account security</a>
    </div>
  );

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setConfirmationError(null);
    try {
      if (useMfa) await stepUpWithMultiFactor(password, codeType, code.trim());
      else await stepUpWithPassword(password);
      setPassword(""); setCode("");
      onAuthenticated();
    } catch (nextError) {
      setConfirmationError(nextError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="rounded-lg border border-warning/30 bg-warning/8 p-4"
      onSubmit={confirm}
    >
      <div className="flex items-start gap-3">
        <KeyRound size={18} className="mt-0.5 shrink-0 text-warning-content" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{useMfa ? "Verify your identity to continue" : title}</p>
          <p className="mt-1 text-xs leading-5 text-base-content/55">{description}</p>
          <div className="mt-3 space-y-3">
            <input
              className="input input-bordered input-sm min-w-0 flex-1 bg-base-100"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              aria-label="Current password"
              required
              disabled={submitting}
            />
            {useMfa && <>
              <SegmentedTabs value={codeType} ariaLabel="Verification code type" stretch
                onValueChange={value => { setCodeType(value); setCode(""); }}
                options={[{ value: "totp", label: "Authenticator code", disabled: submitting }, { value: "recovery-code", label: "Recovery code", disabled: submitting }]} />
              <label className="form-control block">
                <span className="mb-1 block text-sm">{codeType === "totp" ? "Authenticator code" : "Recovery code"}</span>
                <input className="input input-bordered input-sm w-full bg-base-100 font-mono" value={code}
                  onChange={event => setCode(event.target.value)} autoComplete="one-time-code"
                  inputMode={codeType === "totp" ? "numeric" : "text"} required disabled={submitting} />
              </label>
              <p className="text-xs leading-5 text-base-content/55">Use your current password and an authenticator or unused recovery code. <a className="link" href={applicationUrl("/account?section=security")}>Set up or manage MFA</a></p>
            </>}
            <div className="flex flex-wrap gap-2"><button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={!password || (useMfa && !code.trim()) || submitting}
            >
              {submitting && <span className="loading loading-spinner loading-xs" />}
              {submitLabel}
            </button>
            {methods.length > 1 && <button type="button" className="btn btn-ghost btn-sm" disabled={submitting}
              onClick={() => { setPreferMfa(!useMfa); setCode(""); }}>
              {useMfa ? "Use password only" : "Use MFA instead"}
            </button>}</div>
          </div>
        </div>
      </div>
      {confirmationError !== null && (
        <div className="mt-3">{useMfa && confirmationError instanceof ApiError && confirmationError.status === 401 && !confirmationError.code
          ? <p role="alert" className="text-sm">Verification could not be completed. Check your password and code, or sign in again.</p>
          : <ErrorState error={confirmationError} />}</div>
      )}
    </form>
  );
}
