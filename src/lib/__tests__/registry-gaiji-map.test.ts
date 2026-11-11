import { describe, expect, it } from "vitest";

import { REGISTRY_GAIJI_MAP, replaceRegistryGaiji } from "@/lib/registry-gaiji-map";
import { hasPrivateUseChar } from "@/lib/private-use-char";
import { parseRegistryOwnerTable } from "@/lib/registry-owner-table";
import { parseRegistryText } from "@/lib/pdf-registry-parser";

describe("replaceRegistryGaiji", () => {
  it("表にある外字を普通の字にする(名前の中の位置はそのまま)", () => {
    expect(replaceRegistryGaiji("大一郎")).toBe("大塚一郎");
    expect(replaceRegistryGaiji("本子")).toBe("塚本西子");
  });

  it("サロゲートの字・互換の字も正しく入る(𠮷・﨑)", () => {
    expect(replaceRegistryGaiji("田")).toBe("\u{20BB7}田");
    expect(replaceRegistryGaiji("山")).toBe("山﨑");
  });

  it("発注者が画像で決めた字(2026-11-11)", () => {
    expect(replaceRegistryGaiji("")).toBe("土簗鍢啓真道翠寿翔");
  });

  it("表に無い外字はそのまま残す(読めない字として守りが効く)", () => {
    const out = replaceRegistryGaiji("山太郎");
    expect(out).toBe("山太郎");
    expect(hasPrivateUseChar(out)).toBe(true);
  });

  it("外字の無い文字列は同じものを返す", () => {
    const s = "東京都渋谷区神宮前三丁目12番3号";
    expect(replaceRegistryGaiji(s)).toBe(s);
  });

  it("表は外字(私用領域)の1字から、私用領域でない1字へ", () => {
    expect(REGISTRY_GAIJI_MAP.size).toBe(108);
    for (const [from, to] of REGISTRY_GAIJI_MAP) {
      expect([...from]).toHaveLength(1);
      expect(hasPrivateUseChar(from)).toBe(true);
      expect([...to]).toHaveLength(1);
      expect(hasPrivateUseChar(to)).toBe(false);
    }
  });
});

const ownerTable = (address: string, name: string) =>
  [
    "2026/09/15 10:00 登記情報提供サービス。",
    "東京都渋谷区神宮前三丁目123-4 所有者事項 （土地）",
    "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
    "┃ 所 有 者 ┃",
    "┠────────────────────┬─────────────┨",
    "┃ 住 所 │ 氏 名 ┃",
    "┠────────────────────┼─────────────┨",
    `┃${address} │${name} ┃`,
    "┗━━━━━━━━━━━━━━━━━━┷━━━━━━━━━┛",
    "",
    "-- 1 of 1 --",
  ].join("\n");

describe("謄本の読み取りで外字を普通の字にする", () => {
  it("所有者の表: 名前と住所の外字を置き換える", () => {
    const owners = parseRegistryOwnerTable(ownerTable("東京都渋谷区原一丁目1番1号", "大一郎"));
    expect(owners).toEqual([expect.objectContaining({ name: "大塚一郎", address: "東京都渋谷区西原一丁目1番1号" })]);
  });

  it("所有者の表: 表に無い外字は残る", () => {
    const owners = parseRegistryOwnerTable(ownerTable("東京都渋谷区神宮前三丁目12番3号", "山太郎"));
    expect(owners?.[0]?.name).toBe("山太郎");
  });

  it("謄本の取込(parseRegistryText)でも所有者の名前が普通の字になる", () => {
    const parsed = parseRegistryText(ownerTable("東京都渋谷区神宮前三丁目12番3号", "大一郎"));
    expect(parsed.owners.map((o) => o.name)).toContain("大塚一郎");
    expect(parsed.owners.some((o) => hasPrivateUseChar(o.name))).toBe(false);
  });

  it("家屋番号の欄の外字は今までどおり空白として落とす(表にある番号でも字にしない)", () => {
    const parsed = parseRegistryText("所在 渋谷区神宮前三丁目\n家屋番号 12番3\n種類 居宅");
    expect(parsed.buildingNumber).toBe("12番3");
  });
});
