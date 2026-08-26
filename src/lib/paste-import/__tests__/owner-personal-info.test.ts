/**
 * 備考へ入れてよい／いけないの判定（@codex PR#414 11巡目 ①）。
 *
 * ⚠`Property.note` は所有者の項目別マスクを通らずに表示される。だから
 *   `owner_phone` の権限が無い利用者でも、備考経由なら電話番号を保存でき、
 *   しかも物件を見られる全員に見えてしまう＝**項目別権限チェックの迂回路**。
 */
import { describe, it, expect } from "vitest";
import {
  judgeOwnerPersonalInfo,
  looksLikePhoneNumber,
  looksLikeEmailAddress,
} from "../owner-personal-info";

describe("judgeOwnerPersonalInfo（見出しの語で見分ける）", () => {
  const PII_LABELS = [
    "携帯電話",
    "電話番号",
    "ご連絡先電話",
    "TEL",
    "tel（自宅）",
    "ＦＡＸ",
    "メールアドレス",
    "E-mail",
    "連絡先住所",
    "現住所",
    "ご住所",
    "郵便番号",
    "氏名",
    "お名前",
    "フリガナ",
    "年齢",
    "生年月日",
  ];

  for (const label of PII_LABELS) {
    it(`★「${label}」は備考に入れない`, () => {
      const v = judgeOwnerPersonalInfo(label, "なにかの値");
      expect(v.isOwnerPersonalInfo).toBe(true);
      expect(v.reason).toBe("label");
    });
  }

  const SAFE_LABELS = [
    "建物構造",
    "私道負担の有無",
    "希望する利活用方法",
    "コメント",
    "空き家所有者との関係性",
    "売却の希望時期",
    "名義",
    "階数",
  ];

  for (const label of SAFE_LABELS) {
    it(`「${label}」は従来どおり備考に入る（過剰に落としていない）`, () => {
      expect(judgeOwnerPersonalInfo(label, "木造スレート葺").isOwnerPersonalInfo).toBe(false);
    });
  }

  it("★「物件住所」「物件所在地」は所有者の個人情報とみなさない（物件のこと）", () => {
    expect(judgeOwnerPersonalInfo("物件住所", "東京都A区B1-2-3").isOwnerPersonalInfo).toBe(false);
    expect(judgeOwnerPersonalInfo("物件所在地", "東京都A区B1-2-3").isOwnerPersonalInfo).toBe(false);
    expect(judgeOwnerPersonalInfo("土地の所在地", "東京都A区B1-2-3").isOwnerPersonalInfo).toBe(false);
  });

  it("★全角・半角・空白・大文字小文字の違いを吸収する", () => {
    for (const label of ["ＴＥＬ", "ｔｅｌ", "T E L", "Ｅメール"]) {
      expect(judgeOwnerPersonalInfo(label, "値").isOwnerPersonalInfo, label).toBe(true);
    }
  });
});

describe("judgeOwnerPersonalInfo（値の形で見分ける）", () => {
  it("★見出しが分からなくても、値が電話番号なら備考に入れない", () => {
    // 「ご連絡先」「お問い合わせ先」のような見出しはいくらでも増える。
    const v = judgeOwnerPersonalInfo("ご連絡いただける時間帯の窓口", "090-1234-5678");
    expect(v.isOwnerPersonalInfo).toBe(true);
    expect(v.reason).toBe("value");
  });

  it("★見出しが分からなくても、値がメールアドレスなら備考に入れない", () => {
    const v = judgeOwnerPersonalInfo("その他", "yamada@example.com");
    expect(v.isOwnerPersonalInfo).toBe(true);
    expect(v.reason).toBe("value");
  });

  it("★物件の住所は「値の形」でも拾わない（電話でもメールでもない）", () => {
    expect(judgeOwnerPersonalInfo("備考", "東京都A区B1-2-3").isOwnerPersonalInfo).toBe(false);
  });
});

describe("looksLikePhoneNumber / looksLikeEmailAddress", () => {
  it("★電話番号らしい形（10〜11桁・区切りは任意・全角も）", () => {
    for (const v of ["090-1234-5678", "09012345678", "03-1234-5678", "０９０－１２３４－５６７８", "(03) 1234 5678"]) {
      expect(looksLikePhoneNumber(v), v).toBe(true);
    }
  });

  it("★桁数が違うもの・数字以外を含むものは電話番号とみなさない", () => {
    for (const v of ["123", "1234567890123", "東京都A区1-2-3", "552-2", "70.55", ""]) {
      expect(looksLikePhoneNumber(v), v).toBe(false);
    }
  });

  it("★地番「552-2」を電話番号と取り違えない（誤検出の代表例）", () => {
    expect(looksLikePhoneNumber("552-2")).toBe(false);
  });

  it("★メールアドレスらしい形", () => {
    for (const v of ["a@example.com", "yamada.taro@example.co.jp"]) {
      expect(looksLikeEmailAddress(v), v).toBe(true);
    }
    for (const v of ["yamada", "@example.com", "a@b", "東京都A区1-2-3", ""]) {
      expect(looksLikeEmailAddress(v), v).toBe(false);
    }
  });
});

// ===========================================================================
// 所有者語と物件語の優先順位（@codex PR#414 12巡目 ②）
//
// ⚠R11 で入れた「物件系の見出しを先に除外」が広すぎ、`物件所有者氏名` の
//   氏名が備考へ素通りしていた。**例外は、それ自体が新しい穴になる**。
//   4象限（所有者語あり×物件語あり／所有者語のみ／物件語のみ／どちらも無し）を
//   総当たりで固定する。
// ===========================================================================

const OWNER_WORDS = ["所有者", "名義人", "氏名", "名前", "フリガナ"];
const PROPERTY_WORDS = ["物件", "所在地", "土地", "建物"];
/** 所有者の個人情報にあたる項目（見出しの語で判定できるもの）。 */
const PII_SUFFIXES = ["氏名", "住所", "電話", "メールアドレス"];

describe("4象限: 所有者語 × 物件語", () => {
  it("★① 所有者語あり × 物件語あり → 所有者側を優先して withheld", () => {
    // ここが今回の穴。`物件所有者氏名: 山田太郎` が備考へ入っていた。
    const cases = [
      "物件所有者氏名",
      "物件所有者住所",
      "土地所有者の電話番号",
      "建物名義人氏名",
      "所在地の所有者メールアドレス",
    ];
    for (const label of cases) {
      const v = judgeOwnerPersonalInfo(label, "山田太郎");
      expect(v.isOwnerPersonalInfo, label).toBe(true);
      expect(v.reason, label).toBe("label");
    }
  });

  it("★② 所有者語のみ → withheld", () => {
    for (const owner of OWNER_WORDS) {
      for (const pii of PII_SUFFIXES) {
        const label = `${owner}${pii}`;
        expect(judgeOwnerPersonalInfo(label, "山田太郎").isOwnerPersonalInfo, label).toBe(true);
      }
    }
    expect(judgeOwnerPersonalInfo("所有者住所", "東京都A区B1-2-3").isOwnerPersonalInfo).toBe(true);
  });

  it("★③ 物件語のみ → 従来どおり備考に入る（過剰に落とさない）", () => {
    for (const prop of PROPERTY_WORDS) {
      for (const tail of ["住所", "所在地", "の面積", "構造"]) {
        const label = `${prop}${tail}`;
        expect(judgeOwnerPersonalInfo(label, "東京都A区B1-2-3").isOwnerPersonalInfo, label).toBe(
          false,
        );
      }
    }
  });

  it("★④ どちらも無し → 見出しの語だけで判断（PII語があれば withheld、無ければ備考）", () => {
    expect(judgeOwnerPersonalInfo("携帯電話", "090-1234-5678").isOwnerPersonalInfo).toBe(true);
    expect(judgeOwnerPersonalInfo("建物構造", "木造").isOwnerPersonalInfo).toBe(false);
    expect(judgeOwnerPersonalInfo("希望する利活用方法", "売却").isOwnerPersonalInfo).toBe(false);
  });

  it("★物件語 × 所有者語の全組み合わせで、所有者語が勝つ", () => {
    // 「例外の例外」を機械的に洗う。どの組み合わせでも所有者側が優先されること。
    const offenders: string[] = [];
    for (const prop of PROPERTY_WORDS) {
      for (const owner of OWNER_WORDS) {
        for (const pii of PII_SUFFIXES) {
          const label = `${prop}${owner}${pii}`;
          if (!judgeOwnerPersonalInfo(label, "山田太郎").isOwnerPersonalInfo) {
            offenders.push(label);
          }
        }
      }
    }
    expect(offenders, `備考へ素通りする見出し: ${offenders.join(", ")}`).toEqual([]);
  });

  it("★実サンプルの『名義: 本人所有』は所有形態であって氏名ではない（備考に入る）", () => {
    // 所有者語(名義/本人)を含むが、個人情報の項目名ではないので落とさない。
    expect(judgeOwnerPersonalInfo("名義", "本人所有").isOwnerPersonalInfo).toBe(false);
  });

  it("★『名義人』は氏名の欄なので落とす", () => {
    expect(judgeOwnerPersonalInfo("名義人", "山田太郎").isOwnerPersonalInfo).toBe(true);
  });
});
