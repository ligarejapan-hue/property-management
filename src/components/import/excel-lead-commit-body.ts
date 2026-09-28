/**
 * Excel まとめ取込の1行を、登録API(/api/import/paste/commit)の本文にする。
 *
 * ⚠組み立ては**貼り付け画面の登録と同じ部品**を使う(初期値・土地面積/築年の
 *   備考への畳み込み)。同じ反響をどちらの入口から入れても同じ物件ができるように。
 * ⚠既存の所有者へは**紐付けない**(linkExistingOwnerId=null)。同名の所有者が
 *   いる行は、そもそも「要確認」でまとめ登録の対象から外れている。
 */
import {
  defaultPropertyValues,
  defaultOwnerValues,
  foldNoColumnFieldsIntoNote,
} from "./paste-import-review";
import type { PasteDraft } from "@/lib/paste-import/types";
import { leadRowStatus } from "@/lib/paste-import/lead-sheet";
import { supportsUnitFields, supportsBuildingName } from "@/lib/property-building-name";
import { OCCUPANCY_STATUS_LABELS } from "@/lib/property-types";

/**
 * 種別に合わず**登録で消える欄**(区分専用の欄・建物名)の値を、物件の備考の行にする
 * (@codex PR#456 2巡目 ①)。
 * ⚠登録APIは種別に合わない欄を null に落とす(normalizeUnitOnlyFields /
 *   normalizeBuildingName)。読み取れた値は下書きの備考にも入っていないので、
 *   このままでは戸建の建物面積・間取り・現況が**黙って消える**。
 *   貼り付け画面では人が欄を見て直せるが、まとめ登録には人がいない。
 */
function droppedFieldLines(pv: ReturnType<typeof defaultPropertyValues>): string[] {
  const lines: string[] = [];
  if (!supportsBuildingName(pv.propertyType) && pv.buildingName) {
    lines.push(`建物名: ${pv.buildingName}`);
  }
  if (!supportsUnitFields(pv.propertyType)) {
    // ⚠建物面積は延床面積の欄へ入れる(excelLeadCommitBody)ので、ここでは足さない。
    if (pv.roomNo) lines.push(`部屋番号: ${pv.roomNo}`);
    if (pv.layoutType) lines.push(`間取り: ${pv.layoutType}`);
    if (pv.occupancyStatus) {
      lines.push(`現況: ${OCCUPANCY_STATUS_LABELS[pv.occupancyStatus] ?? pv.occupancyStatus}`);
    }
  }
  return lines;
}

export interface ExcelLeadCommitBody {
  property: {
    address: string;
    lotNumber: string | null;
    propertyType: string;
    buildingName: string | null;
    roomNo: string | null;
    exclusiveArea: string | null;
    layoutType: string | null;
    occupancyStatus: string | null;
    note: string | null;
    landArea: string | null;
    totalFloorArea: string | null;
    builtYear: number | null;
  };
  owner: {
    name: string;
    nameKana: string | null;
    phone: string | null;
    email: string | null;
    currentAddress: string | null;
    note: string | null;
  } | null;
  externalLinkKey: string | null;
  linkExistingOwnerId: null;
}

export function excelLeadCommitBody(row: { draft: PasteDraft; ownerNote: string }): ExcelLeadCommitBody {
  const pv = defaultPropertyValues(row.draft);
  const ov = defaultOwnerValues(row.draft);
  // ⚠土地面積・延床面積・築年は物件の正式な欄へ入れる(@codex PR#456 3巡目)。
  //   区分マンションの築年は棟の値が正(登録APIも断る)なので、備考に残す。
  const isUnit = supportsUnitFields(pv.propertyType);
  const builtYear = pv.builtYear && !isUnit ? Number(pv.builtYear) : null;
  const folded = foldNoColumnFieldsIntoNote(row.draft.noteFromUnmapped, {
    landArea: "",
    builtYear: isUnit ? pv.builtYear : "",
  });
  const note = [folded.trim(), ...droppedFieldLines(pv)].filter((l) => l !== "").join("\n");
  return {
    property: {
      address: pv.address,
      lotNumber: pv.lotNumber || null,
      propertyType: pv.propertyType || "unknown",
      buildingName: pv.buildingName || null,
      roomNo: pv.roomNo || null,
      // 専有面積は区分だけ(区分以外は延床面積として下で送る＝同じ値を二重に送らない)。
      exclusiveArea: isUnit ? pv.exclusiveArea || null : null,
      layoutType: pv.layoutType || null,
      occupancyStatus: pv.occupancyStatus || null,
      note: note || null,
      landArea: pv.landArea || null,
      // 区分以外の「建物面積」は延床面積(下書きでは専有面積の欄に読まれている)。
      totalFloorArea: !isUnit && pv.exclusiveArea ? pv.exclusiveArea : null,
      builtYear,
    },
    owner:
      ov.name.trim() === ""
        ? null
        : {
            name: ov.name,
            nameKana: ov.nameKana || null,
            phone: ov.phone || null,
            email: ov.email || null,
            currentAddress: ov.currentAddress || null,
            note: row.ownerNote || null,
          },
    externalLinkKey: row.draft.externalLinkKey,
    linkExistingOwnerId: null,
  };
}

// ---------------------------------------------------------------------------
// 登録直前の見直し(@codex PR#456 1巡目 ①)
//
// ⚠下見の判定は**取込を始める前のDB**に対するもの。同じ人の物件が2行ある
//   (反響番号は別)と、1行目で作った所有者が2行目の下見には映っておらず、
//   そのまま登録すると**同じ人の所有者が2人**できる。登録APIは反響番号の一致
//   しか止めない(住所・氏名の一致は人が判断する設計)ので、ここで止める。
// ⚠貼り付け画面の「登録の直前にもう一度見直す」と同じ見直しAPIを使い、
//   判定は下見と**同じ関数**(leadRowStatus)に通す。
// ---------------------------------------------------------------------------

export interface ExcelLeadRecheckBody {
  address: string;
  lotNumber: string;
  externalLinkKey: string;
  ownerName: string;
  ownerCurrentAddress: string;
}

export function excelLeadRecheckBody(row: { draft: PasteDraft }): ExcelLeadRecheckBody {
  const pv = defaultPropertyValues(row.draft);
  const ov = defaultOwnerValues(row.draft);
  return {
    address: pv.address,
    lotNumber: pv.lotNumber,
    externalLinkKey: row.draft.externalLinkKey ?? "",
    ownerName: ov.name,
    ownerCurrentAddress: ov.currentAddress,
  };
}

/** 見直しAPI(/api/import/paste/recheck)の応答のうち、判定に使う部分。 */
export interface ExcelLeadRecheckResponse {
  duplicates: { blocked: boolean; blockedByPropertyId?: string | null; similarPropertyIds?: string[] };
  similar: unknown[];
  ownerCandidates: unknown[];
  ownerCandidatesTruncated: boolean;
}

export type RecheckOutcome =
  | { kind: "go" }
  | { kind: "duplicate" }
  | { kind: "review"; reasons: string[] };

export function recheckOutcome(draft: PasteDraft, res: ExcelLeadRecheckResponse): RecheckOutcome {
  const { status, reasons } = leadRowStatus(draft, {
    blocked: res.duplicates.blocked,
    similarCount: res.similar.length,
    ownerCandidateCount: res.ownerCandidates.length,
    ownerCandidatesTruncated: res.ownerCandidatesTruncated,
  });
  if (status === "registered") return { kind: "duplicate" };
  if (status === "review") return { kind: "review", reasons };
  return { kind: "go" };
}
