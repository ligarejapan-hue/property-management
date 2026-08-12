/**
 * 謄本 一括取得(PR-B・薄い版)のジョブ操作(provider を呼ばない DB ロジック)。
 *
 *  - createBulkFetchJob: 選択物件から項目を作る(≤50件・可視物件のみ・番号あり/所在不足は即 skipped)
 *  - getBulkJobProgress: ⚠**毎回 可視項目でフィルタし件数を再計算**(伏せた物件の結果を数字から漏らさない)
 *  - cancelBulkJob / resumeBulkJob: 作成者本人のみ(薄い版は管理者代行=registry:manage を作らない)
 *
 * ⚠進捗は保存済み counts を返さず、可視項目集合から都度計算する(@codex 設計指摘)。
 */
import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { buildRegistrySearchRequest } from "@/lib/registry-fetch/search-request";
import { hashPropertyFingerprint } from "@/lib/registry-fetch/candidate-cache";
import type { RegistryCertificateType } from "@/lib/registry-fetch/types";
import {
  MAX_BULK_ITEMS,
  UUID_RE,
  assertJobId,
  type BulkItemStatus,
  type BulkJobStatus,
} from "./types";

interface BulkSession {
  id: string;
  role: string;
}

/** 進捗の件数(可視項目から再計算した値)。 */
export interface BulkJobCounts {
  total: number;
  pending: number;
  processing: number;
  done: number;
  failed: number;
  skipped: number;
  chargedButFailed: number;
}

/** 進捗応答(非PII: 物件の所在・地番・所有者名は載せない)。 */
export interface BulkJobProgress {
  jobId: string;
  status: BulkJobStatus;
  certificateType: RegistryCertificateType;
  pausedReason: string | null;
  activeItemId: string | null;
  counts: BulkJobCounts;
  items: Array<{
    id: string;
    propertyId: string | null;
    status: BulkItemStatus;
    errorCode: string | null;
  }>;
}

/** 可視項目集合から件数を数え直す(保存済み counts は使わない)。 */
function recomputeCounts(
  items: Array<{ status: string }>,
): BulkJobCounts {
  const c: BulkJobCounts = {
    total: items.length,
    pending: 0,
    processing: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    chargedButFailed: 0,
  };
  for (const it of items) {
    switch (it.status) {
      case "pending": c.pending++; break;
      case "processing": c.processing++; break;
      case "done": c.done++; break;
      case "failed": c.failed++; break;
      case "skipped": c.skipped++; break;
      case "charged_but_failed": c.chargedButFailed++; break;
    }
  }
  return c;
}

export interface CreateBulkFetchJobArgs {
  session: BulkSession;
  propertyIds: string[];
  certificateType: RegistryCertificateType;
  /** 二重作成防止キー(POST 応答が失われて再送しても同じジョブへ冪等化)。 */
  idempotencyKey?: string | null;
  /**
   * ⚠画面が承認した内容の指紋(物件ID → digest・任意)。
   *
   * 確認画面は「土地の登記を取得します」のように**何を買うか**を見せて承認を取る。
   * その表示から作成までの間に他の担当者が住所や番号を変えると、作成時に読み直した
   * **新しい値**で指紋が作られ、処理は「変わっていない」と判断して自動購入まで進む
   * (例: 承認したのは土地なのに、家屋番号が足されて建物を買う)。
   * 一致しない物件は対象外にして、もう一度確認してもらう(@codex #373 R6 P1)。
   */
  approvedFingerprints?: Record<string, string>;
}

/** ジョブの項目 status から作成結果の件数を組む(冪等ヒット時の返却にも使う)。 */
function summarizeCreate(
  jobId: string,
  items: Array<{ status: string }>,
  excluded: number,
): CreateBulkFetchJobResult {
  let pending = 0;
  let skipped = 0;
  for (const it of items) {
    if (it.status === "pending") pending++;
    else if (it.status === "skipped") skipped++;
  }
  return { jobId, total: items.length, pending, skipped, excluded };
}

export interface CreateBulkFetchJobResult {
  jobId: string;
  total: number;
  pending: number;
  skipped: number;
  /** 権限が無い/存在しない等でジョブに含めなかった件数。 */
  excluded: number;
}

/**
 * 選択物件から一括ジョブを作る。可視物件だけを項目化し、番号あり/所在不足の物件は
 * provider を呼ばずに即 skipped(要手動)にする。件数上限は 50。
 */
export async function createBulkFetchJob(
  args: CreateBulkFetchJobArgs,
): Promise<CreateBulkFetchJobResult> {
  const { session, certificateType } = args;
  const ids = [
    ...new Set(
      (args.propertyIds ?? []).filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      ),
    ),
  ];
  if (ids.length === 0) {
    throw new ApiError(
      400,
      "取得する物件が選択されていません",
      "REGISTRY_BULK_NO_TARGETS",
    );
  }
  if (ids.length > MAX_BULK_ITEMS) {
    throw new ApiError(
      400,
      `一度に取得できるのは${MAX_BULK_ITEMS}件までです。分けて実行してください`,
      "REGISTRY_BULK_TOO_MANY",
    );
  }
  // ⚠UUID でない物件IDは DB 照会前に 400 で弾く(@codex #361 P2)。@db.Uuid 列へ渡すと
  //   Prisma P2023 で 500 になる。指紋計算・findMany の前に検証する。
  if (!ids.every((id) => UUID_RE.test(id))) {
    throw new ApiError(
      400,
      "物件の指定が不正です",
      "REGISTRY_BULK_INVALID_PROPERTY_ID",
    );
  }

  const idemKey = args.idempotencyKey?.trim() || null;
  // 要求内容の指紋(対象物件の集合 + 種別)。同じキーで違う要求が来たら弾くための照合値。
  const fingerprint = createHash("sha256")
    .update(`${[...ids].sort().join(",")}|${certificateType}`)
    .digest("hex")
    .slice(0, 32);

  // 冪等: 同じキーの既存ジョブがあれば作らずそれを返す(再送で二重ジョブを作らない)。
  if (idemKey) {
    const existing = await prisma.registryFetchJob.findUnique({
      where: { requestedById_idempotencyKey: { requestedById: session.id, idempotencyKey: idemKey } },
      include: { items: { select: { status: true } } },
    });
    if (existing) {
      // ⚠同じキーが**違う要求**(選択物件/種別を変えて再送)に使い回された場合は、古いジョブを
      // 返さず弾く(@codex #361 P2)。利用者の最新の確認と処理内容が食い違うのを防ぐ。
      if (existing.requestFingerprint && existing.requestFingerprint !== fingerprint) {
        throw new ApiError(
          409,
          "同じ操作キーで内容の異なる取得が要求されました。もう一度やり直してください",
          "REGISTRY_BULK_IDEMPOTENCY_MISMATCH",
        );
      }
      return summarizeCreate(existing.id, existing.items, 0);
    }
  }

  // 検索キーの最小カラムのみ(所有者PIIは取らない)。
  const props = await prisma.property.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      createdBy: true,
      assignedTo: true,
      address: true,
      lotNumber: true,
      buildingNumber: true,
      realEstateNumber: true,
    },
  });

  // 可視物件だけを対象にする(見えない/存在しない物件は excluded として件数だけ返す)。
  const visible = props.filter((p) => canAccessPropertyRecord(session, p));
  const excluded = ids.length - visible.length;
  if (visible.length === 0) {
    throw new ApiError(
      403,
      "取得できる物件がありません(権限が無いか、存在しない物件です)",
      "REGISTRY_BULK_NO_VISIBLE",
    );
  }

  // 番号あり/所在不足は provider を呼ばずに skipped(要手動)。所在検索できる物件だけ pending。
  const itemsData = visible.map((p) => {
    const built = buildRegistrySearchRequest({
      address: p.address,
      lotNumber: p.lotNumber,
      buildingNumber: p.buildingNumber,
      realEstateNumber: p.realEstateNumber,
      ref: p.id,
    });
    const fingerprintHash = hashPropertyFingerprint(p);
    // ⚠承認した内容から変わっていたら、その物件だけ対象外にする。
    //   「消えた」ではなく「変わった」なので理由コードを分ける(処理時と同じ)。
    const approved = args.approvedFingerprints?.[p.id];
    const changedSinceApproval = !!approved && approved !== fingerprintHash;
    const status: BulkItemStatus =
      built.searchable && !changedSinceApproval ? "pending" : "skipped";
    return {
      propertyId: p.id,
      status,
      errorCode: changedSinceApproval
        ? "identifier_changed"
        : built.searchable
          ? null
          : built.reason,
      // ⚠作成時点の「検索に渡すもの一式」を控える(設計 §3.1.0.1)。
      //   一括は作成から処理までに時間が空く。その間に**別の正しい値へ**
      //   書き換わっても、番号の有無/形式の検査は素通りし、候補が1件なら
      //   **確認したのと別の筆**を自動で買う。
      //   材料は住所・地番・家屋番号・不動産番号(= 処理時に検索へ渡るものと同じ)。
      //   ⚠地番は秘匿情報なので**値は残さない**(sha256 の先頭32桁だけ)。
      propertyFingerprintHash: fingerprintHash,
    };
  });
  const preSkipped = itemsData.filter((i) => i.status === "skipped").length;
  const pendingCount = itemsData.length - preSkipped;

  try {
    const job = await prisma.$transaction(async (tx) => {
      const created = await tx.registryFetchJob.create({
        data: {
          status: "pending",
          certificateType,
          requestedById: session.id,
          idempotencyKey: idemKey,
          requestFingerprint: fingerprint,
          total: itemsData.length,
          skipped: preSkipped,
        },
      });
      await tx.registryFetchJobItem.createMany({
        data: itemsData.map((i) => ({
          jobId: created.id,
          propertyId: i.propertyId,
          status: i.status,
          errorCode: i.errorCode,
          propertyFingerprintHash: i.propertyFingerprintHash,
          processedAt: i.status === "skipped" ? new Date() : null,
        })),
      });
      return created;
    });

    return { jobId: job.id, total: itemsData.length, pending: pendingCount, skipped: preSkipped, excluded };
  } catch (e) {
    // レース: 同じキーで別リクエストが先に作成した(一意制約違反 P2002)→ 既存を返す。
    if (idemKey && (e as { code?: string }).code === "P2002") {
      const existing = await prisma.registryFetchJob.findUnique({
        where: { requestedById_idempotencyKey: { requestedById: session.id, idempotencyKey: idemKey } },
        include: { items: { select: { status: true } } },
      });
      if (existing) {
        if (existing.requestFingerprint && existing.requestFingerprint !== fingerprint) {
          throw new ApiError(
            409,
            "同じ操作キーで内容の異なる取得が要求されました。もう一度やり直してください",
            "REGISTRY_BULK_IDEMPOTENCY_MISMATCH",
          );
        }
        return summarizeCreate(existing.id, existing.items, excluded);
      }
    }
    throw e;
  }
}

/** ジョブを作成者本人に限定して読み込む(共通ガード)。 */
async function loadOwnedJob(session: BulkSession, jobId: string) {
  assertJobId(jobId);
  const job = await prisma.registryFetchJob.findUnique({
    where: { id: jobId },
  });
  if (!job) {
    throw new ApiError(404, "ジョブが見つかりません", "NOT_FOUND");
  }
  // 薄い版は作成者本人のみ(管理者代行=registry:manage は見送り)。
  if (job.requestedById !== session.id) {
    throw new ApiError(
      403,
      "このジョブを操作する権限がありません",
      "FORBIDDEN",
    );
  }
  return job;
}

/**
 * 進捗を返す。⚠**毎回 項目ごとに canAccessPropertyRecord で再検証しフィルタ**し、
 * 件数も可視項目から再計算する(作成後に担当替え/削除された物件の結果を漏らさない)。
 */
export async function getBulkJobProgress(args: {
  session: BulkSession;
  jobId: string;
}): Promise<BulkJobProgress> {
  const { session, jobId } = args;
  assertJobId(jobId);
  const job = await prisma.registryFetchJob.findUnique({
    where: { id: jobId },
    include: {
      items: {
        orderBy: { createdAt: "asc" },
        include: {
          property: { select: { createdBy: true, assignedTo: true } },
        },
      },
    },
  });
  if (!job) {
    throw new ApiError(404, "ジョブが見つかりません", "NOT_FOUND");
  }
  if (job.requestedById !== session.id) {
    throw new ApiError(
      403,
      "このジョブを操作する権限がありません",
      "FORBIDDEN",
    );
  }

  // 物件が削除された(SetNull で property=null)/担当替えで見えなくなった項目は伏せる。
  const visibleItems = job.items.filter((it) => {
    if (!it.property) return false;
    return canAccessPropertyRecord(session, it.property);
  });

  return {
    jobId: job.id,
    status: job.status as BulkJobStatus,
    certificateType: job.certificateType as RegistryCertificateType,
    pausedReason: job.pausedReason,
    activeItemId: job.activeItemId,
    counts: recomputeCounts(visibleItems),
    items: visibleItems.map((it) => ({
      id: it.id,
      propertyId: it.propertyId,
      status: it.status as BulkItemStatus,
      errorCode: it.errorCode,
    })),
  };
}

/**
 * ジョブを中止する(作成者本人のみ)。⚠**節目で止まる**=実行中の1件は最後まで進み
 * (課金済みはそのまま)、新しい項目は掴まれない。status を cancelled にするだけで、
 * 実行中項目の activeItemId は触らない(走っている process が最終化して外す)。
 */
export async function cancelBulkJob(args: {
  session: BulkSession;
  jobId: string;
}): Promise<{ status: BulkJobStatus }> {
  await loadOwnedJob(args.session, args.jobId);
  const upd = await prisma.registryFetchJob.updateMany({
    where: {
      id: args.jobId,
      status: { in: ["pending", "processing", "paused"] },
    },
    data: { status: "cancelled", completedAt: new Date() },
  });
  if (upd.count === 0) {
    // 既に完了/中止済み。現状を返す(冪等)。
    const job = await prisma.registryFetchJob.findUnique({
      where: { id: args.jobId },
    });
    return { status: (job?.status ?? "cancelled") as BulkJobStatus };
  }
  return { status: "cancelled" };
}

/**
 * 一時停止(charged_but_failed 等)したジョブを再開する(作成者本人のみ)。
 * paused → pending に戻し、残りの pending 項目の処理を再開できるようにする。
 */
export async function resumeBulkJob(args: {
  session: BulkSession;
  jobId: string;
}): Promise<{ status: BulkJobStatus }> {
  await loadOwnedJob(args.session, args.jobId);
  const upd = await prisma.registryFetchJob.updateMany({
    where: { id: args.jobId, status: "paused" },
    data: { status: "pending", pausedReason: null, activeItemId: null },
  });
  if (upd.count === 0) {
    throw new ApiError(
      409,
      "このジョブは再開できる状態ではありません",
      "REGISTRY_BULK_NOT_RESUMABLE",
    );
  }
  return { status: "pending" };
}
