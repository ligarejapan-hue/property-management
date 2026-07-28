/**
 * 巡回開始の1本化 (2026-07-29 業務判断)。
 *
 * 【背景】本番の巡回 11 件のうち 9 件が軌跡ゼロだった。原因は「巡回開始」と
 * 「位置記録開始」が別操作で、後者がパネルの奥にあり、資料にも載っていな
 * かったこと。歩いた記録が残らなければ踏破ヒートも育たない。
 *
 * 【決定】**「巡回開始」ひとつで、位置記録の開始・現在地へ寄せる・倍率を
 * 上げるまで済ませる**。同意文は初回だけ。位置が取れなくても巡回は始める。
 *
 * ⚠vitest は env=node (jsdom 無) のため、実 DOM ではなくソース文字列で
 * 実装の形を固定する。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const MAP_SRC = read("src/components/field-survey/field-survey-map.tsx");
const TRIP_SRC = read("src/components/field-survey/trip-controls.tsx");
const CONTROLS_SRC = read(
  "src/components/field-survey/location-recorder-controls.tsx",
);
// 説明文の正本。表示箇所が2つある (巡回開始の確認 / 印の無い端末での再開)
// ので、本文はこのファイルにしか置かない。
const NOTICE_SRC = read(
  "src/components/field-survey/location-consent-notice.tsx",
);

describe("1. 巡回開始で位置記録も始まる", () => {
  it("巡回が始まった遷移で自動開始を予約する", () => {
    // 開始 (prevId === null && nextId !== null) の時だけ予約する。
    // 別巡回への切替や終了で走らせない。
    expect(MAP_SRC).toMatch(
      /autoStartRecordingRef\.current = true[\s\S]{0,200}autoCenterOnStartRef\.current = true/,
    );
  });

  it("session id が届いてから start() を呼ぶ (同一イベント内では呼ばない)", () => {
    // recorder は sessionId を effect で ref へ同期するため、
    // handleActiveSessionChange の中で start() を呼ぶと sessionId が
    // まだ null で弾かれる。
    const eff = MAP_SRC.match(
      /if \(!autoStartRecordingRef\.current\) return;[\s\S]{0,600}?\}, \[[^\]]*\]\);/,
    );
    expect(eff).not.toBeNull();
    const m = eff?.[0] ?? "";
    expect(m).toContain("activeSession?.id");
    expect(m).toContain("autoStartRecordingRef.current = false");
    expect(m).toContain("recorder.start()");
  });

  it("巡回が終わったら予約を取り消す (次の巡回へ持ち越さない)", () => {
    const off = MAP_SRC.match(
      /autoStartRecordingRef\.current = false;\s*\n\s*autoCenterOnStartRef\.current = false;/,
    );
    expect(off).not.toBeNull();
  });
});

describe("1-b. 復元では自動開始しない (本人の停止を覆さない)", () => {
  it("開始の予約は justStarted のときだけ立てる", () => {
    expect(MAP_SRC).toMatch(
      /prevId === null && nextId !== null && opts\?\.justStarted/,
    );
  });

  it("巡回開始 API が成功したときだけ justStarted を立てる", () => {
    // 復元経路 (fetchActiveSession) では立てない。
    expect(TRIP_SRC).toMatch(
      /outcome\.kind === "ok" && body\?\.data[\s\S]{0,120}justStartedIdRef\.current = body\.data\.id/,
    );
  });

  it("一度伝えたら降ろす (同じ巡回の再通知で二度立てない)", () => {
    const notify =
      TRIP_SRC.match(
        /const justStarted = !!session[\s\S]{0,400}?onActiveSessionChange\(session, \{ justStarted \}\);/,
      )?.[0] ?? "";
    expect(notify).not.toBe("");
    expect(notify).toContain("justStartedIdRef.current = null");
  });

  it("recorder 側にも二重開始の歯止めがある (状態ガード)", () => {
    const hook = read(
      "src/components/field-survey/use-field-survey-location-recorder.ts",
    );
    expect(hook).toMatch(
      /if \(status === "recording" \|\| status === "preparing"\) return;/,
    );
  });
});

describe("2. 開始と同時に現在地へ寄せて倍率を上げる", () => {
  it("最初の現在地が取れた時点で panTo と setZoom を呼ぶ", () => {
    const eff = MAP_SRC.match(
      /if \(!autoCenterOnStartRef\.current\) return;[\s\S]{0,800}?\}, \[[^\]]*\]\);/,
    );
    expect(eff).not.toBeNull();
    const m = eff?.[0] ?? "";
    expect(m).toContain("recorder.latestPositionForDisplay");
    expect(m).toContain("autoCenterOnStartRef.current = false");
    expect(m).toContain("panTo");
    expect(m).toContain("setZoom(TRIP_START_ZOOM)");
  });

  it("開始時の倍率は既定より大きい (街歩きで建物が見える)", () => {
    const z = MAP_SRC.match(/const TRIP_START_ZOOM = (\d+)/);
    expect(z).not.toBeNull();
    const zoom = Number(z?.[1] ?? 0);
    const def = Number(MAP_SRC.match(/const DEFAULT_ZOOM = (\d+)/)?.[1] ?? 0);
    expect(zoom).toBeGreaterThan(def);
    expect(zoom).toBeGreaterThanOrEqual(16);
  });

  it("位置が取れなければ何もしない (巡回自体は止めない)", () => {
    const eff =
      MAP_SRC.match(
        /if \(!autoCenterOnStartRef\.current\) return;[\s\S]{0,800}?\}, \[[^\]]*\]\);/,
      )?.[0] ?? "";
    // 位置が無い間は ref を落とさずに return し、後から届いた時に効かせる。
    const posGuard = eff.indexOf("if (!pos) return;");
    const clear = eff.indexOf("autoCenterOnStartRef.current = false");
    expect(posGuard).toBeGreaterThan(-1);
    expect(posGuard).toBeLessThan(clear);
  });
});

describe("3. 同意文は初回だけ", () => {
  it("開始確認を開くときに同意済みかを見る", () => {
    expect(TRIP_SRC).toContain("hasLocationConsent()");
    expect(TRIP_SRC).toMatch(/setNeedsLocationConsent\(!hasLocationConsent\(\)\)/);
  });

  it("同意して開始したら記録する", () => {
    expect(TRIP_SRC).toContain("markLocationConsent()");
  });

  it("初回だけ位置記録の説明を出す", () => {
    expect(TRIP_SRC).toMatch(/showLocationConsent &&/);
    expect(TRIP_SRC).toMatch(/巡回中は位置を記録します/);
    // 本文は共有部品から出す (2箇所で文言がずれないように)
    expect(TRIP_SRC).toMatch(/<LocationConsentNotice \/>/);
  });

  it("「別途ボタンを押した時のみ記録」という古い説明を残さない", () => {
    // 実装が変わったのに文言が残ると、現場が「押していないから記録されて
    // いない」と誤解する。
    expect(TRIP_SRC).not.toMatch(/巡回開始だけでは GPS は使われません/);
  });

  it("同意文をローカルにしか持たない (サーバへ送らない)", () => {
    const consent = read("src/lib/field-survey-location-consent.ts");
    expect(consent).not.toMatch(/fetch\(/);
    expect(consent).not.toMatch(/\/api\//);
  });
});

describe("4. 位置記録パネルは「再開」だけを持つ", () => {
  it("説明文の本文をパネル側に複製しない (正本は共有部品)", () => {
    // 2箇所で別々に書くと、片方だけ直して文言がずれる。
    expect(CONTROLS_SRC).not.toMatch(/歩いた場所は、次にどのエリア/);
    expect(CONTROLS_SRC).toMatch(/LocationConsentModal/);
    expect(NOTICE_SRC).toMatch(/端末側には保存しません/);
  });

  it("止めた後に戻せる導線を残す (任意機能のまま)", () => {
    expect(CONTROLS_SRC).toMatch(/data-testid="location-record-start-button"/);
    expect(CONTROLS_SRC).toMatch(/位置記録を再開/);
    expect(CONTROLS_SRC).toMatch(/data-testid="location-record-stop-button"/);
  });

  it("印のある端末ではワンタップで再開する", () => {
    expect(CONTROLS_SRC).toMatch(
      /if \(hasLocationConsent\(\)\) \{[\s\S]{0,80}?onStart\(\);[\s\S]{0,40}?return;/,
    );
  });

  it("印の無い端末では再開でも説明を出してから始める (@codex #333 P2)", () => {
    // 巡回を復元しただけの時 (機種変更 / 別ブラウザ / 履歴削除 / この反映より
    // 前に始まった巡回) は巡回開始の確認 modal を通らない。ここを素通しに
    // すると、同意文を一度も見ていない端末で押した瞬間に記録が始まる。
    expect(CONTROLS_SRC).toMatch(/setConfirming\(true\)/);
    const agree =
      CONTROLS_SRC.match(
        /onAgree=\{\(\) => \{[\s\S]{0,240}?\}\}/,
      )?.[0] ?? "";
    expect(agree).toContain("markLocationConsent()");
    expect(agree).toContain("onStart()");
  });
});

describe("5. 個人情報の扱い (継続)", () => {
  it("同意まわりで座標・氏名を console に出さない", () => {
    const consent = read("src/lib/field-survey-location-consent.ts");
    expect(consent).not.toMatch(/console\./);
  });
});
