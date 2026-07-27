import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  CAMERA_PREFETCH_MAX_AGE_MS,
  isCameraPrefetchFresh,
} from "@/lib/field-survey-camera-first";

// 撮影と現在地取得の並行化 (2026-07-28 ユーザー要望
// 「携帯から撮って登録の際現在地の取得も一緒にやってほしい」)。
//
// 従来は「撮影完了 → 現在地取得を開始」の直列で、GPS が確定するまで保存画面が
// 開かず「現在地を取得中…」で待たせていた。撮影ボタンを押した瞬間に取得を
// 開始してカメラ起動と並行させ、写真が返った時点で解決済みなら待ち時間ゼロで
// 保存画面へ進める。
//
// ⚠ただし解決済みでも「撮影時点で古い」座標は使わない (@codex #329 R1)。
// カメラを開けたまま移動すると、ボタンを押した地点でピンが立ってしまう。
//
// env=node のため behavioral test が書けない領域は構造を固定する。

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

const MAP_SRC = read("src/components/field-survey/field-survey-map.tsx");
const BUTTON_SRC = read("src/components/field-survey/camera-first-button.tsx");

/** 撮影ハンドラ本体 (依存配列までを 1 塊で取り出す)。 */
const HANDLER =
  MAP_SRC.match(
    /const handleCameraPhotoCaptured = useCallback\([\s\S]*?startCameraLocationPrefetch\],\s*\n\s*\);/,
  )?.[0] ?? "";

describe("撮影ボタン: カメラ起動と同じ操作で現在地取得を開始する", () => {
  it("onCaptureStart prop を持つ (optional)", () => {
    expect(BUTTON_SRC).toMatch(/onCaptureStart\?:\s*\(\) => void;/);
  });

  it("click ハンドラで onCaptureStart → カメラ起動の順に呼ぶ", () => {
    // 同じ click の中で呼ぶこと (別 effect にすると権限プロンプトが
    // ユーザージェスチャ由来にならない)。順序も固定する。
    const onClick = BUTTON_SRC.match(/onClick=\{\(\) => \{[\s\S]*?\}\}/);
    expect(onClick).not.toBeNull();
    const m = onClick?.[0] ?? "";
    const startIdx = m.indexOf("onCaptureStart?.()");
    const clickIdx = m.indexOf("inputRef.current?.click()");
    expect(startIdx).toBeGreaterThan(-1);
    expect(clickIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeLessThan(clickIdx);
  });

  it("両方の描画箇所 (巡回中・巡回外) で配線する", () => {
    const wired = MAP_SRC.match(/onCaptureStart=\{startCameraLocationPrefetch\}/g);
    expect(wired?.length).toBe(2);
  });
});

describe("先読み取得 (startCameraLocationPrefetch)", () => {
  const FN =
    MAP_SRC.match(
      /const startCameraLocationPrefetch = useCallback\([\s\S]*?\}, \[\]\);/,
    )?.[0] ?? "";

  it("関数を取得できる", () => {
    expect(FN.length).toBeGreaterThan(200);
  });

  it("geolocation 非対応なら prefetch を張らない (場所指定へ倒す)", () => {
    expect(FN).toMatch(/!navigator\.geolocation/);
    expect(FN).toMatch(/cameraLocationPrefetchRef\.current = null;/);
  });

  it("共有 token を bump して自分の requestId を記録する (他経路の取得を無効化)", () => {
    expect(FN).toMatch(/currentLocationRequestIdRef\.current \+= 1;/);
    expect(FN).toMatch(/cameraRequestIdRef\.current = requestId;/);
  });

  it("結果は promise + settled で保持し、prefetch 自体は state を触らない", () => {
    // カメラを閉じただけ (写真なし) のとき何も起きないようにするため、
    // getCurrentPosition の callback では resolve するだけにする。
    expect(FN).toMatch(/new Promise<CameraPrefetchResult>/);
    expect(FN).toMatch(/resolve\(\{ ok: true, pos \}\)/);
    expect(FN).toMatch(/resolve\(\{ ok: false, code:/);
    expect(FN).toMatch(/entry\.settled = true;/);
    expect(FN).not.toMatch(/setCameraFirstPhase/);
    expect(FN).not.toMatch(/setCreateCandidate/);
    // 座標を console に出さない (PII)
    expect(FN).not.toMatch(/console\./);
  });

  it("リセットで先読み結果も捨てる (古い座標を次の撮影に使わない)", () => {
    const reset =
      MAP_SRC.match(
        /const resetCameraFirst = useCallback\([\s\S]*?\}, \[\]\);/,
      )?.[0] ?? "";
    expect(reset).toMatch(/cameraLocationPrefetchRef\.current = null;/);
  });
});

describe("撮影後: 新しければ待たせない / 古ければ取り直す / 未解決なら待つ", () => {
  it("ハンドラを取得できる", () => {
    expect(HANDLER.length).toBeGreaterThan(200);
  });

  it("解決済み・未解決を同じ consume() で扱い、鮮度検証を共通化する", () => {
    // ⚠settled=false でも「カメラ起動前に取得済み」の場合がある
    // (ネイティブカメラがページを止めると .then が走らないまま change が届く)。
    // 待機側だけ検証を省くとその経路から古い座標が通る (@codex #329 R2)。
    expect(HANDLER).toMatch(/const consume = \(/);
    expect(HANDLER).toMatch(/if \(entry\.settled && entry\.result\) \{/);
    expect(HANDLER).toMatch(/void entry\.promise\.then\(finish\);/);
    expect(HANDLER).toMatch(/consume\(prefetch, 0\);/);
    // 鮮度判定は finish 内の 1 箇所だけ = 経路差が生まれない
    const freshChecks = HANDLER.match(/isCameraPrefetchFresh\(/g) ?? [];
    expect(freshChecks.length).toBe(1);
  });

  it("成功かつ古い場合だけ取り直す (失敗はそのまま反映)", () => {
    expect(HANDLER).toMatch(/if \(r\.ok && !isCameraPrefetchFresh\(r\.pos\)\) \{/);
    expect(HANDLER).toMatch(/startCameraLocationPrefetch\(\);/);
    expect(HANDLER).toMatch(/consume\(renewed, attempt \+ 1\);/);
  });

  it("取り直しは1回まで。2回目も古ければ手動指定へ倒す (無限ループ防止)", () => {
    expect(HANDLER).toMatch(/if \(attempt >= 1\) \{/);
    expect(HANDLER).toMatch(/撮った場所の現在地を取得できませんでした/);
    // 誤った座標でピンを立てない = apply へ進まない
    const limitIdx = HANDLER.indexOf("if (attempt >= 1) {");
    const renewIdx = HANDLER.indexOf("startCameraLocationPrefetch();");
    expect(limitIdx).toBeGreaterThan(-1);
    expect(limitIdx).toBeLessThan(renewIdx);
  });

  it("token が進んでいたら再取得を重ねず apply のガードに委ねる", () => {
    expect(HANDLER).toMatch(
      /if \(currentLocationRequestIdRef\.current !== entry\.requestId\) \{\s*\n?\s*apply\(entry\.requestId, r\);\s*\n?\s*return;/,
    );
  });

  it("未解決なら locating 表示にして結果を待つ", () => {
    expect(HANDLER).toMatch(/setCameraFirstPhase\("locating"\);/);
  });

  it("撮影後に getCurrentPosition を呼び直さない (直列取得の撤去)", () => {
    expect(HANDLER).not.toMatch(/geolocation\.getCurrentPosition/);
  });

  it("prefetch が無い場合は場所指定へフォールバックする (写真は保持)", () => {
    expect(HANDLER).toMatch(/if \(!prefetch\) \{/);
    expect(HANDLER).toMatch(/fallbackToMapTap\(null\);/);
    // 写真は ref に入れてから分岐する = 撮り直しを要求しない
    const photoIdx = HANDLER.indexOf("cameraPhotoFileRef.current = file;");
    const branchIdx = HANDLER.indexOf("if (!prefetch)");
    expect(photoIdx).toBeGreaterThan(-1);
    expect(photoIdx).toBeLessThan(branchIdx);
  });

  it("適用は requestId 付きで行う (取り直し後も正しい token で照合する)", () => {
    expect(HANDLER).toMatch(
      /const apply = \(requestId: number, result: CameraPrefetchResult\) =>/,
    );
    // 待機の継続は finish 経由 (鮮度検証を通す)。適用時は entry の requestId を渡す。
    expect(HANDLER).toMatch(/void entry\.promise\.then\(finish\);/);
    expect(HANDLER).toMatch(/apply\(entry\.requestId, r\);/);
  });

  it("既存のガード (mount / token / session / modal 競合 / 失敗理由) を維持する", () => {
    expect(HANDLER).toMatch(/if \(!fsMapMountedRef\.current\) return;/);
    expect(HANDLER).toMatch(/currentLocationRequestIdRef\.current !== requestId/);
    // 巡回外で始めた撮影は巡回開始で破棄しない (@codex #326 R1)
    expect(HANDLER).toMatch(
      /requestSessionId !== null &&\s*\n?\s*activeSessionIdRef\.current !== requestSessionId/,
    );
    expect(HANDLER).toMatch(/if \(createCandidateOpenRef\.current\) \{/);
    expect(HANDLER).toMatch(/fallbackToMapTap\(result\.code\);/);
  });

  it("座標を console に出さない (PII)", () => {
    expect(HANDLER).not.toMatch(/console\./);
  });
});

describe("鮮度判定 isCameraPrefetchFresh (純関数)", () => {
  const now = 1_000_000;

  it("しきい値は徒歩の移動を考慮した 20 秒", () => {
    expect(CAMERA_PREFETCH_MAX_AGE_MS).toBe(20_000);
  });

  it("しきい値内なら新しいと判定する", () => {
    expect(isCameraPrefetchFresh({ timestamp: now }, now)).toBe(true);
    expect(isCameraPrefetchFresh({ timestamp: now - 19_999 }, now)).toBe(true);
    expect(isCameraPrefetchFresh({ timestamp: now - 20_000 }, now)).toBe(true);
  });

  it("しきい値を超えたら古いと判定する (取り直しに回す)", () => {
    expect(isCameraPrefetchFresh({ timestamp: now - 20_001 }, now)).toBe(false);
    expect(isCameraPrefetchFresh({ timestamp: now - 120_000 }, now)).toBe(false);
  });

  it("timestamp が取れない場合は安全側 (古い扱い)", () => {
    expect(isCameraPrefetchFresh(null, now)).toBe(false);
    expect(isCameraPrefetchFresh(undefined, now)).toBe(false);
    expect(isCameraPrefetchFresh({}, now)).toBe(false);
    expect(isCameraPrefetchFresh({ timestamp: NaN }, now)).toBe(false);
  });

  it("端末時計のずれで未来時刻でも新しい扱い (取り直しループを避ける)", () => {
    expect(isCameraPrefetchFresh({ timestamp: now + 5_000 }, now)).toBe(true);
  });

  it("しきい値は引数で上書きできる (将来の調整用)", () => {
    expect(isCameraPrefetchFresh({ timestamp: now - 30_000 }, now, 60_000)).toBe(
      true,
    );
  });
});
