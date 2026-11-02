import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarCheck2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { apiRequest } from "../../api/client";
import type {
  AuthSelfRegistration,
  ExternalAuthenticationProviderList,
  MultiFactorChallenge,
  MultiFactorCodeType,
} from "../../api/types";
import {
  compositeSourceCurrent,
  compositeSourceUsable,
  createCompositeSource,
  type CompositeSourceState,
} from "../../app/compositeSourceState";
import { useSession } from "../../app/session";
import { BrandMark } from "../../components/ui/BrandMark";
import { StaffProfileFields } from "../workspaces/StaffProfileFields";
import {
  defaultStaffProfile,
  saveInviteStaffDraft,
  type StaffProfileDraft,
} from "../workspaces/staffOnboarding";
import { MultiFactorChallengeForm } from "./MultiFactorChallengeForm";
import {
  externalProviderAllowed,
  passwordRegistrationAllowed,
  publicAuthenticationErrorMessage,
} from "./authenticationFlow";
import { authPasswordLengthHelp, authPasswordPolicy } from "./authPasswordPolicy";
import { useSharedAccounts } from "../account-switch/SharedAccountsProvider";

export function AuthPage({ invitation = false }: { invitation?: boolean }) {
  const sharedAccounts = useSharedAccounts();
  const emailInput = useRef<HTMLInputElement>(null);
  const {
    beginExternalSignIn,
    completeMultiFactorSignIn,
    login,
    register,
  } = useSession();
  const [mode, setMode] = useState<"login" | "register">(invitation ? "register" : "login");
  const [staffProfile, setStaffProfile] = useState<StaffProfileDraft>(() => defaultStaffProfile());
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [externalSubmitting, setExternalSubmitting] = useState<string | null>(
    null,
  );
  const [error, setError] = useState("");
  const [multiFactor, setMultiFactor] = useState<{
    challenge: MultiFactorChallenge;
    username: string;
  } | null>(null);
  useLayoutEffect(() => { if (!multiFactor) emailInput.current?.focus(); }, [mode, multiFactor]);
  const providers = useQuery({
    queryKey: ["auth", "external-providers"],
    queryFn: () =>
      apiRequest<ExternalAuthenticationProviderList>(
        "/api/auth/external/providers",
    ),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const selfRegistration = useQuery({
    queryKey: ["auth", "self-registration"],
    queryFn: () =>
      apiRequest<AuthSelfRegistration>("/api/auth/self-registration", {
        headers: { "X-Tenant-Id": "global" },
      }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const providerSource = createCompositeSource({
    label: "External sign-in options",
    hasData: providers.data !== undefined,
    isLoading: providers.isLoading,
    error: providers.error,
    isFetching: providers.isFetching,
    refetch: () => providers.refetch(),
  });
  const registrationSource = createCompositeSource({
    label: "Account registration policy",
    hasData: selfRegistration.data !== undefined,
    isLoading: selfRegistration.isLoading,
    error: selfRegistration.error,
    isFetching: selfRegistration.isFetching,
    refetch: () => selfRegistration.refetch(),
  });
  const providerSourceCurrent = compositeSourceCurrent(providerSource);
  const registrationSourceCurrent = compositeSourceCurrent(registrationSource);
  const passwordRegistrationEnabled =
    selfRegistration.data?.passwordEnabled === true;
  const passwordRegistrationAvailable = passwordRegistrationAllowed(
    registrationSourceCurrent,
    selfRegistration.data,
  );
  const providerCodes = compositeSourceUsable(providerSource.state)
    ? providers.data?.providers ?? []
    : [];
  const showProviderSection = providerCodes.length > 0 || !providerSourceCurrent;

  useEffect(() => {
    if (registrationSourceCurrent && selfRegistration.data && !passwordRegistrationEnabled && mode === "register") {
      setMode("login");
    }
  }, [mode, passwordRegistrationEnabled, registrationSourceCurrent, selfRegistration.data]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    if (mode === "register" && !passwordRegistrationAvailable) {
      setError("Refresh account registration availability before creating an account.");
      setSubmitting(false);
      return;
    }

    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") ?? "");
    if (
      mode === "register" &&
      password !== String(data.get("confirmPassword") ?? "")
    ) {
      setError("Passwords do not match.");
      setSubmitting(false);
      return;
    }

    try {
      if (mode === "register") {
        const latest = await selfRegistration.refetch();
        const latestCurrent = !latest.isFetching && latest.error == null;
        if (!passwordRegistrationAllowed(latestCurrent, latest.data)) {
          if (latest.error) {
            setError("Account registration availability could not be confirmed. Try again.");
          } else {
            setMode("login");
            setError("Password registration is no longer available. Sign in or ask your workspace administrator.");
          }
          return;
        }
      }

      const username = String(data.get("username") ?? "").trim();
      const credentials = {
        username,
        password,
      };
      if (mode === "login") {
        const challenge = await login(credentials);
        if (challenge) {
          setMultiFactor({ challenge, username });
        }
      } else {
        await register(credentials, invitation ? (subjectId) => {
          saveInviteStaffDraft({
            ...staffProfile,
            workEmail: staffProfile.workEmail.trim() || username,
          }, subjectId);
        } : undefined);
      }
    } catch (cause) {
      setError(publicAuthenticationErrorMessage(
        cause,
        mode === "login"
          ? "Email or password was not accepted."
          : "The account could not be created. Review the details and try again.",
      ));
    } finally {
      setSubmitting(false);
    }
  }

  async function completeMultiFactor(
    codeType: MultiFactorCodeType,
    code: string,
  ) {
    if (!multiFactor) return;
    setSubmitting(true);
    setError("");
    try {
      await completeMultiFactorSignIn(
        multiFactor.challenge.challengeToken,
        codeType,
        code,
        multiFactor.username,
      );
    } catch (cause) {
      setError(publicAuthenticationErrorMessage(
        cause,
        "The verification code was not accepted. Check it and try again.",
      ));
    } finally {
      setSubmitting(false);
    }
  }

  async function continueWithProvider(provider: string) {
    setExternalSubmitting(provider);
    setError("");
    try {
      const latest = await providers.refetch();
      const latestCurrent = !latest.isFetching && latest.error == null;
      if (!externalProviderAllowed(latestCurrent, latest.data, provider)) {
        throw new Error(latest.error
          ? "External sign-in options could not be refreshed. Try again."
          : "That external sign-in option is no longer available.");
      }
      await beginExternalSignIn(provider);
    } catch (cause) {
      setError(publicAuthenticationErrorMessage(
        cause,
        "External authentication could not start.",
      ));
    } finally {
      setExternalSubmitting(null);
    }
  }
  return (
    <main className="auth-grid min-h-screen bg-base-200 p-3 sm:p-5">
      <section className="relative hidden overflow-hidden bg-primary p-10 text-primary-content lg:flex lg:flex-col lg:justify-between">
        <div className="relative z-10 flex items-center gap-3">
          <BrandMark variant="simple-white-bold" height={52} />
          <span className="font-display text-2xl font-semibold">BunkFy</span>
        </div>
        <div className="relative z-10 max-w-xl">
          <p className="mb-4 text-sm font-bold uppercase tracking-[0.2em] text-accent">
            Your hostel, in focus
          </p>
          <h1 className="font-display text-5xl font-semibold leading-[1.08] xl:text-6xl">
            A calmer way to run every stay.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-8 text-primary-content/70">
            Reservations, rooms, beds and availability stay connected, so your
            team can move quickly without losing the details.
          </p>
        </div>
        <div className="relative z-10 grid grid-cols-3 gap-3">
          {[
            { icon: CalendarCheck2, label: "Reservations" },
            { icon: Building2, label: "Properties" },
            { icon: ShieldCheck, label: "Staff access" },
          ].map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="border border-primary-content/10 bg-primary-content/8 p-4"
            >
              <Icon size={20} className="mb-3 text-accent" />
              <p className="text-sm font-semibold">{label}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex min-h-[calc(100vh-1.5rem)] items-center justify-center px-4 py-10 sm:min-h-[calc(100vh-2.5rem)] sm:px-10">
        <div className="w-full max-w-md">
          {sharedAccounts?.current?.state === 3 && <button type="button" className="btn btn-ghost mb-5 -ml-3 gap-2 text-sm"
            disabled={sharedAccounts.busy} onClick={() => void sharedAccounts.returnToAccounts()}>
            <ArrowLeft size={17} aria-hidden="true" />Back to accounts</button>}
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <BrandMark variant="simple-white-bold" height={48} framed />
            <span className="font-display text-2xl font-semibold">BunkFy</span>
          </div>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-primary">
            Staff workspace
          </p>
          <h2 className="font-display text-4xl font-semibold">
            {multiFactor
              ? "Verify sign-in"
              : mode === "login"
              ? invitation ? "Sign in to join" : "Welcome back"
              : invitation ? "Join your team" : "Create your account"}
          </h2>
          <p className="mt-3 text-sm leading-6 text-base-content/55">
            {multiFactor
              ? "Enter a code from your authenticator or use one recovery code."
              : mode === "login"
              ? "Sign in to continue managing your property."
              : invitation
                ? "Create your account and staff profile. Your invitation stays ready after registration."
                : "Register once, then create a workspace or join your team."}
          </p>

          {multiFactor ? (
            <MultiFactorChallengeForm
              challenge={multiFactor.challenge}
              error={error}
              submitting={submitting}
              onSubmit={completeMultiFactor}
              onCancel={() => {
                setMultiFactor(null);
                setError("");
              }}
            />
          ) : (
            <>
              <form className="mt-8 space-y-5" onSubmit={submit}>
                <label className="form-control block">
                  <span className="label-text mb-1.5 block text-sm font-semibold">
                    Email
                  </span>
                  <input
                    ref={emailInput}
                    name="username"
                    type="email"
                    className="input input-bordered h-12 w-full bg-base-100"
                    placeholder="you@example.com"
                    autoComplete="email"
                    required
                  />
                </label>
                <PasswordField
                  name="password"
                  label="Password"
                  show={showPassword}
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  showPolicy={mode === "register"}
                  onToggle={() => setShowPassword((value) => !value)}
                />
                {mode === "register" && (
                  <PasswordField
                    name="confirmPassword"
                    label="Confirm password"
                    show={showPassword}
                    autoComplete="new-password"
                    showPolicy
                  />
                )}
                {invitation && mode === "register" && (
                  <div className="border-t border-base-300 pt-5">
                    <h3 className="font-display text-lg font-semibold">Your staff profile</h3>
                    <p className="mb-4 mt-1 text-sm leading-6 text-base-content/50">
                      These details will appear to your workspace team.
                    </p>
                    <StaffProfileFields
                      value={staffProfile}
                      onChange={setStaffProfile}
                      compact
                    />
                  </div>
                )}
                {error && (
                  <div className="alert alert-error py-3 text-sm">
                    <span>{error}</span>
                  </div>
                )}
                <button
                  className="btn btn-primary h-12 w-full text-base text-white"
                  disabled={
                    submitting ||
                    externalSubmitting !== null ||
                    (mode === "register" && !passwordRegistrationAvailable)
                  }
                >
                  {submitting && (
                    <span className="loading loading-spinner loading-sm" />
                  )}
                  {mode === "login" ? "Sign in" : "Create account"}
                </button>
              </form>

              {showProviderSection && (
                <div className="mt-6">
                  <div className="divider text-xs uppercase text-base-content/35">
                    or
                  </div>
                  {!providerSourceCurrent && (
                    <AuthSourceNotice
                      state={providerSource.state}
                      refreshing={providerSource.isFetching}
                      loadingLabel="Checking external sign-in options"
                      title="External sign-in options are delayed"
                      description="Retry to load sign-in options. You can also try your email and password."
                      onRetry={() => void providers.refetch()}
                    />
                  )}
                  {providerCodes.length > 0 && (
                    <div className="mt-3 grid gap-2">
                      {providerCodes.map((provider) => (
                        <button
                          key={provider}
                          type="button"
                          className="btn btn-outline h-12"
                          disabled={
                            !providerSourceCurrent ||
                            externalSubmitting !== null ||
                            submitting
                          }
                          onClick={() => void continueWithProvider(provider)}
                        >
                          {externalSubmitting === provider ? (
                            <span className="loading loading-spinner loading-sm" />
                          ) : (
                            <KeyRound size={17} />
                          )}
                          Continue with {providerLabel(provider)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {mode === "register" ? (
                <>
                  <AuthModeSwitch
                    mode={mode}
                    onToggle={() => {
                      setMode("login");
                      setError("");
                    }}
                  />
                  {!registrationSourceCurrent && (
                    <div className="mt-4">
                      <AuthSourceNotice
                        state={registrationSource.state}
                        refreshing={registrationSource.isFetching}
                        loadingLabel="Checking account registration"
                        title="Registration availability is delayed"
                        description="Retry to check whether account creation is available."
                        onRetry={() => void selfRegistration.refetch()}
                      />
                    </div>
                  )}
                </>
              ) : passwordRegistrationAvailable ? (
                <AuthModeSwitch
                  mode={mode}
                  onToggle={() => {
                    setMode("register");
                    setError("");
                  }}
                />
              ) : registrationSourceCurrent ? (
                <p className="mt-6 text-center text-sm text-base-content/45">
                  Password registration is not available. Sign in with an existing account
                  {providerCodes.length > 0 ? " or an available provider" : ""}.
                </p>
              ) : (
                <div className="mt-6">
                  <AuthSourceNotice
                    state={registrationSource.state}
                    refreshing={registrationSource.isFetching}
                    loadingLabel="Checking account registration"
                    title="Registration availability is delayed"
                    description="Retry to check whether account creation is available."
                    onRetry={() => void selfRegistration.refetch()}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function AuthModeSwitch({
  mode,
  onToggle,
}: {
  mode: "login" | "register";
  onToggle: () => void;
}) {
  return (
    <p className="mt-6 text-center text-sm text-base-content/55">
      {mode === "login" ? "New to BunkFy?" : "Already have an account?"}{" "}
      <button
        type="button"
        className="link link-primary font-semibold no-underline hover:underline"
        onClick={onToggle}
      >
        {mode === "login" ? "Register" : "Sign in"}
      </button>
    </p>
  );
}

function AuthSourceNotice({
  state,
  refreshing,
  loadingLabel,
  title,
  description,
  onRetry,
}: {
  state: CompositeSourceState;
  refreshing: boolean;
  loadingLabel: string;
  title: string;
  description: string;
  onRetry: () => void;
}) {
  if (state === "loading" || (state === "ready" && refreshing)) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-3 text-sm text-base-content/50"
        role="status"
      >
        <LoaderCircle className="animate-spin text-primary" size={17} />
        {loadingLabel}
      </div>
    );
  }

  return (
    <div className="alert items-start border border-warning/25 bg-warning/8 text-base-content">
      <AlertTriangle className="mt-0.5 shrink-0 text-warning-content" size={18} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 text-xs leading-5 text-base-content/60">{description}</p>
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm shrink-0"
        disabled={refreshing}
        onClick={onRetry}
      >
        <RotateCcw className={refreshing ? "animate-spin" : ""} size={15} />
        Retry
      </button>
    </div>
  );
}

function PasswordField({
  name,
  label,
  show,
  autoComplete,
  showPolicy = false,
  onToggle,
}: {
  name: string;
  label: string;
  show: boolean;
  autoComplete: string;
  showPolicy?: boolean;
  onToggle?: () => void;
}) {
  return (
    <label className="form-control block">
      <span className="label-text mb-1.5 block text-sm font-semibold">
        {label}
      </span>
      <div className="relative">
        <input
          name={name}
          type={show ? "text" : "password"}
          className="input input-bordered h-12 w-full bg-base-100 pr-12"
          placeholder="Password"
          autoComplete={autoComplete}
          required
          minLength={showPolicy ? authPasswordPolicy.minimumLength : undefined}
          maxLength={authPasswordPolicy.maximumLength}
        />
        {onToggle && (
          <button
            type="button"
            className="btn btn-circle btn-ghost btn-sm absolute right-2 top-2"
            onClick={onToggle}
            aria-label={show ? "Hide passwords" : "Show passwords"}
          >
            {show ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        )}
      </div>
      {showPolicy && (
        <span className="mt-1.5 block text-xs text-base-content/50">
          Use {authPasswordLengthHelp()}.
        </span>
      )}
    </label>
  );
}

function providerLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
