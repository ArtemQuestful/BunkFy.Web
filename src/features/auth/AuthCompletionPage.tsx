import { AlertTriangle, CheckCircle2, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  MultiFactorChallenge,
  MultiFactorCodeType,
} from "../../api/types";
import { useSession } from "../../app/session";
import { workspaceJoinAuthenticationDestination } from "../workspaces/workspaceJoin";
import { BrandMark } from "../../components/ui/BrandMark";
import { MultiFactorChallengeForm } from "./MultiFactorChallengeForm";
import {
  parseExternalAuthenticationCallback,
  publicAuthenticationErrorMessage,
} from "./authenticationFlow";

export function AuthCompletionPage() {
  const {
    completeExternalAuthentication,
    completeMultiFactorSignIn,
    cancelExternalAuthentication,
    isRestoring,
    session,
  } = useSession();
  const started = useRef(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [multiFactor, setMultiFactor] = useState<{
    challenge: MultiFactorChallenge;
    username: string;
  } | null>(null);
  const [callback] = useState(() =>
    parseExternalAuthenticationCallback(window.location.search));

  useLayoutEffect(() => {
    if (!window.location.search && !window.location.hash) return;
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname,
    );
  }, []);

  useEffect(() => {
    if (isRestoring || started.current) return;
    started.current = true;
    if (callback.providerRejected) {
      cancelExternalAuthentication();
      setError("The external provider did not complete authentication.");
      return;
    }
    if (!callback.code || !callback.provider) {
      cancelExternalAuthentication();
      setError("The external authentication response is incomplete.");
      return;
    }

    void completeExternalAuthentication(
      callback.code,
      callback.provider,
      callback.intent,
    )
      .then((completion) => {
        if (completion.kind === "redirect") {
          window.location.replace(workspaceJoinAuthenticationDestination(completion.destination));
          return;
        }
        setMultiFactor({
          challenge: completion.challenge,
          username: completion.username,
        });
      })
      .catch((cause) => {
        cancelExternalAuthentication();
        setError(publicAuthenticationErrorMessage(
          cause,
          "External authentication could not be completed. Start again from BunkFy.",
        ));
      });
  }, [
    callback,
    cancelExternalAuthentication,
    completeExternalAuthentication,
    isRestoring,
  ]);

  async function completeMultiFactor(
    codeType: MultiFactorCodeType,
    verificationCode: string,
  ) {
    if (!multiFactor) return;
    setSubmitting(true);
    setError("");
    try {
      await completeMultiFactorSignIn(
        multiFactor.challenge.challengeToken,
        codeType,
        verificationCode,
        multiFactor.username,
      );
      window.location.replace(workspaceJoinAuthenticationDestination("/"));
    } catch (cause) {
      setError(publicAuthenticationErrorMessage(
        cause,
        "The verification code was not accepted. Check it and try again.",
      ));
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-base-200 p-5">
      <section className="w-full max-w-md border border-base-300 bg-base-100 p-7 shadow-sm sm:p-9">
        <div className="flex items-center gap-3">
          <BrandMark variant="simple-white-bold" height={48} framed />
          <div>
            <p className="font-display text-xl font-semibold">BunkFy</p>
            <p className="text-xs text-base-content/45">
              Secure account handoff
            </p>
          </div>
        </div>
        {multiFactor ? (
          <div className="mt-8">
            <CheckCircle2 className="text-primary" size={30} />
            <h1 className="mt-4 font-display text-2xl font-semibold">
              Verify sign-in
            </h1>
            <p className="mt-3 text-sm leading-6 text-base-content/60">
              The provider was verified. Complete multi-factor authentication
              to open BunkFy.
            </p>
            <MultiFactorChallengeForm
              challenge={multiFactor.challenge}
              error={error}
              submitting={submitting}
              onSubmit={completeMultiFactor}
              onCancel={() => {
                cancelExternalAuthentication();
                window.location.replace(workspaceJoinAuthenticationDestination("/"));
              }}
            />
          </div>
        ) : error ? (
          <div className="mt-8">
            <AlertTriangle className="text-error" size={28} />
            <h1 className="mt-4 font-display text-2xl font-semibold">
              Authentication could not be completed
            </h1>
            <p className="mt-3 text-sm leading-6 text-base-content/60">
              {error}
            </p>
            <a
              className="btn btn-primary mt-6 w-full"
              href={session ? "/account" : "/"}
              onClick={cancelExternalAuthentication}
            >
              Return to BunkFy
            </a>
          </div>
        ) : (
          <div className="mt-8" aria-live="polite">
            {isRestoring ? (
              <LoaderCircle className="animate-spin text-primary" size={30} />
            ) : (
              <CheckCircle2 className="text-primary" size={30} />
            )}
            <h1 className="mt-4 font-display text-2xl font-semibold">
              Completing authentication
            </h1>
            <p className="mt-3 text-sm leading-6 text-base-content/60">
              Please keep this page open while BunkFy verifies the provider
              response.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
