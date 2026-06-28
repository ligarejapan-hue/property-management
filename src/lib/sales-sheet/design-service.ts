import prismaDefault from "@/lib/prisma";
import { parseSalesSheetDocument } from "./document-schema";

type PrismaLike = typeof prismaDefault;

export interface SaveDesignInput {
  propertyId: string;
  title?: string;
  document: unknown;
  templateId?: string | null;
  userId: string;
}

export async function createDesign(input: SaveDesignInput, db: PrismaLike = prismaDefault) {
  const document = parseSalesSheetDocument(input.document); // 不正は throw
  return db.salesSheetDesign.create({
    data: {
      propertyId: input.propertyId,
      title: input.title?.trim() || "無題の販売図面",
      document,
      templateId: input.templateId ?? null,
      createdBy: input.userId,
      updatedBy: input.userId,
    },
  });
}

export async function getDesign(propertyId: string, sheetId: string, db: PrismaLike = prismaDefault) {
  const d = await db.salesSheetDesign.findUnique({ where: { id: sheetId } });
  if (!d || d.propertyId !== propertyId) return null; // スコープ外は null
  return d;
}

export async function listDesigns(propertyId: string, db: PrismaLike = prismaDefault) {
  return db.salesSheetDesign.findMany({
    where: { propertyId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, updatedAt: true, createdAt: true, thumbnailUrl: true },
  });
}

export async function updateDesign(
  propertyId: string,
  sheetId: string,
  patch: { title?: string; document?: unknown; expectedUpdatedAt: string | Date },
  userId: string,
  db: PrismaLike = prismaDefault,
) {
  const current = await getDesign(propertyId, sheetId, db);
  if (!current) return { ok: false as const, reason: "not_found" as const };
  if (new Date(current.updatedAt).getTime() !== new Date(patch.expectedUpdatedAt).getTime())
    return { ok: false as const, reason: "conflict" as const };
  const data: Record<string, unknown> = { updatedBy: userId };
  if (patch.title !== undefined) data.title = patch.title.trim() || "無題の販売図面";
  if (patch.document !== undefined) data.document = parseSalesSheetDocument(patch.document);
  const updated = await db.salesSheetDesign.update({ where: { id: sheetId }, data });
  return { ok: true as const, design: updated };
}

export async function deleteDesign(propertyId: string, sheetId: string, db: PrismaLike = prismaDefault) {
  const current = await getDesign(propertyId, sheetId, db);
  if (!current) return false;
  await db.salesSheetDesign.delete({ where: { id: sheetId } });
  return true;
}
