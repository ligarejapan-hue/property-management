/**
 * 有料取得(候補からの謄本取得)の実況パネル配線(2026-08-15)。
 *
 * 背景: 実課金テストが2回連続で「#myPageTable 待ちの timeout」1行だけを残して失敗し
 * (課金ゼロ)、原因を特定できなかった。無料の所在検索には実況(段+スクショ)があるのに
 * 有料取得には無かったため。ここでは route→runRegistryAutoFetch→provider→adapter の
 * 受け渡しと、UI が liveRef を発行することをソース表明で固定する。
 *
 * ⚠**2026-08-23 方針変更(発注者指示)**:「確定ボタンを押すまでは中止ボタンを
 *   出してください。」従来は begin 直後に cancel 窓を閉じ、有料取得は一切中止
 *   できなかった。候補1件で自動的に取得へ進む今の流れでは、押せる時間が数秒しか
 *   無く実質止められなかった。
 *   ⇒ **窓は開けたまま渡し、adapter が課金の直前(endCancelable)で閉じる**。
 *   課金までの各段は全て無料で、途中で止めてもカートに未請求の行が残るだけ
 *   (コード上も無害として扱っている)。課金後は cancel-safety.ts が中止を無視する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const ROUTE = read("src/app/api/properties/[id]/registry/auto-fetch/route.ts");
const AUTO = read("src/lib/registry-fetch/auto-fetch.ts");
const PROVIDER = read("src/lib/registry-fetch/official-provider.ts");
const CLIENT = read("src/lib/api-client.ts");
const BUTTON = read(
  "src/components/properties/registry-location-search-button.tsx",
);

describe("route: liveRef の受け付けと橋渡し", () => {
  it("liveRef を isValidLiveRef で検証してから beginLiveView する(不正形式は黙って実況なし)", () => {
    expect(ROUTE).toMatch(/isValidLiveRef\(liveRefRaw\)/);
    expect(ROUTE).toMatch(/beginLiveView\(session\.id, id, liveRef\)/);
  });

  it("⚠begin 直後に cancel 窓を閉じない(課金の直前まで中止できる)", () => {
    const begin = ROUTE.indexOf("beginLiveView(session.id, id, liveRef)");
    expect(begin).toBeGreaterThan(-1);
    // begin の直後の数行に「閉じる」が現れないこと。
    expect(ROUTE.slice(begin, begin + 200)).not.toContain(
      "closeLiveViewCancelWindow",
    );
  });

  it("reporter に中止の確認と受付終了を配線する", () => {
    // ⚠この2つが無いと、画面が中止を送っても**見る場所が無い**。
    expect(ROUTE).toMatch(/isCancelRequested\(\): boolean \{/);
    expect(ROUTE).toMatch(/isLiveViewCancelRequested\(session\.id, id, liveRef\)/);
    expect(ROUTE).toMatch(/endCancelable\(\): void \{/);
    expect(ROUTE).toMatch(
      /closeLiveViewCancelWindow\(session\.id, id, liveRef\)/,
    );
  });

  it("受け付けの文言が実態と合っている(中止できないと嘘を書かない)", () => {
    expect(ROUTE).not.toContain("自動取得を受け付けました(この処理は中止できません)");
    expect(ROUTE).toContain("請求(課金)の直前まで中止できます");
  });

  it("成否によらず finally で completeLiveView する(失敗時こそ見返しが要る)", () => {
    expect(ROUTE).toMatch(/finally\s*\{\s*[^}]*completeLiveView\(session\.id, id, liveRef\)/);
  });

  it("runRegistryAutoFetch へ live を渡す", () => {
    // ⚠間に mode(回収)の受け渡しが入っても、live は同じ引数で渡る。
    expect(ROUTE).toMatch(/expectedFingerprint: fingerprint,[\s\S]*?\n\s*live,/);
  });
});

describe("orchestration→provider→adapter の受け渡し", () => {
  it("runRegistryAutoFetch は provider.fetchRegistryPdf に live を渡す", () => {
    expect(AUTO).toMatch(/live: args\.live,/);
  });

  it("official-provider は request.live を fetchByLocation 経由で adapter へ渡す", () => {
    expect(PROVIDER).toMatch(/this\.fetchByLocation\(location, request\.live\)/);
    expect(PROVIDER).toMatch(/chargeState,\s*\n\s*live,/);
  });

  it("adapter の有料フローは課金境界の前後で固定文言を刻む(文言に所在・地番を入れない)", () => {
    // 課金境界の直前・直後の文言(実況の主目的=お金の不安の解消)。
    expect(AUTO).toContain("⚠ここから請求(課金)を実行します");
    // ⚠押した直後は「課金済み」と**断定しない**(@codex #380 R5 P2)。domClick は
    //   ボタン不在/無効で黙って no-op になるため、断定は「請求済」を実測してから。
    expect(AUTO).toContain("請求を実行しました。サイト側の反映を確認しています");
    expect(AUTO).toContain(
      "請求済みを確認しました(課金済み)。書類(PDF)を保存しています",
    );
    expect(AUTO).not.toContain("請求しました(課金済み)");
    // 選択検証(発注者指示)の文言。
    expect(AUTO).toContain("対象の地番を選択しました。確定します(まだ課金されていません)");
  });

  // ⚠**このテストの旧版は誤りだった**(@codex #401 R1 P1 で指摘)。
  //   「実況文言より前で閉じる」を正しいと固定していたが、その文言から実際の
  //   課金(確認ダイアログのＯＫ)までは**約130行あり全部無料**。正しい基準は
  //   「charged=true の直前で閉じる」。下の describe に置き換えた。

  it("⚠adapter は課金前の節目ごとに中止を見る(押しても進み続ける、を作らない)", () => {
    // 節目が1か所しか無いと「押したのに最後まで走る」時間帯が生まれる。
    const checks = AUTO.match(/abortIfCancelledPaid\(\)/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(3);
  });

  it("⚠中止で止めたことが実況に残る(黙って終わらない)", () => {
    expect(AUTO).toContain("CANCEL_ACCEPTED_MESSAGE");
  });

  it("⚠順番待ち(購入ミューテックス)の間も心拍を刻む(@codex #380 R2 P2)", () => {
    // 一括取得と同じ直列化を共有するため、先客で3分を超えると初手1行のまま
    // 実況が消える。60秒ごとの keepalive + 取得開始と finally の両方で clear。
    expect(PROVIDER).toMatch(
      /queueHeartbeat = live[\s\S]{0,400}?他の取得の完了を待っています\(まだ課金されていません\)/,
    );
    const clears =
      PROVIDER.match(/clearInterval\(queueHeartbeat\)/g) ?? [];
    // 順番待ちを持つ経路(有料取得 / 回収)ごとに、取得開始時 + finally
    // (待ちのまま満了した経路の漏れ防止)の**2箇所**で clear する。
    const heartbeats =
      PROVIDER.match(/const queueHeartbeat = live/g) ?? [];
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(clears.length).toBe(heartbeats.length * 2);
  });

  it("⚠順番待ちそのものに寿命がある(@codex #380 R4/R6 P2)", () => {
    // 心拍だけ止めると(R4初版)、上限後も待つ取得の実況が期限切れで消え、開始後の
    // 全 step が no-op になる(R6)。待ちに寿命を与え、満了は rate_limited で即失敗。
    expect(PROVIDER).toMatch(/const QUEUE_WAIT_TIMEOUT_MS = 30 \* 60 \* 1000;/);
    // ⚠満了後に順番が回ってきたコールバックは、**page 生成もログインもする前に**
    //   何もせず抜ける(外部無接触=記録なき課金の入口を作らない)。
    expect(PROVIDER).toMatch(
      /runExclusivePurchase\(async \(\) => \{\s*\n\s*if \(gaveUp\) \{[\s\S]{0,300}?rate_limited/,
    );
    // gaveUp を立てるのは acquired が偽のときだけ(開始済みの取得を止めない)。
    expect(PROVIDER).toMatch(/if \(!acquired\) \{\s*\n\s*gaveUp = true;/);
  });

  it("⚠課金後の待ちループに心拍を刻む(実況の保管期限3分を無言で超えない)", () => {
    // ループは最悪3分を超えるが、ストアの期限は**最終書き込み**から数える。
    // 無言だと課金済みの待ち最中にパネルごと消える(steps/shotsも削除)。
    expect(AUTO).toMatch(
      /attempt % 5 === 0[\s\S]{0,160}?reportLive\("請求の反映を待っています…"\)/,
    );
  });
});

describe("client 側", () => {
  it("api-client は liveRef を任意引数で受け、body に同封する", () => {
    expect(CLIENT).toMatch(
      /obtainRegistryByCandidate\(\s*propertyId: string,\s*candidateRef: string,\s*certificateType: "owner" \| "all" = "owner",\s*liveRef\?: string,/,
    );
    expect(CLIENT).toMatch(/\.\.\.\(liveRef \? \{ liveRef \} : \{\}\)/);
  });

  it("取得ボタンは取得のたびに新しい liveRef を発行して渡す", () => {
    expect(BUTTON).toMatch(/const obtainLiveRef = safeRandomId\(\);/);
    expect(BUTTON).toMatch(/setLiveRef\(obtainLiveRef\);/);
    expect(BUTTON).toMatch(/certificateType,\s*\n\s*obtainLiveRef,/);
  });

  it("実況パネルは取得中(obtaining)と完了後(done)も表示され続ける", () => {
    // ⚠従来の条件(searching/results/cancelled/error)のままだと、取得を押した瞬間に
    //   state が obtaining になりパネルが**消える**=一番見たい場面で見えない。
    expect(BUTTON).toMatch(/state === "obtaining" \|\|/);
    expect(BUTTON).toMatch(/state === "done" \|\|/);
    // 回収(課金なし)も「まだ決着していない」側に含める(2026-08-19)。
    expect(BUTTON).toMatch(
      /searchSettled=\{[\s\S]*?state !== "searching" &&[\s\S]*?state !== "obtaining" &&[\s\S]*?state !== "recovering"[\s\S]*?\}/,
    );
  });
});

// ── @codex #401 R1 ────────────────────────────────────────────────────
describe("受付を閉じるのは『本当の課金の直前』(@codex #401 R1 P1)", () => {
  it("endCancelable は charged=true より前、かつ請求の実況文言より後", () => {
    // ⚠初版は「⚠ここから請求(課金)を実行します」の手前で閉じていた。
    //   そこから実際の課金(確認ダイアログのＯＫ)までは**約130行あり全部無料**。
    //   「課金の直前まで中止できる」と案内しながら早く締め切っていた。
    const chargeMsg = AUTO.indexOf("⚠ここから請求(課金)を実行します");
    const endCancelable = AUTO.indexOf("live?.endCancelable?.()");
    const chargedFlag = AUTO.indexOf("input.chargeState) input.chargeState.charged = true");
    expect(chargeMsg).toBeGreaterThan(-1);
    expect(endCancelable).toBeGreaterThan(-1);
    expect(chargedFlag).toBeGreaterThan(-1);
    expect(endCancelable).toBeGreaterThan(chargeMsg);
    expect(endCancelable).toBeLessThan(chargedFlag);
  });

  it("閉じる直前に中止を最終確認する(閉じてから押された中止を捨てない)", () => {
    const endCancelable = AUTO.indexOf("live?.endCancelable?.()");
    const before = AUTO.slice(Math.max(0, endCancelable - 400), endCancelable);
    expect(before).toContain("abortIfCancelledPaid();");
  });

  it("⚠確認〜課金の間に await を挟まない(同一同期区間)", () => {
    const endCancelable = AUTO.indexOf("live?.endCancelable?.()");
    const chargedFlag = AUTO.indexOf("input.chargeState) input.chargeState.charged = true");
    const between = AUTO.slice(endCancelable, chargedFlag);
    expect(between).not.toContain("await ");
  });
});

// ── @codex #401 R2 ────────────────────────────────────────────────────
describe("回収(課金なし)は中止を受け付けない(@codex #401 R2 P1)", () => {
  it("route は回収のときだけ受付を即閉じる", () => {
    // ⚠回収の経路には中止を見る場所が無い(実況を刻むだけ)。受け付けると
    //   「止めたつもりで最後まで走り、PDFが添付される」ことになる。
    expect(ROUTE).toMatch(
      /if \(isRecover\) \{\s*\n\s*closeLiveViewCancelWindow\(session\.id, id, liveRef\);/,
    );
  });

  it("画面も回収中は中止ボタンを出さない", () => {
    const at = BUTTON.indexOf("cancelable={");
    const block = BUTTON.slice(at, at + 200);
    expect(block).toContain('state === "searching"');
    expect(block).toContain('state === "obtaining"');
    expect(block).not.toContain('state === "recovering"');
  });
});

// ── @codex #401 R3 ────────────────────────────────────────────────────
describe("終わったら中止の印を必ず片付ける(@codex #401 R3 P2)", () => {
  it("実況を閉じる全ての出口で clearLiveViewCancel も呼ぶ", () => {
    // ⚠実況の TTL が消すのは store のエントリだけ。activeOps / cancelMarks は残る。
    //   消さないと鍵が溜まり続け、TTL 後に「もう存在しない実行」へ中止が
    //   accepted:true を返す。
    const completes = ROUTE.match(/completeLiveView\(session\.id, id, liveRef\)/g) ?? [];
    const clears = ROUTE.match(/clearLiveViewCancel\(session\.id, id, liveRef\)/g) ?? [];
    expect(completes.length).toBeGreaterThanOrEqual(3);
    expect(clears.length).toBe(completes.length);
  });
});
