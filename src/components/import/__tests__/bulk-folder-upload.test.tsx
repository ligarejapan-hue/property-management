import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import BulkFolderUpload from "../bulk-folder-upload";

describe("BulkFolderUpload — SSR構造", () => {
  it("フォルダ/ファイル選択ボタン・対応形式・PDF入力を描画する", () => {
    const html = renderToStaticMarkup(<BulkFolderUpload />);
    expect(html).toContain("data-bulk-folder-upload");
    expect(html).toContain("フォルダを選択");
    expect(html).toContain("ファイルを選択");
    expect(html).toContain("対応形式");
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".pdf,application/pdf"');
  });

  it("未選択の初期状態では開始/完了/進捗を描画しない", () => {
    const html = renderToStaticMarkup(<BulkFolderUpload />);
    expect(html).not.toContain("アップロード開始");
    expect(html).not.toContain("アップロード完了");
  });
});
