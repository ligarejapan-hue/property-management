/**
 * CSV 取込の重複判定ヘルパ。
 *
 * - 正規化関数 (src/lib/normalize.ts) を使い比較用値ベースで判定する
 * - 保存値は変更しない
 * - ピュア関数だけ集めているので Prisma 依存なしで単体テスト可能
 */

import {
  normalizeAddress,
  normalizeBuildingName,
  normalizeRoomNo,
} from "./normalize";

// ---------- 型 ----------

export interface PropertyRecord {
  id: string;
  address: string;
  roomNo: string | null;
  buildingId: string | null;
  realEstateNumber?: string | null;
  externalLinkKey?: string | null;
}

export interface BuildingRecord {
  id: string;
  name: string;
  address: string;
}

export interface DedupeIndex {
  /** 正規化住所 → 最初に出会った既存物件 */
  byNormalizedAddress: Map<string, { id: string; address: string }>;
  /** buildingId → その棟のユニット一覧 (id/roomNo) */
  unitsByBuildingId: Map<
    string,
    Array<{ id: string; roomNo: string | null; address: string }>
  >;
}

export type DuplicateReason =
  | "realEstateNumber一致"
  | "externalLinkKey一致"
  | "住所一致（正規化比較）"
  | "棟内部屋番号一致（正規化比較）";

/**
 * 重複一致理由が「既存更新の対象にしてよい」強度を持つかを返す。
 *
 * 住所一致のみでは他物件と取り違える危険があるため更新不可。
 * 識別子一致 / 棟内部屋番号一致は安全に更新可能。
 */
export function isUpdateEligibleReason(reason: DuplicateReason): boolean {
  return reason !== "住所一致（正規化比較）";
}

/**
 * CSV 取込で安全に update してよい Property フィールドの allowlist。
 *
 * 含めないもの:
 * - id / createdAt / createdBy / updatedAt (システム管理)
 * - propertyType / registryStatus / dmStatus / caseStatus (業務ステータス)
 * - realEstateNumber / externalLinkKey (識別子: マッチキー自身)
 * - buildingId / assignedTo (関連)
 * - roomNo (unit マッチキー自身)
 */
export const UPDATABLE_PROPERTY_FIELDS = [
  "address",
  "lotNumber",
  "buildingNumber",
  "zoningDistrict",
  "rosenkaValue",
  "gpsLat",
  "gpsLng",
  "note",
  "floorNo",
  "exclusiveArea",
  "balconyArea",
  "layoutType",
  "orientation",
  "managementFee",
  "repairReserveFee",
  "ownershipShareNote",
] as const;

export type UpdatablePropertyField = (typeof UPDATABLE_PROPERTY_FIELDS)[number];

export interface DuplicateHit {
  matchedId: string;
  matchedAddress: string;
  reason: DuplicateReason;
}

// ---------- ユーティリティ ----------

/**
 * 既存物件一覧から、住所・棟内ユニットの正規化インデックスを作る。
 *
 * 同じ正規化住所に複数件あっても、最初の1件を代表として保持する（既存重複の精査は本ヘルパの責務外）。
 */
export function buildDedupeIndex(records: PropertyRecord[]): DedupeIndex {
  const byNormalizedAddress = new Map<string, { id: string; address: string }>();
  const unitsByBuildingId = new Map<
    string,
    Array<{ id: string; roomNo: string | null; address: string }>
  >();

  for (const r of records) {
    const na = normalizeAddress(r.address);
    if (na && !byNormalizedAddress.has(na)) {
      byNormalizedAddress.set(na, { id: r.id, address: r.address });
    }
    if (r.buildingId) {
      const arr = unitsByBuildingId.get(r.buildingId) ?? [];
      arr.push({ id: r.id, roomNo: r.roomNo, address: r.address });
      unitsByBuildingId.set(r.buildingId, arr);
    }
  }

  return { byNormalizedAddress, unitsByBuildingId };
}

/**
 * インデックス構築後、同じCSV内で新規作成した物件を後続行の判定にも反映させたい時に使う。
 */
export function addToDedupeIndex(
  index: DedupeIndex,
  record: PropertyRecord,
): void {
  const na = normalizeAddress(record.address);
  if (na && !index.byNormalizedAddress.has(na)) {
    index.byNormalizedAddress.set(na, {
      id: record.id,
      address: record.address,
    });
  }
  if (record.buildingId) {
    const arr = index.unitsByBuildingId.get(record.buildingId) ?? [];
    arr.push({
      id: record.id,
      roomNo: record.roomNo,
      address: record.address,
    });
    index.unitsByBuildingId.set(record.buildingId, arr);
  }
}

/**
 * 物件重複判定のメイン。
 *
 * 識別子 (realEstateNumber / externalLinkKey) は正規化せず raw 比較（DB 側 exact を想定）。
 * 住所と棟内部屋番号は正規化比較。
 *
 * 優先順: realEstateNumber → externalLinkKey → 棟内 roomNo → 住所
 */
export function findPropertyDuplicate(
  index: DedupeIndex,
  input: {
    address?: string | null;
    roomNo?: string | null;
    buildingId?: string | null;
    realEstateNumber?: string | null;
    externalLinkKey?: string | null;
  },
  allRecords: readonly PropertyRecord[],
): DuplicateHit | null {
  // 1. realEstateNumber (raw exact)
  if (input.realEstateNumber) {
    const hit = allRecords.find(
      (r) => r.realEstateNumber === input.realEstateNumber,
    );
    if (hit) {
      return {
        matchedId: hit.id,
        matchedAddress: hit.address,
        reason: "realEstateNumber一致",
      };
    }
  }

  // 2. externalLinkKey (raw exact)
  if (input.externalLinkKey) {
    const hit = allRecords.find(
      (r) => r.externalLinkKey === input.externalLinkKey,
    );
    if (hit) {
      return {
        matchedId: hit.id,
        matchedAddress: hit.address,
        reason: "externalLinkKey一致",
      };
    }
  }

  // 3. 棟内 roomNo (正規化比較)
  if (input.buildingId && input.roomNo) {
    const units = index.unitsByBuildingId.get(input.buildingId) ?? [];
    const target = normalizeRoomNo(input.roomNo);
    if (target) {
      const hit = units.find((u) => normalizeRoomNo(u.roomNo) === target);
      if (hit) {
        return {
          matchedId: hit.id,
          matchedAddress: hit.address,
          reason: "棟内部屋番号一致（正規化比較）",
        };
      }
    }
  }

  // 4. 住所 (正規化比較)
  const targetAddress = normalizeAddress(input.address);
  if (targetAddress) {
    const hit = index.byNormalizedAddress.get(targetAddress);
    if (hit) {
      return {
        matchedId: hit.id,
        matchedAddress: hit.address,
        reason: "住所一致（正規化比較）",
      };
    }
  }

  return null;
}

/**
 * 棟名突合のフォールバック（正規化一致）。
 * 既存の exact/partial/contains 突合が失敗した時に呼び、複数候補から絞り込むのに使う。
 *
 * 戻り値:
 * - 1件に絞れた: そのレコード
 * - 0件 or 複数件: null（呼び出し側が通常の needs_review フローへ）
 */
export function findBuildingByNormalizedName(
  candidates: readonly BuildingRecord[],
  inputName: string,
): BuildingRecord | null {
  const target = normalizeBuildingName(inputName);
  if (!target) return null;
  const matched = candidates.filter(
    (b) => normalizeBuildingName(b.name) === target,
  );
  return matched.length === 1 ? matched[0] : null;
}
