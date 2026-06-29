import prismaDefault from "@/lib/prisma";
import { z } from "zod";
import { parseSalesSheetDocument, type SalesSheetDocument } from "./document-schema";

type PrismaLike = typeof prismaDefault;

// 保存境界の bloat ガード。data: 化は出力時(authorizeAndInlineDocumentImages)のみで、保存 doc は
// /uploads キー参照のみ。property:write ユーザーが巨大データを document JSON に直書きして DB を
// 肥大化させるのを防ぐため、(1) 文書全体のサイズと (2) 個別の data: 埋め込み画像 を上限で弾く。
const MAX_INLINE_IMAGE_SRC_LEN = 8192; // 個別 data: 画像（image.src / qr.dataUrl）
const MAX_DOCUMENT_JSON_LEN = 512 * 1024; // 文書全体（text.content・長い /uploads パス・要素数等の総和）

function makeDocumentError(message: string): z.ZodError {
  // ZodError として投げる＝既存の parse エラーと同様 handleApiError が 422 に変換する
  // （api-helpers の ApiError は next/server を引き込み node テスト環境で解決不可なため）。
  return new z.ZodError([{ code: z.ZodIssueCode.custom, message, path: ["elements"] }]);
}

function assertSavableDocument(document: SalesSheetDocument): void {
  if (JSON.stringify(document).length > MAX_DOCUMENT_JSON_LEN) {
    throw makeDocumentError("保存する図面のデータが大きすぎます");
  }
  for (const el of document.elements) {
    // image.src と qr.dataUrl はどちらも data:image を持ち得る（保存では極小のみ許容）。
    const inlineSrc = el.type === "image" ? el.src : el.type === "qr" ? el.dataUrl : null;
    if (inlineSrc && inlineSrc.startsWith("data:") && inlineSrc.length > MAX_INLINE_IMAGE_SRC_LEN) {
      throw makeDocumentError(
        "保存する図面の埋め込み画像が大きすぎます（画像はアップロードして使用してください）",
      );
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
  assertSavableDocument(document); // サイズ上限（DB 肥大化防止）
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
    assertSavableDocument(parsed); // サイズ上限（DB 肥大化防止）
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
  // 並行 DELETE で再 read が null になり得る（count>0 の直後でも TOCTOU）→ conflict 扱い（500 回避）。
  const updated = await db.salesSheetDesign.findUnique({ where: { id: sheetId } });
  if (!updated) return { ok: false as const, reason: "conflict" as const };
  return { ok: true as const, design: updated };
}

export async function deleteDesign(propertyId: string, sheetId: string, db: PrismaLike = prismaDefault) {
  // Scope-aware atomic delete: id と propertyId が両方一致する行だけ消す。
  // getDesign→delete の TOCTOU（並行二重削除で Prisma P2025 が throw → 500）を避け、
  // 該当無し（他物件・既削除）は count=0 → false（→ route で 404）。
  const result = await db.salesSheetDesign.deleteMany({ where: { id: sheetId, propertyId } });
  return result.count > 0;
}
