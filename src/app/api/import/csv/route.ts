import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import {
  PROPERTY_CSV_COLUMN_MAP,
  POSTAL_CODE_HEADERS,
  BUILDING_POSTAL_CODE_HEADERS,
} from "@/lib/csv-parser";
import { parseSheet, SheetParseError } from "@/lib/sheet-parser";
import {
  recordChanges,
  recordChangesInTx,
  PROPERTY_TRACKED_FIELDS,
  BUILDING_TRACKED_FIELDS,
} from "@/lib/change-log";
import {
  PROPERTY_TYPE_VALUES,
  PROPERTY_TYPE_JP_TO_VALUE,
  CASE_STATUS_VALUES,
  normalizeCaseStatusInput,
  normalizeIntroductionRouteInput,
} from "@/lib/property-types";
import {
  buildDedupeIndex,
  addToDedupeIndex,
  findPropertyDuplicate,
  isUpdateEligibleReason,
  UPDATABLE_PROPERTY_FIELDS,
  type UpdatablePropertyField,
} from "@/lib/import-dedupe";
import { normalizeBuildingName } from "@/lib/property-building-name";
import { RESTORABLE_BUILDING_LINK_FIELDS } from "@/lib/import-rollback";
import {
  planDuplicateBuildingLink,
  resolveCsvBuilding,
  type CsvBuildingResolution,
} from "@/lib/building-link/csv-resolve";
import { AUTO_CHOICE, BUILDING_LINK_TARGET_TYPE, type BuildingChoice } from "@/lib/building-link/resolve";
import {
  applyBuildingLink,
  writeBuildingLinkAudit,
  type BuildingLinkOutcome,
} from "@/lib/building-link/apply";
import {
  normalizePostalCode,
  isValidPostalCode,
} from "@/lib/address-lookup/normalize";
import {
  REIMPORT_IGNORED_HEADERS,
  buildErrorRawDataExtras,
} from "@/lib/import-error-display";
import { unwrapCsvTextCell } from "@/lib/csv-encode";
import { assertImportJsonBodySize } from "@/lib/import-body-size";

const VALID_PROPERTY_TYPES: readonly string[] = PROPERTY_TYPE_VALUES;
const VALID_REGISTRY_STATUS = ["unconfirmed", "scheduled", "obtained"];
const VALID_DM_STATUS = ["send", "hold", "no_send"];
const VALID_OCCUPANCY_STATUS = ["vacant", "occupied", "unknown"];

/** Map Japanese target field names to property field names. */
const JAPANESE_FIELD_MAP: Record<string, string> = {
  "住所": "address",
  "郵便番号": "postalCode",
  "棟郵便番号": "buildingPostalCode",
  "地番": "lotNumber",
  "家屋番号": "buildingNumber",
  "不動産番号": "realEstateNumber",
  "種別": "propertyType",
  "登記状況": "registryStatus",
  "DM判断": "dmStatus",
  "案件ステータス": "caseStatus",
  "導入ルート": "introductionRoute",
  "流入経路": "introductionRoute",
  "獲得経路": "introductionRoute",
  "用途地域": "zoningDistrict",
  "路線価": "rosenkaValue",
  "緯度": "gpsLat",
  "経度": "gpsLng",
  "備考": "note",
  "リンクキー": "externalLinkKey",
  // Unit-specific
  "棟名": "buildingName",
  "マンション名": "buildingName",
  "部屋番号": "roomNo",
  "号室": "roomNo",
  "階": "floorNo",
  "階数": "floorNo",
  "専有面積": "exclusiveArea",
  "バルコニー面積": "balconyArea",
  "間取り": "layoutType",
  "向き": "orientation",
  "管理費": "managementFee",
  "修繕積立金": "repairReserveFee",
  "入居状況": "occupancyStatus",
  "持分備考": "ownershipShareNote",
};

/**
 * 解決済みの棟へ郵便番号（正規化済み・妥当 7 桁）を適用する。
 *
 * - 1 取込あたり棟ごとに 1 回だけ適用（`applied` Set・first-wins）。同一棟の複数ユニット行で
 *   重複 update しない。
 * - 既存値と異なる時のみ update し、building の ChangeLog（source=csv_import）を記録する。
 * - 空欄/不正値は呼び出し側で既に drop 済みのため、本関数には妥当値のみ渡る
 *   （= 空欄で既存値を潰さない）。
 */
async function applyBuildingPostalCode(
  buildingId: string,
  normalizedPostalCode: string,
  changedBy: string,
  applied: Set<string>,
): Promise<void> {
  if (applied.has(buildingId)) return;
  applied.add(buildingId);

  const building = await prisma.building.findUnique({
    where: { id: buildingId },
    select: { postalCode: true },
  });
  const prev = building?.postalCode ?? null;
  if (prev === normalizedPostalCode) return; // 変化なし

  await prisma.building.update({
    where: { id: buildingId },
    data: { postalCode: normalizedPostalCode },
  });
  await recordChanges({
    targetTable: "buildings",
    targetId: buildingId,
    changedBy,
    oldValues: { postalCode: prev },
    newValues: { postalCode: normalizedPostalCode },
    trackedFields: BUILDING_TRACKED_FIELDS,
    source: "csv_import",
  });
}

// ---------- POST /api/import/csv ----------
// Accepts raw CSV text in request body (Content-Type: text/csv or multipart).
// For simplicity in Phase 3, accepts JSON { fileName, csvText }.

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "CSV取込の権限がありません", "FORBIDDEN");
    }

    // body 全体をバッファする前に過大サイズを弾く(2026-08-02 監査: PDF 経路と姿勢を揃える)。


    assertImportJsonBodySize(request);


    const body = await request.json();
    const { fileName, csvText, xlsxBase64, columnMapping } = body as {
      fileName?: string;
      csvText?: string;
      xlsxBase64?: string;
      columnMapping?: Record<string, string>;
    };

    if (!fileName) {
      throw new ApiError(422, "fileName は必須です", "VALIDATION_ERROR");
    }
    if (!csvText && !xlsxBase64) {
      throw new ApiError(422, "csvText または xlsxBase64 は必須です", "VALIDATION_ERROR");
    }

    // XLSX 取込時、郵便番号系の列だけ整形済みテキスト（.w）で読むためのヘッダ集合。
    // 固定トークン（郵便番号/postalCode/postal_code・棟郵便番号/buildingPostalCode/
    // building_postal_code）＋ columnMapping で postalCode/buildingPostalCode に割り当てた
    // CSV ヘッダ。CSV には影響しない（parseSheet 側で xlsx のみ使用）。
    const postalFormattedHeaders = new Set<string>([
      ...POSTAL_CODE_HEADERS,
      ...BUILDING_POSTAL_CODE_HEADERS,
    ]);
    if (columnMapping) {
      for (const [csvHeader, japaneseName] of Object.entries(columnMapping)) {
        const field = JAPANESE_FIELD_MAP[japaneseName];
        if (field === "postalCode" || field === "buildingPostalCode") {
          postalFormattedHeaders.add(csvHeader);
        }
      }
    }

    // Parse CSV or XLSX (unified)
    let headers: string[];
    let rows: Record<string, string>[];
    let parseErrors: Array<{ row: number; message: string }>;
    try {
      const parsed = parseSheet({
        fileName,
        csvText,
        xlsxBase64,
        formattedTextHeaders: postalFormattedHeaders,
      });
      headers = parsed.headers;
      rows = parsed.rows;
      parseErrors = parsed.errors;
    } catch (e) {
      if (e instanceof SheetParseError) {
        throw new ApiError(422, e.message, e.code);
      }
      throw e;
    }

    if (rows.length === 0 && parseErrors.length > 0) {
      throw new ApiError(422, "ファイルのパースに失敗しました", "VALIDATION_ERROR");
    }

    // Build a lookup: csvHeader → property field name.
    // When columnMapping is provided (keys = CSV headers, values = Japanese field names),
    // convert Japanese names to property field names via JAPANESE_FIELD_MAP.
    // Otherwise fall back to auto-mapping via PROPERTY_CSV_COLUMN_MAP.
    const headerToField: Record<string, string> = {};
    if (columnMapping && Object.keys(columnMapping).length > 0) {
      for (const [csvHeader, japaneseName] of Object.entries(columnMapping)) {
        // 再取込時に export-errors の固定列が混ざっていても完全に無視する
        // （warning も出さない）。__error_field 等は __ プレフィックスなので
        // 既存の rawData ループで自然に除外されるため別途対処不要。
        if (REIMPORT_IGNORED_HEADERS.has(csvHeader)) continue;
        const field = JAPANESE_FIELD_MAP[japaneseName];
        if (field) {
          headerToField[csvHeader] = field;
        }
      }
    } else {
      for (const h of headers) {
        if (REIMPORT_IGNORED_HEADERS.has(h)) continue;
        if (PROPERTY_CSV_COLUMN_MAP[h]) {
          headerToField[h] = PROPERTY_CSV_COLUMN_MAP[h];
        }
      }
    }

    // Check that address field is mapped
    const hasAddressMapping = Object.values(headerToField).includes("address");
    if (!hasAddressMapping) {
      throw new ApiError(
        422,
        "必須カラム「住所」(address)がCSVヘッダーに見つかりません",
        "VALIDATION_ERROR",
      );
    }

    // Create import job
    const job = await prisma.importJob.create({
      data: {
        jobType: "property_csv",
        fileName: fileName ?? "import.csv",
        status: "processing",
        totalRows: rows.length,
        executedBy: session.id,
        startedAt: new Date(),
      },
    });

    let successCount = 0;
    let updateCount = 0;
    let errorCount = 0;
    const jobRows: Array<{
      jobId: string;
      rowNumber: number;
      status: "success" | "error" | "needs_review";
      rawData: Record<string, string>;
      errorMessage: string | null;
      createdId: string | null;
    }> = [];

    // Building name lookup cache for unit imports
    // ⚠「作る」の結果は覚えない(resolveCsvBuilding 側)=次の行は前の行が作った棟を見つける。
    const buildingCache = new Map<string, CsvBuildingResolution>();
    // 棟郵便番号を適用済みの buildingId（1 取込あたり棟ごとに 1 回・first-wins）
    const buildingPostalApplied = new Set<string>();

    // Build normalized dedupe index once (address / unit roomNo / identifier fallback)
    const existingPropsForDedupe = await prisma.property.findMany({
      select: {
        id: true,
        address: true,
        roomNo: true,
        buildingId: true,
        realEstateNumber: true,
        externalLinkKey: true,
      },
    });
    // ⚠**externalLinkKey は正規化しない**(@codex PR#414 23巡目・17〜22巡目の全撤回)。
    //   src/lib/import-dedupe.ts の明文の契約:
    //     「識別子 (realEstateNumber / externalLinkKey) は正規化せず raw 比較
    //       （DB 側 exact を想定）」
    //   CSV のリンクキーは**顧客の管理コード**で、幅の違いに意味があり得る。
    //   さらに `externalLinkKey一致` は**更新対象(update-eligible)の判定理由**なので、
    //   正規化して「一致」と判定した瞬間、`顧客ー001` と `顧客-001` を意図的に
    //   別キーとして使う運用では**別の物件のフィールドが上書きされ得る**。
    //   「幅の違い=同じ」は、自機能が発行して正規形を定義できる査定ナンバー
    //   (paste-import)にしか成立しない。他機能の鍵の意味論を変えない。
    const dedupeIndex = buildDedupeIndex(existingPropsForDedupe);

    for (let i = 0; i < rows.length; i++) {
      const rawRow = rows[i];
      const rowNumber = i + 2; // 1-indexed, header is row 1

      try {
        // Map CSV columns to property fields
        const mapped: Record<string, string> = {};
        for (const [csvCol, value] of Object.entries(rawRow)) {
          const field = headerToField[csvCol];
          if (field) {
            mapped[field] = value;
          }
        }

        // 地番・家屋番号: 本システムが出力した CSV は Excel 日付化対策で `="<値>"`（テキスト
        // 数式）で固定されている。再取込時はこの数式を unwrap して元値に戻す（出力→再取込の
        // 往復一致）。手入力 / 外部 CSV の生値（4-2 等）は unwrap 対象外でそのまま通る。
        // 表記そのもの（桁/ハイフン）は変えない＝既存の取込仕様は不変。
        if (mapped.lotNumber !== undefined) {
          mapped.lotNumber = unwrapCsvTextCell(mapped.lotNumber);
        }
        if (mapped.buildingNumber !== undefined) {
          mapped.buildingNumber = unwrapCsvTextCell(mapped.buildingNumber);
        }

        // 外部キー(リンクキー)は **trim だけ**。**保存でも比較でも変換しない**
        // (@codex PR#414 23巡目・17〜22巡目に入れた CSV の正規化を全撤回)。
        // ⚠リンクキーは**利用者が付ける任意の管理コード**であり、
        //   物件CSVと所有者CSVは `externalLinkKey` の**生値の完全一致**で紐付く
        //   (src/lib/owner-property-linker.ts)。所有者CSV側は `.trim()` のみで
        //   保存している(owner-csv/route.ts)ので、物件側だけ正規化すると
        //   `顧客ー001`(長音符)のような鍵が `顧客-001` に変わり、
        //   **紐付けが壊れる**。保存は書式を尊重する。
        // ⚠**比較でも正規化しない**(23巡目)。import-dedupe.ts の明文の契約
        //   「識別子 (realEstateNumber / externalLinkKey) は正規化せず raw 比較」
        //   に従う。`externalLinkKey一致` は**更新対象**の判定理由なので、
        //   正規化して一致にすると、別キー運用の物件を上書きへ誘導してしまう。
        if (mapped.externalLinkKey !== undefined) {
          const trimmed = mapped.externalLinkKey.trim();
          if (trimmed === "") {
            delete mapped.externalLinkKey;
          } else {
            mapped.externalLinkKey = trimmed;
          }
        }

        // Validate required field
        if (!mapped.address) {
          jobRows.push({
            jobId: job.id,
            rowNumber,
            status: "error",
            rawData: rawRow,
            errorMessage: "住所が空です",
            createdId: null,
          });
          errorCount++;
          continue;
        }

        // Validate / normalize propertyType
        // 1. 日本語ラベルを enum 値に変換（例: "土地" → "land"）
        // 2. 不明な値は "unknown" にフォールバック
        if (mapped.propertyType) {
          const jpMapped = PROPERTY_TYPE_JP_TO_VALUE[mapped.propertyType];
          if (jpMapped) {
            mapped.propertyType = jpMapped;
          } else if (!VALID_PROPERTY_TYPES.includes(mapped.propertyType)) {
            mapped.propertyType = "unknown";
          }
        }
        if (
          mapped.registryStatus &&
          !VALID_REGISTRY_STATUS.includes(mapped.registryStatus)
        ) {
          delete mapped.registryStatus;
        }
        if (mapped.dmStatus && !VALID_DM_STATUS.includes(mapped.dmStatus)) {
          delete mapped.dmStatus;
        }
        if (mapped.caseStatus) {
          const normalized = normalizeCaseStatusInput(mapped.caseStatus);
          if (normalized) {
            mapped.caseStatus = normalized;
          } else {
            delete mapped.caseStatus;
          }
        }
        if (mapped.introductionRoute) {
          const normalized = normalizeIntroductionRouteInput(mapped.introductionRoute);
          if (normalized) {
            mapped.introductionRoute = normalized;
          } else {
            delete mapped.introductionRoute;
          }
        }
        if (
          mapped.occupancyStatus &&
          !VALID_OCCUPANCY_STATUS.includes(mapped.occupancyStatus)
        ) {
          delete mapped.occupancyStatus;
        }
        // 郵便番号: 妥当な 7 桁はハイフン無しへ正規化（先頭 0 保持・全角/ハイフン吸収）。
        // 不正値は enum 不正値と同じく drop（raw 保存しない・行自体は失敗にしない）。
        //
        // 既知の制限（XLSX 数値セル）: .xlsx で郵便番号セルが「数値」として保存され、
        // 先頭 0 を含む 7 桁が表示上 0100492・実値 100492 のような場合、parseSheet の
        // raw 読み取り（指数表記回避のため意図的に raw:true）でこの段階には "100492" が
        // 届き、6 桁ゆえ不正として drop される。ここで 6→7 桁へ左 0 詰めする復元は採らない
        // （誤入力 "123456" を正当な別コードに化けさせ DM 誤送につながるため、fail-closed で
        // 落とす方が安全）。恒久対応は sheet-parser 側で郵便番号列の整形済みテキストを保持する
        // 別 PR（全 import 共有の parser 改変を伴うため本 PR スコープ外）。ハイフン付き
        // テキストセル（010-0492）や CSV は本パスで正しく取り込める。
        if (mapped.postalCode !== undefined) {
          if (isValidPostalCode(mapped.postalCode)) {
            mapped.postalCode = normalizePostalCode(mapped.postalCode);
          } else {
            delete mapped.postalCode;
          }
        }
        // 棟郵便番号（Building.postalCode 用・Property.postalCode とは別ヘッダ）も同方針で
        // 正規化/不正値 drop。適用は物件が実際につながった棟へ（commitBuildingPostalCode）のみ。
        if (mapped.buildingPostalCode !== undefined) {
          if (isValidPostalCode(mapped.buildingPostalCode)) {
            mapped.buildingPostalCode = normalizePostalCode(mapped.buildingPostalCode);
          } else {
            delete mapped.buildingPostalCode;
          }
        }

        // -----------------------------------------------------------
        // Unit / building name resolution
        // -----------------------------------------------------------
        // 旧値 "unit" / 新値 "apartment_unit" / buildingName あり をすべて区分扱い
        const isUnit =
          mapped.propertyType === "apartment_unit" ||
          mapped.propertyType === "unit" ||
          !!mapped.buildingName;
        let resolvedBuildingId: string | null = null;
        let buildingChoiceForRow: BuildingChoice | null = null;

        if (isUnit && mapped.buildingName) {
          // 新規取込は正式値 apartment_unit に統一（旧 unit は出力しない）
          mapped.propertyType = "apartment_unit";

          // 同じ町丁目・同じ比べる形の棟だけ自動でつなぐ。紛らわしい候補があれば要確認、
          // 何も無ければ物件を作るトランザクションの中で棟を作る(設計 2026-10-04 §4.4)。
          const resolution = await resolveCsvBuilding(prisma, mapped.buildingName.trim(), mapped.address, buildingCache);
          if (resolution.kind === "review") {
            const enrichedRawRow = { ...rawRow };
            enrichedRawRow["__building_candidates"] = JSON.stringify(resolution.candidates);
            jobRows.push({
              jobId: job.id, rowNumber, status: "needs_review", rawData: enrichedRawRow,
              errorMessage: resolution.error, createdId: null,
            });
            continue;
          }
          resolvedBuildingId = resolution.kind === "link" ? resolution.buildingId : null;
          buildingChoiceForRow = resolution.kind === "link"
            ? { kind: "existing", buildingId: resolution.buildingId }
            : AUTO_CHOICE;
        }

        // 棟郵便番号は「行が物件 create/update として成功した時のみ」棟へ適用する
        // （needs_review や create/update 失敗の行ではマスター Building を変更しない）。
        // ⚠書く先は**この行の後に物件が実際につながっている棟**(@codex P2・2026-10-05)。解決した棟
        //   (resolvedBuildingId)ではない: 同じ名前・同じ町丁目の棟が2つあると、解決は B1 を選んでも
        //   部屋は B2 につながったまま(付け替えない)ことがある。棟の解決が無い行(非ユニット/棟名なし)は書かない。
        const commitBuildingPostalCode = async (finalBuildingId: string | null) => {
          if (buildingChoiceForRow && finalBuildingId && mapped.buildingPostalCode) {
            await applyBuildingPostalCode(
              finalBuildingId,
              mapped.buildingPostalCode,
              session.id,
              buildingPostalApplied,
            );
          }
        };

        // -----------------------------------------------------------
        // Duplicate check (比較用値ベース / 正規化比較)
        // -----------------------------------------------------------
        const dupHit = findPropertyDuplicate(
          dedupeIndex,
          {
            address: mapped.address,
            roomNo: mapped.roomNo,
            buildingId: resolvedBuildingId,
            realEstateNumber: mapped.realEstateNumber,
            // ⚠**生値で比較する**(23巡目)。import-dedupe.ts の契約
            //   「識別子は正規化せず raw 比較」に従う。
            externalLinkKey: mapped.externalLinkKey,
          },
          existingPropsForDedupe,
        );

        if (dupHit) {
          // 住所のみ一致など取り違えリスクのある理由はレビューへ
          if (!isUpdateEligibleReason(dupHit.reason)) {
            jobRows.push({
              jobId: job.id,
              rowNumber,
              status: "needs_review",
              rawData: rawRow,
              errorMessage: `重複の可能性[${dupHit.reason}]: 既存物件ID=${dupHit.matchedId} (${dupHit.matchedAddress})`,
              createdId: null,
            });
            continue;
          }

          // UPDATABLE_PROPERTY_FIELDS ∩ (CSV に非空で入っている項目) のみ更新
          // 空の値でマスター側を潰さないよう、空・undefined は含めない
          const updateData: Record<string, unknown> = {};
          const numericFields = new Set<UpdatablePropertyField>([
            "rosenkaValue",
            "gpsLat",
            "gpsLng",
            "exclusiveArea",
            "balconyArea",
          ]);
          const intFields = new Set<UpdatablePropertyField>([
            "floorNo",
            "managementFee",
            "repairReserveFee",
          ]);
          const trimFields = new Set<UpdatablePropertyField>([
            "layoutType",
            "orientation",
          ]);

          for (const field of UPDATABLE_PROPERTY_FIELDS) {
            const raw = mapped[field];
            if (raw === undefined || raw === null || raw === "") continue;
            if (numericFields.has(field)) {
              const n = parseFloat(raw);
              if (!Number.isNaN(n)) updateData[field] = n;
            } else if (intFields.has(field)) {
              const n = parseInt(raw);
              if (!Number.isNaN(n)) updateData[field] = n;
            } else if (trimFields.has(field)) {
              const v = raw.trim();
              if (v) updateData[field] = v;
            } else {
              updateData[field] = raw;
            }
          }

          // 実際に値が変わる項目だけに絞る
          const existing = await prisma.property.findUnique({
            where: { id: dupHit.matchedId },
          });
          const changedFields: string[] = [];
          const finalUpdateData: Record<string, unknown> = {};
          if (existing) {
            for (const [k, v] of Object.entries(updateData)) {
              const prev = (existing as unknown as Record<string, unknown>)[k];
              const prevStr = prev == null ? null : String(prev);
              const nextStr = v == null ? null : String(v);
              if (prevStr !== nextStr) {
                finalUpdateData[k] = v;
                changedFields.push(k);
              }
            }
          }

          // 区分の棟: 重複(既存物件の更新)でも CSV の棟の解決を捨てない(@codex P2・2026-10-05)。
          //   棟の無い部屋はつなぎ、つながった部屋は棟名が比べる形で変わったときだけ解決どおりにする
          //   (planDuplicateBuildingLink)。要確認の行は上で needs_review に回っていてここへ来ない。
          const csvBuildingName = buildingChoiceForRow
            ? normalizeBuildingName(BUILDING_LINK_TARGET_TYPE, mapped.buildingName)
            : null;
          const planLink = (cur: { propertyType: string; buildingId: string | null; buildingName: string | null }) =>
            csvBuildingName
              ? planDuplicateBuildingLink({ existing: cur, choice: buildingChoiceForRow, buildingName: csvBuildingName })
              : null;
          const linkChoice = existing ? planLink(existing) : null;

          if (!existing || (changedFields.length === 0 && linkChoice === null)) {
            // 既存値と完全一致 → 変更なし。success 扱いで「更新なし」を伝える
            // 棟は付け替えないので、今つながっている棟へ。
            await commitBuildingPostalCode(existing?.buildingId ?? null);
            jobRows.push({
              jobId: job.id,
              rowNumber,
              status: "success",
              rawData: rawRow,
              errorMessage: `更新[${dupHit.reason}]: 既存物件ID=${dupHit.matchedId} (更新項目: なし)`,
              createdId: dupHit.matchedId,
            });
            updateCount++;
            successCount++;
            continue;
          }

          // ⚠**謄本の自動取得(scheduled)中の物件は書き換えない**(@codex #394 R27 P1)。
          //   取得は所在・地番を鍵にサイトから書類を選ぶ。取得中にここが書き換わると、
          //   選んだ書類が**別の対象になった物件**へ添付され、所有者の紐付けまで変わる。
          //   scheduled との競合は version ではなく registryStatus を where の条件に
          //   して弾き、行エラーとして報告する(取得後に再実行できる)。
          // ⚠**version は必ず進める**(Task 9): finalUpdateData は編集画面で変えられる
          //   項目(UPDATABLE_PROPERTY_FIELDS)を書くため、進めないと編集画面を開いていた
          //   人の保存がこの取込の変更を黙って上書きする(Task 7 が謄本取込の法人番号で
          //   直したのと同じ穴)。棟だけをつなぐ行(他の項目は変わらない)もこの更新で版番号を進める
          //   (既存物件の buildingId/buildingName を書くときは必ず同じトランザクションで版番号を進める)。
          // ⚠ロック順: 物件の行(この更新)→ applyBuildingLink のアドバイザリロック(他の保存と同じ)。
          const txResult = await prisma.$transaction(async (tx) => {
            const guarded = await tx.property.updateMany({
              where: {
                id: dupHit.matchedId,
                registryStatus: { not: "scheduled" },
              },
              data: {
                ...(finalUpdateData as Parameters<
                  typeof prisma.property.update
                >[0]["data"]),
                version: { increment: 1 },
              },
            });
            if (guarded.count === 0) return null;
            // 行を押さえた後の値で決め直す(取込の外で棟が変わっていればそれに従う)。
            const before = await tx.property.findUniqueOrThrow({ where: { id: dupHit.matchedId } });
            const choice = planLink(before);
            const buildingLink: BuildingLinkOutcome | null =
              choice && csvBuildingName
                ? await applyBuildingLink(tx, {
                    propertyId: before.id,
                    propertyType: before.propertyType,
                    buildingName: csvBuildingName,
                    address: before.address,
                    buildingNumber: before.buildingNumber,
                    choice,
                    currentBuildingId: before.buildingId,
                    userId: session.id,
                    importJobId: job.id,
                  })
                : null;
            const updated = await tx.property.findUniqueOrThrow({ where: { id: dupHit.matchedId } });
            // 棟が変わった/物件名を棟の表記にそろえたことも変更ログに残す(前の値は行を押さえた後に読んだもの)。
            const buildingNewValues: Record<string, unknown> = {};
            if ((updated.buildingId ?? null) !== (before.buildingId ?? null)) {
              buildingNewValues.buildingId = updated.buildingId ?? null;
            }
            if ((updated.buildingName ?? null) !== (before.buildingName ?? null)) {
              buildingNewValues.buildingName = updated.buildingName ?? null;
            }
            // ⚠変更ログ(csv_import)は**この tx の中で**書く(@codex P2・2026-10-06)。取込の取り消しは
            //   これを見て項目・棟・物件名を前の値へ戻す(import-rollback.ts の RESTORABLE_BUILDING_LINK_FIELDS)。
            //   握りつぶし型の recordChanges を tx の後で呼ぶと、書けなくても取込は成功し、取り消しが
            //   skip_no_changelog で戻せなくなる。書けなければ更新もつなぎも巻き戻り、行はエラーになる。
            await recordChangesInTx(tx, {
              targetTable: "properties",
              targetId: updated.id,
              changedBy: session.id,
              oldValues: {
                ...(existing as unknown as Record<string, unknown>),
                buildingId: before.buildingId ?? null,
                buildingName: before.buildingName ?? null,
              },
              newValues: { ...finalUpdateData, ...buildingNewValues },
              trackedFields: [...PROPERTY_TRACKED_FIELDS, ...RESTORABLE_BUILDING_LINK_FIELDS],
              source: "csv_import",
            });
            return { updated, buildingLink, buildingChangedFields: Object.keys(buildingNewValues) };
          });
          if (txResult === null) {
            // ⚠エラー行では建物の郵便番号も反映しない(@codex #394 R28 P2)。
            //   「成功した行だけがマスタを更新する」という近くの契約に合わせる
            //   (失敗と報告した行が裏で建物を書き換えるのは不意打ち)。
            jobRows.push({
              jobId: job.id,
              rowNumber,
              status: "error",
              rawData: rawRow,
              errorMessage: `更新スキップ[${dupHit.reason}]: 既存物件ID=${dupHit.matchedId} は謄本の自動取得の処理中です。完了後にこの行だけ再取込してください`,
              createdId: dupHit.matchedId,
            });
            errorCount++;
            continue;
          }
          const { updated, buildingLink, buildingChangedFields } = txResult;
          if (buildingLink) {
            await writeBuildingLinkAudit(session.id, updated.id, buildingLink, { importJobId: job.id });
          }
          // 棟が変わった/物件名を棟の表記にそろえたことも「更新項目」に出す(id とフィールド名だけ)。
          //   変更ログは上の tx の中で書き済み。
          changedFields.push(...buildingChangedFields);

          // dedupe index も住所変更などに備えて反映
          const updatedRecord = {
            id: updated.id,
            address: updated.address,
            roomNo: updated.roomNo ?? null,
            buildingId: updated.buildingId ?? null,
            realEstateNumber: updated.realEstateNumber ?? null,
            externalLinkKey: updated.externalLinkKey ?? null,
          };
          addToDedupeIndex(dedupeIndex, updatedRecord);
          const idxInAll = existingPropsForDedupe.findIndex(
            (p) => p.id === updated.id,
          );
          if (idxInAll >= 0) existingPropsForDedupe[idxInAll] = updatedRecord;

          // 棟郵便番号は、行を押さえた後に読み直した物件が実際につながっている棟へ(付け替えた/しなかった両方)。
          await commitBuildingPostalCode(updated.buildingId ?? null);
          jobRows.push({
            jobId: job.id,
            rowNumber,
            status: "success",
            rawData: rawRow,
            errorMessage: `更新[${dupHit.reason}]: 既存物件ID=${updated.id} (更新項目: ${changedFields.join(", ")})`,
            createdId: updated.id,
          });
          updateCount++;
          successCount++;
          continue;
        }

        // -----------------------------------------------------------
        // Build create data
        // -----------------------------------------------------------
        const createData: Record<string, unknown> = {
          address: mapped.address,
          propertyType: mapped.propertyType || "unknown",
          registryStatus: mapped.registryStatus || "unconfirmed",
          dmStatus: mapped.dmStatus || "hold",
          caseStatus: mapped.caseStatus || "new_case",
          createdBy: session.id,
        };

        // Standard fields
        // 郵便番号は上流で正規化済み（妥当 7 桁のみ残る）。空欄は未設定（null 上書きしない）。
        if (mapped.postalCode) createData.postalCode = mapped.postalCode;
        if (mapped.lotNumber) createData.lotNumber = mapped.lotNumber;
        if (mapped.buildingNumber)
          createData.buildingNumber = mapped.buildingNumber;
        if (mapped.realEstateNumber)
          createData.realEstateNumber = mapped.realEstateNumber;
        // ⚠外部キーは**生値(trim済み)のまま保存する**(22巡目)。
        //   所有者CSVとの生値完全一致リンクを壊さないため、ここで正規化しない。
        if (mapped.externalLinkKey)
          createData.externalLinkKey = mapped.externalLinkKey;
        if (mapped.zoningDistrict)
          createData.zoningDistrict = mapped.zoningDistrict;
        if (mapped.rosenkaValue)
          createData.rosenkaValue = parseFloat(mapped.rosenkaValue) || null;
        if (mapped.gpsLat)
          createData.gpsLat = parseFloat(mapped.gpsLat) || null;
        if (mapped.gpsLng)
          createData.gpsLng = parseFloat(mapped.gpsLng) || null;
        if (mapped.note) createData.note = mapped.note;
        if (mapped.introductionRoute) createData.introductionRoute = mapped.introductionRoute;

        // Unit-specific fields
        // 棟(buildingId)は下のトランザクションで applyBuildingLink が入れる。物件名は区分のときだけ。
        const buildingNameForCreate = normalizeBuildingName(
          createData.propertyType as string,
          mapped.buildingName,
        );
        if (buildingNameForCreate) createData.buildingName = buildingNameForCreate;
        if (mapped.roomNo) createData.roomNo = mapped.roomNo.trim();
        if (mapped.floorNo) {
          const n = parseInt(mapped.floorNo);
          if (!isNaN(n)) createData.floorNo = n;
        }
        if (mapped.exclusiveArea) {
          const n = parseFloat(mapped.exclusiveArea);
          if (!isNaN(n)) createData.exclusiveArea = n;
        }
        if (mapped.balconyArea) {
          const n = parseFloat(mapped.balconyArea);
          if (!isNaN(n)) createData.balconyArea = n;
        }
        if (mapped.layoutType) createData.layoutType = mapped.layoutType.trim();
        if (mapped.orientation) createData.orientation = mapped.orientation.trim();
        if (mapped.managementFee) {
          const n = parseInt(mapped.managementFee);
          if (!isNaN(n)) createData.managementFee = n;
        }
        if (mapped.repairReserveFee) {
          const n = parseInt(mapped.repairReserveFee);
          if (!isNaN(n)) createData.repairReserveFee = n;
        }
        if (mapped.occupancyStatus)
          createData.occupancyStatus = mapped.occupancyStatus;
        if (mapped.ownershipShareNote)
          createData.ownershipShareNote = mapped.ownershipShareNote;

        const { property, buildingLink } = await prisma.$transaction(async (tx) => {
          const property = await tx.property.create({
            data: createData as Parameters<typeof prisma.property.create>[0]["data"],
          });
          const buildingLink = buildingChoiceForRow
            ? await applyBuildingLink(tx, {
                propertyId: property.id,
                propertyType: property.propertyType,
                buildingName: property.buildingName,
                address: property.address,
                buildingNumber: property.buildingNumber,
                choice: buildingChoiceForRow,
                currentBuildingId: null,
                userId: session.id,
                // 棟を作ったら同じ tx で取込の目印を書く(取り消しが空の棟を消すとき確実に見つける)。
                importJobId: job.id,
              })
            : null;
          return { property, buildingLink };
        });
        if (buildingLink) {
          await writeBuildingLinkAudit(session.id, property.id, buildingLink, { importJobId: job.id });
          resolvedBuildingId = buildingLink.building?.id ?? null;
        }

        // Reflect newly-created row into dedupe index so later CSV rows catch it
        const newRecord = {
          id: property.id,
          address: property.address,
          roomNo: property.roomNo ?? null,
          // 作った直後の property には棟が入っていない(apply がトランザクション内で後から入れる)。
          buildingId: resolvedBuildingId,
          realEstateNumber: property.realEstateNumber ?? null,
          externalLinkKey: property.externalLinkKey ?? null,
        };
        addToDedupeIndex(dedupeIndex, newRecord);
        existingPropsForDedupe.push(newRecord);

        // 作成: apply が実際に入れた棟へ(つながなかったら書かない)。
        await commitBuildingPostalCode(buildingLink?.building?.id ?? null);
        jobRows.push({
          jobId: job.id,
          rowNumber,
          status: "success",
          rawData: rawRow,
          errorMessage: null,
          createdId: property.id,
        });
        successCount++;
      } catch (err) {
        jobRows.push({
          jobId: job.id,
          rowNumber,
          status: "error",
          rawData: rawRow,
          errorMessage:
            err instanceof Error ? err.message : "不明なエラー",
          createdId: null,
        });
        errorCount++;
      }
    }

    // Save job rows
    for (const row of jobRows) {
      // error / needs_review 行のみ rawData にエラー構造化キー
      // (__error_field / __error_code) を追記する。success 行は不要。
      const enrichedRawData =
        row.status === "error" || row.status === "needs_review"
          ? {
              ...(row.rawData as Record<string, unknown>),
              ...buildErrorRawDataExtras(row.errorMessage, row.rawData),
            }
          : row.rawData;
      await prisma.importJobRow.create({
        data: {
          jobId: row.jobId,
          rowNumber: row.rowNumber,
          status: row.status,
          rawData: enrichedRawData,
          errorMessage: row.errorMessage,
          createdId: row.createdId,
        },
      });
    }

    // Finalize job
    const needsReviewCount = jobRows.filter(
      (r) => r.status === "needs_review",
    ).length;

    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: errorCount > 0 ? "failed" : "completed",
        successCount,
        errorCount: errorCount + needsReviewCount,
        completedAt: new Date(),
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "csv_import",
      targetTable: "import_jobs",
      targetId: job.id,
      detail: {
        fileName: fileName ?? "import.csv",
        totalRows: rows.length,
        successCount,
        updateCount,
        errorCount,
        needsReviewCount,
      },
    });

    return apiResponse(
      {
        jobId: job.id,
        totalRows: rows.length,
        successCount,
        updateCount,
        errorCount,
        needsReviewCount,
        parseErrors,
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  }
}
