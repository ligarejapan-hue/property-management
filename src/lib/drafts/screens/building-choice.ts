import { z } from "zod/v4";

/** BuildingChoice(src/lib/building-link/resolve.ts)と同じ形の検査。 */
export const buildingChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto") }),
  z.object({ kind: z.literal("existing"), buildingId: z.string().min(1) }),
  z.object({ kind: z.literal("new") }),
]);
