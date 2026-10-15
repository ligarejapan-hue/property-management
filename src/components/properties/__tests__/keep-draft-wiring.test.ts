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
    // 大きすぎて控えられないときも、送信中の印は小さな控えで残す(@codex P2)。
    expect(src).toMatch(/useDraftAutosave\(draftKeyValue, draftData, isNewPropertyDraftEmpty, restored, \{\n?\s*compactForPending: compactNewPropertyDraftForPending,?\n?\s*\}\)/);
  });
  it("送る直前に送信中の印・成功で close・失敗で印を外す", () => {
    expect(src).toMatch(/draft\.markSubmitting\(\);[\s\S]*?await createProperty\(/);
    expect(src).toMatch(/draft\.close\(\);\n\s*resolvePostCreate\(/);
    // 登録されていないと言い切れる失敗(4xx)のときだけ印を外す。通信切れ・5xx は印を残し、確かめる帯を出す。
    expect(src).toMatch(/catch \(err\) \{\n(?:\s*\/\/.*\n)*\s*if \(isDefiniteSubmitFailure\(err\)\) draft\.unmarkSubmitting\(\);\n\s*else setPendingBlocked\(true\);/);
    expect(src).not.toMatch(/catch \(err\) \{\n\s*draft\.unmarkSubmitting\(\);/);
  });
  it("×は控えを残して閉じる(2026-10-15 発注者判断)", () => {
    expect(src).toMatch(/const handleCloseKeepDraft = \(\) => \{\n\s*onClose\(\);\n\s*\};/);
    expect((src.match(/onClick=\{handleCloseKeepDraft\}/g) ?? []).length).toBe(1);
    expect(src).toMatch(/onClick=\{handleCloseKeepDraft\}[\s\S]{0,600}<X className/);
  });
  it("キャンセルは控えを消して閉じる", () => {
    // ⚠送信途中の帯が出ている間は控え(印)を残して閉じる=一覧で確かめに行ける(@codex P1)。
    expect(src).toMatch(/const handleCancel = \(\) => \{\n(?:\s*\/\/.*\n)*\s*if \(pendingBlocked\) \{\n\s*onClose\(\);\n\s*return;\n\s*\}\n\s*draft\.close\(\);\n\s*onClose\(\);/);
    expect((src.match(/onClick=\{handleCancel\}/g) ?? []).length).toBe(1);
    expect(src).not.toMatch(/onClick=\{onClose\}/);
  });
  it("帯: 続き・送信途中", () => {
    expect(src).toMatch(/<DraftRestoredNotice/);
    expect(src).toMatch(/<DraftPendingNotice/);
    expect(src).toMatch(/<fieldset disabled=\{pendingBlocked\}/);
    // 大きすぎて控えられないときは知らせる(@codex P2)。
    expect(src).toMatch(/\{draft\.tooLarge && <DraftTooLargeNotice kind="input" \/>\}/);
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
    // 画面に来るたびに1回だけ開く(送信途中の控えを残して閉じたとき、すぐ開き直さない)。
    expect(src).toMatch(/if \(newPropertyDraftExists && canWriteProperty && !newDraftAutoOpened\) \{\n\s*setNewDraftAutoOpened\(true\);\n\s*setShowNewModal\(true\);\n\s*\}/);
    expect(src).toMatch(/\{showNewModal && \(\n\s*<NewPropertyModal draftScreen="new-property:properties"/);
    expect(src).not.toMatch(/showNewModal \|\| newPropertyDraftExists/);
  });
  it("販売図面の新規作成: 控えがあれば開く", () => {
    const src = read("src/app/(dashboard)/sales-sheets/new/page.tsx");
    expect(src).toMatch(/useDraftExists\(draftKey\("new-property:sales-sheet"\)\)/);
    expect(src).toMatch(/if \(registerDraftExists && canWriteProperty && !registerDraftAutoOpened\) \{\n\s*setRegisterDraftAutoOpened\(true\);\n\s*setShowRegister\(true\);\n\s*\}/);
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
  it("お試し(モック)の保存でも控えを消してから onSaved", () => {
    expect(src).toMatch(/if \(USE_MOCK\) \{[\s\S]*?editDraft\.close\(\);\n\s*void lock\.release\(\);\n\s*onSaved\(\);\n\s*return;/);
  });
  it("キャンセルで控えを消す", () => {
    expect(src).toMatch(/const handleClose = \(\) => \{\n\s*editDraft\.close\(\);\n\s*void lock\.release\(\);\n\s*onClose\(\);/);
    expect((src.match(/onClick=\{handleClose\}/g) ?? []).length).toBe(1);
  });
  it("×は控えを残して閉じ、鍵は返す(2026-10-15 発注者判断)", () => {
    expect(src).toMatch(/const handleCloseKeepDraft = \(\) => \{\n\s*void lock\.release\(\);\n\s*onClose\(\);\n\s*\};/);
    expect((src.match(/onClick=\{handleCloseKeepDraft\}/g) ?? []).length).toBe(1);
    expect(src).toMatch(/onClick=\{handleCloseKeepDraft\}[\s\S]{0,600}<X className/);
  });
  it("帯", () => {
    expect(src).toMatch(/<DraftRestoredNotice/);
    expect(src).toMatch(/\{editDraft\.tooLarge && <DraftTooLargeNotice kind="input" \/>\}/);
  });
});

describe("物件詳細: 読み込み完了時に編集の小窓を開き直す", () => {
  const src = read("src/app/(dashboard)/properties/[id]/page.tsx");
  it("物件ごとに最初の読み込みで1回だけ判定する", () => {
    expect(src).toMatch(/if \(applied && editDraftCheckedRef\.current !== id\) \{/);
    expect(src).toMatch(/decideEditDraftOnLoad\(/);
    // 読み込みでは「開き直したい」と覚えるだけ。開くのは物件の書き込み権限を確かめてから(@codex P2)。
    expect(src).toMatch(/if \(decision === "reopen"\) setEditDraftReopenPending\(true\);/);
    expect(src).not.toMatch(/if \(decision === "reopen"\) setShowEditForm\(true\);/);
    expect(src).toMatch(/if \(editDraftReopenPending && canWriteProperty\) \{\n\s*setEditDraftReopenPending\(false\);\n\s*setShowEditForm\(true\);\n\s*\}/);
    expect(src).toMatch(/clearDraft\(editKey\);\n\s*setEditDraftStale\(true\);/);
  });
  it("別の物件へ移ったら、前の物件の開き直し・版違いの帯を引き継がない(@codex P2)", () => {
    expect(src).toMatch(/useEffect\(\(\) => \{[^}]*?setShowEditForm\(false\);\n\s*setEditDraftStale\(false\);\n\s*setEditDraftReopenPending\(false\);[^}]*?\}, \[id\]\);/);
  });
  it("版違いの帯を出す", () => {
    expect(src).toMatch(/\{editDraftStale && <DraftStaleNotice onDismiss=\{\(\) => setEditDraftStale\(false\)\} \/>\}/);
  });
});
