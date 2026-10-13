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
    // ⚠display: contents だと form の space-y-4 が中の欄に効かず、欄の間が詰まる。
    expect(src).not.toMatch(/<fieldset[^>]*className="contents"/);
    expect(src).toMatch(/<fieldset disabled=\{pendingBlocked\} className="[^"]*space-y-4/);
  });
});

describe("新規物件登録の小窓を開き直す", () => {
  it("物件一覧: 控えがあれば開く", () => {
    const src = read("src/app/(dashboard)/properties/page.tsx");
    expect(src).toMatch(/useDraftExists\(draftKey\("new-property:properties"\)\)/);
    // 控えが現れたら開く(開いた状態を保つ)。控えが消えても閉じない=「最初からやり直す」で閉じない。
    expect(src).toMatch(/if \(newPropertyDraftExists && !showNewModal\) setShowNewModal\(true\);/);
    expect(src).toMatch(/\{showNewModal && \(\n\s*<NewPropertyModal draftScreen="new-property:properties"/);
    expect(src).not.toMatch(/showNewModal \|\| newPropertyDraftExists/);
  });
  it("販売図面の新規作成: 控えがあれば開く", () => {
    const src = read("src/app/(dashboard)/sales-sheets/new/page.tsx");
    expect(src).toMatch(/useDraftExists\(draftKey\("new-property:sales-sheet"\)\)/);
    expect(src).toMatch(/if \(registerDraftExists && !showRegister\) setShowRegister\(true\);/);
    expect(src).toMatch(/\{showRegister && \(\n\s*<NewPropertyModal\n\s*draftScreen="new-property:sales-sheet"/);
    expect(src).not.toMatch(/showRegister \|\| registerDraftExists/);
  });
});

describe("物件の編集の小窓: 作業中の入力を消さない", () => {
  const src = read("src/components/properties/property-edit-form.tsx");
  it("開いた時点の控えを読み、[property] の初期化のあとに重ねる", () => {
    expect(src).toMatch(/useRestoredDraft\(editDraftKey, parsePropertyEditDraft\)/);
    expect(src).toMatch(/const merged = mergeDraftIntoInitial\(\s*initial,\s*draftDiscarded \? null : restored\?\.data \?\? null,\s*property\.id,\s*property\.version,?\s*\);\n\s*setValues\(merged\.values\);/);
    expect(src).toMatch(/\}, \[property, restored, draftDiscarded\]\);/);
  });
  it("変えた欄だけを控える(版つき)", () => {
    expect(src).toMatch(/changed: changedValues\(values, property as unknown as Record<string, unknown>\)/);
    expect(src).toMatch(/baseVersion: property\.version/);
    expect(src).toMatch(/useDraftAutosave\(editDraftKey, editDraftData, isPropertyEditDraftEmpty, restored\)/);
  });
  it("保存できたら控えを消してから onSaved", () => {
    expect(src).toMatch(/editDraft\.close\(\);\n\s*void lock\.release\(\);\n\s*onSaved\(/);
  });
  it("閉じる・キャンセルで控えを消す", () => {
    expect(src).toMatch(/const handleClose = \(\) => \{\n\s*editDraft\.close\(\);\n\s*void lock\.release\(\);\n\s*onClose\(\);/);
  });
  it("帯", () => {
    expect(src).toMatch(/<DraftRestoredNotice/);
  });
});

describe("物件詳細: 読み込み完了時に編集の小窓を開き直す", () => {
  const src = read("src/app/(dashboard)/properties/[id]/page.tsx");
  it("物件ごとに最初の読み込みで1回だけ判定する", () => {
    expect(src).toMatch(/if \(applied && editDraftCheckedRef\.current !== id\) \{/);
    expect(src).toMatch(/decideEditDraftOnLoad\(/);
    expect(src).toMatch(/if \(decision === "reopen"\) setShowEditForm\(true\);/);
    expect(src).toMatch(/clearDraft\(editKey\);\n\s*setEditDraftStale\(true\);/);
  });
  it("版違いの帯を出す", () => {
    expect(src).toMatch(/\{editDraftStale && <DraftStaleNotice onDismiss=\{\(\) => setEditDraftStale\(false\)\} \/>\}/);
  });
});
