import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import FilePickerButton from "../file-picker-button";

describe("FilePickerButton — SSR構造", () => {
  it("ボタン・hidden file input・未選択・ヒントを描画する", () => {
    const html = renderToStaticMarkup(
      <FilePickerButton
        accept=".xlsx,.csv"
        onChange={() => {}}
        hint="Excel(.xlsx) または CSV"
      />,
    );
    expect(html).toContain("data-file-picker");
    expect(html).toContain("ファイルを選択");
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".xlsx,.csv"');
    expect(html).toContain("未選択");
    expect(html).toContain("Excel(.xlsx) または CSV");
    // アクセシビリティ: 視覚的に隠すが Tab で到達できる sr-only(display:none の hidden ではない)
    expect(html).toContain("sr-only");
  });

  it("fileName 指定時はファイル名を表示し「未選択」は出さない", () => {
    const html = renderToStaticMarkup(
      <FilePickerButton
        accept=".xlsx,.csv"
        onChange={() => {}}
        fileName="受付帳.xlsx"
      />,
    );
    expect(html).toContain("受付帳.xlsx");
    expect(html).not.toContain("未選択");
  });

  it("label で任意のボタン文言に差し替えできる", () => {
    const html = renderToStaticMarkup(
      <FilePickerButton
        accept=".xlsx,.csv"
        onChange={() => {}}
        label="受付帳を選択"
      />,
    );
    expect(html).toContain("受付帳を選択");
  });
});
