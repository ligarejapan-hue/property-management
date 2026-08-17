/**
 * 地図の長押し(携帯)/右クリック(PC)でピンを立てる導線のソース静的検証。
 * 発注者要望 2026-08-17「携帯からはマップ長押しでピン立てるようにしたい。
 * PCからは地図上で右クリックからピンを立てるようにしたい。」
 *
 * Google Maps の "contextmenu" は PC の右クリックとタッチ端末の長押しの
 * **両方で発火する統一イベント**なので、リスナー1本で両対応する。
 *
 * ⚠なぜ走査型か: vitest は node 環境(jsdom 無し)で Google Maps の
 * イベント発火は再現できない。配線の存在・ゲートの形・順序を固定する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const MAP_SRC = fs
  .readFileSync(
    path.resolve(
      process.cwd(),
      "src/components/field-survey/field-survey-map.tsx",
    ),
    "utf8",
  )
  .replace(/\r\n/g, "\n");

describe("contextmenu リスナー (MapDataLayer)", () => {
  it('map に "contextmenu" リスナーを張る(タップ待ちに関係なく常時)', () => {
    // addListener の引数としての "contextmenu",(コメント中の語と区別するため
    // カンマ付きで探す)。
    expect(MAP_SRC).toContain('"contextmenu",');
    // click リスナーの effect は captureMapClick でゲートされるが、
    // contextmenu の effect はゲートしない(いつでも立てられるのが価値)。
    const at = MAP_SRC.indexOf('"contextmenu",');
    const effectStart = MAP_SRC.lastIndexOf("useEffect", at);
    const effectBlock = MAP_SRC.slice(effectStart, at + 800);
    expect(effectBlock).not.toContain("if (!captureMapClick) return;");
    // ブラウザの右クリックメニューを出さない(PC)。
    expect(effectBlock).toContain("preventDefault");
  });

  it("座標の有限チェックをして共通の発火口 (fireMapContextMenu) へ渡す", () => {
    const at = MAP_SRC.indexOf('"contextmenu",');
    const effectBlock = MAP_SRC.slice(at, at + 800);
    expect(effectBlock).toContain("Number.isFinite(lat)");
    expect(effectBlock).toContain("fireMapContextMenu({ lat, lng })");
  });

  it("⚠発火口は重複抑止つきの1本(Android=ネイティブ+自前長押しの二重発火を捨てる)", () => {
    const fn =
      MAP_SRC.match(
        /const fireMapContextMenu = useCallback\([\s\S]*?\n  \);/,
      )?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).toContain("CONTEXT_FIRE_DEDUPE_MS");
    // 開いていた吹き出しは閉じる(作成モーダルの背後に残さない=click 側と同じ)。
    expect(fn).toContain("setSelected(null)");
    expect(fn).toContain("onMapContextMenu(latLng)");
  });
});

describe("iOS 向け自前長押し検知 (MapDataLayer)", () => {
  // ⚠iOS(全ブラウザ=WebKit)は長押しで DOM contextmenu を発火しない既知の制約
  // (iOS 13以降・提出前レビューで一次情報を確認)。Google 側の合成に頼れる確証も
  // 無いため、touch イベントで長押しを自前検知して同じ導線へ流す。
  const at = MAP_SRC.indexOf('"touchstart"');
  const block = at >= 0 ? MAP_SRC.slice(MAP_SRC.lastIndexOf("useEffect", at), at + 2600) : "";

  it("map div に touch リスナー4種を passive で張り、cleanup で全て外す", () => {
    expect(at).toBeGreaterThan(-1);
    for (const ev of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      expect(block).toContain(`addEventListener("${ev}"`);
      expect(block).toContain(`removeEventListener("${ev}"`);
    }
    expect(block).toContain("passive: true");
  });

  it("長押しの成立条件: 1本指・一定時間・一定距離未満(パン/ピンチは即キャンセル)", () => {
    expect(block).toContain("LONG_PRESS_MS");
    expect(block).toContain("LONG_PRESS_SLOP_PX");
    // 2本目の指(ピンチ)で諦める。
    expect(block).toContain("touches.length !== 1");
  });

  it("座標変換は OverlayView の投影(傾き/回転でも正確)+有限チェック+共通発火口", () => {
    expect(block).toContain("fromContainerPixelToLatLng");
    expect(block).toContain("google.maps.OverlayView");
    expect(block).toContain("Number.isFinite(lat)");
    expect(block).toContain("fireMapContextMenu({ lat, lng })");
    // 投影用 overlay は cleanup で外す(リーク防止)。
    expect(block).toContain("probe.setMap(null)");
  });
});

describe("handleMapContextCreate (FieldSurveyMap)", () => {
  const fn =
    MAP_SRC.match(
      /const handleMapContextCreate = useCallback\([\s\S]*?\n  \);/,
    )?.[0] ?? "";

  it("タップ待ち中は通常のタップと同じ扱い(写真つきでその位置へ)", () => {
    expect(fn).not.toBe("");
    // 先頭で awaiting-map-tap を判定して handleMapClick に委譲する。
    const delegateAt = fn.indexOf("handleMapClick(latLng)");
    expect(fn.indexOf('"awaiting-map-tap"')).toBeGreaterThan(-1);
    expect(delegateAt).toBeGreaterThan(-1);
    expect(fn.indexOf('"awaiting-map-tap"')).toBeLessThan(delegateAt);
  });

  it("⚠ゲートはボタン(cameraFirstButtonState)と同じ条件(巡回中 or 巡回なし登録権限true確定・書込権限なし確定は無反応)", () => {
    expect(fn).toContain("canQuickCapture !== true");
    expect(fn).toContain('canWritePin === false');
    // modal 表示中・詳細パネル作業中は無視(誤操作防止=click 側と同じ)。
    expect(fn).toContain("createCandidate");
    expect(fn).toContain("detailPanelBusyRef.current");
  });

  it("写真なしで作成候補を開く(ref を空に確定・保存後はトースト経路)", () => {
    // 写真 ref を空に(古い写真を拾わない)。
    expect(fn).toContain("cameraPhotoFileRef.current = null");
    // 保存後は詳細パネルでなくトースト(「写真を追加」「取り消す」付き)。
    expect(fn).toContain("createdFromCameraRef.current = true");
    // 写真なしで modal を開く=photoOptional(写真は任意・種類は候補既定)に合流。
    const candidateAt = fn.indexOf("setCreateCandidate({");
    expect(candidateAt).toBeGreaterThan(-1);
    const candidateBlock = fn.slice(candidateAt, candidateAt + 300);
    expect(candidateBlock).not.toContain("cameraPhoto:");
  });

  it("MapDataLayer へ onMapContextMenu として配線されている", () => {
    expect(MAP_SRC).toMatch(/onMapContextMenu=\{handleMapContextCreate\}/);
    // props の型にも宣言がある。
    expect(MAP_SRC).toMatch(
      /onMapContextMenu: \(latLng: \{ lat: number; lng: number \}\) => void;/,
    );
  });
});
