import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDetail, AgentHistoryItem } from "@/lib/api-client";
import { AgentInfoFields, AgentHistoryList, agentSaveErrorMessage } from "../agent-detail";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const agent: AgentDetail = {
  id: "a1", companyName: "○○不動産", companyKana: null, branchName: "新宿支店", licenseNo: "東京都知事(3)第12345号",
  phone: "03-1234-5678", fax: null, email: null, address: null, note: "午前は不在", isArchived: false, version: 4,
};
const fields = (p: Partial<Parameters<typeof AgentInfoFields>[0]> = {}) =>
  renderToStaticMarkup(
    <AgentInfoFields agent={agent} edits={{}} canWrite saving={false} onEdit={() => {}} onBlurPhone={() => {}} {...p} />,
  );

describe("業者の詳細の会社情報", () => {
  it("書ける人には9つの欄を入力できる形で出す", () => {
    const out = fields();
    expect((out.match(/<input/g) ?? []).length + (out.match(/<textarea/g) ?? []).length).toBe(9);
    expect(out).toContain('value="○○不動産"');
    expect(out).toContain("午前は不在");
  });
  it("触った欄は打ちかけの値を出す(読み直しても消えない)", () => {
    expect(fields({ edits: { branchName: "渋谷支店" } })).toContain('value="渋谷支店"');
  });
  it("★書けない人には入力欄を出さず、文字で見せる", () => {
    const out = fields({ canWrite: false });
    expect(out).not.toMatch(/<input|<textarea/);
    expect(out).toContain("○○不動産");
    expect(out).toContain("東京都知事(3)第12345号");
  });
  it("保存中は欄を止める(保存は押したときの値で進む)", () => {
    expect(fields({ saving: true })).toMatch(/<fieldset[^>]*disabled=""/);
  });
  it("電話の桁がおかしければ黄色で知らせる(保存は止めない)", () => {
    expect(fields({ edits: { phone: "03-12" } })).toContain("電話番号の桁をご確認ください(このままでも保存できます)");
  });
});

describe("その業者からの反響", () => {
  const items: AgentHistoryItem[] = [
    { id: "q1", kind: "viewing", status: "done", receivedAt: "2026-09-29T01:00:00.000Z", contactName: "田中", property: { id: "p1", name: "サンライズ", roomNo: "305", town: "新宿区西新宿", propertyType: "unit", adPermissions: {} } },
  ];
  it("年つきの日時・用件・状態・物件(部屋まで)・町名・問い合わせ者", () => {
    const out = renderToStaticMarkup(<AgentHistoryList items={items} />);
    expect(out).toContain("2026/9/29(火) 10:00");
    expect(out).toContain("内見");
    expect(out).toContain("対応済み");
    expect(out).toContain("サンライズ 305");
    expect(out).toContain("新宿区西新宿");
    expect(out).toContain("田中様");
  });
  it("物件名が無い物件(名前=町名)は、同じ文字を2回出さない", () => {
    const land: AgentHistoryItem = { ...items[0], id: "q2", property: { id: "p2", name: "埼玉県さいたま市大宮区桜木町", roomNo: null, town: "埼玉県さいたま市大宮区桜木町", propertyType: "land", adPermissions: {} } };
    const out = renderToStaticMarkup(<AgentHistoryList items={[land]} />);
    expect(out.split("埼玉県さいたま市大宮区桜木町").length - 1).toBe(1);
  });
  it("0件のとき", () => {
    expect(renderToStaticMarkup(<AgentHistoryList items={[]} />)).toContain("この業者からの反響はまだありません");
  });
});

describe("保存の失敗の文言", () => {
  const err = (code: string, status: number) => Object.assign(new Error("x"), { code, status });
  it("409・403・入力の誤り・通信切れを言い分ける", () => {
    expect(agentSaveErrorMessage(err("VERSION_CONFLICT", 409))).toBe("他の人が先に更新しました。最新の内容を読み直しました。内容を確かめて、もう一度保存してください。");
    expect(agentSaveErrorMessage(err("FORBIDDEN", 403))).toBe("業者を変更する権限がありません。");
    expect(agentSaveErrorMessage(err("VALIDATION_ERROR", 422))).toBe("入力を確かめてください(メールの形式・文字数など)。");
    expect(agentSaveErrorMessage(new Error("Failed to fetch"))).toBe("保存できたか分かりません(通信が切れました)。最新の内容を読み直しました。変わっていれば押し直さないでください。");
  });
});

describe("詳細の画面", () => {
  const page = () => read("src/app/(dashboard)/agents/[id]/page.tsx");
  it("業者ごとに作り直す(前の業者の打ちかけを持ち越さない)", () => {
    expect(page()).toMatch(/<AgentDetailBody key=\{id\} id=\{id\} \/>/);
  });
  it("★保存で送るのは触った欄だけ・版番号つき", () => {
    expect(page()).toContain("agentEditPatch(agent, edits)");
    expect(page()).toMatch(/send\(\{ version: agent\.version, \.\.\.patch \}/);
    expect(page()).toContain("updateAgent(agent.id, body)");
  });
  it("結果の知らせは、読み直しが済んでから出す(「保存しました」と古い表示・保存中が同時に出ない)", () => {
    const src = page();
    const at = src.indexOf("const send = async");
    const body = src.slice(at, src.indexOf("const save = ", at));
    expect(body.indexOf("await load()")).toBeGreaterThan(-1);
    expect(body.lastIndexOf("setNotice(")).toBeGreaterThan(body.indexOf("await load()"));
    expect(body.slice(0, body.indexOf("await load()"))).not.toMatch(/setNotice\(\{/);
  });
  it("しまう前に確かめ、戻すのは1回で", () => {
    expect(page()).toContain("<ConfirmDialog");
    expect(page()).toContain("名簿に戻す");
  });
  it("書く操作(保存・しまう・戻す)は書ける人にだけ出す", () => {
    expect(page()).toMatch(/\{canWrite && \(/);
  });
  it("名簿へ戻る導線", () => {
    expect(page()).toMatch(/back=\{\{ href: "\/agents", to: "業者の名簿" \}\}/);
  });
  it("権限表を自分で読まない", () => {
    expect(page()).not.toContain("useScreenProtection");
  });
});
