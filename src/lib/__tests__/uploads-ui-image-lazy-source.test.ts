/**
 * F11 uploads 配信負荷・C前段: 画像読み込み抑制の source-assertion ロック。
 *
 * /uploads 配信は 1 GET ごとに認可 DB 逆引き＋全量 Buffer のフルコストが掛かる
 * （docs/uploads-delivery-load-plan.md）。グリッド系サムネイルの `<img>` に
 * `loading="lazy"` を付け、画面外画像の先読みを抑止していることをロックする。
 *
 *  - field-survey pin サムネ: thumbnailUrl が null の場合は原本へ fallback する
 *    ため lazy の効果が特に大きい（本 PR で付与）。
 *  - property / building photo グリッド: 既存で lazy 済み（現状ロック）。
 *  - クリックで mount されるプレビュー/ライトボックスの `<img>` は表示意図が
 *    確定しているため lazy 対象外（assertion も課さない）。
 *  - buildings 詳細ページにはタブ構造が存在せず BuildingPhotoTab は常時 mount
 *    されるが、グリッド lazy により画面外の画像バイトは取得されない。
 *    タブ/遅延 mount の導入は UX 変更を伴うため本 PR の対象外（Plan 参照）。
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

/** marker を含む <img ... /> タグ全体を切り出す（marker は src 式などタグ内の一意文字列） */
function imgTagContaining(source: string, marker: string): string {
  const idx = source.indexOf(marker);
  expect(idx, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const start = source.lastIndexOf("<img", idx);
  const end = source.indexOf("/>", idx);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(idx);
  return source.slice(start, end);
}

describe("uploads UI 画像 lazy ロック（F11 C前段）", () => {
  it("field-survey pin サムネの <img> に loading=\"lazy\" が付いている", () => {
    const src = readSrc("src/components/field-survey/pin-detail-panel.tsx");
    const tag = imgTagContaining(src, "src={p.thumbnailUrl ?? p.fileUrl}");
    expect(tag).toContain('loading="lazy"');
  });

  it("building photo グリッドの <img> は loading=\"lazy\" を維持している（現状ロック）", () => {
    const src = readSrc("src/components/buildings/building-photo-tab.tsx");
    const tag = imgTagContaining(src, "src={normalizeFileUrl(photo.fileUrl)}");
    expect(tag).toContain('loading="lazy"');
  });

  it("property photo グリッドの <img> は loading=\"lazy\" を維持している（現状ロック）", () => {
    const src = readSrc("src/components/properties/photo-tab.tsx");
    // グリッドの <img src={url}> は loading="lazy" 付き（行 ~400）。同ファイルの
    // ライトボックス <img> は click 後 mount のため対象外。
    const idx = src.indexOf('loading="lazy"');
    expect(idx).toBeGreaterThan(-1);
    const tag = src.slice(src.lastIndexOf("<img", idx), src.indexOf("/>", idx));
    expect(tag).toContain("src={url}");
  });
});
