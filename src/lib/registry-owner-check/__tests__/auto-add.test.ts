/**
 * 謄本にだけいる人を自動で登録する: 誰を足すか(2026-11-10 発注者決定)。
 * ⚠守りたい事故: 表記の違いだけの人を別人として二重に登録する/今いる人を書き換える
 */
import { describe, it, expect } from "vitest";
import { registryOwnersToAutoAdd, uploaderMayAutoAdd } from "@/lib/registry-owner-check/auto-add";
import { ownerDiffLabelFromStored, AUTO_ADD_DONE_TOKEN } from "@/lib/registry-owner-check/diff";

const reg = (...names: string[]) => names.map((name) => ({ name, address: `住所-${name}`, share: null }));
const names = (xs: Array<{ name: string }>) => xs.map((x) => x.name);

describe("registryOwnersToAutoAdd", () => {
  it("別の人(所有者が変わった)=謄本の人を住所つきで足す", () => {
    const out = registryOwnersToAutoAdd(reg("鈴木一郎"), ["佐藤花子"]);
    expect(out).toEqual([{ name: "鈴木一郎", address: "住所-鈴木一郎", share: null }]);
  });

  it("人数が違う(謄本に1人多い)=多い人だけ足す", () => {
    expect(names(registryOwnersToAutoAdd(reg("山田太郎", "田中次郎"), ["山田太郎"]))).toEqual(["田中次郎"]);
  });

  it("表記だけの違い(漢字1字ずつ・法人の書き方)は足さない=人が確かめる", () => {
    expect(registryOwnersToAutoAdd(reg("髙橋一郎"), ["高橋一郎"])).toEqual([]);
    expect(registryOwnersToAutoAdd(reg("株式会社山田商事"), ["(株)山田商事"])).toEqual([]);
    // 異体字の表に無い1字の違いも表記の違いとして扱う
    expect(registryOwnersToAutoAdd(reg("山田太朗"), ["山田太郎"])).toEqual([]);
    expect(registryOwnersToAutoAdd(reg("株式会社山田商亊"), ["(株)山田商事"])).toEqual([]);
    // 謄本に同じ人が2回載っていても足さない(@codex #688 R1)
    expect(registryOwnersToAutoAdd(reg("山田太朗", "山田太朗"), ["山田太郎"])).toEqual([]);
    expect(registryOwnersToAutoAdd(reg("山田太朗", "山田 太朗"), ["山田太郎"])).toEqual([]);
  });

  it("名前の一部が違う・姓や名が替わった(2字以上)=別の人として足す", () => {
    // 相続などで家族に替わった
    expect(names(registryOwnersToAutoAdd(reg("山田花子"), ["山田太郎"]))).toEqual(["山田花子"]);
    // 姓が替わった
    expect(names(registryOwnersToAutoAdd(reg("鈴木一郎"), ["佐藤一郎"]))).toEqual(["鈴木一郎"]);
    // 仮名と漢字
    expect(names(registryOwnersToAutoAdd(reg("山田タロウ"), ["山田太郎"]))).toEqual(["山田タロウ"]);
  });

  it("組になった人と、謄本にだけいる人が混ざる=謄本にだけいる人だけ", () => {
    expect(names(registryOwnersToAutoAdd(reg("髙橋一郎", "鈴木花子"), ["高橋一郎"]))).toEqual(["鈴木花子"]);
  });

  it("システムにだけいる人がいても外す人は返さない(足す人だけ)", () => {
    expect(names(registryOwnersToAutoAdd(reg("鈴木一郎"), ["佐藤花子", "佐藤次郎"]))).toEqual(["鈴木一郎"]);
  });

  it("謄本に同じ人が2回・今いる人とそろえて同じ=二重に足さない", () => {
    expect(registryOwnersToAutoAdd(reg("山田太郎", "山田 太郎"), ["山田太郎"])).toEqual([]);
    expect(names(registryOwnersToAutoAdd(reg("鈴木一郎", "鈴木　一郎"), []))).toEqual(["鈴木一郎"]);
  });

  it("同じなら何も足さない", () => {
    expect(registryOwnersToAutoAdd(reg("山田太郎"), ["山田太郎"])).toEqual([]);
  });
});

describe("uploaderMayAutoAdd(謄本を添付した人が自分で反映できるか)", () => {
  const g = (resource: string, action: string) => ({ resource, action, granted: true });
  const FULL = [
    g("property", "read"), g("registry_pdf", "preview"), g("import", "write"), g("owner", "write"),
    g("owner_name", "full"), g("owner_address", "full"),
  ];
  const owners = [{ name: "鈴木一郎", address: "東京都" }];
  it("反映の窓口と同じ権限がそろえば true", () => {
    expect(uploaderMayAutoAdd(FULL, owners)).toBe(true);
  });
  it("どれか1つでも欠ければ false(偽の謄本で所有者を足させない)", () => {
    for (const drop of ["property", "registry_pdf", "import", "owner", "owner_name", "owner_address"]) {
      expect(uploaderMayAutoAdd(FULL.filter((p) => p.resource !== drop), owners)).toBe(false);
    }
  });
});

describe("自動の登録の印は一覧の文言に出さない", () => {
  it("印だけを除く", () => {
    expect(ownerDiffLabelFromStored(`count:2:1,${AUTO_ADD_DONE_TOKEN}`)).toBe("人数が違う（謄本2名・システム1名）");
    expect(ownerDiffLabelFromStored(AUTO_ADD_DONE_TOKEN)).toBeNull();
  });
});
