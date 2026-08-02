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
import { parseSheet, SheetParseError } from "@/lib/sheet-parser";
import { resolveImportFileType } from "@/lib/import-content-detect";
import { recordChanges, PROPERTY_TRACKED_FIELDS } from "@/lib/change-log";
import {
  parseReceptionRows,
  parseOwnerRows,
  buildCombinedMatches,
  summarizeMatches,
  getReviewReason,
  applyReceptionFilters,
  DEFAULT_RECEPTION_FILTER_OPTIONS,
  REVIEW_REASON_LABEL,
  type PropertyCandidate,
  type ParsedOwnerRow,
  type DlFilterMode,
  type ShinkiFilterMode,
} from "@/lib/reception-owner-match";
import { buildErrorRawDataExtras } from "@/lib/import-error-display";
import { RECEPTION_OWNER_LINK_DATA_KEY } from "@/lib/reception-owner-link";
import { normalizeName, normalizeAddress } from "@/lib/normalize";
import {
  decideCorporateImport,
  emptyCorporateImportSummary,
  tallyCorporateDecision,
  corporateImportMessage,
  appendImportMessage,
  type CorporateImportDecision,
} from "@/lib/owner-corporate-import";
import {
  repairSplitCorporateImportRow,
  emptyCorporateRepairSummary,
  tallyCorporateRepair,
  type CorporateRepairSummary,
} from "@/lib/corporate-number-restore";
import {
  assertImportJsonBodySize,
  MAX_IMPORT_JSON_BODY_BYTES_PAIRED,
} from "@/lib/import-body-size";

// 受付帳CSV × 所有者CSV × 既存物件 の本実行。
// - 一意特定できた行だけ反映。それ以外は needs_review で記録。
// - Property: lotNumber / buildingNumber / roomNo は空値で上書きしない（ブランクのみ補完）。
// - Owner: name + address で upsert。存在すれば再利用、なければ作成。
// - PropertyOwner: 同じ (propertyId, ownerId) が無ければ作成（共有名義に対応）。
// - Building は扱わない（棟名で全ユニットが影響されるため）。

function toPositionalRows(
  headers: string[],
  rows: readonly Record<string, string>[],
): string[][] {
  return rows.map((r) => headers.map((h) => r[h] ?? ""));
}

function nullIfBlank(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // body 全体をバッファする前に過大サイズを弾く(2026-08-02 監査)。
    // ⚠この経路は2ファイル(受付帳+所有者)を同時に受けるため上限は2倍(Codex #349 P2)。


    assertImportJsonBodySize(request, MAX_IMPORT_JSON_BODY_BYTES_PAIRED);


    const body = await request.json();
    const {
      receptionCsv,
      ownerCsv,
      receptionXlsxBase64,
      ownerXlsxBase64,
      receptionFileName,
      ownerFileName,
      dlFilter,
      shinkiFilter,
    } = body as {
      receptionCsv?: string;
      ownerCsv?: string;
      receptionXlsxBase64?: string;
      ownerXlsxBase64?: string;
      receptionFileName?: string;
      ownerFileName?: string;
      dlFilter?: DlFilterMode;
      shinkiFilter?: ShinkiFilterMode;
    };
    const filterOptions = {
      dl: dlFilter ?? DEFAULT_RECEPTION_FILTER_OPTIONS.dl,
      shinki: shinkiFilter ?? DEFAULT_RECEPTION_FILTER_OPTIONS.shinki,
    };

    if (!receptionFileName || !ownerFileName) {
      throw new ApiError(
        422,
        "receptionFileName と ownerFileName は必須です",
        "VALIDATION_ERROR",
      );
    }
    if ((!receptionCsv && !receptionXlsxBase64) || (!ownerCsv && !ownerXlsxBase64)) {
      throw new ApiError(
        422,
        "受付帳・所有者それぞれ csv または xlsx のいずれかを指定してください",
        "VALIDATION_ERROR",
      );
    }

    // パース（csv / xlsx 共通）
    let receptionParsed: ReturnType<typeof parseSheet>;
    let ownerParsed: ReturnType<typeof parseSheet>;
    try {
      receptionParsed = parseSheet({
        fileName: receptionFileName,
        csvText: receptionCsv,
        xlsxBase64: receptionXlsxBase64,
      });
      ownerParsed = parseSheet({
        fileName: ownerFileName,
        csvText: ownerCsv,
        xlsxBase64: ownerXlsxBase64,
      });
    } catch (e) {
      if (e instanceof SheetParseError) {
        throw new ApiError(422, e.message, e.code);
      }
      throw e;
    }
    const receptionPositional = toPositionalRows(
      receptionParsed.headers,
      receptionParsed.rows,
    );
    const ownerPositional = toPositionalRows(
      ownerParsed.headers,
      ownerParsed.rows,
    );

    // ファイル種別チェック (B-11: preview route と同じ純関数・同じ入力で判定し、
    // プレビュー通過 = 本取込も通過を保証する。取り違えのみ 422)
    const receptionResolved = resolveImportFileType(
      "reception",
      receptionFileName,
      receptionParsed.headers,
      receptionPositional,
    );
    if (!receptionResolved.ok) {
      throw new ApiError(
        422,
        `受付帳ファイルとして認識できません: ${receptionResolved.error}`,
        "VALIDATION_ERROR",
      );
    }
    const ownerResolved = resolveImportFileType(
      "owner",
      ownerFileName,
      ownerParsed.headers,
      ownerPositional,
    );
    if (!ownerResolved.ok) {
      throw new ApiError(
        422,
        `所有者ファイルとして認識できません: ${ownerResolved.error}`,
        "VALIDATION_ERROR",
      );
    }

    const receptionRows = applyReceptionFilters(
      parseReceptionRows(receptionPositional),
      filterOptions,
    );
    const ownerRows = parseOwnerRows(ownerParsed.headers, ownerPositional);

    // 既存物件
    const existing = await prisma.property.findMany({
      select: {
        id: true,
        address: true,
        lotNumber: true,
        buildingNumber: true,
        roomNo: true,
        dmStatus: true,
        building: { select: { name: true } },
      },
    });
    const candidates: PropertyCandidate[] = existing.map((p) => ({
      id: p.id,
      address: p.address ?? "",
      lotNumber: p.lotNumber ?? null,
      buildingNumber: p.buildingNumber ?? null,
      buildingName: p.building?.name ?? null,
      roomNo: p.roomNo ?? null,
    }));

    const combined = buildCombinedMatches(receptionRows, ownerRows, candidates);
    const summary = summarizeMatches(receptionRows, ownerRows.length, combined);

    // ImportJob（既存の jobType enum を流用。reception_owner は owner_csv 扱い）
    const job = await prisma.importJob.create({
      data: {
        jobType: "owner_csv",
        fileName: `${receptionFileName ?? "reception.csv"} + ${ownerFileName ?? "owner.csv"}`,
        status: "processing",
        totalRows: receptionRows.length,
        executedBy: session.id,
        startedAt: new Date(),
      },
    });

    let successCount = 0;
    let needsReviewCount = 0;
    let errorCount = 0;
    let propertyUpdatedCount = 0;
    let ownerCreatedCount = 0;
    let ownerLinkedCount = 0;
    // Phase D: 法人番号自動検出のサマリ（AuditLog detail に非PIIで残す）
    const corporateSummary = emptyCorporateImportSummary();
    // 取込ガード: 割れた会社法人等番号の修復件数(非PII・audit detail 用)
    const corporateRepairSummary = emptyCorporateRepairSummary();

    for (const c of combined) {
      const reason = getReviewReason(c);
      const rowNumber = c.reception.rowNumber;
      // 所有者側の DM フラグ・物件住所も rawData に集約（複数件の場合はカンマ区切り）
      const ownerDmList = c.owners
        .map((o) => (o.dm ?? "").trim())
        .filter((v) => v !== "");
      const ownerPropAddrList = c.owners
        .map((o) => (o.propertyAddress ?? "").trim())
        .filter((v) => v !== "");
      // 手動紐づけ (manual-link-reception-owner) で Owner upsert に使う構造化情報。
      // __ プレフィックスは UI / export から除外される内部用フィールド。
      const ownerLinkData = c.owners
        .filter((o) => o.name && o.name.trim() !== "")
        .map((o) => ({ name: o.name, address: o.address, zip: o.zip }));
      const rawData: Record<string, string> = {
        matchKey: c.reception.matchKey,
        fColumn: c.reception.fColumn,
        kColumn: c.reception.kColumn,
        lotNumber: c.reception.lotNumber ?? "",
        buildingNumber: c.reception.buildingNumber ?? "",
        ownerCount: String(c.owners.length),
        // L列(他) は補助情報として保存。物件住所や主突合キーには含めない。
        共有名義人の有無: c.reception.coOwnersNote,
        新既: c.reception.shinkiValue,
        DL: c.reception.dlMarked ? "〇" : "",
        // 所有者CSV の DM フラグ: rawData に保持し、Property.dmStatus への反映もここで行う。
        所有者DM: ownerDmList.join(","),
        所有者CSV物件住所: ownerPropAddrList.join(" / "),
        [RECEPTION_OWNER_LINK_DATA_KEY]: JSON.stringify(ownerLinkData),
        __sourceRef: `${receptionFileName ?? ""}:${c.reception.rowNumber}行`,
      };

      if (reason) {
        const reviewMsg = REVIEW_REASON_LABEL[reason];
        await prisma.importJobRow.create({
          data: {
            jobId: job.id,
            rowNumber,
            status: "needs_review",
            rawData: { ...rawData, ...buildErrorRawDataExtras(reviewMsg, rawData) },
            errorMessage: reviewMsg,
            createdId: null,
          },
        });
        needsReviewCount++;
        continue;
      }

      // matched && owners.length >= 1
      if (
        c.propertyMatch.status !== "matched" ||
        !c.propertyMatch.property ||
        c.owners.length === 0
      ) {
        // 安全側：想定外は skip 扱い
        const fallbackMsg = "想定外の状態";
        await prisma.importJobRow.create({
          data: {
            jobId: job.id,
            rowNumber,
            status: "needs_review",
            rawData: { ...rawData, ...buildErrorRawDataExtras(fallbackMsg, rawData) },
            errorMessage: fallbackMsg,
            createdId: null,
          },
        });
        needsReviewCount++;
        continue;
      }

      const propertyId = c.propertyMatch.property.id;

      try {
        // Property: 空欄のみ補完（既存値は保持）
        const current = existing.find((p) => p.id === propertyId);
        const updates: Record<string, string> = {};
        if (!current?.lotNumber && c.reception.lotNumber) {
          updates.lotNumber = c.reception.lotNumber;
        }
        if (!current?.buildingNumber && c.reception.buildingNumber) {
          updates.buildingNumber = c.reception.buildingNumber;
        }
        // 所有者 CSV の部屋番号でも、物件側が空のときだけ補完
        if (!current?.roomNo) {
          const firstRoom = c.owners
            .map((o) => nullIfBlank(o.roomNo))
            .find((v) => v !== null);
          if (firstRoom) {
            updates.roomNo = firstRoom;
          }
        }

        if (Object.keys(updates).length > 0) {
          const before = {
            lotNumber: current?.lotNumber ?? null,
            buildingNumber: current?.buildingNumber ?? null,
            roomNo: current?.roomNo ?? null,
          };
          await prisma.property.update({
            where: { id: propertyId },
            data: updates,
          });
          await recordChanges({
            targetTable: "properties",
            targetId: propertyId,
            changedBy: session.id,
            oldValues: before,
            newValues: { ...before, ...updates },
            trackedFields: PROPERTY_TRACKED_FIELDS,
            source: "csv_import",
          });
          propertyUpdatedCount++;
        }

        // Owner: name + address で upsert、無ければ name のみで探す
        // Phase D: 行内 owner 単位の法人番号 decision を集約し、行 errorMessage に追記する。
        let rowCorporateMessage: string | null = null;
        for (const o of c.owners) {
          const ownerId = await upsertOwnerAndLink(
            propertyId,
            o,
            session.id,
            () => ownerCreatedCount++,
            () => ownerLinkedCount++,
            (decision) => {
              tallyCorporateDecision(corporateSummary, decision);
              const msg = corporateImportMessage(decision);
              if (msg) {
                rowCorporateMessage = appendImportMessage(rowCorporateMessage, msg);
              }
            },
            corporateRepairSummary,
          );
          if (!ownerId) {
            // name が無ければスキップ（owner 側要件）
            continue;
          }
        }

        // DM〇 → Property.dmStatus を hold から send に昇格（no_send は絶対上書きしない）
        // snapshot 判定ではなく DB 条件付き updateMany で競合を防ぐ。
        // count=1: 実際に hold→send に変わった → recordChanges。
        // count=0: 別ユーザーが変更済み（no_send/send 等）→ 何もしない。
        const hasDmMark = c.owners.some((o) => isDmMarked(o.dm));
        if (hasDmMark) {
          const dmUpdate = await prisma.property.updateMany({
            where: { id: propertyId, dmStatus: "hold" },
            data: { dmStatus: "send" },
          });
          if (dmUpdate.count === 1) {
            await recordChanges({
              targetTable: "properties",
              targetId: propertyId,
              changedBy: session.id,
              oldValues: { dmStatus: "hold" },
              newValues: { dmStatus: "send" },
              trackedFields: PROPERTY_TRACKED_FIELDS,
              source: "csv_import",
            });
          }
        }

        await prisma.importJobRow.create({
          data: {
            jobId: job.id,
            rowNumber,
            status: "success",
            rawData,
            // Phase D: 法人番号スキップ情報のみ追記（生値は含めない）。
            // 複数候補・競合スキップ単独では needs_review に格上げしない。
            errorMessage: appendImportMessage(null, rowCorporateMessage),
            createdId: propertyId,
          },
        });
        successCount++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "不明なエラー";
        await prisma.importJobRow.create({
          data: {
            jobId: job.id,
            rowNumber,
            status: "error",
            rawData: { ...rawData, ...buildErrorRawDataExtras(errMsg, rawData) },
            errorMessage: errMsg,
            createdId: null,
          },
        });
        errorCount++;
      }
    }

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
      action: "reception_owner_csv_import",
      targetTable: "import_jobs",
      targetId: job.id,
      detail: {
        receptionFileName: receptionFileName ?? null,
        ownerFileName: ownerFileName ?? null,
        summary,
        successCount,
        needsReviewCount,
        errorCount,
        propertyUpdatedCount,
        ownerCreatedCount,
        ownerLinkedCount,
        // Phase D: 法人番号自動検出のサマリ。生値・会社名・住所・候補リストは含めない。
        corporateNumber: corporateSummary,
        // 取込ガード: 割れた会社法人等番号の修復件数(split/fragment・非PII)。
        corporateRepair: corporateRepairSummary,
      },
    });

    return apiResponse(
      {
        jobId: job.id,
        summary,
        successCount,
        needsReviewCount,
        errorCount,
        propertyUpdatedCount,
        ownerCreatedCount,
        ownerLinkedCount,
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- helpers ----------

async function upsertOwnerAndLink(
  propertyId: string,
  o: ParsedOwnerRow,
  userId: string,
  onOwnerCreated: () => void,
  onPropertyLinked: () => void,
  onCorporateDecision?: (decision: CorporateImportDecision) => void, // Phase D
  repairSummary?: CorporateRepairSummary, // 取込ガード: 修復件数の集計(非PII)
): Promise<string | null> {
  const rawName = nullIfBlank(o.name);
  if (!rawName) return null; // 氏名がない行は所有者レコードを作れないのでスキップ

  // 取込ガード: exe由来Excelで割れた会社法人等番号を、既存判定・作成より前に修復する。
  // 分断型=住所からラベル+断片を除去し12/13桁を復元(氏名の数字は国税庁照会で後から
  // 会社名に復元できるよう「法人番号復元」タブが拾う)。断片型=氏名から断片を除去。
  const repair = repairSplitCorporateImportRow({
    name: rawName,
    address: nullIfBlank(o.address),
  });
  if (repair.repairedType && repairSummary) {
    tallyCorporateRepair(repairSummary, repair.repairedType);
  }
  const name = repair.name;
  const address = repair.address;
  const zip = nullIfBlank(o.zip);

  // 既存 Owner 検索: name + address → name のみ。
  // archived owner は既存候補として扱わない（Phase 2-A）。
  let candidateOwnerId: string | null = null;
  let existingZip: string | null = null;
  let existingAddress: string | null = null;
  // Phase D: 既存 Owner ヒット時の corporateNumber 競合判定に使う
  let existingCorporateNumber: string | null = null;
  if (address) {
    const normName = normalizeName(name);
    const normAddr = normalizeAddress(address);
    const candidates = await prisma.owner.findMany({
      where: { address: { not: null }, isArchived: false },
      select: {
        id: true,
        zip: true,
        address: true,
        name: true,
        corporateNumber: true,
      },
    });
    const hit =
      candidates.find(
        (c) =>
          normalizeName(c.name) === normName &&
          normalizeAddress(c.address!) === normAddr,
      ) ?? null;
    if (hit) {
      candidateOwnerId = hit.id;
      existingZip = hit.zip;
      existingAddress = hit.address;
      existingCorporateNumber = hit.corporateNumber;
    }
  }
  if (!candidateOwnerId) {
    const hit = await prisma.owner.findFirst({
      where: { name, address: null, isArchived: false },
      select: { id: true, zip: true, address: true, corporateNumber: true },
    });
    if (hit) {
      candidateOwnerId = hit.id;
      existingZip = hit.zip;
      existingAddress = hit.address;
      existingCorporateNumber = hit.corporateNumber;
    }
  }

  // Phase D: name/address から法人番号候補を検出（既存値との競合判定込み）。
  // 純関数なので DB 競合に左右されない。reuse パス・create パス両方で参照する。
  const cnDecision = decideCorporateImport(
    { name, address },
    candidateOwnerId ? existingCorporateNumber : null,
  );

  // 既存 owner を使うパス。lookup と PropertyOwner.create の間に concurrent
  // archive が走るとアーカイブ済み owner に link してしまうため、transaction 内で
  // owner 行を updateMany でロック + isArchived=false を再確認してから link する。
  // count=0 ならアーカイブされたので false を返し、外側で新規 active Owner 作成に
  // フォールバックする。
  if (candidateOwnerId) {
    const zipUpdate = zip && !existingZip ? { zip } : {};
    const addressUpdate = address && !existingAddress ? { address } : {};
    const fieldPatch = { ...zipUpdate, ...addressUpdate };
    const hasFieldPatch = Object.keys(fieldPatch).length > 0;
    const reuseResult = await prisma.$transaction(async (tx) => {
      const lock = await tx.owner.updateMany({
        where: { id: candidateOwnerId!, isArchived: false },
        data: hasFieldPatch
          ? {
              ...fieldPatch,
              version: { increment: 1 },
              updatedAt: new Date(),
            }
          : { updatedAt: new Date() },
      });
      if (lock.count === 0) {
        return { linked: false as const, newLinkCreated: false };
      }
      const existingLink = await tx.propertyOwner.findUnique({
        where: {
          propertyId_ownerId: { propertyId, ownerId: candidateOwnerId! },
        },
        select: { propertyId: true },
      });
      let newLinkCreated = false;
      if (!existingLink) {
        await tx.propertyOwner.create({
          data: {
            propertyId,
            ownerId: candidateOwnerId!,
            relationship: "所有者",
            isPrimary: false,
          },
        });
        newLinkCreated = true;
      }
      return { linked: true as const, newLinkCreated };
    });
    if (reuseResult.linked) {
      if (reuseResult.newLinkCreated) onPropertyLinked();
      // Phase D: 既存 owner で corporateNumber が空欄なら埋める。
      // updateMany の where に corporateNumber: null を入れることでレース時に自動上書きを防ぐ。
      // count=0 のときは既に他者が書き込んでいるため saved にしない（決定は noop 相当）。
      let effectiveDecision: CorporateImportDecision = cnDecision;
      if (cnDecision.action === "save" && cnDecision.corporateNumber) {
        const cnUpdate = await prisma.owner.updateMany({
          where: { id: candidateOwnerId!, corporateNumber: null },
          data: { corporateNumber: cnDecision.corporateNumber },
        });
        if (cnUpdate.count === 0) {
          effectiveDecision = { action: "noop", corporateNumber: null };
        }
      } else if (repair.corporateNumber13) {
        // 取込ガード: 分断型で復元した12/13桁を、既存 owner が未設定の場合のみ埋める
        // (cnDecision と同じ corporateNumber:null レースガード。既存値は上書きしない)。
        await prisma.owner.updateMany({
          where: { id: candidateOwnerId!, corporateNumber: null },
          data: {
            corporateNumber: repair.corporateNumber13,
            ...(repair.companyRegistryNumber12
              ? { companyRegistryNumber: repair.companyRegistryNumber12 }
              : {}),
          },
        });
      }
      if (onCorporateDecision) onCorporateDecision(effectiveDecision);
      return candidateOwnerId;
    }
    // 競合: archived race を検出。candidateOwnerId をクリアして新規作成にフォールバック。
  }

  // 新規 Owner 作成 + link（dedup ヒットなし、または上記レースで fallback）
  // Phase D: 候補 1 件のみ採用。新規作成パスは existing=null として再評価する
  // （ヒットありで race fallback してきたケースでは元の cnDecision が conflict/noop だった
  //  可能性があるが、新 owner なので空欄埋め扱いで再計算）。
  const cnDecisionForCreate =
    candidateOwnerId === null
      ? cnDecision
      : decideCorporateImport({ name, address }, null);
  const created = await prisma.owner.create({
    data: {
      name,
      ...(address ? { address } : {}),
      ...(zip ? { zip } : {}),
      // 13桁の採用優先度: テキスト検出(cnDecision) > 取込ガードの復元値。
      // (両方が同時に成立するデータ形状は実務上ないが、既存挙動を優先する)
      ...(cnDecisionForCreate.action === "save" && cnDecisionForCreate.corporateNumber
        ? { corporateNumber: cnDecisionForCreate.corporateNumber }
        : repair.corporateNumber13
          ? { corporateNumber: repair.corporateNumber13 }
          : {}),
      ...(repair.companyRegistryNumber12
        ? { companyRegistryNumber: repair.companyRegistryNumber12 }
        : {}),
    },
    select: { id: true },
  });
  if (onCorporateDecision) onCorporateDecision(cnDecisionForCreate);
  const ownerId = created.id;
  onOwnerCreated();
  await writeAuditLog({
    userId,
    action: "owner_created_from_reception",
    targetTable: "owners",
    targetId: ownerId,
    // ⚠**氏名・住所・郵便番号を監査に生で残さない**（認可・PII 横断監査 2026-07-30）。
    // 対象は targetId=ownerId で辿れるので、監査には「どの項目が入っていたか」の
    // 有無だけを残す（同ファイルのジョブ監査が件数のみなのと同じ方針）。
    detail: { hasAddress: address != null, hasZip: zip != null },
  });

  // 新規 owner は他 tx から見えないため archive 競合はない。通常の link 処理。
  const existingLink = await prisma.propertyOwner.findUnique({
    where: {
      propertyId_ownerId: { propertyId, ownerId },
    },
    select: { propertyId: true },
  });
  if (!existingLink) {
    await prisma.propertyOwner.create({
      data: {
        propertyId,
        ownerId,
        relationship: "所有者",
        isPrimary: false,
      },
    });
    onPropertyLinked();
  }

  return ownerId;
}

// DM 列の値が「送付可」を示すか判定。NFKC 正規化後に ○/〇 で判断。
function isDmMarked(dm: string | null | undefined): boolean {
  if (!dm) return false;
  const n = dm.trim().normalize("NFKC");
  return n === "○" || n === "〇";
}
