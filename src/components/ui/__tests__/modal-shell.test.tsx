/**
 * モーダルの器 (UI一貫性 第3弾 ⑪・発注者承認 2026-08-23)。
 *
 * 背景: 26箇所のモーダルが器を各自コピーしており、overlay の濃さ(40/50/70)と
 * フッタ間隔(gap-2/3)が揺れていた(実測)。以後の新モーダルはこの器を使う。
 * 規約: overlay=bg-black/50 p-4 / カード=rounded-lg p-6 shadow-xl /
 *       フッタ=justify-end gap-2 / role="dialog" aria-modal。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModalShell } from "../modal-shell";
import { ConfirmDialog } from "../confirm-dialog";

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("ModalShell", () => {
  it("器はネイティブ <dialog>(showModal=閉じ込め/初期フォーカス/復帰が標準・@codex #406 R2 P2)", () => {
    const html = render(
      <ModalShell title="題" footer={<button type="button">閉</button>} />,
    );
    expect(html).toMatch(/^<dialog /);
    expect(html).toContain("backdrop:bg-black/50");
    expect(html).toContain("rounded-lg");
    expect(html).toContain("shadow-xl");
    expect(html).toContain("dark:bg-gray-900");
    // 旧・div 方式の overlay は残っていない
    expect(html).not.toContain("fixed inset-0");
  });

  it("showModal で開く+Escape は onClose 無指定なら無効化(状態の食い違い防止)をソースで固定", () => {
    const src = readFileSync(
      join(process.cwd(), "src", "components", "ui", "modal-shell.tsx"),
      "utf8",
    );
    expect(src).toContain("dialog.showModal()");
    expect(src).toContain("onCancel={(e) => {");
    expect(src).toContain("else e.preventDefault();");
    // ⚠キャンセル→親の条件描画で即アンマウントの経路では native の復帰が
    //   走らないため、開く前のフォーカス元へ手動で戻す(@codex #406 R4 P2)。
    expect(src).toContain("document.activeElement instanceof HTMLElement");
    expect(src).toContain("if (opener?.isConnected) opener.focus();");
  });

  it("dialog は見出しと aria-labelledby で紐付く=名前を持つ(@codex #406 R1 P2)", () => {
    const html = render(<ModalShell title="題" footer={<span>F</span>} />);
    const m = html.match(/aria-labelledby="([^"]+)"/);
    expect(m).not.toBeNull();
    expect(html).toContain(`<h2 id="${m![1]}"`);
  });

  it("ConfirmDialog は busy 中 Escape も無効(onClose=undefined)をソースで固定", () => {
    const src = readFileSync(
      join(process.cwd(), "src", "components", "ui", "confirm-dialog.tsx"),
      "utf8",
    );
    expect(src).toContain("onClose={busy ? undefined : onCancel}");
  });

  it("フッタは justify-end gap-2 に固定(gap-3 揺れの再発防止)", () => {
    const html = render(<ModalShell title="題" footer={<span>F</span>} />);
    expect(html).toContain("flex justify-end gap-2");
    expect(html).not.toContain("gap-3");
  });

  it("size で幅が変わる(sm/md/lg)", () => {
    expect(render(<ModalShell size="sm" title="t" footer={<i />} />)).toContain("max-w-sm");
    expect(render(<ModalShell title="t" footer={<i />} />)).toContain("max-w-md");
    expect(render(<ModalShell size="lg" title="t" footer={<i />} />)).toContain("max-w-lg");
  });

  it("本文(children)は省略できる(確認だけのダイアログ)", () => {
    const html = render(<ModalShell title="t" footer={<i />} />);
    expect(html).toContain("<h2");
  });
});

describe("ConfirmDialog", () => {
  it("既定: メッセージ「この操作は取り消せません。」+キャンセル/削除(danger)", () => {
    const html = render(
      <ConfirmDialog title="写真を削除しますか？" onCancel={() => {}} onConfirm={() => {}} />,
    );
    expect(html).toContain("写真を削除しますか？");
    expect(html).toContain("この操作は取り消せません。");
    expect(html).toContain("キャンセル");
    expect(html).toContain("削除");
    expect(html).toContain("bg-red-600");
  });

  it("busy 中は両ボタンとも押せない(削除の途中で閉じて状態を迷子にしない)", () => {
    const html = render(
      <ConfirmDialog title="t" busy onCancel={() => {}} onConfirm={() => {}} />,
    );
    const btns = html.match(/<button[^>]*>/g) ?? [];
    expect(btns).toHaveLength(2);
    expect(btns[0]).toContain('disabled=""');
    expect(btns[1]).toContain('disabled=""');
  });

  it("confirmLabel・message を差し替えられる", () => {
    const html = render(
      <ConfirmDialog
        title="テンプレート削除"
        message="「A」を削除しますか？この操作は取り消せません。"
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(html).toContain("「A」を削除しますか？");
  });
});
