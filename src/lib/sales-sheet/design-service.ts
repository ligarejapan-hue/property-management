import prismaDefault from "@/lib/prisma";
import { z } from "zod";
import { parseSalesSheetDocument, type SalesSheetDocument } from "./document-schema";

type PrismaLike = typeof prismaDefault;

// 保存境界での data: 埋め込み画像の上限（src 文字数）。1px プレースホルダ等の極小のみ許容し、
// 写真サイズの base64 blob を document JSON に直接保存して DB を肥大化させるのを防ぐ。
// 通常の保存 doc は /uploads キー参照のみ（data: 化は出力時 authorizeAndInlineDocumentImages だけ）。
const MAX_INLINE_IMAGE_SRC_LEN = 8192;

function assertNoLargeInlineImages(document: SalesSheetDocument): void {
  for (const el of document.elements) {
    if (
      el.type === "image" &&
      el.src.startsWith("data:") &&
      el.src.length > MAX_INLINE_IMAGE_SRC_LEN
    ) {
      // ZodError として投げる＝既存の parse エラーと同様 handleApiError が 422 に変換する
      // （api-helpers の ApiError は next/server を引き込み node テスト環境で解決不可なため）。
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          message: "保存する図面の埋め込み画像が大きすぎます（画像はアップロードして使用してください）",
          path: ["elements"],
        },
      ]);
    }
  }
}

export interface SaveDesignInput {
  propertyId: string;
  title?: string;
  document: unknown;
  templateId?: string | null;
  userId: string;
}

export async function createDesign(input: SaveDesignInput, db: PrismaLike = prismaDefault) {
  const document = parseSalesSheetDocument(input.document); // 不正は throw
  assertNoLargeInlineImages(document); // 大きな data: 画像は拒否（DB 肥大化防止）
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
  const data: Record<string, unknown> = { updatedBy: userId };
  if (patch.title !== undefined) data.title = patch.title.trim() || "無題の販売図面";
  if (patch.document !== undefined) {
    const parsed = parseSalesSheetDocument(patch.document); // throws -> 422, before write
    assertNoLargeInlineImages(parsed); // 大きな data: 画像は拒否（DB 肥大化防止）
    data.document = parsed;
  }
  // Atomic optimistic-lock: timestamp check + write in one operation.
  // updateMany guards the WHERE on updatedAt so two concurrent saves with the
  // same expectedUpdatedAt cannot both succeed — the second gets count=0.
  const result = await db.salesSheetDesign.updateMany({
    where: { id: sheetId, propertyId, updatedAt: new Date(patch.expectedUpdatedAt) },
    data,
  });
  if (result.count === 0) return { ok: false as const, reason: "conflict" as const };
  // count > 0 guarantees the row exists; the non-null assertion is safe here.
  const updated = (await db.salesSheetDesign.findUnique({ where: { id: sheetId } }))!;
  return { ok: true as const, design: updated };
}

export async function deleteDesign(propertyId: string, sheetId: string, db: PrismaLike = prismaDefault) {
  const current = await getDesign(propertyId, sheetId, db);
  if (!current) return false;
  await db.salesSheetDesign.delete({ where: { id: sheetId } });
  return true;
}
