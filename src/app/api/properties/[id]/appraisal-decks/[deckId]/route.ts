/**
 * 「査定のご報告」1件(2026-11-10)。
 * GET   … 読み取った数字・担当者の修正・重ねた値
 * PATCH { overrides } … 担当者の修正を丸ごと置き換える。確認済みの資料を直すと下書きに戻る。
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, parseJsonBody, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { assertAppraisalDeckAccess } from "@/lib/appraisal-deck/access";
import { appraisalOverridesSchema, mergeAppraisal } from "@/lib/appraisal-deck/overrides";
import type { AppraisalExtract } from "@/lib/appraisal-deck/parse";

type Ctx = { params: Promise<{ id: string; deckId: string }> };

const patchSchema = z.object({ overrides: appraisalOverridesSchema }).strict();

async function loadDeckOrThrow(propertyId: string, deckId: string) {
  const deck = await prisma.appraisalDeck.findFirst({
    where: { id: deckId, propertyId },
    select: {
      id: true,
      propertyId: true,
      status: true,
      sourceAttachmentId: true,
      parserVersion: true,
      extracted: true,
      overrides: true,
      createdAt: true,
      updatedAt: true,
      confirmedAt: true,
    },
  });
  if (!deck) throw new ApiError(404, "資料が見つかりません", "NOT_FOUND");
  // 周辺地図(2026-11-11)は大きいので中身は読まず、あるかどうかと物件に座標があるかどうかだけ返す(座標の値は返さない)。
  const [mapCount, property] = await Promise.all([
    prisma.appraisalDeck.count({ where: { id: deck.id, mapData: { not: Prisma.DbNull } } }),
    prisma.property.findUnique({ where: { id: propertyId }, select: { gpsLat: true, gpsLng: true, address: true } }),
  ]);
  // GPS 座標がなくても住所があれば住所から地図を作れる(2026-11-11)。住所そのものは返さない。
  return {
    ...deck,
    hasMap: mapCount > 0,
    hasLocation: property?.gpsLat != null && property?.gpsLng != null,
    hasAddress: !!property?.address?.trim(),
  };
}

function view(deck: Awaited<ReturnType<typeof loadDeckOrThrow>>) {
  const extracted = deck.extracted as unknown as AppraisalExtract;
  const parsed = appraisalOverridesSchema.safeParse(deck.overrides ?? {});
  const overrides = parsed.success ? parsed.data : {};
  return { ...deck, overrides, merged: mergeAppraisal(extracted, overrides) };
}

export async function GET(_request: Request, { params }: Ctx) {
  try {
    const { id, deckId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    await assertAppraisalDeckAccess(session, permissions, id, "read");
    return apiResponse({ deck: view(await loadDeckOrThrow(id, deckId)) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { id, deckId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    await assertAppraisalDeckAccess(session, permissions, id, "write");
    const parsed = patchSchema.safeParse(await parseJsonBody(request));
    if (!parsed.success) {
      throw new ApiError(422, parsed.error.issues[0]?.message ?? "入力を確かめてください", "VALIDATION_ERROR");
    }
    const before = await loadDeckOrThrow(id, deckId);
    // 確認済みの資料を直したら、もう一度確かめるまで下書きに戻す(確かめていない数字をお客様に見せない)。
    await prisma.appraisalDeck.update({
      where: { id: before.id },
      data: {
        overrides: parsed.data.overrides as object,
        updatedBy: session.id,
        status: "draft",
        confirmedBy: null,
        confirmedAt: null,
      },
    });
    await writeAuditLog({
      userId: session.id,
      action: "update",
      targetTable: "appraisal_decks",
      targetId: before.id,
      detail: {
        propertyId: id,
        fields: Object.keys(parsed.data.overrides).length,
        unconfirmed: before.status === "confirmed",
      },
    });
    return apiResponse({ deck: view(await loadDeckOrThrow(id, deckId)) });
  } catch (error) {
    return handleApiError(error);
  }
}
