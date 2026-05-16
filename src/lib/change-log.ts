import prisma from "@/lib/prisma";

export const PROPERTY_TRACKED_FIELDS = [
  "propertyType",
  "address",
  "lotNumber",
  "buildingNumber",
  "realEstateNumber",
  "registryStatus",
  "dmStatus",
  "caseStatus",
  "introductionRoute",
  "gpsLat",
  "gpsLng",
  "zoningDistrict",
  "buildingCoverageRatio",
  "floorAreaRatio",
  "heightDistrict",
  "firePreventionZone",
  "scenicRestriction",
  "roadType",
  "roadWidth",
  "frontageWidth",
  "frontageDirection",
  "setbackRequired",
  "rosenkaValue",
  "rosenkaYear",
  "rebuildPermission",
  "architectureNote",
  "note",
  "assignedTo",
];

export const OWNER_TRACKED_FIELDS = [
  "name",
  "nameKana",
  "phone",
  "zip",
  "address",
  "note",
  "email",
];

export const BUILDING_TRACKED_FIELDS = [
  "name",
  "address",
  "lotNumber",
  "realEstateNumber",
  "totalFloors",
  "totalUnits",
  "builtYear",
  "structureType",
  "managementCompany",
  "gpsLat",
  "gpsLng",
  "note",
];

interface RecordChangesInput {
  targetTable: string;
  targetId: string;
  changedBy: string;
  oldValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
  trackedFields: string[];
  source?: "manual" | "api" | "csv_import" | "pdf_import";
}

export async function recordChanges(input: RecordChangesInput): Promise<void> {
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") return;

  const entries: Array<{
    targetTable: string;
    targetId: string;
    fieldName: string;
    oldValue: string | null;
    newValue: string | null;
    source: "manual" | "api" | "csv_import" | "pdf_import";
    changedBy: string;
  }> = [];

  for (const field of input.trackedFields) {
    if (!(field in input.newValues)) continue;

    const oldVal = input.oldValues[field];
    const newVal = input.newValues[field];
    const oldStr = oldVal != null ? String(oldVal) : null;
    const newStr = newVal != null ? String(newVal) : null;

    if (oldStr !== newStr) {
      entries.push({
        targetTable: input.targetTable,
        targetId: input.targetId,
        fieldName: field,
        oldValue: oldStr,
        newValue: newStr,
        source: input.source ?? "manual",
        changedBy: input.changedBy,
      });
    }
  }

  if (entries.length > 0) {
    try {
      await prisma.changeLog.createMany({ data: entries });
    } catch (err) {
      console.error("Failed to record change logs:", err);
    }
  }
}
