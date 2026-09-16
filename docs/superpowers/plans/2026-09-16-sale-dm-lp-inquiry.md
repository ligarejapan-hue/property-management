# 売却DM LP型「査定申込フォーム」(第1段 PR4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 公開LP(`/t/<token>`)に**無料査定の申込フォーム**を出し、送付済みの宛先からの申込を `dm_inquiries` に保存して反響(outcome)へ計上する。社内のキャンペーン画面に申込一覧(対応状況の変更つき)・宛先の「申込」バッジ・LP型表の「申込」列を出す。同意文は管理者設定に置く。**あわせて、公開の書き込み口(配信停止・電話タップ)の送信元判定が本番の前段(nginx)越しに自分自身まで拒否している不具合を直す**(申込フォームの前提)。メール通知(PR5)は作らない。

**Architecture:** 送信元判定は共通の純関数 `isCrossSiteOrigin(headers, requestUrl)` に一本化し、比較相手を `req.url` ではなく **`Host` ヘッダ**(nginx が `proxy_set_header Host $host` で渡す公開ホスト名)にする。公開ページの `Referrer-Policy` は `same-origin` にする。フォームは `renderLpPage` に文字列で足す(React なし・全値 escape)。受け口 `POST /t/[token]/inquiry` は `/u/` と同じ多層の守り(IP・token・全体のレート制限/送信元判定/honeypot/送付済みのみ)。記録は純関数の入力検証 `parseInquiryForm` → `recordInquiry`(親の物件行ロック→申込 INSERT→宛先の計数→`syncSaleDmReaction(allowTerminal:false)`)。社内は認証必須の一覧 GET と対応状況 PATCH。

**Tech Stack:** Next.js App Router route handlers, Prisma 7(`@/generated/prisma`), zod v4, vitest(`src/lib/__tests__/`・env=node), React client components(Tailwind・lucide-react)。**新規 npm 依存なし。**

**Spec:** `docs/superpowers/specs/2026-09-08-sale-dm-lp-autobuild-design.md` §2.5(申込フォームと反響)・§2.7(権限・安全・監査)・§2.4(送付前はフォーム送信不可)・§2.9(データ変更)・§3-4。

## Global Constraints

- **新規 npm 依存を足さない。** 公開ページは React を使わず文字列で組み立てる(`src/lib/sale-dm-letter/unsubscribe-page.ts` / `lp-page.ts` と同じ)。外部読み込みなし。
- **escape**: 公開ページに埋める動的文字列はすべて `escapeHtml`(`src/lib/sale-dm-letter/templates/index.ts`)を通す。同意文は escape したうえで改行だけ `<br />` にする。
- **申込フォームの項目(設計 §2.5 そのまま)**: `name`(必須・50字)・`phone`(必須・20字・数字/ハイフン/+ のみ)・`email?`(254字・形式)・`contactPref?`(`phone|email|either`)・`contactTime?`(60字)・`message?`(1000字)・`consent`(必須)・honeypot(空必須・名前は `website`)。
- **受け口 `POST /t/[token]/inquiry`**: レート制限3種=**端末IP 10/分(溢れたら拒否)・token 5/時・全体 120/時**。送信元がよそ→403(DB に触らない)。honeypot が埋まっていれば**記録せず**完了ページ(200)。入力不備→422。**`status==="sent"` の宛先のみ記録**(それ以外は 409「プレビュー中」ページ)。未知 token→404(記録なし)。
- **申込者への自動返信は送らない**。メール通知は PR5(`notifyStatus` 列は PR5 のために今作り、PR4 では `pending` のまま触らない)。
- **申込の個人情報は消さない**(`dm_inquiries.draft_id` の外部キーは `ON DELETE RESTRICT`=申込がある宛先は消せない)。
- **ログ・監査に入力文字を出さない**(氏名・電話・メール・要望・同意文の値は detail に入れない。許可リスト方式=`src/lib/audit-log-detail-safety.ts`)。
- **社内の閲覧**: `requireSaleDmAccess`+作成者本人のキャンペーンのみ+field_staff は `filterDraftsByFieldStaffScope`。**電話・メール・希望連絡方法・時間帯・要望**は `isPlainOwnerLevel(ownerDisplayConfig.phone)` のときだけ返す(それ以外は `null`+`contactHidden:true`)。画面は `data-pii-protected data-pii-surface="owner"`(画面保護 S1b)。**対応状況の変更**は `requireSaleDmWriteAccess`。
- **ロック順序**: 公開の申込記録も社内の対応状況変更も「親の物件行(`lockPropertyRow`)→子」。`dm-writer-lock-order.test.ts` に順序を固定する。
- **走査テストの縛り**: `src/` に `saleDmLetter` を書かない; Tailwind `bg-blue-600` 禁止・`fixed inset-0` モーダル/`border-b-2` タブ手書き禁止(`ModalShell`/`ConfirmDialog`); dashboard page に生 `<h1` 禁止; 公開の書き込み route の `crypto.randomUUID` 禁止(`@/lib/random-id` の `safeRandomId`)。
- 各ファイルの改行は既存に合わせる(CRLF 混在禁止)・NUL 等の制御文字禁止・`git add` は列挙・commit 末尾に次の2行:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01GfXgLxCNNbT1KsYRPXDnr8`
- **⚠制御文字の化け(この計画書で実際に起きた)**: ファイル書き込みツールは、コード中の「バックスラッシュ+u+16進4桁」の表記(Task 3 の制御文字の正規表現・テスト文字列)を**本物の制御文字(NUL 等)に化かす**ことがある。Task 3 のファイルを書いたら必ず `python -c "d=open('<file>','rb').read();print(sum(1 for b in d if (b<32 and b not in (9,10)) or b==127))"` が `0` であることを確認し、化けていたら表記に戻す。`git diff --stat` に `Bin` が出たら混入のしるし。
- 「緑」の前に `npx vitest run`(フル)+`npx tsc --noEmit`+`npx eslint <変更ファイル>`+`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`。
- 専用 worktree `property-management-worktrees/sale-dm-lp-inquiry`(branch `feat/sale-dm-lp-inquiry`・base `origin/main` 9199a3fd)。

### 設計書からの読み替え(controller ruling・計画で確定)

1. **会社案内・連絡先の専用欄は作らない**(PR3 の読み替え2を継続=`senderName`/`senderContact` を流用)。`SaleDmConfig` に足すのは **`privacyText` だけ**。`companyProfile`/`lpPhone`/`lpPhoneLabel` は作らない。未入力時はひな形 `DEFAULT_PRIVACY_TEXT` を表示。
2. **`deriveOutcome` は変えない。** 申込は必ずアプリ内LPページ(`GET /t/<token>`=QR読み取りの記録が先に走る)から送られる。だから `lpFirstAccessAt` は通常すでに立っている。立っていない(QR読み取りの記録は best-effort で失敗し得る)ときだけ、**申込の tx の中で `lpFirstAccessAt=now` を補う**(`lpAccessCount` は増やさない)。これで outcome の正準定義(LP∪電話)・outcome route・集計・同期の関数を一切変えずに「申込があれば必ず反響あり」が成り立つ。
3. **社内表示は「キャンペーン画面の申込一覧」と「宛先バッジ」と「LP型表の申込列」まで。** 物件のDM履歴とホームの反響は、同じ tx の `syncSaleDmReaction` が送付記録(ブリッジ行)を「反響あり」にするので**既存表示のまま反映される**(新しい画面は作らない)。
4. **送信元判定の不具合修正を本PRの Task 1 に含める。** 本番で実測(2026-09-16・存在しない token で `/u/` に POST):`Origin: https://app.ligarejapan.com`(=自分自身)→**403**、`Origin: null`→403、Origin なし→404。原因=アプリが見る `req.url` のホストが前段 nginx 越しでは公開ホスト名にならない。加えて、実ブラウザ(Chromium)で実測:`Referrer-Policy: no-referrer` のページからの**フォーム送信は `Origin: null`**(sendBeacon は本物の Origin)。この2つで、**配信停止ボタンはどのブラウザでも受け付けられず、電話タップも数えられていない**(お手紙0件のため実害なし)。申込フォームも同じ判定を通るので前提として直す。
5. **送付前の宛先にもフォームは表示する(送信ボタンは押せない)**。§2.4 のとおり「プレビュー」帯+`<fieldset disabled>`。受け口側でも 409 で拒否(二重の守り)。社内プレビュー route も同じ(action は `#`)。
6. **honeypot が埋まった送信は「受け付けました」を返して何も残さない**(ボットに判定材料を与えない)。監査も残さない(audit_logs の肥大防止)。

---

## File Structure

| 種別 | パス | 責務 |
|---|---|---|
| Create | `src/lib/public-origin.ts` | `isCrossSiteOrigin(headers, requestUrl)`(公開の書き込み口の送信元判定・Host ヘッダ基準・`null`/なしは「よそと断定しない」) |
| Modify | `src/app/u/[token]/route.ts` / `src/app/t/[token]/phone-tap/route.ts` | 送信元判定を共通関数へ |
| Modify | `src/lib/sale-dm-letter/unsubscribe-page.ts` | `PUBLIC_PAGE_HEADERS` の `Referrer-Policy` を `same-origin`・カード型ページの組み立てを `renderPublicCardPage` として export |
| Modify | `src/lib/sale-dm-letter/lp-page.ts` | `<meta name="referrer">` を `same-origin`・申込フォームの描画・CTA の飛び先 |
| Modify | `prisma/schema.prisma` / Create `prisma/migrations/20260916100000_add_dm_inquiries/migration.sql` | `DmInquiry`(新設)・`DmRecipientDraft.formInquiryCount/formInquiryFirstAt`・`SaleDmConfig.privacyText`・User の逆リレーション |
| Create | `src/lib/sale-dm-letter/inquiry-input.ts` | `parseInquiryForm`(入力検証の純関数)・項目上限・エラー文言 |
| Create | `src/lib/sale-dm-letter/inquiry-record.ts` | `recordInquiry`(ロック→INSERT→計数→同期) |
| Create | `src/lib/sale-dm-letter/inquiry-page.ts` | 申込の完了/入力不備/プレビュー中/受付不可/混雑/回数超過ページ |
| Create | `src/lib/sale-dm-letter/privacy-text.ts` | `DEFAULT_PRIVACY_TEXT` |
| Modify | `src/lib/sale-dm-letter/lp-render-input.ts` | `LpFormInput` 型・`buildLpRenderInput` が `form` を受ける |
| Modify | `src/lib/sale-dm-letter/lp-page-loader.ts` / `config-store.ts` / preview route | `privacyText` の読み出し・フォーム入力を渡す |
| Create | `src/app/t/[token]/inquiry/route.ts` | 申込の受け口 |
| Create | `src/lib/sale-dm-letter/inquiry-list.ts` | 社内一覧の並べ替え・連絡先の伏せ(純関数) |
| Create | `src/app/api/properties/sale-dm/campaigns/[id]/inquiries/route.ts` | 社内の申込一覧 GET |
| Create | `src/app/api/properties/sale-dm/inquiries/[inquiryId]/route.ts` | 対応状況 PATCH |
| Modify | `src/lib/api-client.ts` | 型と取得・更新関数 |
| Create | `src/components/sale-dm/inquiry-list.tsx` | 申込一覧パネル |
| Modify | `src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx` / `src/components/sale-dm/recipient-list.tsx` / `src/app/api/properties/sale-dm/campaigns/[id]/route.ts` | 一覧の配置・宛先バッジ・宛先の列 |
| Modify | `src/lib/sale-dm-letter/aggregate.ts` / `aggregate-view-model.ts` / `src/components/sale-dm/aggregate-view.tsx` / aggregate route | LP型表に「申込」 |
| Modify | `src/app/api/admin/sale-dm-settings/route.ts` / `src/app/(dashboard)/admin/sale-dm-settings/page.tsx` / `src/lib/api-client.ts`(`SaleDmSettings`) | 同意文の設定欄 |
| Modify | `src/lib/audit-log-detail-safety.ts` / `src/app/(dashboard)/admin/audit-logs/page.tsx` / `src/lib/__tests__/sale-dm-external-audit-visible.test.ts` | 監査3件 |
| Modify | `public/docs/guide.html` / `public/docs/manual.html` / `docs/deploy.md` | 文書 |

---

### Task 1: 公開の書き込み口の送信元判定を直す(配信停止・電話タップ)

**Files:**
- Create: `src/lib/public-origin.ts`
- Modify: `src/app/u/[token]/route.ts:115-127`、`src/app/t/[token]/phone-tap/route.ts:22-47`、`src/lib/sale-dm-letter/unsubscribe-page.ts`(`PUBLIC_PAGE_HEADERS`)、`src/lib/sale-dm-letter/lp-page.ts:111`(`<meta name="referrer"`)
- Test: `src/lib/__tests__/public-origin.test.ts`(新規)、`src/lib/__tests__/sale-dm-unsubscribe-route.test.ts`(追記)、`src/lib/__tests__/sale-dm-lp-phone-tap-route.test.ts`(追記)

**Interfaces:**
- Produces: `isCrossSiteOrigin(headers: Headers, requestUrl: string): boolean`(true=よそからの送信=拒否すべき)。Task 7 の受け口も使う。`PUBLIC_PAGE_HEADERS["Referrer-Policy"] === "same-origin"`。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/__tests__/public-origin.test.ts
import { describe, it, expect } from "vitest";
import { isCrossSiteOrigin } from "@/lib/public-origin";
import { PUBLIC_PAGE_HEADERS } from "@/lib/sale-dm-letter/unsubscribe-page";

const h = (init: Record<string, string>) => new Headers(init);
// 本番の再現: アプリが見る req.url は公開ホスト名にならない(前段 nginx 越し)。Host ヘッダが公開ホスト名。
const APP_URL = "http://localhost:3000/u/tok";

describe("isCrossSiteOrigin(公開の書き込み口の送信元判定)", () => {
  it("Origin なしは よそと断定しない", () => {
    expect(isCrossSiteOrigin(h({ host: "app.ligarejapan.com" }), APP_URL)).toBe(false);
  });
  it("Origin: null(no-referrer ページからのフォーム送信で実ブラウザが付ける値)は よそと断定しない", () => {
    expect(isCrossSiteOrigin(h({ host: "app.ligarejapan.com", origin: "null" }), APP_URL)).toBe(false);
  });
  it("前段越しの本番: Origin=公開ホスト名・Host=公開ホスト名 なら自分自身(req.url のホストが違っても)", () => {
    expect(isCrossSiteOrigin(h({ host: "app.ligarejapan.com", origin: "https://app.ligarejapan.com" }), APP_URL)).toBe(false);
  });
  it("大文字小文字は区別しない", () => {
    expect(isCrossSiteOrigin(h({ host: "App.LigareJapan.com", origin: "https://app.ligarejapan.com" }), APP_URL)).toBe(false);
  });
  it("よそのサイトは true", () => {
    expect(isCrossSiteOrigin(h({ host: "app.ligarejapan.com", origin: "https://evil.example" }), APP_URL)).toBe(true);
  });
  it("URL として読めない Origin は true", () => {
    expect(isCrossSiteOrigin(h({ host: "app.ligarejapan.com", origin: "::::" }), APP_URL)).toBe(true);
  });
  it("Host ヘッダが無い(テスト等で Request を直接作った)ときは req.url のホストと比べる", () => {
    expect(isCrossSiteOrigin(h({ origin: "http://app.test" }), "http://app.test/u/tok")).toBe(false);
    expect(isCrossSiteOrigin(h({ origin: "https://evil.example" }), "http://app.test/u/tok")).toBe(true);
  });
});

describe("公開ページの参照元方針", () => {
  it("same-origin(no-referrer だとフォーム送信の Origin が null になり、よそ判定が意味を失う)", () => {
    expect(PUBLIC_PAGE_HEADERS["Referrer-Policy"]).toBe("same-origin");
  });
});
```

`src/lib/__tests__/sale-dm-unsubscribe-route.test.ts` の「Origin が自分と違えば 403」の `it` の直後に追記:

```ts
  it("前段(nginx)越しの本番: Origin=公開ホスト名・Host=公開ホスト名 なら 403 にしない(自分自身)", async () => {
    const tk = freshValid();
    const res = await POST(
      req("POST", tk, { origin: "https://app.ligarejapan.com", host: "app.ligarejapan.com" }),
      ctx(tk),
    );
    expect(res.status).not.toBe(403);
  });

  it("Origin: null(実ブラウザのフォーム送信)でも 403 にしない", async () => {
    const tk = freshValid();
    const res = await POST(req("POST", tk, { origin: "null" }), ctx(tk));
    expect(res.status).not.toBe(403);
  });
```

`src/lib/__tests__/sale-dm-lp-phone-tap-route.test.ts`(POST route を検証している `describe` の中。当ファイルは prisma を mock し `recordPhoneTap` は本物を通す。`beforeEach` で宛先は送付済み `{ id: "d1", propertyId: "p1", status: "sent" }`)に追記:

```ts
  it("前段(nginx)越しの本番: Origin=公開ホスト名・Host=公開ホスト名 のタップは数える", async () => {
    // req.url(localhost:3000)と公開ホスト名が食い違う本番の状況を Host 見出しで再現する。
    const res = await POST(
      new Request("http://localhost:3000/t/tok/phone-tap", {
        method: "POST",
        headers: { "x-real-ip": "10.0.0.77", origin: "https://app.ligarejapan.com", host: "app.ligarejapan.com" },
      }) as never,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(pm.dmRecipientDraft.update).toHaveBeenCalled();
  });
```

- [ ] **Step 2: 落ちることを確認**

Run: `npx vitest run src/lib/__tests__/public-origin.test.ts src/lib/__tests__/sale-dm-unsubscribe-route.test.ts src/lib/__tests__/sale-dm-lp-phone-tap-route.test.ts`
Expected: FAIL(`@/lib/public-origin` が無い/`Referrer-Policy` が `no-referrer`/自分自身の Origin で 403)

- [ ] **Step 3: 実装**

```ts
// src/lib/public-origin.ts
/**
 * 公開(認証なし)の書き込み口 — 配信停止 /u/・電話タップ /t/<token>/phone-tap・査定申込 /t/<token>/inquiry —
 * で使う「よそのサイトから送らせた送信か」の判定。true = よそ(拒否/数えない)。
 *
 * ⚠比較相手は `req.url` ではなく **Host ヘッダ**。本番は前段 nginx(`proxy_set_header Host $host`)越しで、
 *   アプリが見る req.url のホストは公開ホスト名にならない(2026-09-16 本番実測: 自分自身の Origin で 403)。
 *   Host はブラウザが接続先として付ける値で、よそのページのフォームからは書き換えられない。
 * ⚠`Origin: null` と Origin なしは「よそと断定しない」。null は Referrer-Policy: no-referrer のページからの
 *   フォーム送信で実ブラウザが付ける値(Chromium 実測)で、サンドボックス iframe でも付く。どちらの口も
 *   「印刷物にしか載っていない符号(token/署名)の所持」が本当の守りで、符号を持つ者は Origin を付けずに
 *   直接送れる=null を拒否しても守りは増えず、本物の利用者だけを弾く。
 */
export function isCrossSiteOrigin(headers: Headers, requestUrl: string): boolean {
  const raw = headers.get("origin");
  if (raw == null) return false;
  const value = raw.trim();
  if (value === "" || value === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(value).host.toLowerCase();
  } catch {
    return true;
  }
  const hostHeader = headers.get("host")?.trim().toLowerCase();
  let selfHost: string;
  if (hostHeader) {
    selfHost = hostHeader;
  } else {
    try {
      selfHost = new URL(requestUrl).host.toLowerCase();
    } catch {
      return true;
    }
  }
  return originHost !== selfHost;
}
```

`src/app/u/[token]/route.ts` の Origin 検査ブロック(`const origin = req.headers.get("origin");` から対応する `}` まで)を置き換え、import を足す:

```ts
import { isCrossSiteOrigin } from "@/lib/public-origin";
```

```ts
  // Origin 検査: 第三者サイトのフォームから踏ませる送信を拒否(判定の詳細は public-origin.ts)。
  if (isCrossSiteOrigin(req.headers, req.url)) {
    return html(renderUnsubscribeInvalidPage(), 403);
  }
```

`src/app/t/[token]/phone-tap/route.ts`: ローカル関数 `isForeignOrigin` とそのコメントを削除し、import を足して呼び出しを置き換える:

```ts
import { isCrossSiteOrigin } from "@/lib/public-origin";
```

```ts
  // よそのサイトからの送信は数えない(応答は同じ 204=弾いたことを漏らさない)。判定はDBに触る前に済ませる。
  if (isCrossSiteOrigin(req.headers, req.url)) {
    return noContent();
  }
```

`src/lib/sale-dm-letter/unsubscribe-page.ts` の `PUBLIC_PAGE_HEADERS`:

```ts
/** 公開ページ共通の応答ヘッダ(キャッシュ禁止・索引拒否・token をよそのサイトの referrer に漏らさない)。
 *  Referrer-Policy は same-origin(よそへは参照元を送らない)。no-referrer にすると、同じサイトへの
 *  フォーム送信でもブラウザが Origin を null にし、送信元判定(public-origin.ts)が働かなくなる。 */
export const PUBLIC_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};
```

`src/lib/sale-dm-letter/lp-page.ts` の return 行の `<meta name="referrer" content="no-referrer" />` を `<meta name="referrer" content="same-origin" />` に変える。`src/lib/__tests__/sale-dm-lp-page.test.ts` に `no-referrer` を期待する assert があれば `same-origin` に直す(`grep -n "no-referrer" src/lib/__tests__` で確認)。

- [ ] **Step 4: 通ることを確認**

Run: `npx vitest run src/lib/__tests__/public-origin.test.ts src/lib/__tests__/sale-dm-unsubscribe-route.test.ts src/lib/__tests__/sale-dm-lp-phone-tap-route.test.ts src/lib/__tests__/sale-dm-lp-page.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/public-origin.ts src/app/u/[token]/route.ts src/app/t/[token]/phone-tap/route.ts src/lib/sale-dm-letter/unsubscribe-page.ts src/lib/sale-dm-letter/lp-page.ts src/lib/__tests__/public-origin.test.ts src/lib/__tests__/sale-dm-unsubscribe-route.test.ts src/lib/__tests__/sale-dm-lp-phone-tap-route.test.ts src/lib/__tests__/sale-dm-lp-page.test.ts
git commit -m "fix(sale-dm): 公開の書き込み口の送信元判定を Host 基準に(本番で配信停止・電話タップが自分自身を拒否していた)"
```

---

### Task 2: スキーマ(申込・宛先の計数・同意文)と migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260916100000_add_dm_inquiries/migration.sql`
- Test: `src/lib/__tests__/sale-dm-inquiry-schema.test.ts`

**Interfaces:**
- Produces: `prisma.dmInquiry`(列名は下の model そのまま)・`DmRecipientDraft.formInquiryCount: number`・`formInquiryFirstAt: Date | null`・`DmRecipientDraft.inquiries`・`SaleDmConfig.privacyText: string | null`。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-inquiry-schema.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const schema = readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf8").replace(/\r\n/g, "\n");
const sql = readFileSync(path.resolve(process.cwd(), "prisma/migrations/20260916100000_add_dm_inquiries/migration.sql"), "utf8").replace(/\r\n/g, "\n");
const block = (name: string) => {
  const start = schema.indexOf(`model ${name} {`);
  expect(start, `model ${name}`).toBeGreaterThan(-1);
  return schema.slice(start, schema.indexOf("\n}", start));
};

describe("査定申込のスキーマ", () => {
  it("DmInquiry の列(設計 §2.5)", () => {
    const m = block("DmInquiry");
    for (const re of [
      /draftId\s+String\s+@map\("draft_id"\) @db\.Uuid/,
      /submittedAt\s+DateTime\s+@default\(now\(\)\) @map\("submitted_at"\)/,
      /name\s+String\n/,
      /phone\s+String\n/,
      /email\s+String\?/,
      /contactPref\s+String\?\s+@map\("contact_pref"\)/,
      /contactTime\s+String\?\s+@map\("contact_time"\)/,
      /message\s+String\?/,
      /handleStatus\s+String\s+@default\("open"\) @map\("handle_status"\)/,
      /handledById\s+String\?\s+@map\("handled_by_id"\) @db\.Uuid/,
      /handledAt\s+DateTime\?\s+@map\("handled_at"\)/,
      /handleNote\s+String\?\s+@map\("handle_note"\)/,
      /notifyStatus\s+String\s+@default\("pending"\) @map\("notify_status"\)/,
      /notifyAttempts\s+Int\s+@default\(0\) @map\("notify_attempts"\)/,
      /notifyLastError\s+String\?\s+@map\("notify_last_error"\)/,
      /onDelete: Restrict/,
      /@@map\("dm_inquiries"\)/,
    ]) expect(m).toMatch(re);
  });
  it("宛先に申込の計数、売却DM設定に同意文", () => {
    expect(block("DmRecipientDraft")).toMatch(/formInquiryCount\s+Int\s+@default\(0\) @map\("form_inquiry_count"\)/);
    expect(block("DmRecipientDraft")).toMatch(/formInquiryFirstAt\s+DateTime\?\s+@map\("form_inquiry_first_at"\)/);
    expect(block("SaleDmConfig")).toMatch(/privacyText\s+String\?\s+@map\("privacy_text"\)/);
  });
  it("migration は additive(削除・更新なし)で、申込の外部キーは RESTRICT", () => {
    expect(sql).toMatch(/CREATE TABLE "dm_inquiries"/);
    expect(sql).toMatch(/ADD COLUMN\s+"form_inquiry_count" INTEGER NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/ADD COLUMN\s+"form_inquiry_first_at" TIMESTAMP\(3\)/);
    expect(sql).toMatch(/ADD COLUMN\s+"privacy_text" TEXT/);
    expect(sql).toMatch(/"dm_inquiries_draft_id_fkey" FOREIGN KEY \("draft_id"\) REFERENCES "dm_recipient_drafts"\("id"\) ON DELETE RESTRICT/);
    expect(sql).not.toMatch(/DROP|UPDATE "|DELETE FROM|ALTER TYPE/i);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-inquiry-schema.test.ts` → FAIL

- [ ] **Step 3: schema と migration**

`model DmRecipientDraft` の `phoneTapFirstAt` 行の直後:

```prisma
  // 公開LPの査定申込フォーム(設計 §2.5)。申込の中身は dm_inquiries(同一宛先の複数回も全件保存)。
  formInquiryCount      Int              @default(0) @map("form_inquiry_count")
  formInquiryFirstAt    DateTime?        @map("form_inquiry_first_at")
```

同じ model のリレーション欄(`draftOwners DmRecipientDraftOwner[]` の直後):

```prisma
  inquiries   DmInquiry[]
```

`model SaleDmConfig` の `senderContact` 行の直後:

```prisma
  // 公開LPの申込フォームに出す個人情報の取扱い文。未設定なら DEFAULT_PRIVACY_TEXT。凍結の対象外(§0-12)。
  privacyText        String?  @map("privacy_text")
```

`model User` のリレーション欄(`dmRecipientDrafts ... @relation("DmRecipientGenerator")` の直後):

```prisma
  handledDmInquiries      DmInquiry[]             @relation("DmInquiryHandler")
```

`model DmLpVariant { ... }` の直後に新設:

```prisma
/// 公開LPの査定申込(設計 2026-09-08 §2.5)。申込者の個人情報を含む=自動削除しない(§0-10)。
/// 宛先の削除は外部キー RESTRICT で止める(申込がある宛先・キャンペーンは消せない)。
/// 状態(handleStatus / notifyStatus)は enum を使わず文字列(rollback で enum ADD VALUE を残さない・§2.9)。
model DmInquiry {
  id              String    @id @default(uuid()) @db.Uuid
  draftId         String    @map("draft_id") @db.Uuid
  submittedAt     DateTime  @default(now()) @map("submitted_at")
  name            String
  phone           String
  email           String?
  contactPref     String?   @map("contact_pref")
  contactTime     String?   @map("contact_time")
  message         String?
  // open | in_progress | done
  handleStatus    String    @default("open") @map("handle_status")
  handledById     String?   @map("handled_by_id") @db.Uuid
  handledAt       DateTime? @map("handled_at")
  handleNote      String?   @map("handle_note")
  // pending | sent | failed(メール通知 PR5 が使う。PR4 では触らない)
  notifyStatus    String    @default("pending") @map("notify_status")
  notifyAttempts  Int       @default(0) @map("notify_attempts")
  // 定型コードのみ(外部由来の文字を入れない)
  notifyLastError String?   @map("notify_last_error")
  createdAt       DateTime  @default(now()) @map("created_at")

  draft     DmRecipientDraft @relation(fields: [draftId], references: [id], onDelete: Restrict)
  handledBy User?            @relation("DmInquiryHandler", fields: [handledById], references: [id])

  @@index([draftId])
  @@index([handleStatus])
  @@map("dm_inquiries")
}
```

`prisma/migrations/20260916100000_add_dm_inquiries/migration.sql`:

```sql
-- 公開LPの査定申込(設計 §2.5)。additive のみ。
ALTER TABLE "dm_recipient_drafts" ADD COLUMN     "form_inquiry_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "form_inquiry_first_at" TIMESTAMP(3);

ALTER TABLE "sale_dm_config" ADD COLUMN     "privacy_text" TEXT;

CREATE TABLE "dm_inquiries" (
    "id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "contact_pref" TEXT,
    "contact_time" TEXT,
    "message" TEXT,
    "handle_status" TEXT NOT NULL DEFAULT 'open',
    "handled_by_id" UUID,
    "handled_at" TIMESTAMP(3),
    "handle_note" TEXT,
    "notify_status" TEXT NOT NULL DEFAULT 'pending',
    "notify_attempts" INTEGER NOT NULL DEFAULT 0,
    "notify_last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dm_inquiries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dm_inquiries_draft_id_idx" ON "dm_inquiries"("draft_id");

CREATE INDEX "dm_inquiries_handle_status_idx" ON "dm_inquiries"("handle_status");

ALTER TABLE "dm_inquiries" ADD CONSTRAINT "dm_inquiries_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "dm_recipient_drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dm_inquiries" ADD CONSTRAINT "dm_inquiries_handled_by_id_fkey" FOREIGN KEY ("handled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 4: 確認** — Run: `npx prisma validate && npx prisma generate && npx vitest run src/lib/__tests__/sale-dm-inquiry-schema.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260916100000_add_dm_inquiries/migration.sql src/lib/__tests__/sale-dm-inquiry-schema.test.ts
git commit -m "feat(sale-dm): 査定申込の表と宛先の申込計数・同意文の列を追加(additive)"
```

---

### Task 3: 申込の入力検証 `inquiry-input.ts`(純関数)

**Files:**
- Create: `src/lib/sale-dm-letter/inquiry-input.ts`
- Test: `src/lib/__tests__/sale-dm-inquiry-input.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const INQUIRY_LIMITS: { readonly name: 50; readonly phone: 20; readonly email: 254; readonly contactTime: 60; readonly message: 1000 };
  export const CONTACT_PREFS: readonly ["phone", "email", "either"];
  export type ContactPref = "phone" | "email" | "either";
  export const HONEYPOT_FIELD = "website";
  export interface InquiryInput { name: string; phone: string; email: string | null; contactPref: ContactPref | null; contactTime: string | null; message: string | null }
  export type InquiryFieldError = "name_required" | "name_too_long" | "phone_required" | "phone_invalid" | "email_invalid" | "email_required_for_pref" | "contact_pref_invalid" | "contact_time_too_long" | "message_too_long" | "consent_required";
  export const INQUIRY_ERROR_MESSAGES: Readonly<Record<InquiryFieldError, string>>;
  export type InquiryParse = { kind: "ok"; value: InquiryInput } | { kind: "bot" } | { kind: "invalid"; errors: InquiryFieldError[] };
  export function parseInquiryForm(get: (key: string) => string | null): InquiryParse;
  ```

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-inquiry-input.test.ts
import { describe, it, expect } from "vitest";
import { parseInquiryForm, INQUIRY_ERROR_MESSAGES, HONEYPOT_FIELD } from "@/lib/sale-dm-letter/inquiry-input";

const form = (v: Record<string, string>) => (k: string) => (k in v ? v[k] : null);
const OK = { name: "山田 太郎", phone: "090-1234-5678", consent: "yes" };

describe("parseInquiryForm", () => {
  it("必須だけで通る(任意は null)", () => {
    expect(parseInquiryForm(form(OK))).toEqual({
      kind: "ok",
      value: { name: "山田 太郎", phone: "090-1234-5678", email: null, contactPref: null, contactTime: null, message: null },
    });
  });
  it("全角の数字・ハイフンは半角にそろえる。前後の空白は落とす", () => {
    const r = parseInquiryForm(form({ ...OK, name: "  山田  ", phone: "０９０ー１２３４ー５６７８" }));
    expect(r).toMatchObject({ kind: "ok", value: { name: "山田", phone: "090-1234-5678" } });
  });
  it("honeypot が埋まっていれば bot(他の不備より先に判定)", () => {
    expect(parseInquiryForm(form({ [HONEYPOT_FIELD]: "http://spam" }))).toEqual({ kind: "bot" });
  });
  it("必須の欠落と同意なしをまとめて返す", () => {
    const r = parseInquiryForm(form({}));
    expect(r).toEqual({ kind: "invalid", errors: ["name_required", "phone_required", "consent_required"] });
  });
  it("上限超過", () => {
    const r = parseInquiryForm(form({ ...OK, name: "あ".repeat(51), contactTime: "a".repeat(61), message: "b".repeat(1001) }));
    expect(r).toEqual({ kind: "invalid", errors: ["name_too_long", "contact_time_too_long", "message_too_long"] });
  });
  it("電話番号: 数字/ハイフン/+/空白以外、20字超、数字10桁未満はいずれも不正", () => {
    for (const phone of ["090-1234-567a", "0".repeat(21), "03-1234-567", "(03)1234-5678"]) {
      expect(parseInquiryForm(form({ ...OK, phone }))).toEqual({ kind: "invalid", errors: ["phone_invalid"] });
    }
    expect(parseInquiryForm(form({ ...OK, phone: "+81 90 1234 5678" }))).toMatchObject({ kind: "ok" });
  });
  it("メール: 形式不正・254字超は不正。空は null", () => {
    expect(parseInquiryForm(form({ ...OK, email: "not-mail" }))).toEqual({ kind: "invalid", errors: ["email_invalid"] });
    expect(parseInquiryForm(form({ ...OK, email: `${"a".repeat(250)}@x.jp` }))).toEqual({ kind: "invalid", errors: ["email_invalid"] });
    expect(parseInquiryForm(form({ ...OK, email: "  " }))).toMatchObject({ kind: "ok", value: { email: null } });
  });
  it("希望連絡方法: 列挙外は不正・メール希望なのにメールが空は不正", () => {
    expect(parseInquiryForm(form({ ...OK, contactPref: "fax" }))).toEqual({ kind: "invalid", errors: ["contact_pref_invalid"] });
    expect(parseInquiryForm(form({ ...OK, contactPref: "email" }))).toEqual({ kind: "invalid", errors: ["email_required_for_pref"] });
    expect(parseInquiryForm(form({ ...OK, contactPref: "email", email: "a@b.jp" }))).toMatchObject({ kind: "ok", value: { contactPref: "email", email: "a@b.jp" } });
  });
  it("制御文字は落とす(要望の改行は残す)", () => {
    const r = parseInquiryForm(form({ ...OK, name: "山田\u0000太郎", message: "一行目\r\n二行目\u0007" }));
    expect(r).toMatchObject({ kind: "ok", value: { name: "山田太郎", message: "一行目\n二行目" } });
  });
  it("同意は consent=yes のときだけ", () => {
    expect(parseInquiryForm(form({ ...OK, consent: "no" }))).toEqual({ kind: "invalid", errors: ["consent_required"] });
  });
  it("すべてのエラーに日本語の文言がある", () => {
    const keys = ["name_required", "name_too_long", "phone_required", "phone_invalid", "email_invalid", "email_required_for_pref", "contact_pref_invalid", "contact_time_too_long", "message_too_long", "consent_required"] as const;
    for (const k of keys) expect(INQUIRY_ERROR_MESSAGES[k].length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-inquiry-input.test.ts` → FAIL(モジュールなし)

- [ ] **Step 3: 実装**

```ts
// src/lib/sale-dm-letter/inquiry-input.ts
/**
 * 公開LPの査定申込フォームの入力検証(設計 §2.5)。純関数(env/DB 非依存)。
 * 受け口 route は FormData の get をそのまま渡す。戻り値の value だけを DB に保存する。
 */
export const INQUIRY_LIMITS = { name: 50, phone: 20, email: 254, contactTime: 60, message: 1000 } as const;
export const CONTACT_PREFS = ["phone", "email", "either"] as const;
export type ContactPref = (typeof CONTACT_PREFS)[number];
/** ボット除けの隠し欄。人には見えない位置に置き、埋まっていれば機械送信とみなす。 */
export const HONEYPOT_FIELD = "website";

export interface InquiryInput {
  name: string;
  phone: string;
  email: string | null;
  contactPref: ContactPref | null;
  contactTime: string | null;
  message: string | null;
}

export type InquiryFieldError =
  | "name_required" | "name_too_long"
  | "phone_required" | "phone_invalid"
  | "email_invalid" | "email_required_for_pref"
  | "contact_pref_invalid"
  | "contact_time_too_long"
  | "message_too_long"
  | "consent_required";

export const INQUIRY_ERROR_MESSAGES: Readonly<Record<InquiryFieldError, string>> = {
  name_required: "お名前をご入力ください。",
  name_too_long: `お名前は${INQUIRY_LIMITS.name}文字以内でご入力ください。`,
  phone_required: "電話番号をご入力ください。",
  phone_invalid: "電話番号は数字とハイフンで、10桁以上ご入力ください。",
  email_invalid: "メールアドレスの形式をご確認ください。",
  email_required_for_pref: "メールでのご連絡をご希望の場合は、メールアドレスをご入力ください。",
  contact_pref_invalid: "ご希望の連絡方法をお選びください。",
  contact_time_too_long: `連絡のつきやすい時間帯は${INQUIRY_LIMITS.contactTime}文字以内でご入力ください。`,
  message_too_long: `ご要望・ご質問は${INQUIRY_LIMITS.message}文字以内でご入力ください。`,
  consent_required: "個人情報の取り扱いへの同意が必要です。",
};

export type InquiryParse =
  | { kind: "ok"; value: InquiryInput }
  | { kind: "bot" }
  | { kind: "invalid"; errors: InquiryFieldError[] };

// 改行(\n)以外の制御文字。要望以外は改行も落とす。
const CONTROL_EXCEPT_NL = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function single(v: string | null): string {
  return (v ?? "").normalize("NFKC").replace(CONTROL_ALL, "").trim();
}

function multi(v: string | null): string {
  return (v ?? "").normalize("NFKC").replace(/\r\n?/g, "\n").replace(CONTROL_EXCEPT_NL, "").trim();
}

function normalizePhone(v: string): string {
  // NFKC 後に残る長音・マイナス類をハイフンへ(全角入力の「ー」「－」)。
  return v.replace(/[ー−–—―]/g, "-");
}

export function parseInquiryForm(get: (key: string) => string | null): InquiryParse {
  if (single(get(HONEYPOT_FIELD)) !== "") return { kind: "bot" };

  const errors: InquiryFieldError[] = [];

  const name = single(get("name"));
  if (name === "") errors.push("name_required");
  else if ([...name].length > INQUIRY_LIMITS.name) errors.push("name_too_long");

  const phone = normalizePhone(single(get("phone")));
  if (phone === "") errors.push("phone_required");
  else if (
    phone.length > INQUIRY_LIMITS.phone ||
    !/^[0-9+\- ]+$/.test(phone) ||
    phone.replace(/[^0-9]/g, "").length < 10
  ) errors.push("phone_invalid");

  const emailRaw = single(get("email"));
  const email = emailRaw === "" ? null : emailRaw;
  if (email != null && (email.length > INQUIRY_LIMITS.email || !EMAIL_RE.test(email))) errors.push("email_invalid");

  const prefRaw = single(get("contactPref"));
  let contactPref: ContactPref | null = null;
  if (prefRaw !== "") {
    if ((CONTACT_PREFS as readonly string[]).includes(prefRaw)) contactPref = prefRaw as ContactPref;
    else errors.push("contact_pref_invalid");
  }
  if (contactPref === "email" && email == null) errors.push("email_required_for_pref");

  const timeRaw = single(get("contactTime"));
  const contactTime = timeRaw === "" ? null : timeRaw;
  if (contactTime != null && [...contactTime].length > INQUIRY_LIMITS.contactTime) errors.push("contact_time_too_long");

  const msgRaw = multi(get("message"));
  const message = msgRaw === "" ? null : msgRaw;
  if (message != null && [...message].length > INQUIRY_LIMITS.message) errors.push("message_too_long");

  if (single(get("consent")) !== "yes") errors.push("consent_required");

  if (errors.length > 0) return { kind: "invalid", errors };
  return { kind: "ok", value: { name, phone, email, contactPref, contactTime, message } };
}
```

- [ ] **Step 4: 通ることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-inquiry-input.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/inquiry-input.ts src/lib/__tests__/sale-dm-inquiry-input.test.ts
git commit -m "feat(sale-dm): 査定申込フォームの入力検証(純関数)"
```

---

### Task 4: 申込の記録 `inquiry-record.ts`(ロック順序・反響の計上)

**Files:**
- Create: `src/lib/sale-dm-letter/inquiry-record.ts`
- Modify: `src/lib/__tests__/dm-writer-lock-order.test.ts`(追記)
- Test: `src/lib/__tests__/sale-dm-inquiry-record.test.ts`

**Interfaces:**
- Consumes: `InquiryInput`(Task 3)、`lockPropertyRow`(`@/lib/property-record-guard`)、`syncSaleDmReaction`/`ReactionSyncTx`(`@/lib/dm-reaction/sync`)。
- Produces:
  ```ts
  export type RecordInquiryResult =
    | { kind: "unknown" }
    | { kind: "not_sent" }
    | { kind: "recorded"; inquiryId: string; draftId: string; first: boolean };
  export async function recordInquiry(client: InquiryClientLike, token: string, input: InquiryInput, now?: Date): Promise<RecordInquiryResult>;
  ```
  例外(DB エラー・ロック競合)は**投げる**(呼び出し側 route が「混み合っています」ページにする。申込を黙って捨てない)。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-inquiry-record.test.ts
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn(async () => undefined) }));
vi.mock("@/lib/dm-reaction/sync", () => ({ syncSaleDmReaction: vi.fn(async () => undefined) }));

import { recordInquiry } from "@/lib/sale-dm-letter/inquiry-record";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { syncSaleDmReaction } from "@/lib/dm-reaction/sync";

const INPUT = { name: "山田", phone: "090-1234-5678", email: null, contactPref: null, contactTime: null, message: "相談したい" };
const NOW = new Date("2026-09-20T01:00:00.000Z");

function makeClient(draft: { id: string; propertyId: string; status: string } | null, lockedStatus = draft?.status, claims = { form: 1, lp: 0 }) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: vi.fn(),
    dmRecipientDraft: {
      findUnique: vi.fn(async () => { calls.push("tx.findUnique"); return draft ? { status: lockedStatus } : null; }),
      updateMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        calls.push(`tx.updateMany:${Object.keys(args.where).join(",")}`);
        return { count: "formInquiryFirstAt" in args.where ? claims.form : claims.lp };
      }),
      update: vi.fn(async () => { calls.push("tx.update"); return {}; }),
    },
    dmInquiry: {
      create: vi.fn(async () => { calls.push("tx.dmInquiry.create"); return { id: "inq1" }; }),
    },
  };
  const client = {
    dmRecipientDraft: { findUnique: vi.fn(async () => draft) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { client, tx, calls };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("recordInquiry", () => {
  it("未知 token は unknown(何も書かない)", async () => {
    const { client } = makeClient(null);
    expect(await recordInquiry(client as never, "x", INPUT, NOW)).toEqual({ kind: "unknown" });
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("送付前は not_sent(何も書かない)", async () => {
    const { client } = makeClient({ id: "d1", propertyId: "p1", status: "confirmed" });
    expect(await recordInquiry(client as never, "t", INPUT, NOW)).toEqual({ kind: "not_sent" });
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("ロック後に読み直して送付済みでなければ not_sent(INSERT しない)", async () => {
    const { client, tx } = makeClient({ id: "d1", propertyId: "p1", status: "sent" }, "confirmed");
    expect(await recordInquiry(client as never, "t", INPUT, NOW)).toEqual({ kind: "not_sent" });
    expect(tx.dmInquiry.create).not.toHaveBeenCalled();
  });

  it("送付済み: 親行ロック→読み直し→INSERT→初回→QR読み取りの補い→計数+outcome→同期(allowTerminal:false)", async () => {
    const { client, tx, calls } = makeClient({ id: "d1", propertyId: "p1", status: "sent" });
    const r = await recordInquiry(client as never, "t", INPUT, NOW);
    expect(r).toEqual({ kind: "recorded", inquiryId: "inq1", draftId: "d1", first: true });
    expect(lockPropertyRow).toHaveBeenCalledWith(tx, "p1");
    expect(calls).toEqual([
      "tx.findUnique",
      "tx.dmInquiry.create",
      "tx.updateMany:id,formInquiryFirstAt",
      "tx.updateMany:id,lpFirstAccessAt",
      "tx.update",
    ]);
    expect(tx.dmInquiry.create).toHaveBeenCalledWith({
      data: { draftId: "d1", submittedAt: NOW, name: "山田", phone: "090-1234-5678", email: null, contactPref: null, contactTime: null, message: "相談したい" },
      select: { id: true },
    });
    expect(tx.dmRecipientDraft.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { formInquiryCount: { increment: 1 }, outcome: "inquiry" },
    });
    expect(syncSaleDmReaction).toHaveBeenCalledWith(tx, "d1", { allowTerminal: false });
  });

  it("2回目の申込は first=false(初回時刻は条件付き updateMany の count で決める)", async () => {
    const { client } = makeClient({ id: "d1", propertyId: "p1", status: "sent" }, "sent", { form: 0, lp: 0 });
    expect(await recordInquiry(client as never, "t", INPUT, NOW)).toMatchObject({ kind: "recorded", first: false });
  });

  it("DB エラーは投げる(申込を黙って捨てない)", async () => {
    const { client, tx } = makeClient({ id: "d1", propertyId: "p1", status: "sent" });
    tx.dmInquiry.create.mockRejectedValueOnce(new Error("db down"));
    await expect(recordInquiry(client as never, "t", INPUT, NOW)).rejects.toThrow("db down");
  });
});
```

`src/lib/__tests__/dm-writer-lock-order.test.ts` の「公開LPのページ閲覧」の `it` の直後に追記:

```ts
  it("公開LPの査定申込: 親行ロック→読み直し→申込INSERT→宛先の計数→同期(allowTerminal:false=Ownerロック不要)", () => {
    const src = read("src/lib/sale-dm-letter/inquiry-record.ts");
    const body = src.slice(src.indexOf("export async function recordInquiry"));
    assertOrder("inquiry", body, [
      "lockPropertyRow",
      "tx.dmRecipientDraft.findUnique",
      "tx.dmInquiry.create",
      "tx.dmRecipientDraft.updateMany",
      "tx.dmRecipientDraft.update({",
      "syncSaleDmReaction",
      "allowTerminal: false",
    ]);
    expect(body).not.toMatch(/lockOwnersForUpdate/);
  });
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-inquiry-record.test.ts src/lib/__tests__/dm-writer-lock-order.test.ts` → FAIL

- [ ] **Step 3: 実装**

```ts
// src/lib/sale-dm-letter/inquiry-record.ts
import { lockPropertyRow } from "@/lib/property-record-guard";
import { syncSaleDmReaction, type ReactionSyncTx } from "@/lib/dm-reaction/sync";
import type { InquiryInput } from "./inquiry-input";

// ⚠この説明を関数直上へ移すと dm-writer-lock-order の走査(関数本文の文字列)に引っかかる
/**
 * 公開LPの査定申込の記録(設計 §2.5)。
 *
 * 順序(R50=物件配下の書込は親行ロックから・recordTrackingHit と同じ):
 *   親の物件行ロック → ロック下で宛先の状態を読み直す(送付済みでなければ書かない)
 *   → 申込 INSERT → 初回時刻(条件付き updateMany の count で確定=同時の二重初回を防ぐ)
 *   → QR読み取り時刻の補い(下記) → 申込回数 +1・outcome=inquiry → 送付記録への反響同期。
 *
 * QR読み取り時刻の補い: 申込は必ずアプリ内LPページ(GET /t/<token>=QR読み取りの記録が先に走る)から
 * 送られるので lpFirstAccessAt は通常すでに立っている。立っていない(QR読み取りの記録は best-effort
 * で失敗し得る)ときだけここで立てる。これで outcome の正準定義(deriveOutcome=LP∪電話)を変えずに
 * 「申込があれば必ず反響あり」が成り立つ(outcome route が電話反響を外しても申込の反響は消えない)。
 * lpAccessCount は増やさない(閲覧回数の水増しをしない)。
 *
 * 同期は allowTerminal:false=「連絡あり」だけを書く(宛先不明は書かない=Owner ロック不要の公開経路)。
 * 拒否(配信停止)済みの送付記録は同期の優先規則(dm-reaction/core)で上書きされない。申込自体は保存する。
 *
 * 例外は投げる(呼び出し側が「混み合っています」を返す)。申込を黙って捨てない。
 */

export interface InquiryDraftRow {
  id: string;
  propertyId: string;
  status: string;
}

export interface InquiryTx {
  $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
  dmRecipientDraft: {
    findUnique: (args: { where: { id: string }; select: { status: true } }) => Promise<{ status: string } | null>;
    updateMany: (args: {
      where: { id: string; formInquiryFirstAt?: null; lpFirstAccessAt?: null };
      data: { formInquiryFirstAt?: Date; lpFirstAccessAt?: Date };
    }) => Promise<{ count: number }>;
    update: (args: {
      where: { id: string };
      data: { formInquiryCount: { increment: number }; outcome: "inquiry" };
    }) => Promise<unknown>;
  };
  dmInquiry: {
    create: (args: {
      data: InquiryInput & { draftId: string; submittedAt: Date };
      select: { id: true };
    }) => Promise<{ id: string }>;
  };
}

export interface InquiryClientLike {
  dmRecipientDraft: {
    findUnique: (args: {
      where: { trackingToken: string };
      select: { id: true; propertyId: true; status: true };
    }) => Promise<InquiryDraftRow | null>;
  };
  $transaction: <T>(fn: (tx: InquiryTx) => Promise<T>) => Promise<T>;
}

export type RecordInquiryResult =
  | { kind: "unknown" }
  | { kind: "not_sent" }
  | { kind: "recorded"; inquiryId: string; draftId: string; first: boolean };

export async function recordInquiry(
  client: InquiryClientLike,
  token: string,
  input: InquiryInput,
  now: Date = new Date(),
): Promise<RecordInquiryResult> {
  const draft = await client.dmRecipientDraft.findUnique({
    where: { trackingToken: token },
    select: { id: true, propertyId: true, status: true },
  });
  if (!draft) return { kind: "unknown" };
  if (draft.status !== "sent") return { kind: "not_sent" };

  return client.$transaction(async (tx): Promise<RecordInquiryResult> => {
    await lockPropertyRow(tx, draft.propertyId);
    const locked = await tx.dmRecipientDraft.findUnique({ where: { id: draft.id }, select: { status: true } });
    if (!locked || locked.status !== "sent") return { kind: "not_sent" };

    const created = await tx.dmInquiry.create({
      data: {
        draftId: draft.id,
        submittedAt: now,
        name: input.name,
        phone: input.phone,
        email: input.email,
        contactPref: input.contactPref,
        contactTime: input.contactTime,
        message: input.message,
      },
      select: { id: true },
    });
    const claimed = await tx.dmRecipientDraft.updateMany({
      where: { id: draft.id, formInquiryFirstAt: null },
      data: { formInquiryFirstAt: now },
    });
    await tx.dmRecipientDraft.updateMany({
      where: { id: draft.id, lpFirstAccessAt: null },
      data: { lpFirstAccessAt: now },
    });
    await tx.dmRecipientDraft.update({
      where: { id: draft.id },
      data: { formInquiryCount: { increment: 1 }, outcome: "inquiry" },
    });
    await syncSaleDmReaction(tx as unknown as ReactionSyncTx, draft.id, { allowTerminal: false });
    return { kind: "recorded", inquiryId: created.id, draftId: draft.id, first: claimed.count === 1 };
  });
}
```

- [ ] **Step 4: 通ることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-inquiry-record.test.ts src/lib/__tests__/dm-writer-lock-order.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/inquiry-record.ts src/lib/__tests__/sale-dm-inquiry-record.test.ts src/lib/__tests__/dm-writer-lock-order.test.ts
git commit -m "feat(sale-dm): 査定申込の記録(親行ロック→申込保存→反響の計上)"
```

---

### Task 5: 申込まわりの公開ページと同意文のひな形

**Files:**
- Create: `src/lib/sale-dm-letter/inquiry-page.ts`、`src/lib/sale-dm-letter/privacy-text.ts`
- Modify: `src/lib/sale-dm-letter/unsubscribe-page.ts`(`page` を `renderPublicCardPage` として export し、既存の呼び出しを置き換え)
- Test: `src/lib/__tests__/sale-dm-inquiry-page.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // unsubscribe-page.ts
  export function renderPublicCardPage(title: string, bodyHtml: string): string; // title は escape 済みの固定文を渡す
  // inquiry-page.ts
  export function renderInquiryDonePage(): string;
  export function renderInquiryInvalidPage(messages: readonly string[], backHref: string): string;
  export function renderInquiryPreviewPage(): string;
  export function renderInquiryUnavailablePage(): string;
  export function renderInquiryBusyPage(): string;
  export function renderInquiryThrottledPage(): string;
  // privacy-text.ts
  export const DEFAULT_PRIVACY_TEXT: string;
  ```

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-inquiry-page.test.ts
import { describe, it, expect } from "vitest";
import {
  renderInquiryDonePage, renderInquiryInvalidPage, renderInquiryPreviewPage,
  renderInquiryUnavailablePage, renderInquiryBusyPage, renderInquiryThrottledPage,
} from "@/lib/sale-dm-letter/inquiry-page";
import { DEFAULT_PRIVACY_TEXT } from "@/lib/sale-dm-letter/privacy-text";
import { renderUnsubscribeDonePage } from "@/lib/sale-dm-letter/unsubscribe-page";

describe("申込まわりの公開ページ", () => {
  it("完了: 担当者から連絡する旨。自動返信メールは送らない設計なので「メールを送りました」と言わない", () => {
    const html = renderInquiryDonePage();
    expect(html).toContain("受け付けました");
    expect(html).toContain("担当者");
    expect(html).not.toMatch(/メールを(お)?送り/);
  });
  it("入力不備: 文言は escape され、戻り先リンクが出る", () => {
    const html = renderInquiryInvalidPage(["<b>お名前</b>をご入力ください。"], "/t/abc#inquiry");
    expect(html).toContain("&lt;b&gt;お名前&lt;/b&gt;");
    expect(html).toContain('href="/t/abc#inquiry"');
  });
  it("入力不備: 戻り先の引用符も escape", () => {
    expect(renderInquiryInvalidPage([], '/t/a"onmouseover="x')).not.toContain('"onmouseover="');
  });
  it("プレビュー中・受付不可・混雑・回数超過は、それぞれ電話での受付へ誘導する", () => {
    for (const html of [renderInquiryPreviewPage(), renderInquiryUnavailablePage(), renderInquiryBusyPage(), renderInquiryThrottledPage()]) {
      expect(html).toMatch(/お電話/);
      expect(html).toContain('<meta name="robots" content="noindex,nofollow" />');
    }
  });
  it("配信停止ページは共通化後も同じ見た目(回帰)", () => {
    expect(renderUnsubscribeDonePage()).toContain("配信停止を受け付けました");
  });
  it("同意文のひな形: 利用目的と第三者提供に触れている", () => {
    expect(DEFAULT_PRIVACY_TEXT).toMatch(/利用/);
    expect(DEFAULT_PRIVACY_TEXT).toMatch(/第三者/);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-inquiry-page.test.ts` → FAIL

- [ ] **Step 3: 実装**

`src/lib/sale-dm-letter/unsubscribe-page.ts`: `function page(title: string, bodyHtml: string): string {` を次に変え、ファイル内の `page(` の呼び出しをすべて `renderPublicCardPage(` に置き換える:

```ts
/** お客様向けの公開カード型ページ(配信停止・査定申込の結果画面で共用)。
 *  ⚠title と bodyHtml は呼び出し側で escape 済み(固定文)であること。 */
export function renderPublicCardPage(title: string, bodyHtml: string): string {
```

`PAGE_STYLE` の末尾に1行追加(申込の入力不備ページのリスト・リンク用):

```ts
  "ul{margin:0 0 12px;padding-left:1.2em;font-size:15px}",
  "a.back{display:block;text-align:center;margin-top:16px;color:#0a5246;font-weight:700}",
```

```ts
// src/lib/sale-dm-letter/privacy-text.ts
/** 公開LPの申込フォームに出す個人情報の取扱い文のひな形。管理者設定(privacyText)が空のときに表示する。
 *  発注者の文章に差し替える前提の最低限の内容(利用目的・第三者提供・問い合わせ先)。 */
export const DEFAULT_PRIVACY_TEXT = [
  "ご入力いただいた個人情報は、無料査定のご連絡と、不動産に関するご相談への対応のためにのみ利用します。",
  "法令に基づく場合を除き、ご本人の同意なく第三者に提供することはありません。",
  "個人情報の取り扱いに関するお問い合わせは、このページの会社案内に記載の連絡先までご連絡ください。",
].join("\n");
```

```ts
// src/lib/sale-dm-letter/inquiry-page.ts
/**
 * 公開LPの査定申込の結果画面(設計 §2.5)。純関数・固定文のみ。
 * ⚠お客様が見る画面。入力された氏名・電話などは一切表示しない(送り返さない)。
 */
import { escapeHtml } from "./templates/index";
import { renderPublicCardPage } from "./unsubscribe-page";

export function renderInquiryDonePage(): string {
  return renderPublicCardPage("お申し込みを受け付けました", [
    "<h1>お申し込みを受け付けました</h1>",
    "<p>無料査定のお申し込みをいただき、ありがとうございます。</p>",
    "<p>内容を確認のうえ、担当者からご連絡いたします。</p>",
    '<p class="note">数日たっても連絡がない場合は、お手数ですがお手紙に記載の連絡先までお電話ください。</p>',
  ].join(""));
}

export function renderInquiryInvalidPage(messages: readonly string[], backHref: string): string {
  const items = messages.map((m) => `<li>${escapeHtml(m)}</li>`).join("");
  return renderPublicCardPage("入力内容をご確認ください", [
    "<h1>入力内容をご確認ください</h1>",
    items ? `<ul>${items}</ul>` : "",
    `<a class="back" href="${escapeHtml(backHref)}">入力画面に戻る</a>`,
  ].join(""));
}

export function renderInquiryPreviewPage(): string {
  return renderPublicCardPage("まだお申し込みを受け付けていません", [
    "<h1>まだお申し込みを受け付けていません</h1>",
    "<p>このページは送付前の確認用です。お申し込みは受け付けておりません。</p>",
    "<p>お急ぎの場合は、お手紙に記載の連絡先までお電話ください。</p>",
  ].join(""));
}

export function renderInquiryUnavailablePage(): string {
  return renderPublicCardPage("お申し込みを受け付けられませんでした", [
    "<h1>お申し込みを受け付けられませんでした</h1>",
    "<p>お手数ですが、お手紙に記載の連絡先までお電話ください。</p>",
  ].join(""));
}

export function renderInquiryBusyPage(): string {
  return renderPublicCardPage("ただいま混み合っています", [
    "<h1>ただいま混み合っています</h1>",
    "<p>お申し込みを完了できませんでした。少し時間をおいて、もう一度お試しください。</p>",
    "<p>お急ぎの場合は、お手紙に記載の連絡先までお電話ください。</p>",
  ].join(""));
}

export function renderInquiryThrottledPage(): string {
  return renderPublicCardPage("アクセスが集中しています", [
    "<h1>アクセスが集中しています</h1>",
    "<p>しばらく時間をおいてから、もう一度お試しください。</p>",
    "<p>お急ぎの場合は、お手紙に記載の連絡先までお電話ください。</p>",
  ].join(""));
}
```

- [ ] **Step 4: 通ることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-inquiry-page.test.ts src/lib/__tests__/sale-dm-unsubscribe-route.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/inquiry-page.ts src/lib/sale-dm-letter/privacy-text.ts src/lib/sale-dm-letter/unsubscribe-page.ts src/lib/__tests__/sale-dm-inquiry-page.test.ts
git commit -m "feat(sale-dm): 査定申込の結果画面と同意文のひな形"
```

---

### Task 6: LPページに申込フォームを出す

**Files:**
- Modify: `src/lib/sale-dm-letter/lp-render-input.ts`、`src/lib/sale-dm-letter/lp-page.ts`、`src/lib/sale-dm-letter/lp-page-loader.ts`、`src/lib/sale-dm-letter/config-store.ts`(`loadSaleDmPublicPageConfig` と env フォールバック)、`src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/preview/route.ts`
- Test: `src/lib/__tests__/sale-dm-lp-page.test.ts`(追記)、`src/lib/__tests__/sale-dm-lp-render-input.test.ts`(追記)、`src/lib/__tests__/sale-dm-lp-page-loader.test.ts`(追記)

**Interfaces:**
- Consumes: `LP_CTA_LABEL`(`lp-page.ts`)、`DEFAULT_PRIVACY_TEXT`(Task 5)、`INQUIRY_LIMITS`/`HONEYPOT_FIELD`(Task 3)。
- Produces:
  ```ts
  export interface LpFormInput { action: string; privacyText: string; disabled: boolean }
  // LpRenderInput.form: LpFormInput | null
  // buildLpRenderInput(rows, opts: { mode; unsubscribeUrl; phoneTapToken; form: LpFormInput | null })
  // loadSaleDmPublicPageConfig() の戻り値に privacyText: string | null を追加
  export const INQUIRY_SECTION_ID = "inquiry"; // lp-page.ts
  ```

- [ ] **Step 1: テスト(追記)**

`src/lib/__tests__/sale-dm-lp-page.test.ts` の末尾(見本は当ファイル既存の `input(over)`):

```ts
describe("申込フォーム(PR4)", () => {
  const FORM = { action: "/t/tok_live/inquiry", privacyText: "利用目的は査定のご連絡です。\n<script>x</script>", disabled: false };

  it("フォームあり: 送信先・必須欄・上限・隠し欄・同意・固定文言のボタン", () => {
    const html = renderLpPage(input({ mode: "live", form: FORM }));
    expect(html).toContain('<form method="post" action="/t/tok_live/inquiry"');
    expect(html).toMatch(/name="name"[^>]*required[^>]*maxlength="50"/);
    expect(html).toMatch(/name="phone"[^>]*type="tel"[^>]*required[^>]*maxlength="20"/);
    expect(html).toMatch(/name="email"[^>]*type="email"[^>]*maxlength="254"/);
    expect(html).toMatch(/name="contactTime"[^>]*maxlength="60"/);
    expect(html).toMatch(/<textarea[^>]*name="message"[^>]*maxlength="1000"/);
    expect(html).toMatch(/name="website"[^>]*tabindex="-1"/);
    expect(html).toMatch(/type="checkbox" name="consent" value="yes" required/);
    expect(html).toContain(`>${LP_CTA_LABEL}</button>`);
  });

  it("同意文は escape し、改行だけ <br />", () => {
    const html = renderLpPage(input({ mode: "live", form: FORM }));
    expect(html).toContain("利用目的は査定のご連絡です。<br />&lt;script&gt;x&lt;/script&gt;");
  });

  it("CTA(本文中・固定バー)はフォームへ飛ぶ。フォームが無ければ従来どおり会社案内へ", () => {
    expect(renderLpPage(input({ mode: "live", form: FORM }))).toContain('href="#inquiry"');
    const without = renderLpPage(input({ mode: "live", form: null }));
    expect(without).toContain('href="#contact"');
    expect(without).not.toContain("<form");
  });

  it("送付前(disabled): fieldset disabled で送信不可", () => {
    const html = renderLpPage(input({ mode: "preview", form: { ...FORM, action: "#", disabled: true } }));
    expect(html).toContain("<fieldset disabled>");
  });

  it("入力欄の文字は16px以上(iOS の自動拡大を起こさない)", () => {
    const html = renderLpPage(input({ mode: "live", form: FORM }));
    expect(html).toMatch(/\.inquiry input,\.inquiry textarea\{[^}]*font-size:16px/);
  });

  it("参照元方針は same-origin(no-referrer だとフォーム送信の Origin が null になる)", () => {
    const html = renderLpPage(input({ mode: "live", form: FORM }));
    expect(html).toContain('<meta name="referrer" content="same-origin" />');
    expect(html).not.toContain("no-referrer");
  });
});
```

`src/lib/__tests__/sale-dm-lp-render-input.test.ts`: 既存の `buildLpRenderInput(rows(...), { ... })` の呼び出し(3か所)の opts に `form: null` を足し、末尾に追記(`LP_RENDER_INPUT_KEYS` を `../sale-dm-letter/lp-render-input` の import に足す):

```ts
it("form は opts から素通しで渡る(PII を足さない)", () => {
  const form = { action: "/t/tok/inquiry", privacyText: "文", disabled: false };
  const out = buildLpRenderInput(rows(), { mode: "live", unsubscribeUrl: null, phoneTapToken: "tok", form });
  expect(out.form).toEqual(form);
  expect(Object.keys(out).sort()).toEqual([...LP_RENDER_INPUT_KEYS].sort());
});
```

`src/lib/__tests__/sale-dm-lp-page-loader.test.ts`: 冒頭の `vi.mock("@/lib/sale-dm-letter/config-store", ...)` の戻り値に `privacyText: null,` を足し、import に `import { escapeHtml } from "../sale-dm-letter/templates/index";` と `import { DEFAULT_PRIVACY_TEXT } from "../sale-dm-letter/privacy-text";` を足し、末尾に追記(`draft(over)`・`client(row)` は当ファイル既存。`draft()` の token は `"tok"`。公開スイッチは mock で `lpPublicEnabled: true`):

```ts
it("送付済み: 申込フォームの送信先は /t/<token>/inquiry・同意文は未設定ならひな形", async () => {
  const r = await loadLpPageData(client(draft({ status: "sent" })) as never, "tok");
  expect(r.kind).toBe("page");
  if (r.kind !== "page") return;
  expect(r.html).toContain('action="/t/tok/inquiry"');
  expect(r.html).toContain(escapeHtml(DEFAULT_PRIVACY_TEXT.split("\n")[0]));
  expect(r.html).not.toContain("<fieldset disabled>");
});

it("送付前: フォームは出すが送信不可", async () => {
  const r = await loadLpPageData(client(draft({ status: "confirmed" })) as never, "tok");
  if (r.kind !== "page") throw new Error("page expected");
  expect(r.html).toContain("<fieldset disabled>");
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-page.test.ts src/lib/__tests__/sale-dm-lp-render-input.test.ts src/lib/__tests__/sale-dm-lp-page-loader.test.ts` → FAIL

- [ ] **Step 3: 実装**

`src/lib/sale-dm-letter/lp-render-input.ts`:

```ts
/** 申込フォームの描画入力。action=送信先(/t/<token>/inquiry・社内プレビューは "#")。disabled=送付前(送信不可)。 */
export interface LpFormInput { action: string; privacyText: string; disabled: boolean }
```

`LpRenderInput` の `form: null;` を `form: LpFormInput | null;` に。`buildLpRenderInput` の opts 型に `form: LpFormInput | null` を足し、戻り値の `form: null` を `form: opts.form` に。

`src/lib/sale-dm-letter/lp-page.ts`:

```ts
import { INQUIRY_LIMITS, HONEYPOT_FIELD } from "./inquiry-input";
import type { LpRenderInput, LpImage, LpFormInput } from "./lp-render-input";
```

```ts
export const INQUIRY_SECTION_ID = "inquiry";
```

`CSS` 配列の `".unsub{...}"` 行の直前に追加:

```ts
  ".inquiry{background:#fff;border:1px solid #d6dedb;border-radius:12px;padding:16px}",
  ".inquiry fieldset{border:0;margin:0;padding:0;min-width:0}",
  ".inquiry label{display:block;margin:0 0 14px;font-weight:700}",
  ".inquiry .req,.inquiry .opt{display:inline-block;margin-left:8px;font-size:12px;font-weight:700;border-radius:4px;padding:0 6px;vertical-align:2px}",
  ".inquiry .req{background:#a85f1b;color:#fff}",
  ".inquiry .opt{background:#e6ebe9;color:#4a5b5e}",
  ".inquiry input,.inquiry textarea{display:block;width:100%;margin-top:6px;font:inherit;font-size:16px;font-weight:400;padding:10px 12px;border:1px solid #b9c6c2;border-radius:8px;background:#fff;color:#1f2a2d;min-height:44px}",
  ".inquiry textarea{min-height:120px;resize:vertical}",
  ".inquiry .pref{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:6px;font-weight:400}",
  ".inquiry .pref label{display:flex;align-items:center;gap:6px;margin:0;font-weight:400;min-height:44px}",
  ".inquiry .pref input,.inquiry .consent input{width:auto;min-height:0;margin:0}",
  ".inquiry .privacy{font-size:14px;color:#4a5b5e;background:#f6f7f6;border-radius:8px;padding:10px 12px;margin:4px 0 12px;white-space:normal}",
  ".inquiry .consent{display:flex;align-items:center;gap:8px;font-weight:700;min-height:44px}",
  ".inquiry button{margin-top:12px;width:100%;border:0;cursor:pointer;font:inherit;font-size:17px;font-weight:700}",
  ".inquiry fieldset:disabled button{background:#9fb3ae;cursor:not-allowed}",
  ".hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}",
```

`renderLpPage` の直前に追加:

```ts
function formSection(form: LpFormInput): string {
  const privacy = escapeHtml(form.privacyText).replace(/\n/g, "<br />");
  const pref = (value: string, label: string) =>
    `<label><input type="radio" name="contactPref" value="${value}" />${label}</label>`;
  return `<section class="inquiry" id="${INQUIRY_SECTION_ID}"><h2>${escapeHtml(LP_CTA_LABEL)}</h2>` +
    `<form method="post" action="${escapeHtml(form.action)}" data-inquiry="1">` +
    `<fieldset${form.disabled ? " disabled" : ""}>` +
    `<label>お名前<span class="req">必須</span><input name="name" type="text" required maxlength="${INQUIRY_LIMITS.name}" autocomplete="name" /></label>` +
    `<label>電話番号<span class="req">必須</span><input name="phone" type="tel" required maxlength="${INQUIRY_LIMITS.phone}" inputmode="tel" autocomplete="tel" placeholder="例: 090-1234-5678" /></label>` +
    `<label>メールアドレス<span class="opt">任意</span><input name="email" type="email" maxlength="${INQUIRY_LIMITS.email}" autocomplete="email" /></label>` +
    `<div><strong>ご希望の連絡方法</strong><span class="opt">任意</span><div class="pref">${pref("phone", "電話")}${pref("email", "メール")}${pref("either", "どちらでも")}</div></div>` +
    `<label>連絡のつきやすい時間帯<span class="opt">任意</span><input name="contactTime" type="text" maxlength="${INQUIRY_LIMITS.contactTime}" placeholder="例: 平日18時以降" /></label>` +
    `<label>ご要望・ご質問<span class="opt">任意</span><textarea name="message" maxlength="${INQUIRY_LIMITS.message}" rows="4"></textarea></label>` +
    `<div class="hp" aria-hidden="true"><label>ウェブサイト<input name="${HONEYPOT_FIELD}" type="text" tabindex="-1" autocomplete="off" /></label></div>` +
    `<div class="privacy">${privacy}</div>` +
    `<label class="consent"><input type="checkbox" name="consent" value="yes" required />個人情報の取り扱いに同意する</label>` +
    `<button type="submit" class="cta">${escapeHtml(LP_CTA_LABEL)}</button>` +
    `</fieldset></form></section>`;
}
```

`renderLpPage` の中:
- 先頭の `const cta = ...` を次に置き換え:
  ```ts
  const ctaTarget = input.form ? INQUIRY_SECTION_ID : CONTACT_ID;
  const cta = `<a class="cta" href="#${ctaTarget}">${escapeHtml(LP_CTA_LABEL)}</a>`;
  ```
- 会社案内の文言 `` `<p style="margin-top:10px">無料査定のお申し込み・ご相談は、お電話で承ります。</p>` `` を次に:
  ```ts
  `<p style="margin-top:10px">${input.form ? "お電話でのご相談も承ります。" : "無料査定のお申し込み・ご相談は、お電話で承ります。"}</p>`
  ```
- 本文の組み立て `paragraphs(input.intro) + sections + faq + company + unsub` を `paragraphs(input.intro) + sections + faq + (input.form ? formSection(input.form) : "") + company + unsub` に。
- 送信ボタンの二重押し防止(送付済み=送信可能なときだけ)。`const script = ...` の直後に:
  ```ts
  const submitGuard = input.form && !input.form.disabled
    ? `<script>(function(){var f=document.querySelector("form[data-inquiry]");if(!f)return;f.addEventListener("submit",function(){var b=f.querySelector("button[type=submit]");if(b){setTimeout(function(){b.disabled=true},0)}});})();</script>`
    : "";
  ```
  return の `${bar}${script}` を `${bar}${script}${submitGuard}` に。

`src/lib/sale-dm-letter/config-store.ts` の `loadSaleDmPublicPageConfig`:
- 戻り値の型に `privacyText: string | null;` を追加。
- `db` の型と `select` に `privacyText` を追加: `select: { senderName: true, senderContact: true, trackingBaseUrl: true, privacyText: true }`。
- return に `privacyText: db?.privacyText && db.privacyText.trim().length > 0 ? db.privacyText : null,` を追加(env フォールバックは持たない=同意文は画面から設定する)。

`src/lib/sale-dm-letter/lp-page-loader.ts`:

```ts
import { DEFAULT_PRIVACY_TEXT } from "./privacy-text";
```

`buildLpRenderInput(...)` の opts に追加:

```ts
      // 送信先は QR の token 配下(nginx の公開範囲 /t/ の中に収まる)。送付前は送信不可(受け口でも 409)。
      form: {
        action: `/t/${encodeURIComponent(row.trackingToken)}/inquiry`,
        privacyText: cfg.privacyText ?? DEFAULT_PRIVACY_TEXT,
        disabled: mode !== "live",
      },
```

社内プレビュー route(`.../preview/route.ts`)の `buildLpRenderInput` の opts を次に:

```ts
      { mode: "preview", unsubscribeUrl: null, phoneTapToken: null, form: { action: "#", privacyText: cfg.privacyText ?? DEFAULT_PRIVACY_TEXT, disabled: true } },
```

と `import { DEFAULT_PRIVACY_TEXT } from "@/lib/sale-dm-letter/privacy-text";`。

(`buildLpRenderInput` を呼ぶ他の箇所がないか `grep -rn "buildLpRenderInput(" src --include=*.ts | grep -v __tests__` で確認し、あれば `form: null` を足す。)

- [ ] **Step 4: 通ることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-page.test.ts src/lib/__tests__/sale-dm-lp-render-input.test.ts src/lib/__tests__/sale-dm-lp-page-loader.test.ts src/lib/__tests__/sale-dm-lp-preview-route.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/lp-render-input.ts src/lib/sale-dm-letter/lp-page.ts src/lib/sale-dm-letter/lp-page-loader.ts src/lib/sale-dm-letter/config-store.ts "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/preview/route.ts" src/lib/__tests__/sale-dm-lp-page.test.ts src/lib/__tests__/sale-dm-lp-render-input.test.ts src/lib/__tests__/sale-dm-lp-page-loader.test.ts
git commit -m "feat(sale-dm): 公開LPに査定申込フォームを表示(送付前は送信不可)"
```

---

### Task 7: 申込の受け口 `POST /t/[token]/inquiry`

**Files:**
- Create: `src/app/t/[token]/inquiry/route.ts`
- Modify: `src/lib/audit-log-detail-safety.ts`、`src/app/(dashboard)/admin/audit-logs/page.tsx`、`src/lib/__tests__/sale-dm-external-audit-visible.test.ts`
- Test: `src/lib/__tests__/sale-dm-inquiry-route.test.ts`

**Interfaces:**
- Consumes: `isCrossSiteOrigin`(Task 1)、`parseInquiryForm`/`INQUIRY_ERROR_MESSAGES`(Task 3)、`recordInquiry`(Task 4)、結果画面(Task 5)、`PUBLIC_PAGE_HEADERS`、`clientRateKey`/`createRateLimiter`、`writeAuditLog`。
- Produces: 監査 `sale_dm_inquiry_submit`(detail `{ first, at }` / 回数超過時 `{ result: "throttled", at }`)。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-inquiry-route.test.ts
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextResponse: Response }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("@/lib/sale-dm-letter/inquiry-record", () => ({ recordInquiry: vi.fn() }));

import { POST } from "@/app/t/[token]/inquiry/route";
import { recordInquiry } from "@/lib/sale-dm-letter/inquiry-record";
import { writeAuditLog } from "@/lib/audit";

const rec = recordInquiry as unknown as ReturnType<typeof vi.fn>;
const VALID = { name: "山田", phone: "090-1234-5678", consent: "yes" };

// ⚠レート制限はモジュール保持でテスト間リセットされない。IP と token をテストごとに変える。
let seq = 0;
function call(fields: Record<string, string>, headers: Record<string, string> = {}, token?: string) {
  seq += 1;
  const tk = token ?? `tok_${seq}`;
  const body = new URLSearchParams(fields).toString();
  const req = new Request(`http://localhost:3000/t/${tk}/inquiry`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: "app.ligarejapan.com",
      "x-forwarded-for": `10.9.${Math.floor(seq / 250)}.${seq % 250}`,
      ...headers,
    },
    body,
  });
  return POST(req as never, { params: Promise.resolve({ token: tk }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  rec.mockResolvedValue({ kind: "recorded", inquiryId: "inq1", draftId: "d1", first: true });
});

describe("POST /t/[token]/inquiry", () => {
  it("送付済み・正しい入力: 記録して完了ページ(200・no-store・same-origin)。監査は draftId と非PIIのみ", async () => {
    const res = await call(VALID, { origin: "https://app.ligarejapan.com" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(await res.text()).toContain("受け付けました");
    expect(rec).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^tok_/), {
      name: "山田", phone: "090-1234-5678", email: null, contactPref: null, contactTime: null, message: null,
    });
    const audit = (writeAuditLog as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit).toMatchObject({ action: "sale_dm_inquiry_submit", targetTable: "dm_recipient_drafts", targetId: "d1" });
    expect(Object.keys(audit.detail).sort()).toEqual(["at", "first"]);
    expect(JSON.stringify(audit)).not.toMatch(/山田|090/);
  });

  it("よそのサイトからは 403(記録しない)", async () => {
    const res = await call(VALID, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(rec).not.toHaveBeenCalled();
  });

  it("Origin: null(実ブラウザ)は通す", async () => {
    const res = await call(VALID, { origin: "null" });
    expect(res.status).toBe(200);
  });

  it("honeypot が埋まっていれば記録せず完了ページ(監査もしない)", async () => {
    const res = await call({ ...VALID, website: "http://spam" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("受け付けました");
    expect(rec).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("入力不備は 422。文言と戻り先(#inquiry)を出し、入力値は送り返さない", async () => {
    const res = await call({ name: "山田", phone: "abc" }, {}, "tok_back");
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("電話番号は数字とハイフンで");
    expect(html).toContain("個人情報の取り扱いへの同意が必要です");
    expect(html).toContain('href="/t/tok_back#inquiry"');
    expect(html).not.toContain("山田");
    expect(rec).not.toHaveBeenCalled();
  });

  it("送付前は 409 プレビュー中ページ", async () => {
    rec.mockResolvedValueOnce({ kind: "not_sent" });
    const res = await call(VALID);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("まだお申し込みを受け付けていません");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("未知 token は 404(記録・監査なし)", async () => {
    rec.mockResolvedValueOnce({ kind: "unknown" });
    const res = await call(VALID);
    expect(res.status).toBe(404);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("記録で例外が出たら 503 混雑ページ(黙って完了と言わない)", async () => {
    rec.mockRejectedValueOnce(new Error("lock timeout"));
    const res = await call(VALID);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("混み合っています");
  });

  it("同じ token は1時間に5回まで(6回目は 429・記録しない)", async () => {
    for (let i = 0; i < 5; i += 1) expect((await call(VALID, {}, "tok_limit")).status).toBe(200);
    const res = await call(VALID, {}, "tok_limit");
    expect(res.status).toBe(429);
    expect(rec).toHaveBeenCalledTimes(5);
  });

  it("同じ端末IPは1分に10回まで(11回目は 429)", async () => {
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      seq += 1;
      const res = await POST(new Request(`http://localhost:3000/t/tok_ip_${i}/inquiry`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", host: "app.ligarejapan.com", "x-forwarded-for": "10.200.200.200" },
        body: new URLSearchParams(VALID).toString(),
      }) as never, { params: Promise.resolve({ token: `tok_ip_${i}` }) });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
```

`src/lib/__tests__/sale-dm-external-audit-visible.test.ts` の CASES に追加:

```ts
  { action: "sale_dm_inquiry_submit", detail: { first: true, at: "2026-09-20T00:00:00.000Z" } },
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-inquiry-route.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts` → FAIL

- [ ] **Step 3: 実装**

```ts
// src/app/t/[token]/inquiry/route.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";
import { isCrossSiteOrigin } from "@/lib/public-origin";
import { parseInquiryForm, INQUIRY_ERROR_MESSAGES } from "@/lib/sale-dm-letter/inquiry-input";
import { recordInquiry, type InquiryClientLike } from "@/lib/sale-dm-letter/inquiry-record";
import { PUBLIC_PAGE_HEADERS } from "@/lib/sale-dm-letter/unsubscribe-page";
import {
  renderInquiryBusyPage,
  renderInquiryDonePage,
  renderInquiryInvalidPage,
  renderInquiryPreviewPage,
  renderInquiryThrottledPage,
  renderInquiryUnavailablePage,
} from "@/lib/sale-dm-letter/inquiry-page";

/**
 * 公開LPの査定申込の受け口(設計 §2.5)。認証不要(proxy.ts の PUBLIC_PATHS "/t/"・nginx の公開範囲 /t/ の中)。
 *
 * 守り(多層・/u/ と同じ考え方):
 *  1. 端末IPの回数制限(10/分・溢れたら拒否) — 尽力ベース(送信元IPは偽装し得る)。
 *  2. 送信元判定(public-origin.ts) — よそのサイトから踏ませる送信を 403。DB に触らない。
 *  3. honeypot — 機械送信は「受け付けました」を返して何も残さない。
 *  4. 入力検証(inquiry-input.ts) — 不備は 422。入力値は画面に送り返さない。
 *  5. token の回数制限(5/時)と全体の回数制限(120/時) — 検証を通った送信だけが消費する
 *     (でたらめな連投で正規の申込枠を使い切らせない)。
 *  6. 送付済みの宛先だけ記録 — 送付前は 409・未知 token は 404(記録なし)。
 *  7. 監査は draftId と非PII(first/at)のみ。入力文字は出さない。
 */
const ipLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 }, { onOverflow: "deny" });
const tokenLimiter = createRateLimiter({ limit: 5, windowMs: 3_600_000 });
const globalLimiter = createRateLimiter({ limit: 120, windowMs: 3_600_000 });
// 全体上限に達した事実の監査は5分に1回まで(攻撃中に audit_logs を肥大させない)。
const throttleAuditLimiter = createRateLimiter({ limit: 1, windowMs: 300_000 });

function html(body: string, status: number): NextResponse {
  return new NextResponse(body, { status, headers: { ...PUBLIC_PAGE_HEADERS } });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!ipLimiter.hit(`inq-ip:${clientRateKey(req.headers)}`)) {
    return html(renderInquiryThrottledPage(), 429);
  }
  if (isCrossSiteOrigin(req.headers, req.url)) {
    return html(renderInquiryUnavailablePage(), 403);
  }
  const { token } = await params;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return html(renderInquiryUnavailablePage(), 400);
  }
  const get = (key: string): string | null => {
    const v = form.get(key);
    return typeof v === "string" ? v : null;
  };

  const parsed = parseInquiryForm(get);
  if (parsed.kind === "bot") {
    return html(renderInquiryDonePage(), 200);
  }
  if (parsed.kind === "invalid") {
    const messages = parsed.errors.map((e) => INQUIRY_ERROR_MESSAGES[e]);
    return html(renderInquiryInvalidPage(messages, `/t/${encodeURIComponent(token)}#inquiry`), 422);
  }

  if (!tokenLimiter.hit(`inq-token:${token}`)) {
    return html(renderInquiryThrottledPage(), 429);
  }
  if (!globalLimiter.hit("global")) {
    if (throttleAuditLimiter.hit("audit")) {
      await writeAuditLog({
        action: "sale_dm_inquiry_submit",
        targetTable: "dm_recipient_drafts",
        detail: { result: "throttled", at: new Date().toISOString() },
      });
    }
    return html(renderInquiryThrottledPage(), 429);
  }

  let result: Awaited<ReturnType<typeof recordInquiry>>;
  try {
    result = await recordInquiry(prisma as unknown as InquiryClientLike, token, parsed.value);
  } catch {
    return html(renderInquiryBusyPage(), 503);
  }

  if (result.kind === "unknown") return html(renderInquiryUnavailablePage(), 404);
  if (result.kind === "not_sent") return html(renderInquiryPreviewPage(), 409);

  await writeAuditLog({
    action: "sale_dm_inquiry_submit",
    targetTable: "dm_recipient_drafts",
    targetId: result.draftId,
    detail: { first: result.first, at: new Date().toISOString() },
  });
  return html(renderInquiryDonePage(), 200);
}
```

`src/lib/audit-log-detail-safety.ts` の `sale_dm_lp_preview_view: ...` 行の直後:

```ts
  // 公開LPの査定申込(設計 §2.5)。first=この宛先の初回申込か・at=ISO時刻・result=throttled(全体上限)。
  // 入力文字(氏名・電話・メール・要望)は載せない。宛先は targetId(draftId)で辿る。
  sale_dm_inquiry_submit: new Set(["first", "at", "result"]),
```

`src/app/(dashboard)/admin/audit-logs/page.tsx` の `sale_dm_lp_preview_view: "売却DM LP プレビュー表示",` の直後:

```ts
  sale_dm_inquiry_submit: "売却DM 査定申込(公開)",
```

- [ ] **Step 4: 通ることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-inquiry-route.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add "src/app/t/[token]/inquiry/route.ts" src/lib/audit-log-detail-safety.ts "src/app/(dashboard)/admin/audit-logs/page.tsx" src/lib/__tests__/sale-dm-inquiry-route.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts
git commit -m "feat(sale-dm): 査定申込の受け口(送付済みのみ・回数制限・送信元判定・honeypot)"
```

---

### Task 8: 社内の申込一覧 API と対応状況の変更

**Files:**
- Create: `src/lib/sale-dm-letter/inquiry-list.ts`、`src/app/api/properties/sale-dm/campaigns/[id]/inquiries/route.ts`、`src/app/api/properties/sale-dm/inquiries/[inquiryId]/route.ts`
- Modify: `src/lib/audit-log-detail-safety.ts`、`src/app/(dashboard)/admin/audit-logs/page.tsx`、`src/lib/__tests__/sale-dm-external-audit-visible.test.ts`、`src/lib/__tests__/dm-writer-lock-order.test.ts`
- Test: `src/lib/__tests__/sale-dm-inquiry-list.test.ts`、`src/lib/__tests__/sale-dm-inquiry-api-route.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // inquiry-list.ts
  export const HANDLE_STATUSES: readonly ["open", "in_progress", "done"];
  export type HandleStatus = "open" | "in_progress" | "done";
  export interface InquiryListRow { id: string; draftId: string; submittedAt: Date; name: string; phone: string | null; email: string | null; contactPref: string | null; contactTime: string | null; message: string | null; handleStatus: string; handledAt: Date | null; handleNote: string | null; contactHidden: boolean }
  export function toInquiryListRows(rows: Array<Omit<InquiryListRow, "contactHidden" | "phone"> & { phone: string }>, showContact: boolean): InquiryListRow[]; // 未対応→対応中→対応済み、各々新しい順
  // GET /api/properties/sale-dm/campaigns/[id]/inquiries → { inquiries: InquiryListRow[] }
  // PATCH /api/properties/sale-dm/inquiries/[inquiryId] body { handleStatus: HandleStatus; handleNote?: string | null } → { inquiry: { id; handleStatus; handledAt; handleNote } }
  ```
  監査 `sale_dm_inquiry_view`(targetId=campaignId・detail `{ count, viewedAt }`)・`sale_dm_inquiry_status_update`(targetId=inquiryId・detail `{ handleStatus, updatedAt }`)。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-inquiry-list.test.ts
import { describe, it, expect } from "vitest";
import { toInquiryListRows } from "@/lib/sale-dm-letter/inquiry-list";

const row = (id: string, handleStatus: string, iso: string) => ({
  id, draftId: `d-${id}`, submittedAt: new Date(iso), name: `名${id}`, phone: "090-0000-0000", email: "a@b.jp",
  contactPref: "phone", contactTime: "夜", message: "要望", handleStatus, handledAt: null, handleNote: null,
});

describe("toInquiryListRows", () => {
  it("未対応→対応中→対応済み、同じ状態の中は新しい順", () => {
    const out = toInquiryListRows([
      row("a", "done", "2026-09-20T00:00:00Z"),
      row("b", "open", "2026-09-18T00:00:00Z"),
      row("c", "in_progress", "2026-09-21T00:00:00Z"),
      row("d", "open", "2026-09-19T00:00:00Z"),
    ], true);
    expect(out.map((r) => r.id)).toEqual(["d", "b", "c", "a"]);
  });
  it("連絡先を見る権限が無ければ、名前と日時と状態だけ(連絡先系は null・contactHidden=true)", () => {
    const [r] = toInquiryListRows([row("a", "open", "2026-09-20T00:00:00Z")], false);
    expect(r).toMatchObject({ name: "名a", phone: null, email: null, contactPref: null, contactTime: null, message: null, contactHidden: true });
  });
  it("権限があれば全項目・contactHidden=false", () => {
    const [r] = toInquiryListRows([row("a", "open", "2026-09-20T00:00:00Z")], true);
    expect(r).toMatchObject({ phone: "090-0000-0000", email: "a@b.jp", message: "要望", contactHidden: false });
  });
});
```

```ts
// src/lib/__tests__/sale-dm-inquiry-api-route.test.ts
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));

const session = { id: "u1", role: "admin" };
const guard = {
  requireSaleDmAccess: vi.fn(async () => ({ session, permissions: [], ownerDisplayConfig: { phone: "full" } })),
  requireSaleDmWriteAccess: vi.fn(async () => ({ session, permissions: [], ownerDisplayConfig: { phone: "full" } })),
};
vi.mock("@/lib/sale-dm-letter/route-guard", async (orig) => {
  const actual = await orig<typeof import("@/lib/sale-dm-letter/route-guard")>();
  return { ...actual, requireSaleDmAccess: guard.requireSaleDmAccess, requireSaleDmWriteAccess: guard.requireSaleDmWriteAccess };
});
vi.mock("@/lib/dm-export", async (orig) => {
  const actual = await orig<typeof import("@/lib/dm-export")>();
  return { ...actual, isPlainOwnerLevel: (l: string) => l === "full" };
});

const db = {
  dmCampaign: { findUnique: vi.fn() },
  dmInquiry: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
};
vi.mock("@/lib/prisma", () => ({ default: db }));

import { GET } from "@/app/api/properties/sale-dm/campaigns/[id]/inquiries/route";
import { PATCH } from "@/app/api/properties/sale-dm/inquiries/[inquiryId]/route";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";

const INQ = {
  id: "i1", draftId: "d1", submittedAt: new Date("2026-09-20T00:00:00Z"), name: "山田", phone: "090", email: null,
  contactPref: null, contactTime: null, message: null, handleStatus: "open", handledAt: null, handleNote: null,
  draft: { property: { createdBy: "u1", assignedTo: null } },
};

beforeEach(() => { vi.clearAllMocks(); });

describe("GET 申込一覧", () => {
  it("作成者本人のキャンペーンのみ。他人は 404", async () => {
    db.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c1", createdBy: "other" });
    const res = await GET(new Request("http://x/api") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(404);
    expect(db.dmInquiry.findMany).not.toHaveBeenCalled();
  });
  it("返す・監査は件数と時刻のみ", async () => {
    db.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c1", createdBy: "u1" });
    db.dmInquiry.findMany.mockResolvedValueOnce([INQ]);
    const res = await GET(new Request("http://x/api") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inquiries[0]).toMatchObject({ id: "i1", name: "山田", phone: "090", contactHidden: false });
    expect(body.inquiries[0]).not.toHaveProperty("draft");
    const audit = (writeAuditLog as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit).toMatchObject({ action: "sale_dm_inquiry_view", targetId: "c1" });
    expect(Object.keys(audit.detail).sort()).toEqual(["count", "viewedAt"]);
  });
  it("電話の表示権限が無ければ連絡先を伏せる", async () => {
    guard.requireSaleDmAccess.mockResolvedValueOnce({ session, permissions: [], ownerDisplayConfig: { phone: "masked" } });
    db.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c1", createdBy: "u1" });
    db.dmInquiry.findMany.mockResolvedValueOnce([INQ]);
    const body = await (await GET(new Request("http://x/api") as never, { params: Promise.resolve({ id: "c1" }) })).json();
    expect(body.inquiries[0]).toMatchObject({ phone: null, contactHidden: true });
  });
  it("field_staff は担当外の物件の申込を返さない", async () => {
    guard.requireSaleDmAccess.mockResolvedValueOnce({ session: { id: "u1", role: "field_staff" }, permissions: [], ownerDisplayConfig: { phone: "full" } });
    db.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c1", createdBy: "u1" });
    db.dmInquiry.findMany.mockResolvedValueOnce([{ ...INQ, draft: { property: { createdBy: "x", assignedTo: "y" } } }]);
    const body = await (await GET(new Request("http://x/api") as never, { params: Promise.resolve({ id: "c1" }) })).json();
    expect(body.inquiries).toEqual([]);
  });
});

describe("PATCH 対応状況", () => {
  const patch = (b: unknown) => PATCH(new Request("http://x/api", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }) as never, { params: Promise.resolve({ inquiryId: "i1" }) });
  const FOUND = { id: "i1", draft: { propertyId: "p1", campaign: { createdBy: "u1" }, property: { createdBy: "u1", assignedTo: null } } };

  it("列挙外の状態は 422", async () => {
    expect((await patch({ handleStatus: "closed" })).status).toBe(422);
  });
  it("他人のキャンペーンの申込は 404", async () => {
    db.dmInquiry.findUnique.mockResolvedValueOnce({ ...FOUND, draft: { ...FOUND.draft, campaign: { createdBy: "other" } } });
    expect((await patch({ handleStatus: "done" })).status).toBe(404);
  });
  it("親の物件行をロックしてから更新。done は処理者と時刻を入れ、open に戻すと時刻を消す。監査は状態と時刻のみ", async () => {
    db.dmInquiry.findUnique.mockResolvedValueOnce(FOUND);
    db.dmInquiry.update.mockResolvedValueOnce({ id: "i1", handleStatus: "done", handledAt: new Date(), handleNote: "折り返し済み" });
    const res = await patch({ handleStatus: "done", handleNote: "折り返し済み" });
    expect(res.status).toBe(200);
    expect(lockPropertyRow).toHaveBeenCalledWith(db, "p1");
    const data = db.dmInquiry.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ handleStatus: "done", handledById: "u1", handleNote: "折り返し済み" });
    expect(data.handledAt).toBeInstanceOf(Date);
    const audit = (writeAuditLog as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Object.keys(audit.detail).sort()).toEqual(["handleStatus", "updatedAt"]);
    expect(JSON.stringify(audit)).not.toContain("折り返し済み");

    db.dmInquiry.findUnique.mockResolvedValueOnce(FOUND);
    db.dmInquiry.update.mockResolvedValueOnce({ id: "i1", handleStatus: "open", handledAt: null, handleNote: null });
    await patch({ handleStatus: "open" });
    expect(db.dmInquiry.update.mock.calls[1][0].data).toMatchObject({ handleStatus: "open", handledAt: null, handledById: null });
  });
});
```

`src/lib/__tests__/dm-writer-lock-order.test.ts` に追記:

```ts
  it("申込の対応状況変更: 親行ロック→申込 update", () => {
    const tx = firstTx(read("src/app/api/properties/sale-dm/inquiries/[inquiryId]/route.ts"));
    assertOrder("inquiry-status", tx, ["lockPropertyRow", "tx.dmInquiry.update"]);
  });
```

`src/lib/__tests__/sale-dm-external-audit-visible.test.ts` の CASES に追加:

```ts
  { action: "sale_dm_inquiry_view", detail: { count: 3, viewedAt: "2026-09-20T00:00:00.000Z" } },
  { action: "sale_dm_inquiry_status_update", detail: { handleStatus: "done", updatedAt: "2026-09-20T00:00:00.000Z" } },
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-inquiry-list.test.ts src/lib/__tests__/sale-dm-inquiry-api-route.test.ts src/lib/__tests__/dm-writer-lock-order.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts` → FAIL

- [ ] **Step 3: 実装**

```ts
// src/lib/sale-dm-letter/inquiry-list.ts
/** 社内の申込一覧の並べ替えと連絡先の伏せ(純関数)。 */
export const HANDLE_STATUSES = ["open", "in_progress", "done"] as const;
export type HandleStatus = (typeof HANDLE_STATUSES)[number];

export interface InquiryListRow {
  id: string;
  draftId: string;
  submittedAt: Date;
  name: string;
  phone: string | null;
  email: string | null;
  contactPref: string | null;
  contactTime: string | null;
  message: string | null;
  handleStatus: string;
  handledAt: Date | null;
  handleNote: string | null;
  /** 連絡先(電話・メール・希望連絡方法・時間帯・要望)を権限不足で伏せたか */
  contactHidden: boolean;
}

type SourceRow = Omit<InquiryListRow, "contactHidden" | "phone"> & { phone: string };

const ORDER: Record<string, number> = { open: 0, in_progress: 1, done: 2 };

export function toInquiryListRows(rows: SourceRow[], showContact: boolean): InquiryListRow[] {
  return [...rows]
    .sort((a, b) => (ORDER[a.handleStatus] ?? 9) - (ORDER[b.handleStatus] ?? 9) || b.submittedAt.getTime() - a.submittedAt.getTime())
    .map((r) => (showContact
      ? { ...r, contactHidden: false }
      : { ...r, phone: null, email: null, contactPref: null, contactTime: null, message: null, contactHidden: true }));
}
```

```ts
// src/app/api/properties/sale-dm/campaigns/[id]/inquiries/route.ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import { toInquiryListRows } from "@/lib/sale-dm-letter/inquiry-list";

// 社内の申込一覧(設計 §2.5・§2.7)。作成者本人のキャンペーンのみ・field_staff は担当範囲のみ。
// 連絡先(電話・メール・要望など)は所有者の電話を平文で見られる利用者にだけ返す。
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session, ownerDisplayConfig } = await requireSaleDmAccess();
    const { id } = await params;
    const campaign = await prisma.dmCampaign.findUnique({ where: { id }, select: { id: true, createdBy: true } });
    if (!campaign || campaign.createdBy !== session.id) {
      return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const rows = await prisma.dmInquiry.findMany({
      where: { draft: { campaignId: id } },
      orderBy: { submittedAt: "desc" },
      select: {
        id: true, draftId: true, submittedAt: true, name: true, phone: true, email: true,
        contactPref: true, contactTime: true, message: true, handleStatus: true, handledAt: true, handleNote: true,
        draft: { select: { property: { select: { createdBy: true, assignedTo: true } } } },
      },
    });
    const visible = filterDraftsByFieldStaffScope(rows.map((r) => ({ ...r, property: r.draft.property })), session)
      .map(({ draft: _draft, property: _property, ...rest }) => rest);
    const inquiries = toInquiryListRows(visible, isPlainOwnerLevel(ownerDisplayConfig.phone));
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_inquiry_view",
      targetTable: "dm_campaigns",
      targetId: id,
      detail: { count: inquiries.length, viewedAt: new Date().toISOString() },
    });
    return NextResponse.json({ inquiries }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

```ts
// src/app/api/properties/sale-dm/inquiries/[inquiryId]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { requireSaleDmWriteAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { HANDLE_STATUSES } from "@/lib/sale-dm-letter/inquiry-list";

const bodySchema = z.object({
  handleStatus: z.enum(HANDLE_STATUSES),
  handleNote: z.string().trim().max(500).nullable().optional(),
});

// 申込の対応状況の変更(設計 §2.5)。書き込み権限+作成者本人のキャンペーン+field_staff の担当範囲。
// 物件配下の書き込みなので親の物件行をロックしてから更新する(R50)。
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ inquiryId: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { inquiryId } = await params;
    const body = bodySchema.parse(await parseJsonBody(request));

    const found = await prisma.dmInquiry.findUnique({
      where: { id: inquiryId },
      select: {
        id: true,
        draft: { select: { propertyId: true, campaign: { select: { createdBy: true } }, property: { select: { createdBy: true, assignedTo: true } } } },
      },
    });
    if (
      !found ||
      found.draft.campaign.createdBy !== session.id ||
      filterDraftsByFieldStaffScope([{ property: found.draft.property }], session).length === 0
    ) {
      throw new ApiError(404, "申込が見つかりません", "NOT_FOUND");
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      await lockPropertyRow(tx, found.draft.propertyId);
      return tx.dmInquiry.update({
        where: { id: inquiryId },
        data: {
          handleStatus: body.handleStatus,
          handledById: body.handleStatus === "open" ? null : session.id,
          handledAt: body.handleStatus === "open" ? null : now,
          ...(body.handleNote !== undefined ? { handleNote: body.handleNote && body.handleNote.length > 0 ? body.handleNote : null } : {}),
        },
        select: { id: true, handleStatus: true, handledAt: true, handleNote: true },
      });
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_inquiry_status_update",
      targetTable: "dm_inquiries",
      targetId: inquiryId,
      detail: { handleStatus: body.handleStatus, updatedAt: now.toISOString() },
    });
    return NextResponse.json({ inquiry: updated }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

(`handleApiError` が `ZodError` を 422 にすることを前提にしている=既存規約。違う場合はテストの期待値ではなく route 側で `safeParse` して `ApiError(422, ..., "VALIDATION_ERROR")` を投げる。)

`src/lib/audit-log-detail-safety.ts` に追加(Task 7 で足した行の直後):

```ts
  // 社内の申込一覧の閲覧(PII アクセスの痕跡)。count=表示件数・viewedAt=ISO時刻。対象キャンペーンは targetId。
  sale_dm_inquiry_view: new Set(["count", "viewedAt"]),
  // 申込の対応状況の変更。handleStatus=列挙値・updatedAt=ISO時刻(メモ本文は載せない)。
  sale_dm_inquiry_status_update: new Set(["handleStatus", "updatedAt"]),
```

`src/app/(dashboard)/admin/audit-logs/page.tsx` に追加:

```ts
  sale_dm_inquiry_view: "売却DM 申込一覧の閲覧",
  sale_dm_inquiry_status_update: "売却DM 申込の対応状況変更",
```

- [ ] **Step 4: 通ることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-inquiry-list.test.ts src/lib/__tests__/sale-dm-inquiry-api-route.test.ts src/lib/__tests__/dm-writer-lock-order.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/inquiry-list.ts "src/app/api/properties/sale-dm/campaigns/[id]/inquiries/route.ts" "src/app/api/properties/sale-dm/inquiries/[inquiryId]/route.ts" src/lib/audit-log-detail-safety.ts "src/app/(dashboard)/admin/audit-logs/page.tsx" src/lib/__tests__/sale-dm-inquiry-list.test.ts src/lib/__tests__/sale-dm-inquiry-api-route.test.ts src/lib/__tests__/dm-writer-lock-order.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts
git commit -m "feat(sale-dm): 社内の申込一覧と対応状況の変更(権限・担当範囲・監査)"
```

---

### Task 9: 社内画面(申込一覧パネル・宛先バッジ)

**Files:**
- Modify: `src/lib/api-client.ts`、`src/app/api/properties/sale-dm/campaigns/[id]/route.ts`、`src/components/sale-dm/recipient-list.tsx`、`src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx`
- Create: `src/components/sale-dm/inquiry-list.tsx`
- Test: `src/lib/__tests__/sale-dm-inquiry-ui-scan.test.ts`

**Interfaces:**
- Consumes: Task 8 の API。
- Produces:
  ```ts
  // api-client.ts
  export interface SaleDmInquiry { id: string; draftId: string; submittedAt: string; name: string; phone: string | null; email: string | null; contactPref: string | null; contactTime: string | null; message: string | null; handleStatus: "open" | "in_progress" | "done"; handledAt: string | null; handleNote: string | null; contactHidden: boolean }
  export async function fetchSaleDmInquiries(campaignId: string): Promise<{ inquiries: SaleDmInquiry[] }>;
  export async function updateSaleDmInquiryStatus(inquiryId: string, body: { handleStatus: SaleDmInquiry["handleStatus"]; handleNote?: string | null }): Promise<{ inquiry: Pick<SaleDmInquiry, "id" | "handleStatus" | "handledAt" | "handleNote"> }>;
  // SaleDmDraft に formInquiryCount: number / formInquiryFirstAt: string | null
  ```

- [ ] **Step 1: テスト(走査型)**

```ts
// src/lib/__tests__/sale-dm-inquiry-ui-scan.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("申込の社内画面", () => {
  const panel = read("src/components/sale-dm/inquiry-list.tsx");
  it("申込者の個人情報を画面保護(S1b)の対象にする", () => {
    expect(panel).toContain("data-pii-protected");
    expect(panel).toContain('data-pii-surface="owner"');
  });
  it("状態は3つだけ・日本語ラベル", () => {
    for (const s of ['"open"', '"in_progress"', '"done"', "未対応", "対応中", "対応済み"]) expect(panel).toContain(s);
  });
  it("権限で伏せたときの案内がある", () => {
    expect(panel).toContain("contactHidden");
    expect(panel).toMatch(/表示する権限がありません/);
  });
  it("走査規約: bg-blue-600・手書きモーダルを使わない", () => {
    expect(panel).not.toContain("bg-blue-600");
    expect(panel).not.toContain("fixed inset-0");
  });
  it("キャンペーン画面に配置され、宛先一覧に申込バッジがある", () => {
    expect(read("src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx")).toContain("<SaleDmInquiryList");
    expect(read("src/components/sale-dm/recipient-list.tsx")).toMatch(/formInquiryCount/);
  });
  it("キャンペーン API は宛先の申込計数を返す(token は返さない)", () => {
    const route = read("src/app/api/properties/sale-dm/campaigns/[id]/route.ts");
    expect(route).toContain("formInquiryCount: r.formInquiryCount");
    expect(route).toContain("formInquiryFirstAt: r.formInquiryFirstAt");
    expect(route).not.toMatch(/trackingToken:\s*r\./);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-inquiry-ui-scan.test.ts` → FAIL

- [ ] **Step 3: 実装**

`src/app/api/properties/sale-dm/campaigns/[id]/route.ts` の `recipients` の map で `phoneTapFirstAt: r.phoneTapFirstAt,` の直後:

```ts
      // 公開LPの査定申込(§2.5)。宛先のバッジと LP型表の申込列が画面側で使う。中身は申込一覧 API から取る。
      formInquiryCount: r.formInquiryCount,
      formInquiryFirstAt: r.formInquiryFirstAt,
```

`src/lib/api-client.ts`:
- `SaleDmDraft` の `phoneTapFirstAt: string | null;` の直後に:
  ```ts
  // 公開LPの査定申込の回数と初回時刻(中身は fetchSaleDmInquiries)。
  formInquiryCount: number;
  formInquiryFirstAt: string | null;
  ```
- `updateSaleDmOutcome` の直後に:
  ```ts
  export interface SaleDmInquiry {
    id: string;
    draftId: string;
    submittedAt: string;
    name: string;
    phone: string | null;
    email: string | null;
    contactPref: string | null;
    contactTime: string | null;
    message: string | null;
    handleStatus: "open" | "in_progress" | "done";
    handledAt: string | null;
    handleNote: string | null;
    contactHidden: boolean;
  }

  export async function fetchSaleDmInquiries(campaignId: string) {
    if (USE_MOCK) {
      await mockDelay();
      return { inquiries: [] as SaleDmInquiry[] };
    }
    return apiFetch<{ inquiries: SaleDmInquiry[] }>(`/api/properties/sale-dm/campaigns/${campaignId}/inquiries`);
  }

  export async function updateSaleDmInquiryStatus(
    inquiryId: string,
    body: { handleStatus: SaleDmInquiry["handleStatus"]; handleNote?: string | null },
  ) {
    if (USE_MOCK) {
      await mockDelay();
      return { inquiry: { id: inquiryId, handleStatus: body.handleStatus, handledAt: null, handleNote: body.handleNote ?? null } };
    }
    return apiFetch<{ inquiry: Pick<SaleDmInquiry, "id" | "handleStatus" | "handledAt" | "handleNote"> }>(
      `/api/properties/sale-dm/inquiries/${inquiryId}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
  }
  ```
- `fetchSaleDmCampaign` の USE_MOCK 分岐の recipients は空配列なので変更不要。`SaleDmDraft` を作るモック/テスト(`grep -rn "phoneTapFirstAt: null" src --include=*.ts --include=*.tsx`)があれば `formInquiryCount: 0, formInquiryFirstAt: null` を足す。

```tsx
// src/components/sale-dm/inquiry-list.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Inbox } from "lucide-react";
import { fetchSaleDmInquiries, updateSaleDmInquiryStatus, type SaleDmCampaign, type SaleDmInquiry } from "@/lib/api-client";

const STATUS_OPTIONS: Array<{ value: SaleDmInquiry["handleStatus"]; label: string }> = [
  { value: "open", label: "未対応" },
  { value: "in_progress", label: "対応中" },
  { value: "done", label: "対応済み" },
];
const PREF_LABEL: Record<string, string> = { phone: "電話", email: "メール", either: "どちらでも" };

function formatJst(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** キャンペーン画面の「査定申込」一覧(設計 §2.5)。未対応が上。対応状況はその場で変更できる。 */
export default function SaleDmInquiryList({ campaign, reloadKey }: { campaign: SaleDmCampaign; reloadKey: number }) {
  const [items, setItems] = useState<SaleDmInquiry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchSaleDmInquiries(campaign.id);
      setItems(res.inquiries);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "申込を読み込めませんでした");
    }
  }, [campaign.id]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const recipientName = (draftId: string) => {
    const r = campaign.recipients.find((x) => x.id === draftId);
    return r ? `${r.recipientName} ${r.honorific}` : "(表示範囲外の宛先)";
  };

  const changeStatus = async (id: string, handleStatus: SaleDmInquiry["handleStatus"]) => {
    setBusyId(id);
    try {
      await updateSaleDmInquiryStatus(id, { handleStatus });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "対応状況を変更できませんでした");
    } finally {
      setBusyId(null);
    }
  };

  const openCount = items?.filter((i) => i.handleStatus === "open").length ?? 0;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-3 flex items-center gap-2">
        <Inbox className="h-4 w-4 text-gray-500" />
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">査定申込</h2>
        {items && <span className="text-xs text-gray-500">{items.length}件{openCount > 0 ? `(未対応 ${openCount}件)` : ""}</span>}
      </div>
      {error && <p className="mb-2 text-xs text-red-600" role="alert">{error}</p>}
      {items === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-sm text-gray-500">申込はまだありません</p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-pii-protected data-pii-surface="owner">
          {items.map((i) => (
            <li key={i.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-gray-500">{formatJst(i.submittedAt)}</span>
                <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{i.name}</span>
                <span className="text-xs text-gray-500">宛先: {recipientName(i.draftId)}</span>
                <select
                  value={i.handleStatus}
                  disabled={busyId === i.id}
                  onChange={(e) => void changeStatus(i.id, e.target.value as SaleDmInquiry["handleStatus"])}
                  className="ml-auto rounded-md border border-gray-300 px-1.5 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
                  aria-label="対応状況"
                >
                  {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              {i.contactHidden ? (
                <p className="mt-1 text-xs text-gray-500">連絡先を表示する権限がありません</p>
              ) : (
                <dl className="mt-1 grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 text-xs text-gray-700 dark:text-gray-300">
                  <dt className="text-gray-500">電話</dt><dd>{i.phone}</dd>
                  {i.email && (<><dt className="text-gray-500">メール</dt><dd className="break-all">{i.email}</dd></>)}
                  {i.contactPref && (<><dt className="text-gray-500">希望の連絡方法</dt><dd>{PREF_LABEL[i.contactPref] ?? i.contactPref}</dd></>)}
                  {i.contactTime && (<><dt className="text-gray-500">時間帯</dt><dd>{i.contactTime}</dd></>)}
                  {i.message && (<><dt className="text-gray-500">要望</dt><dd className="whitespace-pre-wrap">{i.message}</dd></>)}
                </dl>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`src/components/sale-dm/recipient-list.tsx` の「反響あり」バッジの直後:

```tsx
                {r.formInquiryCount > 0 && (
                  <span className="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                    申込 {r.formInquiryCount}
                  </span>
                )}
```

`src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx`:
- import 追加: `import SaleDmInquiryList from "@/components/sale-dm/inquiry-list";`
- 再読込の合図: 既存の `load`(キャンペーン再取得)を呼ぶたびに増える数を持つ。`const [reloadKey, setReloadKey] = useState(0);` を state 群に足し、`load` 関数の取得成功直後で `setReloadKey((k) => k + 1);` する(`load` の本体で `setCampaign(...)` している行の直後)。
- `<SaleDmAggregateView campaign={campaign} lpMetricsEnabled={lpMetricsEnabled} />` の直後に:
  ```tsx
      <SaleDmInquiryList campaign={campaign} reloadKey={reloadKey} />
  ```

- [ ] **Step 4: 通ることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-inquiry-ui-scan.test.ts && npx tsc --noEmit && npx eslint src/components/sale-dm/inquiry-list.tsx src/components/sale-dm/recipient-list.tsx "src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx"` → PASS / 0

- [ ] **Step 5: Commit**

```bash
git add src/lib/api-client.ts "src/app/api/properties/sale-dm/campaigns/[id]/route.ts" src/components/sale-dm/inquiry-list.tsx src/components/sale-dm/recipient-list.tsx "src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx" src/lib/__tests__/sale-dm-inquiry-ui-scan.test.ts
git commit -m "feat(sale-dm): キャンペーン画面に査定申込の一覧と宛先の申込バッジ"
```

---

### Task 10: LP型表に「申込」と、同意文の管理者設定

**Files:**
- Modify: `src/lib/sale-dm-letter/aggregate.ts`、`src/lib/sale-dm-letter/aggregate-view-model.ts`、`src/components/sale-dm/aggregate-view.tsx`、`src/app/api/properties/sale-dm/campaigns/[id]/aggregate/route.ts`、`src/app/api/admin/sale-dm-settings/route.ts`、`src/app/(dashboard)/admin/sale-dm-settings/page.tsx`、`src/lib/api-client.ts`(`SaleDmSettings`)
- Test: `src/lib/__tests__/sale-dm-aggregate-two-axis.test.ts`(追記・既存の期待オブジェクトに新キーを足す)、`src/lib/__tests__/sale-dm-settings-privacy.test.ts`(新規)

**Interfaces:**
- Produces: `TwoAxisDraftInput.formInquiryFirstAt: Date | null`・`LpVariantAggregate.inquired: number`・`inquiryRate: number | null`(= inquired / viewed・閲覧0は null)・`LpVariantRow.inquiryLabel: string`・`SaleDmSettings.privacyText: string | null`。

- [ ] **Step 1: テスト**

`src/lib/__tests__/sale-dm-aggregate-two-axis.test.ts`: 冒頭の helper `d(variantId, lpVariantId, deliveryStatus, viewed, phoneTap = false, pageViewed = viewed)` に第7引数 `inquired = false` を足し、戻り値に `formInquiryFirstAt: inquired ? new Date() : null,` を足す。`byLpVariant` の要素を `toEqual` で丸ごと比べている既存 assert には `inquired`/`inquiryRate` を足す(その宛先群に申込は無いので `inquired: 0`・`inquiryRate` は閲覧あり→`0`/閲覧0→`null`)。末尾に追記:

```ts
it("LP型ごとの申込: 分子=申込あり・分母=アプリ内ページの閲覧", () => {
  const r = aggregateTwoAxis([
    d("A", "L1", "delivered", true, false, true, true),
    d("A", "L1", "delivered", true, false, true, false),
    d("A", "L1", "delivered", false),
  ]);
  const lp = r.byLpVariant.find((v) => v.lpVariantId === "L1")!;
  expect(lp.inquired).toBe(1);
  expect(lp.inquiryRate).toBeCloseTo(0.5);
});

it("閲覧0なら申込率は null", () => {
  const lp = aggregateTwoAxis([d("A", "L2", "delivered", false)]).byLpVariant[0];
  expect(lp.inquired).toBe(0);
  expect(lp.inquiryRate).toBeNull();
});
```

```ts
// src/lib/__tests__/sale-dm-settings-privacy.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("同意文の管理者設定", () => {
  const route = read("src/app/api/admin/sale-dm-settings/route.ts");
  const page = read("src/app/(dashboard)/admin/sale-dm-settings/page.tsx");
  it("API は privacyText を 2000字まで受け、返す。監査は項目名のみ", () => {
    expect(route).toMatch(/privacyText:\s*z\.string\(\)\.trim\(\)\.max\(2000\)\.optional\(\)/);
    expect(route).toContain("privacyText: row?.privacyText ?? null");
    expect(route).toContain('changed.push("privacyText")');
  });
  it("画面に入力欄があり、空ならひな形が使われる旨を出す", () => {
    expect(page).toContain("個人情報の取扱い文");
    expect(page).toContain("<textarea");
    expect(page).toContain("DEFAULT_PRIVACY_TEXT");
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate-two-axis.test.ts src/lib/__tests__/sale-dm-settings-privacy.test.ts` → FAIL

- [ ] **Step 3: 実装**

`src/lib/sale-dm-letter/aggregate.ts`:
- `TwoAxisDraftInput` の `phoneTapFirstAt: Date | null;` の直後に `formInquiryFirstAt: Date | null;`
- `ViewBucket` に `inquired: number` を足し、初期値 `{ sent: 0, delivered: 0, viewed: 0, deliveredViewed: 0, phoneTapped: 0, inquired: 0 }`。
- 加算の `if (draft.phoneTapFirstAt != null) b.phoneTapped += 1;` の直後に `if (draft.formInquiryFirstAt != null) b.inquired += 1;`
- `LpVariantAggregate` に `inquired: number; inquiryRate: number | null` を足す(コメント: `// inquired: 査定申込あり(formInquiryFirstAt != null)。inquiryRate: inquired / viewed(閲覧0は null)。LP型の成績=申込率(設計 §0-5)。`)。
- `byLpVariant` の map の戻り値に `inquired: b.inquired, inquiryRate: rate(b.inquired, b.viewed)` を足す。

`src/app/api/properties/sale-dm/campaigns/[id]/aggregate/route.ts` の宛先 select の `phoneTapFirstAt: true,` の直後に `formInquiryFirstAt: true,`。

`src/lib/sale-dm-letter/aggregate-view-model.ts`:
- 宛先→入力の変換(`phoneTapFirstAt: r.phoneTapFirstAt ? new Date(r.phoneTapFirstAt) : null,` の行)の直後に `formInquiryFirstAt: r.formInquiryFirstAt ? new Date(r.formInquiryFirstAt) : null,`
- `LpVariantRow` に `inquired: number; inquiryLabel: string` を足す。
- `buildLpVariantRows` の戻り値に `inquired: v.inquired, inquiryLabel: formatPhoneTapLabel(v.inquired, v.viewed, v.inquiryRate),`(書式は電話タップと同じ「件数 / 閲覧 (率%)」なので同じ関数を使う。関数名が用途を表さなくなるので `formatPhoneTapLabel` を `formatPerViewLabel` に改名し、2か所の呼び出しを直す)。

`src/components/sale-dm/aggregate-view.tsx` の LP型表:

```tsx
            head={["LP型", "送付", "到達", "閲覧", "閲覧率", "電話タップ", "申込"]}
            rows={lpRows.map((r) => ({ key: r.lpVariantId, cells: [r.label, r.sent, r.delivered, r.viewed, r.viewRate, r.phoneTapLabel, r.inquiryLabel], strong: [6] }))}
```

(LP型の成績は申込率=強調を「申込」列へ移す。)

`src/app/api/admin/sale-dm-settings/route.ts`:
- `putSchema` に `privacyText: z.string().trim().max(2000).optional(),`
- GET と PUT 応答の `data` に `privacyText: row?.privacyText ?? null,`(PUT 側は `row.privacyText`)
- PUT の非秘匿項目の反映に `if (body.privacyText !== undefined) { data.privacyText = norm(body.privacyText) ?? null; changed.push("privacyText"); }`

`src/lib/api-client.ts` の `SaleDmSettings` に `privacyText: string | null;`、PUT の body 型(`saveSaleDmSettings` の引数型)に `privacyText?: string;`。

`src/app/(dashboard)/admin/sale-dm-settings/page.tsx`:
- import: `import { DEFAULT_PRIVACY_TEXT } from "@/lib/sale-dm-letter/privacy-text";`
- state: `const [privacyText, setPrivacyText] = useState("");`、読込時 `setPrivacyText(data.privacyText ?? "");`、保存 payload に `privacyText,`。
- 「差出人連絡先」の `Field` の直後に:
  ```tsx
        <Field label="個人情報の取扱い文(公開LPの申込フォームに表示)">
          <textarea value={privacyText} onChange={(e) => setPrivacyText(e.target.value)} placeholder={DEFAULT_PRIVACY_TEXT} maxLength={2000} rows={5} className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
          <span className="mt-1 block text-xs text-gray-500">空欄のときは、薄く表示している見本の文章をそのまま使います。</span>
        </Field>
  ```

- [ ] **Step 4: 通ることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate-two-axis.test.ts src/lib/__tests__/sale-dm-settings-privacy.test.ts src/lib/__tests__/sale-dm-aggregate-route-lp-metrics.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/aggregate.ts src/lib/sale-dm-letter/aggregate-view-model.ts src/components/sale-dm/aggregate-view.tsx "src/app/api/properties/sale-dm/campaigns/[id]/aggregate/route.ts" src/app/api/admin/sale-dm-settings/route.ts "src/app/(dashboard)/admin/sale-dm-settings/page.tsx" src/lib/api-client.ts src/lib/__tests__/sale-dm-aggregate-two-axis.test.ts src/lib/__tests__/sale-dm-settings-privacy.test.ts
git commit -m "feat(sale-dm): LP型表に申込率・同意文の管理者設定"
```

---

### Task 11: 文書・全ゲート・実ブラウザ確認

**Files:**
- Modify: `public/docs/guide.html`、`public/docs/manual.html`、`docs/deploy.md`

- [ ] **Step 1: 文書**

`public/docs/guide.html` と `public/docs/manual.html` の売却DM(公開LP)の節に、次を平易な日本語で追記(既存の見出しと段落の書式に合わせる):
- お手紙のQRから開くページの下に「無料査定のお申し込み」フォームがあること(お名前・電話は必須、同意が必要)。
- 送付前(確定・印刷のみで「送付済み」にしていない宛先)はフォームが押せないこと。
- 申込はキャンペーン画面の「査定申込」に届き、未対応が上に並ぶこと。対応状況(未対応/対応中/対応済み)を変えられること。
- 連絡先は、所有者の電話を見られる権限がある人にだけ表示されること。
- 同意文は「売却DM設定」の「個人情報の取扱い文」で変えられること(空欄なら見本の文)。
- メールでのお知らせは次の段階で追加予定(今はアプリで確認)。

`docs/deploy.md`:
- 公開LP の節の「追跡ホストは既にこのアプリへ着地」の誤記を、「公開LPのホストは `app.ligarejapan.com`(nginx の server ブロックで `/t/` `/u/` `/lp-assets/` だけを公開し、それ以外は 404。443 は公開アドレス限定で listen=tailscaled が 443 を保持しているため)」に直す。
- 「公開の書き込み口(配信停止・電話タップ・査定申込)の送信元判定は Host ヘッダ基準。nginx は `proxy_set_header Host $host;` を必ず渡す(外すと自分自身の送信を拒否する)」を追記。
- 本PRの migration `20260916100000_add_dm_inquiries`(additive・`dm_inquiries` の外部キーは RESTRICT)を反映手順の migration 一覧に追記。

- [ ] **Step 2: 全ゲート**

Run:
```bash
npx tsc --noEmit
npx vitest run
npx eslint src/lib/public-origin.ts src/lib/sale-dm-letter/inquiry-input.ts src/lib/sale-dm-letter/inquiry-record.ts src/lib/sale-dm-letter/inquiry-page.ts src/lib/sale-dm-letter/inquiry-list.ts src/lib/sale-dm-letter/privacy-text.ts src/lib/sale-dm-letter/lp-page.ts src/lib/sale-dm-letter/lp-render-input.ts src/lib/sale-dm-letter/lp-page-loader.ts src/lib/sale-dm-letter/config-store.ts src/lib/sale-dm-letter/unsubscribe-page.ts src/lib/sale-dm-letter/aggregate.ts src/lib/sale-dm-letter/aggregate-view-model.ts "src/app/t/[token]/inquiry/route.ts" "src/app/t/[token]/phone-tap/route.ts" "src/app/u/[token]/route.ts" "src/app/api/properties/sale-dm/campaigns/[id]/inquiries/route.ts" "src/app/api/properties/sale-dm/inquiries/[inquiryId]/route.ts" "src/app/api/properties/sale-dm/campaigns/[id]/route.ts" "src/app/api/properties/sale-dm/campaigns/[id]/aggregate/route.ts" "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/preview/route.ts" src/app/api/admin/sale-dm-settings/route.ts src/components/sale-dm/inquiry-list.tsx src/components/sale-dm/recipient-list.tsx src/components/sale-dm/aggregate-view.tsx "src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx" "src/app/(dashboard)/admin/sale-dm-settings/page.tsx" "src/app/(dashboard)/admin/audit-logs/page.tsx" src/lib/audit-log-detail-safety.ts src/lib/api-client.ts
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build
git diff --stat origin/main   # "Bin" 表示が無いこと(制御文字の混入なし)
```
Expected: tsc 0 / vitest 全緑 / eslint 0 / build 成功 / `Bin` なし

- [ ] **Step 3: 実ブラウザ確認(ローカル・必須)**

`npx next dev -p <port>`(turbopack)+ローカルDBで、送付済みにした宛先1件の `/t/<token>` を Playwright(Chromium)で開き、**画面操作で**次を確かめる(API 直叩きで代用しない。確認の結論は「DB の値が変わった」まで):
1. フォームに入力して送信 → 「受け付けました」ページ → `dm_inquiries` に1行・宛先の `form_inquiry_count=1`・`outcome=inquiry`。
2. 同じページで電話ボタンを押す → `phone_tap_count` が増える(Task 1 の修正の確認)。
3. 配信停止ページのボタンを押す → 「受け付けました」(Task 1 の修正の確認)。
4. 送付前の宛先の `/t/<token>` ではフォームが押せない。
5. キャンペーン画面の「査定申込」に1件出て、対応状況を「対応済み」にできる。宛先に「申込 1」バッジ。LP型表の「申込」列が 1。
6. スマホ幅(390px)とPC幅(1000px)でフォームが崩れない(スクリーンショット2枚)。

- [ ] **Step 4: Commit**

```bash
git add public/docs/guide.html public/docs/manual.html docs/deploy.md
git commit -m "docs(sale-dm): 査定申込フォームの使い方と公開ホスト・送信元判定の運用メモ"
```
