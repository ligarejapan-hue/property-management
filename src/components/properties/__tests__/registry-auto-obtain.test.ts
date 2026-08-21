import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 「候補が1件ならそのまま取得へ」の配線（発注者指示 2026-08-21）。
 *
 * ⚠判断そのものは純関数 `decideAfterSearch` で全条件を実測している
 *  （src/lib/registry-fetch/__tests__/after-search.test.ts）。
 *  ここで固定するのは「**画面がその判断に従っている**」ことだけ。
 * ⚠このリポは jsdom 未導入のため source-assertion。改行は LF に正規化。
 */
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "registry-location-search-button.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("検索のあとの分岐は純関数に委ねる", () => {
  it("画面は decideAfterSearch の判断に従う（条件を書き写さない）", () => {
    expect(src).toContain("decideAfterSearch({");
    expect(src).toContain("cancelRequested: searchCancelledRef.current");
    expect(src).toContain("purchaseEnabled,");
  });

  it("候補1件は、選ぶ・確認を挟まずそのまま取得へ渡す", () => {
    // ⚠state の反映を待たずに走らせるため、**候補を引数で直接渡す**。
    //   setSelected 後の state に頼ると、まだ空のまま取得が始まって何も起きない。
    expect(src).toContain('if (decision.action === "obtain")');
    expect(src).toContain("await runObtain(decision.candidate)");
    expect(src).toContain("const runObtain = async (");
  });

  it("複数件は取得せずエラーで止める", () => {
    expect(src).toContain('decision.action === "too_many"');
    expect(src).toContain("候補が複数");
  });
});

describe("中止は課金の前で必ず効く", () => {
  it("中止が受け付けられたことを画面が覚える", () => {
    expect(src).toContain("searchCancelledRef");
    // 実況パネルから中止の受付を受け取る。
    expect(src).toContain("onCancelAccepted");
  });

  it("検索を始めるたびに、前回の中止は持ち越さない", () => {
    const at = src.indexOf("const runSearch = async ()");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("  };", at));
    expect(body).toContain("searchCancelledRef.current = false;");
    // 初期化は検索の開始時（結果を受け取る前）。
    const iReset = body.indexOf("searchCancelledRef.current = false;");
    const iCall = body.indexOf("await searchRegistryCandidates(");
    expect(iReset).toBeGreaterThan(-1);
    expect(iCall).toBeGreaterThan(iReset);
  });
});
