import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import FileDropZone from "../file-drop-zone";

const noop = () => {};

describe("FileDropZone — SSR構造", () => {
  it("点線の枠・題目・「クリックして選択」・隠したファイル選択欄を描画する", () => {
    const html = renderToStaticMarkup(
      <FileDropZone accept=".csv,.xlsx" onFiles={noop} title="CSV または Excel をここにドラッグ＆ドロップ" hint="上限 10MB" />,
    );
    expect(html).toContain("data-file-drop-zone");
    expect(html).toContain("border-dashed");
    expect(html).toContain("CSV または Excel をここにドラッグ＆ドロップ");
    expect(html).toContain("またはクリックしてファイルを選択");
    expect(html).toContain("上限 10MB");
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".csv,.xlsx"');
  });

  it("キーボードで届く(role=button・tabIndex=0)", () => {
    const html = renderToStaticMarkup(<FileDropZone accept=".pdf" onFiles={noop} title="t" />);
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
  });

  it("multiple 未指定なら複数選択にしない・指定なら「まとめて複数可」", () => {
    const single = renderToStaticMarkup(<FileDropZone accept=".pdf" onFiles={noop} title="t" />);
    expect(single).not.toContain("multiple");
    expect(single).not.toContain("まとめて複数可");
    const many = renderToStaticMarkup(<FileDropZone accept=".pdf" multiple onFiles={noop} title="t" />);
    expect(many).toContain('multiple=""');
    expect(many).toContain("まとめて複数可");
  });

  it("選んだファイル名を枠の中に出す", () => {
    const html = renderToStaticMarkup(
      <FileDropZone accept=".xlsx" onFiles={noop} title="t" fileName="顧客管理表.xlsx" />,
    );
    expect(html).toContain("顧客管理表.xlsx");
  });

  it("busy の間は中身を差し替え、Tab で止まらず選択欄も無効", () => {
    const html = renderToStaticMarkup(
      <FileDropZone accept=".pdf" onFiles={noop} title="題目" busy={<span>アップロード中...</span>} />,
    );
    expect(html).toContain("アップロード中...");
    expect(html).not.toContain("題目");
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('disabled=""');
  });

  it("disabled も同じく無効になる", () => {
    const html = renderToStaticMarkup(<FileDropZone accept=".pdf" onFiles={noop} title="t" disabled />);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("cursor-not-allowed");
  });
});
