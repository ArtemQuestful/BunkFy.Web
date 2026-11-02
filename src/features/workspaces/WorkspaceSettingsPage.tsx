import { useMutation, useQuery } from "@tanstack/react-query";
import { DatabaseZap, Monitor, Settings2, ShieldCheck, UserPlus, UsersRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type {
  Organization,
  OrganizationMemberListResponse,
  OrganizationMembership,
  StaffAccountDirectoryResponse,
} from "../../api/types";
import {
  compositeSourceCurrent,
  createCompositeSource,
} from "../../app/compositeSourceState";
import { useNetworkStatus } from "../../app/networkStatus";
import { useSession } from "../../app/session";
import {
  permissions,
  tenantAccessScope,
  usePermissions,
} from "../../app/permissions";
import { useWorkspace } from "../../app/workspace";
import {
  CompositeSourceFallback,
  CompositeSourceNotice,
} from "../../components/ui/CompositeSourceNotice";
import { ErrorState, PageHeader } from "../../components/ui/primitives";
import { SelectPicker } from "../../components/ui/SelectPicker";
import { WorkspaceInvitesSettings } from "./WorkspaceInvitesSettings";
import { WorkspaceMembersSettings } from "./WorkspaceMembersSettings";
import { useWorkspaceCatalogueSource } from "./WorkspaceCatalogueNotice";
import { RetentionHealthSettings } from "./RetentionHealthSettings";
import { WorkspaceRolesSettings } from "./WorkspaceRolesSettings";
import { WorkspaceStationsSettings } from "./WorkspaceStationsSettings";
import { useProductCapabilities } from "../../app/productCapabilities";
import {
  resolveWorkspaceSettingsCapabilities,
  shouldRedirectWorkspaceSettingsTab,
  type WorkspaceSettingsTab,
  workspaceSettingsTab,
} from "./workspaceSettingsAccess";
import {
  clearWorkspaceUpdateAttempt,
  resolveWorkspaceUpdateAttempt,
  type WorkspaceUpdateAttempt,
  type WorkspaceUpdatePayload,
} from "./workspaceUpdateAttempt";

const MEMBERS_PAGE_SIZE = 25;

export function WorkspaceSettingsPage() {
  const { staffPinEnabled } = useProductCapabilities();
  const { request, session } = useSession();
  const {
    selectedWorkspace,
    properties,
    propertiesLoaded,
    propertiesLoading,
    propertiesFetching,
    propertiesError,
    refetchProperties,
    refetchWorkspaces,
    stationSettings,
    stationSettingsLoaded,
    stationSettingsLoading,
    stationSettingsError,
    refetchStationSettings,
  } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = workspaceSettingsTab(searchParams.get("section"));
  const [memberPage, setMemberPage] = useState(1);
  const workspaceSource = useWorkspaceCatalogueSource();
  const workspaceAuthorityCurrent = compositeSourceCurrent(workspaceSource);
  const workspace = selectedWorkspace?.organization;
  const owner = isOwner(selectedWorkspace?.membership.role);
  const tenantScope = session ? tenantAccessScope(session.tenantId) : "";
  const permissionAccess = usePermissions(session && !owner
    ? [
      { permission: permissions.accessProfilesRead, scope: tenantScope },
      { permission: permissions.accessProfilesManage, scope: tenantScope },
      { permission: permissions.workspaceStaffOnboardingManage, scope: tenantScope },
      { permission: permissions.retentionRead, scope: tenantScope },
      { permission: permissions.retentionRetry, scope: tenantScope },
      { permission: permissions.stationsManage, scope: tenantScope },
    ]
    : []);
  const permissionSource = owner ? null : createCompositeSource({
    label: "Workspace permissions",
    hasData: permissionAccess.hasData,
    isLoading: permissionAccess.isLoading,
    error: permissionAccess.error,
    isFetching: permissionAccess.isFetching,
    refetch: permissionAccess.refetch,
  });
  const permissionAuthorityCurrent = workspaceAuthorityCurrent && (
    owner || Boolean(permissionSource && compositeSourceCurrent(permissionSource))
  );
  const propertySource = createCompositeSource({
    label: "Property directory",
    hasData: propertiesLoaded,
    isLoading: propertiesLoading,
    error: propertiesError,
    isFetching: propertiesFetching,
    refetch: refetchProperties,
  });
  const capabilities = resolveWorkspaceSettingsCapabilities({
    owner,
    profilesRead: permissionAccess.allows(permissions.accessProfilesRead, tenantScope),
    profilesManage: permissionAccess.allows(permissions.accessProfilesManage, tenantScope),
    staffOnboardingManage: permissionAccess.allows(
      permissions.workspaceStaffOnboardingManage,
      tenantScope,
    ),
    retentionRead: permissionAccess.allows(permissions.retentionRead, tenantScope),
    retentionRetry: permissionAccess.allows(permissions.retentionRetry, tenantScope),
  });
  const canManageStationSettings = owner || permissionAccess.allows(permissions.stationsManage, tenantScope);
  const members = useQuery({
    queryKey: ["organizations", workspace?.organizationId, "members", memberPage],
    queryFn: () => request<OrganizationMemberListResponse>(
      `/api/organizations/${workspace?.organizationId}/members?page=${memberPage}&pageSize=${MEMBERS_PAGE_SIZE}`,
    ),
    enabled: Boolean(workspace && owner && tab === "members"),
  });
  const memberSubjectIds = useMemo(
    () => (members.data?.items ?? []).map((membership) => membership.subjectId),
    [members.data?.items],
  );
  const accountDirectory = useQuery({
    queryKey: [
      "staff-account-directory",
      workspace?.organizationId,
      memberPage,
      memberSubjectIds.join("|"),
    ],
    queryFn: () => request<StaffAccountDirectoryResponse>(
      "/api/staff/members/account-directory/resolve",
      {
        method: "POST",
        body: JSON.stringify({ authSubjectIds: memberSubjectIds }),
      },
    ),
    enabled: Boolean(
      workspace &&
      owner &&
      tab === "members" &&
      memberSubjectIds.length,
    ),
    retry: false,
  });
  const memberSource = createCompositeSource({
    label: "Workspace members",
    hasData: members.data !== undefined,
    isLoading: members.isLoading,
    error: members.error,
    isFetching: members.isFetching,
    refetch: () => members.refetch(),
  });
  const accountDirectorySource = memberSubjectIds.length ? createCompositeSource({
    label: "Linked Staff profiles",
    hasData: accountDirectory.data !== undefined,
    isLoading: accountDirectory.isLoading,
    error: accountDirectory.error,
    isFetching: accountDirectory.isFetching,
    refetch: () => accountDirectory.refetch(),
  }) : null;

  const selectTab = useCallback((nextTab: WorkspaceSettingsTab) => {
    const next = new URLSearchParams(searchParams);
    if (nextTab === "general") next.delete("section");
    else next.set("section", nextTab);
    if (nextTab !== "invites") next.delete("joining");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => setMemberPage(1), [workspace?.organizationId]);
  useEffect(() => {
    if (shouldRedirectWorkspaceSettingsTab(
      tab,
      capabilities,
      permissionAuthorityCurrent,
    )) {
      selectTab("general");
    }
  }, [capabilities, permissionAuthorityCurrent, selectTab, tab]);
  useEffect(() => {
    if (!members.isFetching && memberPage > 1 && members.data?.items.length === 0) {
      setMemberPage((current) => Math.max(1, current - 1));
    }
  }, [memberPage, members.data?.items.length, members.isFetching]);

  if (!workspace || !selectedWorkspace) return null;

  async function refreshWorkspace() {
    if (owner) {
      await Promise.all([
        refetchWorkspaces(),
        members.refetch(),
        ...(memberSubjectIds.length ? [accountDirectory.refetch()] : []),
      ]);
      return;
    }

    await refetchWorkspaces();
  }

  async function refreshRetentionAuthority() {
    const refreshes: Promise<unknown>[] = [workspaceSource.refetch()];
    if (permissionSource) refreshes.push(permissionSource.refetch());
    await Promise.all(refreshes);
  }

  const navigation = [
    { value: "stations" as const, label: "Shared stations", description: "Staff PIN and shared browsers", icon: Monitor, visible: staffPinEnabled },
    {
      value: "general" as const,
      label: "Workspace",
      description: "Name and identity",
      icon: Settings2,
      visible: true,
    },
    {
      value: "members" as const,
      label: "Members",
      description: "Governance and access",
      icon: UsersRound,
      visible: capabilities.canReadMembers,
    },
    {
      value: "roles" as const,
      label: "Access roles",
      description: "Reusable permission sets",
      icon: ShieldCheck,
      visible: capabilities.canReadRoles,
    },
    {
      value: "invites" as const,
      label: "Joining",
      description: "Invites, team QR, requests",
      icon: UserPlus,
      visible: capabilities.canManageInvites,
    },
    {
      value: "retention" as const,
      label: "Data retention",
      description: "Workspace governance",
      icon: DatabaseZap,
      visible: capabilities.canReadRetention,
    },
  ].filter((item) => item.visible);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workspace settings"
        title={workspace.name}
        description="Manage workspace identity, governance membership, operational access, joining, and data retention."
        action={(
          <span className={`badge h-8 gap-2 border-0 px-3 font-semibold text-white ${owner && workspaceAuthorityCurrent ? "bg-primary" : owner ? "bg-warning-content" : "bg-neutral"}`}>
            <ShieldCheck size={15} />
            {owner ? workspaceAuthorityCurrent ? "Owner" : "Owner snapshot" : "Member"}
          </span>
        )}
      />
      {permissionSource && (
        <CompositeSourceNotice
          sources={[permissionSource]}
          title="Workspace authority is delayed"
        />
      )}

      <div className="grid gap-5 xl:grid-cols-[252px_minmax(0,1fr)] xl:items-start">
        <div className="min-w-0">
          <div className="xl:hidden">
            <label className="form-control block">
              <span className="mb-1.5 block text-sm font-semibold">Settings section</span>
              <SelectPicker
                value={tab}
                onValueChange={(value) => selectTab(workspaceSettingsTab(value))}
                ariaLabel="Workspace settings section"
                options={navigation.map((item) => ({
                  value: item.value,
                  label: item.label,
                  description: item.description,
                }))}
              />
            </label>
          </div>
          <aside
            className="hidden rounded-lg border border-base-300 bg-base-100 p-2 shadow-sm xl:sticky xl:top-20 xl:block"
            aria-label="Workspace settings sections"
          >
            {navigation.map((item) => {
              const Icon = item.icon;
              const active = tab === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition ${active ? "bg-primary/10 text-primary shadow-[inset_3px_0_0_var(--color-primary)]" : "text-base-content hover:bg-base-200"}`}
                  onClick={() => selectTab(item.value)}
                >
                  <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${active ? "bg-primary text-white" : "bg-base-200 text-base-content/55"}`}>
                    <Icon size={17} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{item.label}</span>
                    <span className="mt-0.5 block truncate text-xs opacity-55">{item.description}</span>
                  </span>
                </button>
              );
            })}
          </aside>
        </div>

        <section className="min-w-0 overflow-visible rounded-lg border border-base-300 bg-base-100 shadow-sm">
          <div className="p-5 sm:p-6">
          {tab !== "general" && !permissionAuthorityCurrent && permissionSource && (
            <CompositeSourceFallback
              state={permissionSource.state}
              label="workspace settings access"
            />
          )}
          {tab === "general" && (
            <GeneralSettings
              key={`${workspace.organizationId}:${session?.subjectId ?? ""}:${session?.sessionId ?? ""}`}
              workspace={workspace}
              accountId={session?.subjectId ?? ""}
              owner={owner}
              authorityCurrent={workspaceAuthorityCurrent}
              onSaved={refetchWorkspaces}
            />
          )}
          {tab === "stations" && (staffPinEnabled ? (
            <WorkspaceStationsSettings
              settings={stationSettings}
              settingsLoaded={stationSettingsLoaded}
              settingsLoading={stationSettingsLoading}
              settingsError={stationSettingsError}
              canManageSettings={canManageStationSettings && permissionAuthorityCurrent}
              onSettingsChanged={refetchStationSettings}
            />
          ) : <p className="text-sm">Shared stations are not enabled for this environment.</p>)}
          {tab === "members" && capabilities.canReadMembers && (
            <WorkspaceMembersSettings
              workspace={workspace}
              currentMembership={selectedWorkspace.membership}
              memberships={members.data?.items ?? []}
              currentUsername={session?.username ?? ""}
              properties={properties}
              propertySource={propertySource}
              memberSource={memberSource}
              accountDirectorySource={accountDirectorySource}
              staffDirectory={accountDirectory.data?.items ?? []}
              authorityCurrent={workspaceAuthorityCurrent}
              page={memberPage}
              pageSize={MEMBERS_PAGE_SIZE}
              hasMore={members.data?.hasMore}
              onChanged={refreshWorkspace}
              onPageChange={setMemberPage}
            />
          )}
          {tab === "roles" && capabilities.canReadRoles && (
            <WorkspaceRolesSettings
              workspaceId={workspace.organizationId}
              canManage={capabilities.canManageRoles && permissionAuthorityCurrent}
            />
          )}
          {tab === "invites" && capabilities.canManageInvites && (
            <WorkspaceInvitesSettings
              key={`${workspace.organizationId}:${session?.subjectId ?? ""}:${session?.sessionId ?? ""}`}
              workspaceId={workspace.organizationId}
              properties={properties}
              propertySource={propertySource}
              canGrant={permissionAuthorityCurrent}
              onMembershipChanged={refreshWorkspace}
            />
          )}
          {tab === "retention" && capabilities.canReadRetention && (
            <RetentionHealthSettings
              key={`${workspace.organizationId}:${session?.username.trim().toLowerCase() ?? ""}`}
              canRetry={capabilities.canRetryRetention}
              authorityCurrent={permissionAuthorityCurrent}
              onRefreshAuthority={refreshRetentionAuthority}
            />
          )}
          </div>
        </section>
      </div>
    </div>
  );
}

function GeneralSettings({
  workspace,
  accountId,
  owner,
  authorityCurrent,
  onSaved,
}: {
  workspace: Organization;
  accountId: string;
  owner: boolean;
  authorityCurrent: boolean;
  onSaved: () => Promise<void>;
}) {
  const { isOffline } = useNetworkStatus();
  const { captureRequestContext } = useSession();
  const canManage = owner && authorityCurrent;
  const [name, setName] = useState(workspace.name);
  const [slug, setSlug] = useState(workspace.slug);
  const updateAttempt = useRef<WorkspaceUpdateAttempt | null>(null);
  const update = useMutation({
    mutationFn: async () => {
      if (!accountId) throw new Error("You are signed out.");
      const context = captureRequestContext(workspace.organizationId);
      const payload: WorkspaceUpdatePayload = {
        organizationId: workspace.organizationId,
        expectedVersion: workspace.version,
        name,
        slug,
      };
      const attempt = await resolveWorkspaceUpdateAttempt(
        updateAttempt.current,
        accountId,
        payload,
        { assertCurrent: context.assertCurrent },
      );
      context.assertCurrent();
      updateAttempt.current = attempt;
      const result = await context.request<Organization>(
        `/api/organizations/${workspace.organizationId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            operationId: attempt.operationId,
            name: name.trim(),
            slug: slug.trim(),
            expectedVersion: workspace.version,
          }),
        },
      );
      return { result, context };
    },
    onSuccess: async ({ context }) => {
      context.assertCurrent();
      await onSaved();
      context.assertCurrent();
      await clearWorkspaceUpdateAttempt(accountId, workspace.organizationId, undefined, context.assertCurrent);
      context.assertCurrent();
      updateAttempt.current = null;
    },
  });
  return (
    <section className="max-w-3xl">
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Settings2 size={20} />
        </span>
        <div>
          <h2 className="font-display text-xl font-semibold">Workspace details</h2>
          <p className="mt-1 text-sm leading-6 text-base-content/55">The name and handle shown throughout your team workspace.</p>
        </div>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="form-control block">
          <span className="mb-1.5 block text-sm font-semibold">Name</span>
          <input className="input input-bordered w-full" value={name} onChange={(event) => setName(event.target.value)} disabled={!canManage} />
        </label>
        <label className="form-control block">
          <span className="mb-1.5 block text-sm font-semibold">Handle</span>
          <input className="input input-bordered w-full" value={slug} onChange={(event) => setSlug(event.target.value)} disabled={!canManage} />
        </label>
      </div>
      {!canManage && (
        <div className="mt-5 flex items-start gap-3 rounded-lg bg-base-200/70 p-4 text-sm text-base-content/60">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-primary" />
          {owner
            ? "Refresh the workspace list before changing workspace identity."
            : "Workspace identity can only be changed by the owner."}
        </div>
      )}
      {update.error && <SettingsError error={update.error} />}
      {canManage && (
        <div className="mt-5 flex justify-end border-t border-base-300 pt-5">
          <button
            className="btn btn-primary text-white"
            onClick={() => update.mutate()}
            disabled={isOffline || update.isPending || !name.trim() || !slug.trim()}
            title={isOffline ? "Reconnect before saving changes." : undefined}
          >
            {update.isPending && <span className="loading loading-spinner loading-sm" />}Save changes
          </button>
        </div>
      )}
    </section>
  );
}

function SettingsError({ error }: { error: unknown }) {
  return <div className="mt-5"><ErrorState error={error} /></div>;
}

function isOwner(role: OrganizationMembership["role"] | undefined): boolean {
  return role === "owner";
}
