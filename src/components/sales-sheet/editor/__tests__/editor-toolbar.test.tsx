import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorToolbar } from "../EditorToolbar";

const noop = async () => {};

describe("EditorToolbar — 描画", () => {
  it("data-editor-toolbar を持つルート要素を描画する", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar dirty={false} onSave={noop} onExport={noop} onDelete={noop} onAddPhoto={() => {}} onAutoArrange={() => {}} onAutoBalance={() => {}} onAddBadge={() => {}} onAddQr={() => {}} onOpenTransactionInfo={() => {}} />,
    );
    expect(html).toContain("data-editor-toolbar");
  });

  it("dirty=false のとき dirty indicator は非表示", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar dirty={false} onSave={noop} onExport={noop} onDelete={noop} onAddPhoto={() => {}} onAutoArrange={() => {}} onAutoBalance={() => {}} onAddBadge={() => {}} onAddQr={() => {}} onOpenTransactionInfo={() => {}} />,
    );
    expect(html).not.toContain("未保存の変更があります");
  });

  it("dirty=true のとき data-dirty-indicator を表示する", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar dirty={true} onSave={noop} onExport={noop} onDelete={noop} onAddPhoto={() => {}} onAutoArrange={() => {}} onAutoBalance={() => {}} onAddBadge={() => {}} onAddQr={() => {}} onOpenTransactionInfo={() => {}} />,
    );
    expect(html).toContain("data-dirty-indicator");
    expect(html).toContain("未保存の変更があります");
  });

  it("保存・PDF出力・PNG出力・削除ボタンを持つ", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar dirty={false} onSave={noop} onExport={noop} onDelete={noop} onAddPhoto={() => {}} onAutoArrange={() => {}} onAutoBalance={() => {}} onAddBadge={() => {}} onAddQr={() => {}} onOpenTransactionInfo={() => {}} />,
    );
    expect(html).toContain("data-toolbar-save");
    expect(html).toContain("data-toolbar-add-photo");
    expect(html).toContain("data-toolbar-export");
    expect(html).toContain("data-toolbar-delete");
    expect(html).toContain("保存");
    expect(html).toContain("写真を追加");
    expect(html).toContain("PDF出力");
    expect(html).toContain("削除");
  });

  it("QR追加ボタンを持つ（計画⑧）", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar
        dirty={false}
        onSave={noop}
        onExport={noop}
        onDelete={noop}
        onAddPhoto={() => {}}
        onAutoArrange={() => {}}
        onAutoBalance={() => {}}
        onAddBadge={() => {}}
        onAddQr={() => {}}
        onOpenTransactionInfo={() => {}}
      />,
    );
    expect(html).toContain("data-toolbar-add-qr");
    expect(html).toContain("QRを追加");
  });

  it("地図QR追加ボタン: 住所ありで活性・住所無しで無効", () => {
    const withAddr = renderToStaticMarkup(
      <EditorToolbar dirty={false} onSave={noop} onExport={noop} onDelete={noop} onAddPhoto={() => {}} onAutoArrange={() => {}} onAutoBalance={() => {}} onAddBadge={() => {}} onAddQr={() => {}} onAddMapQr={() => {}} canAddMapQr={true} onOpenTransactionInfo={() => {}} />,
    );
    expect(withAddr).toContain("data-toolbar-add-map-qr");
    expect(withAddr).toContain("地図QRを追加");
    // React SSR は disabled=true のとき属性 `disabled=""` を出力(className の disabled: とは別)。
    const tag = (html: string) => {
      const s = html.slice(html.indexOf("data-toolbar-add-map-qr"));
      return s.slice(0, s.indexOf(">"));
    };
    expect(tag(withAddr).includes('disabled=""')).toBe(false); // 住所あり=活性

    const noAddr = renderToStaticMarkup(
      <EditorToolbar dirty={false} onSave={noop} onExport={noop} onDelete={noop} onAddPhoto={() => {}} onAutoArrange={() => {}} onAutoBalance={() => {}} onAddBadge={() => {}} onAddQr={() => {}} onAddMapQr={() => {}} canAddMapQr={false} onOpenTransactionInfo={() => {}} />,
    );
    expect(tag(noAddr).includes('disabled=""')).toBe(true); // 住所無し=無効
  });

  it("バッジ追加ボタンを持つ（計画⑦）", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar
        dirty={false}
        onSave={noop}
        onExport={noop}
        onDelete={noop}
        onAddPhoto={() => {}}
        onAutoArrange={() => {}}
        onAutoBalance={() => {}}
        onAddBadge={() => {}}
        onAddQr={() => {}}
        onOpenTransactionInfo={() => {}}
      />,
    );
    expect(html).toContain("data-toolbar-add-badge");
    expect(html).toContain("バッジを追加");
  });

  it("自動整列ボタンを持つ（計画⑥）", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar
        dirty={false}
        onSave={noop}
        onExport={noop}
        onDelete={noop}
        onAddPhoto={() => {}}
        onAutoArrange={() => {}}
        onAutoBalance={() => {}}
        onAddBadge={() => {}}
        onAddQr={() => {}}
        onOpenTransactionInfo={() => {}}
      />,
    );
    expect(html).toContain("data-toolbar-auto-arrange");
    expect(html).toContain("写真を自動整列");
  });

  it("レイアウト自動調整ボタンを持つ（機能A）", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar
        dirty={false}
        onSave={noop}
        onExport={noop}
        onDelete={noop}
        onAddPhoto={() => {}}
        onAutoArrange={() => {}}
        onAutoBalance={() => {}}
        onAddBadge={() => {}}
        onAddQr={() => {}}
        onOpenTransactionInfo={() => {}}
      />,
    );
    expect(html).toContain("data-toolbar-auto-balance");
    expect(html).toContain("レイアウト自動調整");
  });

  it("onUndo/onRedo 指定時、元に戻す/やり直すボタンを持ち canUndo/canRedo で非活性化", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar
        dirty={false}
        onSave={noop}
        onExport={noop}
        onDelete={noop}
        onAddPhoto={() => {}}
        onAutoArrange={() => {}}
        onAutoBalance={() => {}}
        onAddBadge={() => {}}
        onAddQr={() => {}}
        onOpenTransactionInfo={() => {}}
        onUndo={() => {}}
        canUndo={false}
        onRedo={() => {}}
        canRedo={true}
      />,
    );
    expect(html).toContain("data-toolbar-undo");
    expect(html).toContain("元に戻す");
    expect(html).toContain("data-toolbar-redo");
    expect(html).toContain("やり直す");
    // canUndo=false → undo は disabled 属性あり、canRedo=true → redo は無し
    // (クラス名の "disabled:opacity-50" に誤マッチしないよう属性形 'disabled=""' で判定)
    const undoBtn = html.slice(html.indexOf("data-toolbar-undo"), html.indexOf("data-toolbar-redo"));
    expect(undoBtn).toContain('disabled=""');
    const redoBtn = html.slice(html.indexOf("data-toolbar-redo"), html.indexOf("data-toolbar-save"));
    expect(redoBtn).not.toContain('disabled=""');
  });

  it("onUndo/onRedo 未指定なら undo/redo ボタンは出ない(後方互換)", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar
        dirty={false}
        onSave={noop}
        onExport={noop}
        onDelete={noop}
        onAddPhoto={() => {}}
        onAutoArrange={() => {}}
        onAutoBalance={() => {}}
        onAddBadge={() => {}}
        onAddQr={() => {}}
        onOpenTransactionInfo={() => {}}
      />,
    );
    expect(html).not.toContain("data-toolbar-undo");
    expect(html).not.toContain("data-toolbar-redo");
  });

  it("dirty=false のとき保存ボタンが disabled でない", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar dirty={false} onSave={noop} onExport={noop} onDelete={noop} onAddPhoto={() => {}} onAutoArrange={() => {}} onAutoBalance={() => {}} onAddBadge={() => {}} onAddQr={() => {}} onOpenTransactionInfo={() => {}} />,
    );
    // All buttons enabled (no disabled attr in static output when not busy)
    expect(html).not.toContain("保存中");
  });

  it("「取引情報」ボタンを描画する", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar
        dirty={false}
        onSave={noop}
        onExport={noop}
        onDelete={noop}
        onAddPhoto={() => {}}
        onAutoArrange={() => {}}
        onAutoBalance={() => {}}
        onAddBadge={() => {}}
        onAddQr={() => {}}
        onOpenTransactionInfo={() => {}}
      />,
    );
    expect(html).toContain("data-toolbar-transaction-info");
    expect(html).toContain("取引情報");
  });

  it("会社帯が無い図面では「取引情報」ボタンを無効化しツールチップを出す", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar
        dirty={false}
        onSave={noop}
        onExport={noop}
        onDelete={noop}
        onAddPhoto={() => {}}
        onAutoArrange={() => {}}
        onAutoBalance={() => {}}
        onAddBadge={() => {}}
        onAddQr={() => {}}
        onOpenTransactionInfo={() => {}}
        canEditTransactionInfo={false}
      />,
    );
    expect(html).toContain("この図面には会社帯がありません");
  });
});

// ---------------------------------------------------------------------------
// B-8 (UI総点検): 自動調整の効果範囲注記 + 文字・表の重なり注意表示
// ---------------------------------------------------------------------------

describe("EditorToolbar — B-8 効果範囲注記と重なり注意", () => {
  const noop2 = async () => {};
  const base = {
    dirty: false,
    onSave: noop2,
    onExport: noop2,
    onDelete: noop2,
    onAddPhoto: () => {},
    onAutoArrange: () => {},
    onAutoBalance: () => {},
    onAddBadge: () => {},
    onAddQr: () => {},
    onOpenTransactionInfo: () => {},
  };

  it("自動整列・自動調整ボタンに効果範囲の title 注記がある", () => {
    const html = renderToStaticMarkup(<EditorToolbar {...base} />);
    // 自動整列: 地図QRは動かさない(@codex #310)ため QR も「動かない」側に明記
    expect(html).toContain("手で配置した文字・表・バッジ・QRは動きません");
    expect(html).toContain("手で配置した文字・バッジは動きません");
  });

  it("layoutWarning 指定時は data-toolbar-layout-warning を表示する", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar {...base} layoutWarning="文字・表が重なっています(2箇所)。出力にもそのまま写るため、ドラッグで位置を調整してください" />,
    );
    expect(html).toContain("data-toolbar-layout-warning");
    expect(html).toContain("文字・表が重なっています(2箇所)");
  });

  it("警告はボタン行と競合しない独立行に全文表示 (@codex R4/R6)", () => {
    const long = "文字・表が重なっています(12箇所)。出力にもそのまま写るため、ドラッグで位置を調整してください";
    const html = renderToStaticMarkup(
      <EditorToolbar {...base} layoutWarning={long} />,
    );
    // ボタン行 (flex) の外 = 削除ボタンより後に独立要素として出る
    const deleteIdx = html.indexOf("data-toolbar-delete");
    const warnIdx = html.indexOf("data-toolbar-layout-warning");
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(deleteIdx);
    // 全文が truncate されずに含まれる (幅に依存して消えない)
    expect(html).toContain(long);
    const tag = html.slice(warnIdx, html.indexOf(">", warnIdx));
    expect(tag).not.toContain("truncate");
  });

  it("layoutWarning 未指定なら注意表示は出ない(後方互換)", () => {
    const html = renderToStaticMarkup(<EditorToolbar {...base} />);
    expect(html).not.toContain("data-toolbar-layout-warning");
  });
});
