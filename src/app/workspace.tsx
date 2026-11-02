import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  OrganizationMembershipSummary,
  Property,
  StationWorkspaceSettings,
} from "../api/types";
import { loadAllProperties } from "../features/properties/propertiesApi";
import { reconcileSelectedWorkspaceId } from "../features/workspaces/workspaceCatalogue";
import { loadAllWorkspaces } from "../features/workspaces/workspacesApi";
import { useSession } from "./session";
import { useProductCapabilities } from "./productCapabilities";

const WORKSPACE_STORAGE_KEY = "bunkfy.workspace.current.v1";

type WorkspaceValue = {
  workspaces: OrganizationMembershipSummary[];
  workspacesLoaded: boolean;
  workspacesLoading: boolean;
  workspacesFetching: boolean;
  workspacesError: unknown;
  selectedWorkspace: OrganizationMembershipSummary | null;
  selectedWorkspaceId: string;
  setSelectedWorkspaceId: (id: string) => void;
  refetchWorkspaces: () => Promise<void>;
  properties: Property[];
  propertiesLoaded: boolean;
  propertiesLoading: boolean;
  propertiesFetching: boolean;
  propertiesError: unknown;
  selectedProperty: Property | null;
  selectedPropertyId: string;
  setSelectedPropertyId: (id: string) => void;
  refetchProperties: () => Promise<void>;
  stationSettings: StationWorkspaceSettings | null;
  stationSettingsLoaded: boolean;
  stationSettingsLoading: boolean;
  stationSettingsFetching: boolean;
  stationSettingsError: unknown;
  refetchStationSettings: () => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { request, selectWorkspace, session } = useSession();
  const { staffPinEnabled } = useProductCapabilities();
  const [selectedWorkspaceId, setSelectedWorkspaceIdState] = useState(() => {
    if (session?.tenantId && session.tenantId !== "global") return session.tenantId;
    return localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "";
  });
  const workspacesQuery = useQuery({
    queryKey: ["organizations", "mine"],
    queryFn: (context) => loadAllWorkspaces(request, context.signal),
  });
  const workspaces = workspacesQuery.data ?? [];
  const workspaceCatalogueCurrent = Boolean(
    workspacesQuery.data !== undefined &&
      !workspacesQuery.error &&
      !workspacesQuery.isFetching,
  );

  useEffect(() => {
    if (!workspaceCatalogueCurrent) return;
    const nextId = reconcileSelectedWorkspaceId(
      selectedWorkspaceId,
      workspaces.map((item) => item.organization.organizationId),
      true,
    );
    if (nextId !== selectedWorkspaceId) setSelectedWorkspaceIdState(nextId);
    selectWorkspace(nextId);
    if (nextId) localStorage.setItem(WORKSPACE_STORAGE_KEY, nextId);
    else localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  }, [
    selectWorkspace,
    selectedWorkspaceId,
    workspaceCatalogueCurrent,
    workspaces,
  ]);

  const setSelectedWorkspaceId = useCallback(
    (id: string) => {
      setSelectedWorkspaceIdState(id);
      selectWorkspace(id);
      if (id) localStorage.setItem(WORKSPACE_STORAGE_KEY, id);
    },
    [selectWorkspace],
  );

  const propertyStorageKey = `bunkfy.property.${selectedWorkspaceId || "none"}`;
  const [selectedPropertyId, setSelectedPropertyIdState] = useState("");
  const workspaceScopeReady = Boolean(
    selectedWorkspaceId && session?.tenantId === selectedWorkspaceId,
  );
  const propertiesQuery = useQuery({
    queryKey: ["properties", selectedWorkspaceId],
    queryFn: (context) => loadAllProperties(request, context.signal),
    enabled: workspaceScopeReady,
  });
  const properties = propertiesQuery.data?.properties ?? [];
  const propertyCatalogueCurrent = Boolean(
    propertiesQuery.data !== undefined &&
      !propertiesQuery.error &&
      !propertiesQuery.isFetching,
  );

  const stationSettingsQuery = useQuery({
    queryKey: ["station-settings", selectedWorkspaceId],
    queryFn: () => request<StationWorkspaceSettings>("/api/station-settings/workspace"),
    enabled: workspaceScopeReady && staffPinEnabled === true,
    retry: false,
  });

  useEffect(() => {
    setSelectedPropertyIdState(localStorage.getItem(propertyStorageKey) ?? "");
  }, [propertyStorageKey]);

  useEffect(() => {
    if (!propertyCatalogueCurrent) return;
    const selectedStillExists = properties.some(
      (property) => property.propertyId === selectedPropertyId,
    );
    if (!selectedPropertyId || !selectedStillExists) {
      setSelectedPropertyIdState(properties[0]?.propertyId ?? "");
    }
  }, [properties, propertyCatalogueCurrent, selectedPropertyId]);

  useEffect(() => {
    if (selectedPropertyId) localStorage.setItem(propertyStorageKey, selectedPropertyId);
    else localStorage.removeItem(propertyStorageKey);
  }, [propertyStorageKey, selectedPropertyId]);

  const value = useMemo<WorkspaceValue>(
    () => ({
      workspaces,
      workspacesLoaded: workspacesQuery.data !== undefined,
      workspacesLoading: workspacesQuery.isLoading,
      workspacesFetching: workspacesQuery.isFetching,
      workspacesError: workspacesQuery.error,
      selectedWorkspace:
        workspaces.find(
          (item) => item.organization.organizationId === selectedWorkspaceId,
        ) ?? null,
      selectedWorkspaceId,
      setSelectedWorkspaceId,
      refetchWorkspaces: async () => {
        await workspacesQuery.refetch({ throwOnError: true });
      },
      properties,
      propertiesLoaded: propertiesQuery.data !== undefined,
      propertiesLoading: propertiesQuery.isLoading,
      propertiesFetching: propertiesQuery.isFetching,
      propertiesError: propertiesQuery.error,
      selectedProperty:
        properties.find((property) => property.propertyId === selectedPropertyId) ?? null,
      selectedPropertyId,
      setSelectedPropertyId: setSelectedPropertyIdState,
      refetchProperties: async () => {
        await propertiesQuery.refetch();
      },
      stationSettings: stationSettingsQuery.data ?? null,
      stationSettingsLoaded: stationSettingsQuery.data !== undefined,
      stationSettingsLoading: stationSettingsQuery.isLoading,
      stationSettingsFetching: stationSettingsQuery.isFetching,
      stationSettingsError: stationSettingsQuery.error,
      refetchStationSettings: async () => {
        await stationSettingsQuery.refetch();
      },
    }),
    [
      properties,
      propertiesQuery.data,
      propertiesQuery.error,
      propertiesQuery.isFetching,
      propertiesQuery.isLoading,
      propertiesQuery.refetch,
      stationSettingsQuery.data,
      stationSettingsQuery.error,
      stationSettingsQuery.isFetching,
      stationSettingsQuery.isLoading,
      stationSettingsQuery.refetch,
      selectedPropertyId,
      selectedWorkspaceId,
      setSelectedWorkspaceId,
      workspaces,
      workspacesQuery.data,
      workspacesQuery.error,
      workspacesQuery.isFetching,
      workspacesQuery.isLoading,
      workspacesQuery.refetch,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider.");
  return value;
}
