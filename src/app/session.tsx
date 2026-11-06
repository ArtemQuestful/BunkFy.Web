import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import {
  apiDownload,
  apiRequest,
  apiStream,
  accessTokenSubjectId,
  resolveApiBaseUrl,
  type ApiDownload,
  type ApiSession,
} from "../api/client";
import type {
  AuthenticationMethods,
  BrowserAuthResponse,
  BrowserMultiFactorStepUpRequest,
  BrowserTotpActivation,
  ExternalAuthenticationChallenge,
  ExternalAuthenticationResult,
  MultiFactorChallenge,
  MultiFactorCodeType,
} from "../api/types";
import {
  hasSessionBoundaryChanged,
  hasSessionActorGenerationChanged,
  createSingleFlightRefresh,
  runWithBrowserSessionLock,
  startBrowserSessionSignOut,
  type SessionIdentity,
} from "./singleFlightRefresh";
import {
  bindApiSessionIdentity,
  createSessionGeneration,
  readAccessTokenIdentity,
  resolveRefreshedSessionIdentity,
  SessionBoundarySupersededError,
  SessionIdentityMismatchError,
} from "./sessionTokenIdentity";
import { refreshFailureInvalidatesSession } from "./sessionRecovery";
import { isInsufficientAuthenticationError } from "./authenticationAssurance";
import { useQueryClient } from "@tanstack/react-query";
import {
  isMultiFactorChallenge,
  type ExternalAuthenticationIntent,
} from "../features/auth/authenticationFlow";

const STORAGE_KEY = "bunkfy.session.identity.v2";
const SESSION_CHANNEL_NAME = "bunkfy.browser-session.boundary.v1";
const EXTERNAL_AUTH_KEY = "bunkfy.auth.external.pending.v1";
const GLOBAL_IDENTITY_SCOPE = "global";

export type Credentials = {
  username: string;
  password: string;
};

export type ExternalAuthenticationCompletion =
  | {
      kind: "redirect";
      destination: "/" | "/account?external=linked";
    }
  | {
      kind: "mfa";
      challenge: MultiFactorChallenge;
      username: string;
    };

export type SessionRequestContext = {
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  assertCurrent: () => void;
  selectWorkspace: (workspaceId: string) => SessionRequestContext;
};

type SessionContextValue = {
  session: ApiSession | null;
  isRestoring: boolean;
  restorationError: unknown;
  restoringIdentity: SessionIdentity | null;
  retrySessionRestore: () => Promise<void>;
  abandonSessionRestore: () => void;
  login: (credentials: Credentials) => Promise<MultiFactorChallenge | null>;
  register: (credentials: Credentials, onAuthenticated?: (subjectId: string) => void) => Promise<void>;
  completeMultiFactorSignIn: (
    challengeToken: string,
    codeType: MultiFactorCodeType,
    code: string,
    username: string,
  ) => Promise<void>;
  activateTotp: (code: string) => Promise<string[]>;
  disableTotp: (codeType: MultiFactorCodeType, code: string) => Promise<void>;
  beginExternalSignIn: (provider: string) => Promise<void>;
  beginExternalLink: (provider: string) => Promise<void>;
  completeExternalAuthentication: (
    code: string,
    provider: string,
    intent: ExternalAuthenticationIntent | null,
  ) => Promise<ExternalAuthenticationCompletion>;
  cancelExternalAuthentication: () => void;
  logout: () => Promise<void>;
  completeConfirmedBrowserSignOut: (expectedSessionId: string) => void;
  concealForAccountTransition: () => void;
  adoptBrowserAccount: (account: ApiSession) => void;
  logoutAll: () => Promise<void>;
  stepUpWithPassword: (password: string) => Promise<void>;
  stepUpWithMultiFactor: (password: string, codeType: MultiFactorCodeType, code: string) => Promise<void>;
  selectWorkspace: (workspaceId: string) => void;
  captureRequestContext: (workspaceId?: string) => SessionRequestContext;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  download: (path: string, options?: RequestInit) => Promise<ApiDownload>;
  stream: (path: string, signal: AbortSignal) => Promise<Response>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children, restoreOnMount = true, prepareBrowserRefresh }: {
  children: ReactNode;
  restoreOnMount?: boolean;
  prepareBrowserRefresh?: (identity: SessionIdentity) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  // A managed browser must establish its server device boundary before an old
  // remembered identity can trigger refresh or render operational content.
  const initialIdentity = useRef(restoreOnMount ? readSessionIdentity() : null);
  const [session, setSessionState] = useState<ApiSession | null>(null);
  const [isRestoring, setIsRestoring] = useState(
    initialIdentity.current !== null,
  );
  const [restorationError, setRestorationError] = useState<unknown>(null);
  const [restoringIdentity, setRestoringIdentity] = useState<SessionIdentity | null>(
    initialIdentity.current,
  );
  const restoringIdentityRef = useRef<SessionIdentity | null>(
    initialIdentity.current,
  );
  const sessionRef = useRef<ApiSession | null>(null);
  const acceptsRefreshRef = useRef(true);
  const boundarySequenceRef = useRef(0);
  const boundarySyncRef = useRef("");
  const sessionChannelRef = useRef<BroadcastChannel | null>(null);
  const publishedIdentityRef = useRef(sessionIdentitySignature(initialIdentity.current));
  const externalCompletionRef = useRef<Promise<
    ExternalAuthenticationCompletion
  > | null>(null);

  const publishSessionIdentity = useCallback((identity: SessionIdentity | null) => {
    const signature = sessionIdentitySignature(identity);
    if (publishedIdentityRef.current === signature &&
      sessionIdentitySignature(readSessionIdentity()) === signature) return;
    publishedIdentityRef.current = signature;
    writeSessionIdentity(identity);
    sessionChannelRef.current?.postMessage(serializableSessionIdentity(identity));
  }, []);

  const setSession = useCallback((candidate: ApiSession | null) => {
    const next = candidate ? bindApiSessionIdentity(candidate, sessionRef.current) : null;
    const actorChanged = hasSessionActorGenerationChanged(sessionRef.current, next);
    const boundaryChanged = hasSessionBoundaryChanged(sessionRef.current, next);
    if (actorChanged) {
      queryClient.removeQueries();
    } else if (boundaryChanged) {
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== "organizations",
      });
    }
    if (actorChanged || boundaryChanged) boundarySequenceRef.current += 1;
    sessionRef.current = next;
    setSessionState(next);
    publishSessionIdentity(next);
  }, [publishSessionIdentity, queryClient]);

  const performRefresh = useCallback(
    async (identity: SessionIdentity): Promise<ApiSession> => {
      const expectedBoundarySequence = boundarySequenceRef.current;
      return runWithBrowserSessionLock(async () => {
        assertSessionBoundaryCurrent(expectedBoundarySequence, boundarySequenceRef, acceptsRefreshRef);
        if (prepareBrowserRefresh) await prepareBrowserRefresh(identity);
        assertSessionBoundaryCurrent(expectedBoundarySequence, boundarySequenceRef, acceptsRefreshRef);

        const { accessToken } = await apiRequest<BrowserAuthResponse>(
          "/api/auth/browser/refresh",
          {
            method: "POST",
            headers: { "X-Tenant-Id": GLOBAL_IDENTITY_SCOPE },
          },
        );
        assertSessionBoundaryCurrent(expectedBoundarySequence, boundarySequenceRef, acceptsRefreshRef);

        const tokenIdentity = readAccessTokenIdentity(accessToken);
        if (!tokenIdentity) throw new SessionIdentityMismatchError();
        const resolvedIdentity = resolveRefreshedSessionIdentity(
          identity,
          readSessionIdentity(),
          tokenIdentity,
        );
        const refreshed = { ...resolvedIdentity, ...tokenIdentity, accessToken };

        setSession(refreshed);
        return refreshed;
      });
    },
    [prepareBrowserRefresh, setSession],
  );

  const refreshSession = useMemo(
    () =>
      createSingleFlightRefresh(async (identity: SessionIdentity) => {
        try {
          return await performRefresh(identity);
        } catch (error) {
          if (sessionFailureInvalidatesActor(error)) setSession(null);
          throw error;
        }
      }),
    [performRefresh, setSession],
  );

  const restoreSession = useCallback(async () => {
    const identity = restoringIdentityRef.current;
    if (!identity) return;

    setIsRestoring(true);
    setRestorationError(null);
    try {
      await refreshSession(identity);
      restoringIdentityRef.current = null;
      setRestoringIdentity(null);
    } catch (error) {
      if (sessionFailureInvalidatesActor(error)) {
        restoringIdentityRef.current = null;
        setRestoringIdentity(null);
      } else {
        setRestorationError(error);
      }
    } finally {
      setIsRestoring(false);
    }
  }, [refreshSession]);

  const abandonSessionRestore = useCallback(() => {
    acceptsRefreshRef.current = false;
    restoringIdentityRef.current = null;
    setRestoringIdentity(null);
    setRestorationError(null);
    setIsRestoring(false);
    setSession(null);
  }, [setSession]);

  useEffect(() => {
    if (!initialIdentity.current) return;
    void restoreSession();
  }, [restoreSession]);

  const synchronizeBrowserBoundary = useCallback(async (nextIdentity: SessionIdentity | null) => {
    const current = sessionRef.current;
    if (!hasSessionBoundaryChanged(current, nextIdentity) &&
      !hasSessionActorGenerationChanged(current, nextIdentity)) {
      return;
    }

    const signature = sessionIdentitySignature(nextIdentity);
    if (boundarySyncRef.current === signature) return;
    boundarySyncRef.current = signature;
    publishedIdentityRef.current = signature;
    boundarySequenceRef.current += 1;
    queryClient.removeQueries();
    sessionRef.current = null;
    setSessionState(null);
    setRestorationError(null);

    if (!nextIdentity) {
      acceptsRefreshRef.current = false;
      restoringIdentityRef.current = null;
      setRestoringIdentity(null);
      setIsRestoring(false);
      boundarySyncRef.current = "";
      return;
    }

    acceptsRefreshRef.current = true;
    restoringIdentityRef.current = nextIdentity;
    setRestoringIdentity(nextIdentity);
    setIsRestoring(true);
    try {
      await refreshSession(nextIdentity);
      if (boundarySyncRef.current !== signature) return;
      restoringIdentityRef.current = null;
      setRestoringIdentity(null);
    } catch (error) {
      if (boundarySyncRef.current !== signature) return;
      if (sessionFailureInvalidatesActor(error)) {
        restoringIdentityRef.current = null;
        setRestoringIdentity(null);
      } else if (!(error instanceof SessionBoundarySupersededError)) {
        setRestorationError(error);
      }
    } finally {
      if (boundarySyncRef.current === signature) {
        boundarySyncRef.current = "";
        setIsRestoring(false);
      }
    }
  }, [queryClient, refreshSession]);

  useEffect(() => {
    const channel = typeof BroadcastChannel === "function"
      ? new BroadcastChannel(SESSION_CHANNEL_NAME)
      : null;
    sessionChannelRef.current = channel;
    if (channel) {
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const identity = parseSessionIdentity(event.data);
        if (event.data === null || identity) void synchronizeBrowserBoundary(identity);
      };
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      void synchronizeBrowserBoundary(parseStoredSessionIdentity(event.newValue));
    };
    const reconcilePersistedBoundary = () => {
      if (document.visibilityState !== "visible") return;
      void synchronizeBrowserBoundary(readSessionIdentity());
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) reconcilePersistedBoundary();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("online", reconcilePersistedBoundary);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", reconcilePersistedBoundary);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("online", reconcilePersistedBoundary);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", reconcilePersistedBoundary);
      channel?.close();
      if (sessionChannelRef.current === channel) sessionChannelRef.current = null;
    };
  }, [synchronizeBrowserBoundary]);

  const authenticate = useCallback(
    async (
      mode: "login" | "register",
      credentials: Credentials,
      onAuthenticated?: (subjectId: string) => void,
    ): Promise<MultiFactorChallenge | null> => {
      return await runWithBrowserSessionLock(async () => {
        const response = await apiRequest<BrowserAuthResponse | MultiFactorChallenge>(
          `/api/auth/browser/${mode}`,
          {
            method: "POST",
            headers: { "X-Tenant-Id": GLOBAL_IDENTITY_SCOPE },
            body: JSON.stringify(
              mode === "login"
                ? {
                    username: credentials.username,
                    password: credentials.password,
                  }
                : {
                    username: credentials.username,
                    usernameType: "Email",
                    password: credentials.password,
                  },
            ),
          },
        );
        if (isMultiFactorChallenge(response)) {
          return response;
        }
        acceptsRefreshRef.current = true;
        const subjectId = accessTokenSubjectId(response.accessToken);
        const authenticated = bindApiSessionIdentity({
          ...response,
          tenantId: GLOBAL_IDENTITY_SCOPE,
          username: credentials.username,
          subjectId,
        }, sessionRef.current);
        // Bind the registration draft to the validated token's subject inside
        // the browser-session lock, before the authenticated page is rendered.
        onAuthenticated?.(subjectId);
        setSession(authenticated);
        return null;
      });
    },
    [setSession],
  );

  const completeMultiFactorSignIn = useCallback(
    async (
      challengeToken: string,
      codeType: MultiFactorCodeType,
      code: string,
      username: string,
    ) => {
      await runWithBrowserSessionLock(async () => {
        const response = await apiRequest<BrowserAuthResponse>(
          "/api/auth/browser/mfa/challenges/complete",
          {
            method: "POST",
            headers: { "X-Tenant-Id": GLOBAL_IDENTITY_SCOPE },
            body: JSON.stringify({ challengeToken, codeType, code }),
          },
        );
        acceptsRefreshRef.current = true;
        const authenticated: ApiSession = {
          ...response,
          tenantId: GLOBAL_IDENTITY_SCOPE,
          username,
          subjectId: accessTokenSubjectId(response.accessToken),
        };
        try {
          const methods = await apiRequest<AuthenticationMethods>(
            "/api/auth/methods",
            {},
            authenticated,
          );
          authenticated.username =
            methods.emails.find((email) => email.isActive)?.email ||
            authenticated.username;
        } catch {
          // The authenticated session remains valid if profile metadata is unavailable.
        }
        setSession(authenticated);
      });
    },
    [setSession],
  );

  const request = useCallback(
    async <T,>(path: string, options: RequestInit = {}) => {
      const active = sessionRef.current;
      if (!active) throw new Error("You are signed out.");
      const boundarySequence = boundarySequenceRef.current;

      try {
        const result = await apiRequest<T>(path, options, active);
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        return result;
      } catch (error) {
        if (isInsufficientAuthenticationError(error)) {
          assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
          throw error;
        }
        if (
          !(error instanceof Error) ||
          !("status" in error) ||
          error.status !== 401
        )
          throw error;

        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        const refreshed = await refreshSession(active);
        const result = await apiRequest<T>(path, options, refreshed);
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        return result;
      }
    },
    [refreshSession],
  );

  const beginExternalSignIn = useCallback(
    async (provider: string) => {
      clearPendingExternalAuth();
      const returnUrl = externalReturnUrl("sign-in");
      const challenge = await apiRequest<ExternalAuthenticationChallenge>(
        `/api/auth/external/${encodeURIComponent(provider)}/sign-in/challenge`,
        {
          method: "POST",
          headers: { "X-Tenant-Id": GLOBAL_IDENTITY_SCOPE },
          body: JSON.stringify({ returnUrl }),
        },
      );
      writePendingExternalAuth({
        intent: "sign-in",
        provider,
      });
      window.location.assign(apiUrl(challenge.startUrl));
    },
    [],
  );

  const beginExternalLink = useCallback(
    async (provider: string) => {
      const active = sessionRef.current;
      if (!active) throw new Error("You are signed out.");
      clearPendingExternalAuth();
      const returnUrl = externalReturnUrl("link");
      const challenge = await request<ExternalAuthenticationChallenge>(
        `/api/auth/external/${encodeURIComponent(provider)}/link/challenge`,
        { method: "POST", body: JSON.stringify({ returnUrl }) },
      );
      writePendingExternalAuth({
        intent: "link",
        provider,
      });
      window.location.assign(apiUrl(challenge.startUrl));
    },
    [request],
  );

  const completeExternalAuthentication = useCallback(
    (
      code: string,
      provider: string,
      intent: ExternalAuthenticationIntent | null,
    ) => {
      if (externalCompletionRef.current) return externalCompletionRef.current;

      const completion = (async (): Promise<ExternalAuthenticationCompletion> => {
        const pending = readPendingExternalAuth(
          intent ? { intent, provider } : null,
        );
        if (
          !pending ||
          pending.provider.toLowerCase() !== provider.toLowerCase() ||
          (intent !== null && pending.intent !== intent)
        ) {
          throw new Error(
            "The external sign-in state is missing or does not match this provider.",
          );
        }

        if (pending.intent === "link") {
          const result = await request<ExternalAuthenticationResult>(
            "/api/auth/browser/external/exchange",
            {
              method: "POST",
              body: JSON.stringify({ code }),
            },
          );
          if (externalStatus(result.status) !== "linked") {
            throw new Error("The external account was not linked.");
          }
          clearPendingExternalAuth();
          return {
            kind: "redirect",
            destination: "/account?external=linked",
          };
        }

        const response = await runWithBrowserSessionLock(async () => {
          return await apiRequest<BrowserAuthResponse | MultiFactorChallenge>(
            "/api/auth/browser/external/exchange",
            {
              method: "POST",
              headers: { "X-Tenant-Id": GLOBAL_IDENTITY_SCOPE },
              body: JSON.stringify({ code }),
            },
          );
        });
        clearPendingExternalAuth();
        if (isMultiFactorChallenge(response)) {
          return {
            kind: "mfa",
            challenge: response,
            username: `${providerLabel(provider)} account`,
          };
        }

        await runWithBrowserSessionLock(async () => {
          const provisional: ApiSession = {
            ...response,
            tenantId: GLOBAL_IDENTITY_SCOPE,
            username: `${providerLabel(provider)} account`,
            subjectId: accessTokenSubjectId(response.accessToken),
          };
          try {
            const methods = await apiRequest<AuthenticationMethods>(
              "/api/auth/methods",
              {},
              provisional,
            );
            provisional.username =
              methods.emails.find((email) => email.isActive)?.email ||
              provisional.username;
          } catch {
            // The access token is still valid; account metadata can load after navigation.
          }
          acceptsRefreshRef.current = true;
          setSession(provisional);
        });
        return { kind: "redirect", destination: "/" };
      })();

      externalCompletionRef.current = completion;
      void completion.then(
        () => {
          externalCompletionRef.current = null;
        },
        () => {
          externalCompletionRef.current = null;
        },
      );
      return completion;
    },
    [request, setSession],
  );

  const cancelExternalAuthentication = useCallback(() => {
    clearPendingExternalAuth();
  }, []);

  const download = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const active = sessionRef.current;
      if (!active) throw new Error("You are signed out.");
      const boundarySequence = boundarySequenceRef.current;
      try {
        const result = await apiDownload(path, options, active);
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        return result;
      } catch (error) {
        if (isInsufficientAuthenticationError(error)) {
          assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
          throw error;
        }
        if (
          !(error instanceof Error) ||
          !("status" in error) ||
          error.status !== 401
        )
          throw error;
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        const refreshed = await refreshSession(active);
        const result = await apiDownload(path, options, refreshed);
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        return result;
      }
    },
    [refreshSession],
  );

  const stream = useCallback(
    async (path: string, signal: AbortSignal) => {
      const active = sessionRef.current;
      if (!active) throw new Error("You are signed out.");
      const boundarySequence = boundarySequenceRef.current;
      try {
        const response = await apiStream(path, signal, active);
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        return response;
      } catch (error) {
        if (isInsufficientAuthenticationError(error)) {
          assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
          throw error;
        }
        if (
          !(error instanceof Error) ||
          !("status" in error) ||
          error.status !== 401 ||
          signal.aborted
        )
          throw error;
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        const refreshed = await refreshSession(active);
        const response = await apiStream(path, signal, refreshed);
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        return response;
      }
    },
    [refreshSession],
  );

  const stepUpWithPassword = useCallback(
    async (password: string) => {
      const active = sessionRef.current;
      if (!active) throw new Error("You are signed out.");
      const boundarySequence = boundarySequenceRef.current;
      await runWithBrowserSessionLock(async () => {
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        const response = await apiRequest<BrowserAuthResponse>(
          "/api/auth/browser/step-up/password",
          {
            method: "POST",
            body: JSON.stringify({ password }),
          },
          active,
        );
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        setSession({ ...active, accessToken: response.accessToken });
      });
    },
    [setSession],
  );

  const stepUpWithMultiFactor = useCallback(
    async (password: string, codeType: MultiFactorCodeType, code: string) => {
      const active = sessionRef.current;
      if (!active) throw new Error("You are signed out.");
      const boundarySequence = boundarySequenceRef.current;
      const body: BrowserMultiFactorStepUpRequest = { password, codeType, code };
      await runWithBrowserSessionLock(async () => {
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        const response = await apiRequest<BrowserAuthResponse>(
          "/api/auth/browser/step-up/mfa",
          { method: "POST", body: JSON.stringify(body) },
          active,
        );
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        setSession({ ...active, accessToken: response.accessToken });
      });
    },
    [setSession],
  );

  const activateTotp = useCallback(
    async (code: string): Promise<string[]> => {
      const active = sessionRef.current;
      if (!active) throw new Error("You are signed out.");
      const boundarySequence = boundarySequenceRef.current;
      return await runWithBrowserSessionLock(async () => {
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        const response = await apiRequest<BrowserTotpActivation>(
          "/api/auth/browser/mfa/totp/activate",
          {
            method: "POST",
            body: JSON.stringify({ code }),
          },
          active,
        );
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        setSession({ ...active, accessToken: response.accessToken });
        return response.recoveryCodes;
      });
    },
    [setSession],
  );

  const disableTotp = useCallback(
    async (codeType: MultiFactorCodeType, code: string) => {
      const active = sessionRef.current;
      if (!active) throw new Error("You are signed out.");
      const boundarySequence = boundarySequenceRef.current;
      await runWithBrowserSessionLock(async () => {
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        await apiRequest<void>(
          "/api/auth/browser/mfa/totp/disable",
          {
            method: "POST",
            body: JSON.stringify({ codeType, code }),
          },
          active,
        );
        assertSessionBoundaryCurrent(boundarySequence, boundarySequenceRef, acceptsRefreshRef);
        setSession(null);
      });
    },
    [setSession],
  );

  // Only for callers that already awaited exact browser revocation. A concurrent
  // replacement session must not be cleared by an acknowledgement for the old one.
  const completeConfirmedBrowserSignOut = useCallback((expectedSessionId: string) => {
    if (!expectedSessionId || sessionRef.current?.sessionId !== expectedSessionId) {
      throw new SessionIdentityMismatchError();
    }
    acceptsRefreshRef.current = false;
    setSession(null);
  }, [setSession]);

  // Privacy/UI boundary only: the remembered-account owner must separately
  // confirm server revocation. Never present this as a completed remote lock.
  const concealForAccountTransition = useCallback(() => {
    acceptsRefreshRef.current = false;
    boundarySequenceRef.current += 1;
    restoringIdentityRef.current = null;
    setRestoringIdentity(null);
    setRestorationError(null);
    setIsRestoring(false);
    void queryClient.cancelQueries();
    setSession(null);
    queryClient.clear();
  }, [queryClient, setSession]);

  // Called only after the Auth owner returns a confirmed current selection.
  // Explicit subject/session coordinates are checked against the returned token;
  // this does not mint identity, permissions or authentication assurance.
  const adoptBrowserAccount = useCallback((account: ApiSession) => {
    if (!account.subjectId || !account.sessionId) throw new SessionIdentityMismatchError();
    const verified = bindApiSessionIdentity(account, null);
    acceptsRefreshRef.current = true;
    restoringIdentityRef.current = null;
    setRestoringIdentity(null);
    setRestorationError(null);
    setIsRestoring(false);
    setSession(verified);
  }, [setSession]);

  const logout = useCallback(async () => {
    const active = sessionRef.current;
    acceptsRefreshRef.current = false;
    startBrowserSessionSignOut(
      () => setSession(null),
      active
        ? async () => {
          // The cookie lock may have been held by a newer sign-in. Local
          // sign-out already completed; never clean up its replacement cookie.
          const hasReplacementSession = () => {
            const current = sessionRef.current;
            const persisted = readSessionIdentity();
            return (current !== null && !matchesAuthenticationSession(current, active)) ||
              (persisted !== null && !matchesAuthenticationSession(persisted, active));
          };
          if (hasReplacementSession()) return;
          acceptsRefreshRef.current = false;
          try {
            await apiRequest<void>(
              "/api/auth/browser/sign-out",
              { method: "POST" },
              active,
            );
          } finally {
            if (!hasReplacementSession()) {
              acceptsRefreshRef.current = false;
              setSession(null);
            }
          }
        }
        : undefined,
    );
  }, [setSession]);

  const logoutAll = useCallback(async () => {
    const active = sessionRef.current;
    if (!active) {
      acceptsRefreshRef.current = false;
      setSession(null);
      return;
    }

    // Global revocation belongs to the initiating subject/session. A workspace
    // change keeps that intent; a different account or fresh sign-in does not.
    const isInitiatingSessionCurrent = () => {
      const persisted = readSessionIdentity();
      return matchesAuthenticationSession(sessionRef.current, active) &&
        (!persisted || matchesAuthenticationSession(persisted, active));
    };

    try {
      await apiRequest<void>(
        "/api/auth/sign-out-all",
        { method: "POST" },
        active,
      );
    } finally {
      await runWithBrowserSessionLock(async () => {
        if (!isInitiatingSessionCurrent()) return;
        acceptsRefreshRef.current = false;
        try {
          await apiRequest<void>(
            "/api/auth/browser/sign-out",
            { method: "POST" },
            active,
          );
        } catch {
          // Global revocation can make the cookie sign-out request unauthorized.
        }
        if (isInitiatingSessionCurrent()) setSession(null);
      });
    }
  }, [setSession]);

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      const active = sessionRef.current;
      if (!active) return;
      const tenantId = workspaceId.trim() || GLOBAL_IDENTITY_SCOPE;
      if (active.tenantId === tenantId) return;
      setSession({ ...active, tenantId, generation: createSessionGeneration() });
    },
    [setSession],
  );

  const renderedBoundarySequence = boundarySequenceRef.current;
  const captureRequestContext = useCallback((workspaceId?: string): SessionRequestContext => {
    // Async intent preparation must retain the actor and scope of its render.
    // The ordinary request function stays stable for existing query effects.
    assertSessionBoundaryCurrent(renderedBoundarySequence, boundarySequenceRef, acceptsRefreshRef);
    if (!session || !sessionRef.current) throw new Error("You are signed out.");
    if (workspaceId !== undefined && sessionRef.current.tenantId !== workspaceId) {
      throw new SessionBoundarySupersededError();
    }

    const bind = (sequence: number): SessionRequestContext => {
      const assertCurrent = () => assertSessionBoundaryCurrent(sequence, boundarySequenceRef, acceptsRefreshRef);
      return {
        assertCurrent,
        request: async <T,>(path: string, options?: RequestInit) => {
          assertCurrent();
          const result = await request<T>(path, options);
          assertCurrent();
          return result;
        },
        selectWorkspace: (nextWorkspaceId) => {
          // Onboarding may deliberately select the workspace just created. Do
          // this synchronously under the old guard and return its new guard.
          assertCurrent();
          selectWorkspace(nextWorkspaceId);
          return bind(boundarySequenceRef.current);
        },
      };
    };
    return bind(renderedBoundarySequence);
  }, [renderedBoundarySequence, request, selectWorkspace, session]);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      isRestoring,
      restorationError,
      restoringIdentity,
      retrySessionRestore: restoreSession,
      abandonSessionRestore,
      login: (credentials) => authenticate("login", credentials),
      register: async (credentials, onAuthenticated) => {
        await authenticate("register", credentials, onAuthenticated);
      },
      completeMultiFactorSignIn,
      activateTotp,
      disableTotp,
      beginExternalSignIn,
      beginExternalLink,
      completeExternalAuthentication,
      cancelExternalAuthentication,
      logout,
      completeConfirmedBrowserSignOut,
      concealForAccountTransition,
      adoptBrowserAccount,
      logoutAll,
      stepUpWithPassword,
      stepUpWithMultiFactor,
      selectWorkspace,
      captureRequestContext,
      request,
      download,
      stream,
    }),
    [
      authenticate,
      abandonSessionRestore,
      activateTotp,
      beginExternalLink,
      beginExternalSignIn,
      cancelExternalAuthentication,
      completeMultiFactorSignIn,
      completeExternalAuthentication,
      disableTotp,
      download,
      isRestoring,
      logout,
      completeConfirmedBrowserSignOut,
      concealForAccountTransition,
      adoptBrowserAccount,
      logoutAll,
      request,
      restorationError,
      restoreSession,
      restoringIdentity,
      selectWorkspace,
      captureRequestContext,
      session,
      stepUpWithPassword,
      stepUpWithMultiFactor,
      stream,
    ],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value)
    throw new Error("useSession must be used inside SessionProvider.");
  return value;
}

function matchesAuthenticationSession(identity: SessionIdentity | null, expected: ApiSession): boolean {
  if (!identity || !expected.subjectId || !expected.sessionId) return false;
  return identity.subjectId?.toLowerCase() === expected.subjectId.toLowerCase() &&
    identity.sessionId?.toLowerCase() === expected.sessionId.toLowerCase();
}

function readSessionIdentity(): SessionIdentity | null {
  try {
    return parseStoredSessionIdentity(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeSessionIdentity(session: SessionIdentity | null) {
  try {
    if (session) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializableSessionIdentity(session)));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // The in-memory session remains usable when durable browser storage is blocked.
  }
}

function parseStoredSessionIdentity(raw: string | null): SessionIdentity | null {
  if (!raw) return null;
  try {
    return parseSessionIdentity(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseSessionIdentity(value: unknown): SessionIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<SessionIdentity>;
  if (typeof candidate.tenantId !== "string" || typeof candidate.username !== "string") {
    return null;
  }
  return {
    tenantId: candidate.tenantId,
    username: candidate.username,
    ...(typeof candidate.subjectId === "string" ? { subjectId: candidate.subjectId } : {}),
    ...(typeof candidate.sessionId === "string" ? { sessionId: candidate.sessionId } : {}),
    ...(typeof candidate.generation === "string" ? { generation: candidate.generation } : {}),
  };
}

function serializableSessionIdentity(identity: SessionIdentity | null): SessionIdentity | null {
  return identity ? {
    tenantId: identity.tenantId,
    username: identity.username,
    ...(identity.subjectId ? { subjectId: identity.subjectId } : {}),
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
    ...(identity.generation ? { generation: identity.generation } : {}),
  } : null;
}

function sessionIdentitySignature(identity: SessionIdentity | null): string {
  return JSON.stringify(serializableSessionIdentity(identity));
}

function assertSessionBoundaryCurrent(
  expected: number,
  boundarySequence: RefObject<number>,
  acceptsRefresh: RefObject<boolean>,
) {
  if (!acceptsRefresh.current || boundarySequence.current !== expected) {
    throw new SessionBoundarySupersededError();
  }
}

function sessionFailureInvalidatesActor(error: unknown): boolean {
  return refreshFailureInvalidatesSession(error) || error instanceof SessionIdentityMismatchError;
}

type PendingExternalAuth = {
  intent: ExternalAuthenticationIntent;
  provider: string;
};

function externalReturnUrl(intent: PendingExternalAuth["intent"]): string {
  const url = new URL("/auth/complete", window.location.origin);
  url.searchParams.set("intent", intent);
  const apiBaseUrl = resolveApiBaseUrl();
  const apiOrigin = apiBaseUrl
    ? new URL(apiBaseUrl, window.location.origin).origin
    : window.location.origin;

  return apiOrigin === window.location.origin
    ? `${url.pathname}${url.search}`
    : url.toString();
}

function apiUrl(path: string): string {
  return path.startsWith("http://") || path.startsWith("https://")
    ? path
    : `${resolveApiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

function writePendingExternalAuth(pending: PendingExternalAuth) {
  try {
    sessionStorage.setItem(EXTERNAL_AUTH_KEY, JSON.stringify(pending));
  } catch {
    // The callback URL also carries non-secret recovery metadata.
  }
}

function readPendingExternalAuth(
  fallback: PendingExternalAuth | null,
): PendingExternalAuth | null {
  try {
    const raw = sessionStorage.getItem(EXTERNAL_AUTH_KEY);
    if (raw) {
      const candidate = JSON.parse(raw) as Partial<PendingExternalAuth>;
      if (
        (candidate.intent === "sign-in" || candidate.intent === "link") &&
        typeof candidate.provider === "string" &&
        candidate.provider.trim().length > 0
      ) {
        return candidate as PendingExternalAuth;
      }
    }
  } catch {
    // Fall through to the callback metadata.
  }

  return fallback?.provider.trim() ? fallback : null;
}

function clearPendingExternalAuth() {
  try {
    sessionStorage.removeItem(EXTERNAL_AUTH_KEY);
  } catch {
    // Storage can be unavailable in hardened browser modes.
  }
}

function externalStatus(
  status: ExternalAuthenticationResult["status"],
): string {
  const value: unknown = status;
  if (typeof value === "string") return value.toLowerCase();
  return value === 2 ? "linked" : value === 1 ? "authenticated" : "unknown";
}

function providerLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
