import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UpcomingViewingsView } from "../upcoming-viewings";
import { InquiryListView } from "../inquiry-list";
import { InquiryDetailView } from "../inquiry-detail";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickDraft } from "@/lib/agent-inquiry/desk-form";

const property = {
  id: "p1", name: "サンライズ中野", roomNo: "305", town: "東京都中野区中野2丁目", propertyType: "apartment_unit", adPermissions: {},
};
const inquiry = {
  id: "i1", kind: "viewing" as const, status: "open" as const, channel: "phone" as const,
  receivedAt: "2026-09-30T07:20:00.000Z", version: 1,
  contactName: "田中", contactMobile: "090-1234-5678", contactEmail: null, note: null,
  assignee: { id: "u1", name: "佐藤" }, agent: { id: "a1", companyName: "○○不動産", branchName: null, phone: "03-1" },
  viewings: [
    { id: "v1", scheduledAt: "2026-10-02T05:00:00.000Z", viewingType: "guided" as const, canceledAt: null, resultNote: null, version: 1,
      attendant: { id: "u1", name: "佐藤" } },
    { id: "v2", scheduledAt: null, viewingType: "preview" as const, canceledAt: "2026-09-30T00:00:00.000Z", resultNote: "見送り", version: 2,
      attendant: null },
  ],
  property,
};
const noop = vi.fn();

describe("今日・明日の内見", () => {
  it("時刻・案内/下見・物件・業者・立ち会い", () => {
    const html = renderToStaticMarkup(
      <UpcomingViewingsView
        viewings={[{
          id: "v1", scheduledAt: "2026-10-02T05:00:00.000Z", viewingType: "guided", version: 1,
          attendant: { id: "u1", name: "佐藤" },
          inquiry: { id: "i1", contactName: "田中", agent: { companyName: "○○不動産" }, property },
        }]}
      />,
    );
    for (const t of ["今日・明日の内見", "10/2(金) 14:00", "案内", "サンライズ中野 305", "○○不動産", "立会 佐藤"]) {
      expect(html).toContain(t);
    }
  });
  it("0件なら「ありません」", () => {
    expect(renderToStaticMarkup(<UpcomingViewingsView viewings={[]} />)).toContain("ありません");
  });
});

describe("一覧", () => {
  it("3つのタブ(未対応に件数)・自分の担当だけ・1件の中身", () => {
    const html = renderToStaticMarkup(
      <InquiryListView tab="open" onTab={noop} mine={false} onMine={noop} items={[inquiry]} openCount={3}
        onOpen={noop} hasMore={false} onMore={noop} />,
    );
    for (const t of ["未対応 3", "対応中", "対応済み", "自分の担当だけ", "サンライズ中野 305", "○○不動産", "田中様", "内見", "担当:佐藤", "電話"]) {
      expect(html).toContain(t);
    }
    expect(html).toContain('aria-selected="true"');
  });
  it("続きがあれば「もっと見る」", () => {
    expect(
      renderToStaticMarkup(
        <InquiryListView tab="done" onTab={noop} mine onMine={noop} items={[]} openCount={0} onOpen={noop} hasMore onMore={noop} />,
      ),
    ).toContain("もっと見る");
  });
});

describe("詳細", () => {
  type P = Parameters<typeof InquiryDetailView>[0];
  const view = (over: Partial<P> = {}) =>
    renderToStaticMarkup(
      <InquiryDetailView inquiry={inquiry} canOpenProperty={false} users={[{ id: "u1", name: "佐藤" }]} busy={false} error={null}
        onStatus={noop} onAssignee={noop} onSaveNote={noop} onAddViewing={noop} onSaveViewing={noop} onClose={noop} {...over} />,
    );
  it("物件を開く権限が無ければ「メイン画面で物件を開く」を出さない", () => {
    expect(view()).not.toContain("メイン画面で物件を開く");
    const html = view({ canOpenProperty: true });
    expect(html).toContain("メイン画面で物件を開く");
    expect(html).toMatch(/href="\/properties\/p1"[^>]*target="pm-main"|target="pm-main"[^>]*href="\/properties\/p1"/);
  });
  it("状態・担当・メモ・内見(取り消し済みは印・結果・内見を足す)", () => {
    const html = view();
    for (const t of ["未対応", "対応中", "対応済み", "担当", "メモ", "10/2(金) 14:00", "日程調整中", "取り消し済み", "見送り", "内見を足す"]) {
      expect(html).toContain(t);
    }
  });
  it("409 などの文言を出し、入力を残したまま「読み直す」を選べる", () => {
    const html = view({ error: "他の人が先に更新しました。開き直してください。", onReload: noop });
    expect(html).toContain("他の人が先に更新しました");
    expect(html).toContain("読み直す");
  });
  it("問い合わせ者の携帯を出す(折り返し用)", () => {
    expect(view()).toContain("090-1234-5678");
  });
});

describe("詳細: 打ちかけの入力を消さない(最終レビュー I-1/I-2)", () => {
  const src = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-detail.tsx"), "utf8").replace(/\r\n/g, "\n");
  it("詳細と内見の行は反響/内見の id だけで作り直す(版が進んでも打ちかけが消えない)", () => {
    expect(src).not.toMatch(/key=\{`\$\{q\.id\}:\$\{q\.version\}`\}/);
    expect(src).not.toMatch(/key=\{`\$\{v\.id\}:\$\{v\.version\}`\}/);
    expect(src).toMatch(/<ViewingRow key=\{v\.id\}/);
  });
  it("立ち会いは選んだだけでは保存しない(日時・結果と同じ保存ボタンで)", () => {
    expect(src).not.toMatch(/onChange=\{\(e\) => onSave\(\{ attendantId/);
  });
  it("担当は画面の値ではなく最新の値に合わせて表示する(controlled)", () => {
    expect(src).not.toMatch(/defaultValue=\{q\.assignee/);
  });
  it("下書き: 触っていなければ最新の値・触っていれば下書き", () => {
    expect(pickDraft(null, "サーバ")).toBe("サーバ");
    expect(pickDraft("打ちかけ", "サーバ")).toBe("打ちかけ");
    expect(pickDraft("", "サーバ")).toBe("");
  });
});

describe("ボタンの中の個人情報にも画面保護(@codex #459 R4)", () => {
  it("一覧の行の問い合わせ者名は保護の印の中", () => {
    const html = renderToStaticMarkup(
      <InquiryListView tab="open" onTab={noop} mine={false} onMine={noop} items={[inquiry]} openCount={1}
        onOpen={noop} hasMore={false} onMore={noop} />,
    );
    expect(html).toMatch(/<span data-pii-protected="true" data-pii-surface="dashboard">\(田中様\)<\/span>/);
  });
});

describe("保存できたが読み直せなかったとき(@codex #459 R5)", () => {
  const detailSrc = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-detail.tsx"), "utf8").replace(/\r\n/g, "\n");
  it("知らせて、読み直すまで押せないようにする(内見の二重登録を防ぐ)", () => {
    expect(detailSrc).toContain("保存しましたが、最新の内容を読み込めませんでした");
    expect(detailSrc).toMatch(/busy=\{busy \|\| refreshFailed(?: \|\| !canWrite)?\}/);
  });
});

describe("読み直しにも失敗したら操作を止めたまま(@codex #459 R5 の続き)", () => {
  it("読み直しが成功したときだけ操作を戻す", () => {
    const s = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-detail.tsx"), "utf8").replace(/\r\n/g, "\n");
    expect(s).toMatch(/\.then\(\(\) => setRefreshFailed\(false\)\)/);
  });
});

describe("読み直した後の上書きは確かめてから・書き込みの失敗を「保存しました」と言わない(@codex #459 R6)", () => {
  const s = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-detail.tsx"), "utf8").replace(/\r\n/g, "\n");
  it("メモも内見の欄も、書き始めた後に他の人が変えていたら1回目の保存は止めて知らせる", () => {
    expect(s).toContain("他の人が先に変えています");
    expect(s.match(/draftStale\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
  it("保存に進んだら前の食い違いの知らせは消す", () => {
    expect(s).toMatch(/setNoteWarn\(null\);\s*onSaveNote\(note\)/);
    expect(s).toMatch(/setWarn\(null\);\s*onSave\(\{/);
  });
  it("「保存しましたが…」は書き込みが通ったときだけ", () => {
    expect(s).toContain('if (wrote) setError("保存しましたが');
  });
});

describe("詳細の小窓(ネイティブの dialog)の中にも透かし・保存中は閉じない(@codex #459 R8)", () => {
  const s = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-detail.tsx"), "utf8").replace(/\r\n/g, "\n");
  it("小窓の中に透かしを描く(小窓は最前面に出るので外の透かしが隠れる)", () => {
    expect(s).toContain("useScreenProtection()");
    expect(s).toMatch(/!bypass && watermarkText && <WatermarkOverlay text=\{watermarkText\} \/>/);
  });
  it("保存中は「閉じる」も Escape も効かない(書き込み中だけ・読み直しの失敗では閉じられる=閉じ込めない・@codex #459 R9)", () => {
    expect(s).toMatch(/onClose=\{closeLocked \? undefined : onClose\}/);
    expect(s).toMatch(/<Button variant="secondary" onClick=\{onClose\} disabled=\{closeLocked\}>/);
    expect(s).toMatch(/closeLocked=\{busy\}/);
    expect(s).toMatch(/busy=\{busy \|\| refreshFailed(?: \|\| !canWrite)?\}/);
  });
});

describe("書く権限が無いときの詳細(@codex #459 R12)", () => {
  it("canWrite=false なら変更ボタンを押せない", () => {
    const s = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-detail.tsx"), "utf8").replace(/\r\n/g, "\n");
    expect(s).toMatch(/busy=\{busy \|\| refreshFailed \|\| !canWrite\}/);
  });
});

describe("書けないときは入力欄も打てない(@codex #459 R13)", () => {
  it("詳細のメモ・内見の日時・結果は busy のあいだ読み取り専用", () => {
    const html = renderToStaticMarkup(
      <InquiryDetailView inquiry={inquiry} canOpenProperty={false} users={[]} busy error={null}
        onStatus={noop} onAssignee={noop} onSaveNote={noop} onAddViewing={noop} onSaveViewing={noop} onClose={noop} />,
    );
    const textareas = html.match(/<textarea[^>]*>/g) ?? [];
    expect(textareas.length).toBeGreaterThan(0);
    for (const t of textareas) expect(t).toMatch(/readonly/i);
    for (const i of html.match(/<input type="(?:date|time)"[^>]*>/g) ?? []) expect(i).toMatch(/readonly/i);
  });
});

describe("書けないときの文字は保護付きの文章で出す・読み直し中は操作を止める(@codex #459 R17)", () => {
  it("readOnlyText=true ならメモと結果は textarea ではなく保護の印付きの文章", () => {
    const html = renderToStaticMarkup(
      <InquiryDetailView inquiry={{ ...inquiry, note: "メールの本文" }} canOpenProperty={false} users={[]} busy error={null}
        onStatus={noop} onAssignee={noop} onSaveNote={noop} onAddViewing={noop} onSaveViewing={noop} onClose={noop} readOnlyText />,
    );
    expect(html).not.toContain("<textarea");
    expect(html).toMatch(/<p data-pii-protected="true" data-pii-surface="dashboard"[^>]*>メールの本文<\/p>/);
    expect(html).toMatch(/<p data-pii-protected="true" data-pii-surface="dashboard"[^>]*>見送り<\/p>/);
  });
  it("読み直しは古い応答で新しい内容を上書きしない・読み直し中は操作を止める", () => {
    const s = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-detail.tsx"), "utf8").replace(/\r\n/g, "\n");
    expect(s).toMatch(/loadSeqRef\.current !== seq/);
    expect(s).toMatch(/const reload = \(\) => \{[\s\S]{0,200}setBusy\(true\)/);
  });
});
