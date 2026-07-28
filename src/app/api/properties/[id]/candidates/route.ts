import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import {
  haversineDistance,
  getCandidateStrength,
  CANDIDATE_THRESHOLDS,
} from "@/lib/geo";
import {
  addressAreaKey,
  normalizeAddress,
  normalizeLotNumber,
  normalizeRealEstateNumber,
  similarityScore,
} from "@/lib/address-normalizer";

/**
 * 地番一致の走査上限。住所 prefix で同一エリアに絞った母集団の中を JS で
 * 正規化比較するので、無条件スキャンだった頃の 50 件より大きく取れる。
 */
const LOT_MATCH_SCAN_LIMIT = 500;

/**
 * 不動産番号一致の取得上限。番号は全国一意なので通常 0〜1 件だが、
 * 取込ミス等での重複登録に備えて余裕を持たせる。
 */
const REAL_ESTATE_NUMBER_MATCH_LIMIT = 50;

interface CandidateResult {
  id: string;
  address: string;
  lotNumber: string | null;
  realEstateNumber: string | null;
  propertyType: string;
  caseStatus: string;
  distance: number | null;
  strength: string;
  matchType: "gps" | "address" | "lot_number" | "real_estate_number";
  similarity: number;
}

// ---------- GET /api/properties/:id/candidates ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id },
      select: {
        id: true,
        address: true,
        lotNumber: true,
        realEstateNumber: true,
        gpsLat: true,
        gpsLng: true,
      },
    });

    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    const candidateMap = new Map<string, CandidateResult>();

    // --- Strategy 1: GPS proximity ---
    if (property.gpsLat != null && property.gpsLng != null) {
      const baseLat = Number(property.gpsLat);
      const baseLng = Number(property.gpsLng);
      const latDelta = 0.0005;
      const lngDelta = 0.0006;

      const nearby = await prisma.property.findMany({
        where: {
          id: { not: id },
          isArchived: false,
          gpsLat: { gte: baseLat - latDelta, lte: baseLat + latDelta },
          gpsLng: { gte: baseLng - lngDelta, lte: baseLng + lngDelta },
        },
        select: {
          id: true,
          address: true,
          lotNumber: true,
          realEstateNumber: true,
          propertyType: true,
          caseStatus: true,
          gpsLat: true,
          gpsLng: true,
        },
      });

      for (const p of nearby) {
        if (p.gpsLat == null || p.gpsLng == null) continue;
        const distance = haversineDistance(
          baseLat,
          baseLng,
          Number(p.gpsLat),
          Number(p.gpsLng),
        );
        const strength = getCandidateStrength(distance);
        if (strength) {
          candidateMap.set(p.id, {
            id: p.id,
            address: p.address,
            lotNumber: p.lotNumber,
            realEstateNumber: p.realEstateNumber,
            propertyType: p.propertyType,
            caseStatus: p.caseStatus,
            distance: Math.round(distance * 10) / 10,
            strength,
            matchType: "gps",
            similarity: 1 - distance / CANDIDATE_THRESHOLDS.weak,
          });
        }
      }
    }

    // --- Strategy 2: Normalized address similarity ---
    const normalizedAddr = normalizeAddress(property.address);
    // Extract the block-level prefix for DB filtering (first ~10 chars)
    const addrPrefix = property.address.slice(0, 10);

    if (addrPrefix.length >= 4) {
      const addrMatches = await prisma.property.findMany({
        where: {
          id: { not: id },
          isArchived: false,
          address: { contains: addrPrefix },
        },
        select: {
          id: true,
          address: true,
          lotNumber: true,
          realEstateNumber: true,
          propertyType: true,
          caseStatus: true,
        },
        take: 20,
      });

      for (const p of addrMatches) {
        if (candidateMap.has(p.id)) continue;
        const normP = normalizeAddress(p.address);
        const score = similarityScore(normalizedAddr, normP);
        if (score >= 0.7) {
          candidateMap.set(p.id, {
            id: p.id,
            address: p.address,
            lotNumber: p.lotNumber,
            realEstateNumber: p.realEstateNumber,
            propertyType: p.propertyType,
            caseStatus: p.caseStatus,
            distance: null,
            strength: score >= 0.9 ? "strong" : score >= 0.8 ? "medium" : "weak",
            matchType: "address",
            similarity: score,
          });
        }
      }
    }

    // --- Strategy 3: Lot number matching ---
    // ⚠以前は「地番が入っている物件」を無条件に先頭 50 件だけ取り、JS で
    // 正規化比較していた (総点検 2026-07-27)。DB 側の値フィルタも並び順も
    // 無いため、地番入りが数千件ある本番では本当の重複が 50 件に入る確率が
    // 低く、重複検出が実質機能していなかった。
    //
    // 地番の正規化 (全半角・ハイフン統一・漢数字→算用数字) は SQL で再現
    // できないため DB 側で完全一致は取れない。代わりに **同一エリアに限定**
    // して母集団を小さくし、その中を JS で正規化比較する。同じ「1番1」でも
    // 市区町村が違えば重複ではないので、住所での絞り込みは性能面だけでなく
    // 意味の上でも正しい。
    //
    // ⚠絞り込みキーに生の先頭10文字 (Strategy 2 の addrPrefix) を使うと、
    // 「芝公園4-2-8」と「芝公園4丁目2-8」のような**丁目/ハイフンの表記差**が
    // prefix に食い込み、正規化すれば一致する相手を DB 段階で落としてしまう
    // (@codex #330 R1)。番地は最初の数字以降にしか出ないので、数字の手前まで
    // (= addressAreaKey) を使えば表記差の影響を受けない。
    const areaKey = addressAreaKey(property.address);
    if (property.lotNumber && areaKey.length >= 4) {
      const normalizedLot = normalizeLotNumber(property.lotNumber);
      const lotMatches = await prisma.property.findMany({
        where: {
          id: { not: id },
          isArchived: false,
          lotNumber: { not: null },
          address: { contains: areaKey },
        },
        select: {
          id: true,
          address: true,
          lotNumber: true,
          realEstateNumber: true,
          propertyType: true,
          caseStatus: true,
        },
        take: LOT_MATCH_SCAN_LIMIT,
      });

      for (const p of lotMatches) {
        if (candidateMap.has(p.id) || !p.lotNumber) continue;
        const normPLot = normalizeLotNumber(p.lotNumber);
        if (normalizedLot === normPLot) {
          candidateMap.set(p.id, {
            id: p.id,
            address: p.address,
            lotNumber: p.lotNumber,
            realEstateNumber: p.realEstateNumber,
            propertyType: p.propertyType,
            caseStatus: p.caseStatus,
            distance: null,
            strength: "strong",
            matchType: "lot_number",
            similarity: 1,
          });
        }
      }
    }

    // --- Strategy 4: Real estate number matching ---
    // 不動産番号は全国で一意なので、地番と違いエリアで絞れない。以前は
    // 「番号が入っている物件」の先頭 50 件だけを見ていて実質機能していな
    // かった (総点検 2026-07-27)。
    // JS の normalizeRealEstateNumber は「①全角数字→半角 ②数字以外を除去」の
    // 2 段。SQL で ② だけ再現すると全角数字が「数字以外」として丸ごと消え、
    // 全角で登録された行を必ず取りこぼす (PostgreSQL の [0-9] は ASCII のみで
    // 全角 U+FF10-FF19 にマッチしない)。しかも validators の
    // optionalRealEstateNumber は全角を許容するだけで変換していないため、
    // 全角のまま保存された行が現実に存在し得る。
    // → translate() で ① を行ってから regexp_replace で ② を行い、JS と
    //   完全に同じ正規化にする (パラメータ化クエリ)。
    if (property.realEstateNumber) {
      const normalizedNum = normalizeRealEstateNumber(
        property.realEstateNumber,
      );
      const reMatches = normalizedNum
        ? await prisma.$queryRaw<
            Array<{
              id: string;
              address: string;
              lotNumber: string | null;
              realEstateNumber: string | null;
              propertyType: string;
              caseStatus: string;
            }>
          >`
            SELECT id,
                   address,
                   lot_number AS "lotNumber",
                   real_estate_number AS "realEstateNumber",
                   property_type AS "propertyType",
                   case_status AS "caseStatus"
            FROM properties
            WHERE id <> ${id}::uuid
              AND is_archived = false
              AND real_estate_number IS NOT NULL
              AND regexp_replace(
                    translate(real_estate_number, '０１２３４５６７８９', '0123456789'),
                    '[^0-9]', '', 'g'
                  ) = ${normalizedNum}
            LIMIT ${REAL_ESTATE_NUMBER_MATCH_LIMIT}
          `
        : [];

      for (const p of reMatches) {
        if (candidateMap.has(p.id) || !p.realEstateNumber) continue;
        const normPNum = normalizeRealEstateNumber(p.realEstateNumber);
        if (normalizedNum === normPNum) {
          candidateMap.set(p.id, {
            id: p.id,
            address: p.address,
            lotNumber: p.lotNumber,
            realEstateNumber: p.realEstateNumber,
            propertyType: p.propertyType,
            caseStatus: p.caseStatus,
            distance: null,
            strength: "strong",
            matchType: "real_estate_number",
            similarity: 1,
          });
        }
      }
    }

    // Sort: strong > medium > weak, then by similarity desc
    const strengthOrder = { strong: 0, medium: 1, weak: 2 };
    const candidates = Array.from(candidateMap.values()).sort((a, b) => {
      const sDiff =
        (strengthOrder[a.strength as keyof typeof strengthOrder] ?? 2) -
        (strengthOrder[b.strength as keyof typeof strengthOrder] ?? 2);
      if (sDiff !== 0) return sDiff;
      return b.similarity - a.similarity;
    });

    return apiResponse({
      data: candidates,
      thresholds: CANDIDATE_THRESHOLDS,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
