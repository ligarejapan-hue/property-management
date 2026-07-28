/**
 * 連続ピンモード (保存後の作業継続性) のソース静的検証。
 *
 * 現場の指摘「保存のたびにピン追加モードが解除され、パネルを閉じて
 * 入れ直す 2 タップが毎回挟まる」への対応:
 * - 保存成功後も pin 追加モードを維持する (誤タップは modal キャンセルで防げる)
 * - 写真付き保存は詳細パネルを開かず「ピンを保存しました」トーストのみ
 * - 写真なし保存は従来どおり詳細パネルを開く (写真の追加先を提示)
 * - モード中はスマホ折りたたみボタンに「・ピン追加中」を表示 (状態の可視化)
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const MAP_SRC = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/field-survey/field-survey-map.tsx",
  ),
  "utf8",
);

describe("field-survey-map.tsx — 連続ピンモード", () => {
  const finalize = MAP_SRC.match(
    /const finalizePinCreate\s*=\s*useCallback\([\s\S]*?\}\,\s*\[[\s\S]*?\],?\s*\);/,
  );

  it("finalizePinCreate は pin 追加モードを自動 OFF しない (連続作業を優先)", () => {
    expect(finalize).not.toBeNull();
    const m = finalize?.[0] ?? "";
    expect(m).not.toMatch(/setPinAddMode\(false\)/);
  });

  it("finalizePinCreate は hadPhoto を受け取り、写真付きはトースト・写真なしは詳細パネル", () => {
    expect(finalize).not.toBeNull();
    const m = finalize?.[0] ?? "";
    expect(m).toMatch(/\(pinId:\s*string,\s*hadPhoto:\s*boolean\)/);
    // 写真付き (またはカメラ由来) はトーストを出して early return
    expect(m).toMatch(
      /(fromCamera\s*\|\|\s*hadPhoto|hadPhoto\s*\|\|\s*fromCamera)[\s\S]*?setSavedToastPinId\(pinId\)[\s\S]*?return/,
    );
    // 写真なしは従来どおり詳細パネル
    expect(m).toMatch(/setDetailPinId\(pinId\)/);
  });

  it("呼び出し側は写真の有無を正しく渡す (submit 写真なし/あり・再試行・写真なし完了)", () => {
    // 写真なし submit → hadPhoto=false
    const noFile = MAP_SRC.match(
      /if\s*\(!file\)\s*\{[\s\S]*?finalizePinCreate\(newPinId,\s*false\)/,
    );
    expect(noFile).not.toBeNull();
    // 写真 upload 成功 → hadPhoto=true
    expect(MAP_SRC).toMatch(/finalizePinCreate\(newPinId,\s*true\)/);
    // 「写真だけ再試行」成功 → hadPhoto=true
    const retry = MAP_SRC.match(
      /const handleRetryPhoto[\s\S]*?finalizePinCreate\(pinId,\s*true\)/,
    );
    expect(retry).not.toBeNull();
    // 「写真なしで完了」 → hadPhoto=false
    const without = MAP_SRC.match(
      /const handleFinishWithoutPhoto[\s\S]*?finalizePinCreate\(pinId,\s*false\)/,
    );
    expect(without).not.toBeNull();
  });

  it("保存完了トーストは pin id を保持する汎用 state (カメラ専用ではない)", () => {
    expect(MAP_SRC).toMatch(/const \[savedToastPinId, setSavedToastPinId\]/);
    expect(MAP_SRC).toMatch(/data-testid="pin-saved-toast"/);
    expect(MAP_SRC).not.toMatch(/cameraSavedNotice/);
  });

  it("スマホ折りたたみボタンにピン追加モード中の表示がある (排他・短ラベル)", () => {
    // ピン追加は巡回中にしか ON にならないため排他表示で短く保つ。
    // 併記 (・巡回中・ピン追加中) は幅が広がり左上の地図/航空写真ボタンに
    // 重なってタップを奪う (実機で過去に発生した既知ホットスポット)。
    expect(MAP_SRC).toMatch(
      /表示切替\{pinAddMode\s*\?\s*"・ピン追加"\s*:\s*hasActiveSession\s*\?\s*"・巡回中"\s*:\s*""\}/,
    );
  });

  it("巡回の終了/切替でピン追加モードを解除する (表示・OFF導線の残留防止)", () => {
    // OFF 導線 (パネル内トグル) は巡回中しか描画されないため、session が
    // 消えるタイミングでモードも畳む。次の巡回開始時の暗黙 ON 復活も防ぐ。
    const handler = MAP_SRC.match(
      /const handleActiveSessionChange\s*=\s*useCallback\([\s\S]*?\[resetCameraFirst[^\]]*\],?\s*\);/,
    );
    expect(handler).not.toBeNull();
    expect(handler?.[0] ?? "").toMatch(
      /resetCameraFirst\(\)[\s\S]{0,1200}setPinAddMode\(false\)/,
    );
  });

  it("地図タップで新規作成を確定したら詳細パネルを閉じる (旧ピン残留・トースト遮蔽防止)", () => {
    // 連続ピンモードでは詳細パネル表示中も地図タップが有効。パネル (z-40
    // bottom sheet) を開いたままだと写真付き保存のトースト (z-10) が隠れ、
    // 無関係な旧ピンのパネルも残るため、candidate 確定時に必ず閉じる。
    const handler = MAP_SRC.match(
      /const handleMapClick\s*=\s*useCallback\([\s\S]*?\],?\s*\);/,
    );
    expect(handler).not.toBeNull();
    const closes =
      (handler?.[0] ?? "").match(/setDetailPinId\(null\)/g) ?? [];
    // カメラの地図タップ待ち経路 + 通常のピン追加モード経路の両方
    expect(closes.length).toBeGreaterThanOrEqual(2);
  });

  it("詳細パネルで作業中は地図タップを無視する (下書き・送信中写真の喪失防止)", () => {
    // Codex P2: 編集下書き / 削除確認 / 物件化 / 写真送信中に地図タップで
    // パネルを黙って unmount すると下書き喪失・upload 中断になる。
    // パネルが busy を親へ通知し、親は busy の間タップを無視する。
    const handler = MAP_SRC.match(
      /const handleMapClick\s*=\s*useCallback\([\s\S]*?\],?\s*\);/,
    );
    expect(handler).not.toBeNull();
    // busy ガードは candidate 確定 (setDetailPinId(null)) より前
    const m = handler?.[0] ?? "";
    const guardIdx = m.indexOf("detailPanelBusyRef.current");
    const closeIdx = m.indexOf("setDetailPinId(null)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(guardIdx);
    // 親は callback で ref に受ける (cascading render なし)
    expect(MAP_SRC).toMatch(
      /onBusyStateChange=\{handleDetailPanelBusyChange\}/,
    );

    const PANEL_SRC = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/components/field-survey/pin-detail-panel.tsx",
      ),
      "utf8",
    );
    // パネル側: 編集/削除確認/物件化/写真送信を合流した busy を通知し、
    // unmount では必ず false へ戻す
    expect(PANEL_SRC).toMatch(/onBusyStateChange\?:\s*\(busy:\s*boolean\)/);
    expect(PANEL_SRC).toMatch(
      /hasUnfinishedWork\s*=[\s\S]{0,300}editing[\s\S]{0,300}confirmingDelete[\s\S]{0,300}showConvert[\s\S]{0,300}photoSectionBusy/,
    );
    expect(PANEL_SRC).toMatch(
      /return\s*\(\)\s*=>\s*\{\s*onBusyStateChange\?\.\(false\);/,
    );
    // 写真セクション: 送信・削除中を親 panel に合流
    expect(PANEL_SRC).toMatch(/onBusyChange=\{setPhotoSectionBusy\}/);
    expect(PANEL_SRC).toMatch(
      /photoBusy\s*=[\s\S]{0,120}uploadLoading\s*\|\|[\s\S]{0,60}deleteLoading/,
    );
  });
});
