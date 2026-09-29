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
import { supportsUnitFields, supportsBuildingName } from "@/lib/property-building-name";
import { OCCUPANCY_STATUS_LABELS } from "@/lib/property-types";
import { structuredFieldsFor } from "@/lib/paste-import/structured-fields";

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
    // ⚠建物面積は excelLeadCommitBody が延床面積の欄か備考かを決めるので、ここでは足さない。
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
  /** 確定の時点で似た物件・同名の所有者が見つかったら作らずに 409 を返させる。 */
  requireNoDuplicates: true;
}

export function excelLeadCommitBody(row: { draft: PasteDraft; ownerNote: string }): ExcelLeadCommitBody {
  const pv = defaultPropertyValues(row.draft);
  const ov = defaultOwnerValues(row.draft);
  // ⚠土地面積・延床面積・築年は物件の正式な欄へ入れる(@codex PR#456 3巡目)。
  //   ただし**その種別の編集画面に出る欄だけ**(4巡目)。出ない欄の値は備考に残す
  //   (登録APIも同じ規則 structuredFieldsFor で断る)。
  const isUnit = supportsUnitFields(pv.propertyType);
  const allowed = structuredFieldsFor(pv.propertyType);
  // 区分以外の「建物面積」は延床面積(下書きでは専有面積の欄に読まれている)。
  const buildingArea = isUnit ? "" : pv.exclusiveArea;
  const landArea = allowed.has("landArea") ? pv.landArea : "";
  const totalFloorArea = allowed.has("totalFloorArea") ? buildingArea : "";
  const builtYear = allowed.has("builtYear") && pv.builtYear ? Number(pv.builtYear) : null;
  const folded = foldNoColumnFieldsIntoNote(row.draft.noteFromUnmapped, {
    landArea: allowed.has("landArea") ? "" : pv.landArea,
    builtYear: allowed.has("builtYear") ? "" : pv.builtYear,
  });
  const note = [
    folded.trim(),
    ...droppedFieldLines(pv),
    ...(buildingArea && !allowed.has("totalFloorArea") ? [`建物面積: ${buildingArea}㎡`] : []),
  ]
    .filter((l) => l !== "")
    .join("\n");
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
      landArea: landArea || null,
      totalFloorArea: totalFloorArea || null,
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
    requireNoDuplicates: true,
  };
}

// ---------------------------------------------------------------------------
// 登録APIの応答の読み分け(@codex PR#456 1巡目 ①・4巡目 ①)
//
// ⚠重複の確認は**登録APIの中で、作成と同じロックの内側で**行う
//   (requireNoDuplicates)。画面から「確認」と「登録」を別々に呼ぶと、その間に
//   同じ人・同じ物件が(前の行や他の人の取込で)作られても止められない。
//   ここは返ってきた結果を行の状態に読み替えるだけ。
// ---------------------------------------------------------------------------

export type CommitOutcome =
  | { kind: "created"; propertyId: string }
  | { kind: "duplicate" }
  | { kind: "review"; reasons: string[] }
  | { kind: "failed"; message: string };

export function commitOutcome(
  status: number,
  body: { propertyId?: string; error?: { code?: string; message?: string } } | null,
): CommitOutcome {
  if (status >= 200 && status < 300 && body?.propertyId) {
    return { kind: "created", propertyId: body.propertyId };
  }
  const code = body?.error?.code;
  const message = body?.error?.message ?? `処理に失敗しました（${status}）`;
  if (status === 409 && code === "NEEDS_REVIEW") {
    return { kind: "review", reasons: message.split("／").filter((r) => r !== "") };
  }
  if (status === 409 && code === "DUPLICATE") return { kind: "duplicate" };
  return { kind: "failed", message };
}
