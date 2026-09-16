/**
 * consumer-initial-arrange.test.ts — 作成直後の写真を「自動整列」と同じ並びにする
 * (発注者判断 2026-09-16)。
 *
 * 作成時(build-document)は写真の実寸比を知らないため packPhotoCells の均等グリッドで
 * 置く。これは枚数によっては縦積みになり、写真が細長い帯に letterbox される。
 * 実寸比はブラウザでしか測れないので、編集画面が最初に開いたときに一度だけ
 * autoArrangePhotos(=「自動整列」ボタンと同じ)へ寄せる。
 *
 * isInitialPhotoGrid は「作成直後のまま=人が触っていない」ことの判定(純関数)。
 * 触った後の紙面を勝手に組み替えないための門番。
 */
import { describe, it, expect } from "vitest";
import { type EditorState, autoArrangePhotos, isInitialPhotoGrid } from "../editor-document";
import {
  parseSalesSheetDocument,
  A4_LANDSCAPE,
  A4_PORTRAIT,
  type SalesSheetPage,
} from "../document-schema";
import { CONSUMER_PHOTO_ZONE, CONSUMER_PHOTO_RADIUS_MM, packPhotoCells } from "../layout-engine";

const SRC = "/uploads/properties/a/1.jpg";
const Z = CONSUMER_PHOTO_ZONE;

/** 作成直後(build-document)と同じ配置の image 要素を n 枚ぶん作る。 */
function gridImages(n: number): unknown[] {
  const cells = packPhotoCells(n, Z.w, Z.h);
  return cells.map((c, i) => ({
    id: `photo-${i + 1}`,
    type: "image",
    x: Z.x + c.x,
    y: Z.y + c.y,
    w: c.w,
    h: c.h,
    z: 1,
    src: SRC,
    fit: "contain",
  }));
}

function makeState(
  elements: unknown[],
  page: SalesSheetPage = A4_LANDSCAPE,
  template: string | null = "consumer-2026-09",
): EditorState {
  return {
    document: parseSalesSheetDocument({
      page,
      theme: { fontFamily: "sans-serif", accentColor: "#1f4e79", ...(template ? { template } : {}) },
      elements,
    }),
    selectedId: null,
    dirty: false,
  };
}

const textEl = () => ({
  id: "heading", type: "text", x: 136, y: 19.5, w: 154, h: 8, z: 2, content: "売戸建", style: {},
});

describe("isInitialPhotoGrid — 作成直後のままか", () => {
  it("作成直後の並び(1〜6枚)は true", () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(isInitialPhotoGrid(makeState([textEl(), ...gridImages(n)]).document)).toBe(true);
    }
  });

  it("1枚でも動かされていれば false", () => {
    const els = gridImages(3) as Record<string, unknown>[];
    els[1] = { ...els[1], x: (els[1].x as number) + 5 };
    expect(isInitialPhotoGrid(makeState([textEl(), ...els]).document)).toBe(false);
  });

  it("大きさが変えられていれば false", () => {
    const els = gridImages(3) as Record<string, unknown>[];
    els[2] = { ...els[2], h: (els[2].h as number) - 3 };
    expect(isInitialPhotoGrid(makeState([textEl(), ...els]).document)).toBe(false);
  });

  it("自動整列を通した後は false(=二度と組み替えない)", () => {
    const state = makeState([textEl(), ...gridImages(3)]);
    const aspects = { "photo-1": 1.5, "photo-2": 0.75, "photo-3": 1.33 };
    const after = autoArrangePhotos(state, { aspects });
    expect(after.document).not.toBe(state.document);
    expect(isInitialPhotoGrid(after.document)).toBe(false);
  });

  it("写真が無ければ false", () => {
    expect(isInitialPhotoGrid(makeState([textEl()]).document)).toBe(false);
  });

  it("旧ひな型(template 指定なし)は false", () => {
    expect(isInitialPhotoGrid(makeState([textEl(), ...gridImages(3)], A4_LANDSCAPE, null).document)).toBe(false);
  });

  it("A4横でなければ false", () => {
    expect(isInitialPhotoGrid(makeState([textEl(), ...gridImages(3)], A4_PORTRAIT).document)).toBe(false);
  });

  it("1/1000mm 未満の誤差は同一とみなす(保存→読み直しの丸め)", () => {
    const els = gridImages(3) as Record<string, unknown>[];
    els[0] = { ...els[0], x: (els[0].x as number) + 0.0005 };
    expect(isInitialPhotoGrid(makeState([textEl(), ...els]).document)).toBe(true);
  });
});

// @codex #432 P2: 位置と大きさしか見ていなかったため、「枠はそのままで見せ方だけ
// 変えた」図面(contain→cover に切替、焦点位置を指定)を作成直後と誤判定し、開いた
// だけでその設定を消していた。見せ方も門番に含める。
describe("isInitialPhotoGrid — 見せ方の変更も『触った』とみなす", () => {
  it("1枚でも fit:cover にしていれば false", () => {
    const els = gridImages(3) as Record<string, unknown>[];
    els[0] = { ...els[0], fit: "cover" };
    expect(isInitialPhotoGrid(makeState([textEl(), ...els]).document)).toBe(false);
  });

  it("焦点位置(中心のずらし)が指定されていれば false", () => {
    const els = gridImages(3) as Record<string, unknown>[];
    els[1] = { ...els[1], focalX: 30 };
    expect(isInitialPhotoGrid(makeState([textEl(), ...els]).document)).toBe(false);

    const els2 = gridImages(3) as Record<string, unknown>[];
    els2[2] = { ...els2[2], focalY: 80 };
    expect(isInitialPhotoGrid(makeState([textEl(), ...els2]).document)).toBe(false);
  });

  it("作成直後(fit:contain・焦点位置なし)は true のまま", () => {
    expect(isInitialPhotoGrid(makeState([textEl(), ...gridImages(3)]).document)).toBe(true);
  });
});

// @codex #432 P2(2巡目): 角丸(radiusMm)も ElementPanel から変えられる見た目の設定。
// 作成時の既定(写真=2mm・間取り図=無し)から外れていれば「触った」とみなす。
describe("isInitialPhotoGrid — 角丸の変更も『触った』とみなす", () => {
  it("角丸を作成時の既定から変えていれば false", () => {
    const els = gridImages(3) as Record<string, unknown>[];
    els[0] = { ...els[0], radiusMm: 5 };
    expect(isInitialPhotoGrid(makeState([textEl(), ...els]).document)).toBe(false);
  });

  it("角丸を0(角のまま)にした場合も false", () => {
    const els = gridImages(3) as Record<string, unknown>[];
    els[1] = { ...els[1], radiusMm: 0 };
    expect(isInitialPhotoGrid(makeState([textEl(), ...els]).document)).toBe(false);
  });

  it("作成時の既定(写真=2mm)はそのまま true", () => {
    const els = (gridImages(3) as Record<string, unknown>[]).map((e) => ({ ...e, radiusMm: CONSUMER_PHOTO_RADIUS_MM }));
    expect(isInitialPhotoGrid(makeState([textEl(), ...els]).document)).toBe(true);
  });

  it("間取り図のように角丸が無い要素も true(作成時の既定)", () => {
    expect(isInitialPhotoGrid(makeState([textEl(), ...gridImages(3)]).document)).toBe(true);
  });
});
