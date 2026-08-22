/**
 * 実況パネル UI の検証 (SSR + ソース静的検証)。
 * vitest は env=node のためポーリングの実挙動はソース検証 + レビューで担保。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import * as fs from "fs";
import * as path from "path";
import RegistryLivePanel from "@/components/properties/registry-live-panel";

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

const PANEL_SRC = readSrc(
  "src/components/properties/registry-live-panel.tsx",
);
const BUTTON_SRC = readSrc(
  "src/components/properties/registry-location-search-button.tsx",
);
const CLIENT_SRC = readSrc("src/lib/api-client.ts");

describe("RegistryLivePanel — SSR (初期状態)", () => {
  it("接続中表示から始まる (スクショ未着でも成立)", () => {
    const html = renderToStaticMarkup(
      createElement(RegistryLivePanel, {
        propertyId: "p1",
        liveRef: "ref-12345678",
        searchSettled: false,
      }),
    );
    expect(html).toContain('data-testid="registry-live-panel"');
    expect(html).toContain("自動操作の実況");
    expect(html).toContain("実況に接続しています…");
  });

  it("⚠cancelable=false の経路では「中止」を出さない", () => {
    // 呼び出し側が「この経路では中止の話をしない」と決めた場合は、
    // サーバーが何を答えても出さない(AND 条件)。
    const off = renderToStaticMarkup(
      createElement(RegistryLivePanel, {
        propertyId: "p1",
        liveRef: "ref-12345678",
        searchSettled: false,
        cancelable: false,
      }),
    );
    expect(off).not.toContain('data-testid="registry-live-cancel"');
  });

  it("⚠サーバーの答えが来るまでは「中止」を出さない(2026-08-23・安全側)", () => {
    // **方針変更**: 以前は client 状態だけで即座に出していた。今は可否を
    // **サーバーが持つ受付口の状態**で決める(有料取得でも課金の直前までは
    // 中止できるようになったため、文言や画面状態からの推測をやめた)。
    // ⚠初回描画は答えがまだ無い(null)。ここで出すと、効かない中止ボタンを
    //   見せることになる。**分からないなら出さない**(出し損ねは機会損失で済む)。
    //   最初のポーリングが返った時点で出る。
    const initial = renderToStaticMarkup(
      createElement(RegistryLivePanel, {
        propertyId: "p1",
        liveRef: "ref-12345678",
        searchSettled: false,
      }),
    );
    expect(initial).not.toContain('data-testid="registry-live-cancel"');
    // 受付口が閉じたという知らせも、まだ出さない(閉じたと決めつけない)。
    expect(initial).not.toContain("ここから先は中止できません");
  });

  it("親は検索中だけでなく取得中・回収中も cancelable を立てる(2026-08-23)", () => {
    // ⚠searching だけに戻ると、サーバーが受け付けていても画面に出ない。
    const at = BUTTON_SRC.indexOf("cancelable={");
    expect(at).toBeGreaterThan(-1);
    const block = BUTTON_SRC.slice(at, at + 220);
    expect(block).toContain('state === "searching"');
    expect(block).toContain('state === "obtaining"');
    expect(block).toContain('state === "recovering"');
  });

  it("⚠パネルは liveRef ごとに作り直す(@codex #380 P2)", () => {
    // 検索の3分の見返し期限が切れた後に「取得」を押すと、同じ部品が使い回されて
    // 内部状態(steps/done/expired/ポーリング停止)が残り、有料取得中なのに
    // 「表示期限が切れました」のまま固まる。key={liveRef} で remount する。
    expect(BUTTON_SRC).toMatch(/key=\{liveRef\}/);
  });
});

describe("RegistryLivePanel — ポーリング規約 (ソース静的検証)", () => {
  it("1 秒間隔で setInterval し、done/決着/失敗上限/unmount で必ず停止する", () => {
    expect(PANEL_SRC).toMatch(/POLL_INTERVAL_MS = 1000/);
    expect(PANEL_SRC).toMatch(/setInterval/);
    // 停止は stopPolling に集約 (clearInterval + null 化) し、done 到達・
    // POST 決着・連続失敗上限・cleanup の各所から呼ぶ (interval リーク防止)
    expect(PANEL_SRC).toMatch(
      /const stopPolling = \(\) => \{\s*if \(timerRef\.current !== null\) \{\s*clearInterval\(timerRef\.current\)/,
    );
    const stops = PANEL_SRC.match(/stopPolling\(\)/g) ?? [];
    expect(stops.length).toBeGreaterThanOrEqual(4);
    // 応答遅延時に重ね撃ちしない
    expect(PANEL_SRC).toMatch(/inFlightRef/);
  });

  it("失敗 (404/network) は静かに数える (エラーを console に出さない)", () => {
    expect(PANEL_SRC).not.toMatch(/console\./);
  });

  it("実況が存在しない場合の無限ポーリングを断つ (@codex P2)", () => {
    // ①POST 決着 (searchSettled) で最終 1 回取得 → 停止
    expect(PANEL_SRC).toMatch(/searchSettled: boolean/);
    expect(PANEL_SRC).toMatch(/if \(!searchSettled\) return/);
    // ②連続失敗の上限 (二重防御)
    expect(PANEL_SRC).toMatch(/MAX_CONSECUTIVE_POLL_FAILURES = 8/);
    expect(PANEL_SRC).toMatch(
      /failStreakRef\.current >= MAX_CONSECUTIVE_POLL_FAILURES/,
    );
    // 親は POST 決着を伝える。2026-08-15 から有料取得(obtaining)も実況するため、
    // 「決着」= searching でも obtaining でもない、に広がった。
    expect(BUTTON_SRC).toMatch(
      // ⚠回収(課金なし)も「まだ決着していない」側に入れる(2026-08-19)。
      // ここから漏れると、取り込み中なのに最終1回で止まり進行が見えなくなる。
      /searchSettled=\{[\s\S]*?state !== "searching" &&[\s\S]*?state !== "obtaining" &&[\s\S]*?state !== "recovering"[\s\S]*?\}/,
    );
  });

  it("決着時の最終取得は in-flight を待ってから必ず実取得する (@codex P1)", () => {
    // in-flight ガードで素通りすると done:false のまま固まる。決着 effect は
    // ①定期 tick 停止 → ②進行中取得の完了 await → ③実取得、の順。
    const settleEffect =
      PANEL_SRC.match(
        /if \(!searchSettled\) return;[\s\S]*?\}, \[searchSettled\]\)/,
      )?.[0] ?? "";
    expect(settleEffect).toMatch(/stopPolling\(\);/);
    expect(settleEffect).toMatch(/await inFlightPromiseRef\.current/);
    expect(settleEffect).toMatch(/await pollOnce\(/);
    // stopPolling が await より前 (新規 tick が挟まらない)
    expect(settleEffect.indexOf("stopPolling()")).toBeLessThan(
      settleEffect.indexOf("await inFlightPromiseRef.current"),
    );
    // pollOnce は in-flight 中なら同じ Promise を返す (重ね撃ちせず待てる)
    expect(PANEL_SRC).toMatch(
      /return inFlightPromiseRef\.current \?\? Promise\.resolve\(\)/,
    );
    // 遅着スクショの猶予: done 後も有界回数だけ拾ってから停止 (@codex P2)
    expect(PANEL_SRC).toMatch(/GRACE_POLLS_AFTER_DONE = 3/);
    expect(PANEL_SRC).toMatch(/graceRemainingRef/);
    expect(settleEffect).toMatch(
      /for \(let i = 0; i < GRACE_POLLS_AFTER_DONE && !cancelled; i\+\+\)/,
    );
    // 表示も決着を反映: 最終取得が失敗しても「実行中」パルスを出し続けない
    expect(PANEL_SRC).toMatch(/!done && !searchSettled/);
    expect(PANEL_SRC).toMatch(/\(done \|\| searchSettled\)/);
  });

  it("拡大表示 (クリックで画面全体を見る) がある", () => {
    expect(PANEL_SRC).toMatch(/registry-live-shot-enlarged/);
    expect(PANEL_SRC).toMatch(/cursor-zoom-in/);
  });

  it("done 観測から保持期間で表示を畳む (server 期限と同窓・@codex P2)", () => {
    // server の期限切れは描画済み <img> を消せないため、client 側でも同じ
    // 3 分窓で expired に倒し、スクショを描画しない終了表示へ切り替える。
    expect(PANEL_SRC).toMatch(/PANEL_RETENTION_MS = 3 \* 60 \* 1000/);
    expect(PANEL_SRC).toMatch(
      /setTimeout\(\(\) => setExpired\(true\), PANEL_RETENTION_MS\)/,
    );
    // 期限タイマーも cleanup で解除
    expect(PANEL_SRC).toMatch(/return \(\) => clearTimeout\(t\)/);
    // expired 分岐は img を含まない早期 return
    expect(PANEL_SRC).toMatch(/実況の表示期限が切れました/);
  });

  it("画像は認可付き URL (registryLiveShotUrl) のみで参照する", () => {
    expect(PANEL_SRC).toMatch(/registryLiveShotUrl\(propertyId, liveRef/);
    expect(PANEL_SRC).not.toMatch(/data:image/);
  });
});

describe("registry-location-search-button — 実況パネル統合 (ソース静的検証)", () => {
  it("検索開始時に safeRandomId で liveRef を発行し POST に同封する", () => {
    // HTTP 本番で crypto.randomUUID が使えないため safeRandomId 必須
    expect(BUTTON_SRC).toMatch(/safeRandomId\(\)/);
    // 実呼び出しの禁止 (コメントでの言及は許容)
    expect(BUTTON_SRC).not.toMatch(/crypto\.randomUUID\(\)/);
    expect(BUTTON_SRC).toMatch(/searchRegistryCandidates\(propertyId, ref\)/);
  });

  it("パネルは検索完了後 (results/cancelled/error) も維持し、閉じるで消える (@codex P2)", () => {
    // searching 限定だと POST 完了と同時に unmount され「(完了)」表示も
    // 3 分の見返しもできない。reset (閉じる) が liveRef を null にして閉じる。
    // ⚠中止 (cancelled) でも残す: どこまで進んで止まったかを本人が確かめ
    // られないと「本当に止まったのか」が分からない (@codex #357 P2)。
    expect(BUTTON_SRC).toMatch(
      /liveRef &&\s*\(state === "searching" \|\|\s*state === "results" \|\|[\s\S]*?state === "cancelled" \|\|\s*state === "error"\) && \(\s*<RegistryLivePanel/,
    );
    // ⚠2026-08-21: 「畳むだけ(clearFlow)」と「畳んで親も取り直す(reset)」に分けた
    //   (@codex #398 R3 P2)。閉じたときにパネルが消えることは変わらない=
    //   reset は clearFlow を通り、clearFlow が liveRef を落とす。
    const clearBlock =
      BUTTON_SRC.match(/const clearFlow = \(\) => \{[\s\S]*?\};/)?.[0] ?? "";
    expect(clearBlock).toMatch(/setLiveRef\(null\)/);
    const resetBlock =
      BUTTON_SRC.match(/const reset = \(\) => \{[\s\S]*?\};/)?.[0] ?? "";
    expect(resetBlock).toMatch(/clearFlow\(\)/);
  });
});

describe("api-client — 実況 API (ソース静的検証)", () => {
  it("liveRef は任意 (未指定なら従来 body のまま)", () => {
    expect(CLIENT_SRC).toMatch(/\.\.\.\(liveRef \? \{ liveRef \} : \{\}\)/);
  });

  it("shot URL は encodeURIComponent 済みの認可付きパス", () => {
    expect(CLIENT_SRC).toMatch(
      /registry\/search\/live\/\$\{encodeURIComponent\(liveRef\)\}\/shot\/\$\{seq\}/,
    );
  });
});
