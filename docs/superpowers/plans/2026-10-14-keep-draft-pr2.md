# 別メニューへ移っても入力を消さない 第2段(読み取りの画面) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 貼り付けて物件化・Excelからまとめて物件化・謄本PDF取込・取り込み(CSV)の4画面で、途中で別のメニューへ移って戻っても、読み取り結果と直した値がそのタブの中に残り、続きから再開できるようにする。

**Architecture:** 第1段(本番 `3cd8d0a3`)の土台 `src/lib/drafts/*`・`src/hooks/use-draft.ts`・`src/components/drafts/draft-notices.tsx` をそのまま使う。画面ごとの「控えの形・検査・空の判定」を `src/lib/drafts/screens/<画面>.ts` の純関数に置き、ページは state の初期値を控えから取り、state の束を `useMemo` で控えの形にまとめて `useDraftAutosave` に渡すだけにする。ページは最初にサーバーで描かれるため、控えを読むのは**ブラウザで描き直した後**に限る(既定の書き出しが `useClientReady()` を見て `key` を変え、画面本体を作り直す)。

**Tech Stack:** Next.js App Router (client pages)・React 19 (`useSyncExternalStore`)・zod (`zod/v4`)・vitest (env=node・`renderToStaticMarkup`+ソース走査)。

**Spec:** `docs/superpowers/specs/2026-10-13-keep-draft-on-navigate-design.md`(§2 S1〜S4・§3・§4.3・§5.1〜5.4・§6・§7)。第1段の計画 `docs/superpowers/plans/2026-10-13-keep-draft-pr1.md` も参照。

## Global Constraints

- 置き場は **sessionStorage のみ**。localStorage・IndexedDB は使わない(§6)。
- 鍵は既存の `draftKey("paste" | "paste-excel" | "registry-pdf" | "csv-import")`(`DRAFT_SCREENS` に登録済み)。新しい画面名は足さない。
- 12時間失効・1,500,000文字上限・ログアウト/ログイン時の全消しは土台がすでに行う。画面側で重ねて実装しない。
- `File` オブジェクト・objectURL は控えに入れない(§2)。
- 控えの中身をログ・エラー表示・監査に出さない(§6)。
- **サーバー側の変更なし**(API・DB・migration・依存の追加なし)。
- 帯の文言は既存の部品(`DraftRestoredNotice`「前回の続きを表示しています（H時MM分の入力）」［最初からやり直す］/`DraftPendingNotice`/`DraftTooLargeNotice`)を使う。新しい文言は本計画に書いたものだけ。
- 送信の失敗で「登録されていない」と言い切れるのは 4xx だけ(`isDefiniteSubmitFailure`)。通信切れ・5xx は送信中の印を残す(§5.1・@codex P1 の既決)。
- ⚠ eslint `react-hooks/set-state-in-effect`: effect の中で同期的に setState しない。控えからの復元は **useState の初期値**で行う(effect で戻さない)。
- コメント・利用者向けの文は平易な日本語。既存の書き方(⚠で始まる注意・設計書の節番号)に合わせる。
- コミット末尾:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LYGLoZ3RCTWGGudbns69rp
  ```

## Review Focus

1. **F5(読み込み直し)で開いた場合**: サーバー描画と最初のブラウザ描画が食い違わない(hydration の警告が出ない)うえで、控えが戻ること。→ Task 1 の `useClientReady` の走査テストと、各画面の「既定の書き出しが `key={clientReady ? "client" : "server"}` で本体を描く」走査テスト(Task 2〜5)。
2. **配布で控えの形が変わった後**: 古い形の控えを読んでも画面が壊れず、捨てて最初から始まること。→ 各画面の `parse*Draft` が `rev` 違い・欠けた欄で `null` を返すテスト(Task 2〜5)。
3. **PDFを選び直さないまま登録**: 貼り付けて物件化(PDF)・謄本PDF(ファイル)で、控えから戻った確認画面で登録ボタンが押せないこと、選び直すと押せること。→ `pdfReselectReason` / `registryNeedsReselect` の純関数テスト(Task 2・4)。
4. **Excelのまとめ登録の途中で離れた**: 送信中だった行が「登録されたか分かりません」になり、まとめて登録の対象から外れること、画面を離れたら次の行を送らないこと。→ `restoreExcelResults` の総当たりテストと、unmount で `stopRef.current = true` にする走査テスト(Task 3)。
5. **CSVで取り込みの途中で離れた**: 戻ったときに再送できる形で戻さず、取り込み履歴への案内だけが出ること。大きすぎて控えを止めた後でも送信中の印は残ること。→ `compactCsvImportDraftForPending` と `decideCsvImportRestore` のテスト(Task 5)。

---

## ファイルの地図

| ファイル | 役割 | Task |
|---|---|---|
| `src/hooks/use-draft.ts`(変更) | `useClientReady()` を足す | 1 |
| `src/lib/drafts/submit-outcome.ts`(変更) | `httpError(message, status)` を足す(素の fetch の画面でも 4xx を見分ける) | 1 |
| `src/lib/drafts/reselect.ts`(新規) | 選び直したファイル名が前回と同じかの判定 | 1 |
| `src/components/drafts/draft-notices.tsx`(変更) | `DraftReselectFileNotice`・`DraftImportPendingNotice` を足す | 1 |
| `src/lib/drafts/screens/paste.ts`(新規) | S1 の控えの形・検査・空判定・選び直しの理由 | 2 |
| `src/components/import/paste-import-review.tsx`(変更) | `registerBlockedReason`・`readOnly` を受ける | 2 |
| `src/app/(dashboard)/import/paste/page.tsx`(変更) | S1 の組み込み | 2 |
| `src/lib/drafts/screens/paste-excel.ts`(新規) | S2 の控えの形・送信中の行の戻し方 | 3 |
| `src/components/import/excel-lead-table.tsx`(変更) | 結果 `unknown` の表示と「対象に戻す」ボタン | 3 |
| `src/app/(dashboard)/import/paste/excel/page.tsx`(変更) | S2 の組み込み | 3 |
| `src/lib/drafts/screens/registry-pdf.ts`(新規) | S3 の控えの形・選び直しの判定 | 4 |
| `src/app/(dashboard)/import/registry-pdf/page.tsx`(変更) | S3 の組み込み | 4 |
| `src/lib/drafts/screens/csv-import.ts`(新規) | S4 の3つの流れの控え・送信中の扱い | 5 |
| `src/app/(dashboard)/import/page.tsx`(変更) | S4 の組み込み | 5 |
| `src/lib/drafts/__tests__/screens-pr2.test.ts`(新規) | Task 2〜5 の純関数テスト | 2〜5 |
| `src/lib/drafts/__tests__/pr2-wiring-source.test.ts`(新規) | Task 2〜5 の配線(ソース走査) | 2〜5 |
| `src/components/drafts/__tests__/draft-notices-pr2.test.tsx`(新規) | 新しい帯のSSR | 1 |

---

### Task 0: 作業場所の準備(済みのものは確認だけ)

- [ ] **Step 1: worktree と依存**

worktree `C:\Users\issin\Desktop\Claude\property-management-worktrees\keep-draft-2`(branch `feat/keep-draft-2`・origin/main `3cd8d0a3` から)は作成済み。

```bash
cd C:/Users/issin/Desktop/Claude/property-management-worktrees/keep-draft-2
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npx prisma generate
npx vitest run src/lib/drafts src/hooks "src/app/(dashboard)/import" src/components/import > /tmp/kd2-baseline.log 2>&1; echo exit=$?
```
Expected: `exit=0`(赤ならユーザーに報告して止める)。

---

### Task 1: 共通の足し(ブラウザ描画の合図・HTTPの失敗・選び直しの帯・取り込み途中の帯)

**Files:**
- Modify: `src/hooks/use-draft.ts`
- Modify: `src/lib/drafts/submit-outcome.ts`
- Create: `src/lib/drafts/reselect.ts`
- Modify: `src/components/drafts/draft-notices.tsx`
- Test: `src/lib/drafts/__tests__/submit-outcome.test.ts`(追記)・`src/lib/drafts/__tests__/reselect.test.ts`(新規)・`src/lib/drafts/__tests__/use-draft-source.test.ts`(追記)・`src/components/drafts/__tests__/draft-notices-pr2.test.tsx`(新規)

**Interfaces:**
- Produces:
  - `useClientReady(): boolean` — サーバー描画と hydration 中は `false`、ブラウザで描き直した後とクライアント遷移では `true`。
  - `httpError(message: string, status: number): Error & { status: number }`
  - `isSameFileName(expected: string, chosen: string): boolean`
  - `DraftReselectFileNotice({ expectedName, chosenName }: { expectedName: string; chosenName: string | null })`
  - `DraftImportPendingNotice({ onDismiss }: { onDismiss: () => void })`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/drafts/__tests__/submit-outcome.test.ts` の末尾に追記:

```ts
import { httpError } from "../submit-outcome";

describe("httpError", () => {
  it("status を持ち、4xx は登録されていないと言い切れる", () => {
    const e = httpError("住所を入力してください", 422);
    expect(e.message).toBe("住所を入力してください");
    expect(e.status).toBe(422);
    expect(isDefiniteSubmitFailure(e)).toBe(true);
  });
  it("5xx は言い切れない", () => {
    expect(isDefiniteSubmitFailure(httpError("x", 500))).toBe(false);
  });
});
```
(ファイル冒頭の既存 import に `isDefiniteSubmitFailure` があることを確かめ、無ければ足す。)

`src/lib/drafts/__tests__/reselect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isSameFileName } from "../reselect";

describe("選び直したファイル名の照合", () => {
  it("同じ名前は同じ", () => {
    expect(isSameFileName("謄本_山田.pdf", "謄本_山田.pdf")).toBe(true);
  });
  it("大文字小文字・前後の空白・NFKC の違いは同じとみなす", () => {
    expect(isSameFileName("ABC.PDF", " abc.pdf ")).toBe(true);
    expect(isSameFileName("ｱｲｳ.pdf", "アイウ.pdf")).toBe(true);
  });
  it("違う名前は違う", () => {
    expect(isSameFileName("a.pdf", "b.pdf")).toBe(false);
  });
});
```

`src/lib/drafts/__tests__/use-draft-source.test.ts` の describe の中に追記:

```ts
  it("useClientReady はサーバー描画・hydration 中は false(useSyncExternalStore の第3引数)", () => {
    expect(src).toMatch(
      /export function useClientReady\(\): boolean \{\s*return useSyncExternalStore\(\s*subscribeNothing,\s*\(\) => true,\s*\(\) => false,?\s*\);/,
    );
  });
```

`src/components/drafts/__tests__/draft-notices-pr2.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DraftImportPendingNotice, DraftReselectFileNotice } from "../draft-notices";

describe("選び直しの帯", () => {
  it("まだ選んでいないとき: 前回のファイル名を出して選び直しを求める", () => {
    const html = renderToStaticMarkup(createElement(DraftReselectFileNotice, { expectedName: "謄本.pdf", chosenName: null }));
    expect(html).toContain("PDF「謄本.pdf」を選び直してください");
    expect(html).toContain("読み取った結果はそのまま使います");
    expect(html).toContain('data-testid="draft-reselect-notice"');
  });
  it("違う名前を選んだとき: 確かめる一文を出す", () => {
    const html = renderToStaticMarkup(createElement(DraftReselectFileNotice, { expectedName: "a.pdf", chosenName: "b.pdf" }));
    expect(html).toContain("前回と違う名前のファイルです（前回: a.pdf）。同じ書類か確かめてください。");
  });
  it("同じ名前を選んだとき: 何も出さない", () => {
    const html = renderToStaticMarkup(createElement(DraftReselectFileNotice, { expectedName: "a.pdf", chosenName: "a.pdf" }));
    expect(html).toBe("");
  });
});

describe("取り込み途中の帯", () => {
  it("取り込み履歴で確かめるよう案内し、閉じるボタンがある", () => {
    const html = renderToStaticMarkup(createElement(DraftImportPendingNotice, { onDismiss: () => {} }));
    expect(html).toContain("前回、取り込みの途中で画面を離れました。下の「取り込み履歴」で結果を確かめてください。");
    expect(html).toContain("閉じる");
    expect(html).toContain('role="alert"');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/drafts src/components/drafts > /tmp/kd2-t1.log 2>&1; echo exit=$?; tail -30 /tmp/kd2-t1.log`
Expected: `exit=1`。`httpError`・`isSameFileName`・`DraftReselectFileNotice`・`DraftImportPendingNotice` が無い/`useClientReady` が無い、で落ちる。

- [ ] **Step 3: 実装**

`src/lib/drafts/submit-outcome.ts` の末尾に:

```ts
/**
 * 素の fetch を使う画面で、断られた応答を status つきの Error にする
 * (isDefiniteSubmitFailure が 4xx を見分けられるように)。
 */
export function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
```

`src/lib/drafts/reselect.ts`:

```ts
/** 控えから戻した画面で選び直したファイルが、前回と同じ名前か(設計書 §4.3)。 */
export function isSameFileName(expected: string, chosen: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase();
  return norm(expected) === norm(chosen);
}
```

`src/hooks/use-draft.ts` に追記(import は既存の `useSyncExternalStore` を使う):

```ts
const subscribeNothing = () => () => {};

/**
 * ブラウザで描き直した後なら true(サーバー描画と hydration 中は false)。
 * ⚠ページ(最初にサーバーで描かれる画面)で控えを読むときは、これが true になってから
 *   画面本体を作り直す(key を変える)。サーバー描画の結果と食い違わないようにするため。
 *   クライアント遷移(メニューで移ってきた)では最初から true なので作り直しは起きない。
 */
export function useClientReady(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}
```

`src/components/drafts/draft-notices.tsx` の末尾に(`import { isSameFileName } from "@/lib/drafts/reselect";` を先頭の import に足す):

```tsx
/**
 * 控えから戻した画面で、ファイル本体だけは戻せないので選び直しを求める(設計書 §4.3)。
 * 選んだ後は、名前が違うときだけ確かめる一文を出す(同じなら何も出さない)。
 */
export function DraftReselectFileNotice({ expectedName, chosenName }: { expectedName: string; chosenName: string | null }) {
  if (chosenName == null) {
    return (
      <div role="status" data-testid="draft-reselect-notice" className={WARN}>
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>PDF「{expectedName}」を選び直してください（登録のときに添付します。読み取った結果はそのまま使います）。</span>
      </div>
    );
  }
  if (isSameFileName(expectedName, chosenName)) return null;
  return (
    <div role="status" data-testid="draft-reselect-notice" className={WARN}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>前回と違う名前のファイルです（前回: {expectedName}）。同じ書類か確かめてください。</span>
    </div>
  );
}

/** 取り込み(CSV)の送信中に離れた(設計書 §5.1 S4)。内容は戻さず、履歴で確かめてもらう。 */
export function DraftImportPendingNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div role="alert" data-testid="draft-import-pending-notice" className={WARN}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>前回、取り込みの途中で画面を離れました。下の「取り込み履歴」で結果を確かめてください。</span>
      <button type="button" onClick={onDismiss} className={BTN}>
        閉じる
      </button>
    </div>
  );
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/drafts src/components/drafts > /tmp/kd2-t1.log 2>&1; echo exit=$?; tail -8 /tmp/kd2-t1.log`
Expected: `exit=0`。

- [ ] **Step 5: コミット**

```bash
git add src/hooks/use-draft.ts src/lib/drafts/submit-outcome.ts src/lib/drafts/reselect.ts src/components/drafts/draft-notices.tsx src/lib/drafts/__tests__ src/components/drafts/__tests__
git commit -m "feat(drafts): ページ用のブラウザ描画の合図・選び直しと取り込み途中の帯" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LYGLoZ3RCTWGGudbns69rp"
```

---

### Task 2: S1 貼り付けて物件化

**Files:**
- Create: `src/lib/drafts/screens/paste.ts`
- Modify: `src/components/import/paste-import-review.tsx:459-461,526-533`
- Modify: `src/app/(dashboard)/import/paste/page.tsx`
- Test: `src/lib/drafts/__tests__/screens-pr2.test.ts`(新規)・`src/lib/drafts/__tests__/pr2-wiring-source.test.ts`(新規)・`src/components/import/__tests__/paste-import-review.test.tsx`(追記)

**Interfaces:**
- Consumes: Task 1 の `useClientReady`・`httpError`・`DraftReselectFileNotice`。既存の `useRestoredDraft`・`useDraftAutosave`・`draftKey`・`isDefiniteSubmitFailure`・`DraftRestoredNotice`・`DraftPendingNotice`・`DraftTooLargeNotice`・`buildingChoiceSchema`。
- Produces:
  - `type PasteScreenDraft = { rev: 1; rawText: string; pdfFileName: string | null; review: PasteReviewDraft | null }`
  - `parsePasteDraft(d: unknown): PasteScreenDraft | null`
  - `isPasteDraftEmpty(d: PasteScreenDraft): boolean`
  - `compactPasteDraftForPending(): PasteScreenDraft`
  - `pdfReselectReason(d: { hasReview: boolean; pdfFileName: string | null; hasPdfFile: boolean }): string | null`
  - `PasteImportReview` の新しい props: `registerBlockedReason?: string | null`・`readOnly?: boolean`

- [ ] **Step 1: 純関数の失敗するテストを書く**

`src/lib/drafts/__tests__/screens-pr2.test.ts`(新規):

```ts
import { describe, it, expect } from "vitest";
import {
  compactPasteDraftForPending,
  isPasteDraftEmpty,
  parsePasteDraft,
  pdfReselectReason,
  type PasteScreenDraft,
} from "../screens/paste";

const review = {
  draft: { noteFromUnmapped: "", unreadable: [], property: {}, owner: null, externalLinkKey: null },
  duplicates: { blocked: false, blockedByPropertyId: null, similarPropertyIds: [] },
  similar: [{ id: "p1" }],
  ownerCandidates: [{ id: "o1", matchKind: "name_only" }],
  ownerCandidatesTruncated: false,
  extractedText: null,
  propertyValues: { address: "東京都港区1-1" },
  ownerValues: { name: "山田", nameKana: "", phone: "", email: "", currentAddress: "" },
  note: "メモ",
  externalLinkKey: "",
  ownerMode: "new",
  linkedOwner: null,
  buildingChoice: { kind: "auto" },
};

const full = { rev: 1, rawText: "お名前：山田", pdfFileName: null, review } as unknown as PasteScreenDraft;

describe("貼り付けて物件化の控え", () => {
  it("往復して同じ", () => {
    expect(parsePasteDraft(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });
  it("rev が違う・欠けた欄は捨てる(配布で形が変わった後の控え)", () => {
    expect(parsePasteDraft({ ...full, rev: 2 })).toBeNull();
    const { note: _n, ...noNote } = review;
    expect(parsePasteDraft({ ...full, review: noNote })).toBeNull();
    expect(parsePasteDraft({ ...full, review: { ...review, ownerMode: "x" } })).toBeNull();
    expect(parsePasteDraft(null)).toBeNull();
  });
  it("貼った文章も読み取り結果も無ければ空", () => {
    expect(isPasteDraftEmpty({ rev: 1, rawText: "  ", pdfFileName: null, review: null })).toBe(true);
    expect(isPasteDraftEmpty({ rev: 1, rawText: "a", pdfFileName: null, review: null })).toBe(false);
    expect(isPasteDraftEmpty({ ...full, rawText: "" })).toBe(false);
  });
  it("送信中の印だけを残す中身は空", () => {
    expect(isPasteDraftEmpty(compactPasteDraftForPending())).toBe(true);
  });
  it("PDFで読み取った確認画面を戻したときだけ、選び直すまで登録を止める", () => {
    expect(pdfReselectReason({ hasReview: true, pdfFileName: "a.pdf", hasPdfFile: false })).toBe("PDF「a.pdf」を選び直してください");
    expect(pdfReselectReason({ hasReview: true, pdfFileName: "a.pdf", hasPdfFile: true })).toBeNull();
    expect(pdfReselectReason({ hasReview: true, pdfFileName: null, hasPdfFile: false })).toBeNull();
    expect(pdfReselectReason({ hasReview: false, pdfFileName: "a.pdf", hasPdfFile: false })).toBeNull();
  });
});
```

`src/lib/drafts/__tests__/pr2-wiring-source.test.ts`(新規):

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

/** 既定の書き出しが、ブラウザで描き直した後に本体を作り直す形か。 */
function expectClientReadyGate(src: string, screen: string) {
  expect(src).toMatch(new RegExp(`const clientReady = useClientReady\\(\\);\\s*return <${screen} key=\\{clientReady \\? "client" : "server"\\} draftEnabled=\\{clientReady\\} />;`));
}

describe("貼り付けて物件化の配線", () => {
  const src = read("src/app/(dashboard)/import/paste/page.tsx");
  it("F5 でも食い違わない: 控えはブラウザで描き直した後だけ読む", () => {
    expectClientReadyGate(src, "PasteImportScreen");
    expect(src).toMatch(/draftEnabled \? draftKey\("paste"\) : null/);
  });
  it("登録の直前に送信中の印・成功で消す・4xx だけ印を外す", () => {
    expect(src).toMatch(/draftSaver\.markSubmitting\(\);[\s\S]{0,400}fetch\("\/api\/import\/paste\/commit"/);
    expect(src).toMatch(/draftSaver\.close\(\);\s*router\.push\(`\/properties\/\$\{result\.propertyId\}`\)/);
    expect(src).toMatch(/if \(isDefiniteSubmitFailure\(e\)\) draftSaver\.unmarkSubmitting\(\);\s*else setPendingBlocked\(true\);/);
    expect(src).toContain("throw httpError(await readApiErrorMessage(res), res.status)");
  });
  it("やり直しは discard・選び直しまで登録を止める", () => {
    expect(src).toMatch(/draftSaver\.discard\(\)/);
    expect(src).toContain("registerBlockedReason={");
    expect(src).toContain("pdfReselectReason(");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/drafts > /tmp/kd2-t2.log 2>&1; echo exit=$?; tail -20 /tmp/kd2-t2.log`
Expected: `exit=1`(`../screens/paste` が無い・配線が無い)。

- [ ] **Step 3: `src/lib/drafts/screens/paste.ts` を書く**

```ts
/** 貼り付けて物件化の控え(設計書 §2 S1)。 */
import { z } from "zod/v4";
import type { PasteDraft } from "@/lib/paste-import/types";
import type { BuildingChoice } from "@/lib/building-link/resolve";
// ⚠型だけ読む(部品の本体は読まない)。
import type {
  OwnerCandidateSummary,
  OwnerMatchKind,
  OwnerMode,
  OwnerValues,
  PasteDuplicatesResult,
  PropertyValues,
  SimilarPropertySummary,
} from "@/components/import/paste-import-review";
import { buildingChoiceSchema } from "./building-choice";

/** 読み取り後の確認画面の状態(サーバーの応答と人が直した値)。 */
export interface PasteReviewDraft {
  draft: PasteDraft;
  duplicates: PasteDuplicatesResult | null;
  similar: SimilarPropertySummary[];
  ownerCandidates: OwnerCandidateSummary[];
  ownerCandidatesTruncated: boolean;
  extractedText: string | null;
  propertyValues: PropertyValues;
  ownerValues: OwnerValues;
  note: string;
  externalLinkKey: string;
  ownerMode: OwnerMode;
  linkedOwner: { id: string; matchKindAtSelection: OwnerMatchKind } | null;
  buildingChoice: BuildingChoice;
}

/**
 * rev = 控えの形の版。PasteDraft など中身の型を変えたら上げる(古い控えを捨てるため)。
 * pdfFileName = 確認画面を PDF から作ったときのファイル名(登録で添付するので選び直しが要る)。
 */
export interface PasteScreenDraft {
  rev: 1;
  rawText: string;
  pdfFileName: string | null;
  review: PasteReviewDraft | null;
}

const MATCH_KINDS = ["current_address", "registry_address", "name_only"] as const;

// ⚠サーバーの応答の部分は、画面が実際に使う欄だけを確かめる(形を写しきると型の変更のたびに
//   ずれる)。足りない控えは捨てる=最初からやり直しになるだけで、画面は壊れない。
const reviewSchema = z.object({
  draft: z.looseObject({
    noteFromUnmapped: z.string(),
    unreadable: z.array(z.unknown()),
    property: z.looseObject({}),
  }),
  duplicates: z.looseObject({ blocked: z.boolean() }).nullable(),
  similar: z.array(z.looseObject({ id: z.string() })),
  ownerCandidates: z.array(z.looseObject({ id: z.string(), matchKind: z.enum(MATCH_KINDS) })),
  ownerCandidatesTruncated: z.boolean(),
  extractedText: z.string().nullable(),
  propertyValues: z.record(z.string(), z.string()),
  ownerValues: z.object({
    name: z.string(),
    nameKana: z.string(),
    phone: z.string(),
    email: z.string(),
    currentAddress: z.string(),
  }),
  note: z.string(),
  externalLinkKey: z.string(),
  ownerMode: z.enum(["link", "new", "none"]),
  linkedOwner: z.object({ id: z.string(), matchKindAtSelection: z.enum(MATCH_KINDS) }).nullable(),
  buildingChoice: buildingChoiceSchema,
});

const schema = z.object({
  rev: z.literal(1),
  rawText: z.string(),
  pdfFileName: z.string().nullable(),
  review: reviewSchema.nullable(),
});

export function parsePasteDraft(d: unknown): PasteScreenDraft | null {
  const r = schema.safeParse(d);
  // 検査を通った控えは、この画面が書いたものと同じ形(書き手はこの画面だけ)。
  return r.success ? (r.data as unknown as PasteScreenDraft) : null;
}

export function isPasteDraftEmpty(d: PasteScreenDraft): boolean {
  return d.rawText.trim() === "" && d.review === null;
}

/** 大きすぎて控えを止めた後に、送信中の印だけを残す中身(空)。 */
export function compactPasteDraftForPending(): PasteScreenDraft {
  return { rev: 1, rawText: "", pdfFileName: null, review: null };
}

/** PDF から作った確認画面を戻したとき、選び直すまで登録を止める理由(無ければ null)。 */
export function pdfReselectReason(d: { hasReview: boolean; pdfFileName: string | null; hasPdfFile: boolean }): string | null {
  if (!d.hasReview || d.pdfFileName == null || d.hasPdfFile) return null;
  return `PDF「${d.pdfFileName}」を選び直してください`;
}
```

- [ ] **Step 4: 純関数のテストが通ることを確かめる**

Run: `npx vitest run src/lib/drafts/__tests__/screens-pr2.test.ts > /tmp/kd2-t2.log 2>&1; echo exit=$?; tail -8 /tmp/kd2-t2.log`
Expected: `exit=0`。

- [ ] **Step 5: 確認画面の部品に「止める理由」「見るだけ」を足す(テスト先行)**

`src/components/import/__tests__/paste-import-review.test.tsx` に追記(既存の描画用の引数を作る関数があればそれを使う。無ければ同じファイルの既存テストが `PasteImportReview` に渡している props をそのまま写して `base` とする):

```tsx
describe("控えから戻したときの登録の止め", () => {
  it("registerBlockedReason があると登録ボタンが押せず、理由が文字で出る", () => {
    const html = renderToStaticMarkup(
      createElement(PasteImportReview, { ...base, onRegister: () => {}, registerBlockedReason: "PDF「a.pdf」を選び直してください" }),
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>この内容で登録<\/button>/);
    expect(html).toContain("PDF「a.pdf」を選び直してください");
  });
  it("readOnly のときは欄が触れない", () => {
    const html = renderToStaticMarkup(createElement(PasteImportReview, { ...base, readOnly: true }));
    expect(html).toMatch(/<input[^>]*disabled=""/);
  });
});
```

Run: `npx vitest run src/components/import/__tests__/paste-import-review.test.tsx > /tmp/kd2-t2.log 2>&1; echo exit=$?`
Expected: `exit=1`。

`src/components/import/paste-import-review.tsx` の `PasteImportReviewProps`(`registerError?: string | null;` の直後)に:

```ts
  /** 控えから戻した画面などで、登録を止める理由(PDFの選び直し・送信途中の確認待ち)。 */
  registerBlockedReason?: string | null;
  /** 入力欄を触れなくする(前回の登録が済んだか確かめるまで)。 */
  readOnly?: boolean;
```

分割代入に `registerBlockedReason, readOnly,` を足し、526〜533行を:

```ts
  const busy = Boolean(registering) || Boolean(readOnly);
  const blockReason = dup.blocked
    ? "この案件は登録済みのため登録できません"
    : ownerNameMissing
      ? "所有者の氏名を入力してください（所有者を作らない場合は「所有者なしで登録する」を選んでください）"
      : linkTargetMissing
        ? "紐付ける所有者が選ばれていません"
        : (registerBlockedReason ?? null);
```

登録ボタン直後の `{registerError && (...)}` の前に、止めた理由を文字で出す:

```tsx
          {registerBlockedReason && blockReason === registerBlockedReason && (
            <span className="text-sm text-amber-700 dark:text-amber-300">{registerBlockedReason}</span>
          )}
```

Run: `npx vitest run src/components/import/__tests__/paste-import-review.test.tsx > /tmp/kd2-t2.log 2>&1; echo exit=$?`
Expected: `exit=0`。

- [ ] **Step 6: ページに組み込む**

`src/app/(dashboard)/import/paste/page.tsx`:

1. import を足す:
```ts
import { useMemo } from "react"; // 既存の import { useCallback, useState } に useMemo を足す
import { draftKey } from "@/lib/drafts/draft-store";
import { httpError, isDefiniteSubmitFailure } from "@/lib/drafts/submit-outcome";
import {
  compactPasteDraftForPending,
  isPasteDraftEmpty,
  parsePasteDraft,
  pdfReselectReason,
  type PasteScreenDraft,
} from "@/lib/drafts/screens/paste";
import { useClientReady, useDraftAutosave, useRestoredDraft } from "@/hooks/use-draft";
import {
  DraftPendingNotice,
  DraftReselectFileNotice,
  DraftRestoredNotice,
  DraftTooLargeNotice,
} from "@/components/drafts/draft-notices";
```

2. `export default function PasteImportPage() {` を `function PasteImportScreen({ draftEnabled }: { draftEnabled: boolean }) {` に変え、ファイルの**末尾**に既定の書き出しを置く(⚠ `page-pii.test.tsx` は最初の `\n  return (` を画面の最上位とみなすので、書き出しは本体より後ろに置き、`return (` の形にしない):

```tsx
/**
 * 控えはブラウザで描き直した後だけ読む(F5 でサーバー描画と食い違わないように)。
 * クライアント遷移では最初から "client" なので作り直しは起きない。
 */
export default function PasteImportPage() {
  const clientReady = useClientReady();
  return <PasteImportScreen key={clientReady ? "client" : "server"} draftEnabled={clientReady} />;
}
```

3. 本体の先頭(`const router = useRouter();` の直後)で控えを読み、各 state の初期値にする:

```tsx
  // 作業中の控え。別のメニューへ移って戻っても続きから(設計書 2026-10-13 §2 S1)。
  const draftKeyValue = draftEnabled ? draftKey("paste") : null;
  const restored = useRestoredDraft(draftKeyValue, parsePasteDraft);
  const r0 = restored?.data.review ?? null;
```

既存の useState を次のように初期値つきへ置き換える(並びと注釈はそのまま):

```tsx
  const [rawText, setRawText] = useState(restored?.data.rawText ?? "");
  // ...
  const [draft, setDraft] = useState<PasteDraft | null>(r0?.draft ?? null);
  const [duplicates, setDuplicates] = useState<PasteDuplicatesResult | null>(r0?.duplicates ?? null);
  const [similar, setSimilar] = useState<SimilarPropertySummary[]>(r0?.similar ?? []);
  const [ownerCandidates, setOwnerCandidates] = useState<OwnerCandidateSummary[]>(r0?.ownerCandidates ?? []);
  const [ownerCandidatesTruncated, setOwnerCandidatesTruncated] = useState(r0?.ownerCandidatesTruncated ?? false);
  const [extractedText, setExtractedText] = useState<string | null>(r0?.extractedText ?? null);
  const [propertyValues, setPropertyValues] = useState<PropertyValues | null>(r0?.propertyValues ?? null);
  const [ownerValues, setOwnerValues] = useState<OwnerValues | null>(r0?.ownerValues ?? null);
  const [note, setNote] = useState(r0?.note ?? "");
  const [externalLinkKey, setExternalLinkKey] = useState(r0?.externalLinkKey ?? "");
  const [ownerMode, setOwnerMode] = useState<OwnerMode>(r0?.ownerMode ?? "none");
  const [linkedOwner, setLinkedOwner] = useState<...>(r0?.linkedOwner ?? null); // 型注釈は既存のまま
  const [buildingChoice, setBuildingChoice] = useState<BuildingChoice>(r0?.buildingChoice ?? AUTO_CHOICE);
```

その下に足す:

```tsx
  /** 戻した確認画面が PDF から作ったもののとき、そのファイル名(選び直すまで登録できない)。 */
  const [reselectName, setReselectName] = useState<string | null>(r0 ? (restored?.data.pdfFileName ?? null) : null);
  // 前回、登録の返事が来る前に離れた=登録されたか分からない。確かめるまで見るだけにする(§5.1)。
  const [pendingBlocked, setPendingBlocked] = useState(restored?.pendingSubmit != null);
  const [restoredDismissed, setRestoredDismissed] = useState(false);

  const draftData = useMemo<PasteScreenDraft>(
    () => ({
      rev: 1,
      rawText,
      pdfFileName: draft ? (pdfFile?.name ?? reselectName) : null,
      review:
        draft && propertyValues && ownerValues
          ? {
              draft, duplicates, similar, ownerCandidates, ownerCandidatesTruncated, extractedText,
              propertyValues, ownerValues, note, externalLinkKey, ownerMode, linkedOwner, buildingChoice,
            }
          : null,
    }),
    [
      rawText, pdfFile, reselectName, draft, duplicates, similar, ownerCandidates, ownerCandidatesTruncated,
      extractedText, propertyValues, ownerValues, note, externalLinkKey, ownerMode, linkedOwner, buildingChoice,
    ],
  );
  const draftSaver = useDraftAutosave(draftKeyValue, draftData, isPasteDraftEmpty, restored, {
    compactForPending: compactPasteDraftForPending,
  });
  const reselectReason = pdfReselectReason({ hasReview: draft !== null, pdfFileName: reselectName, hasPdfFile: pdfFile !== null });
```

⚠ 変数名: 既存の state `draft`(読み取り結果)と衝突するので、自動保存の戻り値は **`draftSaver`** と呼ぶ(第1段の小窓は `draft`。この計画の4画面はすべて `draftSaver` にそろえる)。

4. `handleRead` の成功時の setState の並びの最後に `setReselectName(null);` を足す(読み直したら選び直しは不要)。

5. `handleRegister` の中:
   - `if (!res.ok) throw new Error(await readApiErrorMessage(res));`(commit の直後の1か所だけ)を `if (!res.ok) throw httpError(await readApiErrorMessage(res), res.status);` に変える。
   - `let res: Response;`(commit の直前)の**直前**に:
     ```ts
      // 返事が来る前に離れたら、戻ったとき「登録されたか確かめて」と出す(二重登録を防ぐ・§5.1)。
      draftSaver.markSubmitting();
     ```
   - `stashBuildingLinkNotice(...)` の後・`router.push` の直前に `draftSaver.close();`。
   - `catch (e) {` の先頭に:
     ```ts
      // ⚠markSubmitting の前(見直しの段階)で止まったときは印が無いので何も起きない。
      if (isDefiniteSubmitFailure(e)) draftSaver.unmarkSubmitting();
      else setPendingBlocked(true);
     ```
     ⚠見直し(recheck)が `return` で止まる経路は catch に来ないので印は書かれない(markSubmitting は commit の直前だけ)。
   - 先頭のガード(`if (!draft || ...) return;`)の直後に `if (reselectReason || pendingBlocked) return;` を足す。
   - useCallback の依存配列に `reselectReason, pendingBlocked, draftSaver` を足す。

6. 「最初からやり直す」:
```tsx
  const handleDiscardDraft = () => {
    draftSaver.discard();
    setRawText("");
    setPdfFile(null);
    setReselectName(null);
    setDraft(null);
    setDuplicates(null);
    setSimilar([]);
    setOwnerCandidates([]);
    setOwnerCandidatesTruncated(false);
    setExtractedText(null);
    setPropertyValues(null);
    setOwnerValues(null);
    setNote("");
    setExternalLinkKey("");
    setOwnerMode("none");
    setLinkedOwner(null);
    setRecheckError(null);
    setRegisterError(null);
    setBuildingChoice(AUTO_CHOICE);
    setRestoredDismissed(true);
  };
```
   「← 貼り直す」ボタンの onClick の最後に `setReselectName(null);` を足す。

7. 描画: `<PageHeader ... />` の直後に帯:
```tsx
      {pendingBlocked ? (
        <DraftPendingNotice
          onConfirm={() => {
            draftSaver.unmarkSubmitting();
            setPendingBlocked(false);
          }}
        />
      ) : (
        restored && !restoredDismissed && <DraftRestoredNotice savedAt={restored.savedAt} onDiscard={handleDiscardDraft} />
      )}
      {draftSaver.tooLarge && <DraftTooLargeNotice kind="input" />}
```
   確認画面(`{draft && propertyValues && ownerValues && (<>`)の「← 貼り直す」の div の直後に、選び直しの枠:
```tsx
          {reselectName && (
            <div className="space-y-2">
              <DraftReselectFileNotice expectedName={reselectName} chosenName={pdfFile?.name ?? null} />
              <FileDropZone
                accept="application/pdf,.pdf"
                disabled={registering}
                icon={FileText}
                title="PDFファイルをここにドラッグ＆ドロップ"
                fileName={pdfFile?.name ?? null}
                // ⚠読み取りはし直さない(結果はそのまま・設計書 §4.3)。
                onFiles={(files) => setPdfFile(files[0])}
                onNoneAccepted={() => setPdfFile(null)}
              />
            </div>
          )}
```
   `<PasteImportReview` に `registerBlockedReason={pendingBlocked ? "前回の登録が済んだか確かめてください" : reselectReason}` と `readOnly={pendingBlocked}` を足す。

- [ ] **Step 7: 通ることを確かめる**

Run: `npx vitest run src/lib/drafts "src/app/(dashboard)/import/paste" src/components/import > /tmp/kd2-t2.log 2>&1; echo exit=$?; tail -8 /tmp/kd2-t2.log`
Expected: `exit=0`(既存の `page-pii.test.tsx` も緑=既定の書き出しはサーバー描画で `draftEnabled=false` の本体を描く)。
Run: `npx tsc --noEmit > /tmp/kd2-tsc.log 2>&1; echo exit=$?` → Expected: `exit=0`。
Run: `npx eslint "src/app/(dashboard)/import/paste/page.tsx" src/lib/drafts src/components/import/paste-import-review.tsx` → Expected: エラー 0。

- [ ] **Step 8: コミット**

```bash
git add src/lib/drafts "src/app/(dashboard)/import/paste/page.tsx" src/components/import/paste-import-review.tsx src/components/import/__tests__/paste-import-review.test.tsx
git commit -m "feat(drafts): 貼り付けて物件化の途中を控えて戻す(PDFは選び直し)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LYGLoZ3RCTWGGudbns69rp"
```

---

### Task 3: S2 Excelからまとめて物件化

**Files:**
- Create: `src/lib/drafts/screens/paste-excel.ts`
- Modify: `src/hooks/use-draft.ts`(`writeNow` を足す)
- Modify: `src/components/import/excel-lead-table.tsx:26-31,37-75,106-`
- Modify: `src/app/(dashboard)/import/paste/excel/page.tsx`
- Test: `src/lib/drafts/__tests__/screens-pr2.test.ts`(追記)・`src/lib/drafts/__tests__/pr2-wiring-source.test.ts`(追記)・`src/app/(dashboard)/import/paste/excel/__tests__/page.test.tsx`(追記)

**Interfaces:**
- Consumes: Task 1 の `useClientReady`。既存の `useRestoredDraft`・`useDraftAutosave`・`draftKey`・`DraftRestoredNotice`・`DraftTooLargeNotice`。
- Produces:
  - `ExcelLeadResult` に `{ kind: "unknown" }` を足す。
  - `type PasteExcelDraft = { rev: 1; fileName: string | null; rows: ExcelLeadRow[]; results: Record<string, ExcelLeadResult>; sendingKey: string | null }`
  - `parsePasteExcelDraft(d: unknown): PasteExcelDraft | null`
  - `isPasteExcelDraftEmpty(d: PasteExcelDraft | null): boolean`(画面は rows が無いとき `null` を渡さず空の形を渡す=下の実装を見る)
  - `restoreExcelResults(results: Record<string, ExcelLeadResult>, sendingKey: string | null): Record<string, ExcelLeadResult>`
  - `ExcelLeadTable` の新しい props: `onReturnUnknown?: (rowKey: string) => void`
  - `useDraftAutosave(...)` の戻り値に `writeNow(d: T): void`(間引きを待たずにすぐ書く)

- [ ] **Step 1: 失敗するテストを書く**

`screens-pr2.test.ts` に追記:

```ts
import {
  isPasteExcelDraftEmpty,
  parsePasteExcelDraft,
  restoreExcelResults,
} from "../screens/paste-excel";

describe("Excelまとめ取込の控え", () => {
  const row = {
    sheetName: "HOME4U", rowNumber: 3, text: "お名前：山田", draft: { noteFromUnmapped: "" },
    ownerNote: "", status: "ready", reasons: [], registeredPropertyId: null,
  };
  const d = { rev: 1, fileName: "表.xlsx", rows: [row], results: { "HOME4U#3": { kind: "created", propertyId: "p1" } }, sendingKey: null };

  it("往復して同じ・形違いは捨てる", () => {
    expect(parsePasteExcelDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parsePasteExcelDraft({ ...d, rev: 2 })).toBeNull();
    expect(parsePasteExcelDraft({ ...d, results: { x: { kind: "nope" } } })).toBeNull();
    expect(parsePasteExcelDraft({ ...d, rows: [{ ...row, status: "x" }] })).toBeNull();
  });
  it("行が無ければ空", () => {
    expect(isPasteExcelDraftEmpty({ rev: 1, fileName: "a.xlsx", rows: [], results: {}, sendingKey: null })).toBe(true);
    expect(isPasteExcelDraftEmpty(d as never)).toBe(false);
  });

  // 総当たり: 送信中の行の有無 × その行の結果の有無 × 他の行の結果
  const cases: Array<[string, Record<string, { kind: string }>, string | null, Record<string, string>]> = [
    ["送信中なし", { a: { kind: "created" } }, null, { a: "created" }],
    ["送信中の行は結果なし→unknown", {}, "b", { b: "unknown" }],
    ["送信中の行に結果が届いていればそのまま", { b: { kind: "failed" } }, "b", { b: "failed" }],
    ["他の行の結果は残す", { a: { kind: "duplicate" } }, "b", { a: "duplicate", b: "unknown" }],
  ];
  it.each(cases)("%s", (_n, results, sending, expected) => {
    const out = restoreExcelResults(results as never, sending);
    expect(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.kind]))).toEqual(expected);
  });
});
```

`pr2-wiring-source.test.ts` に追記:

```ts
describe("Excelまとめ取込の配線", () => {
  const src = read("src/app/(dashboard)/import/paste/excel/page.tsx");
  it("F5 でも食い違わない", () => {
    expectClientReadyGate(src, "ExcelLeadImportScreen");
    expect(src).toMatch(/draftEnabled \? draftKey\("paste-excel"\) : null/);
  });
  it("送る行を控えにすぐ書いてから送り、結果が来たら外す", () => {
    expect(src).toMatch(
      /setSendingKey\(key\);\s*draftSaver\.writeNow\(\{ \.\.\.draftDataRef\.current, sendingKey: key \}\);[\s\S]{0,600}fetch\("\/api\/import\/paste\/commit"[\s\S]{0,600}setSendingKey\(null\);/,
    );
  });
  it("画面を離れたら次の行を送らない(§5.2)", () => {
    expect(src).toMatch(/useEffect\(\(\) => \(\) => \{\s*stopRef\.current = true;\s*\}, \[\]\);/);
  });
  it("戻したとき送信中だった行は分からない扱い", () => {
    expect(src).toContain("restoreExcelResults(");
  });
});
```

`src/lib/drafts/__tests__/use-draft-source.test.ts` の describe の中に追記:

```ts
  it("writeNow は間引きを待たずにすぐ書く(送る直前の印)", () => {
    expect(src).toMatch(/writeNow: \(d: T\) => \{\s*writer\?\.update\(d\);\s*writer\?\.flush\(\);/);
  });
```

`excel/__tests__/page.test.tsx` に追記(ファイル内の `mk` を使う):

```tsx
  it("登録されたか分からない行: 理由と「登録の対象に戻す」ボタンが出る", () => {
    const row = mk({});
    const html = renderToStaticMarkup(
      createElement(ExcelLeadTable, { rows: [row], results: { [`${row.sheetName}#${row.rowNumber}`]: { kind: "unknown" } }, onReturnUnknown: () => {} }),
    );
    expect(html).toContain("登録されたか分かりません");
    expect(html).toContain("物件一覧で確かめてください");
    expect(html).toContain("確かめたので登録の対象に戻す");
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/drafts src/hooks "src/app/(dashboard)/import/paste/excel" > /tmp/kd2-t3.log 2>&1; echo exit=$?; tail -20 /tmp/kd2-t3.log`
Expected: `exit=1`。

- [ ] **Step 3: 表に `unknown` を足す**

`src/components/import/excel-lead-table.tsx` の `ExcelLeadResult` に:

```ts
  /** 送った直後に画面を離れ、登録されたか分からない(設計書 §5.2)。まとめて登録の対象から外す。 */
  | { kind: "unknown" }
```

`StatusCell` の引数に `onReturnUnknown?: () => void` を足し、`if (result?.kind === "failed")` の前に:

```tsx
  if (result?.kind === "unknown") {
    return (
      <div className="space-y-1">
        <StatusBadge intent="warning">登録されたか分かりません</StatusBadge>
        <p className="text-xs text-amber-800 dark:text-amber-300">
          送っている途中で画面を離れました。物件一覧で確かめてください。
        </p>
        {onReturnUnknown && (
          <button type="button" onClick={onReturnUnknown} className="text-xs text-indigo-600 underline dark:text-indigo-400">
            確かめたので登録の対象に戻す
          </button>
        )}
      </div>
    );
  }
```

`ExcelLeadTable` の props に `onReturnUnknown?: (rowKey: string) => void;` を足し、`<StatusCell row={row} result={result} />` を `<StatusCell row={row} result={result} onReturnUnknown={onReturnUnknown ? () => onReturnUnknown(excelLeadRowKey(row)) : undefined} />` にする(実際の呼び出し箇所の書き方に合わせる)。

- [ ] **Step 4: `src/lib/drafts/screens/paste-excel.ts` を書く**

```ts
/** Excelからまとめて物件化の控え(設計書 §2 S2・§5.2)。 */
import { z } from "zod/v4";
import type { ExcelLeadResult, ExcelLeadRow } from "@/components/import/excel-lead-table";

/**
 * sendingKey = いま送っている行(結果が来る前に画面を離れたら、戻ったとき「分からない」にする)。
 * ファイル本体は持たない(読み取った後は不要)。
 */
export interface PasteExcelDraft {
  rev: 1;
  fileName: string | null;
  rows: ExcelLeadRow[];
  results: Record<string, ExcelLeadResult>;
  sendingKey: string | null;
}

const rowSchema = z.looseObject({
  sheetName: z.string(),
  rowNumber: z.number(),
  text: z.string(),
  draft: z.looseObject({}),
  ownerNote: z.string(),
  status: z.enum(["ready", "review", "registered"]),
  reasons: z.array(z.string()),
  registeredPropertyId: z.string().nullable(),
});

const resultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), propertyId: z.string() }),
  z.object({ kind: z.literal("duplicate") }),
  z.object({ kind: z.literal("review"), reasons: z.array(z.string()) }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
  z.object({ kind: z.literal("unknown") }),
]);

const schema = z.object({
  rev: z.literal(1),
  fileName: z.string().nullable(),
  rows: z.array(rowSchema),
  results: z.record(z.string(), resultSchema),
  sendingKey: z.string().nullable(),
});

export function parsePasteExcelDraft(d: unknown): PasteExcelDraft | null {
  const r = schema.safeParse(d);
  return r.success ? (r.data as unknown as PasteExcelDraft) : null;
}

export function isPasteExcelDraftEmpty(d: PasteExcelDraft): boolean {
  return d.rows.length === 0;
}

/**
 * 戻したときの行ごとの結果。送っている途中だった行に結果が無ければ「分からない」にする
 * (まとめて登録の対象から外れる=二重登録を防ぐ)。結果が届いていればそのまま。
 */
export function restoreExcelResults(
  results: Record<string, ExcelLeadResult>,
  sendingKey: string | null,
): Record<string, ExcelLeadResult> {
  if (sendingKey == null || results[sendingKey] !== undefined) return results;
  return { ...results, [sendingKey]: { kind: "unknown" } };
}
```

⚠ `LeadRowStatus` の値が `"ready" | "review" | "registered"` であることを `src/lib/paste-import/lead-sheet.ts` で確かめる。違えば `z.enum` を実際の値に合わせ、台帳に Ruling を残す。

- [ ] **Step 5: ページに組み込む**

`src/app/(dashboard)/import/paste/excel/page.tsx`:

1. import: `useEffect, useMemo` を react の import に足す。加えて:
```ts
import { draftKey } from "@/lib/drafts/draft-store";
import {
  isPasteExcelDraftEmpty,
  parsePasteExcelDraft,
  restoreExcelResults,
  type PasteExcelDraft,
} from "@/lib/drafts/screens/paste-excel";
import { useClientReady, useDraftAutosave, useRestoredDraft } from "@/hooks/use-draft";
import { DraftRestoredNotice, DraftTooLargeNotice } from "@/components/drafts/draft-notices";
```

2. `export default function ExcelLeadImportPage() {` → `function ExcelLeadImportScreen({ draftEnabled }: { draftEnabled: boolean }) {`。末尾に:
```tsx
/** 控えはブラウザで描き直した後だけ読む(F5 でサーバー描画と食い違わないように)。 */
export default function ExcelLeadImportPage() {
  const clientReady = useClientReady();
  return <ExcelLeadImportScreen key={clientReady ? "client" : "server"} draftEnabled={clientReady} />;
}
```

3. 本体の先頭:
```tsx
  // 作業中の控え(設計書 §2 S2)。読み取った行と行ごとの結果を残す。
  const draftKeyValue = draftEnabled ? draftKey("paste-excel") : null;
  const restored = useRestoredDraft(draftKeyValue, parsePasteExcelDraft);
  const [file, setFile] = useState<File | null>(null);
  /** 戻したときのファイル名(ファイル本体は戻せないが、読み取り済みなので不要)。 */
  const [restoredFileName, setRestoredFileName] = useState<string | null>(restored?.data.fileName ?? null);
  const [rows, setRows] = useState<ExcelLeadRow[] | null>(restored ? restored.data.rows : null);
  const [results, setResults] = useState<Record<string, ExcelLeadResult>>(
    restored ? restoreExcelResults(restored.data.results, restored.data.sendingKey) : {},
  );
  /** いま送っている行。結果が来る前に離れたら、戻ったとき「分からない」になる(§5.2)。 */
  const [sendingKey, setSendingKey] = useState<string | null>(null);
  const [restoredDismissed, setRestoredDismissed] = useState(false);
```
(既存の `file`・`rows`・`results` の useState はこれに置き換える。他の state はそのまま。)

その下:
```tsx
  const draftData = useMemo<PasteExcelDraft>(
    () => ({ rev: 1, fileName: file?.name ?? restoredFileName, rows: rows ?? [], results, sendingKey }),
    [file, restoredFileName, rows, results, sendingKey],
  );
  const draftSaver = useDraftAutosave(draftKeyValue, draftData, isPasteExcelDraftEmpty, restored);

  // ⚠画面を離れたら、いま送っている行で止める(裏で送り続けない・§5.2)。
  useEffect(() => () => {
    stopRef.current = true;
  }, []);
```
⚠ この effect は `const stopRef = useRef(false);` より**後ろ**に置く。

4. `handleRead` 成功時に `setRestoredFileName(null);` を足す。FileDropZone の `onFiles` と `onNoneAccepted` にも `setRestoredFileName(null);` を足し、`fileName={file?.name ?? null}` を `fileName={file?.name ?? restoredFileName}` にする。

5. 送る直前に控えを**すぐ**書く仕組み。`setSendingKey` は state なので、控えに届くのは次の描画の後の effect(しかも約1秒の間引き)になる。返事の前に離れると間に合わないことがあるため、書き手に直接渡す。

   `src/hooks/use-draft.ts` の `useDraftAutosave` の戻り値に足す:
```ts
    /** 今の内容をすぐ書く(送る直前など、間引きを待てないとき)。 */
    writeNow: (d: T) => {
      writer?.update(d);
      writer?.flush();
    },
```
   ページでは、最新の控えの形を ref で持つ(⚠描画中に ref を書くと lint `react-hooks/refs` に当たるので effect で更新する):
```tsx
  const draftDataRef = useRef(draftData);
  useEffect(() => {
    draftDataRef.current = draftData;
  }, [draftData]);
```
   `handleRegisterAll` のループ:
```tsx
      const row = targets[i];
      const key = excelLeadRowKey(row);
      // 送る行を控えにすぐ書いてから送る(返事の前に離れても、戻ったとき二重に送らない)。
      setSendingKey(key);
      draftSaver.writeNow({ ...draftDataRef.current, sendingKey: key });
      let result: ExcelLeadResult;
      try {
        // ⚠重複の確認は登録APIの中で行う(既存の注釈はそのまま残す)。
        const res = await fetch("/api/import/paste/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(excelLeadCommitBody(row)),
        });
        result = commitOutcome(res.status, await res.json().catch(() => null));
      } catch (e) {
        result = { kind: "failed", message: e instanceof Error ? e.message : "通信に失敗しました" };
      }
      setResults((prev) => ({ ...prev, [key]: result }));
      setSendingKey(null);
      setProgress(i + 1);
```
   結果の後は通常の間引きで書かれる。離れた瞬間は unmount の flush で最新の state(送信中の行が残っていればそれ)が書かれる。

6. 「対象に戻す」と「最初からやり直す」:
```tsx
  const handleReturnUnknown = (rowKey: string) => {
    setResults((prev) => {
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
  };
  const handleDiscardDraft = () => {
    draftSaver.discard();
    setFile(null);
    setRestoredFileName(null);
    setRows(null);
    setResults({});
    setReadError(null);
    setRestoredDismissed(true);
  };
```
   `<ExcelLeadTable rows={rows} results={results} />` に `onReturnUnknown={running ? undefined : handleReturnUnknown}` を足す。

7. 帯: `<PageHeader ... />` の直後に
```tsx
      {restored && !restoredDismissed && <DraftRestoredNotice savedAt={restored.savedAt} onDiscard={handleDiscardDraft} />}
      {draftSaver.tooLarge && <DraftTooLargeNotice />}
```
   「最初からやり直す」ボタンは送信中(`running`)には押させない: `DraftRestoredNotice` の表示条件に `&& !running` を足す。

8. 「登録の繰り返しが終わった」=控えは消さない(登録済みの印を残し、もう一度押すと残りだけ登録する=設計書 §5.2)。

- [ ] **Step 6: 通ることを確かめる**

Run: `npx vitest run src/lib/drafts src/hooks "src/app/(dashboard)/import/paste" src/components/import > /tmp/kd2-t3.log 2>&1; echo exit=$?; tail -8 /tmp/kd2-t3.log`
Expected: `exit=0`(既存の「最上位に PII 保護の印」テストも緑)。
`npx tsc --noEmit` → exit=0。`npx eslint` を変更ファイルに → 0。

- [ ] **Step 7: コミット**

```bash
git add src/lib/drafts src/hooks/use-draft.ts "src/app/(dashboard)/import/paste/excel" src/components/import/excel-lead-table.tsx
git commit -m "feat(drafts): Excelまとめ取込の行と結果を控える・送信途中の行は分からない扱い" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LYGLoZ3RCTWGGudbns69rp"
```

---

### Task 4: S3 謄本PDFの取り込み

**Files:**
- Create: `src/lib/drafts/screens/registry-pdf.ts`
- Modify: `src/app/(dashboard)/import/registry-pdf/page.tsx`
- Test: `screens-pr2.test.ts`・`pr2-wiring-source.test.ts`(追記)

**Interfaces:**
- Consumes: Task 1 の `useClientReady`・`DraftReselectFileNotice`。既存の `useRestoredDraft`・`useDraftAutosave`・`isDefiniteSubmitFailure`(`api-client` の失敗は `status` を持つ)・`DraftPendingNotice`・`DraftRestoredNotice`・`DraftTooLargeNotice`。
- Produces:
  - `type RegistryPdfDraft`(下のコード)
  - `parseRegistryPdfDraft(d: unknown): RegistryPdfDraft | null`
  - `isRegistryPdfDraftEmpty(d: RegistryPdfDraft): boolean`
  - `compactRegistryPdfDraftForPending(): RegistryPdfDraft`
  - `registryNeedsReselect(d: { step: string; uploadTab: "file" | "text"; fromFile: boolean; hasFile: boolean }): boolean`

- [ ] **Step 1: 失敗するテストを書く**

`screens-pr2.test.ts` に追記:

```ts
import {
  compactRegistryPdfDraftForPending,
  isRegistryPdfDraftEmpty,
  parseRegistryPdfDraft,
  registryNeedsReselect,
} from "../screens/registry-pdf";

describe("謄本PDF取込の控え", () => {
  const d = {
    rev: 1, step: "confirm", uploadTab: "file", text: "", fileName: "謄本.pdf", fromFile: true,
    fields: { address: { value: "東京都", confidence: "high" } },
    owners: [{ name: "山田", address: "", share: "" }], warnings: [], isLikelyScanned: false,
    embeddedTextLength: 1200, target: "existing", existingPropertyId: "p1", propertySearchQuery: "港区",
    existingProperty: { id: "p1", address: "港区1-1", lotNumber: null, realEstateNumber: null },
  };
  it("往復して同じ・形違いは捨てる", () => {
    expect(parseRegistryPdfDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parseRegistryPdfDraft({ ...d, step: "result" })).toBeNull();
    expect(parseRegistryPdfDraft({ ...d, fields: { a: { value: "x", confidence: "?" } } })).toBeNull();
    expect(parseRegistryPdfDraft({ ...d, rev: 2 })).toBeNull();
  });
  it("最初の段階で文章も無ければ空(ファイルだけ選んだ状態は戻せないので控えない)", () => {
    const empty = compactRegistryPdfDraftForPending();
    expect(isRegistryPdfDraftEmpty(empty)).toBe(true);
    expect(isRegistryPdfDraftEmpty({ ...empty, fileName: "a.pdf", fromFile: true })).toBe(true);
    expect(isRegistryPdfDraftEmpty({ ...empty, text: "所在" })).toBe(false);
    expect(isRegistryPdfDraftEmpty(d as never)).toBe(false);
  });
  it.each([
    ["upload", "file", true, false, false],
    ["extract", "file", true, false, true],
    ["confirm", "file", true, false, true],
    ["confirm", "file", true, true, false],
    ["confirm", "text", false, false, false],
  ] as const)("段階 %s・%s・ファイルで読んだ=%s・ファイルあり=%s → 選び直し=%s", (step, uploadTab, fromFile, hasFile, expected) => {
    expect(registryNeedsReselect({ step, uploadTab, fromFile, hasFile })).toBe(expected);
  });
});
```

`pr2-wiring-source.test.ts` に追記:

```ts
describe("謄本PDF取込の配線", () => {
  const src = read("src/app/(dashboard)/import/registry-pdf/page.tsx");
  it("F5 でも食い違わない", () => {
    expectClientReadyGate(src, "RegistryPdfScreen");
    expect(src).toMatch(/draftEnabled \? draftKey\("registry-pdf"\) : null/);
  });
  it("取り込みの直前に送信中の印・成功で消す(続けて取り込めるよう discard)・4xx だけ印を外す", () => {
    expect(src).toMatch(/draftSaver\.markSubmitting\(\);[\s\S]{0,300}importRegistryPdf/);
    expect(src).toMatch(/draftSaver\.discard\(\);\s*setResult\(json as ImportResult\);/);
    expect(src).toMatch(/if \(isDefiniteSubmitFailure\(err\)\) draftSaver\.unmarkSubmitting\(\);\s*else setPendingBlocked\(true\);/);
  });
  it("ファイルを選び直すまで「登録実行」を押せない", () => {
    expect(src).toMatch(/disabled=\{importing \|\| needsReselect \|\| pendingBlocked\}/);
    expect(src).toContain("<DraftReselectFileNotice");
  });
  it("キャンセル(最初に戻る)で控えを消す", () => {
    expect(src).toMatch(/const handleReset = \(\) => \{\s*draftSaver\.discard\(\);/);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/drafts > /tmp/kd2-t4.log 2>&1; echo exit=$?`
Expected: `exit=1`。

- [ ] **Step 3: `src/lib/drafts/screens/registry-pdf.ts`**

```ts
/** 謄本PDFの取り込みの控え(設計書 §2 S3)。結果の段階(取り込み後)は控えない。 */
import { z } from "zod/v4";

export type RegistryDraftStep = "upload" | "extract" | "confirm";

export interface RegistryPdfDraft {
  rev: 1;
  step: RegistryDraftStep;
  uploadTab: "file" | "text";
  text: string;
  fileName: string | null;
  /** ファイルを読んで解析した(取り込みのときもう一度ファイルが要る)。 */
  fromFile: boolean;
  fields: Record<string, { value: string; confidence: "high" | "medium" | "low" }>;
  owners: { name: string; address: string; share: string }[];
  warnings: string[];
  isLikelyScanned: boolean;
  embeddedTextLength: number | null;
  target: "new" | "existing" | "auto";
  existingPropertyId: string;
  propertySearchQuery: string;
  /** 選んであった既存の物件(検索結果は控えないので、選んだ1件だけ持つ)。 */
  existingProperty: { id: string; address: string; lotNumber: string | null; realEstateNumber: string | null } | null;
}

const schema = z.object({
  rev: z.literal(1),
  step: z.enum(["upload", "extract", "confirm"]),
  uploadTab: z.enum(["file", "text"]),
  text: z.string(),
  fileName: z.string().nullable(),
  fromFile: z.boolean(),
  fields: z.record(z.string(), z.object({ value: z.string(), confidence: z.enum(["high", "medium", "low"]) })),
  owners: z.array(z.object({ name: z.string(), address: z.string(), share: z.string() })),
  warnings: z.array(z.string()),
  isLikelyScanned: z.boolean(),
  embeddedTextLength: z.number().nullable(),
  target: z.enum(["new", "existing", "auto"]),
  existingPropertyId: z.string(),
  propertySearchQuery: z.string(),
  existingProperty: z
    .object({ id: z.string(), address: z.string(), lotNumber: z.string().nullable(), realEstateNumber: z.string().nullable() })
    .nullable(),
});

export function parseRegistryPdfDraft(d: unknown): RegistryPdfDraft | null {
  const r = schema.safeParse(d);
  return r.success ? r.data : null;
}

/** 最初の段階で貼った文章も無い=控える意味が無い(ファイル本体は戻せない)。 */
export function isRegistryPdfDraftEmpty(d: RegistryPdfDraft): boolean {
  return d.step === "upload" && d.text.trim() === "";
}

export function compactRegistryPdfDraftForPending(): RegistryPdfDraft {
  return {
    rev: 1, step: "upload", uploadTab: "file", text: "", fileName: null, fromFile: false,
    fields: {}, owners: [], warnings: [], isLikelyScanned: false, embeddedTextLength: null,
    target: "auto", existingPropertyId: "", propertySearchQuery: "", existingProperty: null,
  };
}

/** ファイルで読んだ結果を戻した(読み取り後の段階)のに、ファイル本体が無い。 */
export function registryNeedsReselect(d: { step: string; uploadTab: "file" | "text"; fromFile: boolean; hasFile: boolean }): boolean {
  return d.step !== "upload" && d.uploadTab === "file" && d.fromFile && !d.hasFile;
}
```

- [ ] **Step 4: 純関数のテストが通ることを確かめる**

Run: `npx vitest run src/lib/drafts/__tests__/screens-pr2.test.ts > /tmp/kd2-t4.log 2>&1; echo exit=$?` → Expected: `exit=0`。

- [ ] **Step 5: ページに組み込む**

`src/app/(dashboard)/import/registry-pdf/page.tsx`:

1. import に `useMemo` と:
```ts
import { draftKey } from "@/lib/drafts/draft-store";
import { isDefiniteSubmitFailure } from "@/lib/drafts/submit-outcome";
import {
  compactRegistryPdfDraftForPending,
  isRegistryPdfDraftEmpty,
  parseRegistryPdfDraft,
  registryNeedsReselect,
  type RegistryPdfDraft,
} from "@/lib/drafts/screens/registry-pdf";
import { useClientReady, useDraftAutosave, useRestoredDraft } from "@/hooks/use-draft";
import {
  DraftPendingNotice,
  DraftReselectFileNotice,
  DraftRestoredNotice,
  DraftTooLargeNotice,
} from "@/components/drafts/draft-notices";
```

2. `export default function RegistryPdfPage() {` → `function RegistryPdfScreen({ draftEnabled }: { draftEnabled: boolean }) {`。末尾に:
```tsx
/** 控えはブラウザで描き直した後だけ読む(F5 でサーバー描画と食い違わないように)。 */
export default function RegistryPdfPage() {
  const clientReady = useClientReady();
  return <RegistryPdfScreen key={clientReady ? "client" : "server"} draftEnabled={clientReady} />;
}
```
⚠ 既存の `export function editLockSkipMessages` はそのまま(テストが読む)。

3. 本体の先頭で控えを読み、初期値にする:
```tsx
  // 作業中の控え(設計書 §2 S3)。
  const draftKeyValue = draftEnabled ? draftKey("registry-pdf") : null;
  const restored = useRestoredDraft(draftKeyValue, parseRegistryPdfDraft);
  const r0 = restored?.data ?? null;
  const [step, setStep] = useState<Step>(r0?.step ?? "upload");
  const [uploadTab, setUploadTab] = useState<UploadTab>(r0?.uploadTab ?? "file");
  const [text, setText] = useState(r0?.text ?? "");
  const [fileName, setFileName] = useState<string | null>(r0?.fileName ?? null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  /** 解析に使ったのがファイルか(取り込みのときもう一度ファイルが要る)。 */
  const [fromFile, setFromFile] = useState(r0?.fromFile ?? false);
  const [fields, setFields] = useState<Record<string, ExtractedField>>(r0?.fields ?? {});
  const [owners, setOwners] = useState<ExtractedOwner[]>(r0?.owners ?? []);
  const [warnings, setWarnings] = useState<string[]>(r0?.warnings ?? []);
  const [isLikelyScanned, setIsLikelyScanned] = useState(r0?.isLikelyScanned ?? false);
  const [embeddedTextLength, setEmbeddedTextLength] = useState<number | null>(r0?.embeddedTextLength ?? null);
  const [target, setTarget] = useState<RegistrationTarget>(r0?.target ?? "auto");
  const [existingPropertyId, setExistingPropertyId] = useState(r0?.existingPropertyId ?? "");
  const [propertySearchQuery, setPropertySearchQuery] = useState(r0?.propertySearchQuery ?? "");
  // 選んであった物件は、検索し直さなくても選べた状態で見えるよう結果の一覧に入れておく。
  const [propertySearchResults, setPropertySearchResults] = useState<
    Array<{ id: string; address: string; lotNumber?: string | null; realEstateNumber?: string | null }>
  >(r0?.existingProperty ? [r0.existingProperty] : []);
```
(既存の同名の useState はこれに置き換える。`parsing`・`propertySearchLoading`・`importing`・`result`・`error` はそのまま。)

その下:
```tsx
  const [pendingBlocked, setPendingBlocked] = useState(restored?.pendingSubmit != null);
  const [restoredDismissed, setRestoredDismissed] = useState(false);
  const existingProperty = propertySearchResults.find((p) => p.id === existingPropertyId) ?? null;
  const draftData = useMemo<RegistryPdfDraft>(
    () => ({
      rev: 1,
      // 結果の段階(取り込み済み)は控えない: 最初の段階で文章なし=空の形にして、書き手に消させる。
      step: step === "result" ? "upload" : step,
      text: step === "result" ? "" : text,
      uploadTab, fileName, fromFile, fields, owners, warnings, isLikelyScanned, embeddedTextLength,
      target, existingPropertyId, propertySearchQuery,
      existingProperty: existingProperty
        ? {
            id: existingProperty.id,
            address: existingProperty.address,
            lotNumber: existingProperty.lotNumber ?? null,
            realEstateNumber: existingProperty.realEstateNumber ?? null,
          }
        : null,
    }),
    [step, uploadTab, text, fileName, fromFile, fields, owners, warnings, isLikelyScanned, embeddedTextLength,
      target, existingPropertyId, propertySearchQuery, existingProperty],
  );
  const draftSaver = useDraftAutosave(draftKeyValue, draftData, isRegistryPdfDraftEmpty, restored, {
    compactForPending: compactRegistryPdfDraftForPending,
  });
  const needsReselect = registryNeedsReselect({ step, uploadTab, fromFile, hasFile: selectedFile !== null });
  /** 戻した控えがファイルで読んだ確認画面だったときの、前回のファイル名(選び直しの帯に出す)。 */
  const [reselectExpected, setReselectExpected] = useState<string | null>(
    r0 && r0.fromFile && r0.step !== "upload" ? r0.fileName : null,
  );
```
⚠ `existingProperty` は毎描画で新しい参照になりうる(`find` は同じ要素を返すので参照は保たれる)。`useMemo` の依存はこのままでよい。

4. `handleParse` 成功時(`setStep("extract");` の直前)に `setFromFile(uploadTab === "file" && selectedFile !== null); setReselectExpected(null);` を足す(読み直したら選び直しの帯は不要)。

5. `handleImport`:
   - 先頭に `if (needsReselect || pendingBlocked) return;`
   - `try {` の直前に:
     ```ts
    // 返事が来る前に離れたら、戻ったとき「登録されたか確かめて」と出す(二重登録を防ぐ・§5.1)。
    draftSaver.markSubmitting();
     ```
   - `setResult(json as ImportResult);` の直前に `draftSaver.discard();`(⚠ close ではない。結果の段階から「続けて取り込む」で次の謄本へ進んだとき、また控えられるようにする。結果の段階そのものは `draftData` が空の形になるので控えに残らない)
   - `catch (err) {` の先頭に:
     ```ts
      if (isDefiniteSubmitFailure(err)) draftSaver.unmarkSubmitting();
      else setPendingBlocked(true);
     ```

6. `handleReset` の先頭に `draftSaver.discard();`、最後に `setFromFile(false); setReselectExpected(null); setRestoredDismissed(true); setPendingBlocked(false);` を足す(「キャンセル」「最初からやり直す」「続けて取り込む」の3か所がこれを呼ぶ)。⚠送信途中の帯が出ている間は「最初からやり直す」の帯は出ないので、印を消すのは「確かめたので続ける」だけになる(第1段の小窓と同じ)。

7. 帯: `<StepIndicator current={step} />` の直後に:
```tsx
      {pendingBlocked ? (
        <div className="mb-4">
          <DraftPendingNotice
            onConfirm={() => {
              draftSaver.unmarkSubmitting();
              setPendingBlocked(false);
            }}
          />
        </div>
      ) : (
        restored && !restoredDismissed && step !== "result" && (
          <div className="mb-4">
            <DraftRestoredNotice savedAt={restored.savedAt} onDiscard={handleReset} />
          </div>
        )
      )}
      {draftSaver.tooLarge && <div className="mb-4"><DraftTooLargeNotice /></div>}
      {reselectExpected && (step === "extract" || step === "confirm") ? (
        <div className="mb-4 space-y-2">
          <DraftReselectFileNotice expectedName={reselectExpected} chosenName={selectedFile?.name ?? null} />
          {needsReselect && (
            <FileDropZone
              accept=".pdf"
              icon={FileText}
              title="PDFファイルをここにドラッグ＆ドロップ"
              fileName={null}
              // ⚠読み取りはし直さない(結果はそのまま・設計書 §4.3)。名前は前回のものを残す。
              onFiles={(files) => setSelectedFile(files[0])}
            />
          )}
        </div>
      ) : null}
```
⚠ 選び直したときに `setFileName` を変えない(前回の名前と比べる帯を出すため)。取り込みの `fileName ?? selectedFile.name` には前回の名前が送られる=同じ書類の名前で残る。

8. 「登録実行」ボタン(1138行付近)の `disabled={importing}` を `disabled={importing || needsReselect || pendingBlocked}` に変える。

- [ ] **Step 6: 通ることを確かめる**

Run: `npx vitest run src/lib/drafts src/lib/__tests__ "src/app/(dashboard)/import/registry-pdf" > /tmp/kd2-t4.log 2>&1; echo exit=$?; tail -8 /tmp/kd2-t4.log`
Expected: `exit=0`(既存の謄本画面のソース走査テストも緑)。`npx tsc --noEmit` → 0。`npx eslint "src/app/(dashboard)/import/registry-pdf/page.tsx" src/lib/drafts` → 0。

- [ ] **Step 7: コミット**

```bash
git add src/lib/drafts "src/app/(dashboard)/import/registry-pdf/page.tsx"
git commit -m "feat(drafts): 謄本PDF取込の段階と読み取り結果を控える(ファイルは選び直し)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LYGLoZ3RCTWGGudbns69rp"
```

---

### Task 5: S4 取り込み(CSV・受付帳×所有者・受付帳→物件)

**Files:**
- Create: `src/lib/drafts/screens/csv-import.ts`
- Modify: `src/app/(dashboard)/import/page.tsx`
- Test: `screens-pr2.test.ts`・`pr2-wiring-source.test.ts`(追記)

**Interfaces:**
- Consumes: Task 1 の `useClientReady`・`DraftImportPendingNotice`。既存の `useRestoredDraft`・`useDraftAutosave`・`isDefiniteSubmitFailure`・`DraftRestoredNotice`・`DraftTooLargeNotice`。
- Produces:
  - `type CsvImportDraft`(下のコード)
  - `parseCsvImportDraft(d: unknown): CsvImportDraft | null`
  - `isCsvImportDraftEmpty(d: CsvImportDraft): boolean`
  - `compactCsvImportDraftForPending(): CsvImportDraft`
  - `decideCsvImportRestore(restored: StoredDraft<CsvImportDraft> | null): { start: CsvImportDraft | null; showPending: boolean }`

- [ ] **Step 1: 失敗するテストを書く**

`screens-pr2.test.ts` に追記:

```ts
import {
  compactCsvImportDraftForPending,
  decideCsvImportRestore,
  isCsvImportDraftEmpty,
  parseCsvImportDraft,
} from "../screens/csv-import";

describe("取り込み(CSV)の控え", () => {
  const main = {
    step: 2, fileName: "a.csv", csvText: "住所\n東京", xlsxBase64: null, template: "standard",
    headers: ["住所"], rows: [["東京"]], columnMapping: { 住所: "address" }, duplicatePreview: null,
  };
  const file = { name: "受付帳.csv", csvText: "x" };
  const d = {
    rev: 1, main,
    ro: { receptionFile: file, ownerFile: null, dlFilter: "marked", shinkiFilter: "existing", roPreview: null },
    rp: null,
  };
  it("往復して同じ・形違いは捨てる", () => {
    expect(parseCsvImportDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parseCsvImportDraft({ ...d, main: { ...main, step: 4 } })).toBeNull();
    expect(parseCsvImportDraft({ ...d, ro: { ...d.ro, dlFilter: "x" } })).toBeNull();
    expect(parseCsvImportDraft({ ...d, rev: 2 })).toBeNull();
  });
  it("3つの流れのどれも無ければ空", () => {
    expect(isCsvImportDraftEmpty(compactCsvImportDraftForPending())).toBe(true);
    expect(isCsvImportDraftEmpty({ rev: 1, main: null, ro: null, rp: { rpFile: file, rpDlFilter: "marked", rpShinkiFilter: "existing", rpPreview: null } } as never)).toBe(false);
  });
  it("送信中の印が残っていたら、中身は戻さず案内だけ出す(§5.1 S4)", () => {
    const data = parseCsvImportDraft(d)!;
    expect(decideCsvImportRestore({ v: 1, savedAt: 1, data, pendingSubmit: { at: 1 } })).toEqual({ start: null, showPending: true });
    expect(decideCsvImportRestore({ v: 1, savedAt: 1, data })).toEqual({ start: data, showPending: false });
    expect(decideCsvImportRestore(null)).toEqual({ start: null, showPending: false });
  });
});
```

`pr2-wiring-source.test.ts` に追記:

```ts
describe("取り込み(CSV)の配線", () => {
  const src = read("src/app/(dashboard)/import/page.tsx");
  it("F5 でも食い違わない", () => {
    expectClientReadyGate(src, "ImportScreen");
    expect(src).toMatch(/draftEnabled \? draftKey\("csv-import"\) : null/);
  });
  it("送信中の印が残る控えは書き手に渡さない(印を引き継がず、空で上書きして消す)", () => {
    expect(src).toMatch(/useDraftAutosave\(draftKeyValue, draftData, isCsvImportDraftEmpty, restoreDecision\.start \? restored : null,/);
  });
  it.each(["importCsv(", "importReceptionOwnerCsv(", "importReceptionPropertyCsv("])("%s の直前に印・成功と4xxで外す", (call) => {
    const at = src.indexOf(`await ${call}`);
    expect(at).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, at - 400), at);
    expect(before).toContain("draftSaver.markSubmitting();");
    const after = src.slice(at, at + 900);
    expect(after).toContain("draftSaver.unmarkSubmitting();");
    expect(after).toMatch(/if \(isDefiniteSubmitFailure\((e|err)\)\) draftSaver\.unmarkSubmitting\(\);/);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/drafts > /tmp/kd2-t5.log 2>&1; echo exit=$?` → Expected: `exit=1`。

- [ ] **Step 3: `src/lib/drafts/screens/csv-import.ts`**

```ts
/**
 * 取り込み(CSV)画面の控え(設計書 §2 S4)。1つの画面に3つの流れがある:
 *   main = CSV/Excel → 物件(段階 2・3 だけ控える。取り込み後の段階 4 は控えない)
 *   ro   = 受付帳 × 所有者(結果が出たら控えない)
 *   rp   = 受付帳 → 物件(結果が出たら控えない)
 * ファイルの中身は文字(csvText)か base64 で持っているので、選び直しは要らない。
 * 大きいときは土台が "too_large" で止める(§5.4)。
 */
import { z } from "zod/v4";
import type { StoredDraft } from "../draft-store";

type FileEntry = { name: string; csvText?: string; xlsxBase64?: string };
type DlFilter = "marked" | "unmarked" | "all";
type ShinkiFilter = "existing" | "new" | "all";

export interface CsvMainDraft {
  step: 2 | 3;
  fileName: string;
  csvText: string;
  xlsxBase64: string | null;
  template: string;
  headers: string[];
  rows: string[][];
  columnMapping: Record<string, string>;
  /** 重複の下見(サーバーの応答)。形は画面の state と同じ。 */
  duplicatePreview: Record<string, unknown> | null;
}
export interface CsvRoDraft {
  receptionFile: FileEntry | null;
  ownerFile: FileEntry | null;
  dlFilter: DlFilter;
  shinkiFilter: ShinkiFilter;
  roPreview: Record<string, unknown> | null;
}
export interface CsvRpDraft {
  rpFile: FileEntry | null;
  rpDlFilter: DlFilter;
  rpShinkiFilter: ShinkiFilter;
  rpPreview: Record<string, unknown> | null;
}
export interface CsvImportDraft {
  rev: 1;
  main: CsvMainDraft | null;
  ro: CsvRoDraft | null;
  rp: CsvRpDraft | null;
}

const fileSchema = z.object({ name: z.string(), csvText: z.string().optional(), xlsxBase64: z.string().optional() });
const dl = z.enum(["marked", "unmarked", "all"]);
const shinki = z.enum(["existing", "new", "all"]);

const schema = z.object({
  rev: z.literal(1),
  main: z
    .object({
      step: z.union([z.literal(2), z.literal(3)]),
      fileName: z.string(),
      csvText: z.string(),
      xlsxBase64: z.string().nullable(),
      template: z.string(),
      headers: z.array(z.string()),
      rows: z.array(z.array(z.string())),
      columnMapping: z.record(z.string(), z.string()),
      duplicatePreview: z.looseObject({}).nullable(),
    })
    .nullable(),
  ro: z
    .object({
      receptionFile: fileSchema.nullable(),
      ownerFile: fileSchema.nullable(),
      dlFilter: dl,
      shinkiFilter: shinki,
      roPreview: z.looseObject({}).nullable(),
    })
    .nullable(),
  rp: z
    .object({
      rpFile: fileSchema.nullable(),
      rpDlFilter: dl,
      rpShinkiFilter: shinki,
      rpPreview: z.looseObject({}).nullable(),
    })
    .nullable(),
});

export function parseCsvImportDraft(d: unknown): CsvImportDraft | null {
  const r = schema.safeParse(d);
  return r.success ? (r.data as CsvImportDraft) : null;
}

export function isCsvImportDraftEmpty(d: CsvImportDraft): boolean {
  return d.main === null && d.ro === null && d.rp === null;
}

/** 大きすぎて控えを止めた後に、送信中の印だけを残す中身(空)。 */
export function compactCsvImportDraftForPending(): CsvImportDraft {
  return { rev: 1, main: null, ro: null, rp: null };
}

/**
 * 戻し方を決める。送信中の印が残っていたら、取り込みはサーバーで続いているかもしれない
 * =中身は戻さず「取り込み履歴で確かめて」だけ出す(§5.1 S4)。
 */
export function decideCsvImportRestore(
  restored: StoredDraft<CsvImportDraft> | null,
): { start: CsvImportDraft | null; showPending: boolean } {
  if (!restored) return { start: null, showPending: false };
  if (restored.pendingSubmit) return { start: null, showPending: true };
  return { start: restored.data, showPending: false };
}
```

⚠ 画面の `receptionFile` などの型(`{ name; csvText?; xlsxBase64? }`)と一致していることを確かめる。`readFileForImport` が `csvText: undefined` を返すと JSON で欄ごと消える=`optional()` で受かる。

- [ ] **Step 4: 純関数のテストが通ることを確かめる**

Run: `npx vitest run src/lib/drafts/__tests__/screens-pr2.test.ts > /tmp/kd2-t5.log 2>&1; echo exit=$?` → Expected: `exit=0`。

- [ ] **Step 5: ページに組み込む**

`src/app/(dashboard)/import/page.tsx`:

1. import(react の import には `useMemo` が既にある):
```ts
import { draftKey } from "@/lib/drafts/draft-store";
import { isDefiniteSubmitFailure } from "@/lib/drafts/submit-outcome";
import {
  compactCsvImportDraftForPending,
  decideCsvImportRestore,
  isCsvImportDraftEmpty,
  parseCsvImportDraft,
  type CsvImportDraft,
} from "@/lib/drafts/screens/csv-import";
import { useClientReady, useDraftAutosave, useRestoredDraft } from "@/hooks/use-draft";
import { DraftImportPendingNotice, DraftRestoredNotice, DraftTooLargeNotice } from "@/components/drafts/draft-notices";
```

2. `export default function ImportPage() {` → `function ImportScreen({ draftEnabled }: { draftEnabled: boolean }) {`。末尾に:
```tsx
/** 控えはブラウザで描き直した後だけ読む(F5 でサーバー描画と食い違わないように)。 */
export default function ImportPage() {
  const clientReady = useClientReady();
  return <ImportScreen key={clientReady ? "client" : "server"} draftEnabled={clientReady} />;
}
```
⚠ `sidebar-reorg.test.ts`・`import-content-detect-wiring.test.ts`・`page-dark.test.ts` などはこのファイルの文字列を読む。関数名の変更で落ちたら、そのテストが何を守っているか読んでから合わせる(落ちた場合は台帳に記録)。

3. 本体の先頭:
```tsx
  // 作業中の控え(設計書 §2 S4)。3つの流れをまとめて1つの鍵に置く。
  const draftKeyValue = draftEnabled ? draftKey("csv-import") : null;
  const restored = useRestoredDraft(draftKeyValue, parseCsvImportDraft);
  // ⚠この画面は useState の初期化で1回だけ決める(描き直しで変わらない)。
  const [restoreDecision] = useState(() => decideCsvImportRestore(restored));
  const s0 = restoreDecision.start;
```
既存の useState の初期値を置き換える:
```tsx
  const [step, setStep] = useState<Step>(s0?.main?.step ?? 1);
  const [csvText, setCsvText] = useState(s0?.main?.csvText ?? "");
  const [xlsxBase64, setXlsxBase64] = useState<string | null>(s0?.main?.xlsxBase64 ?? null);
  const [fileName, setFileName] = useState(s0?.main?.fileName ?? "");
  const [template, setTemplate] = useState<string>(s0?.main?.template ?? "standard");
  const [headers, setHeaders] = useState<string[]>(s0?.main?.headers ?? []);
  const [rows, setRows] = useState<string[][]>(s0?.main?.rows ?? []);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>(s0?.main?.columnMapping ?? {});
  const [duplicatePreview, setDuplicatePreview] = useState<{ ...既存の型... } | null>(
    (s0?.main?.duplicatePreview as never) ?? null,
  );
  const [receptionFile, setReceptionFile] = useState<...>(s0?.ro?.receptionFile ?? null);
  const [ownerFile, setOwnerFile] = useState<...>(s0?.ro?.ownerFile ?? null);
  const [roPreview, setRoPreview] = useState<ReceptionOwnerPreviewResponse | null>((s0?.ro?.roPreview as never) ?? null);
  const [dlFilter, setDlFilter] = useState<"marked" | "unmarked" | "all">(s0?.ro?.dlFilter ?? "marked");
  const [shinkiFilter, setShinkiFilter] = useState<"existing" | "new" | "all">(s0?.ro?.shinkiFilter ?? "existing");
  const [rpFile, setRpFile] = useState<...>(s0?.rp?.rpFile ?? null);
  const [rpPreview, setRpPreview] = useState<ReceptionPropertyPreviewResponse | null>((s0?.rp?.rpPreview as never) ?? null);
  const [rpDlFilter, setRpDlFilter] = useState<"marked" | "unmarked" | "all">(s0?.rp?.rpDlFilter ?? "marked");
  const [rpShinkiFilter, setRpShinkiFilter] = useState<"existing" | "new" | "all">(s0?.rp?.rpShinkiFilter ?? "existing");
```
(`...` の型注釈は既存のものをそのまま残す。)

`rpShinkiFilter` の useState の後に:
```tsx
  const [pendingNoticeShown, setPendingNoticeShown] = useState(restoreDecision.showPending);
  const [restoredDismissed, setRestoredDismissed] = useState(false);

  const draftData = useMemo<CsvImportDraft>(
    () => ({
      rev: 1,
      main:
        step === 2 || step === 3
          ? { step, fileName, csvText, xlsxBase64, template, headers, rows, columnMapping, duplicatePreview }
          : null,
      // 結果が出たら(取り込み済み)その流れは控えない。
      ro:
        (receptionFile || ownerFile) && !roResult
          ? { receptionFile, ownerFile, dlFilter, shinkiFilter, roPreview: roPreview as Record<string, unknown> | null }
          : null,
      rp:
        rpFile && !rpResult
          ? { rpFile, rpDlFilter, rpShinkiFilter, rpPreview: rpPreview as Record<string, unknown> | null }
          : null,
    }),
    [step, fileName, csvText, xlsxBase64, template, headers, rows, columnMapping, duplicatePreview,
      receptionFile, ownerFile, dlFilter, shinkiFilter, roPreview, roResult,
      rpFile, rpDlFilter, rpShinkiFilter, rpPreview, rpResult],
  );
  // ⚠送信中の印が残っていた控えは書き手に渡さない(印を引き継がない)。最初の書き込みで
  //   空の中身になり、控えは消える(§5.1 S4)。
  const draftSaver = useDraftAutosave(draftKeyValue, draftData, isCsvImportDraftEmpty, restoreDecision.start ? restored : null, {
    compactForPending: compactCsvImportDraftForPending,
  });
```
⚠ `roResult`・`rpResult` の useState はこの useMemo より**前**で宣言されていること(既存の並びで 577・591 行=前にある)。

4. 3つの取り込み:
   - `handleImport`: `try {` の直前に `draftSaver.markSubmitting();`、`setResult(json as ImportResult);` の直後に `draftSaver.unmarkSubmitting();`(step 4 になる=main が控えから外れる)。`catch (err) {` の先頭に `if (isDefiniteSubmitFailure(err)) draftSaver.unmarkSubmitting();`(⚠5xx・通信切れは印を残す。画面に残っている間は、そのまま取り込み履歴を見られる)。
   - `handleRoImport`: `window.confirm` の後・`setRoLoading(true);` の後の `try {` の直前に `draftSaver.markSubmitting();`、`setRoResult(res);` の直後に `draftSaver.unmarkSubmitting();`、`catch (e) {` の先頭に `if (isDefiniteSubmitFailure(e)) draftSaver.unmarkSubmitting();`。
   - `handleRpImport`: 同じ形(`setRpResult(res);` の直後)。
   ⚠ `importCsv` などが api-client 経由で status つきの Error を投げることを `src/lib/api-client.ts:71-74` で確かめる(確認済み=`status: res.status`)。

5. 「最初からやり直す」:
```tsx
  const handleDiscardDraft = () => {
    draftSaver.discard();
    handleReset();
    handleRoReset();
    handleRpReset();
    setTemplate("standard");
    setRestoredDismissed(true);
  };
```
⚠ `handleReset`・`handleRoReset`・`handleRpReset` は既存のまま(それぞれの流れの「やり直す」は state を空にする=控えはその流れの分だけ自動で外れる)。

6. 帯: ページの見出し(`PageHeader`)の直後に:
```tsx
      {pendingNoticeShown && <DraftImportPendingNotice onDismiss={() => setPendingNoticeShown(false)} />}
      {restoreDecision.start && !restoredDismissed && (
        <DraftRestoredNotice savedAt={restored?.savedAt ?? Date.now()} onDiscard={handleDiscardDraft} />
      )}
      {draftSaver.tooLarge && <DraftTooLargeNotice />}
```
⚠ `restored?.savedAt ?? Date.now()` の `Date.now()` は描画中の不純な呼び出し(lint `react-hooks/purity`)。`restoreDecision.start` があるとき `restored` は必ずあるので `restored!.savedAt` と書かず、`{restoreDecision.start && restored && !restoredDismissed && (<DraftRestoredNotice savedAt={restored.savedAt} ... />)}` とする。
帯の置き場所は、既存の見出しの直後に `className="space-y-..."` の並びがあるならその中。PII 保護の印(`data-pii-protected`)の内側に置く。

- [ ] **Step 6: 通ることを確かめる**

Run: `npx vitest run src/lib/drafts src/lib/__tests__ "src/app/(dashboard)/import" src/components/layout > /tmp/kd2-t5.log 2>&1; echo exit=$?; tail -8 /tmp/kd2-t5.log`
Expected: `exit=0`。`npx tsc --noEmit` → 0。`npx eslint "src/app/(dashboard)/import/page.tsx" src/lib/drafts` → 0(既存の債務は `git stash` で比べて自分の差分かを見る)。

- [ ] **Step 7: コミット**

```bash
git add src/lib/drafts "src/app/(dashboard)/import/page.tsx"
git commit -m "feat(drafts): 取り込み(CSV・受付帳)の途中を控えて戻す・取り込み途中で離れたら履歴へ案内" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LYGLoZ3RCTWGGudbns69rp"
```

---

### Task 6: 全ゲート・手元の実機・提出

- [ ] **Step 1: 全ゲート(報告には終了コードを書く)**

```bash
npx tsc --noEmit > /tmp/kd2-tsc.log 2>&1; echo tsc=$?
npx vitest run > /tmp/kd2-vitest.log 2>&1; echo vitest=$?; tail -6 /tmp/kd2-vitest.log
npx eslint src/hooks/use-draft.ts src/lib/drafts src/components/drafts src/components/import/paste-import-review.tsx src/components/import/excel-lead-table.tsx "src/app/(dashboard)/import/page.tsx" "src/app/(dashboard)/import/paste/page.tsx" "src/app/(dashboard)/import/paste/excel/page.tsx" "src/app/(dashboard)/import/registry-pdf/page.tsx" > /tmp/kd2-eslint.log 2>&1; echo eslint=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > /tmp/kd2-build.log 2>&1; echo build=$?
```
Expected: すべて `=0`。

- [ ] **Step 2: 手元の実機(`local-dev-env-setup` の手順で起動)**

各画面で: 入力・読み取り → 左のメニューで別の画面 → 戻る(帯と内容)/F5(帯と内容・ブラウザの開発者ツールに hydration の警告が出ない)/ログアウト→ログイン(残っていない)/「最初からやり直す」。
- 貼り付けて物件化: PDF で読み取り → 移動 → 戻る → 選び直すまで「この内容で登録」が押せない/違う名前のPDFで確かめる一文。
- Excel: まとめて登録の途中で移動 → 戻る → 送っていた行が「登録されたか分かりません」、他の登録できる行だけが残りの件数に入る。
- 謄本PDF: ファイルで確認画面まで → 移動 → 戻る → 選び直すまで「登録実行」が押せない。テキスト貼り付けでは選び直し不要。
- CSV: 段階2で移動 → 戻る → 列の対応が残る/受付帳×所有者でファイル2つを入れて移動 → 戻る。

- [ ] **Step 3: 提出前レビュー → PR → @codex**

ship スキルの §4〜6 に従う(`feature-dev:code-reviewer` にホットスポット: 二重送信・PII を控えに入れる範囲・F5 の食い違い・既存の重複判定を素通りしないこと)。PR 題: `feat(drafts): 別メニューへ移っても入力を消さない 第2段(貼り付け・Excel・謄本PDF・CSV)`。

---

## 自己点検(計画を書いた後)

- 設計書 §2 S1〜S4 の「とっておくもの」: S1=Task 2(文章・読み取り結果・直した値・所有者の扱い・棟の選択・外部キー)/S2=Task 3(行・結果・送信中の行)/S3=Task 4(段階・タブ・文章・ファイル名・欄・所有者・警告・取り込み先)/S4=Task 5(段階・ファイル名・中身・見出し/行・列の対応・テンプレート・重複の下見・受付帳の2つの流れ)。
- §4.3 選び直し: S1・S3(Task 2・4)。S1 の PDF を添付しない場合(貼り付け)と S3 のテキスト貼り付けは不要=`pdfReselectReason`・`registryNeedsReselect` のテストで固定。
- §5.1: S1・S3=`DraftPendingNotice`(Task 2・4)/S4=履歴への案内+控えを消す(Task 5)。
- §5.2: Task 3。§5.4: 各画面で `DraftTooLargeNotice`+`compactFor*Pending`。
- §6: sessionStorage のみ・サーバー変更なし(Global Constraints)。
- §8 の第3段(ガイド/マニュアル)はこの計画に含めない。
