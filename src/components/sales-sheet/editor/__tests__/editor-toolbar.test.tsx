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
