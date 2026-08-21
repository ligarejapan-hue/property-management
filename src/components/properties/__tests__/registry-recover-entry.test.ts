import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 「取得済みの謄本を取り込む（課金なし）」の入口。
 *
 * 発注者指示(2026-08-21): **取り込みは「所在で謄本を検索」の流れに組み込む**。
 * 検索の流れの中には既に「候補を選ぶ → 取得する（有料）／取得済みを取り込む（課金なし）」の
 * 2択があるので、ボタンの下に独立して置いていたリンクは**出さない**。
 *
 * ⚠ただし**検索そのものが使えない設定のとき**は、リンクを消すと買った書類に手が届かなくなる
 *   （謄本には取得期限があるので実害になる）。その場合だけ入口を残す。
 * ⚠このリポは jsdom 未導入のため source-assertion で配線を固定する。改行は LF に正規化。
 */
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "registry-location-search-button.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("取り込みの入口は検索の流れに一本化する", () => {
  it("検索が使えるときは独立したリンクを出さない", () => {
    // 旧: {showButton && recoverConfigured && ( ... )} が常に出ていた。
    expect(src).not.toContain("{showButton && recoverConfigured && (");
  });

  it("検索が使えないときは、待たずに入口が出る(買った書類に手が届かなくならない)", () => {
    expect(src).toContain("{showButton && providerDisabled && recoverEntryLink}");
    // 入口そのものは「取り込みが使える設定」のときだけ存在する(定義側で担保)。
    expect(src).toContain("const recoverEntryLink = recoverConfigured ? (");
  });

  it("検索の流れの中の2択は残っている(ここが本来の導線)", () => {
    expect(src).toContain("取得する（有料）");
    expect(src).toContain("取得済みを取り込む（課金なし）");
  });
});

describe("土地/建物の選択は流れの中に残す(@codex #398 R1 P1)", () => {
  it("判断は純関数に渡す(画面に条件を書き写さない)", () => {
    expect(src).toContain("hasBothIdentifiers,");
    expect(src).toContain("resolveRecoverEntry({");
  });

  it("⚠『どちらを取り込みますか』は候補を選んだ後でも出る", () => {
    // 候補あり分岐(selected ? ( ... )) の中だけに置くと、検索から入った人は選べない。
    const start = src.indexOf("{selected ? (");
    const elseAt = src.indexOf(") : (", start);
    expect(start).toBeGreaterThan(-1);
    expect(elseAt).toBeGreaterThan(start);
    const candidateBranch = src.slice(start, elseAt);
    expect(candidateBranch).not.toContain("どちらを取り込みますか");
    // ⚠**三項(候補あり/なし)の外**にあること。片方の分岐に置くと、もう片方から
    //   入った人は選べない(=買った方の謄本に手が届かない)。
    // ⚠エスケープを使わずに改行を作る(この環境ではバックスラッシュが失われることがある)。
    const LF = String.fromCharCode(10);
    const ternaryEnd = src.indexOf("</>" + LF + "          )}", elseAt);
    const both = src.indexOf("{hasBothIdentifiers && (");
    const kindFieldset = src.indexOf("取得する種類");
    expect(ternaryEnd).toBeGreaterThan(elseAt);
    expect(both).toBeGreaterThan(ternaryEnd);
    expect(both).toBeLessThan(kindFieldset);
  });
});

describe("行き止まりでも買った書類に手が届く(@codex #398 R2 P1)", () => {
  // 入口を検索の流れへ一本化した結果、**流れが行き止まりになる場面**で回収へ進めなくなった。
  // 該当: 候補0件 / 検索エラー / 中止。いずれも「閉じる」しか無かった。
  // 謄本には取得期限があるので、行き止まり＝**払った代金が失われる**。
  it("回収の入口は1か所で定義する(場所ごとに書き写さない)", () => {
    const defs = src.split("取得済みの謄本を取り込む（課金なし）").length - 1;
    expect(defs).toBe(1);
    expect(src).toContain("recoverEntryLink");
  });

  it("候補0件・エラー・中止のどれからでも回収へ進める", () => {
    // それぞれの分岐に入口を差し込んでいること。
    expect(src).toContain("{candidates.length === 0 && recoverEntryLink}");
    const err = src.indexOf('{state === "error" && errorMsg && (');
    const cancelled = src.indexOf('{state === "cancelled" && (');
    expect(err).toBeGreaterThan(-1);
    expect(cancelled).toBeGreaterThan(-1);
    const errBlock = src.slice(err, src.indexOf("      )}", err));
    const cancelledBlock = src.slice(cancelled, src.indexOf("      )}", cancelled));
    expect(errBlock).toContain("recoverEntryLink");
    expect(cancelledBlock).toContain("recoverEntryLink");
  });
});

describe("入口を押した直後に画面が消えない(@codex #398 R3 P2)", () => {
  // ⚠回収に**失敗した直後**は親の取り直しが溜まっている(版番号が上がるため)。
  //   そこで reset() を呼ぶと onPropertyRefresh() が走り、詳細ページが読み込み中に
  //   差し替わって**この部品ごと消える**→直後の setState("confirmObtain") が捨てられ、
  //   入口を押しても確認画面が開かない(=期限のある書類に手が届かないまま)。
  it("入口は reset() ではなく、画面を作り直さない道を通る", () => {
    const at = src.indexOf("const recoverEntryLink = recoverConfigured ? (");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("  ) : null;", at));
    // 溜まった取り直しを流す reset() は使わない。
    expect(block).not.toContain("reset();");
    // 検索の途中状態だけ畳む。
    expect(block).toContain("clearFlow();");
    // ⚠版番号は新しくする(失敗後の再挑戦が409で弾かれないように)。
    //   使うのは**静かな取り直し**(画面を作り直さない)。
    expect(block).toContain("onRegistryResultApplied();");
    expect(block).toContain("setSavedVersion(null);");
  });

  it("画面を作り直す取り直しは今も『閉じる』のときだけ", () => {
    const calls = src.split("onPropertyRefresh()").length - 1;
    expect(calls).toBe(1);
  });
});

describe("取り直しの完了を待ってから確認画面を開く(@codex #398 R4 P2)", () => {
  // ⚠静かな取り直しは**非同期**。投げっぱなしのまま確認画面を開くと、利用者が先に
  //   ボタンを押せてしまい、**古い版番号のまま送って再び弾かれる**
  //   (REGISTRY_RECOVER_PROPERTY_CHANGED)。失敗直後の再挑戦で必ず1回無駄に失敗する。
  it("合図は待てる形(Promise)で受け取る", () => {
    expect(src).toContain("onRegistryResultApplied: () => void | Promise<void>;");
  });

  it("入口は取り直しを待ってから確認画面へ進む", () => {
    const at = src.indexOf("const recoverEntryLink = recoverConfigured ? (");
    const block = src.slice(at, src.indexOf("  ) : null;", at));
    expect(block).toContain("await onRegistryResultApplied();");
    // 待ってから開く(順序)。
    const iAwait = block.indexOf("await onRegistryResultApplied();");
    const iOpen = block.indexOf('setState("confirmObtain")');
    expect(iAwait).toBeGreaterThan(-1);
    expect(iOpen).toBeGreaterThan(iAwait);
    // 待っている間は押せない/押したことが分かる。
    expect(block).toContain("preparingRecover");
  });

  it("物件ページは取り直しの約束を返す(投げっぱなしにしない)", () => {
    const page = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..", "..", "..",
        "app", "(dashboard)", "properties", "[id]", "page.tsx",
      ),
      "utf8",
    );
    // ⚠改行の正規化は不要(1行の部分一致で確かめるため)。
    expect(page).toContain("return refreshPropertyQuietly();");
  });
});
