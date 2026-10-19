# UIの統一と「押した手応え」 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全画面のボタンに「押すと沈む」手応えを入れ、共通部品(ボタン・小窓・タブ・お知らせ・カード・読み込み中)に標準の強さの動きを持たせ、手書きボタン541個を5回に分けて共通部品へ寄せる。

**Architecture:** 動きの値は `src/app/globals.css` の `@theme`(Tailwind v4 トークン)に1か所で持つ。第1回は `@layer base` の詳細度0の規則で全 `<button>` に手応えを入れる(各画面の utilities が必ず勝つ)。第2回は `src/components/ui/` の部品を、今のpropsを保ったまま中身だけ良くする。第3回以降は画面のまとまりごとに置き換え、走査テストで逆戻りを止める。

**Tech Stack:** Next.js(App Router)・React・Tailwind CSS v4・lucide-react・vitest(env=node・`renderToStaticMarkup`+ソース文字列assert)

**Spec:** `docs/superpowers/specs/2026-10-19-ui-unify-motion-design.md`

## Global Constraints

- 動きの強さ=「標準」: 押すと `scale: .97`、主ボタンに薄い影(乗せると濃く)
- 速さ: 押す・離す=120ms / 色・影・タブの下線=180ms / 小窓・お知らせの出入り=220ms
- 曲線: `cubic-bezier(.2,.8,.2,1)`(トークン名 `--ease-out-soft`)
- 角丸: 操作要素=`rounded-md` / カード・小窓=`rounded-lg` / 札・丸ボタン=`rounded-full`。`rounded-xl` は使わない
- 主ボタンの色は藍(`bg-indigo-600`・乗せると `bg-indigo-700`)。状態色(緑=完了・赤=削除・琥珀=注意)は残す
- `prefers-reduced-motion: reduce` では沈み・すべり・ふわっとを出さない(色の変化だけ残す)
- ダークモードは class 方式(`.dark`)。`@media (prefers-color-scheme: dark)` を globals.css に書かない(既存テスト `globals-dark.test.ts` が禁止)
- 対象外: `data-motion="off"` を付けた要素とその中、`aria-pressed` を持つボタン
- 機能・置き場所・文言は変えない。依存を追加しない。スマホの入力欄16px対策・画面保護・印刷の規則は触らない
- commit 末尾:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BQfqYHEwzEsokryZ4G8UhG
  ```
- 作業場所: worktree `C:\Users\issin\Desktop\Claude\property-management-worktrees\ui-unify-motion`(branch `feat/ui-unify-motion`)。最初に `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci` と `npx prisma generate`
- 各PRの前に全ゲート: `npx tsc --noEmit` / `npx vitest run`(フル。既知の揺れ=`src/lib/edit-lock/__tests__/screen-token-client.test.ts` は単体で再実行して緑なら可)/ `npx eslint <変更ファイル>` / `NODE_OPTIONS=--max-old-space-size=4096 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`

## Review Focus

1. **横幅いっぱいのボタン**(一覧の行・写真の縮小表示・アコーディオンの見出し)が押したとき3%縮んで目立つ → 謄本の実況パネルは丸ごと外す(Task 1)。他は実機確認リストで拾い、気になる箇所は `data-motion="off"` を足す
2. **ダークモードのタブ**で、すべる下線と元の下線が二重に出る → `dark:` 側にも打ち消しを入れ、テストで固定(Task 4)
3. **処理中→✓ の切替で幅が変わり、隣のボタンが動く** → `loading`/`done` の間も元の文言を `invisible` で残し、幅を保つ(Task 2)
4. **フォーム内のボタンを押しながらドラッグ**(押したまま外へ出る)で沈んだまま戻らない → `:active` は離した時点で外れるのでCSSだけで戻る。テストは不要だが実機確認リストに入れる
5. **小窓が開く動きの途中で Escape**/すぐ閉じる → 動きは見た目だけで、開閉は今のまま即時(Task 3)。showModal とフォーカス復帰を壊していないことを既存テストが固定

---

## 第1回(PR 1本): 全ボタンの手応え

### Task 1: 動きのトークン+全ボタンの規則+対象外の印

**Files:**
- Modify: `src/app/globals.css`(`@theme` に追加・`@layer base` を新設・keyframes 追加)
- Modify: `src/components/field-survey/field-survey-map.tsx:1304`(地図の外枠に `data-motion="off"`)
- Modify: `src/components/properties/registry-live-panel.tsx:297-299`(実況パネルの外枠に `data-motion="off"`)
- Create: `src/app/__tests__/globals-motion.test.ts`

**Interfaces:**
- Produces(後のタスクが使う Tailwind クラス): `ease-out-soft` / `animate-pm-dialog-in` / `backdrop:animate-pm-backdrop-in` / `animate-pm-pop` / `animate-pm-shimmer` / `animate-pm-toast-in`
- Produces(属性): `data-motion="off"` = その要素と中のボタンを手応えの対象から外す

- [ ] **Step 1: 失敗するテストを書く**

`src/app/__tests__/globals-motion.test.ts`:

```ts
/**
 * UIの統一と押した手応え 第1回: 全ボタンの規則・動きのトークン(設計書 §1・§2)。
 * CSS は実行できないので、規則の存在と「外し方」を文字列で固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
const css = read("src/app/globals.css");

describe("動きのトークン", () => {
  it("曲線と出入りの動きを @theme に持つ", () => {
    expect(css).toContain("--ease-out-soft: cubic-bezier(.2, .8, .2, 1);");
    for (const name of ["pm-dialog-in", "pm-backdrop-in", "pm-pop", "pm-shimmer", "pm-toast-in"]) {
      expect(css).toContain(`--animate-${name}:`);
      expect(css).toContain(`@keyframes ${name}`);
    }
  });
  it("出入りは 220ms・ボタンの押下は 120ms", () => {
    expect(css).toMatch(/--animate-pm-dialog-in: pm-dialog-in 220ms var\(--ease-out-soft\)/);
    expect(css).toMatch(/--animate-pm-toast-in: pm-toast-in 220ms var\(--ease-out-soft\)/);
  });
});

describe("全ボタンの手応え(@layer base)", () => {
  const base = css.slice(css.indexOf("@layer base"));
  it("@layer base の中にある(= utilities の指定が必ず勝つ)", () => {
    expect(css).toContain("@layer base {");
    expect(base).toContain(":where(button)");
  });
  it("対象外: aria-pressed・data-motion=off とその中", () => {
    expect(base).toContain(
      ':not(:where([aria-pressed], [data-motion="off"], [data-motion="off"] *))',
    );
  });
  it("押すと scale .97(transform ではなく scale プロパティ)", () => {
    expect(base).toContain("scale: 0.97;");
    expect(base).not.toMatch(/transform:\s*scale\(0?\.97\)/);
  });
  it("押せない状態では沈まない", () => {
    expect(base).toContain(':disabled, [aria-disabled="true"]');
  });
  it("沈みと影の動きは reduced-motion で出さない(no-preference の中だけ)", () => {
    const np = base.slice(base.indexOf("@media (prefers-reduced-motion: no-preference)"));
    expect(np).toContain("scale: 0.97;");
    expect(np).toContain("box-shadow");
  });
  it("キーボードで選んだ時に藍の枠", () => {
    expect(base).toMatch(/:focus-visible\s*\{[^}]*outline: 2px solid var\(--color-indigo-500\)/);
  });
});

describe("対象外の印", () => {
  it("地図の外枠(丸ボタン群)", () => {
    expect(read("src/components/field-survey/field-survey-map.tsx")).toContain(
      '<div data-motion="off" className="relative h-full w-full">',
    );
  });
  it("謄本の実況パネル(中止ボタン・写真の縮小表示)", () => {
    expect(read("src/components/properties/registry-live-panel.tsx")).toMatch(
      /data-testid="registry-live-panel"\s+data-motion="off"/,
    );
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/app/__tests__/globals-motion.test.ts`
Expected: FAIL(`--ease-out-soft` が無い・`@layer base` が無い・印が無い)

- [ ] **Step 3: globals.css を実装**

既存の `@theme { --color-gray-* }` ブロックの**後ろ**に、新しい `@theme` を足す:

```css
/*
 * UIの統一と押した手応え(2026-10-19・設計書 docs/superpowers/specs/2026-10-19-ui-unify-motion-design.md):
 * 動きの値はここ1か所。tsx からは ease-out-soft / animate-pm-* で使う。
 */
@theme {
  --ease-out-soft: cubic-bezier(.2, .8, .2, 1);
  --animate-pm-dialog-in: pm-dialog-in 220ms var(--ease-out-soft);
  --animate-pm-backdrop-in: pm-backdrop-in 220ms var(--ease-out-soft);
  --animate-pm-toast-in: pm-toast-in 220ms var(--ease-out-soft);
  --animate-pm-pop: pm-pop 300ms var(--ease-out-soft);
  --animate-pm-shimmer: pm-shimmer 1.4s linear infinite;
}
```

ファイル末尾の既存 `@keyframes pm-toast-in { ... }` は残し、その下に足す:

```css
@keyframes pm-dialog-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes pm-backdrop-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes pm-pop {
  from {
    opacity: 0;
    transform: scale(0.4);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes pm-shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

/*
 * 全ボタンの手応え(第1回)。:where で詳細度0・@layer base なので、各画面が書いた
 * transition-* / scale-* / outline-* / shadow-* が必ず勝つ。
 * transform ではなく scale プロパティ = Tailwind v4 の translate-* / rotate-* と打ち消し合わない。
 * 対象外: 3つ切替など aria-pressed のボタン群・data-motion="off" の要素とその中(地図の丸ボタン・謄本の実況)。
 */
@layer base {
  :where(button):not(:where([aria-pressed], [data-motion="off"], [data-motion="off"] *)) {
    transition-property: color, background-color, border-color;
    transition-duration: 180ms;
    transition-timing-function: var(--ease-out-soft);
  }
  :where(button):focus-visible {
    outline: 2px solid var(--color-indigo-500);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: no-preference) {
    :where(button):not(:where([aria-pressed], [data-motion="off"], [data-motion="off"] *)) {
      transition-property: color, background-color, border-color, box-shadow, scale;
      transition-duration: 180ms, 180ms, 180ms, 180ms, 120ms;
    }
    :where(button):not(
        :where(:disabled, [aria-disabled="true"], [aria-pressed], [data-motion="off"], [data-motion="off"] *)
      ):active {
      scale: 0.97;
    }
  }
}
```

⚠ テストの `':disabled, [aria-disabled="true"]'` に合うよう、上の `:where(` の中は1行で書いてもよい(改行位置はテストに影響しない部分のみ)。

- [ ] **Step 4: 対象外の印を付ける**

`src/components/field-survey/field-survey-map.tsx` の 1304 行:

```tsx
      <div data-motion="off" className="relative h-full w-full">
```

`src/components/properties/registry-live-panel.tsx` の 297〜299 行:

```tsx
    <div
      data-testid="registry-live-panel"
      data-motion="off"
      className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900"
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/app/__tests__/globals-motion.test.ts src/app/__tests__/globals-dark.test.ts src/components/field-survey src/components/properties/__tests__`
Expected: PASS

- [ ] **Step 6: build で CSS が通ることを確認**

Run: `NODE_OPTIONS=--max-old-space-size=4096 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > build.log 2>&1; echo exit=$?`
Expected: `exit=0`。続けて `grep -o "pm-dialog-in[^;]*" .next/static/css/*.css | head -3` で keyframes が出力 CSS に入っていることを見る(入っていなければ Tailwind が未使用トークンを落としている=Task 3 で使われるまで出ないのは可。`@keyframes` は globals.css 直書きなので必ず残る)

- [ ] **Step 7: Commit**

```bash
git add src/app/globals.css src/app/__tests__/globals-motion.test.ts src/components/field-survey/field-survey-map.tsx src/components/properties/registry-live-panel.tsx
git commit -m "feat(ui): 全ボタンに押した手応え(動きのトークン+@layer base の規則)"
```

- [ ] **Step 8: 第1回の提出**

全ゲート → 提出前レビュー(`feature-dev:code-reviewer`。観点: 詳細度0で既存の見た目を上書きしていないか・地図/実況の除外・reduced-motion・ダーク)→ push → PR(タイトル `feat(ui): 全ボタンに押した手応え`)→ `@codex review` → 3系統+CI 監視。実機確認リストに「押すと沈む(PC/スマホ)」「地図の丸ボタンは沈まない」「謄本の実況の中止は沈まない」「Tabキーで藍の枠」「横幅いっぱいのボタンが気にならないか」「押したまま外へ指をずらすと戻る」を追加。

---

## 第2回(PR 1本): 共通部品を作り直す

第1回のマージ後に、最新 main から branch `feat/ui-unify-parts` を新しい worktree で切る(1タスク1worktree)。

### Task 2: Button に loading / done / ghost / lg と主ボタンの影

**Files:**
- Modify: `src/components/ui/button.tsx`
- Modify: `src/components/ui/confirm-dialog.tsx`(busy の手書きくるくる → `loading`)
- Test: `src/components/ui/__tests__/button.test.tsx`

**Interfaces:**
- Consumes: `animate-pm-pop`(Task 1)
- Produces:
  ```ts
  export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
  export type ButtonSize = "md" | "sm" | "lg";
  export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    /** 処理中。くるくる+loadingLabel を出し、自動で押せなくする(二度押し防止)。 */
    loading?: boolean;
    /** 処理中の文言。既定「処理中」。 */
    loadingLabel?: string;
    /** 完了。✓+doneLabel を出す。戻すのは呼び出し側(1.2秒後に false にする)。 */
    done?: boolean;
    /** 完了の文言。既定「完了しました」。 */
    doneLabel?: string;
  }
  ```

- [ ] **Step 1: 失敗するテストを書く**(`button.test.tsx` の `describe("Button")` の末尾に追加)

```tsx
  it("primary は薄い影・乗せると濃く(押せないときは影なし)", () => {
    const out = html({});
    expect(out).toContain("shadow-xs");
    expect(out).toContain("hover:shadow-sm");
    expect(out).toContain("disabled:shadow-none");
    expect(html({ variant: "secondary" })).not.toContain("shadow-xs");
  });

  it("ghost = 枠なし・乗せると薄い灰", () => {
    const out = html({ variant: "ghost" });
    expect(out).toContain("bg-transparent");
    expect(out).toContain("hover:bg-gray-100");
    expect(out).toContain("dark:hover:bg-gray-800");
    expect(out).not.toContain("bg-indigo-600");
  });

  it("lg = スマホの主操作(高さ44px以上)", () => {
    const out = html({ size: "lg" });
    expect(out).toContain("min-h-11");
    expect(out).toContain("px-5");
  });

  it("loading: くるくる+文言・押せない・aria-busy・元の文言は幅を保つため invisible で残す", () => {
    const out = html({ loading: true }, "保存する");
    expect(out).toContain("animate-spin");
    expect(out).toContain("処理中");
    expect(out).toContain("disabled");
    expect(out).toContain('aria-busy="true"');
    expect(out).toMatch(/<span class="invisible"[^>]*>保存する<\/span>/);
  });

  it("loadingLabel を差し替えられる", () => {
    expect(html({ loading: true, loadingLabel: "保存中" }, "保存する")).toContain("保存中");
  });

  it("done: ✓(ポンと出る)+文言。loading より done が優先", () => {
    const out = html({ done: true, loading: true }, "保存する");
    expect(out).toContain("animate-pm-pop");
    expect(out).toContain("motion-reduce:animate-none");
    expect(out).toContain("完了しました");
    expect(out).not.toContain("animate-spin");
  });

  it("通常時は invisible の重ねを出さない(余計な要素を増やさない)", () => {
    const out = html({}, "保存する");
    expect(out).not.toContain("invisible");
    expect(out).toContain(">保存する</button>");
  });
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/components/ui/__tests__/button.test.tsx`
Expected: 新しい7件が FAIL(`shadow-xs` 無し・`ghost` 未対応 など)

- [ ] **Step 3: 実装**

`src/components/ui/button.tsx` の import 以降を次に置き換える(先頭の説明コメントには規約の追記として「ghost=枠なし・lg=スマホの主操作・loading/done=処理中と完了をボタンの中で見せる(2026-10-19 UIの統一)」の3行を足す):

```tsx
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Check, Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "md" | "sm" | "lg";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-indigo-600 text-white shadow-xs hover:bg-indigo-700 hover:shadow-sm disabled:shadow-none disabled:hover:bg-indigo-600",
  secondary:
    "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:hover:bg-white dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800 dark:disabled:hover:bg-gray-900",
  danger:
    "bg-red-600 text-white hover:bg-red-700 disabled:hover:bg-red-600",
  ghost:
    "bg-transparent text-gray-700 hover:bg-gray-100 disabled:hover:bg-transparent dark:text-gray-200 dark:hover:bg-gray-800",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: "px-4 py-2 text-sm",
  sm: "px-3 py-1.5 text-xs",
  lg: "min-h-11 px-5 py-2.5 text-base",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 処理中。くるくる+loadingLabel を出し、自動で押せなくする(二度押し防止)。 */
  loading?: boolean;
  /** 処理中の文言。既定「処理中」。 */
  loadingLabel?: string;
  /** 完了。✓+doneLabel を出す。戻すのは呼び出し側(1.2秒後に false にする)。 */
  done?: boolean;
  /** 完了の文言。既定「完了しました」。 */
  doneLabel?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      type = "button",
      loading = false,
      loadingLabel = "処理中",
      done = false,
      doneLabel = "完了しました",
      disabled,
      className,
      children,
      ...rest
    },
    ref,
  ) {
    const base =
      "relative inline-flex items-center justify-center gap-1.5 rounded-md font-medium disabled:cursor-not-allowed disabled:opacity-60";
    // ⚠done を優先(完了の直後に loading が残っていても✓を見せる)。
    const state: "idle" | "loading" | "done" = done ? "done" : loading ? "loading" : "idle";
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || state === "loading"}
        aria-busy={state === "loading" ? true : undefined}
        className={`${base} ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]}${className ? ` ${className}` : ""}`}
        {...rest}
      >
        {state === "idle" ? (
          children
        ) : (
          <>
            {/* 元の文言は幅を保つためだけに残す(処理中/完了の切替で隣のボタンが動かない)。 */}
            <span className="invisible" aria-hidden="true">
              {children}
            </span>
            <span className="absolute inset-0 inline-flex items-center justify-center gap-1.5">
              {state === "loading" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="h-4 w-4 animate-pm-pop motion-reduce:animate-none" aria-hidden="true" />
              )}
              {state === "loading" ? loadingLabel : doneLabel}
            </span>
          </>
        )}
      </button>
    );
  },
);
```

⚠ `aria-hidden="true"` の span は `renderToStaticMarkup` で `<span class="invisible" aria-hidden="true">` になる。Step 1 の正規表現 `/<span class="invisible"[^>]*>保存する<\/span>/` はこれに合う。

- [ ] **Step 4: ConfirmDialog を loading に寄せる**

`src/components/ui/confirm-dialog.tsx` の import から `Loader2` を消し、危険ボタンを:

```tsx
          <Button variant="danger" onClick={onConfirm} disabled={busy} loading={busy} loadingLabel={confirmLabel}>
            {confirmLabel}
          </Button>
```

(文言は今と同じ「削除」等のまま。くるくるは Button が出す)

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/components/ui`
Expected: PASS(既存の ConfirmDialog「busy 中は両ボタンとも押せない」も緑のまま)

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/button.tsx src/components/ui/confirm-dialog.tsx src/components/ui/__tests__/button.test.tsx
git commit -m "feat(ui): 共通ボタンに処理中/完了・ghost・lg・主ボタンの影"
```

### Task 3: 小窓とお知らせの出る動き

**Files:**
- Modify: `src/components/ui/modal-shell.tsx`(dialog の className)
- Modify: `src/components/ui/toast-stack.tsx:58`
- Test: `src/components/ui/__tests__/modal-shell.test.tsx`・`src/components/ui/__tests__/notification-ui.test.tsx`

**Interfaces:**
- Consumes: `animate-pm-dialog-in` / `backdrop:animate-pm-backdrop-in` / `animate-pm-toast-in`(Task 1)
- Produces: なし(見た目だけ)

- [ ] **Step 1: 失敗するテストを書く**

`modal-shell.test.tsx` の `describe("ModalShell")` 末尾に(ファイル先頭の既存 import と描画ヘルパーをそのまま使う。ヘルパー名が違う場合は既存の「size で幅が変わる」テストと同じ書き方で描画する):

```tsx
  it("開くとき: 中身がふわっと上がり、背景が薄く暗くなる(reduced-motion では動かさない)", () => {
    const src = readFileSync(join(process.cwd(), "src/components/ui/modal-shell.tsx"), "utf8");
    expect(src).toContain("animate-pm-dialog-in");
    expect(src).toContain("backdrop:animate-pm-backdrop-in");
    expect(src).toContain("motion-reduce:animate-none");
    expect(src).toContain("motion-reduce:backdrop:animate-none");
  });

  it("閉じる動きは付けない(呼び出し側が部品ごと外す作り=即時に消える)", () => {
    const src = readFileSync(join(process.cwd(), "src/components/ui/modal-shell.tsx"), "utf8");
    expect(src).not.toMatch(/pm-dialog-out|onAnimationEnd/);
  });
```

`notification-ui.test.tsx` の ToastStack を扱う describe の末尾に:

```tsx
  it("お知らせは出入りの決まり(220ms・ease-out-soft)で出る", () => {
    const src = readFileSync(join(process.cwd(), "src/components/ui/toast-stack.tsx"), "utf8");
    expect(src).toContain("animate-pm-toast-in motion-reduce:animate-none");
    expect(src).not.toContain("animate-[pm-toast-in_200ms_ease-out]");
  });
```

(`readFileSync`/`join` が未 import ならファイル先頭に `import { readFileSync } from "node:fs"; import { join } from "node:path";` を足す)

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/components/ui/__tests__/modal-shell.test.tsx src/components/ui/__tests__/notification-ui.test.tsx`
Expected: 新しい3件のうち「開くとき」「お知らせ」が FAIL

- [ ] **Step 3: 実装**

`modal-shell.tsx` の dialog の className を:

```tsx
      className={`m-auto w-full ${SIZE_CLASSES[size]} rounded-lg bg-white p-6 shadow-xl backdrop:bg-black/50 animate-pm-dialog-in backdrop:animate-pm-backdrop-in motion-reduce:animate-none motion-reduce:backdrop:animate-none dark:bg-gray-900${className ? ` ${className}` : ""}`}
```

先頭コメントの規約に「開くときだけ 220ms で上がって現れる(閉じるのは即時・2026-10-19 UIの統一)」を1行足す。

`toast-stack.tsx:58` の `animate-[pm-toast-in_200ms_ease-out] motion-reduce:animate-none` を `animate-pm-toast-in motion-reduce:animate-none` に置き換える。先頭コメントの「動きは出るときに少し上がるだけ」はそのまま。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/components/ui`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/modal-shell.tsx src/components/ui/toast-stack.tsx src/components/ui/__tests__/modal-shell.test.tsx src/components/ui/__tests__/notification-ui.test.tsx
git commit -m "feat(ui): 小窓とお知らせが出るときの動きを揃える"
```

### Task 4: タブの下線がすべる

**Files:**
- Modify: `src/components/ui/tabs.tsx`
- Test: `src/components/ui/__tests__/tabs.test.tsx`

**Interfaces:**
- Consumes: `ease-out-soft`(Task 1)
- Produces: なし(props は今のまま: `tabs` / `active` / `onChange` / `idBase` / `className`)

方式: タブ列を `relative group/tabs` にし、絶対配置の下線 `<span>` を1本置く。位置は `useLayoutEffect` の中で **DOM の style を直接書く**(setState しない=eslint `react-hooks/set-state-in-effect` に触れない)。初回は位置を置いてから `data-slider="ready"` を立て、そこで初めて transition を効かせる(読み込み直後に左端からすべって来ない)。ready になるまでは今の `border-b-2` の下線を出す(SSR・JS無効でも下線が見える)。ready 後は各タブの下線を透明にする。

- [ ] **Step 1: 失敗するテストを書く**(`tabs.test.tsx` の `describe("Tabs")` 末尾に)

```tsx
  it("すべる下線: aria-hidden の1本・最初は透明・ready で transition(reduced-motion では動かさない)", () => {
    const html = render(<Tabs idBase="t" tabs={TABS} active="a" onChange={() => {}} />);
    const bars = html.match(/<span[^>]*data-tab-indicator[^>]*>/g) ?? [];
    expect(bars).toHaveLength(1);
    expect(bars[0]).toContain('aria-hidden="true"');
    expect(bars[0]).toContain("opacity-0");
    expect(bars[0]).toContain("group-data-[slider=ready]/tabs:transition-[translate,width]");
    expect(bars[0]).toContain("motion-reduce:transition-none");
    expect(bars[0]).toContain("bg-indigo-600");
    expect(bars[0]).toContain("dark:bg-indigo-400");
  });

  it("タブ列は relative group/tabs(下線の基準)", () => {
    const html = render(<Tabs idBase="t" tabs={TABS} active="a" onChange={() => {}} />);
    expect(html).toMatch(/role="tablist"[^>]*class="[^"]*relative[^"]*group\/tabs/);
  });

  it("★ready 後は各タブの下線を消す(明暗どちらでも二重にしない)", () => {
    const html = render(<Tabs idBase="t" tabs={TABS} active="a" onChange={() => {}} />);
    const btns = html.match(/<button[^>]*>/g) ?? [];
    for (const b of btns) {
      expect(b).toContain("group-data-[slider=ready]/tabs:border-transparent");
      expect(b).toContain("dark:group-data-[slider=ready]/tabs:border-transparent");
    }
  });

  it("位置は effect 内で DOM に直接書く(setState しない)+幅の変化に追従", () => {
    const src = readFileSync(join(process.cwd(), "src/components/ui/tabs.tsx"), "utf8");
    expect(src).toContain("useLayoutEffect");
    expect(src).toContain("new ResizeObserver");
    expect(src).toContain('dataset.slider = "ready"');
    expect(src).not.toMatch(/useState/);
  });
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/components/ui/__tests__/tabs.test.tsx`
Expected: 新しい4件が FAIL

- [ ] **Step 3: 実装**

`tabs.tsx` の import を:

```tsx
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
```

`const listRef = useRef<HTMLDivElement>(null);` の下に:

```tsx
  const barRef = useRef<HTMLSpanElement>(null);
  // すべる下線(2026-10-19 UIの統一)。⚠setState しない=位置は DOM の style に直接書く。
  //   初回は位置を置いてから ready を立てる(読み込み直後に左端からすべって来ない)。
  //   折り返し(flex-wrap)で2段になっても、選択中タブの下に付く(offsetTop を使う)。
  useLayoutEffect(() => {
    const list = listRef.current;
    const bar = barRef.current;
    if (!list || !bar) return;
    const place = () => {
      const el = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!el) {
        bar.style.opacity = "0";
        return;
      }
      bar.style.translate = `${el.offsetLeft}px ${el.offsetTop + el.offsetHeight - 2}px`;
      bar.style.width = `${el.offsetWidth}px`;
      bar.style.opacity = "1";
      if (list.dataset.slider !== "ready") {
        bar.getBoundingClientRect(); // 位置を確定させてから transition を効かせる
        list.dataset.slider = "ready";
      }
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(list);
    return () => ro.disconnect();
  }, [active, tabs]);
```

tablist の div の className を:

```tsx
      className={`group/tabs relative flex flex-wrap border-b border-gray-200 dark:border-gray-800${className ? ` ${className}` : ""}`}
```

各タブの className を(元の active/非 active の分岐は残す):

```tsx
          className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors group-data-[slider=ready]/tabs:border-transparent dark:group-data-[slider=ready]/tabs:border-transparent ${
            active === t.key
              ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-400"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          }`}
```

`{tabs.map(...)}` の後ろ(tablist の最後の子)に:

```tsx
      <span
        ref={barRef}
        data-tab-indicator
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 h-0.5 bg-indigo-600 opacity-0 duration-180 ease-out-soft group-data-[slider=ready]/tabs:transition-[translate,width] motion-reduce:transition-none dark:bg-indigo-400"
      />
```

⚠ 矢印キーの `querySelectorAll('[role="tab"]')` は span を拾わない(role が無い)ので今のまま動く。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/components/ui/__tests__/tabs.test.tsx && npx eslint src/components/ui/tabs.tsx`
Expected: PASS・eslint 0件(既存の「active タブだけ indigo の下線」も緑のまま=ready 前の下線は残っている)

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/tabs.tsx src/components/ui/__tests__/tabs.test.tsx
git commit -m "feat(ui): タブの下線が選んだタブへすべる"
```

### Task 5: カード(新)

**Files:**
- Create: `src/components/ui/card.tsx`
- Test: `src/components/ui/__tests__/card.test.tsx`

**Interfaces:**
- Consumes: `ease-out-soft`(Task 1)
- Produces:
  ```ts
  export function cardClassName(interactive?: boolean): string; // <Link> や <button> に直接貼る用
  export interface CardProps extends HTMLAttributes<HTMLDivElement> { interactive?: boolean }
  export function Card(props: CardProps): JSX.Element; // div
  ```

- [ ] **Step 1: 失敗するテストを書く**

`src/components/ui/__tests__/card.test.tsx`:

```tsx
/**
 * カード(UIの統一 第2回・設計書 §3)。枠+角丸lg。interactive のときだけ乗せると持ち上がる。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Card, cardClassName } from "../card";

describe("Card", () => {
  it("枠+角丸lg+白/ダーク", () => {
    const html = renderToStaticMarkup(<Card>中身</Card>);
    expect(html).toContain("rounded-lg");
    expect(html).toContain("border-gray-200");
    expect(html).toContain("bg-white");
    expect(html).toContain("dark:bg-gray-900");
    expect(html).toContain("中身");
  });

  it("通常は動かない(持ち上がりは interactive だけ)", () => {
    expect(cardClassName()).not.toContain("hover:");
  });

  it("interactive: 乗せる/キーボードで選ぶと少し上がり枠が藍に・reduced-motion では上がらない", () => {
    const c = cardClassName(true);
    expect(c).toContain("hover:-translate-y-px");
    expect(c).toContain("hover:border-indigo-400");
    expect(c).toContain("hover:shadow-md");
    expect(c).toContain("focus-visible:border-indigo-400");
    expect(c).toContain("motion-reduce:hover:translate-y-0");
    expect(c).toContain("ease-out-soft");
  });

  it("className と他の属性を渡せる", () => {
    const html = renderToStaticMarkup(<Card className="p-4" data-testid="x">a</Card>);
    expect(html).toContain("p-4");
    expect(html).toContain('data-testid="x"');
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/components/ui/__tests__/card.test.tsx`
Expected: FAIL(`../card` が無い)

- [ ] **Step 3: 実装**

`src/components/ui/card.tsx`:

```tsx
/**
 * カード (UIの統一と押した手応え 第2回・2026-10-19)。
 *
 * 規約: 枠 gray-200 + 角丸 lg + 白(dark: gray-900)。
 * interactive = 押せるカード(一覧の1件など)。乗せる/キーボードで選ぶと 1px 上がり、
 * 枠が藍に・影が付く。押せないカードには付けない(動くのに押せないと迷う)。
 * <Link> や <button> をカードにするときは cardClassName(true) を直接貼る。
 */
import type { HTMLAttributes } from "react";

const BASE = "rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900";
const INTERACTIVE =
  "transition-[translate,box-shadow,border-color] duration-180 ease-out-soft hover:-translate-y-px hover:border-indigo-400 hover:shadow-md focus-visible:border-indigo-400 focus-visible:shadow-md motion-reduce:hover:translate-y-0 dark:hover:border-indigo-500";

export function cardClassName(interactive = false): string {
  return interactive ? `${BASE} ${INTERACTIVE}` : BASE;
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export function Card({ interactive = false, className, ...rest }: CardProps) {
  return <div className={`${cardClassName(interactive)}${className ? ` ${className}` : ""}`} {...rest} />;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/components/ui/__tests__/card.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/card.tsx src/components/ui/__tests__/card.test.tsx
git commit -m "feat(ui): カード部品(押せるカードは乗せると持ち上がる)"
```

### Task 6: 読み込み中の形(新)+物件一覧・物件詳細で使う

**Files:**
- Create: `src/components/ui/skeleton.tsx`
- Test: `src/components/ui/__tests__/skeleton.test.tsx`
- Modify: `src/app/(dashboard)/properties/page.tsx:1693-1697` と `:1902-1906`
- Modify: `src/app/(dashboard)/properties/[id]/page.tsx:788-794`

**Interfaces:**
- Consumes: `animate-pm-shimmer`(Task 1)
- Produces:
  ```ts
  export function Skeleton(props: { className?: string }): JSX.Element; // 灰色の帯1本(aria-hidden)
  export function SkeletonRows(props: { rows?: number; label?: string }): JSX.Element; // role=status + 読み上げ用の文言
  ```

- [ ] **Step 1: 失敗するテストを書く**

`src/components/ui/__tests__/skeleton.test.tsx`:

```tsx
/**
 * 読み込み中の形(UIの統一 第2回・設計書 §3)。くるくるだけの画面を減らし、何が出るかを先に見せる。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Skeleton, SkeletonRows } from "../skeleton";

describe("Skeleton", () => {
  it("灰色の帯・光がゆっくり流れる・reduced-motion では止める・読み上げない", () => {
    const html = renderToStaticMarkup(<Skeleton className="h-3 w-1/2" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("animate-pm-shimmer");
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).toContain("h-3 w-1/2");
  });

  it("SkeletonRows: role=status で「読み込み中」を読み上げる・行数ぶん帯を出す", () => {
    const html = renderToStaticMarkup(<SkeletonRows rows={4} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('<span class="sr-only">読み込み中</span>');
    expect((html.match(/animate-pm-shimmer/g) ?? []).length).toBe(4);
  });

  it("label を差し替えられる", () => {
    expect(renderToStaticMarkup(<SkeletonRows label="物件を読み込み中" />)).toContain("物件を読み込み中");
  });
});

describe("物件一覧・物件詳細の初回読み込み", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("一覧(表とスマホのカード)はくるくるではなく形を出す", () => {
    const src = read("src/app/(dashboard)/properties/page.tsx");
    expect((src.match(/<SkeletonRows /g) ?? []).length).toBe(2);
  });
  it("詳細も形を出す", () => {
    const src = read("src/app/(dashboard)/properties/[id]/page.tsx");
    expect(src).toContain("<SkeletonRows ");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/components/ui/__tests__/skeleton.test.tsx`
Expected: FAIL(`../skeleton` が無い)

- [ ] **Step 3: 部品を実装**

`src/components/ui/skeleton.tsx`:

```tsx
/**
 * 読み込み中の形 (UIの統一と押した手応え 第2回・2026-10-19)。
 *
 * くるくるだけの画面を減らし、何が出るかを先に見せる。帯は読み上げない(aria-hidden)。
 * 読み上げは SkeletonRows の role=status + sr-only の文言で1回だけ。
 */
const BAND =
  "rounded bg-[linear-gradient(90deg,var(--color-gray-200)_0%,var(--color-gray-100)_50%,var(--color-gray-200)_100%)] bg-[length:200%_100%] animate-pm-shimmer motion-reduce:animate-none dark:bg-[linear-gradient(90deg,var(--color-gray-800)_0%,var(--color-gray-700)_50%,var(--color-gray-800)_100%)]";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={`${BAND}${className ? ` ${className}` : ""}`} />;
}

// 行ごとに長さを少し変える(全部同じ長さだと「形」に見えない)。
const WIDTHS = ["w-full", "w-11/12", "w-4/5", "w-2/3"];

export function SkeletonRows({ rows = 6, label = "読み込み中" }: { rows?: number; label?: string }) {
  return (
    <div role="status" className="flex flex-col gap-3 py-6">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`h-4 ${WIDTHS[i % WIDTHS.length]}`} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 物件一覧と詳細で使う**

`src/app/(dashboard)/properties/page.tsx` の 1693〜1697 行と 1902〜1906 行(どちらも同じ形):

```tsx
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
            <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">読み込み中...</span>
          </div>
```

を、それぞれ:

```tsx
          <SkeletonRows rows={8} label="物件を読み込み中" />
```

に置き換え、import に `import { SkeletonRows } from "@/components/ui/skeleton";` を足す(`Loader2` は他でも使っているので import は残す)。

`src/app/(dashboard)/properties/[id]/page.tsx` の 788〜794 行:

```tsx
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
        <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">読み込み中...</span>
      </div>
    );
  }
```

を:

```tsx
  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-4">
        <SkeletonRows rows={10} label="物件を読み込み中" />
      </div>
    );
  }
```

に置き換え、import を足す。`Loader2` が他で使われていなければ import から外す(`npx eslint` の未使用警告で判断)。

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/components/ui "src/app/(dashboard)/properties" && npx eslint src/components/ui/skeleton.tsx "src/app/(dashboard)/properties/page.tsx" "src/app/(dashboard)/properties/[id]/page.tsx"`
Expected: PASS・eslint 新規0件(既存の指摘は `git stash` 比較で自分の差分か確認)

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/skeleton.tsx src/components/ui/__tests__/skeleton.test.tsx "src/app/(dashboard)/properties/page.tsx" "src/app/(dashboard)/properties/[id]/page.tsx"
git commit -m "feat(ui): 読み込み中は形を先に出す(物件一覧・物件詳細)"
```

### Task 7: 第2回の提出

- [ ] 全ゲート(tsc・フル vitest・変更ファイル eslint・build)を `> out; echo exit=$?` で取り、証跡を残す
- [ ] 提出前レビュー(`feature-dev:code-reviewer`。観点: Button の既存29ファイルの見た目が変わりすぎないか・`loading` で `disabled` を上書きしていないか(呼び出し側の disabled=true が loading=false で外れないこと)・タブの二重下線(明暗)・小窓のフォーカス復帰・ダーク)
- [ ] push → PR(`feat(ui): 共通部品に動きを入れる(ボタン・小窓・タブ・お知らせ・カード・読み込み中)`)→ `@codex review` → 3系統+CI 監視
- [ ] 使い方ガイド・マニュアル(`system-docs` と `public/docs`)を「緑のボタン」「青いボタン」など色で説明している箇所だけ grep し、あれば直す(無ければ触らない)
- [ ] 実機確認リストに追加: 保存ボタンの処理中→✓・削除確認の小窓がふわっと開く・タブの下線がすべる(明暗/折り返し2段)・お知らせ・物件一覧と詳細の読み込み中の形・スマホで「視差効果を減らす」ON のとき動かない

---

## 第3〜7回: 手書きボタンの置き換え(型。各回の開始時にこの型で詳細計画を書く)

| 回 | 範囲(`src/components/<dir>` と `src/app/(dashboard)/<dir>`) | 目安 |
|---|---|---|
| 3 | `properties` | 142 |
| 4 | `field-survey` | 67 |
| 5 | `admin`・`import` | 110 |
| 6 | `sale-dm`・`sales-sheet` | 84 |
| 7 | `owners`・`buildings`・`agent-inquiry`・その他すべて | 残り |

各回の Task 構成(1回=1branch=1worktree=1PR=本番反映1回):

1. **走査テストを先に書く**(`src/components/ui/__tests__/raw-button-scan-<範囲>.test.ts`): 範囲内の `.tsx` を全部読み(CRLF→LF 正規化)、`<button` の出現から「許可リスト」を引いた数が 0 であることを確かめる。許可リスト = `data-motion="off"` を持つ要素の中・`role="tab"`(Tabs 部品の中)・`aria-pressed` を持つもの・`src/components/ui/` 自身。最初は FAIL(手書きが残っている)
2. **ファイルごとに置き換え**: 手書き `<button className="...">` → `<Button variant=... size=...>`。対応表:
   - 藍/青/緑の塗りの主ボタン → `variant="primary"`(緑が「完了・成功」の意味ならそのまま `className` で緑を残し、理由をコメント1行)
   - 枠線のボタン → `secondary` / 赤 → `danger` / 文字だけ・アイコンだけ → `ghost`
   - `text-xs`/`py-1` 系 → `size="sm"`、スマホの主操作 → `size="lg"`
   - 手書きの `fixed inset-0` の小窓 → `ModalShell`(写真の拡大表示・全画面ドロワーは対象外=既存の走査テストの allow-list に従う)
   - 一覧の1件の枠 → `Card` / `cardClassName(true)`
   - 手書きの「くるくる+文言」→ `loading` / `loadingLabel`
   - 角丸 `rounded-xl` → `rounded-lg`
3. 各ファイルの置き換えごとに、そのファイルの既存テストを流して緑を確認 → commit(ファイル単位)
4. 走査テストが PASS になったら全ゲート → 提出前レビュー(観点: 押したときの処理・文言・置き場所が変わっていないか=差分は className と要素名だけか)→ PR → @codex → マージ後に本番反映(別承認)→ 実機確認リストに範囲の画面を追加

⚠ 置き換えで `type` を落とさない(共通 Button の既定は `"button"`。元が `type="submit"` のものは必ず `type="submit"` を渡す)。⚠ `onClick` 以外の属性(`title`・`aria-*`・`data-testid`)はそのまま渡す(既存テストが data-testid で探している)。
