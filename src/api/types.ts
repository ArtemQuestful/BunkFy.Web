import type { components } from "./contracts.generated";

type Schema<Name extends keyof components["schemas"]> = components["schemas"][Name];
type NonNullableFields<T, Keys extends keyof T> = Omit<T, Keys> & {
  [Key in Keys]-?: NonNullable<T[Key]>;
};

export type EntityStatus = "active" | "retired" | string;

export type OrganizationStatus = Schema<"OrganizationStatus">;
export type OrganizationMembershipRole = Schema<"OrganizationMembershipRole">;
export type OrganizationMembershipStatus = Schema<"OrganizationMembershipStatus">;

export type Organization = NonNullableFields<
  Schema<"OrganizationDto">,
  "scopeId" | "name" | "slug"
>;

export type OrganizationMembership = NonNullableFields<
  Schema<"OrganizationMembershipDto">,
  "subjectId"
>;

export type OrganizationMembershipSummary = {
  organization: Organization;
  membership: OrganizationMembership;
};

export type OrganizationListResponse = Omit<Schema<"OrganizationListResponse">, "items"> & {
  items: OrganizationMembershipSummary[];
};

export type StationWorkspaceSettings = {
  sharedStationPinEnabled: boolean;
  revision: number;
};

export type OrganizationMemberListResponse = Omit<Schema<"OrganizationMemberListResponse">, "items"> & {
  items: OrganizationMembership[];
};

export type OrganizationInvitation = NonNullableFields<
  Schema<"OrganizationInvitationDto">,
  "inviterSubjectId"
>;

export type OrganizationInvitationIssuance = Omit<
  Schema<"OrganizationInvitationIssuanceDto">,
  "invitation"
> & {
  invitation: OrganizationInvitation;
};

export type OrganizationInvitationPreview = NonNullableFields<
  Schema<"OrganizationInvitationPreviewDto">,
  "organizationName" | "organizationSlug"
>;

export type OrganizationInvitationAcceptance = Omit<
  Schema<"OrganizationInvitationAcceptanceDto">,
  "invitation" | "membership"
> & {
  invitation: OrganizationInvitation;
  membership: OrganizationMembershipSummary;
};

export type OrganizationEnrollmentPreview = NonNullableFields<
  Schema<"OrganizationEnrollmentPreviewDto">,
  "organizationName" | "organizationSlug"
>;

export type OrganizationEnrollmentLink = NonNullableFields<
  Schema<"OrganizationEnrollmentLinkDto">,
  "creatorSubjectId"
>;

export type OrganizationEnrollmentLinkIssuance = Omit<
  Schema<"OrganizationEnrollmentLinkIssuanceDto">,
  "enrollmentLink"
> & {
  enrollmentLink: OrganizationEnrollmentLink;
};

export type OrganizationEnrollmentClaim = NonNullableFields<
  Schema<"OrganizationEnrollmentClaimDto">,
  "subjectId"
>;

export type OrganizationEnrollmentOutcome = Omit<
  Schema<"OrganizationEnrollmentOutcomeDto">,
  "claim" | "membership"
> & {
  claim: OrganizationEnrollmentClaim;
  membership: OrganizationMembershipSummary | null;
};

export type OrganizationJoinRequestListResponse = Omit<
  Schema<"OrganizationJoinRequestListResponse">,
  "items"
> & {
  items: OrganizationEnrollmentClaim[];
};

export type WorkspaceStaffOnboardingSourceKind = Schema<"WorkspaceStaffOnboardingSourceKind">;
export type WorkspaceStaffOnboardingStatus = Schema<"WorkspaceStaffOnboardingStatus">;

export type WorkspaceStaffOnboarding = NonNullableFields<
  Schema<"WorkspaceStaffOnboardingDto">,
  "subjectId"
>;

export type WorkspaceStaffOnboardingListResponse = Omit<
  Schema<"WorkspaceStaffOnboardingListResponse">,
  "items"
> & {
  items: WorkspaceStaffOnboarding[];
};

export type WorkspaceAccessPermission = Omit<
  NonNullableFields<
    Schema<"WorkspaceAccessPermissionDto">,
    "code" | "group" | "label" | "description"
  >,
  "requiredPermissions"
> & {
  requiredPermissions: string[];
};

export type WorkspaceAccessCatalogue = Omit<
  Schema<"WorkspaceAccessCatalogueDto">,
  "permissions" | "protectedSeedKeys"
> & {
  permissions: WorkspaceAccessPermission[];
  protectedSeedKeys: string[];
};

export type WorkspaceAccessProfile = Omit<
  NonNullableFields<
    Schema<"WorkspaceAccessProfileDto">,
    "key" | "displayName" | "description"
  >,
  "permissions"
> & {
  permissions: string[];
};

export type WorkspaceAccessProfileListResponse = Omit<
  Schema<"WorkspaceAccessProfileListResponse">,
  "items"
> & {
  items: WorkspaceAccessProfile[];
};

export type WorkspaceMemberAccessAssignment = NonNullableFields<
  Schema<"WorkspaceMemberAccessAssignmentDto">,
  "profileKey" | "profileDisplayName"
>;

export type WorkspaceMemberAccess = Omit<
  NonNullableFields<Schema<"WorkspaceMemberAccessDto">, "subjectId">,
  "assignments"
> & {
  assignments: WorkspaceMemberAccessAssignment[];
};

export type WorkspaceStaffAccessPlan = Omit<
  NonNullableFields<Schema<"WorkspaceStaffAccessPlanDto">, "profileKey">,
  "propertyIds"
> & {
  propertyIds: string[];
};

export type WorkspaceStaffJoinSource = Omit<
  Schema<"WorkspaceStaffJoinSourceDto">,
  "accessPlan"
> & {
  accessPlan: WorkspaceStaffAccessPlan | null;
};

export type WorkspaceStaffJoinSourceListResponse = Omit<
  Schema<"WorkspaceStaffJoinSourceListResponse">,
  "items"
> & {
  items: WorkspaceStaffJoinSource[];
};

export type WorkspaceStaffJoinSourceIssuance = Omit<
  Schema<"WorkspaceStaffJoinSourceIssuanceDto">,
  "plan"
> & {
  plan: WorkspaceStaffAccessPlan;
};

export type WorkspaceStaffJoinSourceReplacement = Omit<
  Schema<"WorkspaceStaffJoinSourceReplacementDto">,
  "replacement"
> & {
  replacement: WorkspaceStaffJoinSourceIssuance;
};

export type IssueWorkspaceEnrollmentLinkRequest =
  Schema<"IssueWorkspaceEnrollmentLinkRequest">;

export type RetentionExecutionStatus = Schema<"RetentionExecutionStatus">;
export type RetentionRunRetryStatus = Schema<"RetentionRunRetryStatus">;
export type RetentionTargetScopeKind = Schema<"RetentionTargetScopeKind">;

export type RetentionRunRetryReceipt = NonNullableFields<
  Schema<"RetentionRunRetryReceiptDto">,
  "requestId" | "runId"
>;

export type RetryRetentionScheduleRequest = NonNullableFields<
  Schema<"RetryRetentionScheduleRequest">,
  "ownerKey" | "dataClassKey"
>;

export type RetentionScheduleHealth = Omit<
  NonNullableFields<
    Schema<"RetentionScheduleHealthDto">,
    "ownerKey" | "dataClassKey"
  >,
  "retry"
> & {
  retry: RetentionRunRetryReceipt | null;
};

export type RetentionScheduleHealthSummary =
  Schema<"RetentionScheduleHealthSummaryDto">;

export type RetentionScheduleHealthListResponse = Omit<
  Schema<"RetentionScheduleHealthListResponse">,
  "items" | "summary"
> & {
  items: RetentionScheduleHealth[];
  summary: RetentionScheduleHealthSummary;
};

export type PropertyProcessingStatus = Schema<"PropertyProcessingStatus">;
export type PropertyProcessingEffectiveStatus = Schema<"PropertyProcessingEffectiveStatus">;

export type PropertyGovernanceAcknowledgement = NonNullableFields<
  Schema<"PropertyGovernanceAcknowledgementDto">,
  "acknowledgementId"
>;

export type PropertyGovernancePolicyBinding = Omit<
  NonNullableFields<
    Schema<"PropertyGovernancePolicyBindingDto">,
    | "operatingCountryCode"
    | "policyId"
    | "dataRegionId"
    | "transferProfileId"
    | "retentionPolicyId"
    | "contentSha256"
  >,
  "acknowledgements"
> & {
  acknowledgements: PropertyGovernanceAcknowledgement[];
};

export type PropertyDetail = Omit<
  NonNullableFields<
    Schema<"PropertyDto">,
    "name" | "code" | "timeZoneId" | "status" | "processingStatus"
  >,
  "governancePolicy"
> & {
  governancePolicy: PropertyGovernancePolicyBinding | null;
};

export type Property = NonNullableFields<
  Schema<"PropertyListItemDto">,
  "name" | "code" | "timeZoneId" | "status" | "processingStatus"
>;

export type PropertyMutationReceipt = Schema<"PropertyMutationReceiptDto">;
export type PropertyTimeZoneMutationReceipt = Schema<"SetPropertyTimeZoneReceiptDto">;
export type PropertyTimeZoneStatus = Schema<"PropertyTimeZoneStatus">;

export type PropertyTimeZoneCountry = NonNullableFields<
  Schema<"PropertyTimeZoneCountryDto">,
  "code" | "name"
>;

export type PropertyTimeZoneCatalogItem = Omit<
  NonNullableFields<Schema<"PropertyTimeZoneCatalogItemDto">, "timeZoneId">,
  "countries"
> & {
  countries: PropertyTimeZoneCountry[];
};

export type PropertyTimeZoneCatalogPage = Omit<
  Schema<"PropertyTimeZoneCatalogPageDto">,
  "timeZones"
> & {
  timeZones: PropertyTimeZoneCatalogItem[];
};

export type PropertyProcessingState = Omit<
  NonNullableFields<Schema<"PropertyProcessingStateDto">, "reasonCode">,
  "governancePolicy"
> & {
  governancePolicy: PropertyGovernancePolicyBinding | null;
};

export type CountryPolicyRetention = NonNullableFields<
  Schema<"CountryPolicyRetentionDescriptorDto">,
  "retentionPolicyId"
>;

export type CountryPolicy = Omit<
  NonNullableFields<
    Schema<"CountryPolicyDescriptorDto">,
    | "policyId"
    | "operatingCountryCode"
    | "launchStatus"
    | "approvalState"
    | "contentSha256"
  >,
  | "accommodationTypes"
  | "permittedDataRegions"
  | "permittedTransferProfiles"
  | "retentionPolicies"
  | "requiredAcknowledgements"
> & {
  accommodationTypes: string[];
  permittedDataRegions: string[];
  permittedTransferProfiles: string[];
  retentionPolicies: CountryPolicyRetention[];
  requiredAcknowledgements: PropertyGovernanceAcknowledgement[];
};

export type CountryPolicyListResponse = Omit<Schema<"CountryPolicyListResponse">, "items"> & {
  items: CountryPolicy[];
};

export type PropertyListResponse = Omit<Schema<"PropertyListResponse">, "properties"> & {
  properties: Property[];
};

export type RoomDetail = NonNullableFields<Schema<"RoomDto">, "name" | "status">;

export type Room = NonNullableFields<Schema<"RoomListItemDto">, "name" | "status">;

export type RoomMutationReceipt = Schema<"RoomMutationReceiptDto">;

export type RoomListResponse = Omit<Schema<"RoomListResponse">, "rooms"> & {
  rooms: Room[];
};

export type Bed = NonNullableFields<Schema<"BedListItemDto">, "label" | "status">;

export type BedMutationReceipt = Schema<"BedMutationReceiptDto">;
export type BedBatchMutationReceipt = Schema<"BedBatchMutationReceiptDto">;

export type BedListResponse = Omit<Schema<"BedListResponse">, "beds"> & {
  beds: Bed[];
};

export type InventorySalesMode = Schema<"InventorySalesMode"> | "unconfigured" | "roomLevel" | "bedLevel";
export type InventoryUnitKind = Schema<"InventoryUnitKind"> | "room" | "bed";
export type InventoryBlockTargetKind = Schema<"InventoryBlockTargetKind">;
export type InventoryBlockTarget = Schema<"InventoryBlockTarget">;

export type InventoryUnit = Omit<
  NonNullableFields<Schema<"InventoryUnitDto">, "label">,
  "kind"
> & { kind: InventoryUnitKind };

export type RoomInventory = Omit<
  NonNullableFields<Schema<"RoomInventoryDto">, "roomName" | "units">,
  "salesMode" | "units"
> & {
  salesMode: InventorySalesMode;
  units: InventoryUnit[];
};

export type RoomInventoryListResponse = Omit<Schema<"RoomInventoryListResponse">, "rooms"> & {
  rooms: RoomInventory[];
};

export type RoomInventoryMutationReceipt = Schema<"RoomInventoryMutationReceiptDto">;

export type RoomInventoryChangeImpact = Omit<
  Schema<"RoomInventoryChangeImpactDto">,
  "affectedReservationIds"
> & { affectedReservationIds: string[] };

export type BedRetirement = Omit<
  NonNullableFields<Schema<"BedRetirementDto">, "reason" | "requestedBy" | "affectedReservationIds">,
  "status"
> & {
  status: Schema<"InventoryRetirementStatus">;
};

export type RoomRetirement = Omit<
  NonNullableFields<Schema<"RoomRetirementDto">, "reason" | "requestedBy" | "affectedReservationIds">,
  "status"
> & {
  status: Schema<"InventoryRetirementStatus">;
};

export type TopologyRetirement = BedRetirement | RoomRetirement;

export type RetirementProcessSummary = NonNullableFields<Schema<"InventoryRetirementProcessSummaryDto">, "reason" | "requestedBy">;
export type RetirementImpact = NonNullableFields<Schema<"InventoryRetirementImpactDto">, "affectedReservationIds">;
export type RetirementContext = Omit<Schema<"InventoryRetirementContextDto">, "process" | "impact"> & {
  process: RetirementProcessSummary | Extract<Schema<"InventoryRetirementContextDto">["process"], null>;
  impact: RetirementImpact | Extract<Schema<"InventoryRetirementContextDto">["impact"], null>;
};

export type InventoryUnitAvailability = Omit<
  NonNullableFields<Schema<"InventoryUnitAvailabilityDto">, "activeBlockIds" | "activeAllocationIds">,
  "unit"
> & { unit: InventoryUnit };

export type InventoryAvailabilityResponse = Omit<Schema<"InventoryAvailabilityResponse">, "units"> & {
  units: InventoryUnitAvailability[];
};

export type ManualBlock = Omit<NonNullableFields<Schema<"ManualInventoryBlockDto">, "reason">, "status"> & {
  status: Schema<"ManualInventoryBlockStatus"> | "active" | "released";
};

export type ManualBlockListResponse = Omit<Schema<"ManualInventoryBlockListResponse">, "blocks"> & {
  blocks: ManualBlock[];
};

export type ManualBlockMutationReceipt = Schema<"ManualInventoryBlockMutationReceiptDto">;
export type ManualBlockGroupStatus = Schema<"ManualInventoryBlockGroupStatus">;
export type ManualBlockGroupPreviewStatus = Schema<"ManualInventoryBlockGroupPreviewStatus">;
export type ManualBlockGroupOperationKind = Schema<"ManualInventoryBlockGroupOperationKind">;
export type ManualBlockGroupOperationStatus = Schema<"ManualInventoryBlockGroupOperationStatus">;
export type ManualBlockGroup = Schema<"ManualInventoryBlockGroupDto">;
export type ManualBlockGroupListResponse = Omit<
  Schema<"ManualInventoryBlockGroupListResponse">,
  "blockGroups"
> & { blockGroups: ManualBlockGroup[] };
export type ManualBlockGroupMemberListResponse = Omit<
  Schema<"ManualInventoryBlockGroupMemberListResponse">,
  "blocks"
> & { blocks: ManualBlock[] };
export type ManualBlockGroupPreviewMember = Schema<"ManualInventoryBlockGroupPreviewMemberDto">;
export type ManualBlockGroupSelectionPreview = Omit<
  Schema<"ManualInventoryBlockGroupSelectionPreviewDto">,
  "members"
> & { members: ManualBlockGroupPreviewMember[] };
export type ManualBlockGroupMutationReceipt = Schema<"ManualInventoryBlockGroupMutationReceiptDto">;
export type ManualBlockGroupOperation = Schema<"ManualInventoryBlockGroupOperationDto">;
export type PreviewManualBlockGroupRequest = Schema<"PreviewManualBlockGroupRequest">;
export type CreateManualBlockGroupRequest = Schema<"CreateManualBlockGroupRequest">;
export type ReplaceManualBlockGroupRequest = Schema<"ReplaceManualBlockGroupRequest">;
export type ReleaseManualBlockGroupRequest = Schema<"ReleaseManualBlockGroupRequest">;

export type ReservationStatus = Schema<"ReservationStatus">
  | "pendingAllocation"
  | "confirmed"
  | "allocationRejected"
  | "cancellationPending"
  | "cancelled"
  | "checkedIn"
  | "noShowPending"
  | "noShow"
  | "checkoutPending"
  | "checkedOut";

export type ReservationSourceKind = Schema<"ReservationSourceKind"> | "direct" | "external";
export type ReservationGuestRole = Schema<"ReservationGuestRoleKind"> | "primary";
export type ReservationDetailsChangeOrigin = Schema<"ReservationDetailsChangeOriginKind">
  | "staff"
  | "adapter"
  | "admin"
  | "system";

export type ReservationGuest = {
  guestId: string;
  role: ReservationGuestRole;
};

export type Reservation = Omit<
  NonNullableFields<Schema<"ReservationDto">, "inventoryUnitIds" | "primaryGuestName">,
  "status" | "sourceKind" | "guests"
> & {
  status: ReservationStatus;
  sourceKind: ReservationSourceKind;
  guests: ReservationGuest[];
};

export type ReservationListItem = Omit<
  NonNullableFields<Schema<"ReservationListItemDto">, "inventoryUnitIds" | "primaryGuestName">,
  "status" | "sourceKind"
> & {
  status: ReservationStatus;
  sourceKind: ReservationSourceKind;
};

export type ReservationListResponse = Omit<Schema<"ReservationListResponse">, "reservations"> & {
  reservations: ReservationListItem[];
};

export type ReservationOperationsCount = {
  reservationCount: number;
  guestCount: number;
};

export type ReservationOperationsSnapshot = {
  propertyId: string;
  localDate: string;
  timeZoneId: string;
  dateSource: Schema<"ReservationOperationsDateSource">;
  observedAtUtc: string;
  cohorts: {
    confirmedArrivalsOnLocalDate: ReservationOperationsCount;
    scheduledDeparturesOnLocalDate: ReservationOperationsCount;
    currentlyInHouse: ReservationOperationsCount;
  };
  attention: {
    pendingAllocation: ReservationOperationsCount;
    allocationRejected: ReservationOperationsCount;
    cancellationPending: ReservationOperationsCount;
    noShowPending: ReservationOperationsCount;
    checkoutPending: ReservationOperationsCount;
    arrivalBeforeLocalDateStillConfirmed: ReservationOperationsCount;
    departureBeforeLocalDateStillInHouse: ReservationOperationsCount;
    total: ReservationOperationsCount;
  };
  upcoming: ReservationListItem[];
  upcomingLimit: number;
  hasMoreUpcoming: boolean;
};

export type ReservationMutationReceipt = Omit<Schema<"ReservationMutationReceiptDto">, "status"> & {
  status: ReservationStatus;
};

export type ReservationGuestRecordLinkProcess =
  Schema<"ReservationGuestRecordLinkProcessDto">;
export type ReservationGuestRecordWriteRequest =
  Schema<"ReservationGuestRecordWriteRequest">;

export type LinkReservationGuestRequest = Schema<"LinkReservationGuestRequest">;

export type UpdateReservationGuestDetailsRequest = NonNullableFields<
  Schema<"UpdateReservationGuestDetailsRequest">,
  "primaryGuestName"
>;

export type ReservationDetailsSnapshot = {
  arrival: string;
  departure: string;
  expectedArrivalTime?: string | null;
  expectedDepartureTime?: string | null;
  inventoryUnitIds: string[];
  primaryGuestName: string;
  email?: string | null;
  phone?: string | null;
  guestCount: number;
  notes?: string | null;
};

export type ReservationDetailsHistoryItem = {
  changeId: string;
  reservationId: string;
  propertyId: string;
  fromRevision: number;
  toRevision: number;
  origin: ReservationDetailsChangeOrigin;
  actorId?: string | null;
  adapterConnectionId?: string | null;
  externalOperationId?: string | null;
  correlationId: string;
  changedFields: string[];
  before?: ReservationDetailsSnapshot | null;
  after: ReservationDetailsSnapshot;
  occurredAtUtc: string;
};

export type ReservationDetailsHistoryListResponse = Omit<
  Schema<"ReservationDetailsHistoryListResponse">,
  "items"
> & {
  items: ReservationDetailsHistoryItem[];
};

export type DataRightsCaseStatus = Schema<"DataRightsCaseStatus">;
export type DataRightsCaseType = Schema<"DataRightsCaseType">;
export type DataRightsDecisionOutcome = Schema<"DataRightsDecisionOutcome">;
export type DataRightsDecisionReason = Schema<"DataRightsDecisionReason">;
export type DataRightsCorrectionExecutionStatus =
  Schema<"DataRightsCorrectionExecutionStatus">;
export type DataRightsExecutionWorkItemStatus = Schema<"DataRightsExecutionWorkItemStatus">;
export type DataRightsExportArtifactStatus = Schema<"DataRightsExportArtifactStatus">;
export type DataRightsOperation = Schema<"DataRightsOperation">;
export type DataRightsRestrictionDirective = Schema<"DataRightsRestrictionDirective">;
export type DataRightsRequesterRelationship = Schema<"DataRightsRequesterRelationship">;
export type DataRightsResponseDeadlineEvidence = NonNullableFields<
  Schema<"DataRightsResponseDeadlineEvidence">,
  | "operatingCountryCode"
  | "policyId"
  | "contentSha256"
  | "ruleReference"
  | "timeZoneId"
>;
export type DataRightsRestrictionReleaseTarget = NonNullableFields<
  Schema<"DataRightsRestrictionReleaseTargetDto">,
  "ownerKey"
>;
export type DataRightsRestrictionReleaseTargetCandidate =
  Schema<"DataRightsRestrictionReleaseTargetCandidateDto">;
export type DataRightsRestrictionReleaseTargetListResponse = Omit<
  Schema<"DataRightsRestrictionReleaseTargetListResponse">,
  "targets"
> & {
  targets: DataRightsRestrictionReleaseTargetCandidate[];
};
export type DataRightsRestrictionExecutionProof =
  Schema<"DataRightsRestrictionExecutionProofDto">;

export type DataRightsCase = Omit<
  Schema<"DataRightsCaseDto">,
  | "approvalEvidence"
  | "responseDeadlineEvidence"
  | "restrictionReleaseTarget"
  | "restrictionExecutionProof"
> & {
  approvalEvidence: Schema<"DataRightsApprovalEvidence"> | null;
  responseDeadlineEvidence: DataRightsResponseDeadlineEvidence | null;
  restrictionReleaseTarget: DataRightsRestrictionReleaseTarget | null;
  restrictionExecutionProof: DataRightsRestrictionExecutionProof | null;
};
export type DataRightsCaseSummary = Schema<"DataRightsCaseSummaryDto">;
export type DataRightsCaseListResponse = Omit<Schema<"DataRightsCaseListResponse">, "items"> & {
  items: DataRightsCaseSummary[];
};
export type DataRightsSubjectCoordinate = NonNullableFields<
  Schema<"DataRightsSubjectCoordinate">,
  "ownerKey" | "recordType"
>;
export type DataRightsSubjectCandidate = Omit<
  NonNullableFields<Schema<"DataRightsSubjectCandidate">, "displayName">,
  "coordinate"
> & {
  coordinate: DataRightsSubjectCoordinate;
};
export type DataRightsSubjectDiscoveryResponse = Omit<
  Schema<"DataRightsSubjectDiscoveryResponse">,
  "candidates"
> & {
  candidates: DataRightsSubjectCandidate[];
};
export type DataRightsSelectedSubject = NonNullableFields<
  Schema<"DataRightsSelectedSubjectDto">,
  "ownerKey" | "recordType"
>;
export type DataRightsSelectedSubjectsResponse = Omit<
  Schema<"DataRightsSelectedSubjectsResponse">,
  "subjects"
> & {
  subjects: DataRightsSelectedSubject[];
};
export type DataRightsExecutionBatch = Schema<"DataRightsExecutionBatchDto">;
export type DataRightsExecutionWorkItem = NonNullableFields<
  Schema<"DataRightsExecutionWorkItemDto">,
  "ownerKey" | "recordType"
>;
export type DataRightsExecution = Omit<
  Schema<"DataRightsExecutionDto">,
  "case" | "batch" | "workItems"
> & {
  case: DataRightsCase;
  batch: DataRightsExecutionBatch;
  workItems: DataRightsExecutionWorkItem[];
};
export type DataRightsExportArtifact = Schema<"DataRightsExportArtifactDto">;
export type DataRightsRestrictionExecution = Omit<
  Schema<"DataRightsRestrictionExecutionDto">,
  "case" | "proof"
> & {
  case: DataRightsCase;
  proof: DataRightsRestrictionExecutionProof;
};
export type DataRightsCorrectionExecutionDetails = Omit<
  Schema<"DataRightsCorrectionExecutionDetailsDto">,
  "subject"
> & {
  subject: DataRightsSubjectCoordinate;
};
export type DataRightsCorrectionExecution = Omit<
  Schema<"DataRightsCorrectionExecutionDto">,
  "case" | "execution"
> & {
  case: DataRightsCase;
  execution: DataRightsCorrectionExecutionDetails;
};
export type GuestDataRightsCorrectionRequest =
  Schema<"GuestDataRightsCorrectionRequest">;
export type GuestDataRightsCorrectionReceipt =
  Schema<"GuestDataRightsCorrectionReceiptDto">;
export type ReservationDataRightsCorrectionRequest =
  Schema<"ReservationDataRightsCorrectionRequest">;
export type ReservationDataRightsCorrectionReceipt =
  Schema<"ReservationDataRightsCorrectionReceiptDto">;
export type WorkspaceStaffOnboardingDataRightsCorrectionTarget =
  NonNullableFields<
    Schema<"WorkspaceStaffOnboardingDataRightsCorrectionTargetDto">,
    "displayName"
  >;
export type WorkspaceStaffOnboardingDataRightsCorrectionRequest = Omit<
  Schema<"WorkspaceStaffOnboardingDataRightsCorrectionRequest">,
  "displayName"
> & {
  displayName: string;
};
export type WorkspaceStaffOnboardingDataRightsCorrectionReceipt = Omit<
  Schema<"WorkspaceStaffOnboardingDataRightsCorrectionReceiptDto">,
  "changedFieldKeys"
> & {
  changedFieldKeys: string[];
};

export type GuestStatus = Schema<"GuestStatus"> | "active" | "archived";

export type GuestProfile = {
  guestId: string;
  originPropertyId: string;
  displayName: string;
  legalName?: string | null;
  email?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  nationalityCountryCode?: string | null;
  preferredLanguageTag?: string | null;
  // Optional for retained pre-collection responses; current API returns a non-null array.
  languageTags?: string[] | null;
  notes?: string | null;
  status: GuestStatus;
  version: number;
  createdBy: string;
  createdAtUtc: string;
  lastChangedBy: string;
  lastChangedAtUtc: string;
  archivedAtUtc?: string | null;
};

export type GuestListItem = Pick<
  GuestProfile,
  | "guestId"
  | "displayName"
  | "legalName"
  | "email"
  | "phone"
  | "nationalityCountryCode"
  | "preferredLanguageTag"
  | "languageTags"
  | "status"
  | "lastChangedBy"
  | "lastChangedAtUtc"
>;

export type GuestListResponse = {
  guests: GuestListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export type GuestMutationReceipt = Pick<
  GuestProfile,
  "guestId" | "status" | "version" | "lastChangedAtUtc"
>;

export type GuestStayRole = 0 | 1 | "unknown" | "primary" | string;
export type GuestStayStatus = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | string;

export type GuestStayHistoryItem = {
  reservationId: string;
  propertyId: string;
  role: GuestStayRole;
  arrival: string;
  departure: string;
  status: GuestStayStatus;
  checkedInBusinessDate?: string | null;
  noShowBusinessDate?: string | null;
  checkedOutBusinessDate?: string | null;
  isCurrentParticipant: boolean;
  reservationVersion: number;
};

export type GuestStayHistoryListResponse = {
  stays: GuestStayHistoryItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export type StaffStatus = Schema<"StaffStatus"> | "active" | "suspended" | "departed";

export type StaffAccountDirectoryEntry = NonNullableFields<
  Schema<"StaffAccountDirectoryEntryDto">,
  "authSubjectId" | "displayName"
>;

export type StaffAccountDirectoryResponse = Omit<
  Schema<"StaffAccountDirectoryResponse">,
  "items"
> & {
  items: StaffAccountDirectoryEntry[];
};

export type StaffPropertyAssignment = {
  assignmentId: string;
  propertyId: string;
  propertyJobTitle?: string | null;
  isPrimary: boolean;
  isCurrent: boolean;
  effectiveFrom: string;
  effectiveTo?: string | null;
  assignedAtUtc: string;
  unassignedAtUtc?: string | null;
  assignedAtVersion: number;
  unassignedAtVersion?: number | null;
};

export type StaffDirectoryAssignment = {
  assignmentId: string;
  propertyId: string;
  propertyJobTitle?: string | null;
  isPrimary: boolean;
  effectiveFrom: string;
};

export type StaffDirectoryMember = {
  staffMemberId: string;
  displayName: string;
  jobTitle?: string | null;
  department?: string | null;
  status: StaffStatus;
  version: number;
  assignments: StaffDirectoryAssignment[];
};

export type StaffDirectoryListItem = {
  staffMemberId: string;
  displayName: string;
  jobTitle?: string | null;
  department?: string | null;
  status: StaffStatus;
  version: number;
  currentPropertyCount: number;
};

export type StaffPropertyDirectoryListItem = {
  staffMemberId: string;
  displayName: string;
  jobTitle?: string | null;
  department?: string | null;
  status: StaffStatus;
  version: number;
  assignment: StaffDirectoryAssignment;
};

export type StaffMember = {
  staffMemberId: string;
  displayName: string;
  legalName?: string | null;
  workEmail?: string | null;
  workPhone?: string | null;
  employeeNumber?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  authSubjectId?: string | null;
  status: StaffStatus;
  version: number;
  createdAtUtc: string;
  lastChangedAtUtc: string;
  suspendedAtUtc?: string | null;
  departedAtUtc?: string | null;
  assignments: StaffPropertyAssignment[];
};

export type StaffMemberMutationReceipt = {
  staffMemberId: string;
  status: StaffStatus;
  version: number;
  completedAtUtc: string;
};

export type StaffDirectoryListResponse = {
  items: StaffDirectoryListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export type StaffPropertyDirectoryListResponse = {
  items: StaffPropertyDirectoryListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export type AdapterExecutionMode = Schema<"AdapterExecutionMode"> | "polling" | "continuous" | "push" | "remotePolling";
export type AdapterConflictPolicy = Schema<"AdapterConflictPolicy"> | "suggestionsOnly" | "autoApplyWhenAdapterBaselineUnchanged";
export type AdapterConnectionStatus = Schema<"AdapterConnectionStatus"> | "enabled" | "disabled";

export type AdapterConnection = {
  connectionId: string;
  propertyId: string;
  adapterType: string;
  executionMode: AdapterExecutionMode;
  pollingIntervalSeconds?: number | null;
  pollingScheduleMaxAttempts?: number | null;
  pollingScheduleConfiguredAtUtc?: string | null;
  conflictPolicy: AdapterConflictPolicy;
  configurationReference: string;
  hasSecretReference: boolean;
  checkpoint?: string | null;
  status: AdapterConnectionStatus;
  version: number;
  createdAtUtc: string;
  updatedAtUtc?: string | null;
};

export type AdapterConnectionListItem = Pick<
  AdapterConnection,
  "connectionId" | "adapterType" | "executionMode" | "pollingIntervalSeconds" | "conflictPolicy" | "status"
>;
export type AdapterConnectionListResponse = {
  connections: AdapterConnectionListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};
export type AdapterConnectionMutationReceipt = Pick<AdapterConnection, "connectionId" | "status" | "version">;
export type AdapterConnectionCreateRequest = NonNullableFields<
  Schema<"CreateConnectionRequest">,
  "operationId" | "adapterType" | "configurationReference"
>;
export type AdapterConnectionUpdateRequest = NonNullableFields<
  Schema<"UpdateConnectionRequest">,
  "operationId" | "configurationReference"
>;
export type AdapterConnectionControlRequest = Schema<"ConnectionControlRequest">;
export type AdapterConnectionCheckpointResetRequest =
  Schema<"ResetConnectionCheckpointRequest">;
export type AdapterConnectionPollingScheduleRequest =
  Schema<"ConfigurePollingScheduleRequest">;

export type AdapterTypeCapability = {
  adapterType: string;
  protocolVersion: number;
  configurationSchemaVersion: number;
  executionModes: AdapterExecutionMode[];
  minimumPollingIntervalSeconds?: number | null;
  recommendedPollingIntervalSeconds?: number | null;
};
export type AdapterTypeCapabilityListResponse = { adapterTypes: AdapterTypeCapability[] };

export type AdapterConnectionHealth = {
  connectionId: string;
  propertyId: string;
  adapterType: string;
  connectionStatus: AdapterConnectionStatus;
  executionMode: AdapterExecutionMode;
  capabilityStatus: number | string;
  protocolVersion?: number | null;
  configurationSchemaVersion?: number | null;
  pollingIntervalSeconds?: number | null;
  pollingScheduleMaxAttempts?: number | null;
  pollingScheduleConfiguredAtUtc?: string | null;
  nextRunExpectedAtUtc?: string | null;
  runExpected: boolean;
  operationalState: number | string;
  latestRunId?: string | null;
  latestRunStatus?: number | string | null;
  latestRunStartedAtUtc?: string | null;
  latestRunCompletedAtUtc?: string | null;
  latestRunErrorCode?: string | null;
  lastSuccessfulRunAtUtc?: string | null;
  lastObservationReceivedAtUtc?: string | null;
  pendingReceiptCount: number;
  rejectedReceiptCount: number;
  expiredRawPayloadCount: number;
  protectedRawPayloadCount: number;
  heldExpiredRawPayloadCount: number;
  purgingRawPayloadCount: number;
  dueSensitiveHistoryCount: number;
  heldDueSensitiveHistoryCount: number;
  redactedSensitiveHistoryCount: number;
  activeLegalHoldCount: number;
  evaluatedAtUtc: string;
};

export type AdapterIngressCredential = {
  credentialId: string;
  connectionId: string;
  slot: number;
  label: string;
  status: number | string;
  expiresAtUtc: string;
  createdBy: string;
  createdAtUtc: string;
  revokedBy?: string | null;
  revokedAtUtc?: string | null;
  lastAuthenticatedAtUtc?: string | null;
  version: number;
};
export type AdapterIngressCredentialListItem = Pick<
  AdapterIngressCredential,
  "credentialId" | "slot" | "label" | "status" | "expiresAtUtc" | "lastAuthenticatedAtUtc" | "version"
>;
export type AdapterIngressCredentialListResponse = {
  credentials: AdapterIngressCredentialListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};
export type AdapterIngressCredentialMutationReceipt = Pick<
  AdapterIngressCredential,
  "credentialId" | "connectionId" | "status" | "version"
>;
export type AdapterIngressCredentialCreateRequest = {
  operationId: string;
  label: string;
  expiresAtUtc?: string | null;
  sourceSystem?: string | null;
};
export type AdapterIngressCredentialIssuanceOutcome =
  | Schema<"AdapterIngressCredentialIssuanceOutcome">
  | "issued"
  | "alreadyIssued";
export type CreateAdapterIngressCredentialResponse = {
  credential: AdapterIngressCredential;
  outcome: AdapterIngressCredentialIssuanceOutcome;
  token: string | null;
};

export type ChangeProposalStatus = Schema<"ChangeProposalStatus"> | "pending" | "applying" | "applied" | "rejected" | "superseded" | "stale" | "failed";
export type ChangeProposal = {
  proposalId: string;
  propertyId: string;
  connectionId: string;
  receiptId: string;
  reservationId: string;
  baseReservationDetailsRevision: number;
  reasonCode: string;
  sensitiveHistoryStatus: number | string;
  sensitiveDataRetainUntilUtc?: string | null;
  sensitiveDataRedactedAtUtc?: string | null;
  status: ChangeProposalStatus;
  decisionActor?: string | null;
  decisionReason?: string | null;
  productOperationId?: string | null;
  version: number;
  createdAtUtc: string;
  decidedAtUtc?: string | null;
  completedAtUtc?: string | null;
  diff?: string | null;
};
export type ChangeProposalListItem = Pick<
  ChangeProposal,
  "proposalId" | "reservationId" | "baseReservationDetailsRevision" | "reasonCode" | "status" | "createdAtUtc"
>;
export type ChangeProposalListResponse = {
  proposals: ChangeProposalListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};
export type ChangeProposalMutationReceipt = Pick<
  ChangeProposal,
  "proposalId" | "status" | "version" | "productOperationId"
>;

export type IngestionRunStatus = Schema<"IngestionRunStatus"> | "running" | "succeeded" | "partiallySucceeded" | "failed" | "cancelled";
export type IngestionRun = {
  runId: string;
  connectionId: string;
  propertyId: string;
  executionKind: number | string;
  taskRunId?: string | null;
  taskAttempt?: number | null;
  remoteLeaseId?: string | null;
  remoteClaimId?: string | null;
  remoteLeaseEpoch?: number | null;
  remoteWorkerId?: string | null;
  remoteLeaseExpiresAtUtc?: string | null;
  startingCheckpoint?: string | null;
  acceptedCheckpoint?: string | null;
  status: IngestionRunStatus;
  observedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  errorCode?: string | null;
  version: number;
  startedAtUtc: string;
  completedAtUtc?: string | null;
};
export type IngestionRunListItem = Pick<
  IngestionRun,
  "runId" | "connectionId" | "status" | "observedCount" | "acceptedCount" | "rejectedCount" | "errorCode" | "startedAtUtc" | "completedAtUtc"
>;
export type IngestionRunListResponse = {
  runs: IngestionRunListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export type ObservationReceiptStatus = Schema<"ObservationReceiptStatus"> | "pending" | "processed" | "rejected";
export type ObservationReceipt = {
  receiptId: string;
  propertyId: string;
  connectionId: string;
  runId?: string | null;
  operationId: string;
  sourceRecordType: string;
  externalId: string;
  sourceRevision?: string | null;
  contentHash: string;
  rawPayloadFileId: string;
  rawPayloadStatus: number | string;
  rawPayloadRetainUntilUtc: string;
  rawPayloadPurgedAtUtc?: string | null;
  activeReprocessingAttemptId?: string | null;
  reprocessingReservationExpiresAtUtc?: string | null;
  sourceReceiptId?: string | null;
  reprocessingAttemptId?: string | null;
  parserType?: string | null;
  parserVersion?: number | null;
  parserOutputIndex?: number | null;
  sourceUpdatedAtUtc?: string | null;
  observedAtUtc: string;
  status: ObservationReceiptStatus;
  rejectionReason?: string | null;
  receivedAtUtc: string;
  processedAtUtc?: string | null;
};
export type ObservationReceiptListItem = Pick<
  ObservationReceipt,
  "receiptId" | "connectionId" | "sourceRecordType" | "externalId" | "parserType" | "parserVersion" | "status" | "receivedAtUtc"
>;
export type ObservationReceiptListResponse = {
  receipts: ObservationReceiptListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export type ObservationParserCapability = { parserType: string; parserVersion: number; supportedAdapterTypes: string[]; supportedSourceRecordTypes: string[]; outputRecordTypes: string[] };
export type ObservationParserCapabilityListResponse = { parsers: ObservationParserCapability[] };

export type ObservationReprocessingStatus = Schema<"ObservationReprocessingStatus"> | "queued" | "running" | "succeeded" | "noMatch" | "failed" | "canceled" | "expired";
export type ObservationReprocessingAttempt = {
  attemptId: string;
  propertyId: string;
  connectionId: string;
  sourceReceiptId: string;
  taskRunId: string;
  parserType: string;
  parserVersion: number;
  requestedBy: string;
  status: ObservationReprocessingStatus;
  lastTaskAttempt: number;
  parsedCount: number;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  lastErrorCode?: string | null;
  requestedAtUtc: string;
  startedAtUtc?: string | null;
  completedAtUtc?: string | null;
  reservationExpiresAtUtc: string;
  version: number;
};
export type ObservationReprocessingOutput = { outputIndex: number; operationId: string; receiptId?: string | null; status: number | string; recordType: string; externalId: string; sourceRevision?: string | null; contentHash: string; errorCode?: string | null; recordedAtUtc: string };
export type ObservationReprocessingAttemptDetails = { attempt: ObservationReprocessingAttempt; outputs: ObservationReprocessingOutput[] };
export type ObservationReprocessingAttemptListItem = Pick<
  ObservationReprocessingAttempt,
  "attemptId" | "parserType" | "parserVersion" | "status" | "parsedCount" | "acceptedCount" | "duplicateCount" | "rejectedCount" | "lastErrorCode" | "requestedAtUtc" | "startedAtUtc" | "completedAtUtc"
>;
export type ObservationReprocessingAttemptListResponse = {
  attempts: ObservationReprocessingAttemptListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export type NotificationSeverity = 0 | 1 | 2 | 3 | 4 | "info" | "success" | "warning" | "error" | string;
export type NotificationHistoryItem = {
  id: string;
  module: string;
  name: string;
  version: number;
  title: string;
  body?: string | null;
  severity: NotificationSeverity;
  streamSequence: number;
  occurredAtUtc: string;
  createdAtUtc: string;
  readAtUtc?: string | null;
  payload: unknown;
};
export type NotificationHistoryListResponse = { items: NotificationHistoryItem[]; page: number; pageSize: number; totalCount: number; unreadCount: number };
export type NotificationBroadcastItem = {
  broadcastId: string;
  scopeId?: string | null;
  audience: number | string;
  module: string;
  name: string;
  version: number;
  title: string;
  body?: string | null;
  severity: NotificationSeverity;
  streamSequence: number;
  occurredAtUtc: string;
  createdAtUtc: string;
  readAtUtc?: string | null;
  payload: unknown;
};
export type NotificationBroadcastListResponse = { items: NotificationBroadcastItem[]; page: number; pageSize: number; totalCount: number; unreadCount: number };
export type MarkAllNotificationsReadResponse = { updatedCount: number };

export type BrowserAuthResponse = NonNullableFields<Schema<"BrowserAuthResponse">, "accessToken">;
export type BrowserTotpActivation = Omit<
  Schema<"BrowserTotpActivationResponse">,
  "accessToken" | "recoveryCodes"
> & {
  accessToken: string;
  recoveryCodes: string[];
};
export type MultiFactorChallenge = NonNullableFields<
  Schema<"MultiFactorChallengeResponse">,
  "challengeToken" | "availableCodeTypes"
>;
export type MultiFactorCodeType = Schema<"MultiFactorCodeType">;
export type MultiFactorStatus = Schema<"MultiFactorStatusResponse">;
export type TotpEnrollment = NonNullableFields<
  Schema<"TotpEnrollmentResponse">,
  "secret" | "provisioningUri"
>;

export type AuthSelfRegistration = Schema<"AuthSelfRegistrationResponse">;

export type AuthenticationEmail = NonNullableFields<
  Schema<"AuthenticationEmailResponse">,
  "email"
>;

export type ExternalIdentity = NonNullableFields<
  Schema<"ExternalIdentityResponse">,
  "providerCode"
>;

export type AuthenticationMethods = Omit<
  Schema<"AuthenticationMethodsResponse">,
  "emails" | "externalIdentities"
> & {
  emails: AuthenticationEmail[];
  externalIdentities: ExternalIdentity[];
};

export type AuthenticationSession = NonNullableFields<
  Schema<"AuthenticationSessionResponse">,
  "authenticationMethod"
>;

export type AuthenticationSessions = Omit<
  Schema<"AuthenticationSessionsResponse">,
  "sessions"
> & {
  sessions: AuthenticationSession[];
};

export type ExternalAuthenticationProviderList = {
  providers: string[];
};

export type ExternalAuthenticationChallenge = NonNullableFields<
  Schema<"ExternalAuthenticationChallengeResponse">,
  "startUrl"
>;

export type ExternalAuthenticationStatus = Schema<"ExternalAuthenticationStatus"> | "authenticated" | "linked";

export type ExternalAuthenticationResult = Omit<
  Schema<"ExternalAuthenticationResponse">,
  "status" | "providerCode"
> & {
  status: ExternalAuthenticationStatus;
  providerCode: string;
};

export type AccessPermissionCheck = NonNullableFields<Schema<"AccessPermissionCheck">, "permission" | "scope">;
export type AccessPermissionDecision = NonNullableFields<Schema<"AccessPermissionDecision">, "permission" | "scope">;
export type AccessPermissionEvaluationResponse = Omit<
  Schema<"AccessPermissionEvaluationResponse">,
  "permissions"
> & { permissions: AccessPermissionDecision[] };

export type SmokeStatus = {
  application: string;
  service: string;
  status: string;
  timestampUtc: string;
};
