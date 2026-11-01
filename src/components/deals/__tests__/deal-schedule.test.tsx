import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DealScheduleView } from "../deal-schedule";
import { parseOffsetDays, ScheduleTemplateEditor } from "../schedule-template-editor";
import { DEFAULT_SCHEDULE_TEMPLATE, MORTGAGE_UNKNOWN_NOTE, PRE_INTRODUCTION_NOTE } from "@/lib/deals/schedule";
import type { ScheduleItemView } from "@/lib/deals/schedule-sync";
import { HomeDealScheduleView } from "@/components/home/home-deal-schedule";
import { RequestDraftBlanks } from "../deal-request-draft";
import { RequestTemplateEditor, scheduleItemOptions } from "../request-template-editor";
import { DEFAULT_REQUEST_TEMPLATES } from "@/lib/deals/request-drafts/templates";

describe("依頼文のひな形の編集", () => {
  it("差し込み欄の一覧・相手・結びつきを出す", () => {
    const html = renderToStaticMarkup(<RequestTemplateEditor items={DEFAULT_REQUEST_TEMPLATES} scheduleItems={DEFAULT_SCHEDULE_TEMPLATE} onChange={() => {}} />);
    for (const s of ["使える差し込み欄", "物件名", "提出用リンク", "結びつける段取りの項目", "初めのひな形に戻す", "司法書士に決済日時と登記を依頼"]) expect(html).toContain(s);
  });
  it("段取りのひな形から消した項目を結んでいても、外れたことが分かる", () => {
    expect(scheduleItemOptions([{ id: "a", label: "A" }], "gone").map((o) => o.label)).toEqual(["結びつけない", "A", "(段取りのひな形から消した項目)"]);
    expect(scheduleItemOptions([{ id: "a", label: "A" }], "a")).toHaveLength(2);
  });
});

const item = (o: Partial<ScheduleItemView> = {}): ScheduleItemView => ({
  id: "a", label: "精算書を作成", base: "settlement", dueDate: "2026-12-09", dueManual: false, isManual: false, assigneeId: "u1", assigneeName: "担当 太郎",
  completed: false, autoCompleted: false, excluded: false, preIntroduction: false, mortgageUnknown: false, completionHint: null, ...o,
});
const render = (items: ScheduleItemView[]) => renderToStaticMarkup(
  <DealScheduleView items={items} today="2026-12-01" settlementDate="2026-12-16" users={[{ id: "u1", name: "担当 太郎", role: "office_staff" }]} actions={{ onUpdate: () => {}, onCompletePre: () => {} }} />,
);

describe("決済までの段取りの見た目", () => {
  it("項目が無ければ案内を出す", () => expect(render([])).toContain("契約日か決済日を入れると"));
  it("時期ごとにまとめ、あと何日・超過・完了を出す", () => {
    const html = render([
      item({ id: "1", dueDate: "2026-11-25", label: "案内" }), item({ id: "2", dueDate: "2026-12-09" }), item({ id: "3", dueDate: "2026-12-16", label: "決済", completed: true, autoCompleted: true }),
    ]);
    expect(html).toContain("決済の3週間前ごろ");
    expect(html).toContain("決済の1週間前ごろ");
    expect(html).toContain("決済の前日・当日");
    expect(html).toContain("6日超過");
    expect(html).toContain("あと8日");
    expect(html).toContain("自動で完了");
    expect(html).toContain("完了 1/3件");
    expect(html).toContain("期限超過 1件");
  });
  it("担保を判定できない項目に確認を促す。件数や抵当権者は出さない", () => {
    const html = render([item({ label: "金融機関に抵当権抹消の書類を依頼", mortgageUnknown: true })]);
    expect(html).toContain(MORTGAGE_UNKNOWN_NOTE);
    expect(html).not.toMatch(/\d+件残/);
  });
  it("導入前の項目は超過に数えず、まとめて完了のボタンを出す", () => {
    const html = render([item({ dueDate: "2026-11-01", preIntroduction: true })]);
    expect(html).toContain("導入前の項目");
    expect(html).toContain(PRE_INTRODUCTION_NOTE);
    expect(html).toContain("導入前の項目をまとめて完了にする");
    expect(html).not.toContain("期限超過");
    expect(html).not.toContain("日超過");
  });
  it("対象外は「対象外になりました」と出して消さない", () => {
    const html = render([item({ excluded: true })]);
    expect(html).toContain("対象外になりました");
    expect(html).toContain("戻す");
  });
  it("提出書類の受領の進み具合を出す。全部受領ならそのことを出す", () => {
    const html = renderToStaticMarkup(
      <DealScheduleView items={[]} today="2026-12-01" settlementDate={null} users={[]} actions={{ onUpdate: () => {}, onCompletePre: () => {} }} docProgress={[
        { partyRole: "seller", partyName: "試験 太郎", total: 3, received: 3 },
        { partyRole: "buyer", partyName: null, total: 2, received: 1 },
      ]} />,
    );
    expect(html).toContain("売主 試験 太郎:必要な書類がすべて受領になりました(3/3)");
    expect(html).toContain("買主:提出書類の受領 1/2");
  });
  describe("依頼文を作る", () => {
    const actions = { onUpdate: () => {}, onCompletePre: () => {}, onOpenDraft: () => {} };
    const view = (items: ScheduleItemView[], copies: { at: string; userName: string | null; templateLabel: string }[] = []) => renderToStaticMarkup(
      <DealScheduleView items={items} today="2026-12-01" settlementDate="2026-12-16" users={[]} actions={actions} requestDraftCopies={copies} />,
    );
    it("ひな形が結びついた項目にだけボタンを出す", () => {
      expect(view([item({ requestTemplates: 1 })])).toContain("依頼文を作る");
      expect(view([item({ requestTemplates: 0 })])).not.toContain("依頼文を作る");
      expect(view([item({ isManual: true })])).not.toContain("依頼文を作る");
    });
    it("対象外の項目には出さない", () => {
      expect(view([item({ requestTemplates: 1, excluded: true })])).not.toContain("依頼文を作る");
    });
    it("コピーの履歴に誰が・いつ・どのひな形かを出す", () => {
      const html = view([item()], [{ at: "2026-12-01T01:30:00.000Z", userName: "担当 太郎", templateLabel: "司法書士へ" }]);
      expect(html).toContain("依頼文のコピー履歴");
      expect(html).toContain("2026/12/01 10:30 担当 太郎 司法書士へ");
    });
    it("履歴が無ければ見出しも出さない", () => expect(view([item()])).not.toContain("依頼文のコピー履歴"));
    it("空の欄を理由つきで知らせる", () => {
      const html = renderToStaticMarkup(<RequestDraftBlanks blanks={[{ field: "決済場所", reason: "missing" }, { field: "売主住所", reason: "permission" }]} />);
      expect(html).toContain("決済場所(未入力)");
      expect(html).toContain("売主住所(権限なし)");
      expect(renderToStaticMarkup(<RequestDraftBlanks blanks={[]} />)).toBe("");
    });
  });
  it("提出用リンクの完了候補を出す", () => {
    expect(render([item({ completionHint: "doc_link_issued" })])).toContain("提出用リンクを発行しました");
  });
  it("完了候補の知らせを出す", () => {
    const html = render([item({ completionHint: "mortgage_cleared" })]);
    expect(html).toContain("抹消済みの謄本を取り込みました");
  });
  it("完了の取り消しができる(完了の項目もチェックを外せる)", () => {
    const html = render([item({ completed: true })]);
    expect(html).toMatch(/type="checkbox"[^>]*checked/);
  });
});

describe("段取りのひな形の編集", () => {
  it("項目と選択肢を出す", () => {
    const html = renderToStaticMarkup(<ScheduleTemplateEditor items={DEFAULT_SCHEDULE_TEMPLATE} onChange={() => {}} />);
    expect(html).toContain("司法書士に決済日時と登記を依頼");
    expect(html).toContain("有効な担保があるときだけ");
    expect(html).toContain("事務担当");
    expect(html).toContain("初めの項目に戻す");
  });
  it("日数の読み取り", () => {
    expect(parseOffsetDays("-7")).toBe(-7);
    expect(parseOffsetDays("−7")).toBe(-7);
    expect(parseOffsetDays("+3")).toBe(3);
    expect(parseOffsetDays("0")).toBe(0);
    expect(parseOffsetDays("-0")).toBe(0);
    expect(parseOffsetDays("abc")).toBeNull();
    expect(parseOffsetDays("999")).toBeNull();
    expect(parseOffsetDays("")).toBeNull();
  });
});

describe("ホームの自分の段取り", () => {
  const row = { id: "1", label: "精算書を作成", dueDate: "2026-11-02", dealId: "d1", dealNo: "2026-0001", dealTitle: "第一ハイツ 101" };
  it("0件なら何も出さない", () => expect(renderToStaticMarkup(<HomeDealScheduleView items={[]} hasMore={false} />)).toBe(""));
  it("今日・明日・期限超過を出し、取引の画面へ", () => {
    const html = renderToStaticMarkup(<HomeDealScheduleView hasMore={false} items={[
      { ...row, slot: "today" }, { ...row, id: "2", slot: "tomorrow" }, { ...row, id: "3", slot: "overdue", dueDate: "2026-10-30" },
    ]} />);
    expect(html).toContain("今日");
    expect(html).toContain("明日");
    expect(html).toContain("期限超過 10/30");
    expect(html).toContain('href="/deals/d1"');
    expect(html).toContain("第一ハイツ 101");
  });
});
