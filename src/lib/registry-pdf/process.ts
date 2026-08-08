/**
 * 謄本PDF取込の中核処理（手動取込・将来の自動取得連携で共有する）。
 *
 * route.ts（POST handler）から「認証・入力受け口（multipart/text）」を除いた
 * 残り全部 ＝ parse → ImportJob 作成 → Mode A/B 物件特定 → 所有者反映
 * → silent fail / success finalize（ImportJobRow・Attachment(type="registry")保存・
 * AuditLog）→ レスポンス body 生成 を `processRegistryPdf` に集約する。
 *
 * PR1（無挙動リファクタ）: 既存 route.ts の挙動・レスポンス・ステータスコード・
 * ImportJob/ImportJobRow・Attachment 保存・Mode A/B・所有者反映・AuditLog・warning は
 * 一切変更しない。route.ts からロジックを移しただけ。
 *
 * 入力 text は呼び出し側（route の multipart→extractTextFromPdf / text 貼り付け）で
 * 抽出済みのものを受け取る。pdfBuffer は multipart のときのみ非 null（Attachment 保存用）。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { recordChanges, PROPERTY_TRACKED_FIELDS } from "@/lib/change-log";
import { normalizeName, normalizeAddress } from "@/lib/normalize";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { buildErrorRawDataExtras } from "@/lib/import-error-display";
import {
  getStorage,
  validateFile,
  ALLOWED_ATTACHMENT_MIMES,
} from "@/lib/storage";
import {
  decideCorporateImport,
  emptyCorporateImportSummary,
  tallyCorporateDecision,
  corporateImportMessage,
  appendImportMessage,
  type CorporateImportDecision,
} from "@/lib/owner-corporate-import";

// 確定取込で UI が編集した結果（A-2a）。サーバ再 parse より優先する。
// クライアント送信値は無検証で信用せず zod で型・件数を検証する。
export const editedImportSchema = z.object({
  fields: z
    .object({
      realEstateNumber: z.string().nullish(),
      address: z.string().nullish(),
      lotNumber: z.string().nullish(),
      buildingNumber: z.string().nullish(),
      landCategory: z.string().nullish(),
      area: z.string().nullish(),
    })
    .optional(),
  owners: z
    .array(
      z.object({
        name: z.string(),
        address: z.string().nullish(),
        share: z.string().nullish(),
      }),
    )
    .max(100, "所有者が多すぎます")
    .optional(),
});
export type EditedImport = z.infer<typeof editedImportSchema>;

export const registryPdfJsonSchema = z.object({
  /** Extracted text from the PDF (テキスト貼り付けモード) */
  text: z.string().min(1, "テキストは必須です"),
  /** Optional: property ID to update instead of creating new */
  propertyId: z.string().uuid().optional().nullable(),
  /** File name for audit purposes */
  fileName: z.string().optional(),
  /** UI で編集した確定データ（任意）。再 parse 結果より優先して反映する。 */
  edited: editedImportSchema.optional(),
});

/** processRegistryPdf に渡す認証済みセッション（最小形）。 */
export interface RegistryPdfSession {
  id: string;
  role: string;
}

export interface ProcessRegistryPdfArgs {
  /** 認証済みセッション（route の getApiSession の結果）。 */
  session: RegistryPdfSession;
  /** PDF/貼り付けから抽出済みのテキスト。 */
  text: string;
  /** Mode A 指定の物件ID（null なら Mode B）。 */
  propertyId: string | null;
  /** 監査用ファイル名。 */
  fileName: string;
  /** UI 編集データ（任意）。 */
  edited: EditedImport | undefined;
  /** multipart(PDF binary) のときのみ非 null。Attachment(type="registry") 保存用。 */
  pdfBuffer: Buffer | null;
  /**
   * 有料取得の請求種別（owner|all）。有料取得フローからのみ渡る（手動取込は undefined）。
   * ⚠**"all"(全部事項)のときは所有者を物件へ反映しない**。全部事項には抹消された
   * 旧所有者が載り、今の解析は現在/抹消を区別できないため、旧所有者を現在の所有者
   * として登録して DM 宛先などを誤らせる恐れがある。all は PDF 添付のみに留める
   * （安全側の既定・発注者確定の方針）。種別が分かる添付には別途ラベルを付ける。
   */
  certificateType?: "owner" | "all";
}

// parse 結果に UI 編集値をマージ（編集優先）。下流の Mode A/B は
// マージ後の parsed をそのまま使うため、所有者反映・物件更新ロジックは不変。
function applyEditedToParsed(
  parsed: ReturnType<typeof parseRegistryText>,
  edited: EditedImport | undefined,
): ReturnType<typeof parseRegistryText> {
  if (!edited) return parsed;
  const nz = (v: string | null | undefined): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t === "" ? null : t;
  };
  if (edited.fields) {
    // 部分編集を許容: 実際に送信されたキーだけ parsed に反映し、未送信キーは
    // parser の元値を保持する（hasOwnProperty で送信有無を判定）。空文字を明示
    // 送信したキーは nz("") → null として既存方針どおり上書きする。
    const f = edited.fields;
    const sent = (k: keyof typeof f) =>
      Object.prototype.hasOwnProperty.call(f, k);
    if (sent("realEstateNumber"))
      parsed.realEstateNumber = nz(edited.fields.realEstateNumber);
    if (sent("address")) parsed.address = nz(edited.fields.address);
    if (sent("lotNumber")) parsed.lotNumber = nz(edited.fields.lotNumber);
    if (sent("buildingNumber"))
      parsed.buildingNumber = nz(edited.fields.buildingNumber);
    if (sent("landCategory"))
      parsed.landCategory = nz(edited.fields.landCategory);
    if (sent("area")) parsed.area = nz(edited.fields.area);
  }
  if (edited.owners) {
    parsed.owners = edited.owners
      .map((o) => ({
        name: (o.name ?? "").trim(),
        address: nz(o.address),
        share: nz(o.share),
      }))
      .filter((o) => o.name.length > 0);
  }
  return parsed;
}

// Prisma の unique constraint 違反 (P2002) を duck-type で判定する（Prisma namespace を
// import せずに判定）。@@unique([propertyId, ownerId]) への同時 insert 競合のみ握って
// PropertyOwner link 作成を冪等化するために使う（Codex P2）。
function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

// A-2c: 謄本PDF取込の所有者反映（Owner 突合/作成 + PropertyOwner link）を
// Mode A/B 共通の private 関数に括り出す。中身は従来の Mode A ループを propertyId
// 引数化しただけで挙動は不変（突合/正規化/archive race/法人番号の各方針を維持）。
// 返り値は非PIIの件数サマリ:
//   matched = 既存 active Owner を再利用した件数
//   created = 新規 Owner を作成した件数
//   linked  = 新規に作成した PropertyOwner link の件数
async function reflectParsedOwners(args: {
  propertyId: string;
  owners: ReturnType<typeof parseRegistryText>["owners"];
  recordCorporateDecision: (decision: CorporateImportDecision) => void;
}): Promise<{ matched: number; created: number; linked: number }> {
  const { propertyId, owners, recordCorporateDecision } = args;
  let matchedCount = 0;
  let createdCount = 0;
  let linkedCount = 0;

  for (const ownerInfo of owners) {
    if (!ownerInfo.name) continue;

    // address あり → normalizeName + normalizeAddress で既存 Owner 検索
    // address なし → name のみでの自動統合はしない（同姓同名の別人を誤統合しないため）
    // archived owner は通常の取込候補から除外（Phase 2-A）。
    let candidateOwnerId: string | null = null;
    // Phase D: 既存 Owner ヒット時の corporateNumber 競合判定に使う
    let candidateCorporateNumber: string | null = null;

    if (ownerInfo.address) {
      const normName = normalizeName(ownerInfo.name);
      const normAddr = normalizeAddress(ownerInfo.address);
      const candidates = await prisma.owner.findMany({
        where: { address: { not: null }, isArchived: false },
        select: { id: true, name: true, address: true, corporateNumber: true },
      });
      const hit = candidates.find(
        (c) =>
          normalizeName(c.name) === normName &&
          normalizeAddress(c.address!) === normAddr,
      );
      candidateOwnerId = hit?.id ?? null;
      candidateCorporateNumber = hit?.corporateNumber ?? null;
    }

    // 既存 owner を使うパス: lookup と PropertyOwner.create の間に concurrent
    // archive が走った場合に archived owner に link してしまうのを防ぐ。
    // transaction 内で owner 行を updateMany でロック + isArchived=false 再確認 →
    // PropertyOwner 作成までを 1 つの tx に閉じる。count=0 ならフォールバックで
    // 新規 active Owner を作成する。
    let resolvedOwnerId: string | null = null;
    if (candidateOwnerId) {
      // Codex P2: 同時実行で別 tx が先に同じ (propertyId, ownerId) を link 済みだと、
      // tx 内 create が @@unique([propertyId, ownerId]) 違反(P2002)で reject する。
      // その場合は「既にリンク済み」として扱い job 全体は失敗させない（reused 扱い・
      // linkCreated=false で linkedCount を二重に増やさない）。P2002 以外のエラーは
      // 従来どおり throw して失敗させる。
      let reuseResult: { reused: boolean; linkCreated: boolean };
      try {
        reuseResult = await prisma.$transaction(async (tx) => {
          const lock = await tx.owner.updateMany({
            where: { id: candidateOwnerId!, isArchived: false },
            data: { updatedAt: new Date() },
          });
          if (lock.count === 0) {
            return { reused: false, linkCreated: false };
          }
          // 親の物件行をロック(Owner→親の順・書き込み規約+#364 R10)。
          await lockPropertyRow(tx, propertyId);
          const existingLink = await tx.propertyOwner.findFirst({
            where: { propertyId, ownerId: candidateOwnerId! },
            select: { propertyId: true },
          });
          let linkCreated = false;
          if (!existingLink) {
            await tx.propertyOwner.create({
              data: {
                propertyId,
                ownerId: candidateOwnerId!,
                relationship: ownerInfo.share ? "共有者" : "所有者",
              },
            });
            linkCreated = true;
          }
          return { reused: true, linkCreated };
        });
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        // 同時実行で相手が先に link 済み → 既にリンク済み扱い（linkedCount は増やさない）。
        reuseResult = { reused: true, linkCreated: false };
      }
      if (reuseResult.reused) {
        resolvedOwnerId = candidateOwnerId;
        matchedCount++;
        if (reuseResult.linkCreated) linkedCount++;
      }
      // 競合検出時は resolvedOwnerId=null のまま下のフォールバックへ
    }

    // Phase D: reuse 成功判定。
    // `resolvedOwnerId === candidateOwnerId` だけだと両方 null のとき true になり、
    // (a) updateMany が id:null で実行されてしまう
    // (b) recordCorporateDecision が reuse 側と create 側の二重で呼ばれてしまう
    // 上記 2 件の Codex P1/P2 を防ぐため、両方 non-null かつ等しいことを要求する。
    const reusedExistingOwner =
      resolvedOwnerId !== null &&
      candidateOwnerId !== null &&
      resolvedOwnerId === candidateOwnerId;

    // reuse 成功時のみ既存 corporateNumber と比較、それ以外は existing=null として計算。
    const cnDecision = decideCorporateImport(
      { name: ownerInfo.name, address: ownerInfo.address ?? null },
      reusedExistingOwner ? candidateCorporateNumber : null,
    );

    // reuse 成功時: 既存 owner が corporateNumber 空ならここで埋める。
    // where 条件で corporateNumber: null を要求し、race 時は count=0 で自動上書きを防ぐ。
    if (
      reusedExistingOwner &&
      cnDecision.action === "save" &&
      cnDecision.corporateNumber
    ) {
      const cnUpdate = await prisma.owner.updateMany({
        where: { id: candidateOwnerId!, corporateNumber: null },
        data: { corporateNumber: cnDecision.corporateNumber },
      });
      recordCorporateDecision(
        cnUpdate.count === 0
          ? { action: "noop", corporateNumber: null }
          : cnDecision,
      );
    } else if (reusedExistingOwner) {
      // reuse 成功 + save 以外（noop / multi / conflict / none） → そのまま集計
      recordCorporateDecision(cnDecision);
    }

    if (!resolvedOwnerId) {
      // 新規 Owner 作成 + link（dedup ヒットなし、または archive race で fallback）。
      // 新規 owner は他 tx から見えないため archive 競合はない。
      // archive race fallback の場合も「新規 owner なので existing=null」で再評価する。
      const cnDecisionForCreate =
        candidateOwnerId === null
          ? cnDecision
          : decideCorporateImport(
              { name: ownerInfo.name, address: ownerInfo.address ?? null },
              null,
            );
      const created = await prisma.owner.create({
        data: {
          name: ownerInfo.name,
          ...(ownerInfo.address ? { address: ownerInfo.address } : {}),
          // Phase D: 候補 1 件のみ採用、複数 / 競合は乗せない
          ...(cnDecisionForCreate.action === "save" && cnDecisionForCreate.corporateNumber
            ? { corporateNumber: cnDecisionForCreate.corporateNumber }
            : {}),
        },
        select: { id: true },
      });
      resolvedOwnerId = created.id;
      createdCount++;
      recordCorporateDecision(cnDecisionForCreate);

      const existingLink = await prisma.propertyOwner.findFirst({
        where: { propertyId, ownerId: resolvedOwnerId },
      });
      if (!existingLink) {
        // Codex P2: 新規 owner は一意な ID のため通常 link 衝突しないが、防御的に
        // P2002 を握って冪等化する（同時実行で相手が先に link 済みなら既存扱い・
        // linkedCount は増やさない）。P2002 以外は従来どおり throw して失敗させる。
        try {
          // 親の物件行をロックしてから link(書き込み規約+#364 R10)。
          // closure 内では narrowing が効かないため確定値を捕捉する。
          const ownerIdForLink = resolvedOwnerId;
          await prisma.$transaction(async (tx) => {
            await lockPropertyRow(tx, propertyId);
            await tx.propertyOwner.create({
              data: {
                propertyId,
                ownerId: ownerIdForLink,
                relationship: ownerInfo.share ? "共有者" : "所有者",
              },
            });
          });
          linkedCount++;
        } catch (err) {
          if (!isUniqueConstraintError(err)) throw err;
        }
      }
    }
  }

  return { matched: matchedCount, created: createdCount, linked: linkedCount };
}

/**
 * 謄本PDF取込の中核処理。route.ts の認証・入力受け口を除いた残り全部。
 * 戻り値は API レスポンス body（呼び出し側が apiResponse(result, 201) で返す）。
 * ハードエラーは ApiError / Prisma 例外を throw し、呼び出し側 catch → handleApiError へ。
 */
export async function processRegistryPdf(
  args: ProcessRegistryPdfArgs,
): Promise<Record<string, unknown>> {
  const { session, text, propertyId, fileName, edited, pdfBuffer } = args;

  // ⚠**全部事項(all)は所有者を反映しない**。抹消された旧所有者を現在の所有者として
  // 登録する事故を防ぐ安全既定(所有者事項=owner・手動取込=undefined は従来どおり反映)。
  const reflectOwners = args.certificateType !== "all";

  // Parse the registry text（UI 編集値があれば再 parse より優先してマージ）
  const parsed = applyEditedToParsed(parseRegistryText(text), edited);

  // Create import job record
  const job = await prisma.importJob.create({
    data: {
      jobType: "property_pdf",
      fileName: fileName,
      status: "processing",
      totalRows: 1,
      executedBy: session.id,
      startedAt: new Date(),
    },
  });

  let resultAction: "created" | "updated" | "matched" = "matched";
  let targetPropertyId: string | null = null;
  // Phase D: 法人番号自動検出のサマリ + 行 errorMessage 集約
  const corporateSummary = emptyCorporateImportSummary();
  let rowCorporateMessage: string | null = null;
  const recordCorporateDecision = (decision: CorporateImportDecision) => {
    tallyCorporateDecision(corporateSummary, decision);
    const msg = corporateImportMessage(decision);
    if (msg) {
      rowCorporateMessage = appendImportMessage(rowCorporateMessage, msg);
    }
  };
  // A-2c: owner 反映件数（非PII）。Mode A/B 共通関数の返り値を集計する。
  let ownersMatched = 0;
  let ownersCreated = 0;
  let ownersLinked = 0;
  // A-2c: Mode B で field_staff スコープにより owner 反映をスキップしたフラグ。
  let ownerScopeSkipped = false;
  // PR#88: Mode B で弱い住所一致のため owner 反映をスキップしたフラグ。
  let ownerWeakMatchSkipped = false;
  // 失敗理由（silent fail-through 用と、catch ブロックでの recovery 用）。
  // null のままなら成功扱い。
  let failureReason: string | null = null;

  try {
    if (propertyId) {
      // ---- Mode A: Update existing property ----
      const existing = await prisma.property.findUnique({
        where: { id: propertyId },
      });

      if (!existing) {
        throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
      }

      // field_staff スコープ: 担当外/未作成の物件を propertyId 直指定で更新させない。
      // admin / office_staff は全件可。UI だけでなく API 直アクセスもここで遮断する。
      if (!canAccessPropertyRecord(session, existing)) {
        throw new ApiError(
          403,
          "この物件にアクセスする権限がありません",
          "FORBIDDEN",
        );
      }

      // Build update fields (only fill empty/null fields, don't overwrite)
      const updates: Record<string, unknown> = {};
      if (!existing.realEstateNumber && parsed.realEstateNumber) {
        updates.realEstateNumber = parsed.realEstateNumber;
      }
      if (!existing.lotNumber && parsed.lotNumber) {
        updates.lotNumber = parsed.lotNumber;
      }
      if (!existing.buildingNumber && parsed.buildingNumber) {
        updates.buildingNumber = parsed.buildingNumber;
      }
      if (
        existing.registryStatus === "unconfirmed" &&
        parsed.realEstateNumber
      ) {
        updates.registryStatus = "obtained";
      }

      if (Object.keys(updates).length > 0) {
        await prisma.property.updateMany({
          where: { id: propertyId, version: existing.version },
          data: { ...updates, version: { increment: 1 } },
        });

        await recordChanges({
          targetTable: "properties",
          targetId: propertyId,
          changedBy: session.id,
          oldValues: existing as unknown as Record<string, unknown>,
          newValues: updates,
          trackedFields: PROPERTY_TRACKED_FIELDS,
          source: "pdf_import",
        });

        resultAction = "updated";
      }

      targetPropertyId = propertyId;

      // A-2c: owner 反映を Mode A/B 共通関数へ委譲（挙動は従来の Mode A と同一）。
      // Mode A は L239 で canAccessPropertyRecord による 403 を通過済みのため、
      // ここに到達する時点でアクセス権は確認済み。
      // ⚠全部事項(all)は所有者を反映しない（旧所有者混入の防止・上記）。
      if (reflectOwners) {
        const modeAOwners = await reflectParsedOwners({
          propertyId,
          owners: parsed.owners,
          recordCorporateDecision,
        });
        ownersMatched = modeAOwners.matched;
        ownersCreated = modeAOwners.created;
        ownersLinked = modeAOwners.linked;
      }
    } else {
      // ---- Mode B: Try to match or create new ----
      let matchedProperty = null;
      // PR#88: owner 反映は「強い/決定的な物件一致」のときのみ許可する。
      //  - realEstateNumber 一致（一意性が高い）
      //  - 正規化住所の完全一致
      //  - 新規 Property 作成
      // address contains の部分一致 fallback は弱い一致のため owner を反映しない
      // （誤った物件に Owner/PropertyOwner を恒久紐づけしないため）。取込本体の物件
      // match 挙動自体は従来どおり維持し、owner 反映だけを skip する。
      let canReflectOwners = false;

      if (parsed.realEstateNumber) {
        matchedProperty = await prisma.property.findFirst({
          where: { realEstateNumber: parsed.realEstateNumber },
          select: { id: true, address: true, realEstateNumber: true },
        });
        if (matchedProperty) {
          // realEstateNumber 一致は決定的とみなす。
          canReflectOwners = true;
        }
      }

      if (!matchedProperty && parsed.address) {
        matchedProperty = await prisma.property.findFirst({
          where: { address: { contains: parsed.address } },
          select: { id: true, address: true, realEstateNumber: true },
        });
        if (matchedProperty) {
          // 正規化住所が完全一致する場合のみ決定的とみなす。contains による部分一致
          // （完全一致でない）は弱い fallback なので owner 反映を許可しない。
          canReflectOwners =
            matchedProperty.address != null &&
            normalizeAddress(matchedProperty.address) ===
              normalizeAddress(parsed.address);
        }
      }

      if (matchedProperty) {
        targetPropertyId = matchedProperty.id;
        resultAction = "matched";
      } else if (parsed.address) {
        // Create new property
        const newProp = await prisma.property.create({
          data: {
            address: parsed.address,
            lotNumber: parsed.lotNumber,
            buildingNumber: parsed.buildingNumber,
            realEstateNumber: parsed.realEstateNumber,
            propertyType: parsed.buildingNumber ? "building" : "land",
            registryStatus: parsed.realEstateNumber
              ? "obtained"
              : "unconfirmed",
            dmStatus: "hold",
            createdBy: session.id,
          },
        });
        targetPropertyId = newProp.id;
        resultAction = "created";
        // 新規作成した物件は自分が createdBy なので owner 反映可。
        canReflectOwners = true;
      }

      // A-2c: Mode B でも owner を反映する（targetPropertyId 確定後）。
      // PR#88: ただし強い/決定的な物件一致(canReflectOwners)のときのみ。弱い住所部分
      // 一致は誤紐づけ防止のため反映せず skip + warning（取込本体 matched は成功維持）。
      // field_staff スコープ: 反映する場合は担当外/作成外の物件には反映しない
      // （A-2b Attachment と同じく skip + warning）。created は createdBy=session.id の
      // ため常にアクセス可。owner 反映が例外を投げた場合は Mode A と同じく innerErr
      // catch に伝播し job failed になる（ハード失敗。best-effort warning ではない）。
      // owners が無ければ書き込み対象が無いため反映関連はすべてスキップする。
      // ⚠全部事項(all)は所有者を反映しない（旧所有者混入の防止・上記）。
      if (reflectOwners && targetPropertyId && parsed.owners.length > 0) {
        if (!canReflectOwners) {
          // 弱い住所 fallback で物件を特定 → owner 反映しない（取込本体は維持）。
          ownerWeakMatchSkipped = true;
        } else {
          const targetProp = await prisma.property.findUnique({
            where: { id: targetPropertyId },
            select: { createdBy: true, assignedTo: true },
          });
          if (!targetProp || !canAccessPropertyRecord(session, targetProp)) {
            ownerScopeSkipped = true;
          } else {
            const modeBOwners = await reflectParsedOwners({
              propertyId: targetPropertyId,
              owners: parsed.owners,
              recordCorporateDecision,
            });
            ownersMatched = modeBOwners.matched;
            ownersCreated = modeBOwners.created;
            ownersLinked = modeBOwners.linked;
          }
        }
      }
    }

    // Silent fail-through 検出: ジョブは作成済みだが
    //  Mode A/B のどちらでも targetPropertyId が立たなかった = 物件操作なし。
    // これまでは status="completed" / errorCount=1 のまま行を残さず返していたが、
    // status="failed" + ImportJobRow(error) を残し、詳細画面で原因を追えるようにする。
    if (!targetPropertyId) {
      failureReason = !parsed.address
        ? "PDFから住所を抽出できませんでした。OCRに失敗したか、想定外のフォーマットの可能性があります。"
        : "PDFから抽出した内容では既存物件と一致せず、新規作成にも至りませんでした。";
    }
  } catch (innerErr) {
    // ジョブ作成後に発生したエラー (Mode A の NOT_FOUND / Prisma 例外 等)。
    // ImportJob を "failed" で finalize し、ImportJobRow も error で1件残す。
    // 失敗の詳細は元のエラーから取り出して errorMessage に格納する。
    failureReason =
      innerErr instanceof Error
        ? innerErr.message
        : "PDF取込中に不明なエラーが発生しました";

    // ベストエフォートで finalize。recovery 自体が失敗しても元のエラーを優先する。
    try {
      await prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          successCount: 0,
          errorCount: 1,
          completedAt: new Date(),
        },
      });
      await prisma.importJobRow.create({
        data: {
          jobId: job.id,
          rowNumber: 1,
          status: "error",
          rawData: {
            fileName,
            reason: failureReason,
            extractedAddress: parsed.address ?? null,
            extractedRealEstateNumber: parsed.realEstateNumber ?? null,
            targetPropertyId,
            ...buildErrorRawDataExtras(failureReason, null),
          },
          errorMessage: failureReason,
          createdId: null,
        },
      });
    } catch {
      // finalize 失敗はサイレント（元のエラーを下で再 throw）
    }

    // 元のエラーを再 throw して handleApiError に正規の HTTP ステータスを返させる
    throw innerErr;
  }

  // ---- Finalize: success / silent-fail で分岐 ----
  if (failureReason) {
    // Path 3: silent fail-through。API 自体は 201 を返しつつ、ジョブとしては
    // failed + error 行で記録する。propertyId は null。
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        successCount: 0,
        errorCount: 1,
        completedAt: new Date(),
      },
    });
    await prisma.importJobRow.create({
      data: {
        jobId: job.id,
        rowNumber: 1,
        status: "error",
        rawData: {
          fileName,
          reason: failureReason,
          extractedAddress: parsed.address ?? null,
          extractedRealEstateNumber: parsed.realEstateNumber ?? null,
          targetPropertyId: null,
          ...buildErrorRawDataExtras(failureReason, null),
        },
        errorMessage: failureReason,
        createdId: null,
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "pdf_import",
      targetTable: "import_jobs",
      targetId: job.id,
      detail: {
        jobId: job.id,
        action: "failed",
        reason: failureReason,
        confidence: parsed.confidence,
        fileName: fileName,
      },
    });

    return {
      jobId: job.id,
      action: resultAction,
      propertyId: null,
      parsed,
    };
  }

  // 成功パス（既存動作）
  await prisma.importJob.update({
    where: { id: job.id },
    data: {
      status: "completed",
      successCount: 1,
      errorCount: 0,
      completedAt: new Date(),
    },
  });

  await prisma.importJobRow.create({
    data: {
      jobId: job.id,
      rowNumber: 1,
      status: "success",
      rawData: {
        realEstateNumber: parsed.realEstateNumber,
        address: parsed.address,
        lotNumber: parsed.lotNumber,
        buildingNumber: parsed.buildingNumber,
        // PR#88: owner 名(PII)は rawData に残さない。件数のみ保持する。
        ownerCount: parsed.owners.length,
        // A-2c: owner 反映の非PII件数（名前・住所は載せない）。
        ownersMatched,
        ownersCreated,
        ownersLinked,
      },
      // Phase D: 法人番号スキップ情報のみ追記（生値・会社名・住所は含めない）。
      errorMessage: appendImportMessage(null, rowCorporateMessage),
      createdId: targetPropertyId,
    },
  });

  // A-2b: 謄本PDF本体を Attachment(type="registry") として保存する。
  //  - multipart(PDF binary) のみ。text 貼り付けは pdfBuffer=null でスキップ。
  //  - Mode A/B 問わず targetPropertyId 確定後（このパスでは必ず非 null）に保存。
  //  - 保存失敗は取込本体を失敗扱いにせず warning として返す（部分成功）。
  //  - audit/レスポンスに載せるのは attachmentId（UUID）のみ。
  //    fileUrl 全文・PDF 本文・抽出テキスト・所有者名・住所は載せない。
  let attachmentId: string | null = null;
  let attachmentWarning: string | null = null;
  if (pdfBuffer && targetPropertyId) {
    // P1: Attachment を書き込む直前に、対象 property へのアクセス権を必ず確認する。
    // Mode B は地番/住所マッチで既存物件に targetPropertyId が決まり得るため、
    // Mode A と同じ field_staff スコープ（canAccessPropertyRecord）をここでも適用し、
    // 担当外/作成外の物件に PDF を添付させない（attachments endpoint と同等の制御）。
    // admin / office_staff は従来どおり全件許可。
    const target = await prisma.property.findUnique({
      where: { id: targetPropertyId },
      select: { createdBy: true, assignedTo: true },
    });
    if (!target || !canAccessPropertyRecord(session, target)) {
      // 権限が無い対象には upload も attachment.create も実行しない（最優先要件）。
      // 取込本体（matched/created）は既存仕様どおり成功扱いのまま warning を返す。
      attachmentWarning =
        "対象物件へのアクセス権が無いため、謄本PDFは保存されませんでした。";
    } else {
      // upload 成功後に attachment.create が失敗した場合、storage 上に孤児 PDF が
      // 残らないよう uploaded.key を保持し、catch で best-effort 削除する。
      let uploadedKey: string | null = null;
      try {
        const validationError = validateFile(
          pdfBuffer.length,
          "application/pdf",
          ALLOWED_ATTACHMENT_MIMES,
        );
        if (validationError) {
          throw new Error(validationError);
        }
        // key を一意化する（Codex P2）。Date.now() だけだと同一ミリ秒の
        // 並行取込で衝突し、後続 PDF が同一 key を上書きして複数 Attachment が
        // 同じ実体を指す恐れがあるため、randomUUID を suffix に付与する。
        const key = `properties/${targetPropertyId}/registry/${Date.now()}-${randomUUID()}.pdf`;
        const uploaded = await getStorage().upload(pdfBuffer, {
          key,
          mimeType: "application/pdf",
          fileName,
        });
        uploadedKey = uploaded.key;
        const attachment = await prisma.attachment.create({
          data: {
            targetType: "property",
            targetId: targetPropertyId,
            propertyId: targetPropertyId,
            type: "registry",
            // 有料取得の種別（owner|all）。手動取込(undefined)は null=種別不明のまま。
            registryCertificateType: args.certificateType ?? null,
            fileName,
            fileUrl: uploaded.url,
            fileSize: pdfBuffer.length,
            mimeType: "application/pdf",
            uploadedBy: session.id,
          },
          select: { id: true },
        });
        attachmentId = attachment.id;
      } catch (err) {
        // 取込本体は成功扱いのまま継続し、保存失敗のみ warning として返す。
        console.error("Failed to save registry PDF attachment:", err);
        // upload は成功したが attachment.create 等で失敗した場合、謄本=機微ファイルが
        // Attachment row 無しで storage に残ると通常の削除/cleanup から到達できない
        // 孤児ファイルになる。best-effort で削除する（upload 自体が失敗した場合は
        // uploadedKey=null のため削除対象なし）。
        if (uploadedKey) {
          try {
            await getStorage().delete(uploadedKey);
          } catch (delErr) {
            // 削除失敗でも取込本体は失敗させない（記録のみ）。
            console.error(
              "Failed to delete orphaned registry PDF after attachment error:",
              delErr,
            );
          }
        }
        attachmentWarning =
          "謄本は取込されましたが、PDF本体の保存に失敗しました。";
      }
    }
  }

  // A-2c: field_staff スコープで owner 反映をスキップした場合の warning を、
  // A-2b の attachment warning と合わせて 1 つの warning 文字列にまとめて返す
  // （両方発生し得るため。取込本体は成功扱いのまま）。
  const warningParts: string[] = [];
  if (ownerWeakMatchSkipped) {
    warningParts.push(
      "住所の部分一致で物件を特定したため、所有者情報は反映されませんでした。",
    );
  }
  if (ownerScopeSkipped) {
    warningParts.push(
      "対象物件へのアクセス権が無いため、所有者情報は反映されませんでした。",
    );
  }
  if (attachmentWarning) {
    warningParts.push(attachmentWarning);
  }
  const warning = warningParts.length > 0 ? warningParts.join(" ") : null;

  await writeAuditLog({
    userId: session.id,
    action: "pdf_import",
    targetTable: "properties",
    targetId: targetPropertyId ?? undefined,
    detail: {
      jobId: job.id,
      action: resultAction,
      confidence: parsed.confidence,
      fileName: fileName,
      // Phase D: 法人番号自動検出のサマリ。生値・会社名・住所・候補リストは含めない。
      corporateNumber: corporateSummary,
      // A-2c: owner 反映の非PII件数（名前・住所は載せない）。
      ownersMatched,
      ownersCreated,
      ownersLinked,
      // A-2b: 保存できた場合のみ attachmentId（UUID）を載せる。
      ...(attachmentId ? { attachmentId } : {}),
    },
  });

  return {
    jobId: job.id,
    action: resultAction,
    propertyId: targetPropertyId,
    parsed,
    // A-2c: owner 反映件数（非PII）。
    ownersMatched,
    ownersCreated,
    ownersLinked,
    // A-2b: 保存成功時は attachmentId。owner反映/PDF保存のスキップは warning。
    ...(attachmentId ? { attachmentId } : {}),
    ...(warning ? { warning } : {}),
  };
}
