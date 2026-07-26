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
      }),
    );
    expect(html).toContain('data-testid="registry-live-panel"');
    expect(html).toContain("自動操作の実況");
    expect(html).toContain("実況に接続しています…");
  });
});

describe("RegistryLivePanel — ポーリング規約 (ソース静的検証)", () => {
  it("1 秒間隔で setInterval し、unmount と done で必ず clearInterval する", () => {
    expect(PANEL_SRC).toMatch(/POLL_INTERVAL_MS = 1000/);
    expect(PANEL_SRC).toMatch(/setInterval/);
    // done 到達時と cleanup の両方で解除 (interval リーク防止)
    const clears = PANEL_SRC.match(/clearInterval\(timerRef\.current\)/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(2);
    // 応答遅延時に重ね撃ちしない
    expect(PANEL_SRC).toMatch(/inFlightRef/);
  });

  it("失敗 (404/network) は静かに次の tick を待つ (エラーを console に出さない)", () => {
    expect(PANEL_SRC).not.toMatch(/console\./);
  });

  it("拡大表示 (クリックで画面全体を見る) がある", () => {
    expect(PANEL_SRC).toMatch(/registry-live-shot-enlarged/);
    expect(PANEL_SRC).toMatch(/cursor-zoom-in/);
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
