import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// 撮影と現在地取得の並行化 (2026-07-28 ユーザー要望
// 「携帯から撮って登録の際現在地の取得も一緒にやってほしい」)。
//
// 従来は「撮影完了 → 現在地取得を開始」の直列で、GPS が確定するまで保存画面が
// 開かず「現在地を取得中…」で待たせていた。撮影ボタンを押した瞬間に取得を
// 開始してカメラ起動と並行させ、写真が返った時点で解決済みなら待ち時間ゼロで
// 保存画面へ進める。
//
// env=node のため behavioral test が書けない領域なので、構造を固定する。

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

const MAP_SRC = read("src/components/field-survey/field-survey-map.tsx");
const BUTTON_SRC = read("src/components/field-survey/camera-first-button.tsx");

describe("撮影ボタン: カメラ起動と同じ操作で現在地取得を開始する", () => {
  it("onCaptureStart prop を持つ (optional)", () => {
    expect(BUTTON_SRC).toMatch(/onCaptureStart\?:\s*\(\) => void;/);
  });

  it("click ハンドラで onCaptureStart → カメラ起動の順に呼ぶ", () => {
    // 同じ click の中で呼ぶこと (別 effect にすると権限プロンプトが
    // ユーザージェスチャ由来にならない)。順序も固定する。
    const onClick = MAP_SRC.length > 0 ? BUTTON_SRC.match(
      /onClick=\{\(\) => \{[\s\S]*?\}\}/,
    ) : null;
    expect(onClick).not.toBeNull();
    const m = onClick?.[0] ?? "";
    const startIdx = m.indexOf("onCaptureStart?.()");
    const clickIdx = m.indexOf("inputRef.current?.click()");
    expect(startIdx).toBeGreaterThan(-1);
    expect(clickIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeLessThan(clickIdx);
  });

  it("両方の描画箇所 (巡回中・巡回外) で配線する", () => {
    const wired = MAP_SRC.match(
      /onCaptureStart=\{startCameraLocationPrefetch\}/g,
    );
    expect(wired?.length).toBe(2);
  });
});

describe("先読み取得 (startCameraLocationPrefetch)", () => {
  it("geolocation 非対応なら prefetch を張らない (場所指定へ倒す)", () => {
    expect(MAP_SRC).toMatch(
      /if \(typeof navigator === "undefined" \|\| !navigator\.geolocation\) \{\s*\n?\s*cameraLocationPrefetchRef\.current = null;/,
    );
  });

  it("共有 token を bump して自分の requestId を記録する (他経路の取得を無効化)", () => {
    expect(MAP_SRC).toMatch(
      /currentLocationRequestIdRef\.current \+= 1;\s*\n?\s*const requestId = currentLocationRequestIdRef\.current;\s*\n?\s*cameraRequestIdRef\.current = requestId;/,
    );
  });

  it("結果は promise + settled で保持し、prefetch 自体は state を触らない", () => {
    // カメラを閉じただけ (写真なし) のとき何も起きないようにするため、
    // getCurrentPosition の callback では resolve するだけにする。
    const fn = MAP_SRC.match(
      /const startCameraLocationPrefetch = useCallback\([\s\S]*?\}, \[\]\);/,
    );
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/new Promise<CameraPrefetchResult>/);
    expect(m).toMatch(/resolve\(\{ ok: true, pos \}\)/);
    expect(m).toMatch(/resolve\(\{ ok: false, code:/);
    expect(m).toMatch(/entry\.settled = true;/);
    // prefetch 中に画面状態を書き換えない (locating にしない)
    expect(m).not.toMatch(/setCameraFirstPhase/);
    expect(m).not.toMatch(/setCreateCandidate/);
    // 座標を console に出さない (PII)
    expect(m).not.toMatch(/console\./);
  });

  it("リセットで先読み結果も捨てる (古い座標を次の撮影に使わない)", () => {
    const fn = MAP_SRC.match(
      /const resetCameraFirst = useCallback\([\s\S]*?\}, \[\]\);/,
    );
    expect(fn?.[0] ?? "").toMatch(/cameraLocationPrefetchRef\.current = null;/);
  });
});

describe("撮影後: 解決済みなら待たせない / 未解決なら従来どおり待つ", () => {
  const handler =
    MAP_SRC.match(
      /const handleCameraPhotoCaptured = useCallback\([\s\S]*?\n    \[resetCameraFirst\],\n  \);/,
    )?.[0] ?? "";

  it("ハンドラを取得できる", () => {
    expect(handler.length).toBeGreaterThan(200);
  });

  it("解決済みなら locating を出さずそのまま適用する", () => {
    expect(handler).toMatch(
      /if \(prefetch\.settled && prefetch\.result\) \{\s*\n?[\s\S]{0,160}?apply\(prefetch\.result\);\s*\n?\s*return;/,
    );
    // 待ちに入るのは未解決のときだけ (解決済み分岐より後)
    const settledIdx = handler.indexOf("prefetch.settled && prefetch.result");
    const locatingIdx = handler.indexOf('setCameraFirstPhase("locating")');
    expect(settledIdx).toBeGreaterThan(-1);
    expect(locatingIdx).toBeGreaterThan(settledIdx);
  });

  it("未解決なら locating 表示にして結果を待つ", () => {
    expect(handler).toMatch(
      /setCameraFirstPhase\("locating"\);[\s\S]{0,120}?void prefetch\.promise\.then\(apply\);/,
    );
  });

  it("撮影後に getCurrentPosition を呼び直さない (直列取得の撤去)", () => {
    expect(handler).not.toMatch(/geolocation\.getCurrentPosition/);
  });

  it("prefetch が無い場合は場所指定へフォールバックする (写真は保持)", () => {
    expect(handler).toMatch(
      /if \(!prefetch\) \{[\s\S]{0,220}?setCameraFirstPhase\("awaiting-map-tap"\)/,
    );
    // 写真は ref に入れてから分岐する = 撮り直しを要求しない
    const photoIdx = handler.indexOf("cameraPhotoFileRef.current = file;");
    const branchIdx = handler.indexOf("if (!prefetch)");
    expect(photoIdx).toBeGreaterThan(-1);
    expect(photoIdx).toBeLessThan(branchIdx);
  });

  it("既存のガード (mount / token / session / modal 競合) を維持する", () => {
    expect(handler).toMatch(/if \(!fsMapMountedRef\.current\) return;/);
    expect(handler).toMatch(
      /currentLocationRequestIdRef\.current !== requestId/,
    );
    // 巡回外で始めた撮影は巡回開始で破棄しない (@codex #326 R1)
    expect(handler).toMatch(
      /requestSessionId !== null &&\s*\n?\s*activeSessionIdRef\.current !== requestSessionId/,
    );
    expect(handler).toMatch(/if \(createCandidateOpenRef\.current\) \{/);
    // 取得失敗は理由つきで場所指定へ
    expect(handler).toMatch(
      /if \(!result\.ok\) \{[\s\S]{0,160}?cameraFirstFallbackMessage\(result\.code\)/,
    );
  });

  it("座標を console に出さない (PII)", () => {
    expect(handler).not.toMatch(/console\./);
  });
});
