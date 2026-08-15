/**
 * 有料取得(候補からの謄本取得)の実況パネル配線(2026-08-15)。
 *
 * 背景: 実課金テストが2回連続で「#myPageTable 待ちの timeout」1行だけを残して失敗し
 * (課金ゼロ)、原因を特定できなかった。無料の所在検索には実況(段+スクショ)があるのに
 * 有料取得には無かったため。ここでは route→runRegistryAutoFetch→provider→adapter の
 * 受け渡しと、UI が liveRef を発行することをソース表明で固定する。
 *
 * ⚠有料取得は**中止を受け付けない**(課金だけ残る状態を作らない既存方針)。
 *   そのため cancel 窓は begin 直後に閉じ、reporter に isCancelRequested を配線しない。
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

  it("⚠begin 直後に cancel 窓を閉じる(有料取得は中止不可=効かない「中止」ボタンを出さない)", () => {
    const begin = ROUTE.indexOf("beginLiveView(session.id, id, liveRef)");
    const close = ROUTE.indexOf(
      "closeLiveViewCancelWindow(session.id, id, liveRef)",
    );
    expect(begin).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(begin);
    // reporter に中止確認を配線しない(見る場所が無い中止を受け付けない)。
    expect(ROUTE).not.toMatch(/isLiveViewCancelRequested/);
  });

  it("成否によらず finally で completeLiveView する(失敗時こそ見返しが要る)", () => {
    expect(ROUTE).toMatch(/finally\s*\{\s*[^}]*completeLiveView\(session\.id, id, liveRef\)/);
  });

  it("runRegistryAutoFetch へ live を渡す", () => {
    expect(ROUTE).toMatch(/expectedFingerprint: fingerprint,\s*\n\s*live,/);
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

  it("⚠順番待ち(購入ミューテックス)の間も心拍を刻む(@codex #380 R2 P2)", () => {
    // 一括取得と同じ直列化を共有するため、先客で3分を超えると初手1行のまま
    // 実況が消える。60秒ごとの keepalive + 取得開始と finally の両方で clear。
    expect(PROVIDER).toMatch(
      /queueHeartbeat = live[\s\S]{0,400}?他の取得の完了を待っています\(まだ課金されていません\)/,
    );
    const clears =
      PROVIDER.match(/clearInterval\(queueHeartbeat\)/g) ?? [];
    // 取得開始時 + finally(待ちのまま満了した経路の漏れ防止) の2箇所。
    expect(clears.length).toBe(2);
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
    expect(BUTTON).toMatch(
      /searchSettled=\{state !== "searching" && state !== "obtaining"\}/,
    );
  });
});
