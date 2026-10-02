# 業者からの反響の受付 仕上げ(受付の窓の積み残し+第3段の後回し)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 受付の窓の第2段の積み残しと、第3段で後回しにした小さな指摘を片付ける。①入力欄で Enter を押しても勝手に保存されない ②日付だけ・時刻だけの入力で予定が黙って消えない ③切り替えボタンの読み上げ・詳細の読み込み中の表示 ④対応済みタブの期間の絞り込み ⑤アプリ全体の小窓(ModalShell)に透かし ⑥第3段の後回し4件 ⑦(**要承認**)二重登録を防ぐ鍵。

**Architecture:** これまでと同じ分け方(判定は純関数 `src/lib/agent-inquiry/desk-form.ts`・見た目は props の View・取得と保存は親)。⑤は ModalShell 自身が透かしを描くようにして、各小窓が個別に描いていた2か所を外す。⑦だけ表に列を足す(migration・ADD のみ)。

**Tech Stack:** Next.js 16 / React 19 / Prisma / vitest(node 環境・SSR とソース走査)/ Playwright(実ブラウザ確認)。新しい依存なし。**migration は Task 7 だけ**(承認が無ければ Task 7 を飛ばし、この PR は migration なしになる)。

**Spec:** `docs/superpowers/specs/2026-09-28-agent-inquiry-desk-design.md`(§2.1 一覧「対応済みは直近30日を既定表示」・§2.2 登録フォーム・§4 権限と安全)

## 範囲の判断

- **Enter**: 1行の入力欄で Enter を押すと、ブラウザの決まりでフォーム全体が「保存」される(業者を選ぶ前の打ちかけでも保存が走り、エラーが並ぶ/そろっていれば登録されてしまう)。**1行の入力欄の Enter では保存しない**(保存はボタンだけ)。メモ欄(複数行)の Enter は改行のまま。日本語の変換を確定する Enter も今までどおり。
- **日付だけ・時刻だけ**: 今は片方だけだと**黙って「日程調整中」で保存**され、詳細では**入っていた予定が消える**(実害)。→ 登録・詳細とも、片方だけのときは**保存を止めて理由を出す**(両方空=日程調整中はこれまでどおり保存できる)。
- **対応済みの期間**: 設計書どおり、対応済みタブは**既定で直近30日**(受けた日時で)。「直近30日/直近90日/すべて」を選べる。未対応・対応中は期間で絞らない(対応漏れを隠さない)。
- **透かし**: ModalShell を使う小窓は13画面。中で透かしを描いていたのは受付の窓の2つだけ=ほかの11は**小窓の中だけ透かしが無かった**。器で描けば全部そろう(画面保護の外=ログイン前などでは何も描かない)。地図のピン詳細は ModalShell ではない独自の小窓なので今回は対象外(PR 本文に記載)。
- **二重登録を防ぐ鍵(Task 7・要承認)**: 通信が切れて「保存できたか分からない」とき、今は「一覧で確かめてから押し直して」と頼んでいる。鍵を付けると、**同じ内容のまま押し直しても二重にならない**(サーバーが1回目の分を返す)。表 `agent_inquiries`・`agents` に列 `client_token`(空でよい)と「登録者×鍵」の一意の索引を**足すだけ**。**内容を直してから押し直したときは新しい鍵**になる(直した内容を1回目の分で黙って捨てないため)=そのときはこれまでどおり一覧で確かめてもらう。
- **第3段の後回し**: 自分の広告の可否の変更で同じ窓が2回読み直す(合図に窓ごとの印を付けて自分の分は聞かない)/「取り消し」の暗い画面の色/`updateAgent` の型/「もっと見る」の読み込み中。テストの書き直し(M-4)は今回も見送り。

## Global Constraints

- 文言は平易な日本語。ボタン・小窓は共通部品。暗い画面の色(`dark:`)を付ける。スマホ幅 390px ではみ出さない。
- 合図(`BroadcastChannel`)に載せるのは `type` と**窓ごとの乱数の印**だけ(名前・電話・反響の id を載せない)。
- 透かしは画面保護の決まりどおり: `bypass` の人には出さない/`watermarkText` が無ければ出さない。
- 409 は黙って上書きしない。保存できたか分からない失敗を「失敗」と言い切らない。
- Task 7 の migration は **ADD のみ**(列は NULL 可・既存行は NULL のまま)。反映は「表→コード」の順(`prisma migrate deploy` の後に再起動)。
- commit 末尾:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WmeoVwkUWvtup1T1ajZNL5
  ```

## Review Focus

1. **日本語の変換確定の Enter**で保存されない/変換確定が妨げられない(`isComposing` のときは何もしない)(Task 1 のテスト)。
2. **詳細で時刻だけ消した**: 予定が黙って「日程調整中」にならず、理由が出て保存されない。**両方消した**ときは日程調整中にできる(Task 2 のテスト)。
3. **対応済みタブで期間を変えた直後に「もっと見る」**: 前の期間の続きが混ざらない(期間も一覧の世代に入れる)(Task 4 のテスト)。
4. **小窓の中の透かしが二重**にならない(個別に描いていた2か所を外す)/画面保護の外では描かない(Task 5 のテスト)。
5. **(Task 7)同じ鍵で同時に2回届いた**: 1件しかできず、2回目は1回目の id を返す(一意の索引の違反を拾って既存を返す)。**別の人の鍵**とは混ざらない(登録者×鍵)(Task 7 のテスト)。

---

## File Structure

| ファイル | 役割 |
|---|---|
| `src/lib/agent-inquiry/desk-form.ts`(変更) | `shouldBlockEnterSubmit`・`partialScheduleError`・`validateDeskForm` の日時・`DONE_PERIODS`/`donePeriodDays`・(Task 7)`tokenForSubmit` |
| `src/components/agent-inquiry/inquiry-form.tsx`(変更) | Enter の抑止・日時のエラー表示・aria-pressed・(Task 7)鍵 |
| `src/components/agent-inquiry/inquiry-detail.tsx`(変更) | 日時の片方だけを止める・aria-pressed・読み込み中の小窓・透かしの個別描画を外す |
| `src/components/agent-inquiry/agent-create-modal.tsx`(変更) | 透かしの個別描画を外す・(Task 7)鍵 |
| `src/components/agent-inquiry/inquiry-list.tsx`・`src/app/(desk)/inquiry-desk/page.tsx`(変更) | 対応済みタブの期間 |
| `src/app/api/agent-inquiries/route.ts`(変更) | 一覧の `days`・(Task 7)登録の鍵 |
| `src/lib/api-client.ts`(変更) | `fetchAgentInquiries` の `days`・`updateAgent` の型・(Task 7)鍵 |
| `src/components/ui/modal-shell.tsx`(変更) | 器が透かしを描く |
| `src/lib/agent-inquiry/desk-sync.ts`(変更) | 窓ごとの印 |
| `src/components/properties/agent-inquiry-tab.tsx`・`src/app/(dashboard)/agents/**`(変更) | 暗い画面の色・もっと見るの読み込み中 |
| (Task 7)`prisma/schema.prisma`・`prisma/migrations/20261002100000_add_agent_client_tokens/migration.sql`(新)・`src/app/api/agents/route.ts`・`src/lib/agent-inquiry/validators.ts` | 鍵の列と一意の索引・登録の冪等化 |

---

### Task 0: 準備(済み)

worktree `property-management-worktrees/agent-desk-polish`(branch `feat/agent-desk-polish`・origin/main `8588c614` から)。`npm ci`・`prisma generate` 済み。基準: `npx vitest run src/lib/__tests__/agent- src/components/agent-inquiry src/components/ui src/components/properties/__tests__/agent-inquiry-tab.test.tsx` が通ること。

---

### Task 1: 1行の入力欄の Enter では保存しない

**Files:** Modify `src/lib/agent-inquiry/desk-form.ts`・`src/components/agent-inquiry/inquiry-form.tsx` / Test `src/lib/__tests__/agent-desk-form.test.ts`(追記)・`src/components/agent-inquiry/__tests__/inquiry-form.test.tsx`(追記)

**Interfaces:** Produces `shouldBlockEnterSubmit(e: { key: string; isComposing: boolean; tagName: string; type?: string }): boolean`

- [ ] **Step 1: 失敗するテスト**

```ts
// src/lib/__tests__/agent-desk-form.test.ts に追記
import { shouldBlockEnterSubmit } from "@/lib/agent-inquiry/desk-form";
describe("1行の入力欄の Enter では保存しない", () => {
  const k = (o: Partial<{ key: string; isComposing: boolean; tagName: string; type: string }>) =>
    shouldBlockEnterSubmit({ key: "Enter", isComposing: false, tagName: "INPUT", type: "text", ...o });
  it("文字・電話・メール・日付の欄の Enter は止める", () => {
    for (const type of ["text", "tel", "email", "date", "time", "search"]) expect(k({ type })).toBe(true);
  });
  it("★日本語の変換を確定する Enter は止めない(変換の確定を妨げない)", () => {
    expect(k({ isComposing: true })).toBe(false);
  });
  it("メモ欄(複数行)の Enter は改行のまま・ボタンの Enter は押したことになる", () => {
    expect(k({ tagName: "TEXTAREA", type: undefined })).toBe(false);
    expect(k({ tagName: "BUTTON", type: "submit" })).toBe(false);
  });
  it("Enter 以外のキーは関係ない", () => {
    expect(k({ key: "a" })).toBe(false);
  });
});
```

```tsx
// inquiry-form.test.tsx に追記
describe("Enter で勝手に保存しない", () => {
  it("フォームが Enter を受けて shouldBlockEnterSubmit で止める", () => {
    const src = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-form.tsx"), "utf8");
    expect(src).toMatch(/onKeyDown=\{\(e\) => \{[\s\S]{0,300}shouldBlockEnterSubmit\(/);
    expect(src).toMatch(/if \(shouldBlockEnterSubmit\([\s\S]{0,200}\)\) e\.preventDefault\(\);/);
  });
});
```
(このファイルの先頭に `import { readFileSync } from "node:fs"; import { join } from "node:path";` が無ければ足す)

- [ ] **Step 2:** `npx vitest run src/lib/__tests__/agent-desk-form.test.ts src/components/agent-inquiry/__tests__/inquiry-form.test.tsx` → FAIL(関数が無い)

- [ ] **Step 3: 実装**

`desk-form.ts`(`validateDeskForm` の上)に:
```ts
/**
 * フォームの Enter を止めるか。1行の入力欄で Enter を押すと、ブラウザの決まりでフォームが「保存」される
 * (打ちかけのまま登録が走る)。保存はボタンだけにする。複数行のメモ欄・ボタン・日本語の変換確定は止めない。
 */
export function shouldBlockEnterSubmit(e: { key: string; isComposing: boolean; tagName: string; type?: string }): boolean {
  if (e.key !== "Enter" || e.isComposing) return false;
  return e.tagName === "INPUT" && e.type !== "submit" && e.type !== "button";
}
```

`inquiry-form.tsx` の `<form ... onSubmit={...}>` に `onKeyDown` を足し、import に `shouldBlockEnterSubmit` を足す:
```tsx
      onKeyDown={(e) => {
        const t = e.target as HTMLInputElement;
        // 1行の入力欄の Enter では保存しない(保存はボタンだけ)。メモ欄の改行・変換の確定はそのまま。
        if (shouldBlockEnterSubmit({ key: e.key, isComposing: e.nativeEvent.isComposing, tagName: t.tagName, type: t.type })) e.preventDefault();
      }}
```

- [ ] **Step 4:** 同じコマンド → PASS。`npx tsc --noEmit` = 0
- [ ] **Step 5:** commit `fix(agent-inquiry): 受付の窓の入力欄で Enter を押しても保存しない`

---

### Task 2: 日付だけ・時刻だけでは保存しない(登録と詳細)

**Files:** Modify `desk-form.ts`・`inquiry-form.tsx`・`inquiry-detail.tsx` / Test `agent-desk-form.test.ts`・`inquiry-form.test.tsx`・`src/components/agent-inquiry/__tests__/inquiry-list.test.tsx`(詳細の SSR がここにある)

**Interfaces:** Produces `partialScheduleError(date: string, time: string): string | null`・`validateDeskForm` の戻り値に `viewingAt` キー

- [ ] **Step 1: 失敗するテスト**

```ts
// agent-desk-form.test.ts に追記
import { partialScheduleError, validateDeskForm, deskFormReducer, EMPTY_DESK_FORM } from "@/lib/agent-inquiry/desk-form";
describe("日付だけ・時刻だけでは保存しない", () => {
  const MSG = "日付と時刻の両方を入れてください(両方とも空なら日程調整中で保存できます)";
  it("片方だけは止める・両方空/両方ありは通す", () => {
    expect(partialScheduleError("2026-10-05", "")).toBe(MSG);
    expect(partialScheduleError("", "14:00")).toBe(MSG);
    expect(partialScheduleError("", "")).toBeNull();
    expect(partialScheduleError("2026-10-05", "14:00")).toBeNull();
  });
  it("登録フォームの検証にも入る(内見のときだけ)", () => {
    let s = deskFormReducer(EMPTY_DESK_FORM, { type: "kind", value: "viewing" });
    s = deskFormReducer(s, { type: "viewing", field: "date", value: "2026-10-05" });
    expect(validateDeskForm(s).viewingAt).toBe(MSG);
    s = deskFormReducer(s, { type: "viewing", field: "time", value: "14:00" });
    expect(validateDeskForm(s).viewingAt).toBeUndefined();
  });
});
```

```tsx
// inquiry-form.test.tsx に追記
it("日時の片方だけのエラーを日時の欄の下に出す", () => {
  let s = deskFormReducer(EMPTY_DESK_FORM, { type: "kind", value: "viewing" });
  s = deskFormReducer(s, { type: "viewing", field: "date", value: "2026-10-05" });
  expect(view({ state: s, errors: { viewingAt: "日付と時刻の両方を入れてください(両方とも空なら日程調整中で保存できます)" } }))
    .toContain("日付と時刻の両方を入れてください");
});
```

```tsx
// inquiry-list.test.tsx(詳細の SSR と走査)に追記
it("★詳細で日付だけ・時刻だけにしたら保存せず理由を出す(予定を黙って消さない)", () => {
  const src = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-detail.tsx"), "utf8");
  const at = src.indexOf("const save = () => {");
  const body = src.slice(at, src.indexOf("const canceled", at));
  expect(body).toMatch(/const partial = partialScheduleError\(val\("date"\), val\("time"\)\);\s*if \(partial\) \{\s*setWarn\(partial\);\s*return;/);
});
```
(このファイルに `readFileSync`/`join` の import が無ければ足す)

- [ ] **Step 2:** 3ファイルを実行 → FAIL
- [ ] **Step 3: 実装**

`desk-form.ts`:
```ts
const PARTIAL_SCHEDULE = "日付と時刻の両方を入れてください(両方とも空なら日程調整中で保存できます)";
/** 内見の日時が片方だけか。片方だけで保存すると黙って「日程調整中」になる(詳細では入っていた予定が消える)。 */
export function partialScheduleError(date: string, time: string): string | null {
  return (date.trim() === "") !== (time.trim() === "") ? PARTIAL_SCHEDULE : null;
}
```
`validateDeskForm` の型を `Partial<Record<"agent" | "property" | "kind" | "viewingType" | "viewingAt", string>>` にし、最後に:
```ts
  if (s.kind === "viewing") {
    const partial = partialScheduleError(s.viewingDate, s.viewingTime);
    if (partial) e.viewingAt = partial;
  }
```
`inquiry-form.tsx`: 日付・時刻の `<div className="grid grid-cols-2 gap-2">…</div>` の直後に `<Err text={errors.viewingAt} />`。
`inquiry-detail.tsx` の `ViewingRow` の `save` の先頭(stale の判定の前)に:
```ts
    // 日付だけ・時刻だけでは保存しない=入っていた予定を黙って「日程調整中」にしない。
    const partial = partialScheduleError(val("date"), val("time"));
    if (partial) {
      setWarn(partial);
      return;
    }
```
(import に `partialScheduleError` を足す)

- [ ] **Step 4:** PASS・tsc 0
- [ ] **Step 5:** commit `fix(agent-inquiry): 内見の日付だけ・時刻だけでは保存しない(予定を黙って消さない)`

---

### Task 3: 切り替えボタンの読み上げ(aria-pressed)と詳細の読み込み中

**Files:** Modify `inquiry-form.tsx`・`inquiry-detail.tsx` / Test `inquiry-form.test.tsx`・`inquiry-list.test.tsx`

- [ ] **Step 1: 失敗するテスト**

```tsx
// inquiry-form.test.tsx
it("用件・案内/下見・入口の切り替えは押している方を aria-pressed で伝える", () => {
  let s = deskFormReducer(EMPTY_DESK_FORM, { type: "kind", value: "viewing" });
  s = deskFormReducer(s, { type: "viewing", field: "viewingType", value: "guided" });
  const html = view({ state: s });
  expect(html).toMatch(/aria-pressed="true"[^>]*>内見</);
  expect(html).toMatch(/aria-pressed="false"[^>]*>資料請求</);
  expect(html).toMatch(/aria-pressed="true"[^>]*>案内\(お客様連れ\)</);
  expect(html).toMatch(/aria-pressed="true"[^>]*>電話</);
  expect((html.match(/aria-pressed=/g) ?? []).length).toBe(8);
});
```
```tsx
// inquiry-list.test.tsx
it("詳細の状態の切り替えにも aria-pressed", () => {
  const src = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-detail.tsx"), "utf8");
  expect(src).toContain("aria-pressed={q.status === s}");
});
it("詳細は読み込み中も小窓を出す(押しても何も起きないように見せない)", () => {
  const src = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-detail.tsx"), "utf8");
  expect(src).toMatch(/if \(!data\) \{[\s\S]{0,600}読み込み中…/);
});
```

- [ ] **Step 2:** FAIL を確かめる
- [ ] **Step 3: 実装** — `inquiry-form.tsx` の切り替えボタン8つ(用件3・案内/下見2・入口3)に `aria-pressed={…が選ばれているか}` を足す(用件 `s.kind === k`/案内 `s.viewingType === "guided"`/下見 `s.viewingType === "preview"`/入口 `s.channel === c`)。`inquiry-detail.tsx` の状態3つのボタンに `aria-pressed={q.status === s}`。`InquiryDetail` の `if (!data) { return error ? (…) : null; }` を次に置き換える:
```tsx
  if (!data) {
    return error ? (
      <ModalShell size="sm" title="反響" onClose={onClose} footer={<Button onClick={onClose}>閉じる</Button>}>
        <p className="text-sm text-rose-600">{error}</p>
      </ModalShell>
    ) : (
      // 読み込み中も小窓を出す(押してから開くまでの間、何も起きないように見せない)。
      <ModalShell size="sm" title="反響" onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>閉じる</Button>}>
        <p className="text-sm text-gray-500 dark:text-gray-400">読み込み中…</p>
      </ModalShell>
    );
  }
```
- [ ] **Step 4:** PASS・tsc 0
- [ ] **Step 5:** commit `fix(agent-inquiry): 切り替えボタンの aria-pressed・詳細の読み込み中の表示`

---

### Task 4: 対応済みタブの期間(既定=直近30日)

**Files:** Modify `src/app/api/agent-inquiries/route.ts`・`src/lib/api-client.ts`・`desk-form.ts`・`inquiry-list.tsx`・`src/app/(desk)/inquiry-desk/page.tsx` / Test `agent-inquiry-inquiries-route.test.ts`・`agent-desk-api-client.test.ts`・`inquiry-list.test.tsx`・`agent-desk-page-scan.test.ts`

**Interfaces:** API `GET /api/agent-inquiries?days=N`(1〜3650・受けた日時が N 日以内)/`fetchAgentInquiries(p: { status?; assignee?; cursor?; days?: number })`/`DONE_PERIODS = [{ key: "30", label: "直近30日", days: 30 }, { key: "90", label: "直近90日", days: 90 }, { key: "all", label: "すべて", days: null }] as const`・`type DonePeriodKey = "30" | "90" | "all"`・`donePeriodDays(tab: InquiryStatusKey, period: DonePeriodKey): number | undefined`(対応済みのときだけ日数)

- [ ] **Step 1: 失敗するテスト**

```ts
// agent-inquiry-inquiries-route.test.ts の describe 内に追記
it("days=N で受けた日時が N 日以内に絞る(対応済みタブの期間)", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
  try {
    await LIST(new Request("http://x/api/agent-inquiries?status=done&days=30"));
    expect(pm.agentInquiry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "done", receivedAt: { gte: new Date("2026-09-02T00:00:00.000Z") } },
    }));
  } finally {
    vi.useRealTimers();
  }
});
it("days は 1〜3650 の整数だけ(それ以外は 422)", async () => {
  for (const d of ["0", "-1", "3651", "1.5", "abc"]) {
    expect((await LIST(new Request(`http://x/api/agent-inquiries?days=${d}`))).status).toBe(422);
  }
});
```
```ts
// agent-desk-api-client.test.ts に追記
it("一覧の days は指定したときだけ載せる", async () => {
  await fetchAgentInquiries({ status: "done", days: 30 });
  expect(call().url).toBe("/api/agent-inquiries?status=done&days=30");
});
```
```ts
// agent-desk-form.test.ts に追記
import { donePeriodDays } from "@/lib/agent-inquiry/desk-form";
it("期間は対応済みタブだけに効く(未対応・対応中は絞らない=対応漏れを隠さない)", () => {
  expect(donePeriodDays("done", "30")).toBe(30);
  expect(donePeriodDays("done", "90")).toBe(90);
  expect(donePeriodDays("done", "all")).toBeUndefined();
  expect(donePeriodDays("open", "30")).toBeUndefined();
  expect(donePeriodDays("in_progress", "90")).toBeUndefined();
});
```
```tsx
// inquiry-list.test.tsx に追記(既存の InquiryListView の呼び出しにも period={"30"} onPeriod={noop} を足す)
it("対応済みタブだけ期間を選べる(既定=直近30日)", () => {
  const done = renderToStaticMarkup(<InquiryListView tab="done" onTab={noop} mine={false} onMine={noop} items={[]} openCount={0}
    onOpen={noop} hasMore={false} onMore={noop} period="30" onPeriod={noop} />);
  expect(done).toContain('aria-label="対応済みの期間"');
  expect(done).toMatch(/<option value="30" selected="">直近30日<\/option>/);
  const open = renderToStaticMarkup(<InquiryListView tab="open" onTab={noop} mine={false} onMine={noop} items={[]} openCount={0}
    onOpen={noop} hasMore={false} onMore={noop} period="30" onPeriod={noop} />);
  expect(open).not.toContain("対応済みの期間");
});
```
```ts
// agent-desk-page-scan.test.ts に追記
it("★期間も一覧の絞り込みの鍵に入る(期間を替えた直後のもっと見るに前の期間の続きを混ぜない)", () => {
  expect(src).toMatch(/const filterKey = `\$\{tab\}\|\$\{mine\}\|\$\{period\}`;/);
  expect(src).toContain("days: donePeriodDays(tab, period)");
  expect(src).toMatch(/\}, \[tab, mine, period, reloadKey, onError, bodyVisible\]\);/);
});
```

- [ ] **Step 2:** FAIL を確かめる
- [ ] **Step 3: 実装**

API(`route.ts` の GET):
```ts
    const daysRaw = sp.get("days");
    const days = daysRaw == null ? undefined : z.coerce.number().int().min(1).max(3650).parse(daysRaw);
    const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : undefined;
```
`where` を `{ ...(status ? { status } : {}), ...(assigneeId ? { assigneeId } : {}), ...(since ? { receivedAt: { gte: since } } : {}) }` に。⚠`z.coerce.number()` は `"1.5"` を 1.5 にして `.int()` で落ちる・`"abc"` は NaN で落ちる(422)。

api-client: 引数の型に `days?: number`、`if (p.days) sp.set("days", String(p.days));` を `cursor` の前に(URL の並び=status, assignee, days, cursor)。⚠Step 1 の期待 URL は `status=done&days=30`。

desk-form:
```ts
export type DonePeriodKey = "30" | "90" | "all";
export const DONE_PERIODS: readonly { key: DonePeriodKey; label: string; days: number | null }[] = [
  { key: "30", label: "直近30日", days: 30 },
  { key: "90", label: "直近90日", days: 90 },
  { key: "all", label: "すべて", days: null },
];
/** 一覧の API に渡す日数。対応済みタブだけ=未対応・対応中は期間で絞らない(対応漏れを隠さない)。 */
export function donePeriodDays(tab: InquiryStatusKey, period: DonePeriodKey): number | undefined {
  if (tab !== "done") return undefined;
  return DONE_PERIODS.find((p) => p.key === period)?.days ?? undefined;
}
```

`inquiry-list.tsx`: props に `period: DonePeriodKey; onPeriod: (p: DonePeriodKey) => void` を足し、「自分の担当だけ」の label の前に:
```tsx
        {tab === "done" && (
          <select
            aria-label="対応済みの期間"
            value={period}
            onChange={(e) => onPeriod(e.target.value as DonePeriodKey)}
            className="mb-1 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
          >
            {DONE_PERIODS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        )}
```
⚠SSR で `selected=""` を出すため `value` ではなく、各 `<option>` に `selected={p.key === period}` を付けて `select` は `defaultValue` を使わない形でもよい — テストが落ちたら React の SSR が `value` を `selected` に写しているかを確かめ、写していなければ option 側に `selected` を付ける(その場合 `select` の `value` は外し `onChange` だけ残すと React が警告するので、`value` を残したまま option にも付ける)。

`page.tsx`: `const [period, setPeriod] = useState<DonePeriodKey>("30");`、`filterKey` を `` `${tab}|${mine}|${period}` ``、`setListKey` も同じ形、`fetchAgentInquiries({ status: tab, assignee: mine ? "me" : undefined, days: donePeriodDays(tab, period) })`(読み込みと `loadMore` の両方)、effect の依存に `period`、`<InquiryListView … period={period} onPeriod={setPeriod} />`。

- [ ] **Step 4:** 該当テスト PASS・tsc 0・`npx vitest run src/lib/__tests__/agent- src/components/agent-inquiry`
- [ ] **Step 5:** commit `feat(agent-inquiry): 対応済みタブの期間(既定=直近30日)`

---

### Task 5: 小窓(ModalShell)が透かしを描く

**Files:** Modify `src/components/ui/modal-shell.tsx`・`agent-create-modal.tsx`・`inquiry-detail.tsx` / Test `src/components/ui/__tests__/modal-shell.test.tsx`(追記)

- [ ] **Step 1: 失敗するテスト**

```tsx
// modal-shell.test.tsx に追記
import { vi } from "vitest";
describe("小窓の中の透かし(画面保護)", () => {
  it("★画面保護の中では、小窓の中にも透かしを描く(最前面の小窓は外の透かしを隠すため)", async () => {
    vi.resetModules();
    vi.doMock("@/components/screen-protection/screen-protection-provider", () => ({
      useScreenProtection: () => ({ bypass: false, watermarkText: "佐藤 2026-10-02" }),
    }));
    const { ModalShell: M } = await import("../modal-shell");
    expect(renderToStaticMarkup(<M title="題" footer={<span>F</span>} />)).toContain('data-testid="screen-protection-watermark"');
    vi.doUnmock("@/components/screen-protection/screen-protection-provider");
  });
  it("画面保護の外・bypass の人には描かない", async () => {
    vi.resetModules();
    vi.doMock("@/components/screen-protection/screen-protection-provider", () => ({
      useScreenProtection: () => ({ bypass: true, watermarkText: "佐藤" }),
    }));
    const { ModalShell: M } = await import("../modal-shell");
    expect(renderToStaticMarkup(<M title="題" footer={<span>F</span>} />)).not.toContain("screen-protection-watermark");
    vi.doUnmock("@/components/screen-protection/screen-protection-provider");
    // provider の外(既定値=watermarkText null)でも描かない
    expect(render(<ModalShell title="題" footer={<span>F</span>} />)).not.toContain("screen-protection-watermark");
  });
  it("★個別に描いていた2か所は外す(二重に描かない)", () => {
    for (const f of ["agent-create-modal.tsx", "inquiry-detail.tsx"]) {
      const src = readFileSync(join(process.cwd(), "src/components/agent-inquiry", f), "utf8");
      expect(src, f).not.toContain("<WatermarkOverlay");
    }
  });
});
```

- [ ] **Step 2:** FAIL を確かめる
- [ ] **Step 3: 実装** — `modal-shell.tsx` に import(`useScreenProtection`・`WatermarkOverlay`)を足し、`ModalShell` の中で `const { bypass, watermarkText } = useScreenProtection();`、`<h2>` の直前に:
```tsx
      {/* 小窓はブラウザの最前面に出るので、外の透かしは隠れる。器で描けば全部の小窓にそろう(@codex #459 R8/R21 の一般化)。 */}
      {!bypass && watermarkText && <WatermarkOverlay text={watermarkText} />}
```
`agent-create-modal.tsx` と `inquiry-detail.tsx` から `WatermarkOverlay` の描画・import・`useScreenProtection` の分割代入(使わなくなったもの)を外す。⚠既存テスト「旧 div 方式の overlay は残っていない(`fixed inset-0` を含まない)」は provider の外の SSR なので透かしは描かれず通る。⚠`ui-consistency-wave3.test.ts` 等の走査が ModalShell の中身を数えていて落ちたら、意図した変更として期待値を直す。
- [ ] **Step 4:** `npx vitest run src/components/ui src/components/agent-inquiry src/lib/__tests__/ui-consistency-wave3.test.ts` PASS・tsc 0
- [ ] **Step 5:** commit `fix(ui): 小窓(ModalShell)の中にも透かしを描く(全画面の小窓で画面保護をそろえる)`

---

### Task 6: 第3段の後回し(合図の自分の分・暗い画面の色・型・もっと見る)

**Files:** Modify `desk-sync.ts`・`agent-inquiry-tab.tsx`・`api-client.ts`・`src/app/(dashboard)/agents/page.tsx`・`src/app/(dashboard)/agents/[id]/page.tsx` / Test `agent-main-sync.test.ts`・`agent-inquiry-tab.test.tsx`・`agent-directory.test.tsx`・`agent-detail.test.tsx`

- [ ] **Step 1: 失敗するテスト**

```ts
// agent-main-sync.test.ts: 既存の「合図の中身」を置き換え+追記
it("合図の中身は「変わった」と窓ごとの印だけ(名前・電話・反響の id を載せない)", () => {
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  const seen: unknown[] = [];
  const listener = new FakeChannel(INQUIRY_SYNC_CHANNEL);
  listener.onmessage = (e) => seen.push(e.data);
  notifyInquiryChanged();
  expect(seen).toHaveLength(1);
  expect(Object.keys(seen[0] as object).sort()).toEqual(["from", "type"]);
  expect((seen[0] as { type: string }).type).toBe("changed");
});
it("★同じ窓が出した合図は聞かない(自分の保存で2回読み直さない)・別の窓の合図は聞く", () => {
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  const cb = vi.fn();
  onInquiryChanged(cb);
  notifyInquiryChanged();
  expect(cb).not.toHaveBeenCalled();
  new FakeChannel(INQUIRY_SYNC_CHANNEL).postMessage({ type: "changed", from: "other-window" });
  expect(cb).toHaveBeenCalledTimes(1);
});
```
(既存の「変わったと知らせると、聞いている側が呼ばれる」は、合図を `new FakeChannel(INQUIRY_SYNC_CHANNEL).postMessage({ type: "changed", from: "other-window" })` で出す形に直す=同じ窓の合図は聞かない仕様に合わせた意図した変更)

```tsx
// agent-inquiry-tab.test.tsx
it("「取り消し」に暗い画面の色", () => {
  expect(read("src/components/properties/agent-inquiry-tab.tsx")).toContain('text-xs text-gray-500 dark:text-gray-400">取り消し');
});
// agent-directory.test.tsx / agent-detail.test.tsx
it("もっと見るは読み込み中に押せず「読み込み中…」", () => {
  for (const f of ["src/app/(dashboard)/agents/page.tsx", "src/app/(dashboard)/agents/[id]/page.tsx"]) {
    const s = read(f);
    expect(s, f).toMatch(/disabled=\{loadingMore\}/);
    expect(s, f).toContain('{loadingMore ? "読み込み中…" : "もっと見る"}');
  }
});
```
(agent-directory.test.tsx は `read` を持っている。agent-detail.test.tsx も同じ)

型(M-6)は `npx tsc --noEmit` で確かめる: `src/lib/__tests__/agent-main-api-client.test.ts` に
```ts
// @ts-expect-error 商号は null にできない(API が 422 を返す)
void (() => updateAgent("x", { version: 1, companyName: null }));
```
を追記(型が緩いままだと「使われていない @ts-expect-error」で tsc が落ちる)。

- [ ] **Step 2:** FAIL(vitest)・tsc の失敗を確かめる
- [ ] **Step 3: 実装**
  - `desk-sync.ts`: `const WINDOW_TOKEN = safeRandomId();`(`@/lib/random-id`)、`type SyncMessage = { type: "changed"; from: string }`、送るのは `{ type: "changed", from: WINDOW_TOKEN }`、受けるのは `d?.type === "changed" && d.from !== WINDOW_TOKEN` のとき。冒頭コメントの「載せるのは『変わった』の一言だけ」を「『変わった』と窓ごとの乱数の印だけ」に直す。⚠物件の反響タブは自分の保存の後に自分で読み直しているので、同じ窓の合図を聞かなくても表示は最新になる。
  - `agent-inquiry-tab.tsx`: `<span className="mr-2 text-xs text-gray-500">取り消し</span>` → `text-xs text-gray-500 dark:text-gray-400`。
  - `api-client.ts` の `updateAgent` の body 型: `{ version: number; isArchived?: boolean; companyName?: string; phone?: string } & Partial<Record<Exclude<keyof DeskAgentInput, "companyName" | "phone">, string | null>>`。⚠`agents/[id]/page.tsx` の `agentAfterSave(a, body, …)` と `send` の引数型が合わなくなったら、`agentEditPatch` の戻り値を必須欄が `string` の型にする(`Partial<Record<"companyName" | "phone", string>> & Partial<Record<その他, string | null>>`)。
  - 名簿の一覧・詳細: `const [loadingMore, setLoadingMore] = useState(false);` を足し、`loadMore` の開始で `setLoadingMore(true)`・`finally` で `setLoadingMore(false)`(世代が変わっていても false に戻す)。ボタンを `<Button … disabled={loadingMore} …>{loadingMore ? "読み込み中…" : "もっと見る"}</Button>`。
- [ ] **Step 4:** PASS・tsc 0
- [ ] **Step 5:** commit `fix(agent-inquiry): 第3段の後回し(同じ窓の合図は聞かない・暗い画面の色・業者の更新の型・もっと見るの読み込み中)`

---

### Task 7(**要承認=発注者の OK があるときだけ**): 二重登録を防ぐ鍵

**Files:** Modify `prisma/schema.prisma`・Create `prisma/migrations/20261002100000_add_agent_client_tokens/migration.sql`・Modify `src/lib/agent-inquiry/validators.ts`・`src/app/api/agent-inquiries/route.ts`・`src/app/api/agents/route.ts`・`desk-form.ts`・`inquiry-form.tsx`・`agent-create-modal.tsx`・`api-client.ts` / Test `agent-inquiry-inquiries-route.test.ts`・`agent-inquiry-agents-route.test.ts`・`agent-desk-form.test.ts`・`agent-inquiry-migration-scan.test.ts`(追記)・`inquiry-form.test.tsx`

**Interfaces:** 登録の body に `clientToken?: string`(uuid)/応答は新規=201 `{ id }`・同じ鍵の2回目=200 `{ id, replayed: true }`/`tokenForSubmit<T>(prev: { snapshot: T; token: string } | null, snapshot: T, gen: () => string): { snapshot: T; token: string }`(前回と同じ中身=同じ参照なら同じ鍵、違えば新しい鍵)

- [ ] **Step 1: migration と schema**

```sql
-- prisma/migrations/20261002100000_add_agent_client_tokens/migration.sql
-- 業者からの反響の受付: 二重登録を防ぐ鍵(通信が切れて押し直しても、同じ鍵なら1回目の分を返す)。
-- 列を足すだけ(NULL 可・既存行は NULL のまま)。一意は「登録者×鍵」(NULL どうしは重ならない)。
-- ロールバック: コードを戻せば列は参照されなくなるだけ(無害)。

ALTER TABLE "agent_inquiries" ADD COLUMN "client_token" UUID;
ALTER TABLE "agents" ADD COLUMN "client_token" UUID;

CREATE UNIQUE INDEX "agent_inquiries_created_by_id_client_token_key" ON "agent_inquiries"("created_by_id", "client_token");
CREATE UNIQUE INDEX "agents_created_by_id_client_token_key" ON "agents"("created_by_id", "client_token");
```
schema: `AgentInquiry` と `Agent` に `clientToken String? @map("client_token") @db.Uuid` と `@@unique([createdById, clientToken])`。`npx prisma generate`。`agent-inquiry-migration-scan.test.ts` に「このファイルは ALTER TABLE … ADD COLUMN と CREATE UNIQUE INDEX だけ(DROP・UPDATE・DELETE・NOT NULL を含まない)」の走査を足す(既存の走査の書き方に合わせる)。

- [ ] **Step 2: 失敗するテスト(API)**

```ts
// agent-inquiry-inquiries-route.test.ts(prisma の mock の agentInquiry に findFirst: vi.fn(async () => null) を足す)
const TOKEN = "77777777-7777-4777-8777-777777777777";
it("★同じ鍵の2回目は作らずに1回目の id を返す(200・replayed)", async () => {
  pm.agentInquiry.findFirst.mockResolvedValueOnce({ id: IID });
  const res = await POST(json("POST", { propertyId: PID, agentId: AID, kind: "ad_permission", clientToken: TOKEN }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: IID, replayed: true });
  expect(pm.agentInquiry.create).not.toHaveBeenCalled();
  expect(writeAuditLog).not.toHaveBeenCalled();
  expect(pm.agentInquiry.findFirst).toHaveBeenCalledWith({ where: { createdById: "u-field", clientToken: TOKEN }, select: { id: true } });
});
it("★同時に2回届いて一意の索引にぶつかったら、既存の id を返す", async () => {
  pm.agentInquiry.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: IID });
  pm.agentInquiry.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
  const res = await POST(json("POST", { propertyId: PID, agentId: AID, kind: "ad_permission", clientToken: TOKEN }));
  expect(res.status).toBe(200);
  expect((await res.json()).id).toBe(IID);
});
it("鍵は登録者ごと=別の人の同じ鍵とは混ざらない・鍵を作るときに保存する", async () => {
  await POST(json("POST", { propertyId: PID, agentId: AID, kind: "ad_permission", clientToken: TOKEN }));
  expect(pm.agentInquiry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ clientToken: TOKEN, createdById: "u-field" }) }));
});
it("鍵は uuid だけ(それ以外は 422)・鍵なしはこれまでどおり 201", async () => {
  expect((await POST(json("POST", { propertyId: PID, agentId: AID, kind: "ad_permission", clientToken: "abc" }))).status).toBe(422);
  expect((await POST(json("POST", { propertyId: PID, agentId: AID, kind: "ad_permission" }))).status).toBe(201);
});
```
`agent-inquiry-agents-route.test.ts` にも同じ形の3件(業者の登録・`pm.agent.findFirst`)。

- [ ] **Step 3: 失敗するテスト(画面の純関数)**

```ts
// agent-desk-form.test.ts
import { tokenForSubmit } from "@/lib/agent-inquiry/desk-form";
describe("押し直しの鍵", () => {
  let n = 0;
  const gen = () => `t${++n}`;
  it("★中身を変えずに押し直したら同じ鍵(二重にならない)", () => {
    const s = { a: 1 };
    const first = tokenForSubmit(null, s, gen);
    expect(tokenForSubmit(first, s, gen).token).toBe(first.token);
  });
  it("★中身を直してから押したら新しい鍵(直した内容を1回目の分で黙って捨てない)", () => {
    const first = tokenForSubmit(null, { a: 1 }, gen);
    expect(tokenForSubmit(first, { a: 2 }, gen).token).not.toBe(first.token);
  });
});
```
```tsx
// inquiry-form.test.tsx
it("保存できたか分からないときは、そのまま押し直してよいと伝える(同じ鍵で送る)", () => {
  const src = readFileSync(join(process.cwd(), "src/components/agent-inquiry/inquiry-form.tsx"), "utf8");
  expect(src).toContain("tokenForSubmit(");
  expect(src).toContain("clientToken:");
  expect(src).toContain("そのまま「保存する」を押してください(二重には登録されません)");
});
```

- [ ] **Step 4:** FAIL を確かめる
- [ ] **Step 5: 実装**
  - `validators.ts`: `inquiryCreateSchema` と `agentCreateSchema` に `clientToken: uuid.optional()`(`agentUpdateSchema` は `agentCreateSchema.partial()` から作っているので、`.omit({ clientToken: true })` を挟んで PATCH では受けない)。
  - `agent-inquiries/route.ts` の POST: `requireAgentInquiry` の後に
    ```ts
    // 同じ人が同じ鍵で送り直した(通信が切れて押し直した)=作らずに1回目の分を返す。
    const replay = async () =>
      input.clientToken
        ? prisma.agentInquiry.findFirst({ where: { createdById: session.id, clientToken: input.clientToken }, select: { id: true } })
        : null;
    const prev = await replay();
    if (prev) return NextResponse.json({ id: prev.id, replayed: true }, { headers: NO_STORE });
    ```
    `create` の data に `clientToken: input.clientToken ?? null`。`$transaction` を `try` で包み、`(e as { code?: string })?.code === "P2002" && input.clientToken` のときは `const again = await replay(); if (again) return NextResponse.json({ id: again.id, replayed: true }, …)`、それ以外は投げ直す。監査は新規のときだけ。
  - `agents/route.ts` の POST も同じ形(`prisma.agent.findFirst`)。
  - `desk-form.ts`:
    ```ts
    /** 押し直しの鍵。前回と同じ中身(同じ参照)なら同じ鍵、直していたら新しい鍵。 */
    export function tokenForSubmit<T>(prev: { snapshot: T; token: string } | null, snapshot: T, gen: () => string) {
      return prev && prev.snapshot === snapshot ? prev : { snapshot, token: gen() };
    }
    ```
    `AgentInquiryCreateBody` と `DeskAgentInput`(api-client)に `clientToken?: string`。
  - `inquiry-form.tsx`: `const tokenRef = useRef<{ snapshot: DeskFormState; token: string } | null>(null);`、`submit` で `const t = tokenForSubmit(tokenRef.current, state, safeRandomId); tokenRef.current = t;` → `createAgentInquiry({ ...buildCreateBody(state), clientToken: t.token })`。成功(201/200)で `tokenRef.current = null`。分からない失敗の文言を「保存できたか分かりません(通信が切れました)。<b>中身を変えずに</b>そのまま「保存する」を押してください(二重には登録されません)。直してから押す場合は、右の一覧に出ていないか先に確かめてください。」に(プレーン文字列で `<b>` は使わない)。
  - `agent-create-modal.tsx`: 入力の値 `v`(useState のオブジェクト=変えると新しい参照)で同じことをし、`createDeskAgent({ …, clientToken: t.token })`。文言も「そのまま「登録して戻る」を押してください(二重には登録されません)。…」に。
  - ⚠`reducer` の no-op は同じ参照を返す前提(`deskFormReducer` は変化のない操作でも新しいオブジェクトを返す箇所がある=その場合は新しい鍵になるだけ=安全側)。
- [ ] **Step 6:** 全テスト PASS・tsc 0・`npx prisma validate`
- [ ] **Step 7:** commit `feat(agent-inquiry): 二重登録を防ぐ鍵(押し直しても同じ反響・業者を二重に作らない・migration あり)`

---

### Task 8: 全ゲート・実ブラウザ確認・レビュー・PR

- [ ] **Step 1:** `npx tsc --noEmit`・`npx vitest run > out; echo exit=$?`(終了コードで判定)・変更ファイルの eslint・`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`・`git diff --stat origin/main | grep " Bin "` が空
- [ ] **Step 2: 実ブラウザ確認**(本番ビルド `next start` + 使い捨てDB `pm_agent_polish_check`・`LOCAL_UPLOAD_ROOT` は scratchpad。⚠この worktree の `next dev --webpack` は instrumentation で 500 になる既存の問題があるため使わない):
  1. 受付の窓で問い合わせ者の欄に打って Enter → 保存されない(エラーも並ばない)。メモ欄の Enter は改行
  2. 内見で日付だけ入れて保存 → 「日付と時刻の両方を…」が出て保存されない。両方空なら日程調整中で保存できる
  3. 詳細で時刻だけ消して保存 → 理由が出て予定は残る
  4. 一覧の行を押すと、すぐ「読み込み中…」の小窓が出て中身に切り替わる
  5. 対応済みタブ: 既定「直近30日」・「すべて」で古い分も出る・期間を替えてすぐ「もっと見る」でも混ざらない
  6. メイン画面の小窓(テンプレートの新規作成・確認ダイアログなど2つ以上)と受付の窓の小窓の中に透かしが出る(二重になっていない)
  7. 物件の反響タブで広告の可否を押す → 読み直しが1回(Network で GET が1本)
  8. (Task 7 をした場合)開発者ツールで通信を切って保存 →「保存できたか分かりません…そのまま押してください」→ 通信を戻して押す → 一覧に1件だけ
  9. スマホ幅 390px
- [ ] **Step 3: 提出前レビュー**(別AI・ブランチ全体・Review Focus を渡す)→ Critical/Important を修正
- [ ] **Step 4:** push・PR(平易な日本語・Task 7 の有無と migration の有無を明記)・`@codex review`・Monitor(⚠応答の新しい形=「Codex Review Summary」の状態表コメントは Running → Completed に書き換わる。これを応答と数えない)・CI
- [ ] **Step 5:** メモリ更新

## この PR でやらないこと

- 地図のピン詳細(ModalShell ではない独自の小窓)の透かし。
- 第3段の M-4(保存の遷移を純関数へ出して総当たりで固める)。
- 物件の時系列・名簿の履歴から「その反響を受付の窓で開く」。
- 内見の追加(`POST …/viewings`)の鍵(今は「確かめた」を押すまで止める形で二重を防いでいる)。
