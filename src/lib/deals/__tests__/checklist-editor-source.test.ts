import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("書類確認書の項目の編集(第2段階 §4.4)", () => {
  it("項目ごとに「使う書類」を選べる(無い項目は両方として見せる)", () => {
    const src = read("src/components/deals/checklist-items-editor.tsx");
    expect(src).toContain('label="使う書類"');
    expect(src).toContain('value={i.use ?? "both"}');
    expect(src).toContain("optionsOf(CHECKLIST_USES)");
    // 「両方」は書かない(保存済みの項目と同じ形のまま=古い版へ戻しても項目が読める・最終レビュー)
    expect(src).toContain('patch(i.id, { use: v === "both" ? undefined : (v as ChecklistUse) })');
  });
});
