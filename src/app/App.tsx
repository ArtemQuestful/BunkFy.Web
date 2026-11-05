import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router";
import { AppShell } from "../components/layout/AppShell";
import { AuthPage } from "../features/auth/AuthPage";
import { AuthCompletionPage } from "../features/auth/AuthCompletionPage";
import { SessionRecoveryPage } from "../features/auth/SessionRecoveryPage";
import { NotificationsProvider } from "../features/notifications/notifications";
import { useSession } from "./session";
import { WorkspaceProvider, useWorkspace } from "./workspace";
import { WorkspaceGate } from "../features/workspaces/WorkspaceGate";
import {
  parseWorkspaceJoinSecret,
  prepareWorkspaceJoinContext,
  preserveWorkspaceJoinContext,
  readLegacyWorkspaceJoinSecret,
} from "../features/workspaces/workspaceJoin";
import { useQueryClient } from "@tanstack/react-query";
import { clearLegacyPendingEnrollment } from "../features/workspaces/workspaceJoinPending";
import {
  RenderErrorBoundary,
  RouteRenderFailure,
} from "./RenderErrorBoundary";
import { LoadingState } from "../components/ui/primitives";
import { AccessAuthorityProvider } from "./accessAuthority";
import { OperationalPreviewHost } from "../features/operational-preview/OperationalPreviewHost";
import { OperationalPreviewProvider } from "../features/operational-preview/OperationalPreviewProvider";
import { RouteNavigationLeaseProvider, useCurrentRouteNavigationLease } from "./routeNavigationLease";

const AccountPage = lazy(() =>
  import("../features/account/AccountPage").then((module) => ({
    default: module.AccountPage,
  })),
);
const DashboardPage = lazy(() =>
  import("../features/dashboard/DashboardPage").then((module) => ({
    default: module.DashboardPage,
  })),
);
const CalendarPage = lazy(() =>
  import("../features/calendar/CalendarPage").then((module) => ({
    default: module.CalendarPage,
  })),
);
const GuestsPage = lazy(() =>
  import("../features/guests/GuestsPage").then((module) => ({
    default: module.GuestsPage,
  })),
);
const InventoryPage = lazy(() =>
  import("../features/inventory/InventoryPage").then((module) => ({
    default: module.InventoryPage,
  })),
);
const IntegrationsPage = lazy(() =>
  import("../features/integrations/IntegrationsPage").then((module) => ({
    default: module.IntegrationsPage,
  })),
);
const NotificationsPage = lazy(() =>
  import("../features/notifications/NotificationsPage").then((module) => ({
    default: module.NotificationsPage,
  })),
);
const PropertiesPage = lazy(() =>
  import("../features/properties/PropertiesPage").then((module) => ({
    default: module.PropertiesPage,
  })),
);
const PrivacyRequestsPage = lazy(() =>
  import("../features/data-rights/PrivacyRequestsPage").then((module) => ({
    default: module.PrivacyRequestsPage,
  })),
);
const ReservationsPage = lazy(() =>
  import("../features/reservations/ReservationsPage").then((module) => ({
    default: module.ReservationsPage,
  })),
);
const StaffPage = lazy(() =>
  import("../features/staff/StaffPage").then((module) => ({
    default: module.StaffPage,
  })),
);
const SpacesPage = lazy(() =>
  import("../features/spaces/SpacesPage").then((module) => ({
    default: module.SpacesPage,
  })),
);
const WorkspaceSettingsPage = lazy(() =>
  import("../features/workspaces/WorkspaceSettingsPage").then((module) => ({
    default: module.WorkspaceSettingsPage,
  })),
);

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [joinPreparationError, setJoinPreparationError] = useState<string | null>(null);
  const [joinPreparationRetry, setJoinPreparationRetry] = useState(0);
  const hasIncomingJoin = location.pathname === "/join" && Boolean(
    parseWorkspaceJoinSecret(location.hash) ?? readLegacyWorkspaceJoinSecret(),
  );
  useEffect(clearLegacyPendingEnrollment, []);
  const {
    abandonSessionRestore,
    isRestoring,
    restorationError,
    restoringIdentity,
    retrySessionRestore,
    session,
  } = useSession();
  useEffect(() => {
    if (location.pathname !== "/join") return;
    const incoming = parseWorkspaceJoinSecret(location.hash) ?? readLegacyWorkspaceJoinSecret();
    if (!incoming) return;
    let cancelled = false;
    setJoinPreparationError(null);
    void prepareWorkspaceJoinContext(incoming).then(({ context, preview }) => {
      if (cancelled) return;
      preserveWorkspaceJoinContext(context);
      queryClient.setQueryData(["workspace-join-preview", context.kind, context.contextId], preview);
      navigate(`${location.pathname}${location.search}`, { replace: true });
    }).catch(error => {
      if (!cancelled) setJoinPreparationError(error instanceof Error
        ? error.message : "The invitation could not be prepared. Check your connection and try again.");
    });
    return () => { cancelled = true; };
  }, [location.hash, location.pathname, location.search, navigate, queryClient, joinPreparationRetry]);

  if (location.pathname === "/auth/complete") {
    return <AuthCompletionPage />;
  }
  if (hasIncomingJoin) {
    return <main className="grid min-h-screen place-items-center bg-base-200 p-6">
      <section className="w-full max-w-lg rounded-lg border border-base-300 bg-base-100 p-7 shadow-sm">
        <h1 className="font-display text-2xl font-semibold">Preparing your invitation</h1>
        {joinPreparationError ? <>
          <p role="alert" className="my-4 text-sm">{joinPreparationError}</p>
          <button className="btn btn-primary" onClick={() => setJoinPreparationRetry(value => value + 1)}>Try again</button>
        </> : <LoadingState label="Keep this page open while we prepare your invitation" />}
      </section>
    </main>;
  }
  if (restoringIdentity && (isRestoring || restorationError)) {
    return <SessionRecoveryPage
      error={restorationError}
      identity={restoringIdentity}
      isRestoring={isRestoring}
      onRetry={() => void retrySessionRestore()}
      onUseAnotherAccount={abandonSessionRestore}
    />;
  }
  if (!session) return <AuthPage invitation={location.pathname === "/join"} />;

  return (
    <WorkspaceProvider>
      <AccessAuthorityProvider>
        <WorkspaceGate>
          <WorkspaceNotificationsProvider>
            <RouteNavigationLeaseProvider>
              <LeasedApplicationRoutes />
            </RouteNavigationLeaseProvider>
          </WorkspaceNotificationsProvider>
        </WorkspaceGate>
      </AccessAuthorityProvider>
    </WorkspaceProvider>
  );
}

function WorkspaceNotificationsProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const { selectedWorkspace, selectedWorkspaceId } = useWorkspace();
  return <NotificationsProvider enabled={Boolean(selectedWorkspace && selectedWorkspaceId && session?.tenantId === selectedWorkspaceId)}>{children}</NotificationsProvider>;
}

function LeasedApplicationRoutes() {
  const { effectiveLocation } = useCurrentRouteNavigationLease();
  return <Routes location={effectiveLocation}>
    <Route element={<ApplicationRouteLayout />}>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/calendar" element={<CalendarPage />} />
      <Route path="/spaces" element={<SpacesPage />} />
      <Route path="/properties" element={<PropertiesPage />} />
      <Route path="/privacy-requests" element={<PrivacyRequestsPage />} />
      <Route path="/inventory" element={<InventoryPage />} />
      <Route path="/integrations" element={<IntegrationsPage />} />
      <Route path="/notifications" element={<NotificationsPage />} />
      <Route path="/account" element={<AccountPage />} />
      <Route path="/workspace" element={<WorkspaceSettingsPage />} />
      <Route path="/reservations" element={<ReservationsPage />} />
      <Route path="/guests" element={<GuestsPage />} />
      <Route path="/staff" element={<StaffPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
  </Routes>;
}

function ApplicationRouteLayout() {
  const location = useLocation();
  return <OperationalPreviewProvider>
    <AppShell>
      <RenderErrorBoundary fallback={<RouteRenderFailure />} resetKey={location.key}>
        <Suspense fallback={<LoadingState label="Opening page" />}>
          <RouteViewportReset pathname={location.pathname} />
          <Outlet />
        </Suspense>
      </RenderErrorBoundary>
    </AppShell>
    <OperationalPreviewHost />
  </OperationalPreviewProvider>;
}

function RouteViewportReset({ pathname }: { pathname: string }) {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}
