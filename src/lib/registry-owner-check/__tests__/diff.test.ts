/**
 * 謄本の名義の確認: 違う部分に色を付ける(2026-11-09 発注者依頼)。名前はすべて架空。
 * - 似ている人どうしを組にする・組にならない人は相手を空欄
 * - 組の中で違う文字だけに印(全角半角・空白は違いにしない)
 * - 物件ごとの違いの種類(漢字・法人の書き方・人数・別の人)
 */
import { describe, it, expect } from "vitest";
import {
  diffChars,
  ownerDiff,
  ownerDiffLabelFromStored,
  OWNER_DIFF_RANK,
  type Segment,
} from "@/lib/registry-owner-check/diff";

const marked = (segs: Segment[]) => segs.filter((s) => s.diff).map((s) => s.text).join("|");
const plain = (segs: Segment[]) => segs.map((s) => s.text).join("");

describe("diffChars", () => {
  it("違う文字だけに印を付ける(元の文字のまま)", () => {
    const d = diffChars("高橋 一郎", "髙橋 一郎");
    expect(marked(d.a)).toBe("高");
    expect(marked(d.b)).toBe("髙");
    expect(plain(d.a)).toBe("高橋 一郎");
    expect(plain(d.b)).toBe("髙橋 一郎");
  });
  it("全角半角・空白の違いは印にしない", () => {
    const d = diffChars("ＡＢＣ商事　太郎", "ABC商事太郎");
    expect(marked(d.a)).toBe("");
    expect(marked(d.b)).toBe("");
  });
  it("続いた違いはひとまとまり", () => {
    const d = diffChars("（株）見本商事", "見本商事株式会社");
    expect(marked(d.a)).toBe("（株）");
    expect(marked(d.b)).toBe("株式会社");
  });
});

describe("ownerDiff: 組にする", () => {
  it("似ている人どうしを組にし、組にならない人は相手を空欄にする", () => {
    const r = ownerDiff(["髙橋 一郎", "見本商事株式会社", "髙橋 次郎"], ["高橋 一郎", "（株）見本商事"]);
    expect(r.rows.map((x) => [x.systemIndex, x.registryIndex, x.status])).toEqual([
      [0, 0, "differs"],
      [1, 1, "differs"],
      [null, 2, "registry_only"],
    ]);
  });
  it("並び順が違っても名前の似ている度合いで組にする", () => {
    const r = ownerDiff(["鈴木 洋子", "鈴木 太郎"], ["鈴木太郎", "鈴木洋子"]);
    expect(r.rows.map((x) => [x.systemIndex, x.registryIndex, x.status])).toEqual([
      [0, 1, "same"],
      [1, 0, "same"],
    ]);
  });
  it("似ていない人は組にしない(別の人)", () => {
    const r = ownerDiff(["株式会社例示ホーム"], ["佐藤 花子"]);
    expect(r.rows.map((x) => [x.systemIndex, x.registryIndex, x.status])).toEqual([
      [0, null, "system_only"],
      [null, 0, "registry_only"],
    ]);
  });
  it("空の名前は並べない", () => {
    const r = ownerDiff(["山田 太郎", " "], ["山田太郎"]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].status).toBe("same");
  });
  it("組の違う文字に印を付ける", () => {
    const r = ownerDiff(["髙橋 一郎"], ["高橋 一郎"]);
    expect(marked(r.rows[0].system!)).toBe("高");
    expect(marked(r.rows[0].registry!)).toBe("髙");
  });
});

describe("ownerDiff: 違いの種類", () => {
  const labels = (reg: string[], sys: string[]) => ownerDiff(reg, sys).kinds.map((k) => k.label);

  it("漢字の違い(謄本／システムの字)", () => {
    expect(labels(["髙橋 一郎", "山田 﨑子"], ["高橋 一郎", "山田 崎子"])).toEqual(["漢字の違い（髙／高、﨑／崎）"]);
  });
  it("法人の書き方の違い", () => {
    expect(labels(["見本商事株式会社"], ["（株）見本商事"])).toEqual(["法人の書き方の違い"]);
    expect(labels(["株式会社見本商事"], ["見本商事株式会社"])).toEqual(["法人の書き方の違い"]);
  });
  it("人数が違う", () => {
    expect(labels(["鈴木 太郎"], ["鈴木 太郎", "鈴木 洋子"])).toEqual(["人数が違う（謄本1名・システム2名）"]);
  });
  it("全員が別の人なら、所有者が変わった可能性", () => {
    expect(labels(["株式会社例示ホーム"], ["佐藤 花子"])).toEqual(["別の人（所有者が変わった可能性）"]);
  });
  it("人数は同じで一部が別の人", () => {
    expect(labels(["鈴木 太郎", "株式会社例示ホーム"], ["鈴木 太郎", "佐藤 花子"])).toEqual([
      "一部が別の人（所有者が変わった可能性）",
    ]);
  });
  it("仮名の違いは「名前の一部が違う」", () => {
    expect(labels(["山田 はなこ"], ["山田 はるこ"])).toEqual(["名前の一部が違う"]);
  });
  it("いくつも重なれば並べる(種類の順)", () => {
    expect(labels(["髙橋 一郎", "見本商事株式会社", "髙橋 次郎"], ["高橋 一郎", "（株）見本商事"])).toEqual([
      "漢字の違い（髙／高）",
      "法人の書き方の違い",
      "人数が違う（謄本3名・システム2名）",
    ]);
  });
  it("違いが無ければ種類は空", () => {
    expect(labels(["山田 太郎"], ["山田太郎"])).toEqual([]);
  });
});

describe("保存する形(名前・文字は残さない)", () => {
  it("種類の記号と人数だけ", () => {
    const r = ownerDiff(["髙橋 一郎", "見本商事株式会社", "髙橋 次郎"], ["高橋 一郎", "（株）見本商事"]);
    expect(r.stored).toBe("kanji,corp,count:3:2");
    expect(r.stored).not.toMatch(/[髙高橋]/);
    expect(r.rank).toBe(OWNER_DIFF_RANK.count);
  });
  it("一番重い種類で並べる", () => {
    expect(ownerDiff(["髙橋 一郎"], ["高橋 一郎"]).rank).toBe(OWNER_DIFF_RANK.kanji);
    expect(ownerDiff(["株式会社例示ホーム"], ["佐藤 花子"]).rank).toBe(OWNER_DIFF_RANK.different);
  });
  it("違いが無いときは other(違うと判定されたのに種類が出ない場合の受け皿)", () => {
    const r = ownerDiff(["山田 太郎"], ["山田太郎"]);
    expect(r.stored).toBe("other");
    expect(r.rank).toBe(OWNER_DIFF_RANK.other);
  });
  it("保存した形から一覧の文言に戻す(字は出さない)", () => {
    expect(ownerDiffLabelFromStored("kanji,corp,count:3:2")).toBe("漢字の違い・法人の書き方の違い・人数が違う（謄本3名・システム2名）");
    expect(ownerDiffLabelFromStored("different")).toBe("別の人（所有者が変わった可能性）");
    expect(ownerDiffLabelFromStored(null)).toBeNull();
    expect(ownerDiffLabelFromStored("unknown_code")).toBe("その他の違い");
  });
});
