import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/lib/api-client", () => ({ fetchMaterialCandidates: vi.fn(), fetchMaterialSends: vi.fn(), sendMaterial: vi.fn(), applyMaterialSends: vi.fn() }));
vi.mock("@/components/ui/modal-shell", () => ({
  ModalShell: ({ title, children, footer }: { title: string; children: React.ReactNode; footer: React.ReactNode }) => (
    <div data-title={title}>
      {children}
      {footer}
    </div>
  ),
}));
import { MaterialSendDialogView, MaterialSendHistoryView } from "../material-send-dialog";
import type { MaterialCandidates, MaterialSendView } from "@/lib/api-client";

const MB = 1024 * 1024;
const WARN = "所有者の名前・住所が載っています。送ってよい相手か確かめてください";
const cand = (o: Partial<MaterialCandidates> = {}): MaterialCandidates => ({
  mailConfigured: true, to: "sato@agent.jp", subject: "【資料送付】サンプル荘", body: "本文", maxTotalBytes: 20 * MB, maxFiles: 20,
  files: [
    { id: "a1", fileName: "図面.pdf", fileSize: 2 * MB, type: "general", createdAt: "2026-10-01T00:00:00Z", warning: null },
    { id: "a2", fileName: "謄本.pdf", fileSize: 1 * MB, type: "registry", createdAt: "2026-10-01T00:00:00Z", warning: WARN },
  ],
  ...o,
});
const noop = () => {};
const view = (o: Partial<Parameters<typeof MaterialSendDialogView>[0]> = {}) =>
  renderToStaticMarkup(
    <MaterialSendDialogView
      c={cand()}
      loadError={null}
      to="sato@agent.jp"
      subject="件名"
      body="本文"
      picked={[]}
      busy={false}
      error={null}
      hidden={false}
      onTo={noop}
      onSubject={noop}
      onBody={noop}
      onToggle={noop}
      onSend={noop}
      onHide={noop}
      onCancel={noop}
      {...o}
    />,
  );
const sendButton = (html: string) => html.match(/<button[^>]*>送信<\/button>/)?.[0] ?? "";

describe("資料を送る小窓(表示)", () => {
  it("1つも選ばないと送信ボタンが押せない", () => {
    expect(sendButton(view())).toContain('disabled=""');
  });
  it("選べば押せる・宛先と文面が入っている", () => {
    const html = view({ picked: ["a1"] });
    expect(sendButton(html)).not.toContain('disabled=""');
    expect(html).toContain('value="sato@agent.jp"');
    expect(html).toContain("図面.pdf");
  });
  it("謄本を選ぶと黄色の注意", () => {
    expect(view({ picked: ["a2"] })).toContain(WARN);
    expect(view({ picked: ["a1"] })).not.toContain(WARN);
  });
  it("20MB を超えると知らせて押せない", () => {
    const c = cand({ files: [
      { id: "b1", fileName: "大.pdf", fileSize: 15 * MB, type: "general", createdAt: "x", warning: null },
      { id: "b2", fileName: "大2.pdf", fileSize: 6 * MB, type: "general", createdAt: "x", warning: null },
    ] });
    const html = view({ c, picked: ["b1", "b2"] });
    expect(html).toContain("20MB を超えています");
    expect(sendButton(html)).toContain('disabled=""');
  });
  it("メール設定が無ければ案内(メール設定へのリンク)", () => {
    const html = view({ c: cand({ mailConfigured: false }), picked: ["a1"] });
    expect(html).toContain("管理画面のメール設定が必要です");
    expect(html).toContain('href="/admin/mail-settings"');
    expect(sendButton(html)).toContain('disabled=""');
  });
  it("添付が無ければ資料一覧への案内", () => {
    expect(view({ c: cand({ files: [] }) })).toContain("資料一覧にファイルがありません");
  });
  it("失敗のメッセージは alert で出す", () => {
    expect(view({ picked: ["a1"], error: "送れませんでした" })).toMatch(/role="alert"[^>]*>送れませんでした/);
  });
  it("隠しているあいだは何も描かない(×=入力は親の状態に残る)", () => {
    expect(view({ hidden: true })).toBe("");
  });
  it("読み込み中・読み込み失敗", () => {
    expect(view({ c: null })).toContain("読み込み中");
    expect(view({ c: null, loadError: "読み込めませんでした" })).toContain("読み込めませんでした");
  });
});

describe("送った記録(表示)", () => {
  const item = (o: Partial<MaterialSendView> = {}): MaterialSendView => ({
    id: "s1", createdAt: "2026-10-18T05:05:00Z", result: "sent", state: "送信済み", sentBy: { name: "山田" },
    toAddress: "sato@agent.jp", subject: "件名A", body: "本文A",
    attachments: [{ attachmentId: "a1", fileName: "図面.pdf", fileSize: 2 * MB, type: "general" }], totalSize: 2 * MB, errorCode: null,
    ...o,
  });
  it("記録が無ければ何も出さない", () => {
    expect(renderToStaticMarkup(<MaterialSendHistoryView items={[]} openId={null} onToggle={noop} />)).toBe("");
  });
  it("日時・送った人・宛先・ファイル数・状態を出す(日本時間)", () => {
    const html = renderToStaticMarkup(<MaterialSendHistoryView items={[item()]} openId={null} onToggle={noop} />);
    expect(html).toContain("14:05");
    expect(html).toContain("山田");
    expect(html).toContain("1ファイル");
    expect(html).toContain("送信済み");
    expect(html).not.toContain("本文A");
  });
  it("開いた行は件名・本文・ファイル名を出す", () => {
    const html = renderToStaticMarkup(<MaterialSendHistoryView items={[item()]} openId="s1" onToggle={noop} />);
    expect(html).toContain("件名A");
    expect(html).toContain("本文A");
    expect(html).toContain("図面.pdf");
  });
});

describe("押し直しの鍵(@codex P1)", () => {
  it("平文 HTTP でも動く safeUuidV4 を使い、crypto.randomUUID を直に呼ばない", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/agent-inquiry/material-send-dialog.tsx", "utf8");
    expect(src).not.toContain("crypto.randomUUID");
    expect(src.match(/safeUuidV4\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("送れたのに反響へ反映できていない記録(@codex 2巡目 P2)", () => {
  it("記録の一覧が needsApply を返したら、反映し直しの口を呼び、親に知らせて読み直させる", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/agent-inquiry/material-send-dialog.tsx", "utf8");
    const hist = src.slice(src.indexOf("export function MaterialSendHistory("));
    expect(hist).toMatch(/d\.needsApply/);
    expect(hist).toMatch(/applyMaterialSends\(inquiryId\)/);
    expect(hist).toMatch(/onApplied\?\.\(\)/);
    const detail = readFileSync("src/components/agent-inquiry/inquiry-detail.tsx", "utf8");
    expect(detail).toMatch(/<MaterialSendHistory[^>]*onApplied=\{/);
    const client = readFileSync("src/lib/api-client.ts", "utf8");
    expect(client).toMatch(/material-sends\/apply`, \{ method: "POST"/);
  });
});
