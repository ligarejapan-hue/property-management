import { describe, it, expect } from "vitest";
import { buildDmReadiness } from "@/lib/sale-dm-letter/dm-readiness";

const scen = (name: string, letterReady: boolean, lpReady: boolean) => ({ id: name, name, letterReady, lpReady });

describe("buildDmReadiness(DMメニューの準備チェック・第4回 E)", () => {
  it("全部そろっていれば allOk・各行 ok", () => {
    const r = buildDmReadiness({ settingsMissing: [], scenarios: [scen("相続", true, true)] });
    expect(r.allOk).toBe(true);
    expect(r.items.map((i) => i.ok)).toEqual([true, true]);
  });

  it("売却DM設定の足りない項目を名前で出す(直す画面=売却DM設定)", () => {
    const r = buildDmReadiness({ settingsMissing: ["差出人名", "追跡URL"], scenarios: [] });
    const s = r.items[0];
    expect(s.key).toBe("settings");
    expect(s.ok).toBe(false);
    expect(s.detail).toBe("未設定: 差出人名・追跡URL");
    expect(s.fixHref).toBe("/admin/sale-dm-settings");
    expect(r.allOk).toBe(false);
  });

  it("種類ごとに手紙とLPの登録を見る(手紙が無い=×、LPだけ無い=注意)", () => {
    const r = buildDmReadiness({
      settingsMissing: [],
      scenarios: [scen("相続", true, true), scen("空き家", true, false), scen("相続（マンション）", false, false)],
    });
    const rows = r.items.filter((i) => i.key.startsWith("scenario:"));
    expect(rows.map((i) => [i.label, i.ok, i.level])).toEqual([
      ["DMの種類「相続」", true, "ok"],
      ["DMの種類「空き家」", true, "warn"],
      ["DMの種類「相続（マンション）」", false, "ng"],
    ]);
    expect(rows[1].detail).toBe("手紙は登録済み・LPが未登録(QRは会社のホームページへ)");
    expect(rows[2].detail).toBe("手紙が未登録(この種類の物件を含む発送は作れません)");
    expect(rows.every((i) => i.fixHref === "/admin/dm-scenarios")).toBe(true);
    // LPだけ無いのは作れる=全体の可否には数えない
    expect(r.allOk).toBe(false);
    const r2 = buildDmReadiness({ settingsMissing: [], scenarios: [scen("空き家", true, false)] });
    expect(r2.allOk).toBe(true);
  });

  it("使える種類が1つも無いときはその旨を1行出す", () => {
    const r = buildDmReadiness({ settingsMissing: [], scenarios: [] });
    expect(r.items[1]).toMatchObject({ key: "scenarios", ok: false, level: "ng", detail: "使える種類がありません" });
  });
});
