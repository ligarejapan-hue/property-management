/**
 * 謄本にだけいる人を自動で登録する(ピュア・2026-11-10 発注者決定)。
 *
 * 発注者の分け方:
 * - 表記だけの違い(漢字の違い 髙／高・法人の書き方の違い 株式会社／(株))=自動にしない(人が確かめる)
 * - 所有者が変わった可能性(別の人・一部が別の人・人数が違う・名前の一部が違う)=謄本の人を登録する
 * そこで、謄本の人のうち「システムのだれとも、そろえて同じにならない人」を足す。ただし、システムの
 * 人と組になり、違いが表記だけ(漢字1字ずつ・法人の書き方)の人は足さない。
 * - システムにだけいる人は外さない・今いる人の名前と住所は変えない(ここは足す人を選ぶだけ)
 * - 謄本に同じ人が2回載っている等、そろえて同じ名前は1人だけ
 */
import {
  ownerNameKey,
  planOwnerReplacement,
  type RegistryOwnerEntry,
} from "@/lib/registry-owner-check/compare";
import { ownerDiff } from "@/lib/registry-owner-check/diff";

export function registryOwnersToAutoAdd<T extends RegistryOwnerEntry>(
  registryOwners: readonly T[],
  systemNames: readonly string[],
): T[] {
  const rows = ownerDiff(
    registryOwners.map((o) => o.name),
    systemNames,
  ).rows;
  // システムの人と表記だけ違う謄本の人(人が確かめる)
  const notationOnly = new Set(
    rows
      .filter(
        (r) =>
          r.status === "differs" &&
          r.pairKinds.length > 0 &&
          r.pairKinds.every((k) => k === "kanji" || k === "corp"),
      )
      .map((r) => r.registryIndex),
  );
  const plan = planOwnerReplacement(
    registryOwners,
    systemNames.map((name, i) => ({ ownerId: String(i), name })),
  );
  const addKeys = new Set(plan.add.map((o) => ownerNameKey(o.name)));
  const seen = new Set<string>();
  return registryOwners.filter((o, i) => {
    if (notationOnly.has(i)) return false;
    const k = ownerNameKey(o.name);
    if (!addKeys.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
