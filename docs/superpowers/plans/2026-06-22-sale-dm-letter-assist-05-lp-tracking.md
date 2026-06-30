# 売却促進DM 作成 — Plan 5: LP連携(追跡リンク/QR)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 確定したDMに **宛先固有の追跡リンク(短縮URL+QR)** を載せ、受け手がそのリンク/QRから既存LPへアクセスしたら、当該宛先の `lpFirstAccessAt`(初回のみ)+`lpAccessCount` を自動記録し、設定LP(`SALE_DM_LP_URL`)へ 302 転送する。これにより **反響(問い合わせ)= LPアクセス ∪ 電話** の自動シグナルの「LP側」を成立させる。URL/クエリ/QRに PII を一切載せない。

**Architecture:** Plan 1 が用意した `DmRecipientDraft.trackingToken`(unique・生成済み)を opaque キーに、**認証不要の公開 GET `/t/[token]`** を新設する。トークン → DB lookup → 記録(初回のみ first-access・常に count++)→ `SALE_DM_LP_URL` へ 302。公開化のため `src/proxy.ts` の `PUBLIC_PATHS` に `/t/` 前方一致を追加し、**proxy は単体テストで検出できない**ため `isPublicPath("/t/...")===true` を直接検証するテストを必ず足す(secret-cron/`/api/health` 公開の前例に倣う)。追跡URLの生成(`buildTrackingUrl`)と QR(SVG文字列・サーバー軽量生成)は純関数寄りの util として `src/lib/sale-dm-letter/` に置き、Plan 2 の `renderLetterHtml` の「追跡枠 slot」へ流し込む(Plan 2 が本 util を consume する依存関係)。

**Tech Stack:** Next.js 16 (App Router) / Prisma 7 / PostgreSQL / next-auth v5 / zod 4 / vitest 4 / `qrcode`(新規追加・サーバー側 SVG 生成のみ・ブラウザ非依存)。

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-06-22-sale-dm-letter-assist-design.md`(本プランの上位)。Plan 1: `docs/superpowers/plans/2026-06-22-sale-dm-letter-assist-01-foundation.md`(本プランが乗る土台)。
- 実装は**専用 git worktree** で行う(`superpowers:using-git-worktrees` を実行時に使用)。base = `main`・branch = `feat/sale-dm-letter-assist`(Plan 1 と同一ブランチに積む)。
- **公開エンドポイント `/t/[token]` は認証不要**。`src/proxy.ts` の `PUBLIC_PATHS`(前方一致 `startsWith`)に `"/t/"` を追加する。**proxy はミドルウェアで単体テストから直接到達できないため、`isPublicPath` を export し `isPublicPath("/t/xxx")===true` を検証するテストを必ず追加する**(`/api/health` 公開時と同じ担保方針)。
- **URL・クエリ・QR に PII を載せない**。`/t/[token]` の token は opaque(氏名/住所/物件IDを含まない)。LP への 302 転送時に付与してよいクエリは **匿名のキャンペーンID / 型(variant)ラベル** のみ(任意・既定は付与しない)。`Referer` 経由の漏えいも無いよう、トークン以外をパスに含めない。
- **公開 GET が DB 書込を行う点の妥当性**: アクセス記録は「初回のみ `lpFirstAccessAt` をセット(冪等)・`lpAccessCount` を常に +1」。副作用は当該1行の counter/timestamp 更新に限定し、**認証・課金・状態遷移を伴わない**(GETでの軽量サイドエフェクトとして許容)。bot/プリフェッチのノイズは「初回アクセス時刻」で軽く判定する設計(厳密判定は将来)。この判断をコードコメントに明記する。
- 未知/不正トークンは **情報を漏らさず** に振る舞う: `SALE_DM_LP_URL` が設定済みなら LP へ 302(列挙耐性・受け手体験優先)、未設定なら 404。**404/302 いずれもトークンの有無を本文で示さない**。
- `SALE_DM_LP_URL` 未設定時は `/t/[token]` は安全に停止(記録は行うが転送先が無いため 404 を返す=fail-closed)。既存挙動は不変。
- 追跡URLの base は env `SALE_DM_TRACKING_BASE_URL`(末尾スラッシュ無し・例 `https://app.example.com`)。未設定時は相対パス `/t/<token>` を返す(印刷物には絶対URLが要るため本番設定必須・QRは絶対URL推奨)。
- 秘密はサーバー側のみ。`NEXT_PUBLIC_*` で露出させない(`SALE_DM_TRACKING_BASE_URL` は公開URLだが機微でない。ただし client 直叩きはしない)。
- 既存ヘルパ再利用(再実装しない): `@/lib/prisma`(default prisma), `@/lib/audit`(writeAuditLog=非PIIメタのみ)。Plan 1 の `DmRecipientDraft`(`trackingToken` unique / `lpFirstAccessAt` / `lpAccessCount` default 0)。
- テストは `src/lib/__tests__/*.test.ts`。実行: `npm test`(= `vitest run`)。単体は `npx vitest run <file>`。route テストは Plan 1 / dm-export route test と同じ `vi.mock("next/server" | "@/lib/audit" | "@/lib/prisma")` 流儀。
- 反響(問い合わせ)= `lpFirstAccessAt != null` ∪ `phoneInquiryAt != null` の **導出**。本プランは LP 側シグナル(`lpFirstAccessAt`/`lpAccessCount`)の記録のみを担い、`outcome` 集計/電話入力は Plan 4。導出ルールが Plan 4 と一致するよう、本プランで純関数 `isInquiryResponded(draft)` を1つ用意し Plan 4 がそれを consume する(DRY)。
- DRY / YAGNI / TDD / こまめにコミット。raw SQL は入れない。

---

### Task 1: 追跡URL util `buildTrackingUrl`(純関数)

**Files:**
- Create: `src/lib/sale-dm-letter/tracking.ts`
- Test: `src/lib/__tests__/sale-dm-tracking.test.ts`

**Interfaces:**
- Produces: `TRACKING_PATH_PREFIX = "/t/"`、`buildTrackingUrl(token: string, baseUrl?: string): string`、`isInquiryResponded(d: { lpFirstAccessAt?: Date | null; phoneInquiryAt?: Date | null }): boolean`。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-tracking.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildTrackingUrl, TRACKING_PATH_PREFIX, isInquiryResponded } from "../sale-dm-letter/tracking";

describe("buildTrackingUrl", () => {
  it("base 指定時は絶対URL(末尾スラッシュ重複なし)", () => {
    expect(buildTrackingUrl("abc123", "https://app.example.com")).toBe("https://app.example.com/t/abc123");
  });
  it("base 末尾スラッシュ付きでも二重スラッシュにしない", () => {
    expect(buildTrackingUrl("abc123", "https://app.example.com/")).toBe("https://app.example.com/t/abc123");
  });
  it("base 未指定なら相対パス", () => {
    expect(buildTrackingUrl("abc123")).toBe("/t/abc123");
  });
  it("token は encodeURIComponent される(URLにPII/危険文字を漏らさない)", () => {
    expect(buildTrackingUrl("a/b?c", "https://x.test")).toBe("https://x.test/t/a%2Fb%3Fc");
  });
  it("prefix は /t/", () => {
    expect(TRACKING_PATH_PREFIX).toBe("/t/");
  });
});

describe("isInquiryResponded", () => {
  it("LPアクセスありで true", () => {
    expect(isInquiryResponded({ lpFirstAccessAt: new Date(), phoneInquiryAt: null })).toBe(true);
  });
  it("電話ありで true", () => {
    expect(isInquiryResponded({ lpFirstAccessAt: null, phoneInquiryAt: new Date() })).toBe(true);
  });
  it("どちらも無ければ false", () => {
    expect(isInquiryResponded({ lpFirstAccessAt: null, phoneInquiryAt: null })).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-tracking.test.ts`
Expected: FAIL(モジュール未解決)。

- [ ] **Step 3: 実装**

`src/lib/sale-dm-letter/tracking.ts`:

```ts
// 追跡リンク(短縮URL/QR)に関する純関数群。
// URL に載せるのは opaque な trackingToken のみ(氏名・住所・物件ID 等の PII は載せない)。

export const TRACKING_PATH_PREFIX = "/t/";

// 環境変数 SALE_DM_TRACKING_BASE_URL を既定 base として読む薄いラッパ。
// 印刷物・QR には絶対URLが必要だが、base 未設定でも相対パスで動く(本番は設定必須)。
export function resolveTrackingBaseUrl(): string | undefined {
  const base = process.env.SALE_DM_TRACKING_BASE_URL;
  return base && base.trim().length > 0 ? base.trim() : undefined;
}

/**
 * 宛先固有の追跡URLを組み立てる。
 *  - baseUrl 指定時: `<base>/t/<encoded token>`(base 末尾スラッシュは1つに正規化)
 *  - baseUrl 未指定時: 相対パス `/t/<encoded token>`
 * token は encodeURIComponent で安全化(PII/予期せぬ区切り文字を URL に漏らさない)。
 */
export function buildTrackingUrl(token: string, baseUrl?: string): string {
  const path = `${TRACKING_PATH_PREFIX}${encodeURIComponent(token)}`;
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * 反響(問い合わせ)の導出: LP初回アクセス または 電話問い合わせ のいずれかがあれば「反響あり」。
 * 設計書「反響 = lpFirstAccessAt ∪ phoneInquiryAt」を単一の純関数に閉じ込め、
 * Plan 4(集計)と本プラン(LP記録)で同じ定義を共有する(導出のブレ防止)。
 */
export function isInquiryResponded(d: {
  lpFirstAccessAt?: Date | null;
  phoneInquiryAt?: Date | null;
}): boolean {
  return Boolean(d.lpFirstAccessAt) || Boolean(d.phoneInquiryAt);
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-tracking.test.ts`
Expected: PASS(8 件)。

- [ ] **Step 5: コミット**

```bash
git add src/lib/sale-dm-letter/tracking.ts src/lib/__tests__/sale-dm-tracking.test.ts
git commit -m "feat(sale-dm): add tracking url builder + inquiry-responded derivation (pure)"
```

---

### Task 2: QR 生成 util(`qrcode` で SVG 文字列・サーバー軽量)

**Files:**
- Modify: `package.json`(`qrcode` を dependencies に・`@types/qrcode` を devDependencies に追加)
- Create: `src/lib/sale-dm-letter/qr.ts`
- Test: `src/lib/__tests__/sale-dm-qr.test.ts`

**Interfaces:**
- Consumes: `buildTrackingUrl`(Task 1)。
- Produces: `buildTrackingQrSvg(url: string): Promise<string>`(SVG マークアップ文字列)、`buildTrackingArtifacts(token: string, baseUrl?: string): Promise<{ url: string; qrSvg: string }>`(URL+QR をまとめて返す・テンプレ slot 用)。

- [ ] **Step 1: 依存を追加**

Run: `cd <worktree> && npm install qrcode && npm install -D @types/qrcode`
Expected: `package.json` の dependencies に `qrcode`、devDependencies に `@types/qrcode` が入り、`npm test` が引き続き解決可能。

> 採用理由: `qrcode` は `QRCode.toString(text, { type: "svg" })` で **SVG 文字列を同期的相当(Promise)でサーバー生成**でき、ブラウザ/canvas/重い画像処理に依存しない(設計書「QRは軽量ライブラリで印刷HTML内生成・サーバー重依存なし」に合致)。dataURL(PNG)ではなく **SVG** を選ぶ理由は、印刷時に鮮明・サイズ非依存・HTML へインライン埋め込みできるため。

- [ ] **Step 2: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-qr.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildTrackingQrSvg, buildTrackingArtifacts } from "../sale-dm-letter/qr";

describe("buildTrackingQrSvg", () => {
  it("SVG マークアップ文字列を返す", async () => {
    const svg = await buildTrackingQrSvg("https://app.example.com/t/abc123");
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });
  it("同一URLで決定的(同じSVG)", async () => {
    const a = await buildTrackingQrSvg("https://x.test/t/tok");
    const b = await buildTrackingQrSvg("https://x.test/t/tok");
    expect(a).toBe(b);
  });
});

describe("buildTrackingArtifacts", () => {
  it("追跡URL と QR(SVG) をまとめて返す", async () => {
    const { url, qrSvg } = await buildTrackingArtifacts("abc123", "https://app.example.com");
    expect(url).toBe("https://app.example.com/t/abc123");
    expect(qrSvg).toContain("<svg");
  });
  it("URL に token のみ(QR の中身=URL であり PII を含まない)", async () => {
    const { url } = await buildTrackingArtifacts("opaqueToken", "https://x.test");
    expect(url).toBe("https://x.test/t/opaqueToken");
    expect(url).not.toContain("田中");
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-qr.test.ts`
Expected: FAIL(モジュール未解決)。

- [ ] **Step 4: 実装**

`src/lib/sale-dm-letter/qr.ts`:

```ts
import QRCode from "qrcode";
import { buildTrackingUrl } from "./tracking";

/**
 * 追跡URLの QR を SVG マークアップ文字列で生成する(サーバー側・ブラウザ非依存)。
 * SVG はサイズ非依存で印刷に鮮明・HTML へインライン埋め込み可能。
 * `margin: 1` で印刷余白を最小化、`errorCorrectionLevel: "M"` で実用バランス。
 */
export async function buildTrackingQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
  });
}

/**
 * テンプレ(Plan 2 renderLetterHtml)の追跡枠 slot 用に、追跡URL と QR(SVG)を
 * まとめて生成する。URL/QR とも opaque token のみで PII を含まない。
 */
export async function buildTrackingArtifacts(
  token: string,
  baseUrl?: string,
): Promise<{ url: string; qrSvg: string }> {
  const url = buildTrackingUrl(token, baseUrl);
  const qrSvg = await buildTrackingQrSvg(url);
  return { url, qrSvg };
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-qr.test.ts`
Expected: PASS(4 件)。

- [ ] **Step 6: コミット**

```bash
git add package.json package-lock.json src/lib/sale-dm-letter/qr.ts src/lib/__tests__/sale-dm-qr.test.ts
git commit -m "feat(sale-dm): add tracking QR (SVG) generation via qrcode"
```

---

### Task 3: 公開化 — `proxy.ts` の `PUBLIC_PATHS` に `/t/` 追加 + テスト

**Files:**
- Modify: `src/proxy.ts`(`PUBLIC_PATHS` に `"/t/"` 追加・`isPublicPath` を export)
- Test: `src/lib/__tests__/sale-dm-proxy-public-path.test.ts`

**Interfaces:**
- Produces: `isPublicPath`(export 化)。proxy の公開パスに `/t/` を含めることを単体テストで担保。

> **なぜテストが必須か**: proxy(ミドルウェア)は Next ランタイムが実行するため、route の様に直接 import して挙動を検証しにくい。`/t/[token]` を `PUBLIC_PATHS` に入れ忘れると **公開エンドポイントが 302→/login に飛ばされ機能不全**になる(逆に広げ過ぎると認証バイパス)。`isPublicPath` を export し、`/t/...` が public・近接パス(`/tasks` 等)が public でないことを直接アサートして回帰を防ぐ。`/api/health` を `PUBLIC_EXACT_PATHS` で限定公開した前例と同じ担保方針。

- [ ] **Step 1: `isPublicPath` を export して失敗するテストを書く**

まず `src/proxy.ts` の `function isPublicPath` を `export function isPublicPath` に変える(挙動は変えない)。

`src/lib/__tests__/sale-dm-proxy-public-path.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isPublicPath } from "@/proxy";

describe("proxy public paths(/t/ 追跡リンク)", () => {
  it("/t/<token> は公開(認証不要)", () => {
    expect(isPublicPath("/t/abc123")).toBe(true);
    expect(isPublicPath("/t/")).toBe(true);
  });
  it("既存の公開パスは引き続き公開", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/session")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/uploads/x.pdf")).toBe(true);
  });
  it("/t/ に前方一致しない近接パスは公開しない(過剰公開の回帰防止)", () => {
    expect(isPublicPath("/tasks")).toBe(false);
    expect(isPublicPath("/team")).toBe(false);
    expect(isPublicPath("/api/properties")).toBe(false);
    expect(isPublicPath("/")).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-proxy-public-path.test.ts`
Expected: FAIL(`/t/abc123` が false=`/t/` 未追加)。`@/proxy` の解決が通らない場合は import を相対(`../../proxy`)へ。

- [ ] **Step 3: `PUBLIC_PATHS` に `/t/` を追加**

`src/proxy.ts` の `PUBLIC_PATHS` を更新:

```ts
// 公開(認証不要)パス。startsWith 前方一致。
// "/t/" = 売却DMの宛先固有 追跡リンク(opaque token のみ・PII を含まない)。
// 受け手(所有者)は本システムの認証ユーザーではないため認証免除が必須。
// 単体テストでは proxy 本体を実行できないため isPublicPath を export し
// sale-dm-proxy-public-path.test.ts で /t/ の公開を担保する(/api/health と同じ方針)。
const PUBLIC_PATHS = ["/login", "/api/auth", "/_next", "/favicon.ico", "/uploads", "/t/"];
```

> 注: `matcher`(`/((?!_next/static|_next/image|favicon.ico|uploads/).*)`)は `/t/...` を**対象に含む**ため proxy は走る。`PUBLIC_PATHS` の前方一致で `isPublicPath` が true を返し `NextResponse.next()` される。matcher 側の変更は不要。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-proxy-public-path.test.ts`
Expected: PASS(3 describe・全アサート緑)。

- [ ] **Step 5: コミット**

```bash
git add src/proxy.ts src/lib/__tests__/sale-dm-proxy-public-path.test.ts
git commit -m "feat(sale-dm): make /t/ tracking link public in proxy + guard test"
```

---

### Task 4: 公開エンドポイント `GET /t/[token]`(記録 + LP へ 302)

**Files:**
- Create: `src/lib/sale-dm-letter/tracking-record.ts`(記録の純粋寄りヘルパ・テスト容易化)
- Create: `src/app/t/[token]/route.ts`(GET・公開)
- Test: `src/lib/__tests__/sale-dm-tracking-route.test.ts`

**Interfaces:**
- Consumes: `@/lib/prisma`、`@/lib/audit`、`resolveTrackingBaseUrl`(Task 1)。
- Produces: `recordTrackingHit(tx, token): Promise<{ matched: boolean }>`、route `GET /t/[token]`(認証不要・302→`SALE_DM_LP_URL`・no-store)。

- [ ] **Step 1: 記録ヘルパの失敗テストを書く**

`recordTrackingHit` は「トークンで該当 draft を引き、初回のみ `lpFirstAccessAt` をセット・常に `lpAccessCount` を +1」する。冪等性(2回目で first-access を上書きしない)を純粋にテストできるよう、prisma クライアントを引数で受ける形にする。

`src/lib/__tests__/sale-dm-tracking-route.test.ts`(まず記録ヘルパ。route 統合は Step 4 で追記):

```ts
import { describe, it, expect, vi } from "vitest";
import { recordTrackingHit } from "../sale-dm-letter/tracking-record";

function makeTx(existing: { id: string; lpFirstAccessAt: Date | null } | null) {
  return {
    dmRecipientDraft: {
      findUnique: vi.fn(async () => existing),
      update: vi.fn(async (_args: unknown) => ({ id: existing?.id })),
    },
  };
}

describe("recordTrackingHit", () => {
  it("未知トークンは matched=false・更新しない", async () => {
    const tx = makeTx(null);
    const r = await recordTrackingHit(tx as never, "nope");
    expect(r.matched).toBe(false);
    expect(tx.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  it("初回アクセスは lpFirstAccessAt をセット + count++", async () => {
    const tx = makeTx({ id: "r1", lpFirstAccessAt: null });
    const r = await recordTrackingHit(tx as never, "tok");
    expect(r.matched).toBe(true);
    const arg = tx.dmRecipientDraft.update.mock.calls[0][0] as {
      data: { lpFirstAccessAt?: Date; lpAccessCount: { increment: number } };
    };
    expect(arg.data.lpFirstAccessAt).toBeInstanceOf(Date);
    expect(arg.data.lpAccessCount).toEqual({ increment: 1 });
  });

  it("2回目以降は lpFirstAccessAt を上書きしない(冪等)・count は ++", async () => {
    const tx = makeTx({ id: "r1", lpFirstAccessAt: new Date("2020-01-01") });
    await recordTrackingHit(tx as never, "tok");
    const arg = tx.dmRecipientDraft.update.mock.calls[0][0] as {
      data: { lpFirstAccessAt?: Date; lpAccessCount: { increment: number } };
    };
    expect(arg.data.lpFirstAccessAt).toBeUndefined();
    expect(arg.data.lpAccessCount).toEqual({ increment: 1 });
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-tracking-route.test.ts`
Expected: FAIL(`recordTrackingHit` 未定義)。

- [ ] **Step 3: 記録ヘルパを実装**

`src/lib/sale-dm-letter/tracking-record.ts`:

```ts
import type { Prisma } from "@prisma/client";

// findUnique/update だけに依存する最小インターフェース(prisma 本体 or $transaction tx を受ける)。
type TrackingTxLike = {
  dmRecipientDraft: {
    findUnique: (args: {
      where: { trackingToken: string };
      select: { id: true; lpFirstAccessAt: true };
    }) => Promise<{ id: string; lpFirstAccessAt: Date | null } | null>;
    update: (args: {
      where: { id: string };
      data: Prisma.DmRecipientDraftUpdateInput;
    }) => Promise<unknown>;
  };
};

/**
 * 追跡トークンのヒットを記録する。
 *  - 該当 draft が無ければ matched=false(更新しない)。
 *  - 初回(lpFirstAccessAt == null)のみ lpFirstAccessAt = now をセット。
 *  - lpAccessCount は常に increment(+1)。
 *
 * 公開 GET でこの DB 書込を行う妥当性:
 *  追跡リンクのアクセス記録は副作用が「当該1行の counter/timestamp 更新」に限定され、
 *  認証・課金・状態遷移を伴わない。これは「リンクが踏まれた」という観測の記録であり、
 *  GET の安全性(冪等的・観測のみ)を実質的に保つ。first-access は初回のみで冪等。
 *  bot/プリフェッチのノイズは将来 first-access 時刻で軽く判定する(初版は素朴に記録)。
 */
export async function recordTrackingHit(
  tx: TrackingTxLike,
  token: string,
): Promise<{ matched: boolean }> {
  const draft = await tx.dmRecipientDraft.findUnique({
    where: { trackingToken: token },
    select: { id: true, lpFirstAccessAt: true },
  });
  if (!draft) return { matched: false };

  await tx.dmRecipientDraft.update({
    where: { id: draft.id },
    data: {
      lpAccessCount: { increment: 1 },
      // 初回のみセット(2回目以降は undefined=既存値を上書きしない)。
      ...(draft.lpFirstAccessAt ? {} : { lpFirstAccessAt: new Date() }),
    },
  });
  return { matched: true };
}
```

- [ ] **Step 4: route を実装 + 統合テストを追記**

`src/app/t/[token]/route.ts`:

```ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { recordTrackingHit } from "@/lib/sale-dm-letter/tracking-record";
import { resolveTrackingBaseUrl } from "@/lib/sale-dm-letter/tracking";

// 認証不要の公開エンドポイント(proxy.ts の PUBLIC_PATHS に "/t/" を追加済み)。
// 受け手(所有者)は本システムのログインユーザーではないため認証免除が必須。
// no-store: 個人を特定し得る遷移(どの宛先がアクセスしたか)をキャッシュさせない。
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const lpUrl = process.env.SALE_DM_LP_URL;

  // 記録は best-effort(失敗しても受け手体験=LP転送を止めない)。
  let matched = false;
  try {
    const r = await recordTrackingHit(prisma, token);
    matched = r.matched;
  } catch {
    // 記録失敗はログのみ(下の 302/404 判定には影響させない)。
    matched = false;
  }

  // AuditLog は非PIIメタのみ。token/氏名/住所は残さない(matched 真偽のみ)。
  await writeAuditLog({
    action: "sale_dm_tracking_hit",
    targetTable: "dm_recipient_drafts",
    detail: { matched, at: new Date().toISOString() },
  });

  // 転送先 LP 未設定なら fail-closed(404)。未知トークンでも、LP 設定済みなら
  // 列挙耐性・受け手体験のため LP へ 302(本文でトークンの有無を示さない)。
  if (!lpUrl) {
    return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.redirect(lpUrl, { status: 302, headers: { "Cache-Control": "no-store" } });
}
```

> 実装メモ: LP への 302 時に **PII をクエリに付さない**。匿名のキャンペーン/型ラベルを付けたい場合のみ `new URL(lpUrl)` に `searchParams` を足す(初版は素の `lpUrl` へ転送=何も付けない)。`NextResponse.redirect` は absolute URL を要求するため `SALE_DM_LP_URL` は絶対URLで設定する(env 表に明記)。

同テストファイル `src/lib/__tests__/sale-dm-tracking-route.test.ts` の冒頭に `vi.mock` を足し、route の 302/404/no-store を検証する(Plan 1 route test と同じ `next/server`/`@/lib/audit`/`@/lib/prisma` mock 流儀):

```ts
// ↓ ファイル冒頭(他 import より前)に追加。
import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextResponse extends Response {
    static redirect = (url: string, init?: number | ResponseInit) => {
      const status = typeof init === "number" ? init : (init?.status ?? 307);
      const headers = typeof init === "object" && init && "headers" in init ? (init.headers as HeadersInit) : undefined;
      return new Response(null, { status, headers: { ...(headers as Record<string, string>), Location: url } });
    };
  }
  return { NextResponse: MockNextResponse };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    dmRecipientDraft: {
      findUnique: vi.fn(async () => ({ id: "r1", lpFirstAccessAt: null })),
      update: vi.fn(async () => ({ id: "r1" })),
    },
  },
}));
```

route 検証を同ファイル末尾に追記:

```ts
import { describe as d2, it as i2, expect as e2, beforeEach as b2 } from "vitest";
import prismaMock from "@/lib/prisma";
import { GET } from "../../app/t/[token]/route";

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const ENV = process.env;
b2(() => { vi.clearAllMocks(); process.env = { ...ENV }; });

d2("GET /t/[token]", () => {
  i2("既知トークン + LP 設定で 302 → LP・記録する・no-store", async () => {
    process.env.SALE_DM_LP_URL = "https://lp.example.com/sell";
    const res = await GET(new Request("http://x/t/tok") as never, ctx("tok"));
    e2(res.status).toBe(302);
    e2(res.headers.get("Location")).toBe("https://lp.example.com/sell");
    e2(res.headers.get("Cache-Control")).toBe("no-store");
    const pm = prismaMock as never as { dmRecipientDraft: { update: ReturnType<typeof vi.fn> } };
    e2(pm.dmRecipientDraft.update).toHaveBeenCalledOnce();
  });

  i2("LP 未設定なら 404(fail-closed)", async () => {
    delete process.env.SALE_DM_LP_URL;
    const res = await GET(new Request("http://x/t/tok") as never, ctx("tok"));
    e2(res.status).toBe(404);
  });

  i2("未知トークンでも LP 設定済みなら 302(列挙耐性)・記録は更新しない", async () => {
    process.env.SALE_DM_LP_URL = "https://lp.example.com/sell";
    const pm = prismaMock as never as { dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } };
    pm.dmRecipientDraft.findUnique.mockResolvedValueOnce(null);
    const res = await GET(new Request("http://x/t/nope") as never, ctx("nope"));
    e2(res.status).toBe(302);
    e2(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
  });
});
```

> 注: `process.env` を `beforeEach` で復元し、`SALE_DM_LP_URL` のリークを防ぐ。`NextResponse.redirect` の挙動は Plan 1/既存 route テストに合わせて mock する(本物の `next/server` は absolute URL を要求するため mock で `Location` ヘッダを直接確認する)。

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-tracking-route.test.ts`
Expected: PASS(記録ヘルパ 3 + route 3)。

- [ ] **Step 6: コミット**

```bash
git add src/lib/sale-dm-letter/tracking-record.ts src/app/t/[token]/route.ts src/lib/__tests__/sale-dm-tracking-route.test.ts
git commit -m "feat(sale-dm): add public GET /t/[token] (record hit + 302 to LP)"
```

---

### Task 5: テンプレ追跡枠 slot 連携(Plan 2 `renderLetterHtml` への供給)+ env 反映

**Files:**
- Create: `src/lib/sale-dm-letter/tracking-slot.ts`(印刷HTML向け 追跡枠 HTML を組む純関数)
- Modify: `.env.example`(本プランの env を追記)
- Test: `src/lib/__tests__/sale-dm-tracking-slot.test.ts`

**Interfaces:**
- Consumes: `buildTrackingArtifacts`(Task 2)。
- Produces: `renderTrackingSlotHtml({ url, qrSvg }, opts?): string`(QR+短縮URL を含む安全な HTML 断片)。**Plan 2 の `renderLetterHtml` がこの関数(または `buildTrackingArtifacts`)を呼び、デザインテンプレの「追跡枠」へ差し込む**(本プランが produce、Plan 2 が consume)。

> 依存関係の明示: Plan 2(デザインテンプレ/印刷)がまだ存在しない場合、本タスクは **slot を埋める純関数を先に用意**し、Plan 2 側はこの関数を呼ぶだけにする。Plan 2 の `renderLetterHtml(draft, options)` 内で確定済み draft の `trackingToken` から `buildTrackingArtifacts(token, resolveTrackingBaseUrl())` → `renderTrackingSlotHtml(artifacts)` を差し込む契約とする。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-tracking-slot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderTrackingSlotHtml } from "../sale-dm-letter/tracking-slot";

describe("renderTrackingSlotHtml", () => {
  const artifacts = { url: "https://app.example.com/t/abc123", qrSvg: "<svg><rect/></svg>" };

  it("QR(SVG)と短縮URLを含む", () => {
    const html = renderTrackingSlotHtml(artifacts);
    expect(html).toContain("<svg>");
    expect(html).toContain("https://app.example.com/t/abc123");
  });

  it("URL テキストは HTML エスケープされる(< > & を素で出さない)", () => {
    const html = renderTrackingSlotHtml({ url: "https://x.test/t/a&b<c>", qrSvg: "<svg/>" });
    expect(html).toContain("a&amp;b&lt;c&gt;");
    expect(html).not.toContain("a&b<c>");
  });

  it("案内文(任意 caption)を差し込める", () => {
    const html = renderTrackingSlotHtml(artifacts, { caption: "詳しくはこちら" });
    expect(html).toContain("詳しくはこちら");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-tracking-slot.test.ts`
Expected: FAIL(モジュール未解決)。

- [ ] **Step 3: 実装**

`src/lib/sale-dm-letter/tracking-slot.ts`:

```ts
// 印刷HTML(Plan 2 デザインテンプレ)の「追跡枠」に差し込む HTML 断片を組む純関数。
// qrSvg は本システム生成の信頼できる SVG(qrcode 出力)なのでそのまま埋め込む。
// url はテキスト表示分のみ HTML エスケープする(QR の中身=url は既に encodeURIComponent 済み)。

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface TrackingSlotOptions {
  /** QR の下に出す案内文(任意)。既定は無し。 */
  caption?: string;
}

/**
 * 追跡枠の HTML 断片(QR + 短縮URL テキスト)を返す。
 * Plan 2 の renderLetterHtml がデザインテンプレの slot へこの断片を差し込む。
 */
export function renderTrackingSlotHtml(
  artifacts: { url: string; qrSvg: string },
  opts: TrackingSlotOptions = {},
): string {
  const caption = opts.caption ? `<p class="sale-dm-track-caption">${escapeHtml(opts.caption)}</p>` : "";
  return [
    `<div class="sale-dm-tracking">`,
    `<div class="sale-dm-track-qr">${artifacts.qrSvg}</div>`,
    `<p class="sale-dm-track-url">${escapeHtml(artifacts.url)}</p>`,
    caption,
    `</div>`,
  ].join("");
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-tracking-slot.test.ts`
Expected: PASS(3 件)。

- [ ] **Step 5: `.env.example` に env を追記**

`.env.example` の末尾(売却DM 関連の節があればその近く)に追記:

```dotenv
# 売却促進DM 追跡リンク(LP連携)
# 受け手が QR / 短縮URL からアクセスする転送先 LP の絶対URL(未設定なら /t/[token] は 404)。
SALE_DM_LP_URL=
# 追跡URL/QR に埋め込む base(末尾スラッシュ無し・例 https://app.example.com)。未設定なら相対 /t/<token>。
SALE_DM_TRACKING_BASE_URL=
```

- [ ] **Step 6: 全テスト + lint + build を確認**

Run: `npm test` → 既存 + 新規すべて green。
Run: `npm run lint` → エラーなし。
Run: `npm run build` → 成功(`/t/[token]` route が manifest に出る)。

- [ ] **Step 7: コミット**

```bash
git add src/lib/sale-dm-letter/tracking-slot.ts .env.example src/lib/__tests__/sale-dm-tracking-slot.test.ts
git commit -m "feat(sale-dm): add tracking slot html for templates + env example (LP/tracking base)"
```

---

## Self-Review(本プラン → 設計書の突合)

- **(a) 公開 `GET /t/[token]`**: Task 4 ✅(trackingToken で draft lookup・初回のみ `lpFirstAccessAt`・常に `lpAccessCount++`・`SALE_DM_LP_URL` へ 302・PII を URL/クエリに載せない・LP 未設定 404=fail-closed・未知トークンは列挙耐性で LP へ 302)。
- **(b) 公開化 + proxy テスト**: Task 3 ✅(`PUBLIC_PATHS` に `"/t/"` 追加・`isPublicPath` を export し `isPublicPath("/t/xxx")===true` と近接パス非公開を直接アサート。`/api/health` 限定公開の前例方針)。
- **(c) `buildTrackingUrl` + QR + Plan 2 slot 連携**: Task 1(URL)・Task 2(QR=`qrcode` の SVG 文字列・サーバー軽量)・Task 5(`renderTrackingSlotHtml` を produce し Plan 2 `renderLetterHtml` が consume)✅。
- **(d) env `SALE_DM_LP_URL`(+`SALE_DM_TRACKING_BASE_URL`)**: Global Constraints + Task 5 `.env.example` ✅。
- **テスト網羅**: トークン安全化/相対・絶対URL(Task1)・QR 決定的/PII 非混入(Task2)・proxy 公開パス(Task3)・記録の初回のみ first-access + count++ の冪等性 + 未知トークン非更新(Task4 記録ヘルパ)・302/404/no-store(Task4 route)・slot の HTML エスケープ(Task5)。
- **反響=LP ∪ 電話 の導出整合(Plan 4)**: `isInquiryResponded`(Task 1)を単一純関数として produce。Plan 4 の集計はこれを consume して `outcome` を導出する(導出ルールの二重定義を防ぐ)。
- **公開 GET の DB 書込妥当性**: `recordTrackingHit` と route のコメントに「副作用は当該1行の counter/timestamp 更新に限定・認証/状態遷移を伴わない・first-access は冪等」を明記 ✅。
- **PII 非載せ**: token は opaque(Plan 1 で `randomBytes` 由来)・URL/QR/クエリに氏名/住所/物件ID を含めない・AuditLog は `matched` 真偽のみ(本文/token を残さない)・route レスポンス `no-store` ✅。
- **Placeholder スキャン**: なし(各 step に実コード/実コマンド)。
- **既知の実装時確認点(レビュアー向け)**: (1) `NextResponse.redirect` は本物では absolute URL 必須 → `SALE_DM_LP_URL` を絶対URLで設定(env コメント明記)。route テストは mock の `Location` ヘッダで検証。(2) `@prisma/client` の `Prisma.DmRecipientDraftUpdateInput` 型名は Plan 1 の `prisma generate` 後に存在する(未生成なら `npx prisma generate` を先に実行)。(3) `@/proxy` のテスト import がパスエイリアスで解決しない場合は相対 import へ。(4) Plan 2 が未着手の場合、`renderTrackingSlotHtml`/`buildTrackingArtifacts` は本プランで先に提供し、Plan 2 が `renderLetterHtml` の slot から呼ぶ契約とする(本プラン単体でも全テスト緑)。
