import type { PermissionEntry } from "@/lib/api-helpers";

/**
 * PermissionMap is an alias for PermissionEntry[] used by display-level module.
 */
export type PermissionMap = PermissionEntry[];

/**
 * Check if the given permissions grant access to a resource+action.
 * Defaults to deny if no matching entry is found.
 */
export function hasPermission(
  permissions: PermissionEntry[],
  resource: string,
  action: string,
): boolean {
  const entry = permissions.find(
    (p) => p.resource === resource && p.action === action,
  );
  return entry?.granted ?? false;
}

/**
 * Get the highest-level display permission for an owner field.
 * Returns: "full" | "read" | "partial" | "masked" | "hidden"
 */
export function getOwnerFieldLevel(
  permissions: PermissionEntry[],
  fieldResource: string,
): string {
  // Priority: edit > full > read > partial > masked > hidden
  const levels = ["edit", "full", "read", "partial", "masked", "hidden"];
  for (const level of levels) {
    const entry = permissions.find(
      (p) => p.resource === fieldResource && p.action === level,
    );
    if (entry?.granted) return level;
  }
  return "hidden";
}

/**
 * Mask a value based on display level.
 */
export function maskValue(
  value: string | null | undefined,
  level: string,
): string | null {
  if (!value) return null;

  switch (level) {
    case "edit":
    case "full":
    case "read":
      return value;
    case "partial":
      // Show first 3 chars + ***
      return value.length > 3 ? value.substring(0, 3) + "***" : value;
    case "masked":
      // Show last 4 chars, mask rest
      if (value.length <= 4) return "****";
      return "***" + value.substring(value.length - 4);
    case "hidden":
    default:
      return null;
  }
}
