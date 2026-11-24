import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { draftsToSteps, LeadFollowupSettingsForm, toDrafts } from "@/components/admin/lead-followup-settings";
import type { LeadFollowupSettings } from "@/lib/api-client";

const base: LeadFollowupSettings = {
  enabled: false,
  enabledAt: null,
  version: 0,
  steps: {
    new: [
      { delayDays: 0, subject: "", body: "" },
      { delayDays: 3, subject: "", body: "" },
    ],
    hold: [{ delayDays: 7, subject: "", body: "" }],
  },
  usingDefaultSlots: true,
  setupProblems: [],
  footerPreview: "──────────────\n送信者: 見本不動産",
};

describe("追客メールの区画(メール設定の画面)", () => {
  it("2本の流れ・通ごとの日数と件名と本文・末尾の見本・ON で送り始める旨と規約の確認を出す", () => {
    const html = renderToStaticMarkup(<LeadFollowupSettingsForm initial={base} onSaved={vi.fn()} />);
    expect(html).toContain("新規の流れ");
    expect(html).toContain("保留の流れ");
    expect(html).toContain('data-step="new-1"');
    expect(html).toContain('data-step="new-2"');
    expect(html).toContain('data-step="hold-1"');
    expect(html).toContain("登録から");
    expect(html).toContain("保留になった日から");
    expect(html).toContain("送信者: 見本不動産");
    expect(html).toContain("15分ごとの見回りで送り始めます");
    expect(html).toContain("査定サイトの規約");
    expect(html).toContain("追客メールの設定を保存");
    expect(html).toContain("全員への追客がすぐ止まります");
  });

  it("物件の対象になる導入ルートの名前と、外す物件(DM 送付不可・業者と同じ名前・自治体や国)を出す", () => {
    const html = renderToStaticMarkup(<LeadFollowupSettingsForm initial={base} onSaved={vi.fn()} />);
    for (const label of ["一括査定", "DM反響", "電話問い合わせ", "Web問い合わせ", "紹介"]) expect(html).toContain(label);
    expect(html).toContain("DM送付不可");
    expect(html).toContain("業者と同じ名前");
    expect(html).toContain("自治体・国");
    expect(html).toContain("DMの拒否・宛先不明");
  });

  it("足りない設定があれば一覧で出す・ON にした時刻を出す", () => {
    const html = renderToStaticMarkup(
      <LeadFollowupSettingsForm
        initial={{ ...base, enabled: true, enabledAt: "2026-11-17T01:00:00.000Z", setupProblems: ["会社の設定に住所がありません"] }}
        onSaved={vi.fn()}
      />,
    );
    expect(html).toContain("ON にする前に、次をそろえてください");
    expect(html).toContain("会社の設定に住所がありません");
    expect(html).toContain("ON にした時刻");
  });

  it("保存の直後は「保存しました」を出す", () => {
    const html = renderToStaticMarkup(<LeadFollowupSettingsForm initial={base} onSaved={vi.fn()} savedNotice />);
    expect(html).toContain("保存しました");
  });
});

describe("入力→保存の形", () => {
  it("日数は全角の数字も受ける・数字でなければ場所を返す", () => {
    const d = toDrafts(base.steps);
    d.new[1].delayDays = "３";
    const ok = draftsToSteps(d);
    expect(ok).toEqual({ ok: true, steps: { new: [{ delayDays: 0, subject: "", body: "" }, { delayDays: 3, subject: "", body: "" }], hold: [{ delayDays: 7, subject: "", body: "" }] } });
    d.hold[0].delayDays = "あ";
    const ng = draftsToSteps(d);
    expect(ng.ok).toBe(false);
    if (!ng.ok) expect(ng.error).toBe("保留の流れの1通目: 日数を数字で入れてください");
  });
});
