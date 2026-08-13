import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  handleApiError,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission, maskValue } from "@/lib/permissions";
import { propertyListQuerySchema } from "@/lib/validators";
import {
  buildPropertyListWhere,
  buildPropertyListOrderBy,
  loadImportSourceMap,
} from "@/lib/property-list-query";
import {
  encodeCsv,
  sanitizeCsvCellForExcel,
  wrapCsvTextCell,
} from "@/lib/csv-encode";
import {
  PROPERTY_TYPE_LABELS,
  CASE_STATUS_LABELS,
  INTRODUCTION_ROUTE_LABELS,
  REGISTRY_STATUS_LABELS,
  DM_STATUS_LABELS,
} from "@/lib/property-types";
import { formatPostalCode, isValidPostalCode } from "@/lib/address-lookup/normalize";
import { selectGroupRepresentative, type DmRowPropertyOwner } from "@/lib/dm-export";
import { resolveExportColumns } from "@/lib/property-export-columns";

// 郵便番号を CSV セル用に整形する。
// 住所補完フローは 7 桁（ハイフン無し）で保存し得るため、妥当な 7 桁は NNN-NNNN へ整形して
// テキスト化し、Excel での数値化による先頭 0 欠落を防ぐ。7 桁として妥当でない値は素のまま
// 返す（勝手に変形しない）。null/空は空欄。formula injection 対策は後段の sanitize が担う。
function toPostalCodeCell(postalCode: string | null | undefined): string {
  if (!postalCode) return "";
  return isValidPostalCode(postalCode) ? formatPostalCode(postalCode) : postalCode;
}

// 地番（例: 4-2）・家屋番号（例: 1-2-3）は「数字＋ハイフン」のため Excel が CSV を開く際に
// 日付（4月2日 等）へ自動変換してしまう。Excel テキスト数式 `="<値>"` に包んでテキスト固定する
// （wrapCsvTextCell 参照）。空欄は空のまま・表記（桁/ハイフン）は変えない（郵便番号のような
// 整形はしない）。値全体が文字列リテラル化されるため formula injection も中和され、後段の
// sanitizeCsvCellForExcel（' 付与）はこの2列には重ねない（= 始まりに ' が付くと数式が壊れる）。
// 取込側は unwrapCsvTextCell で元値へ戻すため、出力→再取込の往復で元値に一致する。
const TEXT_FORCED_HEADERS: ReadonlySet<string> = new Set(["地番", "家屋番号"]);

// ---------- GET /api/properties/export ----------
//
// 物件一覧と同じ検索・フィルタ・sort・field_staff スコープで、条件一致の「全件」を
// CSV 出力する。1ページ分ではなく全件を返す点だけが一覧 API との違い。
//
// 安全上限: MAX_EXPORT_ROWS 件。超過時は切り捨てず 400 エラーにする
//（巨大エクスポートによる DoS / メモリ枯渇防止と、不完全な CSV を渡さないため）。
//
// PII / 権限:
//  - property:read 必須
//  - field_staff は一覧と同じスコープ（自分の作成/担当のみ）
//  - 所有者名は owner:read がある場合のみ、ownerDisplayConfig / maskValue に従って出力
//  - CSV 本文・所有者名・mgmtId 生値などの PII は AuditLog に保存しない

const MAX_EXPORT_ROWS = 10000;

// CSV 列の定義（安定英語キー↔日本語ヘッダ・列順）は property-export-columns.ts に集約。
// 行オブジェクトは全列の日本語ヘッダをキーに持たせ、出力時に選択列の部分集合で絞る。

function toCsvDateTime(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件一覧の閲覧権限がありません", "FORBIDDEN");
    }

    // CSV 出力は property:read とは別の専用権限を必須にする。
    //  - csv_export:read         : CSV エクスポート自体の許可（field_staff は不可）
    //  - csv_export_personal:read: 本 CSV は所有者名（個人情報）列を含むため必須（office_staff は不可）
    // owner:read は所有者名の表示/マスキング判断にのみ使い、出力権限の代替にはしない。
    // 権限不足時はここで 403 とし、DB 取得・CSV 生成・AuditLog 書き込みは一切行わない。
    if (!hasPermission(permissions, "csv_export", "read")) {
      throw new ApiError(403, "CSV エクスポートの権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "csv_export_personal", "read")) {
      throw new ApiError(
        403,
        "個人情報を含む CSV エクスポートの権限がありません",
        "FORBIDDEN",
      );
    }

    const hasOwnerRead = hasPermission(permissions, "owner", "read");
    const ownerDisplayConfig = hasOwnerRead
      ? await getOwnerDisplayConfig(session.id, permissions)
      : null;

    const { searchParams } = new URL(request.url);
    const queryObj: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      queryObj[key] = value;
    });

    // 出力項目選択（?columns=安定英語キー）。無指定=全列（後方互換）・既知キーのみ定義順に
    // 正規化・未知/空は無視・全て無効なら全列。認可は別途（案A: ルート全体で権限ゲート済み）。
    const selectedColumns = resolveExportColumns(searchParams.get("columns"));

    // page / limit は無視して全件出力するが、schema は共有のため parse はそのまま通す。
    const query = propertyListQuerySchema.parse(queryObj);

    // 一覧 API と同一の where / sort / field_staff スコープを共有ロジックで組み立てる。
    const { where, mgmtShortCircuitEmpty, mgmtHitCount, mgmtOverflowed, mgmtIdTrimmed } =
      await buildPropertyListWhere(query, session);

    // ⚠管理ID の一致が上限を超えて切り捨てられているときは、**最終行数が上限未満でも**
    // 出力しない (@codex #330 R2)。where は管理IDに加えて案件状況・DM状況・日付・
    // field_staff スコープを AND するため、切り捨てた id 側にだけ条件を満たす行が
    // あると、下の行数ガードが発火しないまま取りこぼした CSV が出てしまう。
    if (mgmtOverflowed) {
      throw new ApiError(
        400,
        "管理IDに一致する物件が多すぎます（上限10,000件）。管理IDをより具体的に指定するか、他の条件で絞り込んでください。",
        "EXPORT_LIMIT_EXCEEDED",
      );
    }

    const orderBy = buildPropertyListOrderBy(query);

    // 全件取得。安全上限 +1 件まで取り、超過していれば切り捨てずエラーにする。
    const properties = mgmtShortCircuitEmpty
      ? []
      : await prisma.property.findMany({
          where,
          select: {
            id: true,
            propertyType: true,
            address: true,
            lotNumber: true,
            buildingNumber: true,
            realEstateNumber: true,
            registryStatus: true,
            dmStatus: true,
            caseStatus: true,
            introductionRoute: true,
            updatedAt: true,
            createdAt: true,
            assignee: { select: { name: true } },
            // 郵便番号は代表所有者(selectGroupRepresentative)の Owner.zip から出す（非PII扱い）。
            // 所有者名(ownerNames)用の name と、代表選定用の isPrimary も同時取得する。
            propertyOwners: {
              select: { isPrimary: true, owner: { select: { name: true, zip: true } } },
              orderBy: { createdAt: "asc" },
            },
          },
          orderBy,
          take: MAX_EXPORT_ROWS + 1,
        });

    if (properties.length > MAX_EXPORT_ROWS) {
      throw new ApiError(
        400,
        `出力対象が上限（${MAX_EXPORT_ROWS.toLocaleString()}件）を超えています。検索条件で絞り込んでください。`,
        "EXPORT_LIMIT_EXCEEDED",
      );
    }

    // 取込元（管理ID）を一括逆引き（一覧 API と共有・N+1 回避）。
    const importSourceMap = await loadImportSourceMap(
      prisma,
      properties.map((p) => p.id),
    );

    const rows = properties.map((p) => {
      // 所有者名は一覧 API と同じく owner:read + ownerDisplayConfig + maskValue に従う。
      const ownerNames =
        hasOwnerRead && ownerDisplayConfig
          ? p.propertyOwners
              .map(({ owner }) => maskValue(owner.name, ownerDisplayConfig.name))
              .filter((n): n is string => n !== null)
          : [];

      // 郵便番号 = 代表所有者(primary 優先・無ければ createdAt 昇順の先頭)の Owner.zip。
      // 非PII扱い: owner:read ゲート無し・マスク非経由・NNN-NNNN 整形のみ。
      // selectGroupRepresentative(#169) を再利用するため DmRowPropertyOwner 形へ写像する
      //（同関数は isPrimary のみ参照。未使用フィールドは null で埋める＝余分取得なし）。
      const repCandidates: DmRowPropertyOwner[] = p.propertyOwners.map((po) => ({
        isPrimary: po.isPrimary,
        relationship: null,
        owner: {
          name: po.owner.name,
          nameKana: null,
          zip: po.owner.zip,
          address: null,
          corporateNumber: null,
        },
      }));
      const representativeZip =
        repCandidates.length > 0
          ? selectGroupRepresentative(repCandidates).owner.zip
          : null;

      return {
        管理ID: importSourceMap.get(p.id) ?? "",
        物件種別: PROPERTY_TYPE_LABELS[p.propertyType] ?? p.propertyType,
        住所: p.address ?? "",
        // 地番・家屋番号は Excel の日付自動変換を防ぐためテキスト数式 `="<値>"` で固定する
        //（空欄は空のまま）。再取込時は import 側が unwrap して元値へ戻す。
        地番: wrapCsvTextCell(p.lotNumber),
        家屋番号: wrapCsvTextCell(p.buildingNumber),
        不動産番号: p.realEstateNumber ?? "",
        登記状況:
          REGISTRY_STATUS_LABELS[p.registryStatus] ?? p.registryStatus,
        DM判断: DM_STATUS_LABELS[p.dmStatus] ?? p.dmStatus,
        案件ステータス: CASE_STATUS_LABELS[p.caseStatus] ?? p.caseStatus,
        導入ルート: p.introductionRoute
          ? INTRODUCTION_ROUTE_LABELS[p.introductionRoute] ?? p.introductionRoute
          : "",
        担当者名: p.assignee?.name ?? "",
        所有者名: ownerNames.join("、"),
        更新日時: toCsvDateTime(p.updatedAt),
        作成日時: toCsvDateTime(p.createdAt),
        // 代表所有者の Owner.zip（非PII扱い）。妥当な 7 桁は NNN-NNNN へテキスト化
        //（Excel の先頭 0 欠落対策）・null/未保有は空欄。
        郵便番号: toPostalCodeCell(representativeZip),
      };
    });

    // CSV formula injection 対策: 外部入力・DB 由来の全セル値を encodeCsv に渡す前に
    // 無害化する（先頭が = + - @ tab CR のセルに ' を付与）。RFC quoting は encodeCsv 側。
    //
    // ただし地番・家屋番号（TEXT_FORCED_HEADERS）は既に wrapCsvTextCell で `="<値>"` に
    // テキスト固定済み。これは値全体を文字列リテラル化するため formula injection は中和済みで、
    // ここで sanitize を重ねると先頭 `=` に `'` が付いて Excel 数式が壊れる（テキスト固定が無効化）。
    // よってこの2列は sanitize をスキップし、wrap 済みの値をそのまま使う。
    const sanitizedRows = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          TEXT_FORCED_HEADERS.has(key) ? value : sanitizeCsvCellForExcel(value),
        ]),
      ),
    );

    // UTF-8 BOM + CRLF（既存 encodeCsv の既定挙動）で Excel 互換に出力。
    // 出力列は ?columns= の選択（無指定=全列）。encodeCsv は headers のキーで行から
    // 値を引くため、行オブジェクトは全列を持たせたまま headers の部分集合で列を絞る。
    const csv = encodeCsv(
      selectedColumns.map((c) => c.header),
      sanitizedRows,
      { bom: true },
    );

    // AuditLog は操作事実のみ。CSV 本文・所有者名などの PII は残さない。
    // filters は raw query の rest ではなく、parse 済み query からの明示 allowlist で組む。
    // これにより token / apiKey / password / secret 等の任意 query が混入しない。
    //  - mgmtId : 取込元ファイル名・行番号を含む生値のため除外（長さと hit 件数のみ記録）
    //  - keyword: address / lotNumber 等を検索する語で住所等 PII を含み得るため除外
    //  - page / limit: 全件出力では無意味なページング値のため除外
    const AUDIT_FILTER_KEYS = [
      "propertyType",
      "registryStatus",
      "dmStatus",
      "caseStatus",
      "introductionRoute",
      "assignedTo",
      "updatedFrom",
      "updatedTo",
      "includeArchived",
      "hasWarning",
      "dmSentMax",
      // 再送候補で絞った出力かを監査にも残す(非PIIのフラグ)。画面のCSVボタンは
      // buildFilterParams をそのまま渡すので、ここに無いと**絞ったのに絞っていない
      // 出力と区別できない**監査ログになる(@codex #374 R3・PR-C)。
      "resendOnly",
      "sortBy",
      "sortOrder",
    ] as const;
    const filtersForLog: Record<string, unknown> = {};
    for (const key of AUDIT_FILTER_KEYS) {
      const value = query[key];
      if (value !== undefined) filtersForLog[key] = value;
    }
    await writeAuditLog({
      userId: session.id,
      action: "property_csv_export",
      targetTable: "properties",
      detail: {
        filters: filtersForLog,
        resultCount: rows.length,
        exportedAt: new Date().toISOString(),
        ...(mgmtIdTrimmed
          ? { mgmtIdLen: mgmtIdTrimmed.length, mgmtHitCount }
          : {}),
      },
    });

    const fileDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="properties_${fileDate}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
