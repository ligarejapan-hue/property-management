import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

describe("新規物件登録の小窓: 作業中の入力を消さない", () => {
  const src = read("src/components/properties/new-property-modal.tsx");
  it("控えから初期値を作る(useRestoredDraft)", () => {
    expect(src).toMatch(/useRestoredDraft\(draftKeyValue, parseNewPropertyDraft\)/);
    expect(src).toMatch(/useState\(start\.propertyType\)/);
    expect(src).toMatch(/useState<BuildingChoice>\(start\.buildingChoice\)/);
  });
  it("自動で控える(useDraftAutosave)", () => {
    expect(src).toMatch(/useDraftAutosave\(draftKeyValue, draftData, isNewPropertyDraftEmpty, restored\)/);
  });
  it("送る直前に送信中の印・成功で close・失敗で印を外す", () => {
    expect(src).toMatch(/draft\.markSubmitting\(\);[\s\S]*?await createProperty\(/);
    expect(src).toMatch(/draft\.close\(\);\n\s*resolvePostCreate\(/);
    expect(src).toMatch(/catch \(err\) \{\n\s*draft\.unmarkSubmitting\(\);/);
  });
  it("キャンセル・×は控えを消して閉じる", () => {
    expect(src).toMatch(/const handleCancel = \(\) => \{\n\s*draft\.close\(\);\n\s*onClose\(\);/);
    expect((src.match(/onClick=\{handleCancel\}/g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/onClick=\{onClose\}/);
  });
  it("帯: 続き・送信途中", () => {
    expect(src).toMatch(/<DraftRestoredNotice/);
    expect(src).toMatch(/<DraftPendingNotice/);
    expect(src).toMatch(/<fieldset disabled=\{pendingBlocked\}/);
  });
});

describe("新規物件登録の小窓を開き直す", () => {
  it("物件一覧: 控えがあれば開く", () => {
    const src = read("src/app/(dashboard)/properties/page.tsx");
    expect(src).toMatch(/useDraftExists\(draftKey\("new-property:properties"\)\)/);
    expect(src).toMatch(/\(showNewModal \|\| newPropertyDraftExists\) && \(\n\s*<NewPropertyModal draftScreen="new-property:properties"/);
  });
  it("販売図面の新規作成: 控えがあれば開く", () => {
    const src = read("src/app/(dashboard)/sales-sheets/new/page.tsx");
    expect(src).toMatch(/useDraftExists\(draftKey\("new-property:sales-sheet"\)\)/);
    expect(src).toMatch(/\(showRegister \|\| registerDraftExists\) && \(\n\s*<NewPropertyModal\n\s*draftScreen="new-property:sales-sheet"/);
  });
});
