import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, maskValue } from "@/lib/permissions";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import { writeAuditLog } from "@/lib/audit";
import { encodeCsv, sanitizeCsvCellForExcel } from "@/lib/csv-encode";
import { createTokenBucketLimiter } from "@/lib/token-bucket";
import {
  lookupAddressByPostalCode,
  isAddressLookupConfigured,
  AddressLookupError,
  normalizePostalCode,
  isValidPostalCode,
} from "@/lib/address-lookup";
import {
  comparePostalAddress,
  buildPostalAuditCsvRow,
  POSTAL_AUDIT_CSV_HEADERS,
  POSTAL_AUDIT_MAX_TARGETS,
  type PostalAuditRow,
  type PostalAuditCandidate,
} from "@/lib/postal-code-audit";

// ---------- GET /api/admin/postal-code-audit ----------
//
// 所有者(Owner)の保存済み郵便番号(zip)と住所(address)が整合しているかを、
// 郵便番号 → 住所 lookup（日本郵便 API 等）と突き合わせて点検する read-only レポート。
// DB は一切変更しない（自動修正なし）。on-demand 実行（自動バッチなし）。
//
// 権限:
//   - user_management:read（管理者エリア）+ owner:read（PII 閲覧）必須
//   - CSV 出力(?format=csv)はさらに csv_export:read / csv_export_personal:read 必須
//     （所有者名・郵便番号・住所という PII を含む CSV のため、既存 DM/CSV export と同じゲート）
//
// PII egress 最小化:
//   - 外部 API へ送るのは「郵便番号のみ」。保存住所は外部へ送らず、サーバ内で
//     取得済み候補住所（一般地名）と突き合わせるだけ（comparePostalAddress）。
//   - 同一郵便番号は 1 回だけ lookup してキャッシュする（API 呼び出し削減 + egress 削減）。
//
// レート制御・件数上限:
//   - 対象 owner が多いと多数の API 呼び出しになるため token-bucket で throttle。
//   - 対象は POSTAL_AUDIT_MAX_TARGETS 件で打ち切り、超過時は silent に切らず truncated を立てる。

// 1 秒あたり 5 リクエスト・バースト 5 の控えめなレート。外部 API への礼儀的 throttle。
const LOOKUP_REFILL_PER_SEC = 5;
const LOOKUP_BURST = 5;
// throttle 待機の最大ループ（暴走防止）。1 件あたり最長 ~2 秒待つ。
const MAX_WAIT_MS_PER_LOOKUP = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    // 管理者エリア + PII 閲覧。いずれか欠ければ DB 取得・API 照合・AuditLog 書込を行わず 403。
    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }

    const { searchParams } = new URL(request.url);
    const wantsCsv = searchParams.get("format") === "csv";

    // CSV は PII を含むため、既存 DM/CSV export と同じ csv_export 系ゲートを追加で課す。
    if (wantsCsv) {
      if (!hasPermission(perms, "csv_export", "read")) {
        throw new ApiError(403, "CSV エクスポートの権限がありません", "FORBIDDEN");
      }
      if (!hasPermission(perms, "csv_export_personal", "read")) {
        throw new ApiError(
          403,
          "個人情報を含む CSV エクスポートの権限がありません",
          "FORBIDDEN",
        );
      }
    }

    const displayConfig = await getOwnerDisplayConfig(session.id, perms);

    // 表示権限が「生値を返すレベル」かどうか。保存住所が隠れるレベルでは、
    // 突き合わせ結果（API住所/判定）を出しても監査として意味が薄く、かつ
    // API住所と保存住所マスクの差で住所を推測される懸念があるため API住所も伏せる。
    const addressPlain = isPlainOwnerLevel(displayConfig.address);

    // 1. 対象 owner（非アーカイブ・zip と address の両方あり）を取得。
    //    DB レベルで zip/address 非空に絞り、無駄な API 照合対象を減らす。
    //    take = MAX+1 で「上限超過」を検出（超過分は照合せず truncated を立てる）。
    const owners = await prisma.owner.findMany({
      where: {
        isArchived: false,
        zip: { not: null },
        address: { not: null },
      },
      select: { id: true, name: true, zip: true, address: true },
      orderBy: { createdAt: "asc" },
      take: POSTAL_AUDIT_MAX_TARGETS + 1,
    });

    const truncated = owners.length > POSTAL_AUDIT_MAX_TARGETS;
    const targets = truncated ? owners.slice(0, POSTAL_AUDIT_MAX_TARGETS) : owners;

    // 2. API 未設定なら照合せず安全に返す（クラッシュしない）。
    //    全 owner を indeterminate(lookup_unavailable) として返し、apiConfigured=false を立てる。
    const apiConfigured = isAddressLookupConfigured();

    // 同一郵便番号の lookup 結果キャッシュ（正規化済み 7 桁 zip → 候補 or null[=不能]）。
    const lookupCache = new Map<string, PostalAuditCandidate[] | null>();
    const limiter = createTokenBucketLimiter({
      capacity: LOOKUP_BURST,
      refillPerSec: LOOKUP_REFILL_PER_SEC,
    });

    // API 設定済みのときだけ実際に lookup する純度の高い helper。
    // 未設定・有効な郵便番号でない場合は null/skip を返し、comparePostalAddress に委ねる。
    async function lookupCandidates(rawZip: string): Promise<PostalAuditCandidate[] | null> {
      if (!apiConfigured) return null;
      const zip7 = normalizePostalCode(rawZip);
      if (!isValidPostalCode(zip7)) {
        // 不正郵便番号は API を叩かない（comparePostalAddress が invalid_postal_code を返す）。
        // candidates は [] を渡しても invalid 判定が優先されるが、PII egress と無駄打ちを避けるため照合しない。
        return [];
      }
      if (lookupCache.has(zip7)) return lookupCache.get(zip7)!;

      // throttle: トークンが取れるまで短時間待つ（暴走防止に上限あり）。
      let waited = 0;
      while (!limiter.tryConsume("postal-audit", Date.now())) {
        if (waited >= MAX_WAIT_MS_PER_LOOKUP) break;
        await sleep(100);
        waited += 100;
      }

      let result: PostalAuditCandidate[] | null;
      try {
        // PII egress は郵便番号のみ（住所は送らない）。
        const candidates = await lookupAddressByPostalCode(zip7);
        result = candidates.map((c) => ({ addressLine: c.addressLine }));
      } catch (err) {
        // NOT_CONFIGURED 等は安全側で照合不能(null)に倒す。message に PII は無い。
        if (err instanceof AddressLookupError) {
          result = null;
        } else {
          // 想定外エラーも owner 単位の indeterminate に倒し、レポート全体は壊さない。
          result = null;
        }
      }
      lookupCache.set(zip7, result);
      return result;
    }

    // 3. owner ごとに照合。
    const rows: PostalAuditRow[] = [];
    for (const owner of targets) {
      const candidates = await lookupCandidates(owner.zip ?? "");
      const cmp = comparePostalAddress(owner.zip, owner.address, candidates);
      rows.push({
        ownerId: owner.id,
        nameMasked: maskValue(owner.name, displayConfig.name),
        zipMasked: maskValue(owner.zip, displayConfig.zip),
        addressMasked: maskValue(owner.address, displayConfig.address),
        // API住所（一般地名）は保存住所が生値レベルのときだけ提示（推測防止の保守的措置）。
        apiAddressLine: addressPlain ? cmp.matchedAddressLine : null,
        verdict: cmp.verdict,
        reason: cmp.reason,
      });
    }

    const summary = {
      total: rows.length,
      match: rows.filter((r) => r.verdict === "match").length,
      mismatch: rows.filter((r) => r.verdict === "mismatch").length,
      indeterminate: rows.filter((r) => r.verdict === "indeterminate").length,
    };

    // 4. 監査ログ。PII は記録しない（件数・サマリ・フラグのみ）。
    await writeAuditLog({
      userId: session.id,
      action: wantsCsv ? "postal_code_audit_csv_export" : "postal_code_audit_list",
      detail: {
        apiConfigured,
        truncated,
        maxTargets: POSTAL_AUDIT_MAX_TARGETS,
        summary,
      },
    });

    if (wantsCsv) {
      // CSV は不一致・判定不能の点検が主目的だが、全件を出す（一致も含め全件突合の証跡）。
      const sanitizedRows = rows.map((r) =>
        Object.fromEntries(
          Object.entries(buildPostalAuditCsvRow(r)).map(([k, v]) => [
            k,
            sanitizeCsvCellForExcel(v),
          ]),
        ),
      );
      const csv = encodeCsv([...POSTAL_AUDIT_CSV_HEADERS], sanitizedRows, { bom: true });
      const fileDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="postal_code_audit_${fileDate}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return apiResponse({
      apiConfigured,
      truncated,
      maxTargets: POSTAL_AUDIT_MAX_TARGETS,
      summary,
      rows,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
