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
  looksLikeAddress,
  looksLikePersonName,
  isDefinitelyNonPersonalValue,
  MAX_SAFE_NUMERIC_DIGITS,
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

  it("★判定できない見出し + 住所らしい値 → withheld（既定の向きが反転した証拠）", () => {
    // ⚠旧実装(危険と確定できたら withheld)ではここは false だった。
    //   いまは「安全と確定できたら通す」なので、見出しから安全と言い切れない
    //   ものは、値が住所らしければ伏せる。
    const v = judgeOwnerPersonalInfo("備考", "東京都A区B1-2-3");
    expect(v.isOwnerPersonalInfo).toBe(true);
    expect(v.reason).toBe("value");
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

  it("★③ 物件系と**完全一致**で確定できる見出しは備考に入る", () => {
    // ⚠14巡目 ②: 「所在地を含む」では確定しない。完全一致の有限リストだけ。
    for (const label of [
      "物件所在地", "物件の所在地", "物件住所", "物件の住所",
      "所在地", "所在", "土地所在地", "建物所在地",
    ]) {
      expect(judgeOwnerPersonalInfo(label, "東京都A区B1-2-3").isOwnerPersonalInfo, label).toBe(
        false,
      );
    }
  });

  it("★③-b 物件語を含むだけの見出しは確定しない → 値の形で判定される", () => {
    // ⚠これは**意図した過剰**。`勤務先所在地` `会社所在地` を通さないために、
    //   完全一致以外は「判定不能」に落とす。値が住所らしければ withheld になり、
    //   画面に出て人が備考へ移せる（回復可能な側の誤り）。
    for (const label of ["物件の面積", "土地の広さ", "建物の状態"]) {
      expect(judgeOwnerPersonalInfo(label, "東京都A区B1-2-3").isOwnerPersonalInfo, label).toBe(
        true,
      );
    }
    // 値が住所らしくなければ、これまでどおり備考に入る。
    for (const label of ["物件の面積", "建物構造"]) {
      expect(judgeOwnerPersonalInfo(label, "70.55").isOwnerPersonalInfo, label).toBe(false);
    }
    expect(judgeOwnerPersonalInfo("建物構造", "木造").isOwnerPersonalInfo).toBe(false);
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

// ===========================================================================
// 既定の向きの反転（@codex PR#414 13巡目 ①）
//
// ⚠R11→R12→R13 と3巡続けて「列挙の穴を1語ずつ」突かれた。危険を数え上げる方式
//   そのものが誤りだった。社内の恒久ルール「伏せ字は許可リスト方式 ―
//   危険を除くのではなく、安全なものだけで組み立てる」に合わせて向きを反転した。
// ⚠代償: 非PIIが誤って withheld になることが増える。だが withheld は画面に出て
//   人が備考へ移せる＝**過剰に伏せる誤りは回復可能、漏らす誤りは回復不能**。
// ===========================================================================

describe("安全と確定できないものは、値の形で伏せる", () => {
  it("★『お客様所在地: 東京都…』は withheld（列挙に無い人物語＋物件語の組み合わせ）", () => {
    // これが13巡目の指摘そのもの。旧実装は「所在地」で物件側に倒れて素通りしていた。
    const v = judgeOwnerPersonalInfo("お客様所在地", "東京都世田谷区池尻4丁目26-8");
    expect(v.isOwnerPersonalInfo).toBe(true);
  });

  it("★『依頼者住所』『売主様ご住所』も withheld", () => {
    for (const label of ["依頼者住所", "売主様ご住所", "買主様の連絡先", "相続人のお名前"]) {
      expect(judgeOwnerPersonalInfo(label, "東京都A区B1-2-3").isOwnerPersonalInfo, label).toBe(true);
    }
  });

  it("★列挙に無い見出しでも、値が住所らしければ withheld", () => {
    for (const label of ["ご連絡事項", "特記", "メモ", "第2連絡先"]) {
      const v = judgeOwnerPersonalInfo(label, "神奈川県横浜市西区1-2-3");
      expect(v.isOwnerPersonalInfo, label).toBe(true);
      expect(v.reason, label).toBe("value");
    }
  });

  it("★列挙に無い見出しでも、値が人名らしければ withheld", () => {
    for (const label of ["ご担当", "窓口", "先方"]) {
      const v = judgeOwnerPersonalInfo(label, "山田太郎");
      expect(v.isOwnerPersonalInfo, label).toBe(true);
      expect(v.reason, label).toBe("value");
    }
  });

  it("★『物件住所: 東京都…』は備考に入る（物件系と確定できる）", () => {
    expect(judgeOwnerPersonalInfo("物件住所", "東京都A区B1-2-3").isOwnerPersonalInfo).toBe(false);
    expect(judgeOwnerPersonalInfo("物件所在地", "東京都世田谷区池尻4丁目26-8").isOwnerPersonalInfo).toBe(false);
  });

  it("★『建物構造: 木造』は備考に入る（非PIIの値／物件系の見出し）", () => {
    expect(judgeOwnerPersonalInfo("建物構造", "木造").isOwnerPersonalInfo).toBe(false);
    expect(judgeOwnerPersonalInfo("希望する利活用方法", "売却").isOwnerPersonalInfo).toBe(false);
    expect(judgeOwnerPersonalInfo("空き家所有者との関係性", "本人").isOwnerPersonalInfo).toBe(false);
  });

  it("★数値だけの値・記号だけの値は備考に入る", () => {
    for (const v of ["70", "70.55", "1980", "-", "なし", "不明"]) {
      expect(judgeOwnerPersonalInfo("その他", v).isOwnerPersonalInfo, v).toBe(false);
    }
  });
});

describe("値の形の判定（粗くてよい／漏らすより過剰に引っかかる方を採る）", () => {
  it("★住所らしい値", () => {
    for (const v of ["東京都A区B1-2-3", "神奈川県横浜市西区1-2-3", "世田谷区池尻4丁目26-8", "A市1番地2"]) {
      expect(looksLikeAddress(v), v).toBe(true);
    }
  });

  it("★住所らしくない値", () => {
    for (const v of ["木造", "売却", "70.55", "2LDK", "", "本人"]) {
      expect(looksLikeAddress(v), v).toBe(false);
    }
  });

  it("★人名らしい値／らしくない値", () => {
    for (const v of ["山田太郎", "佐藤", "ヤマダタロウ"]) {
      expect(looksLikePersonName(v), v).toBe(true);
    }
    for (const v of ["木造スレート葺", "1年以内に売りたい", "70", "A", ""]) {
      expect(looksLikePersonName(v), v).toBe(false);
    }
  });

  it("★安全と確定できる値だけが素通りする（許可リスト方式）", () => {
    expect(isDefinitelyNonPersonalValue("なし")).toBe(true);
    expect(isDefinitelyNonPersonalValue("70.55")).toBe(true);
    // ⚠人名・住所は絶対に「安全」にならない。
    expect(isDefinitelyNonPersonalValue("山田太郎")).toBe(false);
    expect(isDefinitelyNonPersonalValue("東京都A区B1-2-3")).toBe(false);
    expect(isDefinitelyNonPersonalValue("090-1234-5678")).toBe(false);
  });
});

// ===========================================================================
// 14巡目: 前回の反転に残っていた2つの穴
//   ① 数字だけの電話番号が「安全な数値」として素通り（評価の順序）
//   ② `勤務先所在地` が「物件系」として素通り（「確定」が部分文字列のままだった）
// ⚠この関数はもう4巡直している。**総当たりの語彙に今回の2形を必ず含める**。
// ===========================================================================

describe("① 値の形は、値の許可リストより先に評価する", () => {
  it("★『緊急連絡先: 09012345678』は withheld（数字だけでも電話形状が勝つ）", () => {
    // 順序が逆だと「数値のみ＝安全」で確定し、電話形状の判定に到達しない。
    const v = judgeOwnerPersonalInfo("緊急連絡先", "09012345678");
    expect(v.isOwnerPersonalInfo).toBe(true);
    expect(v.reason).toBe("value");
  });

  it("★固定電話の形（0312345678）も withheld", () => {
    expect(judgeOwnerPersonalInfo("その他", "0312345678").isOwnerPersonalInfo).toBe(true);
    expect(judgeOwnerPersonalInfo("ご連絡先", "0312345678").isOwnerPersonalInfo).toBe(true);
  });

  it("★普通の数値は備考に入る（許可リストは効いている）", () => {
    for (const v of ["3", "70", "70.55", "1980", "12345"]) {
      expect(judgeOwnerPersonalInfo("部屋数", v).isOwnerPersonalInfo, v).toBe(false);
    }
  });

  it("★順序そのものを pin: 『数字だけ』かつ『電話形状』の値は必ず withheld", () => {
    // ⚠許可リスト(数値のみ)を先に評価する実装へ戻すと、ここは必ず落ちる。
    const digitsOnlyPhones = ["09012345678", "0312345678", "0120345678"];
    for (const v of digitsOnlyPhones) {
      // 前提: この値は「数字だけ」である＝許可リスト側の条件も満たす。
      expect(/^[0-9]+$/.test(v), v).toBe(true);
      expect(looksLikePhoneNumber(v), v).toBe(true);
      // それでも withheld になること＝形の判定が先に効いている証拠。
      expect(judgeOwnerPersonalInfo("メモ", v).isOwnerPersonalInfo, v).toBe(true);
    }
  });
});

describe("② 物件系の「確定」は完全一致だけ", () => {
  it("★『勤務先所在地: 東京都…』は withheld", () => {
    expect(
      judgeOwnerPersonalInfo("勤務先所在地", "東京都千代田区1-2-3").isOwnerPersonalInfo,
    ).toBe(true);
  });

  it("★『会社所在地』『実家所在地』『連絡先所在地』も withheld", () => {
    for (const label of ["会社所在地", "実家所在地", "連絡先所在地", "本店所在地"]) {
      expect(
        judgeOwnerPersonalInfo(label, "東京都千代田区1-2-3").isOwnerPersonalInfo,
        label,
      ).toBe(true);
    }
  });

  it("★『物件所在地』『所在地』は備考に入る（完全一致で確定）", () => {
    expect(judgeOwnerPersonalInfo("物件所在地", "東京都千代田区1-2-3").isOwnerPersonalInfo).toBe(false);
    expect(judgeOwnerPersonalInfo("所在地", "東京都千代田区1-2-3").isOwnerPersonalInfo).toBe(false);
  });

  it("★複合語 × 所在地/住所 の総当たり: 完全一致リストに無いものは全部 withheld", () => {
    // 次に同型が来ても、列挙の外で**形**で捕まることを確かめる。
    const prefixes = ["勤務先", "会社", "実家", "連絡先", "本店", "支店", "旧", "転居先"];
    const tails = ["所在地", "住所", "の所在地", "のご住所"];
    const offenders: string[] = [];
    for (const p of prefixes) {
      for (const t of tails) {
        const label = `${p}${t}`;
        if (!judgeOwnerPersonalInfo(label, "東京都千代田区1-2-3").isOwnerPersonalInfo) {
          offenders.push(label);
        }
      }
    }
    expect(offenders, `備考へ素通りする見出し: ${offenders.join(", ")}`).toEqual([]);
  });

  it("★裸の数字電話 × 見出しの総当たり: 見出しが何であっても withheld", () => {
    const labels = ["緊急連絡先", "ご連絡先", "メモ", "特記", "第2連絡先", "窓口", "その他"];
    const offenders: string[] = [];
    for (const label of labels) {
      if (!judgeOwnerPersonalInfo(label, "09012345678").isOwnerPersonalInfo) {
        offenders.push(label);
      }
    }
    expect(offenders, `電話番号が素通りする見出し: ${offenders.join(", ")}`).toEqual([]);
  });
});

// ===========================================================================
// 15巡目 ①: 最終フォールバックを withheld にした（反転の最終形）
//
// ⚠それまでは「危険な形に掛からなければ safe」＝**危険側の既定**が最後に残って
//   いた。形の判定の語彙（日本語の氏名・日本の住所・日本の電話）の外にある
//   個人情報は、すべてこの穴を通っていた。ラテン文字の氏名はその一例にすぎない。
// ⚠形の判定は**残す**が、役割が変わった: 危険を検出するのではなく、
//   **なぜ伏せたかを具体的に示す**分類（reason）。
// ===========================================================================

describe("最終フォールバックは withheld", () => {
  it("★『担当: Jonathan Smith』は withheld（reason=unclassified）", () => {
    const v = judgeOwnerPersonalInfo("担当", "Jonathan Smith");
    expect(v.isOwnerPersonalInfo).toBe(true);
    // 形の判定には掛かっていない＝最終フォールバックが受け止めた証拠。
    expect(v.reason).toBe("unclassified");
  });

  it("★『担当: 田中』は withheld（こちらは人名の形で分類できる）", () => {
    const v = judgeOwnerPersonalInfo("担当", "田中");
    expect(v.isOwnerPersonalInfo).toBe(true);
    expect(v.reason).toBe("value");
  });

  it("★語彙の外にある個人情報は、形に頼らず全部伏せる", () => {
    // 形の判定を足して追いかけない。既定が withheld なので自動的に守られる。
    const cases: [string, string][] = [
      ["担当", "Jonathan Smith"],
      ["Contact", "J. Smith"],
      ["連絡", "+44 20 7946 0958"],
      ["メモ", "Rua das Flores 123, Lisboa"],
      ["備考2", "何か分からない自由記述"],
    ];
    for (const [label, value] of cases) {
      expect(judgeOwnerPersonalInfo(label, value).isOwnerPersonalInfo, `${label}: ${value}`).toBe(
        true,
      );
    }
  });

  it("★安全と確定できるものだけが備考に入る（3つの経路）", () => {
    // (a) 物件見出しの完全一致
    expect(judgeOwnerPersonalInfo("物件所在地", "東京都A区B1-2-3").isOwnerPersonalInfo).toBe(false);
    // (b) 個人情報を持たないと分かっている見出しの完全一致
    expect(judgeOwnerPersonalInfo("建物構造", "木造スレート葺").isOwnerPersonalInfo).toBe(false);
    // (c) 値の許可リスト・電話形状でない純粋な数値
    expect(judgeOwnerPersonalInfo("何か", "なし").isOwnerPersonalInfo).toBe(false);
    expect(judgeOwnerPersonalInfo("何か", "70.55").isOwnerPersonalInfo).toBe(false);
  });

  it("★自由記述の見出しでも、値が危険な形なら形の判定が先に効く", () => {
    // コメント/備考は安全確定の見出しに入れているが、③が先に走るので
    // 住所・電話・メール・日本語の氏名は伏せられる。
    expect(judgeOwnerPersonalInfo("コメント", "東京都A区B1-2-3").isOwnerPersonalInfo).toBe(true);
    expect(judgeOwnerPersonalInfo("備考", "09012345678").isOwnerPersonalInfo).toBe(true);
    expect(judgeOwnerPersonalInfo("コメント", "山田太郎").isOwnerPersonalInfo).toBe(true);
  });
});

// ===========================================================================
// 19巡目 ②: 識別子（法人番号など）が「安全な数値」を通っていた
//
// ⚠`法人番号: 1234567890123` は電話形状(10〜11桁)から外れ、PII語にも当たらず、
//   「数字のみ＝安全」で備考へ入り、owner_corporate_number のマスクを迂回していた。
//   **二重の網**で塞ぐ: ①数値の桁数上限 ②識別子系のラベル語。
// ===========================================================================

describe("識別子は備考に入れない（二重の網）", () => {
  it("★法人番号(13桁)は withheld", () => {
    expect(judgeOwnerPersonalInfo("法人番号", "1234567890123").isOwnerPersonalInfo).toBe(true);
  });

  it("★見出しが分からなくても、7桁以上の数字列は withheld（桁数の網）", () => {
    for (const v of ["1234567", "12345678", "1234567890123", "99999999999999"]) {
      const verdict = judgeOwnerPersonalInfo("その他", v);
      expect(verdict.isOwnerPersonalInfo, v).toBe(true);
    }
  });

  it("★識別子らしいラベルは、値が短くても withheld（ラベルの網）", () => {
    for (const label of ["お客様番号", "会員ナンバー", "顧客ID", "管理コード", "受付No"]) {
      expect(judgeOwnerPersonalInfo(label, "123").isOwnerPersonalInfo, label).toBe(true);
    }
  });

  it("★お客様番号(8桁)は、ラベルでも桁でも withheld（網が二重であることの確認）", () => {
    // ラベルを外しても桁で、桁を外してもラベルで捕まる。
    expect(judgeOwnerPersonalInfo("お客様番号", "12345678").isOwnerPersonalInfo).toBe(true);
    expect(judgeOwnerPersonalInfo("その他", "12345678").isOwnerPersonalInfo).toBe(true);
    expect(judgeOwnerPersonalInfo("お客様番号", "12").isOwnerPersonalInfo).toBe(true);
  });

  it("★正当な数値は従来どおり備考に入る（過剰に落としていない）", () => {
    const cases: [string, string][] = [
      ["築年", "1996"],
      ["部屋数", "3"],
      ["専有面積", "70"],
      ["土地面積", "120.55"],
      ["総戸数", "48"],
      ["階数", "12"],
    ];
    for (const [label, value] of cases) {
      expect(judgeOwnerPersonalInfo(label, value).isOwnerPersonalInfo, `${label}: ${value}`).toBe(
        false,
      );
    }
  });

  it("★桁数の網が効くのは『見出しから安全と確定できない』ときだけ", () => {
    // 個人情報を持たないと分かっている見出し(NON_PERSONAL_LABELS_EXACT)は、
    // 桁数に関わらず備考へ通る。金額のような大きい数値を巻き添えにしない。
    expect(judgeOwnerPersonalInfo("希望価格", "35000000").isOwnerPersonalInfo).toBe(false);
    // 一方、見出しから何も分からなければ7桁以上は識別子とみなす。
    expect(judgeOwnerPersonalInfo("その他", "35000000").isOwnerPersonalInfo).toBe(true);
    // 識別子のラベルなら、安全確定の見出しではないので当然 withheld。
    expect(judgeOwnerPersonalInfo("法人番号", "1234567890123").isOwnerPersonalInfo).toBe(true);
  });

  it("★6桁ちょうどは安全・7桁は伏せる（境界の両側）", () => {
    expect(judgeOwnerPersonalInfo("その他", "999999").isOwnerPersonalInfo).toBe(false);
    expect(judgeOwnerPersonalInfo("その他", "1000000").isOwnerPersonalInfo).toBe(true);
    expect(MAX_SAFE_NUMERIC_DIGITS).toBe(6);
  });

  it("小数部は桁数の対象外（整数部で数える）", () => {
    expect(isDefinitelyNonPersonalValue("123456.789")).toBe(true);
    expect(isDefinitelyNonPersonalValue("1234567.8")).toBe(false);
  });
});
