/**
 * 契約予定日・決済予定日の欄(物件詳細・案件ステータスのすぐ下)。
 * ⚠見せるだけ(2026-11-26 発注者「入れるのは取引からのみ」)。値は取引の日付の写し(lib/deals/case-dates-sync.ts)。
 * ⚠vitest は env=node(jsdom 無し)。見た目は renderToStaticMarkup で検査する。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import CaseDatesField from "../case-dates-field";

const base = { contractPlannedOn: null as string | null, settlementPlannedOn: null as string | null, deals: [] as unknown[] };
const render = (property: Partial<typeof base> & { caseStatus: string }, today = "2026-10-23") =>
  renderToStaticMarkup(<CaseDatesField property={{ ...base, ...property }} today={today} />);

describe("CaseDatesField(契約予定日・決済予定日)", () => {
  it("契約予定・契約完了・決済完了以外では何も出さない", () => {
    expect(render({ caseStatus: "on_sale", contractPlannedOn: "2026-11-15" })).toBe("");
    expect(render({ caseStatus: "new_case" })).toBe("");
  });

  it("入力欄は出さず、値(未定は「未定」)を見せるだけ", () => {
    const html = render({ caseStatus: "contract_planned", contractPlannedOn: "2026-11-15" });
    expect(html).not.toContain("<input");
    expect(html).toContain("契約予定日");
    expect(html).toContain("決済予定日");
    expect(html).toContain("2026/11/15");
    expect(html).toContain("未定");
  });

  it("見出しは進み具合で変わる(契約完了: 契約日/決済予定日・決済完了: 契約日/決済日)", () => {
    const html9 = render({ caseStatus: "contracted", contractPlannedOn: "2026-11-15" });
    expect(html9).toContain(">契約日<");
    expect(html9).toContain(">決済予定日<");
    const html10 = render({ caseStatus: "sold", contractPlannedOn: "2026-11-15", settlementPlannedOn: "2026-12-20" });
    expect(html10).toContain(">決済日<");
    expect(html10).toContain("2026/12/20");
  });

  it("取引があれば「取引の基本タブで入れる」、無ければ「取引を作ると入る」と添える", () => {
    expect(render({ caseStatus: "contract_planned", deals: [{ id: "d1" }] })).toContain("取引の基本タブで入れてください");
    expect(render({ caseStatus: "contract_planned", deals: [] })).toContain("取引を作ると、取引の契約日時・決済日時が入ります");
  });

  it("予定日を過ぎてまだ進んでいなければ琥珀色の知らせ・先なら「あと N 日」", () => {
    const over = render({ caseStatus: "contract_planned", contractPlannedOn: "2026-10-20" });
    expect(over).toContain("契約予定日を 3 日過ぎています");
    expect(over).toContain("amber");
    const soon = render({ caseStatus: "contracted", settlementPlannedOn: "2026-12-20" });
    expect(soon).toContain("決済まであと 58 日");
    expect(render({ caseStatus: "sold", contractPlannedOn: "2026-10-20", settlementPlannedOn: "2026-10-21" })).not.toContain("過ぎています");
  });
});
