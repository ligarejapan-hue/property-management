import type { PermissionMap } from "@/lib/permissions";
import { hasPermission } from "@/lib/permissions";

// ----- Types -----

export type DisplayLevel = "hidden" | "masked" | "partial" | "full" | "read" | "edit";

export interface OwnerDisplayConfig {
  name: DisplayLevel;
  nameKana: DisplayLevel;
  phone: DisplayLevel;
  zip: DisplayLevel;
  address: DisplayLevel;
  note: DisplayLevel;
  email: DisplayLevel;
}

/** Shape of an owner record coming from the database */
interface OwnerRecord {
  id: string;
  name: string;
  nameKana?: string | null;
  phone?: string | null;
  zip?: string | null;
  address?: string | null;
  note?: string | null;
  email?: string | null;
  [key: string]: unknown;
}

// ----- Default display levels for field_staff -----

export const FIELD_STAFF_OWNER_DISPLAY: OwnerDisplayConfig = {
  name: "full",
  nameKana: "full",
  phone: "masked",
  zip: "masked",
  address: "partial",
  note: "hidden",
  email: "masked",
};

// ----- Masking helpers -----

/**
 * Mask a phone number, keeping only the last 4 digits.
 * Example: "090-1234-5678" -> "***-****-5678"
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length < 4) return "***";
  const last4 = digits.slice(-4);
  return `***-****-${last4}`;
}

/**
 * Mask a Japanese zip code, keeping only the first 3 digits.
 * Example: "100-0001" -> "100-****"
 */
export function maskZip(zip: string): string {
  const digits = zip.replace(/[^0-9]/g, "");
  if (digits.length < 3) return "***-****";
  const first3 = digits.slice(0, 3);
  return `${first3}-****`;
}

/**
 * Mask an email address, keeping the first 3 characters of the local part.
 * Example: "yamada@example.com" -> "yam***@example.com"
 * Short local parts (< 3 chars) are fully masked: "ab@example.com" -> "***@example.com"
 */
export function maskEmail(email: string): string {
  const atIdx = email.indexOf("@");
  if (atIdx < 0) return "***";
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx); // includes "@"
  const visible = local.length >= 3 ? local.slice(0, 3) : "";
  return `${visible}***${domain}`;
}

/**
 * Show only the prefecture + city portion of a Japanese address.
 * Splits on common city suffixes (市, 区, 町, 村, 郡).
 * Example: "東京都千代田区丸の内1-1-1" -> "東京都千代田区"
 */
export function partialAddress(address: string): string {
  // Match up to and including the first city-level suffix
  const match = address.match(/^(.+?(?:都|道|府|県).+?(?:市|区|町|村|郡))/);
  if (match) return match[1];

  // Fallback: return first 6 characters
  return address.slice(0, 6) + "...";
}

// ----- Apply display level to a single field -----

function applyLevel(
  value: string | null | undefined,
  level: DisplayLevel,
  maskFn?: (v: string) => string,
): string | null {
  if (value == null) return null;

  switch (level) {
    case "hidden":
      return null;
    case "masked":
      return maskFn ? maskFn(value) : "****";
    case "partial":
      return maskFn ? maskFn(value) : value.slice(0, 3) + "...";
    case "full":
    case "read":
    case "edit":
      return value;
    default:
      return null;
  }
}

// ----- Resolve display config from permissions -----

function resolveOwnerDisplayConfig(permissions: PermissionMap): OwnerDisplayConfig {
  // If the user has full owner access, show everything
  if (hasPermission(permissions, "owner", "full")) {
    return {
      name: "full",
      nameKana: "full",
      phone: "full",
      zip: "full",
      address: "full",
      note: "full",
      email: "full",
    };
  }

  // If the user has read access, use office-level defaults
  if (hasPermission(permissions, "owner", "read")) {
    return {
      name: "full",
      nameKana: "full",
      phone: "full",
      zip: "full",
      address: "full",
      note: "read",
      email: "full",
    };
  }

  // If the user has masked access, use field_staff defaults
  if (hasPermission(permissions, "owner", "masked")) {
    return FIELD_STAFF_OWNER_DISPLAY;
  }

  // No access at all
  return {
    name: "hidden",
    nameKana: "hidden",
    phone: "hidden",
    zip: "hidden",
    address: "hidden",
    note: "hidden",
    email: "hidden",
  };
}

// ----- Main function -----

/**
 * Return a copy of the owner object with fields filtered/masked
 * according to the user's permission levels.
 */
export function applyOwnerDisplayLevel(
  owner: OwnerRecord,
  permissions: PermissionMap,
): OwnerRecord {
  const config = resolveOwnerDisplayConfig(permissions);

  return {
    ...owner,
    name: applyLevel(owner.name, config.name) ?? "",
    nameKana: applyLevel(owner.nameKana, config.nameKana),
    phone: applyLevel(owner.phone, config.phone, maskPhone),
    zip: applyLevel(owner.zip, config.zip, maskZip),
    address: applyLevel(owner.address, config.address, partialAddress),
    note: applyLevel(owner.note, config.note),
    email: applyLevel(owner.email, config.email, maskEmail),
  };
}

/**
 * Apply a pre-resolved OwnerDisplayConfig to a single owner record.
 * Used by both /api/owners/[id] and /api/properties/[id] so that
 * field-level masking (owner_phone, owner_address, owner_email, …)
 * is applied consistently regardless of which endpoint is called.
 *
 * Unlike applyOwnerDisplayLevel (which resolves config from raw PermissionMap),
 * this function takes an already-resolved config from getOwnerDisplayConfig().
 */
export function applyDisplayToOwner(
  owner: {
    name: string;
    nameKana?: string | null;
    phone?: string | null;
    zip?: string | null;
    address?: string | null;
    note?: string | null;
    email?: string | null;
    [key: string]: unknown;
  },
  config: OwnerDisplayConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...owner };

  const fieldMap: Array<{
    key: string;
    configKey: keyof OwnerDisplayConfig;
    maskFn?: (v: string) => string;
  }> = [
    { key: "name", configKey: "name" },
    { key: "nameKana", configKey: "nameKana" },
    { key: "phone", configKey: "phone", maskFn: maskPhone },
    { key: "zip", configKey: "zip", maskFn: maskZip },
    { key: "address", configKey: "address", maskFn: partialAddress },
    { key: "note", configKey: "note" },
    { key: "email", configKey: "email", maskFn: maskEmail },
  ];

  for (const { key, configKey, maskFn } of fieldMap) {
    const level = config[configKey];
    const value = owner[key];

    if (level === "hidden") {
      delete result[key];
    } else if ((level === "masked" || level === "partial") && typeof value === "string" && maskFn) {
      result[key] = maskFn(value);
    }
    // "full", "read", "edit" -> keep as-is
  }

  return result;
}
