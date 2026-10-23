import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { getStorage } from "@/lib/storage";
import { stripFieldSurveyPhotoMetadata } from "@/lib/field-survey/exif-strip";
import { readImageDimensions } from "@/lib/image-dimensions";
import { requireDealAdmin, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { DEAL_SETTINGS_ID, resolveDealSettings } from "@/lib/deals/settings";
import {
  DEAL_IMAGE_EXT, DEAL_IMAGE_KEY_FIELD, DEAL_IMAGE_MAX_BYTES, DEAL_IMAGE_MAX_EDGE,
  dealImageKey, dealImageMimeFromKey, isDealImageKind, isDealImageMime, type DealImageKind,
} from "@/lib/deals/branding";

type Ctx = { params: Promise<{ kind: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
/** 0 = まだ設定の行が無い(初めての保存)。 */
const versionSchema = z.coerce.number().int().min(0);
const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";
const conflict = () => new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");

async function kindOf(ctx: Ctx): Promise<DealImageKind> {
  const { kind } = await ctx.params;
  if (!isDealImageKind(kind)) throw new ApiError(404, "見つかりません", "NOT_FOUND");
  return kind;
}
function versionOf(v: FormDataEntryValue | string | null): number {
  const r = versionSchema.safeParse(typeof v === "string" && v.trim() !== "" ? v : undefined);
  if (!r.success) throw new ApiError(422, "設定の版の番号がありません。画面を読み込み直してください。", "VALIDATION_ERROR");
  return r.data;
}
async function currentRow() {
  return prisma.dealSettings.findUnique({ where: { id: DEAL_SETTINGS_ID } });
}
async function settingsResponse() {
  return NextResponse.json({ settings: resolveDealSettings(await currentRow()) }, { headers: NO_STORE });
}

/** 設定画面の見本。管理者だけ。`/uploads` からは配らない(設計の読み替え 2)。 */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    await requireDealAdmin();
    const kind = await kindOf(ctx);
    const row = await currentRow();
    const key = row?.[DEAL_IMAGE_KEY_FIELD[kind]];
    const mime = key ? dealImageMimeFromKey(key) : null;
    const file = key && mime ? await getStorage().read(key) : null;
    if (!file || !mime) throw new ApiError(404, "見つかりません", "NOT_FOUND");
    return new Response(new Uint8Array(file.body), {
      headers: { "Content-Type": mime, "Content-Length": String(file.body.length), ...NO_STORE, "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * ロゴ・角印を登録する(差し替えも同じ)。PNG・JPEG だけ。EXIF を落としてから置き、設定の版の番号が合うときだけ鍵を書く。
 * 書けなかったら置いた画像を消す。書けたら前の画像を消す。
 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const session = await requireDealAdmin();
    const kind = await kindOf(ctx);
    if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      throw new ApiError(422, "画像を選んでください", "VALIDATION_ERROR");
    }
    const form = await request.formData();
    const version = versionOf(form.get("version"));
    const file = form.get("file");
    if (!(file instanceof Blob)) throw new ApiError(422, "画像を選んでください", "VALIDATION_ERROR");
    const mime = file.type;
    if (!isDealImageMime(mime)) throw new ApiError(422, "PNG か JPEG の画像を選んでください", "VALIDATION_ERROR");
    if (file.size > DEAL_IMAGE_MAX_BYTES) throw new ApiError(422, "画像は 1MB 以下にしてください", "VALIDATION_ERROR");

    // 位置情報などを残さない(保存前に EXIF を落とす)。中身が形式と合わなければここで止まる。
    const stripped = stripFieldSurveyPhotoMetadata(Buffer.from(await file.arrayBuffer()), mime);
    if (!stripped.ok) throw new ApiError(422, "画像ファイルを読み取れませんでした", "VALIDATION_ERROR");
    const body = stripped.buffer;
    const dims = readImageDimensions(body, mime);
    if (!dims) throw new ApiError(422, "画像ファイルを読み取れませんでした", "VALIDATION_ERROR");
    if (Math.max(dims.width, dims.height) > DEAL_IMAGE_MAX_EDGE) {
      throw new ApiError(422, `画像の長い辺は ${DEAL_IMAGE_MAX_EDGE}px 以下にしてください`, "VALIDATION_ERROR");
    }

    const field = DEAL_IMAGE_KEY_FIELD[kind];
    const before = await currentRow();
    if ((before?.version ?? 0) !== version) throw conflict();
    const oldKey = before?.[field] ?? null;

    const storage = getStorage();
    const stored = await storage.upload(body, { key: dealImageKey(kind, randomUUID(), mime), mimeType: mime, fileName: `${kind}.${DEAL_IMAGE_EXT[mime]}` });
    try {
      if (version === 0) {
        await prisma.dealSettings.create({ data: { id: DEAL_SETTINGS_ID, [field]: stored.key, updatedById: session.id } });
      } else {
        const res = await prisma.dealSettings.updateMany({
          where: { id: DEAL_SETTINGS_ID, version },
          data: { [field]: stored.key, updatedById: session.id, version: { increment: 1 } },
        });
        if (res.count === 0) throw conflict();
      }
    } catch (e) {
      await storage.delete(stored.key).catch(() => undefined);
      if (isUniqueViolation(e)) throw conflict();
      throw e;
    }
    if (oldKey) await storage.delete(oldKey).catch(() => undefined);

    // 監査には種類・寸法・大きさだけ(ファイル名は残さない)。
    await writeAuditLog({
      userId: session.id, action: "deal_settings_image_update", targetTable: "deal_settings",
      detail: { kind, op: "set", bytes: body.length, width: dims.width, height: dims.height },
    });
    return settingsResponse();
  } catch (error) {
    return handleApiError(error);
  }
}

/** ロゴ・角印の登録を外す。鍵を空にしてから画像を消す。 */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    const session = await requireDealAdmin();
    const kind = await kindOf(ctx);
    const version = versionOf(new URL(request.url).searchParams.get("version"));
    const field = DEAL_IMAGE_KEY_FIELD[kind];
    const before = await currentRow();
    if ((before?.version ?? 0) !== version) throw conflict();
    const oldKey = before?.[field] ?? null;
    if (!oldKey) return settingsResponse();

    const res = await prisma.dealSettings.updateMany({
      where: { id: DEAL_SETTINGS_ID, version },
      data: { [field]: null, updatedById: session.id, version: { increment: 1 } },
    });
    if (res.count === 0) throw conflict();
    await getStorage().delete(oldKey).catch(() => undefined);
    await writeAuditLog({
      userId: session.id, action: "deal_settings_image_update", targetTable: "deal_settings", detail: { kind, op: "clear" },
    });
    return settingsResponse();
  } catch (error) {
    return handleApiError(error);
  }
}
