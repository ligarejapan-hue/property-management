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
import type { PermissionEntry } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { findMissingOwnerFieldWritePerm } from "@/lib/owner-create";
import { hasPrivateUseChar } from "@/lib/private-use-char";

/**
 * 謄本を添付した人が、今も自分で「添付済みの謄本から所有者を反映」できるか(2026-11-10・
 * 自動のセキュリティ点検の指摘)。自動の登録はこの人の操作として残す。
 * ⚠所有者を書けない人が偽の謄本を添付して、だれかの名前で所有者を足させる抜け道を作らない。
 *   反映の窓口(/api/properties/[id]/registry-owners)と同じ線: 物件を見る・謄本を見る・取込・
 *   所有者の編集・足す人の氏名と住所を書ける。担当範囲は呼び出し元が物件の行で見る。
 */
export function uploaderMayAutoAdd(
  perms: PermissionEntry[],
  owners: ReadonlyArray<{ name: string; address: string | null }>,
): boolean {
  if (!hasPermission(perms, "property", "read")) return false;
  if (!hasPermission(perms, "registry_pdf", "preview")) return false;
  if (!hasPermission(perms, "import", "write")) return false;
  if (!hasPermission(perms, "owner", "write")) return false;
  return owners.every((o) => findMissingOwnerFieldWritePerm(perms, { name: o.name, address: o.address }) === null);
}

export function registryOwnersToAutoAdd<T extends RegistryOwnerEntry>(
  registryOwners: readonly T[],
  systemNames: readonly string[],
): T[] {
  const rows = ownerDiff(
    registryOwners.map((o) => o.name),
    systemNames,
  ).rows;
  // システムの人と表記だけ違う謄本の人(人が確かめる)。⚠謄本に同じ人が2回載っていると組になるのは
  //   1回目だけなので、行ではなく名前(そろえた形)で除く(@codex #688 R1)。
  const notationOnly = new Set(
    rows
      .filter(
        (r) =>
          r.status === "differs" &&
          r.registryIndex !== null &&
          r.pairKinds.length > 0 &&
          // 外字の違いだけ(システムに外字の名前・謄本は普通の字 など)も、同じ方の表記の違いとして足さない(2026-11-11)
          r.pairKinds.every((k) => k === "kanji" || k === "corp" || k === "gaiji"),
      )
      .map((r) => ownerNameKey(registryOwners[r.registryIndex!].name)),
  );
  const plan = planOwnerReplacement(
    registryOwners,
    systemNames.map((name, i) => ({ ownerId: String(i), name })),
  );
  const addKeys = new Set(plan.add.map((o) => ownerNameKey(o.name)));
  const seen = new Set<string>();
  return registryOwners.filter((o) => {
    // 謄本の外字(私用領域)を含む名前は足さない=どの字か分からず、同じ方が2人になる・□ の宛名になる
    //   (2026-11-11 実機確認)。名義の確認の一覧に「外字を含む」として残り、人が確かめる。
    if (hasPrivateUseChar(o.name)) return false;
    const k = ownerNameKey(o.name);
    if (notationOnly.has(k) || !addKeys.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
