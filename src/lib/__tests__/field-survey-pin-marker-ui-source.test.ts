/**
 * ピン配色 (種別/対応済み/自分・他人) の配線ソース静的検証 + 凡例 SSR 検証。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import * as fs from "fs";
import * as path from "path";
import PinMarkerLegend from "@/components/field-survey/pin-marker-legend";

/**
 * ⚠改行コードを LF に正規化してから照合する。
 *
 * Windows の checkout（git の autocrlf）ではソースが CRLF で落ちてくるため、
 * `/\bPin,\n/` や `/<MapDataLayer\n/` のように `\n` を直接含む表明が
 * **中身は正しいのに落ちる**（実際には `Pin,\r\n` が入っている）。
 * ここで正規化しておくと、Linux（本番・CI）の LF checkout と同じ文字列に
 * なるので、表明の意味を変えずに OS 差だけを消せる（LF 環境では恒等変換）。
 */
function readSrc(relPath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relPath), "utf8")
    .replace(/\r\n/g, "\n");
}

const MAP_SRC = readSrc("src/components/field-survey/field-survey-map.tsx");
const HISTORY_SRC = readSrc(
  "src/components/field-survey/field-survey-history-map.tsx",
);
const LEGEND_SRC = readSrc(
  "src/components/field-survey/pin-marker-legend.tsx",
);

describe("field-survey-map — ピン配色の配線", () => {
  it("ピン marker は Pin (色+グリフ) を子に持ち、スタイルは純関数経由", () => {
    expect(MAP_SRC).toMatch(/\bPin,\n/);
    // 第3弾: まとまっていない単独ピンの描画ブロックを掴む
    // (ControlPanel の {layers.pins && <PinMarkerLegend .../>} に誤マッチさせない)。
    // 「対応済みのピンを隠す」フィルタは pinClusters の材料側で効く。
    const pinBlock = MAP_SRC.match(
      /\{layers\.pins &&\s*pinClusters\.singles\.map\(\(sp\) => \{[\s\S]*?<\/AdvancedMarker>/,
    );
    expect(pinBlock).not.toBeNull();
    const m = pinBlock?.[0] ?? "";
    // フィルタは残っている(取得条件ではなく描画時のまま)。
    expect(MAP_SRC).toMatch(
      /hideClosedPins \? pins\.filter\(\(p\) => p\.status !== "closed"\) : pins/,
    );
    // <PinMarkerLegend 等への前方一致を防ぐため空白まで含めて照合
    expect(m).toMatch(/<Pin\s/);
    expect(m).toMatch(/pinMarkerStyle\(\{/);
    // 自分/他人は staffUserId と server 確定の currentUserId の一致で判定
    expect(m).toMatch(/isOwn:\s*pin\.staffUserId === currentUserId/);
    // title は生 enum でなく日本語ラベル (タッチ端末以外の hover 用)
    expect(m).toMatch(/title=\{formatPinType\(pin\.pinType\)\}/);
    expect(m).not.toMatch(/title=\{pin\.pinType\}/);
  });

  it("MapDataLayer は currentUserId を受け取る (タグ単位で照合)", () => {
    // TripControls 等の同名 prop への誤一致を防ぐためタグ単位で掴む
    const mdTag = MAP_SRC.match(/<MapDataLayer\n[\s\S]*?\/>/);
    expect(mdTag).not.toBeNull();
    expect(mdTag?.[0] ?? "").toMatch(/currentUserId=\{currentUserId\}/);
  });

  it("物件 marker は赤系のまま(第3弾で種別の文字を足したが、ピンとの区別は保つ)", () => {
    // ⚠旧: 物件は Google 既定の赤バルーンで「<Pin を持たない」ことを固定して
    //   いた。第3弾で種別を1文字で示すため <Pin を持つようになったが、守るべき
    //   不変条件は**物件とピンが一目で区別できること**であって、実装形ではない。
    //   → 見分けの根拠(色が被らないこと)は純関数のテストで固定する
    //     (field-survey-property-marker.test.ts)。ここでは配線だけを見る。
    expect(MAP_SRC).toMatch(/propertyMarkerStyle\(\{/);
    expect(MAP_SRC).toMatch(/propertyType: p\.propertyType/);
    expect(MAP_SRC).toMatch(/caseStatus: p\.caseStatus/);
  });

  it("凡例は出している層に合わせて表示される(第3弾で物件の行が加わった)", () => {
    // ⚠旧: ピンの層 ON のときだけ出していた。第3弾で物件マーカーの説明が
    //   凡例に入ったため、ピンを消して物件だけ出しているときにも必要になった
    //   (@codex #409 R2 P2)。中の行は showPins / showProperties で出し分ける。
    expect(MAP_SRC).toMatch(/\{\(layers\.pins \|\| layers\.properties\) && \(/);
    expect(MAP_SRC).toMatch(/<PinMarkerLegend/);
    expect(MAP_SRC).toMatch(/showOthersHint=\{showOthersLegendHint\}/);
    expect(MAP_SRC).toMatch(/showPins=\{layers\.pins\}/);
    expect(MAP_SRC).toMatch(/showProperties=\{layers\.properties\}/);
  });

  it("「他の担当者」ヒントは read_all/manage 保持者にのみ渡す", () => {
    // read_all/manage が無いスタッフには API が own のみを返し白縁ピンは
    // 出現しないため、存在しない見分け方を凡例に出さない
    expect(MAP_SRC).toMatch(/canSeeOtherPins/);
    expect(MAP_SRC).toMatch(
      /p\.action === "read_all" \|\| p\.action === "manage"/,
    );
    expect(MAP_SRC).toMatch(/showOthersLegendHint=\{canSeeOtherPins\}/);
  });
});

describe("field-survey-history-map — 同じ配色を適用", () => {
  it("履歴の pin marker も Pin + pinMarkerStyle (isOwn は閲覧者と巡回者の一致)", () => {
    expect(HISTORY_SRC).toMatch(/<Pin\s/);
    expect(HISTORY_SRC).toMatch(/pinMarkerStyle\(\{/);
    // read_all/manage で他人の巡回を閲覧した場合に縁色の意味が本編と
    // 反転しないよう、isOwn:true 固定にしない
    expect(HISTORY_SRC).toMatch(
      /isOwn:\s*meta\?\.staffUserId === currentUserId/,
    );
    expect(HISTORY_SRC).not.toMatch(/isOwn:\s*true,/);
    expect(HISTORY_SRC).toMatch(/title=\{formatPinType\(pin\.pinType\)\}/);
  });
});

describe("PinMarkerLegend — SSR", () => {
  const html = renderToStaticMarkup(createElement(PinMarkerLegend));
  const htmlWithOthers = renderToStaticMarkup(
    createElement(PinMarkerLegend, { showOthersHint: true }),
  );

  it("種別4種 + 対応済みの説明を含む", () => {
    for (const label of ["物件化候補", "要確認", "調査不可", "再確認"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("対応済み・物件化済み");
    expect(html).toContain("ピンの見かた");
  });

  it("「他の担当者」行は showOthersHint 時のみ (視覚サンプル付き)", () => {
    expect(html).not.toContain("他の担当者のピン");
    expect(htmlWithOthers).toContain("他の担当者のピン");
    expect(htmlWithOthers).toContain('data-testid="pin-legend-others-hint"');
  });

  it("グリフ (候/確/不/再/✓) がチップとして描画される", () => {
    for (const glyph of ["候", "確", "不", "再", "✓"]) {
      expect(html).toContain(glyph);
    }
  });

  it("ダークモード配色を持ち、座標や PII を含まない", () => {
    expect(LEGEND_SRC).toMatch(/dark:/);
    expect(LEGEND_SRC).not.toMatch(/lat|lng|memo|staffUserId/);
  });
});
