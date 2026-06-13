// 法人番号の混入除去(local cleanup)判定の純関数(I/O なし)。
//
// 製品既定(21-D タスク11 / P1):
//  - 除去番号は decideCorporateImport の action="save"(列が空・1候補)のときだけ列へ移送する。
//  - noop(列=候補)/ conflict(列=別番号)は移送せず、混入文字列の除去のみ。
//  - multi(複数候補)は手動フラグ(自動除去/移送しない)。
//  - 空化ガード: 除去で name が(非空→)空になる行は手動フラグ(除去しない)。
//    address / note が空になる場合は null 化(nullable のため許容)。
//
// raw-visible gate は route 側で行う(検出させたくないフィールドは null を渡す)。
import {
  detectCorporateNumberInOwnerLike,
  removeCorporateNumbersFromText,
} from "./corporate-number";
import {
  decideCorporateImport,
  type CorporateImportAction,
} from "./owner-corporate-import";

export type CorporateCleanupAction = "none" | "cleanup" | "manual";
export type CorporateCleanupManualReason = "multi" | "name_would_be_empty" | null;

export interface OwnerCleanupInput {
  name: string | null;
  address: string | null;
  note: string | null;
  corporateNumber: string | null;
}

export interface CorporateCleanupProposal {
  action: CorporateCleanupAction;
  manualReason: CorporateCleanupManualReason;
  importAction: CorporateImportAction;
  detectedIn: Array<"name" | "address" | "note">;
  cleanedName: string | null;
  cleanedAddress: string | null;
  cleanedNote: string | null;
  corporateNumberToSet: string | null;
  changedFields: Array<"name" | "address" | "note" | "corporateNumber">;
}

function emptyToNull(s: string | null): string | null {
  if (s == null) return null;
  return s.trim() === "" ? null : s;
}

export function decideOwnerCorporateCleanup(
  owner: OwnerCleanupInput,
): CorporateCleanupProposal {
  const detect = detectCorporateNumberInOwnerLike({
    name: owner.name,
    address: owner.address,
    note: owner.note,
  });
  const importDecision = decideCorporateImport(
    { name: owner.name, address: owner.address, note: owner.note },
    owner.corporateNumber,
  );

  const unchanged: CorporateCleanupProposal = {
    action: "none",
    manualReason: null,
    importAction: importDecision.action,
    detectedIn: detect.detectedIn,
    cleanedName: owner.name,
    cleanedAddress: owner.address,
    cleanedNote: owner.note,
    corporateNumberToSet: null,
    changedFields: [],
  };

  if (detect.candidates.length === 0) return unchanged;
  if (importDecision.action === "multi") {
    return { ...unchanged, action: "manual", manualReason: "multi" };
  }

  // 除去対象: save/noop は採用候補、conflict は検出された候補(列値とは別)
  const numbersToRemove =
    importDecision.action === "conflict"
      ? detect.candidates
      : [importDecision.corporateNumber as string];

  const cleanedName = removeCorporateNumbersFromText(owner.name, numbersToRemove);
  const cleanedAddress = emptyToNull(
    removeCorporateNumbersFromText(owner.address, numbersToRemove),
  );
  const cleanedNote = emptyToNull(
    removeCorporateNumbersFromText(owner.note, numbersToRemove),
  );

  // 空化ガード(name のみ)
  const nameWasNonEmpty = (owner.name ?? "").trim() !== "";
  const nameWouldBeEmpty = nameWasNonEmpty && (cleanedName ?? "").trim() === "";
  if (nameWouldBeEmpty) {
    return { ...unchanged, action: "manual", manualReason: "name_would_be_empty" };
  }

  const corporateNumberToSet =
    importDecision.action === "save" ? importDecision.corporateNumber : null;

  const changedFields: CorporateCleanupProposal["changedFields"] = [];
  if (cleanedName !== owner.name) changedFields.push("name");
  if (cleanedAddress !== owner.address) changedFields.push("address");
  if (cleanedNote !== owner.note) changedFields.push("note");
  if (corporateNumberToSet !== null) changedFields.push("corporateNumber");

  if (changedFields.length === 0) return unchanged;

  return {
    action: "cleanup",
    manualReason: null,
    importAction: importDecision.action,
    detectedIn: detect.detectedIn,
    cleanedName,
    cleanedAddress,
    cleanedNote,
    corporateNumberToSet,
    changedFields,
  };
}
