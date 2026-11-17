import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FOLLOWUP_STOP_CONFIRM,
  FollowupStatusBlock,
  InquiryFollowupLine,
  PropertyLeadFollowupField,
} from "@/components/lead-followup/followup-status";
import type { LeadFollowupView } from "@/lib/api-client";

const active: LeadFollowupView = {
  state: "active",
  label: "進行中",
  canStop: true,
  stopped: null,
  sends: [{ label: "新規の流れ 1通目", result: "送信", at: "2026-11-20T01:00:00.000Z" }],
};
const stopped: LeadFollowupView = {
  state: "stopped",
  label: "止まっています(担当が止めた)",
  canStop: false,
  stopped: { reason: "担当が止めた", at: "2026-11-18T03:00:00.000Z", by: "担当A" },
  sends: [],
};

describe("追客メールの様子(表示)", () => {
  it("進行中: 状態・送った記録(日本時間)・止める権限があれば「追客を止める」", () => {
    const html = renderToStaticMarkup(<FollowupStatusBlock view={active} showStop onStop={vi.fn()} />);
    expect(html).toContain('data-followup-state="active"');
    expect(html).toContain("追客メール");
    expect(html).toContain("進行中");
    expect(html).toContain("新規の流れ 1通目: 送信");
    expect(html).toContain("2026/11/20 10:00");
    expect(html).toContain("追客を止める");
  });

  it("止める権限が無ければボタンを出さない", () => {
    const html = renderToStaticMarkup(<FollowupStatusBlock view={active} showStop={false} />);
    expect(html).not.toContain("追客を止める");
  });

  it("止まった行: 理由・止めた人・日時。ボタンは出さない(再開なし)", () => {
    const html = renderToStaticMarkup(<FollowupStatusBlock view={stopped} showStop onStop={vi.fn()} />);
    expect(html).toContain("止まっています(担当が止めた)");
    expect(html).toContain("担当Aが止めました");
    expect(html).toContain("2026/11/18 12:00");
    expect(html).not.toContain("追客を止める");
  });

  it("止めている途中は押せない・失敗の知らせを出す", () => {
    const html = renderToStaticMarkup(<FollowupStatusBlock view={active} showStop busy error="止められませんでした" />);
    expect(html).toContain("止めています…");
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain('role="alert"');
  });

  it("確認の文は「止めたら再開できない」を伝える", () => {
    expect(FOLLOWUP_STOP_CONFIRM).toContain("再開はできません");
  });
});

describe("置き場所ごとの出し方", () => {
  it("申込の一覧: 様子が null(メールを見られない人・始まりようのない申込)なら何も出さない", () => {
    expect(renderToStaticMarkup(<InquiryFollowupLine inquiryId="i1" initial={null} />)).toBe("");
    expect(renderToStaticMarkup(<InquiryFollowupLine inquiryId="i1" initial={active} />)).toContain("追客を止める");
  });

  it("物件の画面: 一括査定でない物件には出さない(読み込み前も何も出さない)", () => {
    expect(renderToStaticMarkup(<PropertyLeadFollowupField propertyId="p1" introductionRoute="dm" canWrite />)).toBe("");
    expect(renderToStaticMarkup(<PropertyLeadFollowupField propertyId="p1" introductionRoute="bulk_assessment" canWrite />)).toBe("");
  });

  it("物件の画面・申込の一覧に組み込んである", () => {
    const page = readFileSync("src/app/(dashboard)/properties/[id]/page.tsx", "utf8");
    expect(page).toMatch(/<PropertyLeadFollowupField key=\{property\.id\} propertyId=\{property\.id\} introductionRoute=\{property\.introductionRoute\} canWrite=\{canWrite\} \/>/);
    const list = readFileSync("src/components/sale-dm/inquiry-list.tsx", "utf8");
    expect(list).toContain("<InquiryFollowupLine");
  });
});
