import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ファイルを入れる場所は共通のドロップ枠(FileDropZone)にそろえる(2026-10-13 発注者依頼:
 * 「受付帳CSVから物件を新規作成」と同じく、選択もドラッグ＆ドロップもできるように)。
 * 素の <input type="file"> を新しく書いたらここで止める。
 * 例外は、枠とは別に置く理由のあるものだけ(理由を必ず書く)。
 */
const ALLOWED: Record<string, string> = {
  "src/components/ui/file-drop-zone.tsx": "共通のドロップ枠そのもの",
  "src/components/properties/photo-tab.tsx": "見出し横の「アップロード」ボタン(枠も併設)",
  "src/components/buildings/building-photo-tab.tsx": "見出し横の「アップロード」ボタン(枠も併設)",
  "src/components/import/bulk-folder-upload.tsx": "「フォルダを選択」(フォルダはドロップでは送れない・枠も併設)",
  "src/components/field-survey/camera-first-button.tsx": "スマホのカメラを直接開く撮影ボタン",
  "src/components/field-survey/field-survey-map.tsx": "現地調査の撮影ボタン(スマホのカメラ)",
  "src/components/field-survey/pin-create-modal.tsx": "現地調査の撮影ボタン(スマホのカメラ)",
  "src/components/field-survey/pin-detail-panel.tsx": "現地調査の撮影ボタン(スマホのカメラ)",
};

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
}

describe("ファイル選択欄は共通のドロップ枠にそろえる", () => {
  const root = process.cwd();
  const files: string[] = [];
  walk(path.join(root, "src"), files);
  const users = files
    .filter((f) => /type=["{]+"?file"?\}?/.test(readFileSync(f, "utf8").replace(/\r\n/g, "\n")))
    .map((f) => path.relative(root, f).split(path.sep).join("/"))
    .sort();

  it("素の <input type=\"file\"> は例外の一覧にあるファイルだけ", () => {
    expect(users.filter((f) => !(f in ALLOWED))).toEqual([]);
  });

  it("例外の一覧に、もう使っていないファイルを残さない", () => {
    expect(Object.keys(ALLOWED).filter((f) => !users.includes(f))).toEqual([]);
  });

  it("FilePickerButton(古いボタン型)は使わない", () => {
    const stale = files.filter((f) => readFileSync(f, "utf8").includes("file-picker-button"));
    expect(stale).toEqual([]);
  });
});
