import type { Role, PropertyType, CaseStatus, DmStatus, RegistryStatus } from "@/generated/prisma";

// ----- Session / Auth -----

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

// ----- Permissions -----

export type PermissionMap = Record<string, Record<string, boolean>>;

// ----- Display Level -----

export type DisplayLevel = "hidden" | "masked" | "partial" | "full" | "read" | "edit";

export interface OwnerDisplayConfig {
  name: DisplayLevel;
  nameKana: DisplayLevel;
  phone: DisplayLevel;
  zip: DisplayLevel;
  address: DisplayLevel;
  note: DisplayLevel;
}

// ----- Property (list view - no personal info) -----

export interface PropertyListItem {
  id: string;
  propertyType: PropertyType;
  address: string;
  lotNumber: string | null;
  caseStatus: CaseStatus;
  dmStatus: DmStatus;
  registryStatus: RegistryStatus;
  assignedTo: string | null;
  assigneeName: string | null;
  isArchived: boolean;
  updatedAt: Date;
}

// ----- Property (full detail view) -----

export interface PropertyDetail {
  id: string;
  propertyType: PropertyType;
  address: string;
  originalAddress: string | null;
  lotNumber: string | null;
  originalLotNumber: string | null;
  buildingNumber: string | null;
  realEstateNumber: string | null;
  externalLinkKey: string | null;
  registryStatus: RegistryStatus;
  dmStatus: DmStatus;
  caseStatus: CaseStatus;
  gpsLat: number | null;
  gpsLng: number | null;

  // Investigation data
  zoningDistrict: string | null;
  buildingCoverageRatio: number | null;
  floorAreaRatio: number | null;
  heightDistrict: string | null;
  firePreventionZone: string | null;
  scenicRestriction: string | null;
  roadType: string | null;
  roadWidth: number | null;
  frontageWidth: number | null;
  frontageDirection: string | null;
  setbackRequired: string | null;
  rosenkaValue: number | null;
  rosenkaYear: number | null;
  rebuildPermission: string | null;

  // Investigation meta
  investigationSource: string | null;
  investigationFetchedAt: Date | null;
  investigationConfirmedAt: Date | null;
  manuallyEdited: boolean;
  architectureNote: string | null;

  // Operational
  assignedTo: string | null;
  assigneeName: string | null;
  isArchived: boolean;
  note: string | null;
  version: number;
  createdBy: string;
  creatorName: string;
  createdAt: Date;
  updatedAt: Date;

  // Related (populated based on permissions)
  owners?: OwnerSummary[];
  photos?: PhotoSummary[];
}

// ----- Related sub-types -----

export interface OwnerSummary {
  id: string;
  name: string;
  nameKana: string | null;
  phone: string | null;
  zip: string | null;
  address: string | null;
  note: string | null;
  relationship: string | null;
}

export interface PhotoSummary {
  id: string;
  fileUrl: string;
  thumbnailUrl: string | null;
  fileName: string;
  sortOrder: number;
}
