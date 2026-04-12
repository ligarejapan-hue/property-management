/**
 * Haversine distance between two GPS coordinates.
 * Returns distance in meters.
 */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

export type CandidateStrength = "strong" | "medium" | "weak";

export const CANDIDATE_THRESHOLDS: Record<CandidateStrength, number> = {
  strong: 20,
  medium: 30,
  weak: 50,
};

/**
 * Determine candidate strength based on distance.
 * Returns null if distance exceeds the weak threshold.
 */
export function getCandidateStrength(
  distanceMeters: number,
): CandidateStrength | null {
  if (distanceMeters <= CANDIDATE_THRESHOLDS.strong) return "strong";
  if (distanceMeters <= CANDIDATE_THRESHOLDS.medium) return "medium";
  if (distanceMeters <= CANDIDATE_THRESHOLDS.weak) return "weak";
  return null;
}
