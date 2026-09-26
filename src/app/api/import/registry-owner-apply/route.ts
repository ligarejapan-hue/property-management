/**
 * 添付済みの謄本(所有者事項)から、**所有者が空の物件をまとめて**埋める受付。
 *
 * 背景: 「謄本はあるのに所有者が空」の物件が本番に1,821件ある(2026-09-26 実測)。
 * 1件ずつのボタンと**同じ共通処理**を、裏で1件ずつ順番に呼ぶ。
 *
 *   GET  … 対象の件数を返すだけ(何も保存しない)
 *   POST … 取込ジョブを作り、裏の処理(ワーカー)に渡して 202 を返す
 *
 * ⚠取込記録の種別は既存の「所有者事項PDF一括」に**相乗り**する(データベースの
 *   種別を増やさない)。行は印で見分ける → `registry-owner-bulk/marker.ts`
 * ⚠**同時に2つ走らせない**。処理中のときは受け付けない(同じ物件を2回拾って
 *   「すでに所有者あり」の行が並ぶのを避ける+サーバ負荷の平準化)。
 * ⚠取込記録・監査に**所有者の氏名・住所は残さない**。行に残すのは物件IDと
 *   物件の住所(結果の一覧で「どの物件か」を示すため)だけ。
 */
import type { NextRequest } from "next/server";

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  enqueueRegistryPdfBulkJob,
  isRegistryPdfBulkWorkerBusy,
} from "@/lib/registry-pdf-bulk/worker";
import {
  REGISTRY_OWNER_APPLY_JOB_TYPE,
  REGISTRY_OWNER_APPLY_KIND,
  REGISTRY_OWNER_APPLY_KIND_KEY,
} from "@/lib/registry-owner-bulk/marker";
import {
  REGISTRY_OWNER_APPLY_DEFAULT_LIMIT,
  REGISTRY_OWNER_APPLY_MAX_LIMIT,
  buildRegistryOwnerApplyRowSeeds,
  parseRegistryOwnerApplyLimit,
} from "@/lib/registry-owner-bulk/plan";
import {
  REGISTRY_OWNER_APPLY_PERM_MESSAGES,
  findMissingRegistryOwnerApplyPerm,
} from "@/lib/registry-owner-bulk/permissions";

/** 取込記録に残す名前。⚠添付の生ファイル名は使わない(PIIを含みうる)。 */
const JOB_LABEL = "謄本から所有者をまとめて反映";

/**
 * 受付を直列化するための**助言ロック**の鍵(この機能だけの固定値)。
 *
 * ⚠「終わっていないジョブが無いか」を読んでから作るまでの間に、もう1回押されると
 *   両方とも通ってジョブが2本できる(2本目は全行「すでに所有者あり」で埋まる)。
 *   読み取りと作成を1つのトランザクションに入れても、**読みは互いをブロックしない**
 *   ので防げない。データベース側の助言ロックで「同時に1人だけ」にする。
 *   トランザクションの終わりで自動的に解放される(明示的な解放は不要)。
 */
const ADMISSION_LOCK_KEY = 7314441;

/** 対象の謄本の条件(所有者事項・削除されていない)。 */
const OWNER_REGISTRY_ATTACHMENT = {
  type: "registry",
  isDeleted: false,
  registryCertificateType: "owner",
} as const;

/** 権限を確かめる(管理者+取込+所有者の編集+氏名・住所の項目権限)。 */
async function assertCanApply() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  const missing = findMissingRegistryOwnerApplyPerm(session.role, perms);
  if (missing) {
    throw new ApiError(403, REGISTRY_OWNER_APPLY_PERM_MESSAGES[missing], "FORBIDDEN");
  }
  return { session, perms };
}

/** 対象の物件数(所有者が空 かつ 所有者事項の謄本あり)。 */
function countTargets() {
  return prisma.property.count({
    where: {
      propertyOwners: { none: {} },
      attachments: { some: { ...OWNER_REGISTRY_ATTACHMENT } },
    },
  });
}

/** 対象件数を返す(保存しない)。 */
export async function GET() {
  try {
    await assertCanApply();
    const targetCount = await countTargets();
    return apiResponse({
      targetCount,
      defaultLimit: REGISTRY_OWNER_APPLY_DEFAULT_LIMIT,
      maxLimit: REGISTRY_OWNER_APPLY_MAX_LIMIT,
      // ほかの取込が動いているか(動いている間は実行できない)
      busy: isRegistryPdfBulkWorkerBusy(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/** まとめて反映を始める。 */
export async function POST(request: NextRequest) {
  try {
    const { session } = await assertCanApply();

    // ⚠本文が**無い**ときだけ既定の件数にする。読めない本文(壊れたJSON・オブジェクト
    //   以外)は 400。「指定なし」と同じに扱うと、壊れたリクエストで既定の件数ぶんの
    //   書き込みが始まってしまう(@codex 第7R)。
    const text = await request.text();
    let body: { limit?: unknown } = {};
    if (text.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ApiError(400, "リクエストの内容を読み取れませんでした", "VALIDATION_ERROR");
      }
      body = parsed as { limit?: unknown };
    }
    const limit = parseRegistryOwnerApplyLimit(body.limit);
    if (limit === null) {
      throw new ApiError(
        400,
        `今回処理する件数は 1〜${REGISTRY_OWNER_APPLY_MAX_LIMIT} の整数で指定してください`,
        "VALIDATION_ERROR",
      );
    }

    // ワーカーが動いている間は受け付けない(サーバ負荷の平準化・同一プロセス前提)
    if (isRegistryPdfBulkWorkerBusy()) {
      throw new ApiError(
        409,
        "ほかの取込を処理中です。終わってからもう一度実行してください",
        "IMPORT_BUSY",
      );
    }

    // ⚠**受付の判定と作成を1つのトランザクション+助言ロックで直列化する**。
    //   同時に2回押されても、ロックを取れなかった側は待たずに断る。
    const admitted = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${ADMISSION_LOCK_KEY}::bigint) AS locked
      `;
      if (!locked[0]?.locked) return { conflict: "busy" as const };

      // 終わっていない反映のジョブがあれば受け付けない。
      // ⚠**失敗(failed)でも未処理の行が残っているジョブは塞ぐ**。取込の記録の画面には
      //   未処理の行がある間「再開」ボタンが出るため、新しく始めてしまうと同じ物件を
      //   両方が拾い、片方が「すでに所有者あり」で埋まる。
      const unfinished = await tx.importJob.findFirst({
        where: {
          jobType: REGISTRY_OWNER_APPLY_JOB_TYPE,
          rows: {
            some: {
              rawData: {
                path: [REGISTRY_OWNER_APPLY_KIND_KEY],
                equals: REGISTRY_OWNER_APPLY_KIND,
              },
            },
          },
          OR: [
            { status: { in: ["pending", "processing"] } },
            { status: "failed", rows: { some: { status: "pending" } } },
          ],
        },
        select: { id: true },
      });
      if (unfinished) return { conflict: "unfinished" as const };

      // 対象を「謄本(添付)がいちばん古い順」に、**物件単位で**指定件数だけ取り出す。
      // ⚠添付の行に対して件数を絞ると、同じ物件の謄本が複数あるときに処理できる
      //   物件が指定件数より少なくなる(「全件」でも取りこぼす)。物件でまとめてから
      //   絞るため、ここは生SQLで数える。
      // ⚠前に**試して**要確認・失敗になった物件は**後ろに回す**。
      //   所有者が空で謄本も残るので毎回また選ばれ、謄本の古い順だと未着手の物件より
      //   先に並ぶ。同じように失敗する物件が件数ぶんたまると、実行しても前に進まなく
      //   なる(@codex 第7R/第9R)。除外はしない(未着手が尽きたら、また試す)。
      //   試したかは行の印(attempted)で見る。権限切れの中止で閉じた行は試していない
      //   ので印が無く、未着手と同じ扱いになる。
      const targets = await tx.$queryRaw<{ id: string; address: string | null }[]>`
        WITH attempted AS (
          SELECT DISTINCT lower(jr.raw_data->>'propertyId') AS property_id
          FROM import_job_rows jr
          JOIN import_jobs j ON j.id = jr.job_id
          WHERE j.job_type::text = ${REGISTRY_OWNER_APPLY_JOB_TYPE}
            -- ⚠「スキップ」「エラー確定」で状態が変わっても消えない印でも見分ける(@codex 第8R)
            AND (jr.status::text = 'needs_review' OR jr.raw_data->>'attempted' = '1')
            AND jr.raw_data->>(${REGISTRY_OWNER_APPLY_KIND_KEY}::text) = ${REGISTRY_OWNER_APPLY_KIND}
        )
        SELECT p.id::text AS id, p.address AS address
        FROM properties p
        JOIN attachments a
          ON a.property_id = p.id
         AND a.type = 'registry'
         AND a.is_deleted = false
         AND a.registry_certificate_type = 'owner'
        LEFT JOIN attempted r ON r.property_id = p.id::text
        WHERE NOT EXISTS (
          SELECT 1 FROM property_owners po WHERE po.property_id = p.id
        )
        GROUP BY p.id, p.address, r.property_id
        ORDER BY (r.property_id IS NOT NULL) ASC, MIN(a.created_at) ASC
        LIMIT ${limit}
      `;
      const seeds = buildRegistryOwnerApplyRowSeeds(
        targets.map((t) => ({ id: t.id, address: t.address })),
      );
      if (seeds.length === 0) return { empty: true as const };

      const job = await tx.importJob.create({
        data: {
          jobType: REGISTRY_OWNER_APPLY_JOB_TYPE,
          // ⚠固定の名前。添付の生ファイル名は使わない。
          fileName: JOB_LABEL,
          status: "pending",
          totalRows: seeds.length,
          executedBy: session.id,
        },
        select: { id: true },
      });
      await tx.importJobRow.createMany({
        data: seeds.map((seed) => ({
          jobId: job.id,
          rowNumber: seed.rowNumber,
          status: seed.status,
          rawData: seed.rawData,
        })),
      });
      return { jobId: job.id, totalRows: seeds.length };
    });

    if ("conflict" in admitted) {
      throw new ApiError(
        409,
        admitted.conflict === "unfinished"
          ? "まだ終わっていない反映があります。取込の記録で進み具合を確認してください"
          : "ほかの人が同じ操作を始めたところです。少し待ってからもう一度お試しください",
        admitted.conflict === "unfinished"
          ? "REGISTRY_OWNER_APPLY_IN_PROGRESS"
          : "IMPORT_BUSY",
      );
    }
    if ("empty" in admitted) {
      return apiResponse({ jobId: null, totalRows: 0 });
    }
    const job = { id: admitted.jobId };
    const seeds = { length: admitted.totalRows };

    await writeAuditLog({
      userId: session.id,
      action: "registry_owner_bulk_apply",
      targetTable: "import_jobs",
      targetId: job.id,
      // 非PII(件数とジョブIDだけ)
      detail: { jobId: job.id, totalRows: seeds.length },
    });

    // 裏の処理へ(既存の待機列に乗せる=同時に走る処理は常に1つ)
    enqueueRegistryPdfBulkJob(job.id);

    return apiResponse({ jobId: job.id, totalRows: seeds.length }, 202);
  } catch (error) {
    return handleApiError(error);
  }
}
