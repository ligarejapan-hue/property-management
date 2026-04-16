import { z } from "zod";
import { PROPERTY_TYPE_VALUES } from "@/lib/property-types";

// ---------- Property list query ----------

export const propertyListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  keyword: z.string().optional(),
  propertyType: z.enum(PROPERTY_TYPE_VALUES).optional(),
  registryStatus: z.enum(["unconfirmed", "scheduled", "obtained"]).optional(),
  dmStatus: z.enum(["send", "hold", "no_send"]).optional(),
  caseStatus: z
    .enum([
      "new_case",
      "site_checked",
      "waiting_registry",
      "dm_target",
      "dm_sent",
      "hold",
      "done",
    ])
    .optional(),
  assignedTo: z.string().uuid().optional(),
  updatedFrom: z.string().optional(),
  updatedTo: z.string().optional(),
  includeArchived: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  sortBy: z.enum(["updatedAt", "createdAt", "address", "caseStatus"]).default("updatedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

// ---------- Create property ----------

export const createPropertySchema = z.object({
  propertyType: z.enum(PROPERTY_TYPE_VALUES),
  address: z.string().min(1, "住所は必須です"),
  lotNumber: z.string().optional().nullable(),
  buildingNumber: z.string().optional().nullable(),
  realEstateNumber: z.string().optional().nullable(),
  registryStatus: z.enum(["unconfirmed", "scheduled", "obtained"]).default("unconfirmed"),
  dmStatus: z.enum(["send", "hold", "no_send"]).default("hold"),
  caseStatus: z
    .enum([
      "new_case",
      "site_checked",
      "waiting_registry",
      "dm_target",
      "dm_sent",
      "hold",
      "done",
    ])
    .default("new_case"),
  gpsLat: z.number().optional().nullable(),
  gpsLng: z.number().optional().nullable(),
  note: z.string().optional().nullable(),
  assignedTo: z.string().uuid().optional().nullable(),
});

// ---------- Update property ----------

export const updatePropertySchema = z.object({
  propertyType: z.enum(PROPERTY_TYPE_VALUES).optional(),
  address: z.string().min(1).optional(),
  lotNumber: z.string().optional().nullable(),
  buildingNumber: z.string().optional().nullable(),
  realEstateNumber: z.string().optional().nullable(),
  registryStatus: z.enum(["unconfirmed", "scheduled", "obtained"]).optional(),
  dmStatus: z.enum(["send", "hold", "no_send"]).optional(),
  caseStatus: z
    .enum([
      "new_case",
      "site_checked",
      "waiting_registry",
      "dm_target",
      "dm_sent",
      "hold",
      "done",
    ])
    .optional(),
  gpsLat: z.number().optional().nullable(),
  gpsLng: z.number().optional().nullable(),
  zoningDistrict: z.string().optional().nullable(),
  buildingCoverageRatio: z.number().optional().nullable(),
  floorAreaRatio: z.number().optional().nullable(),
  heightDistrict: z.string().optional().nullable(),
  firePreventionZone: z.string().optional().nullable(),
  scenicRestriction: z.string().optional().nullable(),
  roadType: z.string().optional().nullable(),
  roadWidth: z.number().optional().nullable(),
  frontageWidth: z.number().optional().nullable(),
  frontageDirection: z.string().optional().nullable(),
  setbackRequired: z.enum(["yes", "no", "unknown"]).optional().nullable(),
  rosenkaValue: z.number().int().optional().nullable(),
  rosenkaYear: z.number().int().optional().nullable(),
  rebuildPermission: z.enum(["yes", "no", "needs_review"]).optional().nullable(),
  architectureNote: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  assignedTo: z.string().uuid().optional().nullable(),
  version: z.number().int(), // optimistic locking
});

export type UpdatePropertyInput = z.infer<typeof updatePropertySchema>;

// ---------- Owner schemas ----------

export const createOwnerSchema = z.object({
  name: z.string().min(1, "氏名は必須です"),
  nameKana: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  zip: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  externalLinkKey: z.string().optional().nullable(),
});

export const updateOwnerSchema = z.object({
  name: z.string().min(1).optional(),
  nameKana: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  zip: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  version: z.number().int(),
});

// ---------- Link owner to property ----------

export const linkOwnerSchema = z.object({
  ownerId: z.string().uuid(),
  relationship: z.string().optional().nullable(),
  isPrimary: z.boolean().default(false),
});
