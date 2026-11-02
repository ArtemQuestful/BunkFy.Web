export {
  accessAuthorityChecksMatchTenant as accessChecksMatchTenant,
  useAccessPermissions as usePermissions,
} from "./accessAuthority";

export const permissions = {
  accessProfilesRead: "access-control.profiles.read",
  accessProfilesManage: "access-control.profiles.manage",
  accessProfilesAssign: "access-control.profiles.assign",
  workspaceStaffOnboardingManage: "workspaces.staff-onboarding.manage",
  propertiesRead: "properties.read",
  propertiesManage: "properties.properties.manage",
  propertyTimeZonesManage: "properties.time-zones.manage",
  roomsManage: "properties.rooms.manage",
  bedsManage: "properties.beds.manage",
  inventoryRead: "inventory.read",
  inventoryConfigure: "inventory.configure",
  inventoryBlocksManage: "inventory.blocks.manage",
  inventoryBlockGroupsManage: "inventory.block-groups.manage",
  inventoryRetire: "inventory.retire",
  reservationsRead: "reservations.read",
  reservationsCreate: "reservations.create",
  reservationsManage: "reservations.manage",
  reservationsManageGuests: "reservations.manage-guests",
  reservationsCancel: "reservations.cancel",
  reservationsCheckIn: "reservations.check-in",
  reservationsNoShow: "reservations.no-show",
  reservationsCheckOut: "reservations.check-out",
  guestsRead: "guests.read",
  guestsCreate: "guests.create",
  guestsManage: "guests.manage",
  guestsArchive: "guests.archive",
  staffRead: "staff.read",
  stationsManage: "stations.manage",
  staffSensitiveProfileRead: "staff.sensitive-profile.read",
  staffCreate: "staff.create",
  staffManage: "staff.manage",
  staffAccountLinksManage: "staff.account-links.manage",
  staffAssignProperties: "staff.assign-properties",
  staffManageLifecycle: "staff.manage-lifecycle",
  ingestionRead: "ingestion.read",
  ingestionConnectionsManage: "ingestion.connections.manage",
  ingestionCredentialsManage: "ingestion.credentials.manage",
  ingestionRawPayloadsRead: "ingestion.raw-payloads.read",
  ingestionSensitiveHistoryRead: "ingestion.sensitive-history.read",
  ingestionProposalsDecide: "ingestion.proposals.decide",
  dataRightsRead: "data-rights.read",
  dataRightsCreate: "data-rights.create",
  dataRightsDiscover: "data-rights.discover",
  dataRightsReview: "data-rights.review",
  dataRightsDecide: "data-rights.decide",
  dataRightsExecute: "data-rights.execute",
  dataRightsExport: "data-rights.export",
  dataRightsDownloadExport: "data-rights.export.download",
  dataRightsRestrict: "data-rights.restrict",
  dataRightsErase: "data-rights.erase",
  dataRightsManage: "data-rights.manage",
  retentionRead: "retention.read",
  retentionRetry: "retention.retry",
} as const;

export function tenantAccessScope(tenantId: string): string {
  return `tenant:${tenantId}`;
}

export function propertyAccessScope(tenantId: string, propertyId: string): string {
  return `${tenantAccessScope(tenantId)}/property:${propertyId}`;
}
