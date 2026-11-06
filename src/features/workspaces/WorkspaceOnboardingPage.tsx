import { useMutation } from "@tanstack/react-query";
import { ArrowRight, Building2, Check, Link2, LogOut, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import type { OrganizationMembershipSummary } from "../../api/types";
import { useNetworkStatus } from "../../app/networkStatus";
import { useSession, type SessionRequestContext } from "../../app/session";
import { useWorkspace } from "../../app/workspace";
import { BrandMark } from "../../components/ui/BrandMark";
import { ErrorState } from "../../components/ui/primitives";
import { waitForWorkspaceAccess } from "./workspaceAccess";
import { StaffProfileFields } from "./StaffProfileFields";
import { defaultStaffProfile } from "./staffOnboarding";
import {
  clearWorkspaceCreationAttempt,
  readWorkspaceCreationAttempt,
  resolveWorkspaceCreationAttempt,
  type WorkspaceCreationAttempt,
} from "./workspaceCreationAttempt";
import { WorkspaceCatalogueNotice } from "./WorkspaceCatalogueNotice";
import {
  continueWorkspaceOnboarding,
  recoverCreatedWorkspace,
} from "./workspaceOnboardingFlow";

export function WorkspaceOnboardingPage() {
  const { session } = useSession();
  return <WorkspaceOnboardingForm key={`${session?.subjectId ?? ""}:${session?.sessionId ?? ""}`} />;
}

function WorkspaceOnboardingForm() {
  const { isOffline } = useNetworkStatus();
  const navigate = useNavigate();
  const { logout, captureRequestContext, session } = useSession();
  const captureContext = useRef(captureRequestContext);
  captureContext.current = captureRequestContext;
  const { refetchWorkspaces, setSelectedWorkspaceId } = useWorkspace();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [staffProfile, setStaffProfile] = useState(() => defaultStaffProfile(session?.username));
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(null);
  const [step, setStep] = useState<"workspace" | "profile">("workspace");
  const [recoveryState, setRecoveryState] = useState<
    "restoring" | "ready" | "created" | "pending"
  >("restoring");
  const [recoveryError, setRecoveryError] = useState<unknown>(null);
  const creationAttempt = useRef<WorkspaceCreationAttempt | null>(null);

  useEffect(() => {
    let active = true;
    const accountId = session?.subjectId;
    creationAttempt.current = null;
    setCreatedWorkspaceId(null);
    setStep("workspace");
    setRecoveryError(null);
    setRecoveryState("restoring");

    if (!accountId) {
      setRecoveryState("ready");
      return () => {
        active = false;
      };
    }

    void (async () => {
      let context: SessionRequestContext;
      try {
        context = captureContext.current();
      } catch (error) {
        if (active) {
          setRecoveryError(error);
          setRecoveryState("ready");
        }
        return;
      }
      try {
        const attempt = await readWorkspaceCreationAttempt(accountId);
        if (!active) return;
        context.assertCurrent();
        creationAttempt.current = attempt;
        if (!attempt) {
          setRecoveryState("ready");
          return;
        }

        const workspace = await recoverCreatedWorkspace(context.request, attempt);
        if (!active) return;
        context.assertCurrent();
        if (!workspace) {
          setRecoveryState("pending");
          return;
        }

        setCreatedWorkspaceId(workspace.organization.organizationId);
        setName(workspace.organization.name);
        setSlug(workspace.organization.slug);
        setSlugEdited(true);
        setRecoveryState("created");
      } catch (error) {
        if (!active) return;
        try { context.assertCurrent(); } catch { return; }
        setRecoveryError(error);
        setRecoveryState("ready");
      }
    })();

    return () => {
      active = false;
    };
  }, [session?.subjectId]);

  const workspaceSetup = useMutation({
    mutationFn: async () => {
      const accountId = session?.subjectId;
      if (!accountId) throw new Error("You are signed out.");
      const context = captureRequestContext();
      let workspace: OrganizationMembershipSummary | null = null;
      if (!createdWorkspaceId) {
        const payload = { name: name.trim(), slug: slug.trim() };
        const attempt = await resolveWorkspaceCreationAttempt(
          creationAttempt.current,
          accountId,
          payload,
          { assertCurrent: context.assertCurrent },
        );
        context.assertCurrent();
        creationAttempt.current = attempt;
        workspace = await recoverCreatedWorkspace(context.request, attempt);
        workspace ??= await context.request<OrganizationMembershipSummary>(
          "/api/organizations",
          {
            method: "POST",
            body: JSON.stringify({
              operationId: attempt.operationId,
              ...payload,
            }),
          },
        );
      }
      const workspaceId = createdWorkspaceId ?? workspace!.organization.organizationId;
      context.assertCurrent();
      setCreatedWorkspaceId(workspaceId);
      const workspaceContext = context.selectWorkspace(workspaceId);
      await waitForWorkspaceAccess(workspaceContext.request, workspaceId);
      workspaceContext.assertCurrent();
      await refetchWorkspaces();
      workspaceContext.assertCurrent();
      setSelectedWorkspaceId(workspaceId);
      return workspaceContext;
    },
    onSuccess: (context) => {
      context.assertCurrent();
      setStep("profile");
    },
  });
  const profileSetup = useMutation({
    mutationFn: async () => {
      const accountId = session?.subjectId;
      if (!accountId || !createdWorkspaceId) throw new Error("Workspace setup is unavailable.");
      let context = captureRequestContext(createdWorkspaceId);
      await continueWorkspaceOnboarding({
        request: (path, options) => context.request(path, options),
        workspaceId: createdWorkspaceId,
        staffProfile,
        selectWorkspace: (workspaceId) => { context = context.selectWorkspace(workspaceId); },
        refetchWorkspaces: async () => {
          context.assertCurrent();
          await refetchWorkspaces();
          context.assertCurrent();
        },
        setSelectedWorkspaceId: (workspaceId) => {
          context.assertCurrent();
          setSelectedWorkspaceId(workspaceId);
        },
        clearCreationAttempt: () => clearWorkspaceCreationAttempt(accountId, undefined, context.assertCurrent),
      });
      context.assertCurrent();
      creationAttempt.current = null;
      return context;
    },
    onSuccess: (context) => {
      context.assertCurrent();
      navigate("/properties", { replace: true });
    },
  });

  function updateName(value: string) {
    setName(value);
    if (!slugEdited) setSlug(toSlug(value));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    workspaceSetup.mutate();
  }

  function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    profileSetup.mutate();
  }

  return (
    <main className="min-h-screen bg-base-200 px-4 py-8 sm:px-8 sm:py-14">
      <div className="mx-auto max-w-4xl">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <BrandMark variant="simple-white-bold" height={48} framed />
            <span className="font-display text-2xl font-semibold">BunkFy</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
          <Link to="/account?section=security" className="btn btn-ghost btn-sm">Account & security</Link>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void logout()}
          >
            <LogOut size={16} />
            Sign out
          </button>
          </div>
        </div>
        <WorkspaceCatalogueNotice
          className="mt-8"
          title="Your existing workspace list is delayed"
        />
        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_32rem] lg:items-start lg:gap-12">
          <section>
            <p className="text-xs font-bold uppercase text-primary">Workspace setup</p>
            <h1 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">
              Set up your operating workspace
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-base-content/60">
              A workspace owns the properties, staff access, reservations, and integrations for one operating team.
            </p>
            <ol className="mt-8 max-w-md space-y-3" aria-label="Workspace setup progress">
              <SetupStep
                active={step === "workspace"}
                complete={step === "profile"}
                icon={<Building2 size={17} />}
                title="Workspace identity"
                description="Name the operating team and create its secure boundary."
              />
              <SetupStep
                active={step === "profile"}
                complete={false}
                icon={<UserRound size={17} />}
                title="Your staff profile"
                description="Add the details your team will use in daily operations."
              />
            </ol>
            <button
              className="btn btn-ghost mt-8 px-0 text-primary"
              onClick={() => navigate("/join")}
            >
              <Link2 size={18} />
              Join with an invite link
            </button>
          </section>

          {recoveryState === "restoring" && <div className="alert alert-info mb-5 text-sm">Checking for an interrupted workspace setup…</div>}
          {recoveryState === "created" && <div className="alert alert-info mb-5 text-sm">This workspace was already created. Continue its setup to finish your staff profile.</div>}
          {recoveryState === "pending" && <div className="alert alert-warning mb-5 text-sm">An interrupted create attempt is ready to retry. Re-enter the same workspace details to reuse it safely.</div>}
          {Boolean(recoveryError) && <div className="mb-5"><ErrorState error={recoveryError} title="Workspace setup could not be checked" /></div>}
          {step === "workspace" ? (
            <form className="rounded-lg border border-base-300 bg-base-100 p-5 shadow-sm sm:p-6" onSubmit={submit}>
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
                  <Building2 size={20} />
                </span>
                <div>
                  <p className="text-xs font-bold uppercase text-base-content/45">Step 1 of 2</p>
                  <h2 className="font-display text-xl font-semibold">Create the workspace</h2>
                </div>
              </div>
              <label className="mt-6 block">
                <span className="mb-1.5 block text-sm font-semibold">Workspace name</span>
                <input
                  className="input input-bordered w-full"
                  value={name}
                  onChange={(event) => {
                    workspaceSetup.reset();
                    updateName(event.target.value);
                  }}
                  placeholder="Harbor House"
                  autoFocus
                  required
                  maxLength={160}
                  disabled={workspaceSetup.isPending || createdWorkspaceId !== null}
                />
              </label>
              <label className="mt-4 block">
                <span className="mb-1.5 block text-sm font-semibold">Workspace handle</span>
                <input
                  className="input input-bordered w-full"
                  value={slug}
                  onChange={(event) => {
                    workspaceSetup.reset();
                    setSlugEdited(true);
                    setSlug(toSlug(event.target.value));
                  }}
                  placeholder="harbor-house"
                  required
                  maxLength={80}
                  disabled={workspaceSetup.isPending || createdWorkspaceId !== null}
                />
              </label>
              {createdWorkspaceId && workspaceSetup.isError && (
                <div className="alert alert-warning mt-5 py-3 text-sm">
                  <div>
                    <p className="font-semibold">The workspace was created.</p>
                    <p className="mt-1">Its access setup is still finishing. Retry without creating a duplicate workspace.</p>
                  </div>
                </div>
              )}
              {workspaceSetup.error && (
                <div className="mt-5"><ErrorState error={workspaceSetup.error} title={createdWorkspaceId ? "Workspace access setup is still pending" : "Workspace could not be created"} /></div>
              )}
              <button className="btn btn-primary mt-6 w-full text-white" disabled={isOffline || workspaceSetup.isPending || recoveryState === "restoring"} title={isOffline ? "Reconnect before creating a workspace." : undefined}>
                {workspaceSetup.isPending && <span className="loading loading-spinner loading-sm" />}
                {createdWorkspaceId ? "Retry workspace setup" : "Create and continue"}
                {!workspaceSetup.isPending && <ArrowRight size={17} />}
              </button>
            </form>
          ) : (
            <form className="rounded-lg border border-base-300 bg-base-100 p-5 shadow-sm sm:p-6" onSubmit={submitProfile}>
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
                  <UserRound size={20} />
                </span>
                <div>
                  <p className="text-xs font-bold uppercase text-base-content/45">Step 2 of 2</p>
                  <h2 className="font-display text-xl font-semibold">Create your staff profile</h2>
                </div>
              </div>
              <div className="mt-5 flex items-start gap-3 rounded-lg bg-success/10 px-4 py-3 text-sm">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-success text-success-content">
                  <Check size={14} strokeWidth={3} />
                </span>
                <div>
                  <p className="font-semibold">{name} is ready</p>
                  <p className="mt-0.5 leading-5 text-base-content/55">Finish your owner profile to enter the workspace.</p>
                </div>
              </div>
              <div className="mt-6">
                <StaffProfileFields value={staffProfile} onChange={(next) => {
                  profileSetup.reset();
                  setStaffProfile(next);
                }} />
              </div>
              {profileSetup.error && (
                <div className="mt-5"><ErrorState error={profileSetup.error} title="Staff profile could not be completed" /></div>
              )}
              <button className="btn btn-primary mt-6 w-full text-white" disabled={isOffline || profileSetup.isPending} title={isOffline ? "Reconnect before completing the staff profile." : undefined}>
                {profileSetup.isPending && <span className="loading loading-spinner loading-sm" />}
                Finish setup
                {!profileSetup.isPending && <ArrowRight size={17} />}
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}

function SetupStep({
  active,
  complete,
  icon,
  title,
  description,
}: {
  active: boolean;
  complete: boolean;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <li className={`flex items-start gap-3 rounded-lg px-3 py-2.5 ${active ? "bg-base-100 shadow-xs" : ""}`}>
      <span
        className={`grid size-8 shrink-0 place-items-center rounded-full ${
          active || complete ? "bg-primary text-primary-content" : "border border-base-300 bg-base-100 text-base-content/45"
        }`}
      >
        {complete ? <Check size={15} strokeWidth={3} /> : icon}
      </span>
      <span>
        <span className={`block text-sm font-semibold ${active || complete ? "text-base-content" : "text-base-content/55"}`}>{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-base-content/50">{description}</span>
      </span>
    </li>
  );
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
