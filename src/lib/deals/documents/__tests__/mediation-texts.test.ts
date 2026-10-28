import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MEDIATION_GENERAL } from "../texts/mediation-general";
import { MEDIATION_EXCLUSIVE } from "../texts/mediation-exclusive";
import { MEDIATION_DEDICATED } from "../texts/mediation-dedicated";

const ALL = { general: MEDIATION_GENERAL, exclusive: MEDIATION_EXCLUSIVE, dedicated: MEDIATION_DEDICATED };
const hash = (xs: readonly string[]) => createHash("sha256").update(xs.join("\n")).digest("hex");
/** 型の名前を伏せる(3つの型で同じはずの段落を比べるため)。 */
const anon = (s: string) => s.replace(/専属専任媒介契約|専任媒介契約|一般媒介契約/g, "X媒介契約");
const block = (xs: readonly string[]) => xs.slice(xs.indexOf("・専属専任媒介契約型式"), xs.findIndex((p) => p.startsWith("依頼者甲は")));

/**
 * 写した文面の指紋(設計 第2段階 §3.4)。落ちたら、文面が変わった=全宅連の書式と見比べてから値を直す。
 * 値は、生成したファイル(scripts/deals/extract-zentaku-mediation.py)から取って書いた。
 */
const FINGERPRINTS: Record<keyof typeof ALL, { contract: string; clauses: string }> = {
  general: { contract: "c9f34c599fda07f713923980c7090e34089c237be414e54cd35ccbe4b8a16822", clauses: "379c650307477d71888f58ec7bf1409c56a2a57b94284cc545c99cfbc613d55f" },
  exclusive: { contract: "3f4fd40050a83cc79d955960c71381b391740611d92723d27c0ad0bd4bd8f953", clauses: "888dd67ba2902957c5dd913f46d70f3505e2eb2be87fe301e76533630c8a1699" },
  dedicated: { contract: "c8edd0913f6652752975547d0737e0bb890d7f74b2ce6f53758cd62ac522b310", clauses: "8ae624af742e25eb15f4a47bf2e8315039090535df9df044f433c13c29b30547" },
};

describe("全宅連の媒介契約書から写した文面", () => {
  it("どこから写したかを持つ(作成日・更新日)", () => {
    for (const t of Object.values(ALL)) {
      expect(t.source).toMatch(/^18[012]_\w+\.docx$/);
      expect(t.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.modified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(MEDIATION_GENERAL.title).toBe("一般媒介契約書");
    expect(MEDIATION_EXCLUSIVE.clausesTitle).toBe("専任媒介契約約款");
    expect(MEDIATION_DEDICATED.title).toBe("専属専任媒介契約書");
  });

  it("文面の指紋が変わっていない", () => {
    for (const [k, t] of Object.entries(ALL) as [keyof typeof ALL, (typeof ALL)[keyof typeof ALL]][]) {
      expect({ contract: hash(t.contract), clauses: hash(t.clauses) }, k).toEqual(FINGERPRINTS[k]);
    }
  });

  it("行をそろえる空き・書き込み欄の空白が残っていない(番号の後ろの1つだけ)", () => {
    for (const t of Object.values(ALL)) {
      for (const p of [...t.contract, ...t.clauses]) {
        expect(p, p).not.toMatch(/[  ]/);
        expect(p.replace(/^(第[０-９0-9]+条|[０-９0-9]{1,2}|[一二三四五六七八九十]+|[イロハニホヘト]|注[０-９0-9]*|＊)　/, ""), p).not.toContain("　");
      }
    }
  });

  it("3つの型で同じはずの段落が一字も違わない(整え方の確かめ)", () => {
    const b = block(MEDIATION_EXCLUSIVE.contract);
    expect(b.length).toBe(11);
    expect(block(MEDIATION_GENERAL.contract)).toEqual(b);
    expect(block(MEDIATION_DEDICATED.contract)).toEqual(b);
    const first = (t: (typeof ALL)[keyof typeof ALL]) => anon(t.clauses.find((p) => p.startsWith("第１条"))!);
    expect(first(MEDIATION_GENERAL)).toBe(first(MEDIATION_EXCLUSIVE));
    expect(first(MEDIATION_DEDICATED)).toBe(first(MEDIATION_EXCLUSIVE));
    expect(first(MEDIATION_EXCLUSIVE)).toBe(
      "第１条　この約款は、宅地又は建物の売買又は交換のX媒介契約について、当事者が契約の締結に際して定めるべき事項及び当事者が契約の履行に関して互いに遵守すべき事項を明らかにすることを目的とします。",
    );
  });

  it("最初と最後の段落", () => {
    for (const t of Object.values(ALL)) {
      expect(t.contract[0]).toBe("この媒介契約は、国土交通省が定めた標準媒介契約約款に基づく契約です。");
      expect(t.clauses.at(-1)).toBe("２　この約款の各条項の定めに反する特約で甲に不利なものは無効とします。");
    }
  });

  it("前の会社の名前・リースバックの語が無い", () => {
    for (const t of Object.values(ALL)) for (const w of ["インテリックス", "リースバック"]) expect(JSON.stringify(t)).not.toContain(w);
  });
});
