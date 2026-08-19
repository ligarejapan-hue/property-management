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
  decodeSiteNumericEntities,
  FUDOSAN_LIST_CHECKBOX_NAME,
  FUDOSAN_LIST_HIDDEN_PREFIX,
  normalizeKuikiForCompare,
  pickChargedMyPageRow,
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
      shozai: `${KU}６９－２`,
      status: "請求済",
      when: "2026/08/18 12:00",
      expiry: "2026/09/18",
      ...over,
    };
  }
  const EXP = { targetKey: "69-2", kuiki: KU, baselineReceiptNos: new Set<string>() };

  it("課金後の同定も文字参照を解いてから比べる(可視セルは素の日本語だが対で維持)", () => {
    const ENTITY_KU = "&#31070;&#22856;&#24029;&#30476;&#27178;&#27996;&#24066;&#21335;&#21306;&#20117;&#22303;&#12465;&#35895;&#20013;&#30010;";
    const picked = pickChargedMyPageRow(
      [mrow({ shozai: `${ENTITY_KU}６９－２` })],
      EXP,
    );
    expect(picked?.receiptNo).toBe("2026081900727233");
  });

  it("⚠別の町の同一地番は選ばない(地番末尾一致だけでは他人の筆を掴む)", () => {
    expect(
      pickChargedMyPageRow(
        [mrow({ shozai: "東京都別の市別の町６９－２", receiptNo: "2026081900000009" })],
        EXP,
      ),
    ).toBeNull();
  });

  it("⚠「69-2」は「169-2」の行に化けない(残り完全一致)", () => {
    expect(
      pickChargedMyPageRow([mrow({ shozai: `${KU}１６９－２` })], EXP),
    ).toBeNull();
  });

  it("⚠町名が延長された別区域(中町→中町東)の行を選ばない(@codex #390 R1 P1)", () => {
    // startsWith だけだと「中町」は「中町東６９－２」も通す。残り「東６９－２」は
    // 地番として説明できない(isReadableChiban=false)ので弾く。
    expect(
      pickChargedMyPageRow(
        [mrow({ shozai: `${KU}東６９－２`, when: "2026/08/18 23:59" })],
        EXP,
      ),
    ).toBeNull();
  });

  it("同じ筆の別表記(69番地2)は同定できる(残りが説明可能+正規化一致)", () => {
    expect(
      pickChargedMyPageRow([mrow({ shozai: `${KU}６９番地２` })], EXP)?.receiptNo,
    ).toBe("2026081900727233");
  });

  it("所在だけで地番が無い行(残り空)は選ばない", () => {
    expect(pickChargedMyPageRow([mrow({ shozai: KU })], EXP)).toBeNull();
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
