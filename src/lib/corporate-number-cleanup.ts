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
  extractCompanyRegistryNumbersFromText,
  removeCompanyRegistryNumbersFromText,
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

  // 会社法人等番号(12桁)の検出は 13桁とは完全に独立した別レイヤ。
  // ラベル付きのみ抽出し、除去のみ(列移送なし=corporateNumberToSet には影響しない)。
  const registryFields: Array<["name" | "address" | "note", string | null]> = [
    ["name", owner.name],
    ["address", owner.address],
    ["note", owner.note],
  ];
  const registryNumbers = new Set<string>();
  const registryDetectedIn = new Set<"name" | "address" | "note">();
  for (const [field, value] of registryFields) {
    const hits = extractCompanyRegistryNumbersFromText(value);
    if (hits.length > 0) {
      registryDetectedIn.add(field);
      for (const h of hits) registryNumbers.add(h);
    }
  }
  const registryNumbersToRemove = Array.from(registryNumbers);
  const hasRegistry = registryNumbersToRemove.length > 0;

  // detectedIn は 13桁・12桁の和集合(field 順は name/address/note 固定)。
  const detectedIn = (["name", "address", "note"] as const).filter(
    (f) => detect.detectedIn.includes(f) || registryDetectedIn.has(f),
  );

  const unchanged: CorporateCleanupProposal = {
    action: "none",
    manualReason: null,
    importAction: importDecision.action,
    detectedIn,
    cleanedName: owner.name,
    cleanedAddress: owner.address,
    cleanedNote: owner.note,
    corporateNumberToSet: null,
    changedFields: [],
  };

  // 13桁候補も 12桁混入も無ければ何もしない。
  if (detect.candidates.length === 0 && !hasRegistry) return unchanged;
  // 13桁の multi(複数候補)は従来どおり手動フラグ(12桁が併存しても 13桁挙動を維持)。
  if (importDecision.action === "multi") {
    return { ...unchanged, action: "manual", manualReason: "multi" };
  }

  // 除去対象(13桁): save/noop は採用候補、conflict は検出された候補(列値とは別)。
  // 13桁候補が無い(12桁のみ)場合は 13桁除去は空配列=不変。
  const numbersToRemove =
    detect.candidates.length === 0
      ? []
      : importDecision.action === "conflict"
        ? detect.candidates
        : [importDecision.corporateNumber as string];

  // removeCorporateNumbersFromText は除去が無ければ入力を不変で返す。raw 出力が元と
  // 異なるか = 実際に番号を除去したか、で判定する。emptyToNull("")→null の正規化を
  // 「除去」と誤判定しないよう、判定は raw 出力で行い、null 化は実際に除去が起きた
  // フィールドにのみ適用する(Codex P2 round5)。
  // まず 13桁を除去し、その出力に対して 12桁(会社法人等番号)を重ねて除去する。
  // 12桁は除去のみで corporateNumber 列移送には一切関与しない。
  const rawName13 = removeCorporateNumbersFromText(owner.name, numbersToRemove);
  const rawAddress13 = removeCorporateNumbersFromText(owner.address, numbersToRemove);
  const rawNote13 = removeCorporateNumbersFromText(owner.note, numbersToRemove);

  const rawName = removeCompanyRegistryNumbersFromText(rawName13, registryNumbersToRemove);
  const rawAddress = removeCompanyRegistryNumbersFromText(rawAddress13, registryNumbersToRemove);
  const rawNote = removeCompanyRegistryNumbersFromText(rawNote13, registryNumbersToRemove);

  const addressRemoved = rawAddress !== owner.address;
  const noteRemoved = rawNote !== owner.note;

  // 13桁の除去が「実際に」起きたか(12桁除去とは独立に追跡)。save 列移送の可否判定は
  // 13桁の除去成否のみで行う。12桁(会社法人等番号)を除去しただけで 13桁番号を列へ
  // 誤移送しないため(ハイフン連結ID 等の Codex P2 round4/5 ガードを 12桁併存時も維持)。
  const corporate13Removed =
    rawName13 !== owner.name ||
    rawAddress13 !== owner.address ||
    rawNote13 !== owner.note;

  const cleanedName = rawName;
  const cleanedAddress = addressRemoved ? emptyToNull(rawAddress) : owner.address;
  const cleanedNote = noteRemoved ? emptyToNull(rawNote) : owner.note;

  // 空化ガード(name のみ)
  const nameWasNonEmpty = (owner.name ?? "").trim() !== "";
  const nameWouldBeEmpty = nameWasNonEmpty && (cleanedName ?? "").trim() === "";
  if (nameWouldBeEmpty) {
    return { ...unchanged, action: "manual", manualReason: "name_would_be_empty" };
  }

  // save(空き列へ移送)は「実際にテキストから番号を除去できた」ときだけ行う。
  // ハイフン連結ID(例 "…1234567890123-45" / 全角 "－45")は共有検出器が先頭13桁を
  // save 候補にするが、厳格な cleanup remover は除去しない。テキスト無変更のまま列へ
  // 数字断片を誤保存しないよう、除去が1件も起きていない save は列移送しない(Codex P2 round4/5)。
  // 12桁除去ではなく 13桁除去成否(corporate13Removed)でのみ save を許可する。
  const corporateNumberToSet =
    importDecision.action === "save" && corporate13Removed
      ? importDecision.corporateNumber
      : null;

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
    detectedIn,
    cleanedName,
    cleanedAddress,
    cleanedNote,
    corporateNumberToSet,
    changedFields,
  };
}
