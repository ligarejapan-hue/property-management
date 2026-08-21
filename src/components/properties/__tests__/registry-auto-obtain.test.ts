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
    // ⚠承認した警告の状態も一緒に渡すため、引数は2つになった(@codex #399 R5 P2)。
    expect(src).toContain("await runObtain(decision.candidate,");
    expect(src).toContain("const runObtain = async (");
  });

  it("複数件は取得せずエラーで止める", () => {
    expect(src).toContain('decision.action === "too_many"');
    expect(src).toContain("候補が複数");
  });
});

describe("中止は課金の前で必ず効く", () => {
  it("中止が押されたことを画面が覚える", () => {
    expect(src).toContain("searchCancelledRef");
    // ⚠実況パネルから**押下の時点**で受け取る(受付の応答を待たない。@codex #399 R1 P1)。
    expect(src).toContain("onCancelRequested");
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

describe("自動で課金する前に、止める手段と警告を確実に出す(@codex #399 R1 P1 ×2)", () => {
  it("⚠中止は**押した瞬間**に記録する(サーバー応答を待たない)", () => {
    // 押した直後に検索が終わると、応答待ちの間に自動購入が走ってしまう。
    // 課金は取り消せないので、**利用者が止める意思を示した時点**で止める。
    const panel = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "registry-live-panel.tsx"),
      "utf8",
    );
    // ⚠改行の正規化はしない(1行の部分一致と位置比較だけで確かめるため)。
    expect(panel).toContain("onCancelRequested");
    // 通信より前に呼ぶ(順序)。
    const at = panel.indexOf("const handleCancel = async ()");
    const body = panel.slice(at, panel.indexOf("  };", at));
    const iNotify = body.indexOf("onCancelRequested?.()");
    const iSend = body.indexOf("await cancelRegistryLiveView(");
    expect(iNotify).toBeGreaterThan(-1);
    expect(iSend).toBeGreaterThan(iNotify);
    // 画面側も押下時点で受け取る。
    expect(src).toContain("onCancelRequested={");
  });

  it("⚠取得の前に『既に取得済み』等の警告を出す(重複購入を防ぐ)", () => {
    // 自動で進む経路は確認画面を通らないため、警告が確認画面だけにあると
    // **重複して買ってしまう**。検索の確認にも出す。
    const at = src.indexOf('state === "confirmSearch" && target?.kind !== "none"');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('{state === "searching"', at));
    expect(block).toContain("RegistryPreflightWarningLines");
  });
});

describe("検索の間に状況が変わっていたら自動で買わない(@codex #399 R2 P1)", () => {
  it("課金の直前に警告を取り直し、増えていたら人に確認させる", () => {
    const at = src.indexOf('if (decision.action === "obtain")');
    expect(at).toBeGreaterThan(-1);
    // ⚠内側の閉じ括弧で切れないよう、分岐の**次の行**を終端にする。
    const block = src.slice(
      at,
      src.indexOf("setNotSearchableReason(res.candidates.length", at),
    );
    // 検索前の値と、取り直した今の値を比べる。
    expect(block).toContain("preflight.flagsById.get(propertyId)");
    expect(block).toContain("await fetchRegistryPreflight([propertyId])");
    expect(block).toContain("preflightWarningsIncreased(beforeFlags, afterFlags)");
    // 増えていたら取得へ進まず確認画面へ。
    const iGuard = block.indexOf("preflightWarningsIncreased(");
    const iObtain = block.indexOf("await runObtain(");
    expect(iGuard).toBeGreaterThan(-1);
    expect(iObtain).toBeGreaterThan(iGuard);
    expect(block).toContain('setState("confirmObtain")');
  });

  it("確認へ回すときは最新の警告を出し直す", () => {
    const at = src.indexOf('if (decision.action === "obtain")');
    // ⚠内側の閉じ括弧で切れないよう、分岐の**次の行**を終端にする。
    const block = src.slice(
      at,
      src.indexOf("setNotSearchableReason(res.candidates.length", at),
    );
    expect(block).toContain("setPreflightReload((n) => n + 1)");
  });
});

describe("課金の直前に、もう一度だけ中止を読み直す(@codex #399 R3 P1)", () => {
  // ⚠警告を取り直す待ち時間の間にも「中止」は押せる。判断はその待ちの**前**に
  //   済ませているので、読み直さないと**押したのに課金される**。
  //   ⚠一般則: **課金の前に await を足したら、その後で必ず中止を読み直す**。
  it("警告の取り直しのあと、取得を始める前に中止を確認する", () => {
    const at = src.indexOf('if (decision.action === "obtain")');
    const block = src.slice(
      at,
      src.indexOf("setNotSearchableReason(res.candidates.length", at),
    );
    const iAwaitPreflight = block.indexOf("await fetchRegistryPreflight(");
    const iRecheck = block.indexOf("if (searchCancelledRef.current)");
    const iWarnBranch = block.indexOf("preflightWarningsIncreased(");
    const iObtain = block.indexOf("await runObtain(");
    expect(iAwaitPreflight).toBeGreaterThan(-1);
    // 待ちの直後＝**どの分岐よりも先**に読み直す（@codex #399 R4 P2）。
    //   後ろに置くと、警告が増えた場合に中止が無視されて有料ボタンのある画面へ進む。
    expect(iRecheck).toBeGreaterThan(iAwaitPreflight);
    expect(iWarnBranch).toBeGreaterThan(iRecheck);
    expect(iObtain).toBeGreaterThan(iRecheck);
  });
});

describe("重複の検査は課金のロックと同じ一文で行う(@codex #399 R5 P2)", () => {
  const AUTO_FETCH = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "..", "..",
      "lib", "registry-fetch", "auto-fetch.ts",
    ),
    "utf8",
  );

  it("楽観ロックの where に承認内容の検査が入っている", () => {
    // 別の問い合わせで確かめると、相手の未確定な処理を読み落として重複購入し得る。
    const at = AUTO_FETCH.indexOf("const lock = await prisma.property.updateMany({");
    expect(at).toBeGreaterThan(-1);
    const block = AUTO_FETCH.slice(
      at,
      AUTO_FETCH.indexOf("if (lock.count === 0)", at),
    );
    expect(block).toContain("buildApprovedDuplicateGuard(args.approvedPreflight)");
    // ⚠課金する経路だけ。回収(課金なし)には掛けない。
    expect(block).toContain("willPurchaseByLocation");
  });

  it("重複で弾いたときは『実行中』ではなく専用の理由を返す", () => {
    // 「実行中です」と言われると待って押し直すが、実際はもう持っているので解決しない。
    expect(AUTO_FETCH).toContain("REGISTRY_PURCHASE_DUPLICATE_APPEARED");
    const at = AUTO_FETCH.indexOf("REGISTRY_PURCHASE_DUPLICATE_APPEARED");
    const before = AUTO_FETCH.slice(Math.max(0, at - 900), at);
    expect(before).toContain("課金していません");
  });

  it("画面は承認した警告の状態を一緒に送る", () => {
    expect(src).toContain("await runObtain(decision.candidate, {");
    expect(src).toContain("registryObtained: afterFlags?.registryObtained ?? false");
  });
});

describe("手動の取得ボタンも承認内容を送る(@codex #399 R6 P2)", () => {
  it("画面に出ている警告をそのまま渡す(最新を取り直さない)", () => {
    // ⚠承認したのは「画面に出ていた状態」。その後に増えた警告は弾く側に回す必要がある。
    expect(src).toContain("const approvedFromDisplay = ()");
    expect(src).toContain("preflight.flagsById.get(propertyId)");
    expect(src).toContain("runObtain(undefined, approvedFromDisplay())");
  });

  it("有料取得のボタンは、承認内容を渡さずには押せない形になっている", () => {
    // ボタン本体(onClick)を起点にする。文言は他の説明文にも出るため。
    const at = src.indexOf("runObtain(undefined, approvedFromDisplay())");
    expect(at).toBeGreaterThan(-1);
    const after = src.slice(at, at + 900);
    // 従来どおりスイッチと事前確認で塞ぐ。
    expect(after).toContain("!purchaseEnabled");
    expect(after).toContain("preflight.pending");
    expect(after).toContain("取得する（有料）");
  });
});
