/**
 * 地図の「現在地へ移動」— 純ロジックの検証。
 *
 * 業務背景: 街歩き中に地図をずらしてから自分の場所へ戻る操作が、表示切替パネル
 * 最下部にしか無く実質使えなかった (2026-08-03 発注者フィードバック)。地図左下の
 * FAB として出し直すにあたり、押したときの分岐・文言・倍率の判断をここで固定する。
 */
import { describe, it, expect } from "vitest";
import {
  describeGeolocationError,
  recenterPlan,
  recenterZoom,
  RECENTER_UNSUPPORTED_MESSAGE,
} from "@/lib/field-survey-map-recenter";

describe("recenterPlan — 押したときに何をするか", () => {
  it("位置記録中は recorder の位置で即座に寄せる (GPS を取り直さない)", () => {
    const plan = recenterPlan({
      livePosition: { lat: 35.1, lng: 139.1 },
      locating: false,
    });
    expect(plan.kind).toBe("use-live");
    if (plan.kind === "use-live") {
      expect(plan.pos).toEqual({ lat: 35.1, lng: 139.1 });
    }
  });

  it("記録していなければ単発取得へ落ちる", () => {
    expect(recenterPlan({ livePosition: null, locating: false }).kind).toBe(
      "locate",
    );
  });

  it("取得中の連打では何もしない (取得を多重に走らせない)", () => {
    expect(recenterPlan({ livePosition: null, locating: true }).kind).toBe(
      "busy",
    );
  });

  it("⚠記録中なら locating が立っていても即座に寄せる (連打で無反応にしない)", () => {
    // busy を live より先に見ると、記録中に押しっぱなしで固まる。
    const plan = recenterPlan({
      livePosition: { lat: 35.2, lng: 139.2 },
      locating: true,
    });
    expect(plan.kind).toBe("use-live");
  });

  it("渡された位置オブジェクトをそのまま参照で返さない (呼び出し側の書き換えから守る)", () => {
    const live = { lat: 35.3, lng: 139.3 };
    const plan = recenterPlan({ livePosition: live, locating: false });
    if (plan.kind !== "use-live") throw new Error("use-live のはず");
    expect(plan.pos).not.toBe(live);
    expect(plan.pos).toEqual(live);
  });
});

describe("describeGeolocationError — 現場で直し方が分かる文言", () => {
  it("許可されていない (code 1) は許可の取り方と https を案内する", () => {
    const msg = describeGeolocationError(1);
    expect(msg).toContain("許可");
    expect(msg).toContain("https");
  });

  it("タイムアウト (code 3) は屋外/窓際を案内する", () => {
    expect(describeGeolocationError(3)).toContain("屋外");
  });

  it("取得不能 (code 2) と不明な code は電波を案内する", () => {
    expect(describeGeolocationError(2)).toContain("電波");
    expect(describeGeolocationError(null)).toContain("電波");
    expect(describeGeolocationError(999)).toContain("電波");
  });

  it("⚠英語・技術用語・座標を出さない (ブラウザ message を素通ししない)", () => {
    for (const code of [1, 2, 3, null, 999]) {
      const msg = describeGeolocationError(code);
      // 利用者に意味のある "https" 以外の英単語を混ぜない
      expect(msg.replace(/https/g, "")).not.toMatch(/[A-Za-z]{2,}/);
      expect(msg).not.toMatch(/geolocation|PERMISSION_DENIED|TIMEOUT/i);
      expect(msg).not.toMatch(/\d{2,3}\.\d{3,}/); // 緯度経度らしき数値
    }
  });

  it("未対応ブラウザの案内は代替手段 (地図タップ) を示す", () => {
    expect(RECENTER_UNSUPPORTED_MESSAGE).toContain("地図をタップ");
  });
});

describe("recenterZoom — 寄せたあとの倍率", () => {
  it("引きすぎているときだけ街歩き用まで上げる", () => {
    expect(recenterZoom({ currentZoom: 14, tripZoom: 17 })).toBe(17);
    expect(recenterZoom({ currentZoom: 10, tripZoom: 17 })).toBe(17);
  });

  it("⚠すでに寄せている人の倍率は変えない (見ていた範囲を見失わせない)", () => {
    expect(recenterZoom({ currentZoom: 17, tripZoom: 17 })).toBeNull();
    expect(recenterZoom({ currentZoom: 19, tripZoom: 17 })).toBeNull();
  });

  it("倍率が読めない環境では何もしない", () => {
    expect(recenterZoom({ currentZoom: null, tripZoom: 17 })).toBeNull();
    expect(recenterZoom({ currentZoom: undefined, tripZoom: 17 })).toBeNull();
    expect(recenterZoom({ currentZoom: Number.NaN, tripZoom: 17 })).toBeNull();
  });
});
