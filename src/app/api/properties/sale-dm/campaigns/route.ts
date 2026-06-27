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
import { resolveSender } from "@/lib/sale-dm-letter/sender";
import { generateLetters, isSaleDmConfigured, MAX_GENERATE_ITEMS, DEFAULT_MODEL } from "@/lib/sale-dm-letter";
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

    const ownerDisplayConfig = await getOwnerDisplayConfig(session.id, permissions);
    if (!isPlainOwnerLevel(ownerDisplayConfig.name) || !isPlainOwnerLevel(ownerDisplayConfig.zip) || !isPlainOwnerLevel(ownerDisplayConfig.address)) {
      throw new ApiError(403, "DM作成に必要な所有者情報(氏名・郵便番号・住所)の表示権限がありません", "FORBIDDEN");
    }

    // env 未設定なら fail-closed(503)。DB に何も書かない。
    if (!isSaleDmConfigured()) throw new ApiError(503, "売却DM生成が未設定です", "NOT_CONFIGURED");

    // 不正JSON は parseJsonBody で 400(request.json() の素の 500 を避ける。他 mutation route と統一)。
    const body = saleDmCampaignBodySchema.parse(await parseJsonBody(request));
    const query = propertyListQuerySchema.parse(body.filters ?? {});
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

    // 差出人は env 既定(SALE_DM_SENDER_NAME/CONTACT)を補完(body 指定があればそれを優先)。
    // 集計・型は variant 基準のため sender は letter 生成にのみ使う(再生成 route と同方針)。
    const sender = resolveSender();
    const genOptions = {
      ...body.options,
      senderName: body.options.senderName ?? sender.senderName,
      senderContact: body.options.senderContact ?? sender.senderContact,
    };

    const { drafts, truncated } = await generateLetters(
      recipients.map((r) => ({ recipient: r, options: genOptions })),
    );

    // キャンペーン + 既定型(1つ)+ 宛先下書きを保存(生成成功分のみ body 入り。失敗分は空+メモ)。
    const created = await prisma.$transaction(async (tx) => {
      const campaign = await tx.dmCampaign.create({
        data: { name: body.name, createdBy: session.id, filterSnapshot: body.filters ?? {} },
      });
      // 初期型 A を1つ作り、全宛先をこの型に割り当てる(初期=均等割り済みの1型)。
      // 複数型(B/C)の追加と再割当は POST /campaigns/[id]/variants(型 CRUD)+
      // POST /campaigns/[id]/assign(割当)で行う。生成 route は「初期1型」を保証するのみ。
      // A/B 純度は割り当てられた variantId 基準(個別 override は本文の微修正で集計に影響しない)。
      const variant = await tx.dmVariant.create({
        data: {
          campaignId: campaign.id, label: "A",
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
            campaignId: campaign.id, variantId: variant.id, propertyId: sliced[i].propertyId,
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
      return campaign;
    });

    // AuditLog は非PIIメタのみ(本文・宛名・住所は残さない)。
    await writeAuditLog({
      userId: session.id, action: "sale_dm_campaign_create", targetTable: "dm_campaigns",
      detail: { campaignId: created.id, requested: recipients.length, generated: drafts.length, failed: drafts.filter((d) => d.error).length, truncated, createdAt: new Date().toISOString() },
    });

    return NextResponse.json(
      { campaignId: created.id, generated: drafts.length, failed: drafts.filter((d) => d.error).length, truncated },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SaleDmError && error.code === "NOT_CONFIGURED") {
      return handleApiError(new ApiError(503, "売却DM生成が未設定です", "NOT_CONFIGURED"));
    }
    return handleApiError(error);
  }
}
