/**
 * 「この場所を地図で見る」導線 (?focusPin=<uuid>) のソース静的検証。
 * - 完成待ち一覧 → /field-survey/map?focusPin=<id>
 * - map-client が focusPin を UUID 検証して FieldSurveyMap に渡す
 * - map が pin 詳細 API から座標を取り panTo + 詳細を開く
 *   (座標は URL に載せず id のみ・console/ログに出さない)
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

const CLIENT = readSrc(
  "src/components/field-survey/field-survey-map-client.tsx",
);
const MAP = readSrc("src/components/field-survey/field-survey-map.tsx");
const QUEUE = readSrc("src/components/field-survey/candidate-queue.tsx");

describe("field-survey: この場所を地図で見る (?focusPin)", () => {
  it("完成待ち一覧に地図リンク (focusPin=id) を出す", () => {
    expect(QUEUE).toMatch(/data-testid="candidate-map-link"/);
    expect(QUEUE).toMatch(
      /href=\{`\/field-survey\/map\?focusPin=\$\{r\.id\}`\}/,
    );
  });

  it("map-client は focusPin を UUID 検証して FieldSurveyMap に渡す", () => {
    expect(CLIENT).toMatch(/searchParams\?\.get\("focusPin"\)/);
    expect(CLIENT).toMatch(
      /const focusPinId = isValidUuid\(rawFocusPin\) \? rawFocusPin : null/,
    );
    expect(CLIENT).toMatch(/focusPinId=\{focusPinId\}/);
  });

  it("map は focusPinId を受け、map instance 後に一度だけ場所へ寄せる (詳細は自動で開かない)", () => {
    expect(MAP).toMatch(/focusPinId\?:\s*string \| null/);
    const eff = MAP.match(
      /const focusedPinRef = useRef[\s\S]*?\}, \[focusPinId, mapInstance\]\);/,
    );
    expect(eff).not.toBeNull();
    const m = eff?.[0] ?? "";
    // 一度だけ (once-guard) + map instance が揃うまで待つ
    expect(m).toMatch(/if \(!focusPinId \|\| !mapInstance\) return/);
    expect(m).toMatch(/focusedPinRef\.current === focusPinId/);
    // 座標は pin 詳細 API から取得 (URL には id のみ)
    expect(m).toMatch(
      /\/api\/field-survey\/pins\/\$\{encodeURIComponent\(focusPinId\)\}/,
    );
    // panTo で場所へ寄せ、強調マーカー用に座標を state 化する
    expect(m).toMatch(/panTo\(\{ lat, lng \}\)/);
    expect(m).toMatch(/setFocusPinPos\(\{ lat, lng \}\)/);
    // @codex: 詳細パネルは自動で開かない (開くと他人 pin で監査が二重計上)
    expect(m).not.toMatch(/setDetailPinId/);
    // 取得失敗は once-guard を解除して再訪で再試行できるようにする
    expect(m).toMatch(/focusedPinRef\.current = null/);
    // per-effect cancel flag は使わない
    expect(m).not.toMatch(/cancelled/);
    // 座標を console に出さない (継続ガード)
    expect(m).not.toMatch(/console\./);
  });

  it("@codex P2: 指定ピンを強調マーカーで必ず表示する (PIN_LIMIT で漏れる古い候補対策)", () => {
    // MapDataLayer は bbox を新しい順 PIN_LIMIT で取得するため古い候補は marker
    // 一覧から漏れ得る。panTo だけでなく取得座標で専用マーカーを立てる。
    const marker = MAP.match(
      /\{focusPinPos && focusPinId && \([\s\S]*?<\/AdvancedMarker>[\s\S]*?\)\}/,
    );
    expect(marker).not.toBeNull();
    const m = marker?.[0] ?? "";
    expect(m).toMatch(/position=\{focusPinPos\}/);
    // 通常ピンと区別できる強調 (グリフ ★ + 前面 zIndex)
    expect(m).toMatch(/glyph="★"/);
    expect(m).toMatch(/zIndex=\{1000\}/);
    // @codex P2: 前面マーカーが背後の通常マーカーのタップを奪うため、この
    // マーカー自身の onClick (ユーザー操作) で詳細を開く。自動オープンではない
    // ので監査は二重計上されない。
    expect(m).toMatch(/onClick=\{\(\) => setDetailPinId\(focusPinId\)\}/);
  });
});
