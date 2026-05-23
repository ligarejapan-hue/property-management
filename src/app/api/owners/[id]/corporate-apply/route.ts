// POST /api/owners/[id]/corporate-apply
// Phase C: 法人番号 lookup preview の結果を Owner.name / address / zip / corporateNumber に反映する。
//
// 設計上の不変条件:
// - 自動上書きはしない（クライアントが apply.* を明示）
// - 値はサーバ側で必ず再 lookup して取得する。client から送られた expectedRecord は
//   「previewと食い違いがないか」のための比較スナップショットであり、保存しない。
// - Owner.version で optimistic lock
// - AuditLog detail には法人番号生値・会社名・所在地・郵便番号・フリガナ・raw XML・
//   Owner.name / address / phone / email / memo 本文 / rawData 全文を一切含めない。
// - 廃止法人は allowClosed=true がなければ 409 で止める。

import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { recordChanges, OWNER_TRACKED_FIELDS } from "@/lib/change-log";
import { hasPermission, hasExplicitWritePerm } from "@/lib/permissions";
import { normalizeCorporateNumber } from "@/lib/corporate-number";
import {
  CorporateLookupError,
  lookupCorporateNumber,
  type CorporateLookupRecord,
} from "@/lib/corporate-lookup";

const expectedRecordSchema = z.object({
  corporateNumber: z.string(),
  name: z.string(),
  address: z.string(),
  postCode: z.string().nullable(),
  updateDate: z.string().nullable(),
});

const applyFlagsSchema = z.object({
  name: z.boolean(),
  address: z.boolean(),
  zip: z.boolean(),
  corporateNumber: z.boolean(),
});

const applyRequestSchema = z.object({
  corporateNumber: z.string(),
  version: z.number().int(),
  apply: applyFlagsSchema,
  expectedRecord: expectedRecordSchema,
  allowClosed: z.boolean().optional(),
});

type ApplyFlags = z.infer<typeof applyFlagsSchema>;
type ApplyResult =
  | "applied"
  | "stale"
  | "version_conflict"
  | "not_found"
  | "closed_blocked"
  | "validation_error"
  | "forbidden"
  | "upstream_error";

function mapLookupErrorToApi(err: CorporateLookupError): ApiError {
  switch (err.code) {
    case "NOT_CONFIGURED":
      return new ApiError(503, "法人番号APIが設定されていません", "NOT_CONFIGURED");
    case "RATE_LIMITED":
      return new ApiError(429, "国税庁APIのレート制限に達しました", "RATE_LIMITED");
    case "TIMEOUT":
    case "NETWORK":
    case "UPSTREAM_4XX":
    case "UPSTREAM_5XX":
    case "PARSE_ERROR":
    default:
      return new ApiError(502, "国税庁APIからの応答取得に失敗しました", "UPSTREAM_ERROR");
  }
}

/**
 * lookup の postCode (7桁ハイフンなし) を Owner.zip の既存形式 (XXX-XXXX) に整形する。
 * 7桁以外は null（既存値を上書きしない判断は呼び出し側で行う想定はしない、ここで弾く）。
 */
function formatPostCodeToZip(postCode: string | null): string | null {
  if (!postCode) return null;
  const digits = postCode.replace(/\D/g, "");
  if (digits.length !== 7) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

function recordsMatch(
  expected: z.infer<typeof expectedRecordSchema>,
  fresh: CorporateLookupRecord,
): boolean {
  return (
    expected.corporateNumber === fresh.corporateNumber &&
    expected.name === fresh.name &&
    expected.address === fresh.address &&
    expected.postCode === fresh.postCode &&
    expected.updateDate === fresh.updateDate
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let auditUserId: string | null = null;
  let auditOwnerId: string | null = null;
  let auditApplied: ApplyFlags | null = null;
  let auditIsClosed = false;
  let auditSource: string | null = null;
  let auditResult: ApplyResult = "validation_error";
  let auditHttpStatus: number | null = null;

  try {
    const { id } = await params;
    auditOwnerId = id;
    const session = await getApiSession();
    auditUserId = session.id;
    const perms = await getUserPermissions(session.id);

    // ---- session/perm scope ----
    if (!hasPermission(perms, "owner", "write")) {
      auditResult = "forbidden";
      throw new ApiError(403, "所有者を更新する権限がありません", "FORBIDDEN");
    }

    // ---- body parse ----
    const raw = (await request.json().catch(() => ({}))) as unknown;
    const parsed = applyRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(400, "リクエスト形式が不正です", "VALIDATION_ERROR");
    }
    const body = parsed.data;
    auditApplied = body.apply;

    // ---- normalize corporateNumber ----
    const normalized = normalizeCorporateNumber(body.corporateNumber);
    if (!normalized) {
      throw new ApiError(
        422,
        "法人番号は13桁の数字で指定してください",
        "VALIDATION_ERROR",
      );
    }
    // expectedRecord.corporateNumber も 13桁正規化前提
    const expectedNormalized = normalizeCorporateNumber(body.expectedRecord.corporateNumber);
    if (!expectedNormalized || expectedNormalized !== normalized) {
      auditResult = "stale";
      throw new ApiError(
        409,
        "プレビュー時の法人番号と一致しません",
        "FETCH_STALE",
      );
    }

    // ---- apply フィールドが全 false なら 400 ----
    const anyApply =
      body.apply.name ||
      body.apply.address ||
      body.apply.zip ||
      body.apply.corporateNumber;
    if (!anyApply) {
      throw new ApiError(
        400,
        "反映対象が1つも指定されていません",
        "VALIDATION_ERROR",
      );
    }

    // ---- field-level write perm（要求された field だけ厳格に要求） ----
    // 拒否時は DB アクセス前に失敗するため、生値ログには到達しない。
    const fieldChecks: Array<{ flag: boolean; resource: string; label: string }> = [
      { flag: body.apply.name, resource: "owner_name", label: "name" },
      { flag: body.apply.address, resource: "owner_address", label: "address" },
      { flag: body.apply.zip, resource: "owner_zip", label: "zip" },
      {
        flag: body.apply.corporateNumber,
        resource: "owner_corporate_number",
        label: "corporateNumber",
      },
    ];
    for (const { flag, resource, label } of fieldChecks) {
      if (flag && !hasExplicitWritePerm(perms, resource)) {
        auditResult = "forbidden";
        throw new ApiError(
          403,
          `${label} を更新する権限がありません`,
          "FORBIDDEN",
        );
      }
    }

    // ---- Owner 実在 + archived チェック ----
    const currentOwner = await prisma.owner.findUnique({ where: { id } });
    if (!currentOwner || currentOwner.isArchived) {
      auditResult = "not_found";
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    // ---- サーバ側で再 lookup（クライアント送信値を信用しない） ----
    let fresh;
    try {
      fresh = await lookupCorporateNumber(normalized);
    } catch (err) {
      if (err instanceof CorporateLookupError) {
        auditResult = "upstream_error";
        throw mapLookupErrorToApi(err);
      }
      throw err;
    }
    auditSource = fresh.source;
    auditIsClosed = fresh.isClosed;

    if (!fresh.found || !fresh.record) {
      auditResult = "stale";
      throw new ApiError(
        422,
        "再取得時に法人が見つかりませんでした",
        "LOOKUP_NOT_FOUND",
      );
    }
    if (!fresh.record.name || fresh.record.name.trim() === "") {
      auditResult = "stale";
      throw new ApiError(
        422,
        "再取得結果に会社名が含まれていません",
        "LOOKUP_INVALID",
      );
    }

    // ---- 廃止法人 ----
    if (fresh.isClosed && body.allowClosed !== true) {
      auditResult = "closed_blocked";
      throw new ApiError(
        409,
        "廃止法人です。反映を実行するには allowClosed=true を指定してください",
        "CLOSED_NOT_ALLOWED",
      );
    }

    // ---- expectedRecord 整合性チェック ----
    // preview を出した時点の値と再 lookup の値が完全一致しなければ stale。
    if (!recordsMatch(body.expectedRecord, fresh.record)) {
      auditResult = "stale";
      throw new ApiError(
        409,
        "プレビュー後に法人情報が更新されています。再検索してください",
        "FETCH_STALE",
      );
    }

    // ---- 反映フィールド組み立て ----
    const updateFields: Record<string, unknown> = {};
    if (body.apply.name) updateFields.name = fresh.record.name;
    if (body.apply.address) updateFields.address = fresh.record.address;
    if (body.apply.zip) {
      const z = formatPostCodeToZip(fresh.record.postCode);
      if (z === null) {
        auditResult = "stale";
        throw new ApiError(
          422,
          "再取得結果に有効な郵便番号がありません",
          "LOOKUP_INVALID",
        );
      }
      updateFields.zip = z;
    }
    if (body.apply.corporateNumber) {
      updateFields.corporateNumber = fresh.record.corporateNumber;
    }

    // ---- optimistic lock update ----
    const result = await prisma.owner.updateMany({
      where: { id, version: body.version },
      data: {
        ...updateFields,
        version: { increment: 1 },
      },
    });
    if (result.count === 0) {
      auditResult = "version_conflict";
      throw new ApiError(409, "他のユーザーが先に更新しました", "CONFLICT");
    }

    // ---- ChangeLog（既存 OWNER_TRACKED_FIELDS / source="manual" を流用） ----
    await recordChanges({
      targetTable: "owners",
      targetId: id,
      changedBy: session.id,
      oldValues: currentOwner as unknown as Record<string, unknown>,
      newValues: updateFields,
      trackedFields: OWNER_TRACKED_FIELDS,
    });

    // ---- AuditLog（生値・PII は入れない） ----
    auditResult = "applied";
    auditHttpStatus = 200;
    await writeAuditLog({
      userId: session.id,
      action: "owner_corporate_apply",
      targetTable: "owners",
      targetId: id,
      detail: {
        applied: body.apply,
        isClosed: auditIsClosed,
        source: auditSource,
        result: auditResult,
        httpStatus: auditHttpStatus,
      },
    });

    // ---- response: 最小限（PII は返さない） ----
    const newVersion = (currentOwner.version ?? body.version) + 1;
    return apiResponse({
      ok: true,
      owner: { id, version: newVersion },
    });
  } catch (error) {
    // エラー時も AuditLog を残す（route 内で session/owner 解決済の場合のみ）。
    // detail には生値を一切残さない。
    if (auditUserId && auditOwnerId && error instanceof ApiError) {
      auditHttpStatus = error.status;
      try {
        await writeAuditLog({
          userId: auditUserId,
          action: "owner_corporate_apply",
          targetTable: "owners",
          targetId: auditOwnerId,
          detail: {
            applied: auditApplied ?? {
              name: false,
              address: false,
              zip: false,
              corporateNumber: false,
            },
            isClosed: auditIsClosed,
            source: auditSource,
            result: auditResult,
            httpStatus: auditHttpStatus,
          },
        });
      } catch {
        // audit 失敗は本処理を壊さない
      }
    }
    return handleApiError(error);
  }
}
