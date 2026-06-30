import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession, getUserPermissions, getOwnerDisplayConfig, handleApiError, ApiError, parseJsonBody,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { propertyListQuerySchema } from "@/lib/validators";
import { buildPropertyListWhere, buildPropertyListOrderBy } from "@/lib/property-list-query";
import { isPlainOwnerLevel, type DmRowPropertyOwner } from "@/lib/dm-export";
import { saleDmCampaignBodySchema } from "@/lib/validators-sale-dm";
import { buildRecipientsFromProperties } from "@/lib/sale-dm-letter/recipients";
import { resolveSender, isSenderConfigured } from "@/lib/sale-dm-letter/sender";
import { generateLetters, isSaleDmConfigured, MAX_GENERATE_ITEMS, DEFAULT_MODEL } from "@/lib/sale-dm-letter";
import { resolveTrackingBaseUrl, resolveLpUrl } from "@/lib/sale-dm-letter/tracking";
import { SaleDmError } from "@/lib/sale-dm-letter/types";
import { randomBytes } from "crypto";

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 権限ゲート(副作用なし)。dm-export と同一の4種。
    if (!hasPermission(permissions, "property", "read")) throw new ApiError(403, "物件一覧の閲覧権限がありません", "FORBIDDEN");
    if (!hasPermission(permissions, "csv_export", "read")) throw new ApiError(403, "CSV エクスポートの権限がありません", "FORBIDDEN");
    if (!hasPermission(permissions, "csv_export_personal", "read")) throw new ApiError(403, "個人情報を含む出力の権限がありません", "FORBIDDEN");
    if (!hasPermission(permissions, "owner", "read")) throw new ApiError(403, "所有者情報の閲覧権限がありません", "FORBIDDEN");
    // AI生成は課金 + オーナーPII を外部AIへ送るため、専用権限 sale_dm:generate を必須化(謄本自動取得と同方針)。
    // read系/CSV権限だけで誰でも有料生成を実行できないようにする(admin が明示付与する高リスク操作)。
    if (!hasPermission(permissions, "sale_dm", "generate")) throw new ApiError(403, "AIによるDM生成の権限がありません", "FORBIDDEN");

    const ownerDisplayConfig = await getOwnerDisplayConfig(session.id, permissions);
    if (!isPlainOwnerLevel(ownerDisplayConfig.name) || !isPlainOwnerLevel(ownerDisplayConfig.zip) || !isPlainOwnerLevel(ownerDisplayConfig.address)) {
      throw new ApiError(403, "DM作成に必要な所有者情報(氏名・郵便番号・住所)の表示権限がありません", "FORBIDDEN");
    }

    // env 未設定なら fail-closed(503)。DB に何も書かない。
    if (!isSaleDmConfigured()) throw new ApiError(503, "売却DM生成が未設定です", "NOT_CONFIGURED");
    // 印刷の郵送QRには絶対URL(SALE_DM_TRACKING_BASE_URL / SALE_DM_LP_URL)が必須。これらが未設定/不正だと、
    // 生成(課金)しても印刷 route が 503 で出力できず、印刷不能な下書きに課金されるだけになる。有料生成の前に
    // 印刷必須URLも確認し、揃っていなければ生成を始めずに fail-closed(503)する(印刷 route と同じ前提)。
    if (!resolveTrackingBaseUrl() || !resolveLpUrl()) {
      throw new ApiError(503, "印刷に必要なURL(SALE_DM_TRACKING_BASE_URL / SALE_DM_LP_URL)が未設定です", "PRINT_URL_NOT_CONFIGURED");
    }

    // 不正JSON は parseJsonBody で 400(request.json() の素の 500 を避ける。他 mutation route と統一)。
    const body = saleDmCampaignBodySchema.parse(await parseJsonBody(request));
    // 課金確認: 最大50通の有料AI呼び出し + オーナーPII の外部送信を伴うため、明示確認(confirmed:true)を要求。
    // 謄本自動取得の confirmed ゲートと同方針(UI は実行前に確認ダイアログを出してから true を送る)。
    if (body.confirmed !== true) {
      throw new ApiError(400, "AI生成には課金確認(confirmed:true)が必要です", "SALE_DM_CONFIRMATION_REQUIRED");
    }
    // 差出人は env 既定(SALE_DM_SENDER_NAME/CONTACT)のみを使う。印刷・再生成も resolveSender(env)を使い、
    // body 指定の差出人は保存されず印刷で env 既定にズレる(不整合)ため、body の抜け道は塞ぎ env を必須にする。
    // 未設定なら使えない手紙を有料生成しないよう生成前に fail-closed(503・印刷URL チェックと同方針・Codex R33)。
    if (!isSenderConfigured()) {
      throw new ApiError(503, "差出人情報(SALE_DM_SENDER_NAME / SALE_DM_SENDER_CONTACT)が未設定です", "SENDER_NOT_CONFIGURED");
    }
    // 冪等性: client が作成試行ごとに安定生成したキー。同キーで既に作成済みなら、有料生成を再実行せず
    // 既存 campaign を返す(再送信/別タブ/連打での二重課金・二重作成を防ぐ)。キー未指定なら従来通り。
    const idempotencyKey = body.idempotencyKey;
    if (idempotencyKey) {
      const existing = await prisma.dmCampaign.findUnique({ where: { idempotencyKey }, select: { id: true, createdBy: true, status: true, createdAt: true } });
      if (existing) {
        if (existing.createdBy !== session.id) throw new ApiError(409, "この作成キーは既に使用されています", "IDEMPOTENCY_CONFLICT");
        // status!=="draft"(=ready 以降)= 生成+保存が完了済み → そのまま返す(冪等)。
        if (existing.status !== "draft") {
          return NextResponse.json({ campaignId: existing.id, idempotent: true }, { headers: { "Cache-Control": "no-store" } });
        }
        // status==="draft" = クレーム後・保存完了前。並行生成中(ライブ)か、プロセス死の孤児か区別が要る。
        // 生成は数分以内に完了するため、生成時間を大きく超えて古い(STALE_MS 超)draft のみ孤児として削除し作り直す。
        // まだ新しい draft は並行生成中とみなし削除せず 409(再試行を促す。完了すれば ready で冪等返却)。ライブの
        // クレームを消すと同キーの2リクエストが二重に有料生成し冪等性が破れる(Codex 指摘)ため、必ず新旧を判定する。
        const STALE_MS = 10 * 60 * 1000;
        if (Date.now() - new Date(existing.createdAt).getTime() < STALE_MS) {
          throw new ApiError(409, "同じ作成キーの処理が進行中です。少し待って再試行してください", "CAMPAIGN_PROCESSING");
        }
        await prisma.dmCampaign.delete({ where: { id: existing.id } }).catch(() => {});
      }
    }
    const query = propertyListQuerySchema.parse(body.filters ?? {});
    // DM は送付可(dmStatus=send)の物件にのみ生成する。ユーザーの絞り込みが明示的に send 以外(hold/no_send)を
    // 指している場合、send へ黙って上書きすると、確認ダイアログの「現在の絞り込み対象」と実際の生成対象がずれ、
    // 意図しない物件へオーナーPII送信+課金が起きる。上書きせず 400 で弾き、確認した対象と一致させる。
    if (query.dmStatus !== undefined && query.dmStatus !== "send") {
      throw new ApiError(400, "送付可(dmStatus=send)以外の絞り込みではDMを作成できません", "INVALID_DM_STATUS_FILTER");
    }
    const { where, mgmtShortCircuitEmpty } = await buildPropertyListWhere(query, session);
    where.dmStatus = "send";
    where.isArchived = false;
    const orderBy = buildPropertyListOrderBy(query);

    const properties = mgmtShortCircuitEmpty ? [] : await prisma.property.findMany({
      where: {
        ...where,
        AND: [...(where.AND ?? []), { propertyOwners: { some: { owner: { isArchived: false, address: { not: "" } } } } }],
      },
      select: {
        id: true, address: true, propertyType: true, roomNo: true,
        propertyOwners: {
          where: { owner: { isArchived: false } },
          select: { isPrimary: true, relationship: true, owner: { select: { id: true, name: true, nameKana: true, zip: true, address: true, corporateNumber: true } } },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        },
      },
      orderBy,
      take: MAX_GENERATE_ITEMS + 1,
    });

    const { recipients, meta } = buildRecipientsFromProperties(
      properties as never,
      ownerDisplayConfig,
    );

    // 差出人は env 既定(SALE_DM_SENDER_NAME/CONTACT)のみ。印刷・再生成も resolveSender(env)を使うため、
    // 生成も env 差出人で揃える(body 指定は非永続ゆえ使わない=印刷とのズレを防ぐ・Codex R33)。
    const sender = resolveSender();
    const genOptions = {
      ...body.options,
      senderName: sender.senderName,
      senderContact: sender.senderContact,
    };

    // 生成(課金)の前に campaign をクレーム(idempotencyKey の一意制約で同キーの二重生成を弾く)。
    // 並行リクエストは P2002 で1つに収束し、敗者は生成せず既存を返す(二重課金の防止)。
    let claimed: { id: string };
    try {
      claimed = await prisma.dmCampaign.create({
        data: { name: body.name, createdBy: session.id, filterSnapshot: body.filters ?? {}, idempotencyKey: idempotencyKey ?? null },
        select: { id: true },
      });
    } catch (e) {
      if (idempotencyKey && e && typeof e === "object" && (e as { code?: unknown }).code === "P2002") {
        const won = await prisma.dmCampaign.findUnique({ where: { idempotencyKey }, select: { id: true, createdBy: true, status: true } });
        if (won) {
          if (won.createdBy !== session.id) throw new ApiError(409, "この作成キーは既に使用されています", "IDEMPOTENCY_CONFLICT");
          // 完了済み(ready 以降)なら冪等返却。status==="draft"=並行勝者が生成中(未完)→ 勝者の生成を壊さない
          // よう削除せず、少し待っての再試行を促す(完了すれば ready で冪等返却される・R34)。
          if (won.status !== "draft") {
            return NextResponse.json({ campaignId: won.id, idempotent: true }, { headers: { "Cache-Control": "no-store" } });
          }
          throw new ApiError(409, "同じ作成キーの処理が進行中です。少し待って再試行してください", "CAMPAIGN_PROCESSING");
        }
      }
      throw e;
    }

    // クレーム確保後に生成+保存。途中で失敗(生成の総失敗 / 保存トランザクション失敗=対象物件の削除・FK・DB
    // エラー等)したらクレームを削除し、孤児 campaign(空)を残さない。UI は失敗後に同じ idempotencyKey で再試行
    // するため、空 campaign が残ると壊れた空キャンペーンに遷移してしまう。削除すれば再クレーム→再生成できる(R33)。
    let drafts: Awaited<ReturnType<typeof generateLetters>>["drafts"];
    let truncated: boolean;
    try {
      const result = await generateLetters(recipients.map((r) => ({ recipient: r, options: genOptions })));
      drafts = result.drafts;
      truncated = result.truncated;

      // 既定型 A(1つ)+ 宛先下書きを、クレーム済み campaign 配下に保存(生成成功分のみ body 入り。失敗分は空+メモ)。
      // 複数型(B/C)の追加と再割当は variants / assign route で行う。生成 route は「初期1型」を保証するのみ。
      // A/B 純度は割り当てられた variantId 基準(個別 override は本文の微修正で集計に影響しない)。
      await prisma.$transaction(async (tx) => {
        const variant = await tx.dmVariant.create({
          data: {
            campaignId: claimed.id, label: "A",
            designTemplate: body.options.designTemplate, tone: body.options.tone,
            length: body.options.length, appeal: body.options.appeal,
            strength: body.options.strength, extraInstruction: body.options.extraInstruction ?? null,
          },
        });
        const sliced = meta.slice(0, drafts.length);
        for (let i = 0; i < sliced.length; i++) {
          const d = drafts[i];
          await tx.dmRecipientDraft.create({
            data: {
              campaignId: claimed.id, variantId: variant.id, propertyId: sliced[i].propertyId,
              representativeOwnerId: sliced[i].representativeOwnerId,
              recipientName: sliced[i].recipientName, recipientZip: sliced[i].recipientZip,
              recipientAddress: sliced[i].recipientAddress, honorific: sliced[i].honorific,
              coOwnerCount: sliced[i].coOwnerCount,
              body: d.body ?? "", model: process.env.SALE_DM_LETTER_MODEL ?? DEFAULT_MODEL,
              outcomeNote: d.error ? `生成失敗(${d.error})` : null,
              trackingToken: randomBytes(8).toString("base64url"),
              generatedBy: session.id,
            },
          });
        }
        // 生成+保存が完了したのでキャンペーンを ready にする(drafts と同一トランザクションでアトミックに確定)。
        // idempotency の pre-check / P2002 はこの完了マーカーで「冪等返却(ready)」と「孤児削除→作り直し(draft)」
        // を区別する。途中でプロセスが落ちれば status は draft のままで孤児として検出・回収される(R34)。
        await tx.dmCampaign.update({ where: { id: claimed.id }, data: { status: "ready" } });
      });
    } catch (e) {
      // 生成 or 保存の失敗 → クレームを削除(孤児の空 campaign を残さない。再試行で再クレームできる)。
      await prisma.dmCampaign.delete({ where: { id: claimed.id } }).catch(() => {});
      throw e;
    }

    // AuditLog は非PIIメタのみ(本文・宛名・住所は残さない)。
    await writeAuditLog({
      userId: session.id, action: "sale_dm_campaign_create", targetTable: "dm_campaigns",
      detail: { campaignId: claimed.id, requested: recipients.length, generated: drafts.length, failed: drafts.filter((d) => d.error).length, truncated, createdAt: new Date().toISOString() },
    });

    return NextResponse.json(
      { campaignId: claimed.id, generated: drafts.length, failed: drafts.filter((d) => d.error).length, truncated },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SaleDmError && error.code === "NOT_CONFIGURED") {
      return handleApiError(new ApiError(503, "売却DM生成が未設定です", "NOT_CONFIGURED"));
    }
    return handleApiError(error);
  }
}
