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
    // 親は POST 決着 (state !== "searching") を伝える
    expect(BUTTON_SRC).toMatch(/searchSettled=\{state !== "searching"\}/);
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

  it("パネルは検索完了後 (results/error) も維持し、閉じるで消える (@codex P2)", () => {
    // searching 限定だと POST 完了と同時に unmount され「(完了)」表示も
    // 3 分の見返しもできない。reset (閉じる) が liveRef を null にして閉じる。
    expect(BUTTON_SRC).toMatch(
      /liveRef &&\s*\(state === "searching" \|\|\s*state === "results" \|\|\s*state === "error"\) && \(\s*<RegistryLivePanel/,
    );
    const resetBlock =
      BUTTON_SRC.match(/const reset = \(\) => \{[\s\S]*?\};/)?.[0] ?? "";
    expect(resetBlock).toMatch(/setLiveRef\(null\)/);
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
