import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_DESK_FORM, deskFormReducer } from "@/lib/agent-inquiry/desk-form";
import { InquiryFormView } from "../inquiry-form";
import { AdPermissionChips } from "../ad-permission-chips";
import { AgentResults } from "../agent-picker";

const agent = {
  id: "a1", companyName: "○○不動産", branchName: "新宿店", phone: "03-1234-5678", matchedBy: "mobile" as const,
  lastContact: { name: "田中", mobile: "090-1234-5678", email: null },
};
const property = {
  id: "p1", name: "サンライズ中野", roomNo: "305", town: "東京都中野区中野2丁目", propertyType: "apartment_unit",
  adPermissions: { athome: "ok" as const, homes: "ng" as const, other_portal: "ask" as const },
};
type ViewProps = Parameters<typeof InquiryFormView>[0];
const view = (over: Partial<ViewProps> = {}) =>
  renderToStaticMarkup(
    <InquiryFormView
      state={EMPTY_DESK_FORM} dispatch={() => {}} users={[]} errors={{}} warning={null}
      submitting={false} message={null} saveError={null} onSubmit={() => {}} onCreateAgent={() => {}} {...over}
    />,
  );

describe("登録フォーム", () => {
  it("並び順=業者→問い合わせ者→物件→用件→入口→保存(方針12)", () => {
    const html = view();
    const idx = ["業者(代表電話・携帯・会社名)", "問い合わせ者", "物件(物件名・部屋・所在地)", "用件", "入口", "保存する"]
      .map((t) => html.indexOf(t));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
  it("内見のときだけ内見の予定が出て、案内/下見・日付・時刻・立ち会い", () => {
    expect(view()).not.toContain("内見の予定");
    const s = deskFormReducer(EMPTY_DESK_FORM, { type: "kind", value: "viewing" });
    const html = view({ state: s, users: [{ id: "u1", name: "佐藤" }] });
    for (const t of ["内見の予定", "案内(お客様連れ)", "下見(業者のみ)", 'type="date"', 'type="time"', "立ち会い", "佐藤"]) {
      expect(html).toContain(t);
    }
  });
  it("光る目印(data-guide)が各所にある", () => {
    const s = deskFormReducer(EMPTY_DESK_FORM, { type: "kind", value: "viewing" });
    const html = view({ state: s });
    for (const k of ["agent", "property", "kind", "viewingType", "save"]) expect(html).toContain(`data-guide="${k}"`);
  });
  it("「その場で回答した」チェックは無い(方針12)", () => {
    expect(view()).not.toContain("その場で回答");
  });
  it("保存中はボタンを押せない(二重登録を防ぐ)", () => {
    const html = view({ submitting: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-guide="save"|<button[^>]*data-guide="save"[^>]*disabled=""/);
    expect(html).toContain("保存中…");
  });
  it("保存の失敗は成功と見分けがつく(赤・role=alert)(最終レビュー M-1)", () => {
    const html = view({ saveError: "反響の受付の権限がありません" });
    expect(html).toMatch(/role="alert"[^>]*>[^<]*反響の受付の権限がありません|<p[^>]*role="alert"/);
    expect(html).toContain("text-rose");
    expect(view({ message: "登録しました" })).not.toContain('role="alert"');
  });
  it("エラーと資料請求のメール空の知らせ", () => {
    const html = view({ errors: { agent: "業者を選んでください" }, warning: "資料の送り先のメールが空です" });
    expect(html).toContain("業者を選んでください");
    expect(html).toContain("資料の送り先のメールが空です");
  });
  it("選んだ物件の名前・町名・広告の可否が出る", () => {
    const s = deskFormReducer(EMPTY_DESK_FORM, { type: "propertySelected", property });
    const html = view({ state: s });
    expect(html).toContain("サンライズ中野 305");
    expect(html).toContain("東京都中野区中野2丁目");
    expect(html).toContain("この物件の広告の可否");
  });
  it("携帯の桁が合わなければ知らせる(保存は止めない)", () => {
    const s = deskFormReducer(EMPTY_DESK_FORM, { type: "contact", field: "contactMobile", value: "0901" });
    expect(view({ state: s })).toContain("電話番号の桁をご確認ください(このままでも保存できます)");
  });
});

describe("広告の可否", () => {
  it("6媒体を ○×△/— で出す", () => {
    const html = renderToStaticMarkup(<AdPermissionChips value={property.adPermissions} />);
    for (const t of ["自社HP", "at home", "SUUMO", "HOME&#x27;S", "その他", "チラシ", "○", "×", "△", "—"]) expect(html).toContain(t);
  });
});

describe("業者の候補", () => {
  it("携帯で当たったら前回の問い合わせ者を出す", () => {
    const html = renderToStaticMarkup(<AgentResults hits={[agent]} onPick={vi.fn()} />);
    expect(html).toContain("○○不動産 新宿店");
    expect(html).toContain("代表 03-1234-5678");
    expect(html).toContain("前回 田中様");
  });
});

describe("業者の候補の前回の問い合わせ者名にも画面保護(@codex #459 R4)", () => {
  it("前回 ○○様 は保護の印の中", () => {
    const html = renderToStaticMarkup(<AgentResults hits={[agent]} onPick={vi.fn()} />);
    expect(html).toMatch(/<span data-pii-protected="true" data-pii-surface="dashboard">[^<]*前回 田中様<\/span>/);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
describe("新しい業者の登録中は閉じられない(@codex #459 R7)", () => {
  it("登録中は「やめる」も Escape も効かない(取り消したつもりで登録・二重登録を防ぐ)", () => {
    const s = readFileSync(join(process.cwd(), "src/components/agent-inquiry/agent-create-modal.tsx"), "utf8");
    expect(s).toMatch(/onClose=\{saving \? undefined : onClose\}/);
    expect(s).toMatch(/<Button variant="secondary" onClick=\{onClose\} disabled=\{saving\}>/);
  });
});

describe("保存中は入力できない(保存が終わって空に戻るときに消えないように・@codex #459 R11)", () => {
  it("保存中はフォームの中身をまとめて使えなくする", () => {
    expect(view({ submitting: true })).toMatch(/<fieldset[^>]*disabled=""/);
    expect(view({ submitting: false })).not.toMatch(/<fieldset[^>]*disabled=""/);
  });
});

describe("新しい業者の登録中は欄も打てない(@codex #459 R14)", () => {
  it("登録中は入力欄をまとめて使えなくする(登録後に消える直しを受け付けない)", () => {
    const s = readFileSync(join(process.cwd(), "src/components/agent-inquiry/agent-create-modal.tsx"), "utf8");
    expect(s).toMatch(/<fieldset disabled=\{saving\}/);
  });
});

describe("保存できたか分からないときは一覧を確かめさせる(@codex #459 R15)", () => {
  it("分からない失敗は二重登録にならないよう、一覧を読み直して確かめる文言を出す", () => {
    const s = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-form.tsx"), "utf8");
    expect(s).toContain("isAmbiguousSaveError(err)");
    expect(s).toContain("保存できたか分かりません");
  });
});

describe("業者の登録ができたか分からないとき(@codex #459 R16)", () => {
  it("分からない失敗は、名簿で探して確かめる文言を出す", () => {
    const s = readFileSync(join(process.cwd(), "src/components/agent-inquiry/agent-create-modal.tsx"), "utf8");
    expect(s).toContain("isAmbiguousSaveError(e)");
    expect(s).toContain("登録できたか分かりません");
  });
});

describe("Enter で勝手に保存しない", () => {
  it("フォームが Enter を受けて shouldBlockEnterSubmit で止める", () => {
    const src = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-form.tsx"), "utf8");
    expect(src).toMatch(/onKeyDown=\{\(e\) => \{[\s\S]{0,300}shouldBlockEnterSubmit\(/);
    expect(src).toMatch(/if \(shouldBlockEnterSubmit\([\s\S]{0,200}\)\) e\.preventDefault\(\);/);
  });
});

describe("日時の片方だけ", () => {
  it("日時の片方だけのエラーを日時の欄の下に出す", () => {
    let s = deskFormReducer(EMPTY_DESK_FORM, { type: "kind", value: "viewing" });
    s = deskFormReducer(s, { type: "viewing", field: "date", value: "2026-10-05" });
    expect(view({ state: s, errors: { viewingAt: "日付と時刻の両方を入れてください(両方とも空なら日程調整中で保存できます)" } }))
      .toContain("日付と時刻の両方を入れてください");
  });
});

describe("切り替えボタンの読み上げ", () => {
  it("用件・案内/下見・入口の切り替えは押している方を aria-pressed で伝える", () => {
    let s = deskFormReducer(EMPTY_DESK_FORM, { type: "kind", value: "viewing" });
    s = deskFormReducer(s, { type: "viewing", field: "viewingType", value: "guided" });
    const html = view({ state: s });
    expect(html).toMatch(/aria-pressed="true"[^>]*>内見</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>資料請求</);
    expect(html).toMatch(/aria-pressed="true"[^>]*>案内\(お客様連れ\)</);
    expect(html).toMatch(/aria-pressed="true"[^>]*>電話</);
    expect((html.match(/aria-pressed=/g) ?? []).length).toBe(8);
  });
});

describe("押し直しの鍵(二重登録を防ぐ)", () => {
  const src = () => readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-form.tsx"), "utf8");
  const modal = () => readFileSync(join(process.cwd(), "src/components/agent-inquiry/agent-create-modal.tsx"), "utf8");
  it("反響の登録は鍵を付けて送り、分からないときはそのまま押してよいと伝える", () => {
    expect(src()).toContain("tokenForSubmit(tokenRef.current, state, safeUuidV4)");
    expect(src()).toContain("clientToken: t.token");
    expect(src()).toContain("中身を変えずにそのまま「保存する」を押してください(二重には登録されません)");
  });
  it("業者の登録も同じ", () => {
    expect(modal()).toContain("tokenForSubmit(tokenRef.current, v, safeUuidV4)");
    expect(modal()).toContain("clientToken: t.token");
    expect(modal()).toContain("中身を変えずにそのまま「登録して戻る」を押してください(二重には登録されません)");
  });
});

describe("鍵は UUID の形で作る・小窓の欄は同じ値なら同じ状態", () => {
  it("反響・業者の登録の鍵は safeUuidV4(平文 HTTP でも UUID の形)", () => {
    const form = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-form.tsx"), "utf8");
    const modal = readFileSync(join(process.cwd(), "src/components/agent-inquiry/agent-create-modal.tsx"), "utf8");
    expect(form).toContain("tokenForSubmit(tokenRef.current, state, safeUuidV4)");
    expect(modal).toContain("tokenForSubmit(tokenRef.current, v, safeUuidV4)");
    expect(modal).toContain("setV((p) => setFieldIfChanged(p, k, val))");
  });
});
