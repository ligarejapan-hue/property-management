/**
 * Prisma-free field constants.
 *
 * このファイルは Prisma Client / DB / server-only モジュールを **一切 import しない**。
 * Rollback の純関数 (src/lib/import-rollback.ts) などが change-log.ts 経由で
 * Prisma runtime を巻き込まないようにするための分離点。
 *
 * 中身を変えるときは src/lib/change-log.ts と src/lib/import-rollback.ts の
 * 両方の挙動を必ず確認すること。
 */

/** Property 編集時に ChangeLog に記録する追跡対象 field 名。 */
export const PROPERTY_TRACKED_FIELDS = [
  "propertyType",
  "address",
  "postalCode",
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

/** Owner 編集時に ChangeLog に記録する追跡対象 field 名。 */
export const OWNER_TRACKED_FIELDS = [
  "name",
  "nameKana",
  "phone",
  "zip",
  "address",
  "note",
  "email",
  "corporateNumber",
];

/** Building 編集時に ChangeLog に記録する追跡対象 field 名。 */
export const BUILDING_TRACKED_FIELDS = [
  "name",
  "address",
  "postalCode",
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
