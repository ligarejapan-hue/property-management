/**
 * 問い合わせ者・除外申請の画面部品(2026-10-24 従業員の指摘 第2弾)。
 * ⚠vitest は env=node(jsdom 無し)。見た目は renderToStaticMarkup、配線は画面のソースの文字列で確かめる。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { InquirerOrOwnerNames, LeadExclusionListBadge } from "../property-list-cells";
import InquirerNameField from "../inquirer-name-field";
import LeadExclusionField, { type LeadExclusionProperty } from "../lead-exclusion-field";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

describe("InquirerOrOwnerNames(一覧の 問い合わせ者／所有者)", () => {
  it("問い合わせ者があればそれだけ・札「問合せ」・owner の面で囲む", () => {
    const html = renderToStaticMarkup(<InquirerOrOwnerNames inquirerName="山田花子" ownerNames={["山田太郎"]} />);
    expect(html).toContain("問合せ");
    expect(html).toContain("山田花子");
    expect(html).not.toContain("山田太郎");
    expect(html).toContain("data-pii-protected");
    expect(html).toContain('data-pii-surface="owner"');
  });
  it("無ければ所有者(札「所有者」・複数は「、」)", () => {
    const html = renderToStaticMarkup(<InquirerOrOwnerNames inquirerName={null} ownerNames={["A", "B"]} />);
    expect(html).toContain("所有者");
    expect(html).toContain("A、B");
  });
  it("どちらも無ければ —(札なし)", () => {
    const html = renderToStaticMarkup(<InquirerOrOwnerNames inquirerName={undefined} ownerNames={[]} />);
    expect(html).toContain("—");
    expect(html).not.toContain("問合せ");
    expect(html).toContain('data-pii-surface="owner"');
  });
});

describe("LeadExclusionListBadge(一覧の札)", () => {
  const today = "2026-10-24";
  it("6日=琥珀(warning)・7日=赤(error)で「運営に確認」", () => {
    const six = renderToStaticMarkup(<LeadExclusionListBadge status="requested" requestedOn="2026-10-18" today={today} />);
    expect(six).toContain("除外申請中 6日");
    expect(six).not.toContain("運営に確認");
    expect(six).toContain("amber");
    const seven = renderToStaticMarkup(<LeadExclusionListBadge status="requested" requestedOn="2026-10-17" today={today} />);
    expect(seven).toContain("除外申請中 7日・運営に確認");
    expect(seven).toContain("red");
  });
  it("除外済・除外不可・なし", () => {
    expect(renderToStaticMarkup(<LeadExclusionListBadge status="approved" requestedOn={null} today={today} />)).toContain("除外済");
    expect(renderToStaticMarkup(<LeadExclusionListBadge status="rejected" requestedOn={null} today={today} />)).toContain("除外不可");
    expect(renderToStaticMarkup(<LeadExclusionListBadge status={null} requestedOn={null} today={today} />)).toBe("");
  });
});

describe("InquirerNameField(物件詳細)", () => {
  it("API が返さない(owner:read なし)なら行ごと出さない", () => {
    expect(renderToStaticMarkup(<InquirerNameField value={undefined} />)).toBe("");
  });
  it("値は owner の面で囲む・空は —", () => {
    const html = renderToStaticMarkup(<InquirerNameField value="山田花子" />);
    expect(html).toContain("問い合わせ者");
    expect(html).toContain("山田花子");
    expect(html).toContain('data-pii-surface="owner"');
    expect(renderToStaticMarkup(<InquirerNameField value={null} />)).toContain("—");
  });
});

describe("LeadExclusionField(物件詳細の 除外申請)", () => {
  const base: LeadExclusionProperty = {
    id: "p1",
    version: 3,
    introductionRoute: "bulk_assessment",
    leadExclusionStatus: null,
    leadExclusionRequestedAt: null,
    leadExclusionDecidedAt: null,
  };
  const render = (p: Partial<LeadExclusionProperty>, opts: { canWrite?: boolean; editLockHeld?: boolean } = {}) =>
    renderToStaticMarkup(
      <LeadExclusionField
        property={{ ...base, ...p }}
        onRefresh={() => {}}
        canWrite={opts.canWrite ?? true}
        editLockHeld={opts.editLockHeld ?? false}
        today="2026-10-24"
      />,
    );

  it("一括査定の物件: 申請していない・申請した日の既定は今日・「申請中にする」", () => {
    const html = render({});
    expect(html).toContain("除外申請");
    expect(html).toContain("申請していません");
    expect(html).toContain('value="2026-10-24"');
    expect(html).toContain("申請中にする");
    expect(html).not.toContain("除外された</button>");
  });

  it("一括査定以外で状態なし: 書ける人には小さなリンクだけ・書けない人には何も出さない", () => {
    const html = render({ introductionRoute: "web_inquiry" });
    expect(html).toContain("除外申請を記録する");
    expect(html).not.toContain("申請中にする");
    expect(render({ introductionRoute: null }, { canWrite: false })).toBe("");
  });

  it("申請中: N日の札・結果の操作(除外された/認められなかった/取り消す)", () => {
    const html = render({ introductionRoute: null, leadExclusionStatus: "requested", leadExclusionRequestedAt: "2026-10-16" });
    expect(html).toContain("除外申請中 8日・運営に確認");
    expect(html).toContain("申請した日を直す");
    expect(html).toContain("除外された");
    expect(html).toContain("認められなかった");
    expect(html).toContain("取り消す");
    expect(html).toContain('value="2026-10-16"');
  });

  it("書けない人には操作を出さない(状態だけ)", () => {
    const html = render({ leadExclusionStatus: "approved", leadExclusionRequestedAt: "2026-10-10", leadExclusionDecidedAt: "2026-10-20" }, { canWrite: false });
    expect(html).toContain("除外された");
    expect(html).toContain("2026/10/20");
    expect(html).not.toContain("<button");
    expect(html).not.toContain('type="date"');
  });

  it("他の人の鍵のときは止める", () => {
    expect(render({ leadExclusionStatus: "requested" }, { editLockHeld: true })).toContain("disabled");
  });
});

describe("画面の配線(ソース)", () => {
  const list = src("src/app/(dashboard)/properties/page.tsx");

  it("一覧: 見出しは「問い合わせ者／所有者」・表とカードの両方で部品/判定を使う", () => {
    expect(list).toContain("問い合わせ者／所有者");
    expect(list).toContain("<InquirerOrOwnerNames");
    expect(list).toContain("ownerColumnDisplay(property.inquirerName, property.ownerNames)");
    expect(list.match(/<LeadExclusionListBadge/g)?.length).toBe(2);
  });

  it("一覧: 除外申請の絞り込みは並行する一覧(状態・URL・API・リセット・件数・初期の開閉)すべてに入っている", () => {
    expect(list).toContain('sp.get("leadExclusion")');
    expect(list.match(/sp\.get\("leadExclusion"\)/g)?.length).toBe(2); // 初期値+詳細条件を開くか
    expect(list).toContain("params.leadExclusion = leadExclusionFilter");
    expect(list).toContain('params.set("leadExclusion", leadExclusionFilter)');
    expect(list).toContain('setLeadExclusionFilter("")');
    expect(list).toContain("!!leadExclusionFilter");
    // activeFilterCount・advancedFilterCount・buildFilterParams と URL 同期の依存配列の4つ
    expect(list.match(/introductionRouteFilter, leadExclusionFilter,/g)?.length).toBe(4);
    // buildFilterParams と URL 同期の依存配列
    expect(list.match(/caseFilter, introductionRouteFilter, leadExclusionFilter, assigneeFilter/g)?.length).toBe(2);
    expect(list).toContain("LEAD_EXCLUSION_FILTER_OPTIONS");
  });

  it("取込: 貼り付け画面は申込者の氏名を問い合わせ者として送る", () => {
    expect(src("src/app/(dashboard)/import/paste/page.tsx")).toContain("inquirerName: draft.applicantName?.trim() || null");
  });

  it("詳細: 問い合わせ者の欄・除外申請の欄・編集の小窓には書ける人だけ問い合わせ者の欄", () => {
    const detail = src("src/app/(dashboard)/properties/[id]/page.tsx");
    expect(detail).toContain("<InquirerNameField value={property.inquirerName} />");
    expect(detail).toContain("<LeadExclusionField");
    expect(detail).toContain("canEditInquirer={canReadOwner && canWriteOwnerName && property.inquirerName !== undefined}");
    const form = src("src/components/properties/property-edit-form.tsx");
    expect(form).toContain('FORM_FIELDS.filter((f) => f.key !== "inquirerName" || canEditInquirer)');
  });
});
