import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  parseJsonBody,
  apiResponse,
  handleApiError,
  ApiError,
} from "@/lib/api-helpers";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { classifyRegistryTarget } from "@/lib/registry-fetch/registry-target";
import { hashPropertyFingerprint } from "@/lib/registry-fetch/candidate-cache";
import { requireBulkSession } from "@/lib/registry-fetch/bulk/route-support";
import { publicRegistryLoginUrl } from "@/lib/registry-fetch/auto-fetch";
import { MAX_BULK_ITEMS, UUID_RE } from "@/lib/registry-fetch/bulk/types";

// ---------- POST /api/registry-fetch/preflight ----------
//
// 謄本取得(単発・所在検索・一括)の実行前警告の材料を返す(発注者要望 2026-08-08)。
// 「既に取得済み/所有者情報が入っている物件に課金する前に気づけるようにする」ための
// 読み取り専用 API。判定はここに一元化し、3つの入口(単発ボタン・所在検索ボタン・
// 一括モーダル)が同じ結果を表示する([同種の穴は全箇所]の原則)。
//
// - ゲート: registry:auto_fetch + property:read(単発/一括の取得routeと同型)。
// - 判定(非PII・フラグのみ):
//     registryObtained      = Property.registryStatus === "obtained"(登記状況バッジと同じ正)
//     hasRegistryAttachment = Attachment(type="registry", isDeleted:false, 物件宛)が存在
//     hasOwners             = PropertyOwner が1件以上(品質チェック NO_OWNER と同じ正)
//   3系統は一致しないことがある(手動マークのみ・手動取込のみ等)ため別々に返す。
// - 警告は情報提供のみで取得はブロックしない(意図した再取得は可能なまま)。
// - 30日購入台帳(purchaseKeyHash)は地番確定後にしか引けないため、この事前警告では
//   使わない(実行時の二重課金ガードは従来どおり auto-fetch 側で効く)。

export async function POST(request: NextRequest) {
  try {
    const session = await requireBulkSession();

    const body = (await parseJsonBody(request)) as {
      propertyIds?: unknown;
    };
    const rawIds = Array.isArray(body.propertyIds) ? body.propertyIds : [];
    const ids = [
      ...new Set(
        rawIds.filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        ),
      ),
    ];
    if (ids.length === 0) {
      throw new ApiError(400, "対象の物件が選択されていません", "REGISTRY_PREFLIGHT_NO_TARGETS");
    }
    if (ids.length > MAX_BULK_ITEMS) {
      throw new ApiError(
        400,
        `一度に確認できるのは ${MAX_BULK_ITEMS} 件までです`,
        "REGISTRY_PREFLIGHT_TOO_MANY",
      );
    }
    if (!ids.every((id) => UUID_RE.test(id))) {
      throw new ApiError(400, "物件IDの形式が不正です", "REGISTRY_PREFLIGHT_INVALID_PROPERTY_ID");
    }

    const properties = await prisma.property.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        createdBy: true,
        assignedTo: true,
        registryStatus: true,
        // ⚠「何を取りに行くか(土地/建物)」の判定に使う。値は返さない(秘匿)。
        propertyType: true,
        // ⚠分類に使う（値は返さない＝秘匿）。検索の入口は番号より先に住所を見る。
        address: true,
        lotNumber: true,
        buildingNumber: true,
        // ⚠あれば所在検索の対象外＝地番を尋ねてはいけない（設計 §3.1）。
        realEstateNumber: true,
        _count: { select: { propertyOwners: true } },
      },
    });

    const visible = properties.filter((p) =>
      canAccessPropertyRecord(session, p),
    );
    const excluded = ids.length - visible.length;

    // 謄本添付の有無(手動取込・exe一括取込分も含めて実物の添付で判定)。
    const registryAttachments = visible.length
      ? await prisma.attachment.findMany({
          where: {
            targetType: "property",
            targetId: { in: visible.map((p) => p.id) },
            type: "registry",
            isDeleted: false,
          },
          select: { targetId: true },
        })
      : [];
    const attachedSet = new Set(registryAttachments.map((a) => a.targetId));

    const data = visible.map((p) => ({
      propertyId: p.id,
      registryObtained: p.registryStatus === "obtained",
      hasRegistryAttachment: attachedSet.has(p.id),
      hasOwners: p._count.propertyOwners > 0,
      // ⚠これは参考情報ではなく**買う対象そのもの**。画面はこれが読めるまで
      //   実行させない(fail closed・設計 §3.1.1)。
      //   ⚠返すのは分類と警告文だけ。地番の値そのものは返さない(秘匿)。
      // ⚠画面が「この内容で承認した」と言えるようにする（@codex #373 R6 P1）。
      //   preflight から一括の作成までの間に他の担当者が住所や番号を変えると、
      //   作成時に読み直した**新しい値**で指紋が作られ、処理は「変わっていない」と
      //   判断して自動購入まで進む。承認の根拠を持ち回るための値。
      //   ⚠これは digest（sha256 の先頭32桁）で、地番そのものではない。
      fingerprintHash: hashPropertyFingerprint(p),
      target: classifyRegistryTarget({
        propertyType: p.propertyType,
        address: p.address,
        lotNumber: p.lotNumber,
        buildingNumber: p.buildingNumber,
        realEstateNumber: p.realEstateNumber,
      }),
    }));

    // A案(@codex #381 R1/R2 P2): 画面のログインリンクは**公開専用**の実効値に従わせる
    // (自動操作用 REGISTRY_FETCH_BASE_URL は内部を指し得るため配らない)。
    return apiResponse({ data, excluded, registryLoginUrl: publicRegistryLoginUrl() });
  } catch (error) {
    return handleApiError(error);
  }
}
