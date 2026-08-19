/**
 * 請求リスト(fudosan-list)の行選択の挙動テスト。
 *
 * probe13(2026-08-17)実測: 確定(fuBtnForward)の着地はマイページでなく請求リスト。
 * check した行がそのまま請求対象になる=お金の一歩手前なので、
 * 「迷ったら選ばない」「同一内容の重複だけ先頭を選ぶ」を挙動で固定する。
 */
import { describe, expect, it } from "vitest";

import {
  collectBaselineReceiptNos,
  splitMyPageShozai,
  decodeSiteNumericEntities,
  FUDOSAN_LIST_CHECKBOX_NAME,
  FUDOSAN_LIST_HIDDEN_PREFIX,
  normalizeKuikiForCompare,
  pickChargedMyPageRow,
  mypageCertificateTypeOf,
  stripTrailingChibanFromKuiki,
  stripTrailingIdentifierFromKuiki,
  selectFudosanListRow,
  type FudosanListRow,
  type MyPageScanRow,
} from "@/lib/registry-fetch/fudosan-list-select";

const KUIKI = "神奈川県横浜市南区井土ケ谷中町";

function row(over: Partial<FudosanListRow> & { index: number }): FudosanListRow {
  return {
    chiban: "６９－２", // サイトは全角(probe13 実測)
    kuiki: KUIKI,
    seikyuType: "所有者事項",
    seikyuzumi: "false",
    checked: false,
    kind: "土地",
    ...over,
  };
}

const EXPECTED = {
  targetKey: "69-2", // normalizeChibanForDialog 済みの形
  kuiki: KUIKI,
  seikyuTypeLabel: "所有者事項",
  kindLabel: "土地",
};

describe("selectFudosanListRow", () => {
  it("全角地番・完全一致の1行を選ぶ(サイトの全角と targetKey の半角を突き合わせる)", () => {
    expect(selectFudosanListRow([row({ index: 1 })], EXPECTED)).toEqual({
      ok: true,
      index: 1,
      duplicateCount: 0,
    });
  });

  it("⚠同一内容の重複(過去テストの未請求の残り)は index 最小の1件を選び、残数を報告する", () => {
    const pick = selectFudosanListRow(
      [row({ index: 3 }), row({ index: 1 }), row({ index: 2 })],
      EXPECTED,
    );
    expect(pick).toEqual({ ok: true, index: 1, duplicateCount: 2 });
  });

  it("⚠地番が同じでも所在(kuiki)が違う行は選ばない(別の筆)", () => {
    const pick = selectFudosanListRow(
      [row({ index: 1, kuiki: "神奈川県横浜市南区別の町" })],
      EXPECTED,
    );
    expect(pick).toEqual({ ok: false, reason: "no-match" });
  });

  it("⚠請求済み(seikyuzumi!=false)の行は選ばない(二重課金の入口)", () => {
    const pick = selectFudosanListRow(
      [row({ index: 1, seikyuzumi: "true" })],
      EXPECTED,
    );
    expect(pick).toEqual({ ok: false, reason: "no-match" });
  });

  it("⚠不動産種別違い(同番号の建物の行)は選ばない(@codex #390 R5 P1)", () => {
    // 同じ区域に地番69-2の土地と家屋番号69-2の建物が両方未請求で並ぶと、
    // 種別を見ない照合は先頭(index最小)=別種の登記へ課金し得る。
    const pickKind = selectFudosanListRow(
      [row({ index: 1, kind: "建物" }), row({ index: 2, kind: "土地" })],
      EXPECTED,
    );
    expect(pickKind).toEqual({ ok: true, index: 2, duplicateCount: 0 });
    expect(
      selectFudosanListRow([row({ index: 1, kind: "建物" })], EXPECTED),
    ).toEqual({ ok: false, reason: "no-match" });
  });

  it("⚠種別違い(全部事項の行など)は選ばない", () => {
    const pick = selectFudosanListRow(
      [row({ index: 1, seikyuType: "全部事項" })],
      EXPECTED,
    );
    expect(pick).toEqual({ ok: false, reason: "no-match" });
  });

  it("⚠所在の隠しデータが数値文字参照でも一致する(2026-08-19 第6回テストの実測値)", () => {
    // サイトは #chibanKuiki_N だけ二重エスケープして持つ(実行時に読める値は
    // 「神奈川県横浜市南区井土ケ谷中町」ではなく下の ASCII 文字列)。
    const ENTITY = "&#31070;&#22856;&#24029;&#30476;&#27178;&#27996;&#24066;&#21335;&#21306;&#20117;&#22303;&#12465;&#35895;&#20013;&#30010;";
    expect(decodeSiteNumericEntities(ENTITY)).toBe("神奈川県横浜市南区井土ケ谷中町");
    const pick = selectFudosanListRow(
      [row({ index: 1, kuiki: ENTITY })],
      EXPECTED,
    );
    expect(pick).toEqual({ ok: true, index: 1, duplicateCount: 0 });
  });

  it("16進の文字参照(&#x…;)も解ける・実在住所の文字列は変えない", () => {
    expect(decodeSiteNumericEntities("&#x795E;&#x5948;")).toBe("神奈");
    // 大文字X形式も正しい書き方(@codex #391 R1)。混在も解ける。
    expect(decodeSiteNumericEntities("&#X795E;&#X5948;")).toBe("神奈");
    expect(decodeSiteNumericEntities("&#X795E;&#22856;&#x5DDD;")).toBe("神奈川");
    expect(decodeSiteNumericEntities("神奈川県横浜市南区")).toBe("神奈川県横浜市南区");
    // 参照の形をしていない & はそのまま(壊さない)。
    expect(decodeSiteNumericEntities("A&B&#;")).toBe("A&B&#;");
  });

  it("所在の全角/空白の揺れは吸収する(NFKC+空白除去)", () => {
    const pick = selectFudosanListRow(
      [row({ index: 1, kuiki: "神奈川県 横浜市南区　井土ケ谷中町" })],
      EXPECTED,
    );
    expect(pick).toEqual({ ok: true, index: 1, duplicateCount: 0 });
    expect(normalizeKuikiForCompare("Ａ Ｂ　Ｃ")).toBe("ABC");
  });

  it("⚠所在が取れていない(空)なら選ばない(kuiki-empty)", () => {
    expect(
      selectFudosanListRow([row({ index: 1 })], { ...EXPECTED, kuiki: "  " }),
    ).toEqual({ ok: false, reason: "kuiki-empty" });
  });

  it("行ゼロは no-rows(確定したのに行が無い=画面想定違い)", () => {
    expect(selectFudosanListRow([], EXPECTED)).toEqual({
      ok: false,
      reason: "no-rows",
    });
  });

  it("hidden 接頭辞と checkbox 名は probe13 の実測値", () => {
    expect(FUDOSAN_LIST_HIDDEN_PREFIX).toEqual({
      chiban: "chiban_",
      kuiki: "chibanKuiki_",
      seikyuType: "seikyuType_",
      seikyuzumi: "seikyuzumi_",
      ryokin: "ryokin_",
    });
    expect(FUDOSAN_LIST_CHECKBOX_NAME).toBe("sentaku");
  });
});

describe("pickChargedMyPageRow(課金直後の行同定・提出前レビュー confidence82 対応)", () => {
  const KU = "神奈川県横浜市南区井土ケ谷中町";
  function mrow(over: Partial<MyPageScanRow>): MyPageScanRow {
    return {
      receiptNo: "2026081900727233",
      shozai: `土地・${KU}６９－２`, // ⚠実サイト形(先頭に種別)
      seikyuType: "不動産登記 （所有者事項）", // ⚠実サイト形(probe16 実測)
      status: "請求済",
      when: "2026/08/18 12:00",
      expiry: "2026/09/18",
      ...over,
    };
  }
  const EXP = {
    targetKey: "69-2",
    kuiki: KU,
    kindLabel: "土地",
    certificateType: "owner" as const,
    baselineReceiptNos: new Set<string>(),
  };

  it("課金後の同定も文字参照を解いてから比べる(可視セルは素の日本語だが対で維持)", () => {
    const ENTITY_KU = "&#31070;&#22856;&#24029;&#30476;&#27178;&#27996;&#24066;&#21335;&#21306;&#20117;&#22303;&#12465;&#35895;&#20013;&#30010;";
    const picked = pickChargedMyPageRow(
      [mrow({ shozai: `土地・${ENTITY_KU}６９－２` })],
      EXP,
    );
    expect(picked?.receiptNo).toBe("2026081900727233");
  });

  it("⚠所在の先頭の種別が違う行は選ばない(土地の請求で建物の行を掴まない・probe16実測形)", () => {
    expect(
      pickChargedMyPageRow([mrow({ shozai: `建物・${KU}６９－２` })], EXP),
    ).toBeNull();
    // 建物を請求したときは建物の行を選ぶ。
    expect(
      pickChargedMyPageRow([mrow({ shozai: `建物・${KU}６９－２` })], {
        ...EXP,
        kindLabel: "建物",
      })?.receiptNo,
    ).toBe("2026081900727233");
  });

  it("⚠種別接頭辞を外さずに比べると常に不一致になる(第8回の次に待っていた穴)", () => {
    const { kindLabel, rest } = splitMyPageShozai(`土地・${KU}６９－２`);
    expect(kindLabel).toBe("土地");
    expect(rest).toBe(`${KU}６９－２`);
    expect(splitMyPageShozai(`${KU}６９－２`)).toEqual({
      kindLabel: "",
      rest: `${KU}６９－２`,
    });
  });

  it("⚠別の町の同一地番は選ばない(地番末尾一致だけでは他人の筆を掴む)", () => {
    expect(
      pickChargedMyPageRow(
        [mrow({ shozai: "土地・東京都別の市別の町６９－２", receiptNo: "2026081900000009" })],
        EXP,
      ),
    ).toBeNull();
  });

  it("⚠「69-2」は「169-2」の行に化けない(残り完全一致)", () => {
    expect(
      pickChargedMyPageRow([mrow({ shozai: `土地・${KU}１６９－２` })], EXP),
    ).toBeNull();
  });

  it("⚠町名が延長された別区域(中町→中町東)の行を選ばない(@codex #390 R1 P1)", () => {
    // startsWith だけだと「中町」は「中町東６９－２」も通す。残り「東６９－２」は
    // 地番として説明できない(isReadableChiban=false)ので弾く。
    expect(
      pickChargedMyPageRow(
        [mrow({ shozai: `土地・${KU}東６９－２`, when: "2026/08/18 23:59" })],
        EXP,
      ),
    ).toBeNull();
  });

  it("同じ筆の別表記(69番地2)は同定できる(残りが説明可能+正規化一致)", () => {
    expect(
      pickChargedMyPageRow([mrow({ shozai: `土地・${KU}６９番地２` })], EXP)?.receiptNo,
    ).toBe("2026081900727233");
  });

  it("所在だけで地番が無い行(残り空)は選ばない", () => {
    expect(pickChargedMyPageRow([mrow({ shozai: `土地・${KU}` })], EXP)).toBeNull();
  });

  it("同じ筆が複数(過去の購入履歴)なら**最新の行**=いま買った行を選ぶ", () => {
    const picked = pickChargedMyPageRow(
      [
        mrow({ receiptNo: "2026080100000001", when: "2026/08/01 09:00" }),
        mrow({ receiptNo: "2026081900727233", when: "2026/08/18 12:00" }),
      ],
      EXP,
    );
    expect(picked?.receiptNo).toBe("2026081900727233");
    expect(picked?.readyNow).toBe(true);
  });

  it("⚠最新行が準備前でも、古い ready 行へ乗り換えない(同一性が先・準備状態は後)", () => {
    const picked = pickChargedMyPageRow(
      [
        mrow({ receiptNo: "2026080100000001", when: "2026/08/01 09:00" }), // ready な古い購入
        mrow({ receiptNo: "2026081900727233", when: "2026/08/18 12:00", status: "請求中", expiry: "" }),
      ],
      EXP,
    );
    expect(picked?.receiptNo).toBe("2026081900727233");
    expect(picked?.readyNow).toBe(false); // 呼び出し側は待つ(乗り換えない)
  });

  it("期限切れ(期間超過)・期限空(準備前)は readyNow=false", () => {
    expect(
      pickChargedMyPageRow([mrow({ expiry: "期間超過" })], EXP)?.readyNow,
    ).toBe(false);
    expect(pickChargedMyPageRow([mrow({ expiry: "" })], EXP)?.readyNow).toBe(false);
  });

  it("⚠基準(課金前に控えた受付番号)に載っている行は選ばない(@codex #390 R2 P1)", () => {
    // 新行が非同期でまだ見えず、同じ筆の**古い**請求済行だけが見えている局面。
    // 基準が無いと「見えている最新」として古い行を掴み、古いPDFを添付する。
    const old_ = mrow({ receiptNo: "2026080100000001", when: "2026/08/01 09:00" });
    expect(
      pickChargedMyPageRow([old_], { ...EXP, baselineReceiptNos: new Set(["2026080100000001"]) }),
    ).toBeNull(); // 基準内しか見えない=まだ新行が出ていない→呼び出し側は待つ
    // 新行が現れたら、基準外のそれを選ぶ(古い方がreadyでも乗り換えない設計と両立)。
    const picked = pickChargedMyPageRow(
      [old_, mrow({ receiptNo: "2026081900727233", when: "2026/08/18 12:00" })],
      { ...EXP, baselineReceiptNos: new Set(["2026080100000001"]) },
    );
    expect(picked?.receiptNo).toBe("2026081900727233");
  });

  it("該当なし/受付番号なし/期待所在が空なら null(進めない=安全側)", () => {
    expect(pickChargedMyPageRow([], EXP)).toBeNull();
    expect(pickChargedMyPageRow([mrow({ receiptNo: " " })], EXP)).toBeNull();
    expect(pickChargedMyPageRow([mrow({})], { ...EXP, kuiki: " " })).toBeNull();
  });
});

describe("collectBaselineReceiptNos(課金前の基準・2026-08-19 第8回の実測反映)", () => {
  it("受付番号を持つ行だけを基準にする(未請求は持たないのが正常)", () => {
    const r = collectBaselineReceiptNos([
      { receiptNo: "2026080100000001", status: "請求済" },
      { receiptNo: "", status: "未請求" },
    ]);
    expect(r.ok).toBe(true);
    expect([...r.receiptNos]).toEqual(["2026080100000001"]);
  });

  it("⚠未請求だけの一覧でも基準は成立する(all-or-nothingの誤爆防止)", () => {
    const r = collectBaselineReceiptNos([
      { receiptNo: "", status: "未請求" },
      { receiptNo: "", status: "未請求" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.receiptNos.size).toBe(0);
  });

  it("⚠未請求でないのに受付番号が空なら基準を無効にする(読み取り途中/構造想定違い)", () => {
    expect(
      collectBaselineReceiptNos([{ receiptNo: "", status: "請求済" }]).ok,
    ).toBe(false);
    expect(
      collectBaselineReceiptNos([{ receiptNo: "", status: "取得中" }]).ok,
    ).toBe(false);
  });

  it("空の一覧は基準ゼロで成立(初回購入の口座)", () => {
    expect(collectBaselineReceiptNos([])).toEqual({
      ok: true,
      receiptNos: new Set<string>(),
    });
  });
});

describe("所在の末尾に入っている地番を外す(照合キーは区域だけ)", () => {
  // 本番データ実測(2026-08-19): properties.address は地番まで入っていることがある。
  // 「神奈川県横浜市南区井土ケ谷中町69-2」+ 地番 69-2 が実在の形。
  const AREA = "神奈川県横浜市南区井土ケ谷中町";

  it("末尾が対象の地番なら外して区域だけにする", () => {
    expect(stripTrailingChibanFromKuiki(`${AREA}69-2`, "69-2")).toBe(AREA);
  });

  it.each([
    ["全角", "６９－２"],
    ["登記の慣用表記(番)", "69番2"],
    ["空白入り", " 69 - 2 "],
  ])("%s で書かれていても外せる(表記ゆれで取りこぼさない)", (_label, tail) => {
    expect(stripTrailingChibanFromKuiki(`${AREA}${tail}`, "69-2")).toBe(AREA);
  });

  it("地番が入っていない所在は1文字も削らない", () => {
    expect(stripTrailingChibanFromKuiki(AREA, "69-2")).toBe(AREA);
  });

  it("⚠末尾が**別の**地番なら削らない(対象と違う筆の区域を作らない)", () => {
    expect(stripTrailingChibanFromKuiki(`${AREA}70-1`, "69-2")).toBe(`${AREA}70-1`);
  });

  it("⚠町名が延びた区域は延びたまま返す(中町東は中町にしない)", () => {
    // ここを縮めると、区域「中町」として中町の別の筆に当たり得る。
    expect(stripTrailingChibanFromKuiki(`${AREA}東69-2`, "69-2")).toBe(`${AREA}東`);
  });

  it("⚠数字の途中では切らない(169-2 の物件を 69-2 として扱わない)", () => {
    // 切ると区域が「…中町1」になり、マイページの「…中町１６９－２」の行が
    // 残り「69-2」で一致=**別の筆のPDFを貼る**。見つからない扱いの方が安全。
    expect(stripTrailingChibanFromKuiki(`${AREA}169-2`, "69-2")).toBe(
      `${AREA}169-2`,
    );
  });

  it("⚠ハイフンの途中でも切らない", () => {
    expect(stripTrailingChibanFromKuiki(`${AREA}5-69-2`, "69-2")).toBe(
      `${AREA}5-69-2`,
    );
  });

  it("対象地番が空なら何もしない(正規化だけ)", () => {
    expect(stripTrailingChibanFromKuiki(`${AREA}69-2`, "  ")).toBe(`${AREA}69-2`);
  });
});

describe("謄本の種類(所有者事項/全部事項)まで一致させる(@codex #394 P1)", () => {
  // 同じ筆で両方買っていると、種類を見ずに最新行を掴む=**別の商品のPDFを**
  // 別の商品として扱う(所有者事項を全部事項として添付/全部事項で所有者反映)。
  const KU2 = "神奈川県横浜市南区井土ケ谷中町";
  const row = (over: Partial<MyPageScanRow>): MyPageScanRow => ({
    receiptNo: "2026081900727233",
    shozai: `土地・${KU2}６９－２`,
    seikyuType: "不動産登記 （所有者事項）",
    status: "請求済",
    when: "2026/08/18 12:00",
    expiry: "2026/09/18",
    ...over,
  });
  const EXPECT = {
    targetKey: "69-2",
    kuiki: KU2,
    kindLabel: "土地",
    baselineReceiptNos: new Set<string>(),
  };

  it("表記から種類を読む(読めなければ null)", () => {
    expect(mypageCertificateTypeOf("不動産登記 （所有者事項）")).toBe("owner");
    expect(mypageCertificateTypeOf("不動産登記（全部事項）")).toBe("all");
    expect(mypageCertificateTypeOf("地図・図面")).toBeNull();
    expect(mypageCertificateTypeOf("")).toBeNull();
  });

  it("⚠同じ筆で両方買っていても、要求した種類の行を選ぶ(所有者事項)", () => {
    const picked = pickChargedMyPageRow(
      [
        row({
          receiptNo: "2026081900000ALL",
          seikyuType: "不動産登記 （全部事項）",
          when: "2026/08/19 15:30", // 全部事項の方が新しい
        }),
        row({ receiptNo: "2026081900000OWN", when: "2026/08/19 15:20" }),
      ],
      { ...EXPECT, certificateType: "owner" },
    );
    expect(picked?.receiptNo).toBe("2026081900000OWN");
  });

  it("⚠同じ筆で両方買っていても、要求した種類の行を選ぶ(全部事項)", () => {
    const picked = pickChargedMyPageRow(
      [
        row({ receiptNo: "2026081900000OWN", when: "2026/08/19 15:30" }),
        row({
          receiptNo: "2026081900000ALL",
          seikyuType: "不動産登記 （全部事項）",
          when: "2026/08/19 15:20",
        }),
      ],
      { ...EXPECT, certificateType: "all" },
    );
    expect(picked?.receiptNo).toBe("2026081900000ALL");
  });

  it("⚠読めた上での不一致しか無ければ選ばない", () => {
    expect(
      pickChargedMyPageRow(
        [row({ seikyuType: "不動産登記 （全部事項）" })],
        { ...EXPECT, certificateType: "owner" },
      ),
    ).toBeNull();
  });

  it("種類が読めない表記の行は落とさない(課金後に『払ったのに失う』を作らない)", () => {
    // 表記が想定と違うだけで課金済みのPDFを取り逃す方が損害が大きい。
    const picked = pickChargedMyPageRow(
      [row({ seikyuType: "不動産登記" })],
      { ...EXPECT, certificateType: "owner" },
    );
    expect(picked?.receiptNo).toBe("2026081900727233");
  });
});

describe("回収は『いま取り込める行』の中から最新を選ぶ(@codex #394 R9 P2)", () => {
  const KU3 = "神奈川県横浜市南区井土ケ谷中町";
  const row = (over: Partial<MyPageScanRow>): MyPageScanRow => ({
    receiptNo: "2026081900727233",
    shozai: `土地・${KU3}６９－２`,
    seikyuType: "不動産登記 （所有者事項）",
    status: "請求済",
    when: "2026/08/18 12:00",
    expiry: "2026/09/18",
    ...over,
  });
  const EXP3 = {
    targetKey: "69-2",
    kuiki: KU3,
    kindLabel: "土地",
    certificateType: "owner" as const,
    baselineReceiptNos: new Set<string>(),
  };

  it("⚠最新が期限切れでも、まだ生きている購入があればそれを取り込む", () => {
    const picked = pickChargedMyPageRow(
      [
        row({
          receiptNo: "2026081900000NEW",
          when: "2026/08/19 15:30",
          expiry: "期間超過",
        }),
        row({ receiptNo: "2026081900000OLD", when: "2026/08/10 09:00" }),
      ],
      { ...EXP3, requireReady: true },
    );
    expect(picked?.receiptNo).toBe("2026081900000OLD");
    expect(picked?.readyNow).toBe(true);
  });

  it("⚠有料取得(requireReady なし)は『いま買った行』を譲らない", () => {
    // 準備中(請求中)でもその行でなければならない。古い ready 行へ乗り換えると
    // 払った分と違うPDFを『今回の結果』として添付してしまう。
    const picked = pickChargedMyPageRow(
      [
        row({
          receiptNo: "2026081900000NEW",
          when: "2026/08/19 15:30",
          status: "請求中",
          expiry: "",
        }),
        row({ receiptNo: "2026081900000OLD", when: "2026/08/10 09:00" }),
      ],
      EXP3,
    );
    expect(picked?.receiptNo).toBe("2026081900000NEW");
    expect(picked?.readyNow).toBe(false);
  });
});

describe("所在の末尾は『対象でない方の識別子』でも外す(@codex #394 R9 P2)", () => {
  const AREA2 = "神奈川県横浜市南区井土ケ谷中町";

  it("建物で探すとき、所在の末尾に残った地番を外す", () => {
    // 対象キー(家屋番号5-2)だけ見ると外せず、区域が合わずに『無い』になる。
    expect(
      stripTrailingIdentifierFromKuiki(`${AREA2}69-2`, ["5-2", "69-2"]),
    ).toBe(AREA2);
  });

  it("対象キーで外せるならそれを優先する", () => {
    expect(
      stripTrailingIdentifierFromKuiki(`${AREA2}5-2`, ["5-2", "69-2"]),
    ).toBe(AREA2);
  });

  it("どちらでも外せなければ1文字も削らない", () => {
    expect(
      stripTrailingIdentifierFromKuiki(`${AREA2}70-1`, ["5-2", "69-2"]),
    ).toBe(`${AREA2}70-1`);
  });
});
