import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";

/**
 * GET /api/attachments/search — 添付の横断検索（管理者限定）。
 *
 * 物件詳細配下に閉じている添付を、type / ファイル名（部分一致）/ 期間 / 対象
 * （targetType・targetId）で横断検索する admin 専用エンドポイント。既存
 * Attachment.@@index([targetType, targetId]) を活用する。schema 変更なし。
 *
 *  - 認証必須・実効権限を要求（オーバーライド反映・いずれか欠落/剥奪/マスクで 403）:
 *    user_management:read かつ property:read かつ owner:read、加えてファイル名は自由テキストで
 *    任意の owner PII を含み得るため owner PII 全フィールド（name/kana/phone/zip/address/note/
 *    email/corporate_number）が edit/full/read（getOwnerDisplayConfig で解決）。
 *  - 既定で isDeleted=false（削除済みは除外）。
 *  - 返却は **メタデータのみ**（id / fileName / type / createdAt / targetType /
 *    targetId）。**ファイル本体 URL(fileUrl)は select せず結果に一切載せない**
 *    （ダウンロードは物件詳細など本来の権限導線でのみ。横断検索は所在把握用）。
 *  - 検索操作は非PII audit に記録する（検索語の生値は載せず、フィルタの有無/種別
 *    と件数のみ）。
 */

const RESULT_LIMIT = 200;

// owner PII フィールドを「生値で閲覧できる」とみなす field-level 可視性。
// partial/masked/hidden は不可（ファイル名に混入し得る owner PII の保護のため fail-closed）。
const OWNER_PII_VISIBLE_LEVELS: ReadonlySet<string> = new Set([
  "edit",
  "full",
  "read",
]);

const querySchema = z.object({
  type: z.enum(["general", "registry"]).optional(),
  fileName: z.string().trim().min(1).max(200).optional(),
  targetType: z.enum(["property", "owner", "comment"]).optional(),
  targetId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const QUERY_KEYS = [
  "type",
  "fileName",
  "targetType",
  "targetId",
  "from",
  "to",
] as const;

export async function GET(request: Request) {
  try {
    const session = await getApiSession();
    // 認可は実効権限で判定する。getUserPermissions は DB から role 由来テンプレートと
    // ユーザー個別オーバーライドをマージした現在の権限を返すため、JWT 上の role や DB
    // role 単独に依存せず、ログイン後の降格・権限剥奪も尊重する。本検索は全添付のメタ
    // （ファイル名・targetId 等、PII を含み得る）を横断露出するため、管理者能力
    // (user_management:read) に加えて、添付が紐づくデータの read 権限（property:read・
    // owner:read）も要求する。これにより audit ログ閲覧権限だけ／データ権限を剥奪された
    // アカウントは弾かれる。いずれかを欠く/オーバーライドで剥奪された場合は 403。
    const perms = await getUserPermissions(session.id);
    // ファイル名は利用者がアップロード時に付ける自由テキストで、owner の氏名・住所・電話・
    // メール・郵便番号等あらゆる PII を含み得る。したがって owner PII 全フィールドの実効
    // 可視性（edit/full/read）を要求し、いずれかが partial/masked/hidden の利用者には
    // 生ファイル名を横断検索/閲覧させない（field-level マスキングを本経由で回避させない）。
    // 実効レベルは getOwnerDisplayConfig（email→phone / corporate_number→name の
    // fallback を反映）で解決する。
    const ownerDisplay = await getOwnerDisplayConfig(session.id, perms);
    const allOwnerPiiVisible = Object.values(ownerDisplay).every((level) =>
      OWNER_PII_VISIBLE_LEVELS.has(level),
    );
    const allowed =
      hasPermission(perms, "user_management", "read") &&
      hasPermission(perms, "property", "read") &&
      hasPermission(perms, "owner", "read") &&
      allOwnerPiiVisible;
    if (!allowed) {
      throw new ApiError(403, "この操作の権限がありません", "FORBIDDEN");
    }

    // 空文字パラメータは未指定扱いにしてから検証する。
    const searchParams = new URL(request.url).searchParams;
    const raw: Record<string, string> = {};
    for (const key of QUERY_KEYS) {
      const value = searchParams.get(key);
      if (value != null && value.trim() !== "") raw[key] = value;
    }

    const parsed = querySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(400, "検索条件が不正です", "VALIDATION_ERROR");
    }
    const q = parsed.data;

    const where: Record<string, unknown> = { isDeleted: false };
    if (q.type) where.type = q.type;
    if (q.fileName) where.fileName = { contains: q.fileName, mode: "insensitive" };
    if (q.targetType) where.targetType = q.targetType;
    if (q.targetId) where.targetId = q.targetId;
    if (q.from || q.to) {
      const createdAt: { gte?: Date; lte?: Date } = {};
      if (q.from) createdAt.gte = q.from;
      if (q.to) {
        // 期間（終了）は日付指定でもその日全体を含めるため終端を 23:59:59.999 に寄せる。
        const end = new Date(q.to);
        end.setHours(23, 59, 59, 999);
        createdAt.lte = end;
      }
      where.createdAt = createdAt;
    }

    const results = await prisma.attachment.findMany({
      where,
      // メタデータのみ。fileUrl・fileSize・mimeType 等の本体情報は意図的に非選択。
      select: {
        id: true,
        fileName: true,
        type: true,
        createdAt: true,
        targetType: true,
        targetId: true,
      },
      orderBy: { createdAt: "desc" },
      take: RESULT_LIMIT,
    });

    await writeAuditLog({
      userId: session.id,
      action: "attachment_search",
      targetTable: "attachments",
      // 非PII: 検索語（fileName 等、PII を含み得る生値）は記録せず、フィルタの
      // 有無/種別と件数のみを残す。
      detail: {
        filters: {
          type: q.type ?? null,
          hasFileName: Boolean(q.fileName),
          targetType: q.targetType ?? null,
          targetId: q.targetId ?? null,
          from: q.from ? q.from.toISOString() : null,
          to: q.to ? q.to.toISOString() : null,
        },
        resultCount: results.length,
      },
    });

    return apiResponse({ data: results, count: results.length, limit: RESULT_LIMIT });
  } catch (error) {
    return handleApiError(error);
  }
}
