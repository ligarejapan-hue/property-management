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
  const note = foldNoColumnFieldsIntoNote(row.draft.noteFromUnmapped, {
    landArea: pv.landArea,
    builtYear: pv.builtYear,
  });
  return {
    property: {
      address: pv.address,
      lotNumber: pv.lotNumber || null,
      propertyType: pv.propertyType || "unknown",
      buildingName: pv.buildingName || null,
      roomNo: pv.roomNo || null,
      exclusiveArea: pv.exclusiveArea || null,
      layoutType: pv.layoutType || null,
      occupancyStatus: pv.occupancyStatus || null,
      note: note || null,
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
