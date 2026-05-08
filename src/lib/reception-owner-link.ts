/**
 * 受付帳×所有者ジョブの行レベル手動紐づけ用ヘルパ（ピュア）。
 *
 * - ジョブ種別判定: jobType === "owner_csv" かつ rawData に受付帳×所有者固有マーカ
 * - 所有者情報の復元: 取込時に rawData["__owner_link_data"] に保存した JSON 配列から
 * - Property 補完計算: 既存値が空の項目だけ受付帳の値で埋める
 *
 * DB 依存なし。route から呼び出して transaction 内で安全に使う。
 */

/** 取込時に rawData["__owner_link_data"] へ JSON で保存する所有者情報 1件 */
export interface RecoveredOwner {
  name: string;
  address: string | null;
  zip: string | null;
}

/**
 * 受付帳×所有者ジョブを判定するための rawData 固有キー。
 * 取込ロジック (src/app/api/import/reception-owner/route.ts) で必ず付与される。
 */
const RECEPTION_OWNER_MARKER_KEYS = [
  "所有者CSV物件住所",
  "matchKey",
  "ownerCount",
] as const;

export const RECEPTION_OWNER_LINK_DATA_KEY = "__owner_link_data";

/**
 * 行が「受付帳×所有者ジョブの行」であるかを厳格に判定する。
 *
 * - jobType === "owner_csv" であること（受付帳×所有者は owner_csv を流用）
 * - かつ rawData に受付帳×所有者固有のマーカが少なくとも1つ存在すること
 *
 * 通常の所有者CSV単独ジョブには上記マーカが存在しないため、
 * 既存 PATCH /rows/:rowId の link_existing 動作を壊さない。
 */
export function isReceptionOwnerJobRow(
  jobType: string,
  rawData: Record<string, unknown> | null | undefined,
): boolean {
  if (jobType !== "owner_csv") return false;
  if (!rawData || typeof rawData !== "object") return false;
  return RECEPTION_OWNER_MARKER_KEYS.some((k) =>
    Object.prototype.hasOwnProperty.call(rawData, k),
  );
}

/**
 * rawData["__owner_link_data"] から復元用の所有者配列をパースする。
 * 取込時に格納されていない（古い ImportJob、または取込時に owners.length === 0）場合は空配列。
 *
 * 失敗時は空配列を返す（呼び出し側で「復元不可」として 400 を返すかを判断する）。
 */
export function parseRecoveredOwners(
  rawData: Record<string, unknown> | null | undefined,
): RecoveredOwner[] {
  if (!rawData || typeof rawData !== "object") return [];
  const raw = (rawData as Record<string, unknown>)[RECEPTION_OWNER_LINK_DATA_KEY];
  if (typeof raw !== "string" || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (v): v is { name: unknown; address?: unknown; zip?: unknown } =>
        typeof v === "object" && v !== null,
    )
    .map((v) => {
      const name = typeof v.name === "string" ? v.name.trim() : "";
      const address =
        typeof v.address === "string" && v.address.trim() !== ""
          ? v.address.trim()
          : null;
      const zip =
        typeof v.zip === "string" && v.zip.trim() !== "" ? v.zip.trim() : null;
      return { name, address, zip };
    })
    .filter((o) => o.name !== "");
}

/**
 * 受付帳行の地番/家屋番号と、所有者行から取れる部屋番号で、
 * 既存 Property の空欄項目だけを補完する update データを返す。
 *
 * - 既存値 (current) が空の項目のみ更新
 * - 受付帳側に値が無ければスキップ
 * - 戻り値が空オブジェクトなら Property 更新は不要
 */
export function calcPropertyUpdates(
  current: {
    lotNumber: string | null;
    buildingNumber: string | null;
    roomNo: string | null;
  },
  reception: { lotNumber: string | null; buildingNumber: string | null },
  ownersRoomNo: string | null,
): { lotNumber?: string; buildingNumber?: string; roomNo?: string } {
  const updates: { lotNumber?: string; buildingNumber?: string; roomNo?: string } = {};
  if (!current.lotNumber && reception.lotNumber) {
    updates.lotNumber = reception.lotNumber;
  }
  if (!current.buildingNumber && reception.buildingNumber) {
    updates.buildingNumber = reception.buildingNumber;
  }
  if (!current.roomNo && ownersRoomNo) {
    updates.roomNo = ownersRoomNo;
  }
  return updates;
}

/**
 * 復元された所有者群が「Owner upsert に必要な氏名」を持っているかチェック。
 * 1件以上 name を持つ owner があれば true。
 *
 * `owner_unmatched`（取込時 owners.length === 0）の行や、古い ImportJob で
 * `__owner_link_data` が無い行は false を返す → 400 で弾く。
 */
export function hasUsableOwnerInfo(owners: RecoveredOwner[]): boolean {
  return owners.some((o) => o.name && o.name.trim() !== "");
}
