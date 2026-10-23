/**
 * 契約予定日・決済予定日の欄(物件詳細・案件ステータスのすぐ下)。
 * ⚠vitest は env=node(jsdom 無し)。見た目は renderToStaticMarkup で検査し、
 *   入力→保存の遷移は purely な決まり(src/lib/case-dates.ts)のテストで担保する。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import CaseDatesField from "../case-dates-field";

const base = { id: "p1", version: 3, contractPlannedOn: null as string | null, settlementPlannedOn: null as string | null };
const render = (
  property: Partial<typeof base> & { caseStatus: string },
  opts: { canWrite?: boolean; editLockHeld?: boolean; today?: string } = {},
) =>
  renderToStaticMarkup(
    <CaseDatesField
      property={{ ...base, ...property }}
      onRefresh={() => {}}
      canWrite={opts.canWrite ?? true}
      editLockHeld={opts.editLockHeld ?? false}
      today={opts.today ?? "2026-10-23"}
    />,
  );

describe("CaseDatesField(契約予定日・決済予定日)", () => {
  it("契約予定・契約完了・決済完了以外では何も出さない", () => {
    expect(render({ caseStatus: "on_sale", contractPlannedOn: "2026-11-15" })).toBe("");
    expect(render({ caseStatus: "new_case" })).toBe("");
  });

  it("契約予定: 2つの日付の入力欄と「未定なら空のまま」の添え書き", () => {
    const html = render({ caseStatus: "contract_planned" });
    expect(html).toContain("契約予定日");
    expect(html).toContain("決済予定日");
    expect(html).toContain('type="date"');
    expect(html).toContain('aria-label="契約予定日"');
    expect(html).toContain('aria-label="決済予定日"');
    expect(html).toContain("未定なら空のまま");
  });

  it("契約完了: 見出しが契約日/決済予定日・決済完了: 契約日/決済日(値は同じ2欄)", () => {
    const html9 = render({ caseStatus: "contracted", contractPlannedOn: "2026-11-15" });
    expect(html9).toContain('aria-label="契約日"');
    expect(html9).toContain('aria-label="決済予定日"');
    expect(html9).toContain('value="2026-11-15"');
    const html10 = render({ caseStatus: "sold", contractPlannedOn: "2026-11-15", settlementPlannedOn: "2026-12-20" });
    expect(html10).toContain('aria-label="契約日"');
    expect(html10).toContain('aria-label="決済日"');
    expect(html10).toContain('value="2026-12-20"');
  });

  it("書けない人には入力欄でなく値(未定は「未定」)を出す", () => {
    const html = render({ caseStatus: "contract_planned", contractPlannedOn: "2026-11-15" }, { canWrite: false });
    expect(html).not.toContain('type="date"');
    expect(html).toContain("2026/11/15");
    expect(html).toContain("未定");
  });

  it("他の人の鍵のときは入力欄を止める(案件ステータスのプルダウンと同じ)", () => {
    const html = render({ caseStatus: "contract_planned" }, { editLockHeld: true });
    expect(html).toContain("disabled");
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
