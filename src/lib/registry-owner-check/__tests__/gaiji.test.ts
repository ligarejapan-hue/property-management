/**
 * 謄本の外字(私用領域の字)を含む名前(2026-11-11 実機確認)。
 * ⚠守りたい事故: 外字のまま所有者に自動で登録され、同じ方が2人になる(□ の宛名・2通の DM)/
 *   外字の名前どうしが「✓ 同じ」になって、確かめる一覧から消える
 */
import { describe, it, expect } from "vitest";
import { registryOwnersToAutoAdd } from "@/lib/registry-owner-check/auto-add";
import { compareRegistryOwners, planOwnerReplacement } from "@/lib/registry-owner-check/compare";
import { ownerDiff, ownerDiffLabelFromStored } from "@/lib/registry-owner-check/diff";
import { hasPrivateUseChar } from "@/lib/private-use-char";

const G = "\uE0A6"; // 謄本の外字(私用領域)
const reg = (...names: string[]) => names.map((name) => ({ name, address: `住所-${name}`, share: null }));
const names = (xs: Array<{ name: string }>) => xs.map((x) => x.name);

describe("hasPrivateUseChar", () => {
  it("U+E000〜U+F8FF の字があれば true", () => {
    expect(hasPrivateUseChar(`大${G}一郎`)).toBe(true);
    expect(hasPrivateUseChar("\uE000")).toBe(true);
    expect(hasPrivateUseChar("\uF8FF")).toBe(true);
  });
  it("普通の字・異体字・第2面の字・空は false", () => {
    expect(hasPrivateUseChar("髙橋一郎")).toBe(false);
    expect(hasPrivateUseChar("𠮷田花子")).toBe(false);
    expect(hasPrivateUseChar("豈")).toBe(false); // 互換漢字は私用領域ではない
    expect(hasPrivateUseChar("")).toBe(false);
    expect(hasPrivateUseChar(null)).toBe(false);
  });
});

describe("自動の登録: 外字を含む謄本の人は足さない", () => {
  it("システムに似た人がいる(外字が普通の字で入っている)=足さない", () => {
    expect(registryOwnersToAutoAdd(reg(`大${G}一郎`), ["大塚一郎"])).toEqual([]);
  });
  it("システムにだれもいない・別の人しかいない=足さない", () => {
    expect(registryOwnersToAutoAdd(reg(`大${G}一郎`), [])).toEqual([]);
    expect(registryOwnersToAutoAdd(reg(`大${G}一郎`), ["佐藤花子"])).toEqual([]);
  });
  it("外字の人と、外字の無い謄本だけの人が混ざる=外字の無い人だけ足す", () => {
    expect(names(registryOwnersToAutoAdd(reg(`大${G}一郎`, "鈴木花子"), ["大塚一郎"]))).toEqual(["鈴木花子"]);
  });
  it("システムに外字の名前で入っている人と、謄本の普通の字の人=同じ方として足さない(2人目を作らない)", () => {
    expect(registryOwnersToAutoAdd(reg("大塚一郎"), [`大${G}一郎`])).toEqual([]);
  });
  it("外字の無い人は今までどおり足す", () => {
    expect(names(registryOwnersToAutoAdd(reg("鈴木一郎"), ["佐藤花子"]))).toEqual(["鈴木一郎"]);
  });
});

describe("名義の比べ: 外字はどの字とも一致しない", () => {
  it("謄本とシステムが同じ外字の名前でも「同じ」にしない", () => {
    expect(compareRegistryOwners([`大${G}一郎`], [`大${G}一郎`])).toBe("mismatch");
  });
  it("実機の形: システムに普通の字の人+外字のまま入った人 → 違う", () => {
    expect(compareRegistryOwners([`大${G}一郎`], ["大塚一郎", `大${G}一郎`])).toBe("mismatch");
  });
  it("外字の無い名前は今までどおり(同じ・表記の違い)", () => {
    expect(compareRegistryOwners(["山田太郎"], ["山田 太郎"])).toBe("same");
    expect(compareRegistryOwners(["髙橋一郎"], ["高橋一郎"])).toBe("same_notation");
  });

  it("一覧の組: 同じ外字の名前でも「✓ 同じ」にせず、外字を含む違いとして出す", () => {
    const d = ownerDiff([`大${G}一郎`], [`大${G}一郎`]);
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0].status).toBe("differs");
    expect(d.rows[0].pairKinds).toEqual(["gaiji"]);
    // 外字の字に印が付く
    expect(d.rows[0].registry).toEqual([
      { text: "大", diff: false },
      { text: G, diff: true },
      { text: "一郎", diff: false },
    ]);
    expect(d.kinds.map((k) => k.code)).toEqual(["gaiji"]);
    expect(ownerDiffLabelFromStored(d.stored)).toBe("外字を含む（謄本の字が読めない）");
  });

  it("実機の形: 普通の字の人と外字のまま入った人がいる=「✓ 同じ」にならず外字と人数の違いを出す", () => {
    const d = ownerDiff([`大${G}一郎`], ["大塚一郎", `大${G}一郎`]);
    const statuses = d.rows.map((r) => r.status);
    expect(statuses).not.toContain("same");
    expect(d.kinds.map((k) => k.code)).toContain("gaiji");
    expect(d.kinds.map((k) => k.code)).toContain("count");
  });

  it("外字のほかに名前の一部も違う=両方出す", () => {
    const d = ownerDiff([`大${G}一郎太`], ["大塚一郎"]);
    expect(d.rows[0].pairKinds).toEqual(["gaiji", "partial"]);
  });

  it("一覧の違いの種類(保存した形)と、開いた中身の違いの種類が同じ文言になる(実機の形)", () => {
    const d = ownerDiff([`大${G}一郎`], ["大塚一郎", `大${G}一郎`]);
    expect(ownerDiffLabelFromStored(`${d.stored},autoadd`)).toBe(d.kinds.map((k) => k.label).join("・"));
    expect(ownerDiffLabelFromStored(d.stored)).toBe("外字を含む（謄本の字が読めない）・人数が違う（謄本1名・システム2名）");
  });

  it("異体字(髙/高)の扱いは変わらない", () => {
    const d = ownerDiff(["髙橋一郎"], ["高橋一郎"]);
    expect(d.rows[0].pairKinds).toEqual(["kanji"]);
    expect(d.kinds[0].label).toBe("漢字の違い（髙／高）");
    expect(ownerDiff(["山田太郎"], ["山田太郎"]).rows[0].status).toBe("same");
  });
});

describe("謄本の名義に直す: 外字の組はシステムの人をそのまま残す(2026-11-11 昼 実機確認)", () => {
  const sys = (...xs: string[]) => xs.map((name, i) => ({ ownerId: `o${i + 1}`, name }));

  it("実機の形: 普通の字の人は残し、外字のまま入ったシステムだけの人は今までどおり外す・謄本の外字の人は足さない", () => {
    const plan = planOwnerReplacement(reg(`大${G}一郎`), sys("大塚一郎", `大${G}一郎`));
    expect(plan).toEqual({ keepOwnerIds: ["o1"], removeOwnerIds: ["o2"], add: [] });
  });

  it("所有者の並び順が逆でも同じ(普通の字の人を組にして残す)", () => {
    const plan = planOwnerReplacement(reg(`大${G}一郎`), sys(`大${G}一郎`, "大塚一郎"));
    expect(plan).toEqual({ keepOwnerIds: ["o2"], removeOwnerIds: ["o1"], add: [] });
    const d = ownerDiff([`大${G}一郎`], [`大${G}一郎`, "大塚一郎"]);
    expect(d.rows.find((r) => r.status === "differs")?.systemIndex).toBe(1);
  });

  it("外字の組だけ=何も外さない・足さない", () => {
    expect(planOwnerReplacement(reg(`大${G}一郎`), sys("大塚一郎"))).toEqual({
      keepOwnerIds: ["o1"],
      removeOwnerIds: [],
      add: [],
    });
    expect(planOwnerReplacement(reg(`大${G}一郎`), sys(`大${G}一郎`))).toEqual({
      keepOwnerIds: ["o1"],
      removeOwnerIds: [],
      add: [],
    });
  });

  it("外字のほかに名前の一部も違う組も、システムの人を残す", () => {
    expect(planOwnerReplacement(reg(`大${G}一郎太`), sys("大塚一郎"))).toEqual({
      keepOwnerIds: ["o1"],
      removeOwnerIds: [],
      add: [],
    });
  });

  it("外字の組+システムだけの人+謄本だけの人: システムだけの人は外し、謄本だけの人は足す", () => {
    const plan = planOwnerReplacement(reg(`大${G}一郎`, "鈴木花子"), sys("大塚一郎", "佐藤次郎"));
    expect(plan.keepOwnerIds).toEqual(["o1"]);
    expect(plan.removeOwnerIds).toEqual(["o2"]);
    expect(names(plan.add)).toEqual(["鈴木花子"]);
  });

  it("謄本に同じ外字の人が2回載っていても足さない", () => {
    expect(planOwnerReplacement(reg(`大${G}一郎`, `大${G}一郎`), sys("大塚一郎")).add).toEqual([]);
  });

  it("外字を含まない物件は今までどおり(入れ替え・表記の違い)", () => {
    const swap = planOwnerReplacement(reg("鈴木一郎"), sys("佐藤一郎"));
    expect(swap.removeOwnerIds).toEqual(["o1"]);
    expect(names(swap.add)).toEqual(["鈴木一郎"]);
    expect(planOwnerReplacement(reg("髙橋一郎"), sys("高橋一郎"))).toEqual({
      keepOwnerIds: ["o1"],
      removeOwnerIds: [],
      add: [],
    });
  });
});
