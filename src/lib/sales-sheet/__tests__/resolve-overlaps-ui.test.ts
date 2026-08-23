/**
 * B-8 案A の画面側 source assertion。
 *
 * 核心の約束=**勝手には一切動かさない**(案Aが見送られていた理由への回答)。
 * 自動修正はボタンを押したときにだけ走り、結果は履歴に乗る(Ctrl+Zで戻せる)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const EDITOR = read("src/components/sales-sheet/editor/SalesSheetEditor.tsx");
const TOOLBAR = read("src/components/sales-sheet/editor/EditorToolbar.tsx");

describe("重なりの自動修正はボタン式(B-8 案A)", () => {
  it("警告の隣に「重なりを自動で直す」ボタンがある", () => {
    expect(TOOLBAR).toContain("重なりを自動で直す");
    expect(TOOLBAR).toContain("data-toolbar-auto-fix-overlaps");
    // 警告(layoutWarning)がある時だけ描画される構造 = 警告の <p> の中にある。
    const warnAt = TOOLBAR.indexOf("data-toolbar-layout-warning");
    const btnAt = TOOLBAR.indexOf("data-toolbar-auto-fix-overlaps");
    expect(warnAt).toBeGreaterThan(-1);
    expect(btnAt).toBeGreaterThan(warnAt);
  });

  it("⚠適用は履歴経由(setEditorState=dispatch edit)=「元に戻す」で戻せる", () => {
    // R1 P2 対応で「表示用に計算した結果の document をそのまま積む」形になった
    // (通知の紐付け先と画面の document を同一参照にするため)。
    // 競合時(理論上)のフォールバックは resolveOverlapsInState。
    // ⚠同名の setEditorState は他にも多数あるので**ハンドラの中**で探す
    //   (ファイル先頭からの indexOf は別の呼び出しを掴む=実際に一度掴んだ)。
    const handlerAt = EDITOR.indexOf("const handleAutoFixOverlaps");
    expect(handlerAt).toBeGreaterThan(-1);
    const handler = EDITOR.slice(handlerAt, handlerAt + 2200);
    expect(handler).toContain("setEditorState((prev) =>");
    expect(handler).toContain("document: r.document, dirty: true");
    expect(handler).toContain("resolveOverlapsInState(prev)");
  });

  it("⚠勝手には動かさない=ハンドラ以外から resolveOverlaps を呼ばない", () => {
    // useEffect や保存/出力経路から呼ぶと「押していないのに動いた」に戻る。
    // 呼び出しは (1)表示用の結果計算 (2)履歴への適用 の2か所だけ。
    const calls =
      EDITOR.match(/resolveTextTableOverlapsInDocument\(|resolveOverlapsInState/g) ??
      [];
    // 出現の内訳: resolveTextTableOverlapsInDocument は**呼び出し形**のみ数える
    // (import 行に括弧は無い)=1。resolveOverlapsInState は名前で数える=
    // import 1 + フォールバック呼び出し 1。合計 3。これを超えたら自動起動の疑い。
    expect(calls.length).toBe(3);
    // ⚠ハンドラ本体が useEffect の中に無いことを近傍走査で確認。
    const handlerAt2 = EDITOR.indexOf("const handleAutoFixOverlaps");
    const before = EDITOR.slice(Math.max(0, handlerAt2 - 800), handlerAt2);
    expect(before).not.toContain("useEffect(");
  });

  it("結果を黙らせない=直った件数/直せない残りを表示する", () => {
    expect(EDITOR).toContain("で直しました");
    expect(EDITOR).toContain("自動では直せません");
    expect(TOOLBAR).toContain("data-toolbar-auto-fix-notice");
  });

  it("表示用の概要と履歴への適用は同じ純関数(結果がずれない)", () => {
    // 概要=resolveTextTableOverlapsInDocument / 適用=resolveOverlapsInState。
    // 後者は前者の薄い包み(editor-document.ts 側で固定)。ここでは両方が
    // 使われていることだけを見る。
    expect(EDITOR).toContain("resolveTextTableOverlapsInDocument(captured)");
    // captured は押した瞬間の editorState.document(閉じ込め)。
    expect(EDITOR).toContain("const captured = editorState.document;");
  });
});

describe("@codex #403 R1 の追補", () => {
  it("通知は document に紐付き、変わったら消える(古い『直しました』を残さない)", () => {
    expect(EDITOR).toContain("autoFix.doc === editorState.document");
  });

  it("busy 中(保存/出力/削除)は自動修正を押せない", () => {
    const at = TOOLBAR.indexOf("data-toolbar-auto-fix-overlaps");
    const before = TOOLBAR.slice(Math.max(0, at - 300), at);
    expect(before).toContain("disabled={busy}");
  });
});
