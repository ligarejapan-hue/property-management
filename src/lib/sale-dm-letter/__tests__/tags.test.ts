import { describe, it, expect } from "vitest";
import {
  LETTER_TAGS,
  coarsePropertyLocation,
  expandLetterTags,
  hasUnresolvedTag,
  propertyTypeLabel,
} from "../tags";

describe("LETTER_TAGS", () => {
  it("語彙は物件所在と物件種別の2つだけ(増やすときは設計§2.2の見直しから)", () => {
    expect([...LETTER_TAGS]).toEqual(["物件所在", "物件種別"]);
  });
});

describe("coarsePropertyLocation", () => {
  it("市区町村+町名までに丸める(番地・号は落とす)", () => {
    expect(coarsePropertyLocation("東京都杉並区西荻北3-19-4")).toBe(
      "東京都杉並区西荻北",
    );
    expect(coarsePropertyLocation("神奈川県横浜市南区井土ケ谷中町69-2")).toBe(
      "神奈川県横浜市南区井土ケ谷中町",
    );
  });

  it("丁目は残す(町名の一部として自然に読めるため)", () => {
    expect(coarsePropertyLocation("東京都世田谷区若林2丁目18-3")).toBe(
      "東京都世田谷区若林2丁目",
    );
  });

  it("番地のあとに建物名が続いても、町名までで切る(@codex #376 R4)", () => {
    // ⚠末尾だけを削る作りだと「…2丁目8番1号 新宿ビル」が残り、共通の文面に
    //   建物が特定できる住所が載ってしまう。
    expect(coarsePropertyLocation("東京都新宿区西新宿2丁目8番1号 新宿ビル101")).toBe(
      "東京都新宿区西新宿2丁目",
    );
    expect(coarsePropertyLocation("東京都杉並区西荻北3-19-4 メゾン西荻203")).toBe(
      "東京都杉並区西荻北",
    );
  });

  it("番地が無くても、空白のあとの建物名は落とす", () => {
    expect(coarsePropertyLocation("東京都千代田区丸の内 サンプルビル")).toBe(
      "東京都千代田区丸の内",
    );
    expect(coarsePropertyLocation("東京都千代田区丸の内　サンプルビル")).toBe(
      "東京都千代田区丸の内",
    );
  });

  it("漢数字の番地でも町名までで切る(@codex #376 R5)", () => {
    expect(
      coarsePropertyLocation("東京都新宿区西新宿二丁目八番一号 新宿ビル"),
    ).toBe("東京都新宿区西新宿二丁目");
    expect(coarsePropertyLocation("東京都千代田区丸の内一丁目三番")).toBe(
      "東京都千代田区丸の内一丁目",
    );
  });

  it("⚠地名に含まれる漢数字では切らない(六本木・四谷・三田・九段)", () => {
    for (const a of [
      "東京都港区六本木",
      "東京都新宿区四谷",
      "東京都港区三田",
      "東京都千代田区九段北",
    ]) {
      expect(coarsePropertyLocation(a)).toBe(a);
    }
    expect(coarsePropertyLocation("東京都港区六本木7-1-1")).toBe("東京都港区六本木");
  });

  it("⚠「◯番町」は町名なので切らない(千代田区一番町〜六番町・@codex #376 R6)", () => {
    for (const a of [
      "東京都千代田区一番町",
      "東京都千代田区二番町",
      "東京都千代田区五番町",
    ]) {
      expect(coarsePropertyLocation(a)).toBe(a);
    }
    // 町名のあとに番地が続く場合は、番地の手前で切る。
    expect(coarsePropertyLocation("東京都千代田区一番町6-4")).toBe(
      "東京都千代田区一番町",
    );
    expect(coarsePropertyLocation("東京都千代田区一番町六番二号")).toBe(
      "東京都千代田区一番町",
    );
  });

  it("⚠「◯番丁」も町名なので切らない(仙台市青葉区・和歌山市・@codex #376 R8)", () => {
    // 「丁」は「町」と同じく町名の字。仙台の一番丁〜五番丁、和歌山の一番丁〜七番丁は実在の町名。
    for (const a of [
      "宮城県仙台市青葉区一番丁",
      "宮城県仙台市青葉区二番丁",
      "和歌山県和歌山市一番丁",
    ]) {
      expect(coarsePropertyLocation(a)).toBe(a);
    }
    expect(coarsePropertyLocation("宮城県仙台市青葉区二番丁3-5")).toBe(
      "宮城県仙台市青葉区二番丁",
    );
  });

  it("算用数字で書かれた「1番町/1番丁」も町名として残す(表記ゆれ)", () => {
    expect(coarsePropertyLocation("東京都千代田区1番町6-4")).toBe(
      "東京都千代田区1番町",
    );
    expect(coarsePropertyLocation("宮城県仙台市青葉区2番丁")).toBe(
      "宮城県仙台市青葉区2番丁",
    );
  });

  it("漢数字＋ハイフンの番地も落とす(@codex #376 R13)", () => {
    // ⚠「八－一」は 番/号 を書かない番地の書き方。番/号 だけを見ていると地名の一部と
    //   誤解して**建物が特定できる住所がそのまま**共通の文面に載る。
    expect(coarsePropertyLocation("東京都新宿区西新宿二丁目八－一")).toBe(
      "東京都新宿区西新宿二丁目",
    );
    expect(coarsePropertyLocation("東京都新宿区西新宿二丁目八-一")).toBe(
      "東京都新宿区西新宿二丁目",
    );
    expect(coarsePropertyLocation("東京都千代田区丸の内一丁目三―五")).toBe(
      "東京都千代田区丸の内一丁目",
    );
  });

  it("⚠北海道の「◯条」「◯線」も町名(@codex #376 R17)", () => {
    // 札幌・旭川・帯広に多い書き方。条/線 を町名と見ないと「中央区北」で切れて
    // 意味の通らない文になる（その文が全宛先の手紙に載る）。
    expect(coarsePropertyLocation("北海道札幌市中央区北1条西2丁目3-4")).toBe(
      "北海道札幌市中央区北1条西2丁目",
    );
    expect(coarsePropertyLocation("北海道札幌市中央区北一条西二丁目三-四")).toBe(
      "北海道札幌市中央区北一条西二丁目",
    );
    expect(coarsePropertyLocation("北海道旭川市1条通8丁目")).toBe(
      "北海道旭川市1条通8丁目",
    );
    expect(coarsePropertyLocation("北海道河西郡芽室町東2線")).toBe(
      "北海道河西郡芽室町東2線",
    );
  });

  it("番地が無い住所はそのまま", () => {
    expect(coarsePropertyLocation("東京都千代田区丸の内")).toBe(
      "東京都千代田区丸の内",
    );
  });

  it("⚠知らない書き方は「途中で切った町名」を名乗らず null にする", () => {
    // この関数は表記から番地の始まりを推定しているので、知らない語尾は必ず出てくる
    // (実際 条/線 で作り直した)。そのとき**途中で切れた町名**を返すと、意味の通らない
    // 住所が全宛先の手紙に載る。数字の並びのあとが番地の始まりに見えない＝知らない形
    // なので、名乗らずに null を返す＝適用時に飛ばして件数で報告される。
    expect(coarsePropertyLocation("北海道○○市△△1坪2丁目")).toBeNull();
    expect(coarsePropertyLocation("東京都○○市××3阝")).toBeNull();
  });

  it("⚠漢数字の番地でも「の」で切る(@codex #376 R18)", () => {
    // 「三の四」は 番/号/ハイフン を書かない番地。算用数字側にだけ境界の判定を入れて
    // 漢数字側に入れないと、**住所がまるごと**手紙に載る（同じ穴を片側だけ塞いだ形）。
    expect(coarsePropertyLocation("北海道札幌市中央区北一条西二丁目三の四")).toBe(
      "北海道札幌市中央区北一条西二丁目",
    );
    expect(coarsePropertyLocation("東京都千代田区丸の内一丁目三の五")).toBe(
      "東京都千代田区丸の内一丁目",
    );
  });

  it("番地の始まりだと分かる形は今までどおり切る(の・番・号・ハイフン・空白・行末)", () => {
    expect(coarsePropertyLocation("東京都○○市××町3の5")).toBe("東京都○○市××町");
    expect(coarsePropertyLocation("東京都○○市××町3番5号")).toBe("東京都○○市××町");
    expect(coarsePropertyLocation("東京都○○市××町3")).toBe("東京都○○市××町");
  });

  it("空・null は null(タグを解決できない=適用をスキップする材料)", () => {
    expect(coarsePropertyLocation(null)).toBeNull();
    expect(coarsePropertyLocation("   ")).toBeNull();
  });
});

describe("propertyTypeLabel", () => {
  it("既存の表示名と同じ出所を使う", () => {
    expect(propertyTypeLabel("land")).toBe("土地");
  });

  it("null は null(未解決として扱う)", () => {
    expect(propertyTypeLabel(null)).toBeNull();
  });
});

describe("expandLetterTags", () => {
  it("許可タグを値で置き換える", () => {
    const out = expandLetterTags("{{物件所在}}の{{物件種別}}について", {
      location: "東京都杉並区西荻北",
      propertyType: "土地",
    });
    expect(out).toBe("東京都杉並区西荻北の土地について");
  });

  it("同じタグが複数回あってもすべて置き換える", () => {
    const out = expandLetterTags("{{物件種別}}と{{物件種別}}", {
      location: null,
      propertyType: "戸建",
    });
    expect(out).toBe("戸建と戸建");
  });

  it("値が null のタグは置き換えない(未解決として残す)", () => {
    const out = expandLetterTags("{{物件所在}}", {
      location: null,
      propertyType: "土地",
    });
    expect(out).toBe("{{物件所在}}");
  });

  it("知らないタグは触らない", () => {
    const out = expandLetterTags("{{所有者名}}", {
      location: "A",
      propertyType: "土地",
    });
    expect(out).toBe("{{所有者名}}");
  });
});

describe("hasUnresolvedTag", () => {
  it("展開後に {{ が残っていれば true", () => {
    expect(hasUnresolvedTag("残り{{所有者名}}")).toBe(true);
    expect(hasUnresolvedTag("問題なし")).toBe(false);
  });

  it("片方だけ・閉じ側だけの記号も true(@codex #376 R12)", () => {
    // 展開で開き側が消え、閉じ側だけが残る形（{{物件所在}}} など）を見逃さない。
    expect(hasUnresolvedTag("東京都杉並区西荻北} の件")).toBe(true);
    expect(hasUnresolvedTag("{物件所在} の件")).toBe(true);
  });
});
