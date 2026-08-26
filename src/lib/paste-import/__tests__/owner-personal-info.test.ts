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
