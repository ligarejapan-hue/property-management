# 売却DM LP型「申込のメール通知」(第1段 PR5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 公開LPから査定申込が届いたら、通知をONにした社内の利用者へ **info@ligarejapan.com(Xserver SMTP)からメールで知らせる**。あわせて発注者判断(2026-09-18)どおり、**申込を「売却DMを使える人全員」が見て対応できる**ようにする(キャンペーン横断の「査定の申込」画面)。

**Architecture:** 送信は `nodemailer` を薄く包んだ `src/lib/mail/transport.ts`(テスト用に差し替え口)。送信設定は singleton `MailConfig`(パスワードは既存 `encryptSecret` で暗号化・書き込み専用)。通知本体 `notifyInquiry(inquiryId, attempt)` は **申込の記録(tx)が終わった後に**受け口 route から投げっぱなしで起動し、`dm_inquiries.notify_status` を `pending→sending→sent|failed` と原子的に取り合う(二重送信防止)。宛先は「通知ON+有効+売却DMを使える+(field_staff なら物件の担当範囲)」の利用者。本文は純関数 `buildInquiryNotifyMail` が組み、**受け手ごとに**電話・メールの表示権限が揃っている人にだけ詳しい内容(full)を出す。失敗は同じプロセス内で 30秒→2分→10分に再試行、全滅で `failed`+画面から「再送」。

**Tech Stack:** Next.js 16 App Router route handlers, Prisma 7(`@/generated/prisma`), zod v4, vitest(`src/lib/__tests__/`・env=node), React client components(Tailwind・lucide-react)。**新規 npm 依存=`nodemailer` と `@types/nodemailer`(devDependencies)だけ(発注者承認済 2026-09-18)。**

**Spec:** `docs/superpowers/specs/2026-09-08-sale-dm-lp-autobuild-design.md` §2.6(メール通知)・§2.7(権限・安全・監査)・§2.9(データ変更)。前段の計画=`docs/superpowers/plans/2026-09-16-sale-dm-lp-inquiry.md`(PR4・申込フォーム)。

## Global Constraints

- **依存**: `npm install nodemailer` と `npm install -D @types/nodemailer` だけ。ほかの依存を足さない。`package-lock.json` を必ず commit。
- **秘密の扱い**: SMTP パスワードは `encryptSecret`(`src/lib/sale-dm-letter/secret-crypto.ts`・env `SALE_DM_SETTINGS_ENC_KEY` 共用)で保存し、**API は値を返さない**(`hasPassword: boolean` だけ)。パスワード・宛先アドレス・申込者の入力値を**ログ・監査・例外メッセージ・`notify_last_error` に出さない**。`notify_last_error` は定型コード(`no_recipients` / `mail_not_configured` / `send_failed` / `partial`)だけ。
- **ログの許可リスト**: 送信失敗を `console.error` に出すときは `{ name, code }` だけ(`code` は `/^[A-Z][A-Z0-9_]{1,40}$/` に合うときだけ・それ以外 null)。nodemailer のエラー message は SMTP 応答や宛先を含み得るので出さない。
- **メールを失敗させても申込は消えない・申込者への応答は変わらない**: 受け口 route は通知の成否を待たない(`void` で起動・関数は決して throw しない)。
- **1通ずつ・受け手ごとに1通**(To は1アドレス・CC/BCC 不使用)。件名・本文はプレーンテキスト(HTML メールにしない)。件名から CR/LF を除く。
- **受け手ごとの内容**: `full` は MailConfig が `full` **かつ** その受け手の `getOwnerDisplayConfig` で phone と email が両方 plain のときだけ。それ以外は `minimal`。お名前は PR4 と同じ規則(`NAME_CONTACT_LIKE_RE` に当たり、受け手が両方 plain でなければ `HIDDEN_NAME_PLACEHOLDER`)。
- **監査**: `mail_settings_update`(detail=`{ fields: string[] }` 項目名のみ)・`mail_settings_test`(detail=`{ result: "sent"|"failed" }`)・`inquiry_notify_sent`(targetId=inquiryId・detail=`{ attempt, recipientUserIds }`)・`inquiry_notify_failed`(detail=`{ attempt, code }`)。すべて `src/lib/audit-log-detail-safety.ts` の許可リストに追加し、`sale_dm_inquiry_view` を登録している箇所(`grep -rn "sale_dm_inquiry_view" src`)すべてに同じく足す。
- **閲覧範囲(発注者判断 2026-09-18)**: 申込の閲覧・対応状況の変更・再送は **`requireSaleDmAccess`(変更は `requireSaleDmWriteAccess`)を満たす利用者全員**。キャンペーン作成者の縛りは申込については外す。field_staff は物件の担当範囲(作成 or 担当)だけ。電話・メール・自由記述の伏せは PR4 のまま(`toInquiryListRows`)。**キャンペーン画面そのもの(作成者のみ)は変えない。**
- **ロック順序**: 対応状況の変更は PR4 のまま「親の物件行→子」。通知は物件配下を書き換えないので物件ロックを取らない(`dm_inquiries` の notify 列だけを条件付き `updateMany` で更新)。
- **走査テストの縛り**: `src/` に `saleDmLetter` を書かない; Tailwind `bg-blue-600` 禁止・`fixed inset-0` モーダル/`border-b-2` タブ手書き禁止(`ModalShell`/`ConfirmDialog`); dashboard page に生 `<h1` 禁止; `crypto.randomUUID` 禁止(`@/lib/random-id`)。サイドバーの項目を足したら `src/components/layout/__tests__/sidebar-reorg.test.ts` の期待も更新。
- **テストは env の有無に依存させない**(CI は `NEXTAUTH_SECRET` 等を設定済み)。`SALE_DM_SETTINGS_ENC_KEY` を使うテストは退避→設定→検証→復元。
- **タイマー**: 再試行の `setTimeout` は `.unref()` を呼ぶ。テストは `vi.useFakeTimers()`。
- 各ファイルの改行は既存に合わせる(CRLF 混在禁止)・NUL 等の制御文字禁止(書いたら `python -c "d=open(r'<file>','rb').read();print(sum(1 for b in d if (b<32 and b not in (9,10,13)) or b==127))"` が 0)・`git add` は列挙・commit 末尾に次の2行:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01GfXgLxCNNbT1KsYRPXDnr8`
- 「緑」の前に `npx vitest run`(フル)+`npx tsc --noEmit`+`npx eslint <変更ファイル>`+`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`。
- 専用 worktree `property-management-worktrees/sale-dm-lp-inquiry-notify`(branch `feat/sale-dm-lp-inquiry-notify`・base = PR4 マージ後の `origin/main`)。**実機確認で本物の SMTP に接続しない**(テスト送信はローカルでは `mock` 差し替え or 未設定エラーの確認まで)。

### 設計書からの読み替え(controller ruling・計画で確定)

1. **閲覧範囲の拡大(発注者判断)に合わせて、キャンペーン横断の「査定の申込」画面を新設する**(`/properties/sale-dm/inquiries`・サイドバー「DM」グループ・`minRole: "office_staff"`)。通知メールの「アプリで開く」リンクはここ(`?focus=<inquiryId>`)を指す。キャンペーンを作っていない人はキャンペーン画面を開けないため、キャンペーン画面の一覧だけでは範囲拡大が意味を持たない。キャンペーン画面の申込パネルと per-campaign API は PR4 のまま残す。
2. **宛先の資格**: 通知ONでも「売却DMを使えない人」には送らない(申込者名・町名は個人情報・リンクも開けない)。判定は `requireSaleDmAccess` と同じ条件を任意の userId で調べる `checkSaleDmAccessFor(userId)` に切り出して共用する。field_staff は物件の担当範囲外なら送らない。
3. **受け手ごとの詳しさ**: 設計書の `full` は全員一律だったが、表示権限の弱い受け手に電話・メールを渡すと画面の伏せを迂回するので、受け手ごとに `minimal` へ落とす(Global Constraints)。
4. **二重送信の防止**: `dm_inquiries` に `notify_claimed_at` を足し、`notify_status in (pending, failed)` か「`sending` のまま 15分以上経過(プロセスが落ちた残骸)」のときだけ `sending` に取る。再試行の待ちの間も `sending` を保持し、各試行で `notify_claimed_at` を更新する(最長待ち10分 < 15分)。
5. **再試行の単位**: 1回の試行で「まだ成功していない受け手」だけに送る(成功した受け手の集合は試行をまたいでメモリで持つ)。プロセス再起動後の「再送」は全受け手に送る(重複は許容・通知は反響の見落とし防止が目的)。
6. **宛先0人**: `failed`+`no_recipients`。「査定の申込」画面と管理者のメール設定画面に「通知先が未設定です」。設定後に「再送」できる。**再試行はしない**(設定が変わるまで結果は同じ)。送信設定が未完成(`mail_not_configured`)も同じく再試行しない。
7. **通知先の設定は利用者一覧の行の「通知」ボタン → ダイアログ**(作成フォームは触らない=新規利用者は既定OFF・作成直後にダイアログで設定)。
8. **`appBaseUrl` は MailConfig に持つ**(社内 HTTPS の絶対URL・例 `https://property-management.tail182d6b.ts.net`)。未設定なら本文にリンク行を出さず「アプリの『査定の申込』からご確認ください。」と書く(送信は止めない)。

---

## File Structure

| 種別 | パス | 責務 |
|---|---|---|
| Modify | `package.json` / `package-lock.json` | `nodemailer`・`@types/nodemailer` |
| Modify | `prisma/schema.prisma` / Create `prisma/migrations/20260918100000_add_mail_config_and_inquiry_notify/migration.sql` | `MailConfig`・`User.inquiryNotifyEnabled/inquiryNotifyEmail`・`DmInquiry.notifyClaimedAt` |
| Modify | `src/lib/sale-dm-letter/route-guard.ts` | `checkSaleDmAccessFor(userId)` を切り出し `requireSaleDmAccess` から共用 |
| Create | `src/lib/mail/mail-config.ts` | `MAIL_CONFIG_ID`・`loadMailSendConfig()`(復号込み・未完成なら null)・`isMailConfigComplete` |
| Create | `src/lib/mail/transport.ts` | `sendPlainMail(config, { to, subject, text })`・テスト用差し替え口・エラーコードの許可リスト |
| Create | `src/app/api/admin/mail-settings/route.ts` | GET/PUT(管理者) |
| Create | `src/app/api/admin/mail-settings/test/route.ts` | テスト送信 POST(管理者・宛先=操作者の通知先) |
| Create | `src/app/(dashboard)/admin/mail-settings/page.tsx` | メール送信設定の画面 |
| Modify | `src/components/layout/sidebar-model.tsx` | 「メール送信設定」(admin)・「査定の申込」(office_staff) |
| Create | `src/app/api/admin/users/[id]/inquiry-notify/route.ts` | 利用者の通知設定 GET/PUT(管理者) |
| Modify | `src/app/(dashboard)/admin/users/page.tsx` / Create `src/components/admin/inquiry-notify-dialog.tsx` | 行の「通知」ボタンとダイアログ |
| Create | `src/lib/sale-dm-letter/inquiry-notify-mail.ts` | `buildInquiryNotifyMail`(件名・本文の純関数) |
| Create | `src/lib/sale-dm-letter/inquiry-notify.ts` | `notifyInquiry`・`startInquiryNotify`・宛先の解決・状態の取り合い・再試行 |
| Modify | `src/app/t/[token]/inquiry/route.ts` | 記録後に `startInquiryNotify` を起動 |
| Create | `src/app/api/properties/sale-dm/inquiries/route.ts` | キャンペーン横断の申込一覧 GET |
| Modify | `src/app/api/properties/sale-dm/inquiries/[inquiryId]/route.ts` | 作成者の縛りを外す |
| Create | `src/app/api/properties/sale-dm/inquiries/[inquiryId]/notify/route.ts` | 再送 POST |
| Modify | `src/lib/sale-dm-letter/inquiry-list.ts` | 行に `notifyStatus` を足す(横断一覧用の追加項目は route 側) |
| Create | `src/app/(dashboard)/properties/sale-dm/inquiries/page.tsx` / Modify `src/components/sale-dm/inquiry-list.tsx` | 横断画面・通知状況と再送 |
| Modify | `src/lib/api-client.ts` | 新 API の呼び出し |
| Modify | `src/lib/audit-log-detail-safety.ts` ほか `sale_dm_inquiry_view` 登録箇所 | 監査アクション4種 |
| Modify | `docs/deploy.md` / `docs/*guide*`・`public/docs/guide.html`・`public/docs/manual.html` | 反映手順・使い方 |

---

### Task 1: スキーマ・migration・依存

**Files:**
- Modify: `package.json`, `package-lock.json`, `prisma/schema.prisma`
- Create: `prisma/migrations/20260918100000_add_mail_config_and_inquiry_notify/migration.sql`
- Test: `src/lib/__tests__/mail-config-schema.test.ts`

**Interfaces:**
- Produces: Prisma model `MailConfig`(`prisma.mailConfig`)、`User.inquiryNotifyEnabled: boolean`・`User.inquiryNotifyEmail: string | null`、`DmInquiry.notifyClaimedAt: Date | null`。

- [ ] **Step 1: 依存を入れる**

```bash
npm install nodemailer
npm install -D @types/nodemailer
```

- [ ] **Step 2: 走査テストを書く(失敗する)**

`src/lib/__tests__/mail-config-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";

const root = process.cwd();
const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8").replace(/\r\n/g, "\n");

describe("メール通知のスキーマ", () => {
  it("MailConfig は singleton で、パスワードは暗号文の列だけを持つ", () => {
    const m = schema.match(/model MailConfig \{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const col of ["smtpHost", "smtpPort", "smtpSecure", "smtpUser", "smtpPassEnc", "fromAddress", "appBaseUrl", "inquiryMailDetail", "updatedAt", "updatedById"]) {
      expect(body).toContain(col);
    }
    expect(body).toMatch(/id\s+String\s+@id @default\("singleton"\)/);
    expect(body).not.toMatch(/smtpPass\s+String/);
    expect(body).toContain('@@map("mail_config")');
  });
  it("User に通知の2列・DmInquiry に notifyClaimedAt", () => {
    expect(schema).toMatch(/inquiryNotifyEnabled\s+Boolean\s+@default\(false\)\s+@map\("inquiry_notify_enabled"\)/);
    expect(schema).toMatch(/inquiryNotifyEmail\s+String\?\s+@map\("inquiry_notify_email"\)/);
    expect(schema).toMatch(/notifyClaimedAt\s+DateTime\?\s+@map\("notify_claimed_at"\)/);
  });
  it("migration は追加のみ(DROP/ALTER COLUMN TYPE を含まない)", () => {
    const dir = path.join(root, "prisma/migrations/20260918100000_add_mail_config_and_inquiry_notify");
    expect(readdirSync(dir)).toContain("migration.sql");
    const sql = readFileSync(path.join(dir, "migration.sql"), "utf8");
    expect(sql).toContain('CREATE TABLE "mail_config"');
    expect(sql).not.toMatch(/^\s*DROP\b/im);
    expect(sql).not.toMatch(/ALTER COLUMN[^;]*TYPE/i);
  });
  it("nodemailer は dependencies・型は devDependencies", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.dependencies.nodemailer).toBeDefined();
    expect(pkg.devDependencies["@types/nodemailer"]).toBeDefined();
  });
});
```

- [ ] **Step 3: 失敗を確認** — `npx vitest run src/lib/__tests__/mail-config-schema.test.ts` → FAIL(MailConfig なし)

- [ ] **Step 4: schema を足す**

`prisma/schema.prisma` の `model SaleDmConfig` の直後に:

```prisma
// 通知メールの送信設定(設計 2026-09-08 §2.6)。Xserver SMTP を想定。パスワードは encryptSecret の暗号文のみ。
model MailConfig {
  id                String   @id @default("singleton")
  smtpHost          String?  @map("smtp_host")
  smtpPort          Int?     @map("smtp_port")
  // true=接続時からTLS(465) / false=STARTTLS(587)
  smtpSecure        Boolean  @default(true) @map("smtp_secure")
  smtpUser          String?  @map("smtp_user")
  smtpPassEnc       String?  @map("smtp_pass_enc")
  fromAddress       String?  @map("from_address")
  // 社内から開くアプリの絶対URL(通知メールのリンク用)。公開LPの trackingBaseUrl とは別物。
  appBaseUrl        String?  @map("app_base_url")
  // minimal | full
  inquiryMailDetail String   @default("minimal") @map("inquiry_mail_detail")
  updatedAt         DateTime @updatedAt @map("updated_at")
  updatedById       String?  @map("updated_by_id") @db.Uuid

  @@map("mail_config")
}
```

`model User` の `mustChangePassword` の行の直後に:

```prisma
  // 査定申込の通知メール(設計 §2.6)。null=ログイン email に送る。
  inquiryNotifyEnabled Boolean  @default(false) @map("inquiry_notify_enabled")
  inquiryNotifyEmail   String?  @map("inquiry_notify_email")
```

`model DmInquiry` の `notifyLastError` の行の直後に:

```prisma
  // 通知を取り合った時刻。sending のまま15分を超えたら残骸とみなして取り直せる。
  notifyClaimedAt DateTime? @map("notify_claimed_at")
```

- [ ] **Step 5: migration を書く**

`prisma/migrations/20260918100000_add_mail_config_and_inquiry_notify/migration.sql`:

```sql
-- 通知メールの送信設定(singleton)
CREATE TABLE "mail_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "smtp_host" TEXT,
    "smtp_port" INTEGER,
    "smtp_secure" BOOLEAN NOT NULL DEFAULT true,
    "smtp_user" TEXT,
    "smtp_pass_enc" TEXT,
    "from_address" TEXT,
    "app_base_url" TEXT,
    "inquiry_mail_detail" TEXT NOT NULL DEFAULT 'minimal',
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,
    CONSTRAINT "mail_config_pkey" PRIMARY KEY ("id")
);

-- 利用者ごとの通知先
ALTER TABLE "users" ADD COLUMN "inquiry_notify_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "inquiry_notify_email" TEXT;

-- 通知の取り合い時刻
ALTER TABLE "dm_inquiries" ADD COLUMN "notify_claimed_at" TIMESTAMP(3);
```

(`users` の実テーブル名は `grep -n '@@map("users")' prisma/schema.prisma` で確認。違えば合わせる。)

- [ ] **Step 6: 生成と検証**

```bash
npx prisma generate
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --script
```

2つ目はローカルに shadow DB があるときだけ(差分が空=schema と migration が一致)。無ければ `npx prisma migrate dev --create-only` は使わず、ローカル DB に `npx prisma migrate deploy` して `npx prisma migrate status` が "Database schema is up to date" になることを確認。

- [ ] **Step 7: テストが通る** — `npx vitest run src/lib/__tests__/mail-config-schema.test.ts` → PASS、`npx tsc --noEmit` → 0

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json prisma/schema.prisma prisma/migrations/20260918100000_add_mail_config_and_inquiry_notify/migration.sql src/lib/__tests__/mail-config-schema.test.ts
git commit -m "feat(mail): 通知メールの送信設定と通知先の列を追加"
```

---

### Task 2: 売却DMを使えるかを任意の利用者で判定する

**Files:**
- Modify: `src/lib/sale-dm-letter/route-guard.ts`
- Test: `src/lib/__tests__/sale-dm-access-for-user.test.ts`

**Interfaces:**
- Consumes: `getUserPermissions(userId)`, `getOwnerDisplayConfig(userId, permissions)`(`@/lib/api-helpers`), `hasPermission`, `isPlainOwnerLevel`
- Produces:
  ```ts
  export type SaleDmAccessCheck =
    | { ok: true; permissions: Awaited<ReturnType<typeof getUserPermissions>>; ownerDisplayConfig: Awaited<ReturnType<typeof getOwnerDisplayConfig>> }
    | { ok: false; reason: "permission" | "display" };
  export async function checkSaleDmAccessFor(userId: string): Promise<SaleDmAccessCheck>;
  ```
  `requireSaleDmAccess()` の戻り値・例外文言は**変えない**。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-access-for-user.test.ts`:

```ts
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/api-helpers", () => ({
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  getOwnerDisplayConfig: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string, public code: string) { super(message); }
  },
}));
vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("@/lib/permissions", () => ({
  hasPermission: (perms: Record<string, string[]>, res: string, act: string) => (perms[res] ?? []).includes(act),
}));
vi.mock("@/lib/dm-export", () => ({ isPlainOwnerLevel: (v: string) => v === "full" }));

import { checkSaleDmAccessFor, requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";

const perms = vi.mocked(getUserPermissions);
const display = vi.mocked(getOwnerDisplayConfig);
const ALL = { property: ["read", "write"], csv_export: ["read"], csv_export_personal: ["read"], owner: ["read"] };
const PLAIN = { name: "full", zip: "full", address: "full", phone: "full", email: "full" };

beforeEach(() => {
  vi.clearAllMocks();
  perms.mockResolvedValue(ALL as never);
  display.mockResolvedValue(PLAIN as never);
});

describe("checkSaleDmAccessFor", () => {
  it("4権限+氏名/郵便番号/住所が平文なら ok", async () => {
    const r = await checkSaleDmAccessFor("u1");
    expect(r.ok).toBe(true);
    expect(perms).toHaveBeenCalledWith("u1");
  });
  it.each(["property", "csv_export", "csv_export_personal", "owner"])("%s の read が無ければ permission", async (res) => {
    perms.mockResolvedValue({ ...ALL, [res]: [] } as never);
    expect(await checkSaleDmAccessFor("u1")).toEqual({ ok: false, reason: "permission" });
  });
  it.each(["name", "zip", "address"])("%s が平文でなければ display", async (key) => {
    display.mockResolvedValue({ ...PLAIN, [key]: "masked" } as never);
    expect(await checkSaleDmAccessFor("u1")).toEqual({ ok: false, reason: "display" });
  });
  it("requireSaleDmAccess は従来どおり 403 の文言を投げる", async () => {
    vi.mocked(getApiSession).mockResolvedValue({ id: "u1", role: "office_staff" } as never);
    perms.mockResolvedValue({ ...ALL, owner: [] } as never);
    await expect(requireSaleDmAccess()).rejects.toThrow("所有者情報の閲覧権限がありません");
  });
});
```

(モックの形は既存の `hasPermission`/`isPlainOwnerLevel` の実シグネチャに合わせて直してよい。`grep -n "export function hasPermission" src/lib/permissions.ts`・`grep -n "export function isPlainOwnerLevel" src/lib/dm-export.ts` を先に読む。平文レベルの実際の値も同様。)

- [ ] **Step 2: 失敗を確認** — `npx vitest run src/lib/__tests__/sale-dm-access-for-user.test.ts` → FAIL(`checkSaleDmAccessFor` なし)

- [ ] **Step 3: 実装**

`route-guard.ts` の `requireSaleDmAccess` を次に置き換える(配列は共有定数へ):

```ts
const SALE_DM_REQUIRED_READS = [
  ["property", "物件一覧の閲覧権限がありません"],
  ["csv_export", "CSV エクスポートの権限がありません"],
  ["csv_export_personal", "個人情報を含む出力の権限がありません"],
  ["owner", "所有者情報の閲覧権限がありません"],
] as const;

export type SaleDmAccessCheck =
  | {
      ok: true;
      permissions: Awaited<ReturnType<typeof getUserPermissions>>;
      ownerDisplayConfig: Awaited<ReturnType<typeof getOwnerDisplayConfig>>;
    }
  | { ok: false; reason: "permission" | "display" };

// 任意の利用者が売却DMを使えるか(通知の宛先判定など、ログイン中の本人以外に使う)。
// requireSaleDmAccess と同じ条件。例外は投げない。
export async function checkSaleDmAccessFor(userId: string): Promise<SaleDmAccessCheck> {
  const permissions = await getUserPermissions(userId);
  for (const [res] of SALE_DM_REQUIRED_READS) {
    if (!hasPermission(permissions, res, "read")) return { ok: false, reason: "permission" };
  }
  const cfg = await getOwnerDisplayConfig(userId, permissions);
  if (!isPlainOwnerLevel(cfg.name) || !isPlainOwnerLevel(cfg.zip) || !isPlainOwnerLevel(cfg.address)) {
    return { ok: false, reason: "display" };
  }
  return { ok: true, permissions, ownerDisplayConfig: cfg };
}

export async function requireSaleDmAccess() {
  const session = await getApiSession();
  const permissions = await getUserPermissions(session.id);
  for (const [res, msg] of SALE_DM_REQUIRED_READS) {
    if (!hasPermission(permissions, res, "read")) throw new ApiError(403, msg, "FORBIDDEN");
  }
  const cfg = await getOwnerDisplayConfig(session.id, permissions);
  if (!isPlainOwnerLevel(cfg.name) || !isPlainOwnerLevel(cfg.zip) || !isPlainOwnerLevel(cfg.address)) {
    throw new ApiError(403, "DM作成に必要な所有者情報の表示権限がありません", "FORBIDDEN");
  }
  return { session, permissions, ownerDisplayConfig: cfg };
}
```

- [ ] **Step 4: 通る** — 同テスト PASS。`npx vitest run src/lib/__tests__ -t "sale-dm"` で既存の売却DM系が緑。

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/route-guard.ts src/lib/__tests__/sale-dm-access-for-user.test.ts
git commit -m "refactor(sale-dm): 売却DMを使えるかの判定を任意の利用者に使えるよう切り出す"
```

---

### Task 3: 送信設定の読み出しと送信の薄い包み

**Files:**
- Create: `src/lib/mail/mail-config.ts`, `src/lib/mail/transport.ts`
- Test: `src/lib/__tests__/mail-config-load.test.ts`, `src/lib/__tests__/mail-transport.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // mail-config.ts
  export const MAIL_CONFIG_ID = "singleton";
  export type InquiryMailDetail = "minimal" | "full";
  export interface MailSendConfig { host: string; port: number; secure: boolean; user: string; pass: string; from: string; appBaseUrl: string | null; inquiryMailDetail: InquiryMailDetail }
  export function isMailConfigComplete(row: { smtpHost: string | null; smtpPort: number | null; smtpUser: string | null; smtpPassEnc: string | null; fromAddress: string | null } | null): boolean;
  export async function loadMailSendConfig(): Promise<MailSendConfig | null>; // 未完成・復号失敗は null(throw しない)
  // transport.ts
  export interface PlainMail { to: string; subject: string; text: string }
  export type SendResult = { ok: true } | { ok: false; code: string | null };
  export async function sendPlainMail(config: MailSendConfig, mail: PlainMail): Promise<SendResult>; // throw しない
  export function setMailSenderForTest(fn: ((config: MailSendConfig, mail: PlainMail) => Promise<void>) | null): void;
  export function safeErrorCode(err: unknown): string | null;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/mail-transport.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";

const sendMail = vi.fn();
const createTransport = vi.fn(() => ({ sendMail }));
vi.mock("nodemailer", () => ({ default: { createTransport }, createTransport }));

import { sendPlainMail, setMailSenderForTest, safeErrorCode } from "@/lib/mail/transport";

const CFG = { host: "sv1.xserver.jp", port: 465, secure: true, user: "info@ligarejapan.com", pass: "pw", from: "info@ligarejapan.com", appBaseUrl: null, inquiryMailDetail: "minimal" as const };

afterEach(() => { setMailSenderForTest(null); vi.clearAllMocks(); });

describe("sendPlainMail", () => {
  it("nodemailer に1宛先・テキストのみで渡し、件名の改行は除く", async () => {
    sendMail.mockResolvedValue({});
    const r = await sendPlainMail(CFG, { to: "a@example.jp", subject: "件名\r\nBcc: x@evil", text: "本文" });
    expect(r).toEqual({ ok: true });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: "sv1.xserver.jp", port: 465, secure: true, auth: { user: "info@ligarejapan.com", pass: "pw" } }));
    const arg = sendMail.mock.calls[0][0];
    expect(arg).toEqual({ from: "info@ligarejapan.com", to: "a@example.jp", subject: "件名Bcc: x@evil", text: "本文" });
    expect(arg).not.toHaveProperty("html");
    expect(arg).not.toHaveProperty("bcc");
  });
  it("失敗しても throw せず、コードだけ返す(message は出さない)", async () => {
    const err = Object.assign(new Error("535 auth failed for info@ligarejapan.com"), { code: "EAUTH" });
    sendMail.mockRejectedValue(err);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await sendPlainMail(CFG, { to: "a@example.jp", subject: "s", text: "t" });
    expect(r).toEqual({ ok: false, code: "EAUTH" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("535");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("info@ligarejapan.com");
    spy.mockRestore();
  });
  it("差し替え口が使われる", async () => {
    const fake = vi.fn(async () => {});
    setMailSenderForTest(fake);
    await sendPlainMail(CFG, { to: "a@example.jp", subject: "s", text: "t" });
    expect(fake).toHaveBeenCalledOnce();
    expect(createTransport).not.toHaveBeenCalled();
  });
  it("safeErrorCode は大文字の定型コードだけ通す", () => {
    expect(safeErrorCode({ code: "ETIMEDOUT" })).toBe("ETIMEDOUT");
    expect(safeErrorCode({ code: "bad code a@b" })).toBeNull();
    expect(safeErrorCode(new Error("x"))).toBeNull();
    expect(typeof setMailSenderForTest).toBe("function");
  });
});
```

`src/lib/__tests__/mail-config-load.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

vi.mock("@/lib/prisma", () => ({ default: { mailConfig: { findUnique: vi.fn() } } }));
import prisma from "@/lib/prisma";
import { loadMailSendConfig, isMailConfigComplete } from "@/lib/mail/mail-config";
import { encryptSecret } from "@/lib/sale-dm-letter/secret-crypto";

const find = vi.mocked((prisma as unknown as { mailConfig: { findUnique: (a: unknown) => unknown } }).mailConfig.findUnique);
let saved: string | undefined;
beforeEach(() => { saved = process.env.SALE_DM_SETTINGS_ENC_KEY; process.env.SALE_DM_SETTINGS_ENC_KEY = crypto.randomBytes(32).toString("base64"); });
afterEach(() => { if (saved === undefined) delete process.env.SALE_DM_SETTINGS_ENC_KEY; else process.env.SALE_DM_SETTINGS_ENC_KEY = saved; vi.clearAllMocks(); });

const base = () => ({ smtpHost: "sv1.xserver.jp", smtpPort: 465, smtpSecure: true, smtpUser: "info@ligarejapan.com", smtpPassEnc: encryptSecret("pw"), fromAddress: "info@ligarejapan.com", appBaseUrl: "https://pm.example.ts.net", inquiryMailDetail: "minimal" });

describe("loadMailSendConfig", () => {
  it("揃っていれば復号して返す", async () => {
    find.mockResolvedValue(base() as never);
    expect(await loadMailSendConfig()).toEqual({ host: "sv1.xserver.jp", port: 465, secure: true, user: "info@ligarejapan.com", pass: "pw", from: "info@ligarejapan.com", appBaseUrl: "https://pm.example.ts.net", inquiryMailDetail: "minimal" });
  });
  it.each(["smtpHost", "smtpPort", "smtpUser", "smtpPassEnc", "fromAddress"])("%s が無ければ null", async (k) => {
    find.mockResolvedValue({ ...base(), [k]: null } as never);
    expect(await loadMailSendConfig()).toBeNull();
  });
  it("行が無い・復号失敗・DB 例外は null", async () => {
    find.mockResolvedValue(null as never);
    expect(await loadMailSendConfig()).toBeNull();
    find.mockResolvedValue({ ...base(), smtpPassEnc: "v1:broken" } as never);
    expect(await loadMailSendConfig()).toBeNull();
    find.mockRejectedValue(new Error("db down"));
    expect(await loadMailSendConfig()).toBeNull();
  });
  it("未知の inquiryMailDetail は minimal", async () => {
    find.mockResolvedValue({ ...base(), inquiryMailDetail: "everything" } as never);
    expect((await loadMailSendConfig())?.inquiryMailDetail).toBe("minimal");
  });
  it("isMailConfigComplete", () => {
    expect(isMailConfigComplete(null)).toBe(false);
    expect(isMailConfigComplete(base())).toBe(true);
  });
});
```

- [ ] **Step 2: 失敗を確認** — 両テスト FAIL(モジュールなし)

- [ ] **Step 3: 実装**

`src/lib/mail/mail-config.ts`:

```ts
import prisma from "@/lib/prisma";
import { decryptSecret } from "@/lib/sale-dm-letter/secret-crypto";

export const MAIL_CONFIG_ID = "singleton";
export type InquiryMailDetail = "minimal" | "full";

export interface MailSendConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  appBaseUrl: string | null;
  inquiryMailDetail: InquiryMailDetail;
}

export function isMailConfigComplete(
  row: { smtpHost: string | null; smtpPort: number | null; smtpUser: string | null; smtpPassEnc: string | null; fromAddress: string | null } | null,
): boolean {
  return !!row && !!row.smtpHost && !!row.smtpPort && !!row.smtpUser && !!row.smtpPassEnc && !!row.fromAddress;
}

// 送信に使う設定(パスワード復号込み)。未完成・復号失敗・DB 例外は null(呼び出し側は mail_not_configured)。
// ⚠この戻り値(pass)をログ・監査・API 応答に出さない。
export async function loadMailSendConfig(): Promise<MailSendConfig | null> {
  try {
    const row = await prisma.mailConfig.findUnique({ where: { id: MAIL_CONFIG_ID } });
    if (!row || !isMailConfigComplete(row)) return null;
    const pass = decryptSecret(row.smtpPassEnc as string);
    return {
      host: row.smtpHost as string,
      port: row.smtpPort as number,
      secure: row.smtpSecure,
      user: row.smtpUser as string,
      pass,
      from: row.fromAddress as string,
      appBaseUrl: row.appBaseUrl && row.appBaseUrl.trim() !== "" ? row.appBaseUrl : null,
      inquiryMailDetail: row.inquiryMailDetail === "full" ? "full" : "minimal",
    };
  } catch {
    return null;
  }
}
```

`src/lib/mail/transport.ts`:

```ts
import nodemailer from "nodemailer";
import type { MailSendConfig } from "./mail-config";

export interface PlainMail {
  to: string;
  subject: string;
  text: string;
}
export type SendResult = { ok: true } | { ok: false; code: string | null };

type Sender = (config: MailSendConfig, mail: PlainMail) => Promise<void>;
let senderOverride: Sender | null = null;

// テスト専用の差し替え口(本番コードから呼ばない)。
export function setMailSenderForTest(fn: Sender | null): void {
  senderOverride = fn;
}

const CODE_RE = /^[A-Z][A-Z0-9_]{1,40}$/;
export function safeErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && CODE_RE.test(code) ? code : null;
}

const realSender: Sender = async (config, mail) => {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  await transporter.sendMail({ from: config.from, to: mail.to, subject: mail.subject, text: mail.text });
};

// 1通送る。throw しない。件名の改行は除く(ヘッダ注入の多層防御)。
// ⚠失敗の message は SMTP 応答・宛先を含み得るので出さない(name/code の許可リストだけ)。
export async function sendPlainMail(config: MailSendConfig, mail: PlainMail): Promise<SendResult> {
  const safe: PlainMail = { to: mail.to, subject: mail.subject.replace(/[\r\n]+/g, ""), text: mail.text };
  try {
    await (senderOverride ?? realSender)(config, safe);
    return { ok: true };
  } catch (err) {
    const code = safeErrorCode(err);
    console.error("[mail] send failed", { name: err instanceof Error ? err.name : "Unknown", code });
    return { ok: false, code };
  }
}
```

- [ ] **Step 4: 通る** — 両テスト PASS、`npx tsc --noEmit` 0

- [ ] **Step 5: Commit**

```bash
git add src/lib/mail/mail-config.ts src/lib/mail/transport.ts src/lib/__tests__/mail-transport.test.ts src/lib/__tests__/mail-config-load.test.ts
git commit -m "feat(mail): 送信設定の読み出しと nodemailer の薄い包み"
```

---

### Task 4: 管理者のメール送信設定 API(GET/PUT/テスト送信)

**Files:**
- Create: `src/app/api/admin/mail-settings/route.ts`, `src/app/api/admin/mail-settings/test/route.ts`
- Modify: `src/lib/audit-log-detail-safety.ts`(と `sale_dm_inquiry_view` を登録している他の箇所)
- Test: `src/lib/__tests__/admin-mail-settings-route.test.ts`

**Interfaces:**
- Consumes: `MAIL_CONFIG_ID`, `isMailConfigComplete`, `loadMailSendConfig`(Task 3)、`sendPlainMail`(Task 3)、`encryptSecret`/`isSecretCryptoConfigured`
- Produces:
  - `GET /api/admin/mail-settings` → `{ data: { smtpHost, smtpPort, smtpSecure, smtpUser, hasPassword, fromAddress, appBaseUrl, inquiryMailDetail, complete, cryptoConfigured, notifyRecipientCount } }`(`notifyRecipientCount` = `isActive && inquiryNotifyEnabled` の利用者数)
  - `PUT /api/admin/mail-settings` body(全て optional): `smtpHost`(≤255)・`smtpPort`(1..65535 int)・`smtpSecure`(bool)・`smtpUser`(≤254)・`smtpPassword`(≤500・空文字=クリア・未指定=維持)・`fromAddress`(email)・`appBaseUrl`(https 絶対URL か空文字)・`inquiryMailDetail`(`minimal|full`) → GET と同じ形
  - `POST /api/admin/mail-settings/test` → `{ data: { result: "sent" } }` / 422 `MAIL_NOT_CONFIGURED` / 502 `MAIL_SEND_FAILED`(detail に code だけ)

- [ ] **Step 1: 失敗するテストを書く** — 既存 `src/app/api/admin/sale-dm-settings/route.ts` のテスト(`grep -rln "admin/sale-dm-settings/route" src/lib/__tests__`)と同じモックの組み方で、次を固定する:
  1. `user_management:write` が無い → 403(GET/PUT/POST すべて)。
  2. GET は `smtpPassEnc` の値も平文も返さない(`JSON.stringify(res)` に暗号文・`"pw"` を含まない)・`hasPassword: true`。
  3. PUT `smtpPassword: "pw"` → `mailConfig.upsert` の data の `smtpPassEnc` が `v1:` で始まり、`"pw"` を含まない。`smtpPassword: ""` → `smtpPassEnc: null`。未指定 → data に `smtpPassEnc` キーなし。
  4. PUT で `SALE_DM_SETTINGS_ENC_KEY` 未設定かつ `smtpPassword` あり → 422 `ENC_KEY_MISSING`(env は退避→削除→復元)。
  5. PUT `appBaseUrl: "http://x"` → 422(https だけ)・`"javascript:alert(1)"` → 422・`""` → null 保存。
  6. PUT の監査 `mail_settings_update` の detail が `{ fields: [...] }` だけで、値(ホスト名・アドレス)を含まない。
  7. POST test: 設定未完成 → 422 `MAIL_NOT_CONFIGURED`・`sendPlainMail` 呼ばれない。完成 → 宛先は操作者の `inquiryNotifyEmail ?? email`、件名「【テスト】通知メールの送信確認」・成功で 200・監査 `mail_settings_test` `{ result: "sent" }`。失敗 → 502 と監査 `{ result: "failed" }`。

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 実装** — `sale-dm-settings/route.ts` の `requireSaleDmAdmin` と同じ門(文言「メール送信設定を変更する権限がありません(管理者のみ)」)。PUT は `prisma.mailConfig.upsert({ where: { id: MAIL_CONFIG_ID }, create: { id: MAIL_CONFIG_ID, ...data, updatedById }, update: { ...data, updatedById } })`。`fields` は body に来たキー名(`smtpPassword` はそのまま名前だけ)。レスポンスは全部 `Cache-Control: no-store`。

  テスト送信の本文:

  ```ts
  const text = [
    "このメールは物件管理システムの「メール送信設定」からのテスト送信です。",
    "受け取れていれば、査定申込の通知メールも届きます。",
  ].join("\n");
  ```

- [ ] **Step 4: 監査の許可リスト** — `audit-log-detail-safety.ts` に:

  ```ts
  mail_settings_update: new Set(["fields"]),
  mail_settings_test: new Set(["result"]),
  inquiry_notify_sent: new Set(["attempt", "recipientUserIds"]),
  inquiry_notify_failed: new Set(["attempt", "code"]),
  ```

  `grep -rn "sale_dm_inquiry_view" src` で出る他の一覧(監査画面のラベル・アクション列挙など)にも4つを足し、それぞれのテストが緑になること。

- [ ] **Step 5: 通る** — 対象テスト PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/api/admin/mail-settings/route.ts src/app/api/admin/mail-settings/test/route.ts src/lib/audit-log-detail-safety.ts src/lib/__tests__/admin-mail-settings-route.test.ts <sale_dm_inquiry_view を足した他のファイル>
git commit -m "feat(mail): 管理者のメール送信設定 API とテスト送信"
```

---

### Task 5: メール送信設定の画面とサイドバー

**Files:**
- Create: `src/app/(dashboard)/admin/mail-settings/page.tsx`
- Modify: `src/components/layout/sidebar-model.tsx`, `src/lib/api-client.ts`, `src/components/layout/__tests__/sidebar-reorg.test.ts`
- Test: `src/app/(dashboard)/admin/__tests__/mail-settings-page-source.test.ts`

**Interfaces:**
- Consumes: Task 4 の API
- Produces: `api-client` に `getMailSettings()`, `updateMailSettings(body)`, `sendMailSettingsTest()`

- [ ] **Step 1: 走査テスト(失敗する)**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const page = readFileSync(path.join(process.cwd(), "src/app/(dashboard)/admin/mail-settings/page.tsx"), "utf8");
const sidebar = readFileSync(path.join(process.cwd(), "src/components/layout/sidebar-model.tsx"), "utf8");

describe("メール送信設定の画面", () => {
  it("パスワード欄は type=password・値を画面に戻さない(placeholder で設定済みを示す)", () => {
    expect(page).toContain('type="password"');
    expect(page).toContain("設定済み(変更する場合のみ入力)");
    expect(page).not.toMatch(/value=\{[^}]*smtpPass/);
  });
  it("テスト送信・通知先未設定の案内・Xserver の既定値の説明", () => {
    expect(page).toContain("テスト送信");
    expect(page).toContain("通知先が未設定です");
    expect(page).toContain("465");
  });
  it("サイドバー: DM グループに admin 限定で出す", () => {
    expect(sidebar).toMatch(/label:\s*"メール送信設定",\s*href:\s*"\/admin\/mail-settings"[^}]*minRole:\s*"admin"/);
  });
  it("生の h1 を使わない", () => {
    expect(page).not.toContain("<h1");
  });
});
```

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 実装** — 既存 `src/app/(dashboard)/admin/sale-dm-settings/page.tsx` を読み、同じ見出し部品・入力部品・保存ボタン・トースト/エラー表示を使う。欄: 送信サーバー(例 `sv****.xserver.jp`)/ポート(既定 465)/接続方式(「SSL(465)」「STARTTLS(587)」の select=`smtpSecure`)/ユーザー名(メールアドレス全体)/パスワード(書き込み専用)/送信元アドレス(既定の説明「info@ligarejapan.com」)/アプリのURL(`https://…` 社内から開くアドレス)/通知の詳しさ(「最小(町名・種別・お名前・リンク)」「詳しく(電話・メール・要望も)※電話とメールを見られる人にだけ」)。`notifyRecipientCount === 0` のとき上部に黄色の案内「通知先が未設定です。利用者一覧の「通知」から、通知を受け取る人を設定してください。」。`cryptoConfigured === false` なら赤の案内「サーバーの暗号化キーが未設定のため、パスワードを保存できません」。テスト送信ボタンは保存済みの設定で送る(未保存の変更があれば「先に保存してください」)。
  サイドバー: `{ label: "メール送信設定", href: "/admin/mail-settings", icon: ic(Mail), minRole: "admin" }` を「売却DM設定」の直後。`sidebar-reorg.test.ts` の項目数・順序の期待を更新。

- [ ] **Step 4: 通る** — 走査テスト+`sidebar-reorg.test.ts` PASS、eslint 0

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/admin/mail-settings/page.tsx" src/components/layout/sidebar-model.tsx src/lib/api-client.ts src/components/layout/__tests__/sidebar-reorg.test.ts "src/app/(dashboard)/admin/__tests__/mail-settings-page-source.test.ts"
git commit -m "feat(mail): メール送信設定の画面"
```

---

### Task 6: 利用者ごとの通知先

**Files:**
- Create: `src/app/api/admin/users/[id]/inquiry-notify/route.ts`, `src/components/admin/inquiry-notify-dialog.tsx`
- Modify: `src/app/(dashboard)/admin/users/page.tsx`, `src/lib/api-client.ts`
- Test: `src/lib/__tests__/admin-user-inquiry-notify-route.test.ts`, `src/app/(dashboard)/admin/users/__tests__/inquiry-notify-dialog-source.test.ts`

**Interfaces:**
- Consumes: `checkSaleDmAccessFor`(Task 2)
- Produces:
  - `GET /api/admin/users/[id]/inquiry-notify` → `{ data: { enabled, email: string | null, loginEmail, canUseSaleDm: boolean } }`
  - `PUT` body `{ enabled: boolean, email: string | "" | null }` → 同じ形。監査 `user_update` detail `{ changedFields: ["inquiryNotifyEnabled", "inquiryNotifyEmail"] }`(実際に来たものだけ)
  - `api-client`: `getUserInquiryNotify(id)`, `updateUserInquiryNotify(id, body)`

- [ ] **Step 1: 失敗するテスト** — route: `user_management:read`(GET)/`write`(PUT)が無ければ 403・対象なし 404・`email: "not-mail"` → 422・`email: ""` → null 保存・`enabled: true` でも `canUseSaleDm=false` の利用者は保存はできるが応答の `canUseSaleDm` が false(画面が警告を出す)・監査 detail にアドレスを含まない。ダイアログ走査: `ModalShell` を使う・「売却DMを使える権限がないため、この人には通知が届きません」の文言・メール欄の placeholder がログイン email。

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 実装** — route は `admin/users/[id]/route.ts` と同じ門。ダイアログ: チェックボックス「査定申込の通知メールを受け取る」+ メール入力(空欄=ログインのメールアドレスに送る)+ 保存。`users/page.tsx` の各行の操作列(「権限」リンクの隣)に `type="button"` の「通知」ボタン(既存の二次ボタンと同じ class)を足し、押すとダイアログを開く。

- [ ] **Step 4: 通る**

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/admin/users/[id]/inquiry-notify/route.ts" src/components/admin/inquiry-notify-dialog.tsx "src/app/(dashboard)/admin/users/page.tsx" src/lib/api-client.ts src/lib/__tests__/admin-user-inquiry-notify-route.test.ts "src/app/(dashboard)/admin/users/__tests__/inquiry-notify-dialog-source.test.ts"
git commit -m "feat(mail): 利用者ごとの査定申込の通知先"
```

---

### Task 7: 通知メールの件名・本文(純関数)

**Files:**
- Create: `src/lib/sale-dm-letter/inquiry-notify-mail.ts`
- Test: `src/lib/__tests__/sale-dm-inquiry-notify-mail.test.ts`

**Interfaces:**
- Consumes: `NAME_CONTACT_LIKE_RE`(`inquiry-input.ts`)、`HIDDEN_NAME_PLACEHOLDER`(`inquiry-list.ts`)
- Produces:
  ```ts
  export interface InquiryNotifyFacts {
    inquiryId: string; submittedAt: Date; campaignName: string; dmVariantLabel: string | null; lpVariantLabel: string | null;
    location: string | null; propertyTypeLabel: string | null;
    name: string; phone: string; email: string | null; contactPref: string | null; contactTime: string | null; message: string | null;
  }
  export function buildInquiryNotifyMail(facts: InquiryNotifyFacts, opts: { detail: "minimal" | "full"; appBaseUrl: string | null }): { subject: string; text: string };
  export function formatJst(d: Date): string; // "2026年9月18日 14:05"
  ```

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect } from "vitest";
import { buildInquiryNotifyMail, formatJst } from "@/lib/sale-dm-letter/inquiry-notify-mail";
import { HIDDEN_NAME_PLACEHOLDER } from "@/lib/sale-dm-letter/inquiry-list";

const F = {
  inquiryId: "11111111-1111-4111-8111-111111111111",
  submittedAt: new Date("2026-09-18T05:05:00Z"),
  campaignName: "9月 空き家",
  dmVariantLabel: "A", lpVariantLabel: "安心",
  location: "世田谷区代沢", propertyTypeLabel: "戸建",
  name: "山田 太郎", phone: "090-1234-5678", email: "taro@example.jp", contactPref: "phone", contactTime: "平日夜", message: "相談したい",
};

describe("buildInquiryNotifyMail", () => {
  it("件名=【査定申込】町名の種別(キャンペーン名)", () => {
    expect(buildInquiryNotifyMail(F, { detail: "minimal", appBaseUrl: null }).subject).toBe("【査定申込】世田谷区代沢の戸建(9月 空き家)");
  });
  it("件名の改行は除き、120字で切る・町名/種別が無ければ一般語", () => {
    const s = buildInquiryNotifyMail({ ...F, campaignName: "x\r\ny".repeat(100), location: null, propertyTypeLabel: null }, { detail: "minimal", appBaseUrl: null }).subject;
    expect(s).not.toMatch(/[\r\n]/);
    expect([...s].length).toBeLessThanOrEqual(120);
    expect(s.startsWith("【査定申込】所在地不明の物件(")).toBe(true);
  });
  it("minimal は電話・メール・時間帯・要望を含まない", () => {
    const { text } = buildInquiryNotifyMail(F, { detail: "minimal", appBaseUrl: "https://pm.example.ts.net/" });
    for (const v of ["090-1234-5678", "taro@example.jp", "平日夜", "相談したい"]) expect(text).not.toContain(v);
    expect(text).toContain("受付日時: 2026年9月18日 14:05");
    expect(text).toContain("お名前: 山田 太郎");
    expect(text).toContain("DM型: A / LP型: 安心");
    expect(text).toContain("https://pm.example.ts.net/properties/sale-dm/inquiries?focus=11111111-1111-4111-8111-111111111111");
  });
  it("full は電話・メール・希望連絡方法・時間帯・要望を含む", () => {
    const { text } = buildInquiryNotifyMail(F, { detail: "full", appBaseUrl: null });
    for (const v of ["電話: 090-1234-5678", "メール: taro@example.jp", "希望の連絡方法: 電話", "連絡のつきやすい時間帯: 平日夜", "相談したい"]) expect(text).toContain(v);
  });
  it("minimal では数字や @ を含むお名前を伏せる・full ではそのまま", () => {
    const f = { ...F, name: "山田 090" };
    expect(buildInquiryNotifyMail(f, { detail: "minimal", appBaseUrl: null }).text).toContain(`お名前: ${HIDDEN_NAME_PLACEHOLDER}`);
    expect(buildInquiryNotifyMail(f, { detail: "full", appBaseUrl: null }).text).toContain("お名前: 山田 090");
  });
  it("アプリのURLが無ければリンクの代わりに案内文", () => {
    const { text } = buildInquiryNotifyMail(F, { detail: "minimal", appBaseUrl: null });
    expect(text).toContain("アプリの「査定の申込」からご確認ください。");
    expect(text).not.toContain("focus=");
  });
  it("formatJst", () => {
    expect(formatJst(new Date("2026-12-31T15:00:00Z"))).toBe("2027年1月1日 00:00");
  });
});
```

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 実装**

```ts
import { NAME_CONTACT_LIKE_RE } from "./inquiry-input";
import { HIDDEN_NAME_PLACEHOLDER } from "./inquiry-list";

export interface InquiryNotifyFacts {
  inquiryId: string;
  submittedAt: Date;
  campaignName: string;
  dmVariantLabel: string | null;
  lpVariantLabel: string | null;
  location: string | null;
  propertyTypeLabel: string | null;
  name: string;
  phone: string;
  email: string | null;
  contactPref: string | null;
  contactTime: string | null;
  message: string | null;
}

const PREF_LABEL: Record<string, string> = { phone: "電話", email: "メール", either: "どちらでも" };
const SUBJECT_MAX = 120;

export function formatJst(d: Date): string {
  const j = new Date(d.getTime() + 9 * 3_600_000);
  const hh = String(j.getUTCHours()).padStart(2, "0");
  const mm = String(j.getUTCMinutes()).padStart(2, "0");
  return `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月${j.getUTCDate()}日 ${hh}:${mm}`;
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

// 通知メールの件名・本文(設計 §2.6)。detail は受け手ごとに呼び出し側が決める(表示権限の弱い人は minimal)。
export function buildInquiryNotifyMail(
  f: InquiryNotifyFacts,
  opts: { detail: "minimal" | "full"; appBaseUrl: string | null },
): { subject: string; text: string } {
  const place = oneLine(f.location ?? "所在地不明");
  const kind = oneLine(f.propertyTypeLabel ?? "物件");
  const subject = [...`【査定申込】${place}の${kind}(${oneLine(f.campaignName)})`].slice(0, SUBJECT_MAX).join("");
  const full = opts.detail === "full";
  const name = !full && NAME_CONTACT_LIKE_RE.test(f.name.normalize("NFKC")) ? HIDDEN_NAME_PLACEHOLDER : oneLine(f.name);

  const lines = [
    "公開LPから査定のお申込みが届きました。",
    "",
    `受付日時: ${formatJst(f.submittedAt)}`,
    `キャンペーン: ${oneLine(f.campaignName)}`,
    `DM型: ${oneLine(f.dmVariantLabel ?? "-")} / LP型: ${oneLine(f.lpVariantLabel ?? "-")}`,
    `物件: ${place}の${kind}`,
    `お名前: ${name}`,
  ];
  if (full) {
    lines.push(`電話: ${f.phone}`);
    if (f.email) lines.push(`メール: ${f.email}`);
    if (f.contactPref) lines.push(`希望の連絡方法: ${PREF_LABEL[f.contactPref] ?? "-"}`);
    if (f.contactTime) lines.push(`連絡のつきやすい時間帯: ${oneLine(f.contactTime)}`);
    if (f.message) lines.push("", "ご要望・ご質問:", f.message);
  }
  lines.push("");
  if (opts.appBaseUrl) {
    const base = opts.appBaseUrl.replace(/\/+$/, "");
    lines.push("アプリで開く:", `${base}/properties/sale-dm/inquiries?focus=${encodeURIComponent(f.inquiryId)}`);
  } else {
    lines.push("アプリの「査定の申込」からご確認ください。");
  }
  lines.push("", "※このメールは物件管理システムから自動で送っています。返信しても届きません。");
  return { subject, text: lines.join("\n") };
}
```

- [ ] **Step 4: 通る** — PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/inquiry-notify-mail.ts src/lib/__tests__/sale-dm-inquiry-notify-mail.test.ts
git commit -m "feat(sale-dm): 査定申込の通知メールの件名と本文"
```

---

### Task 8: 通知の本体(宛先・取り合い・再試行)

**Files:**
- Create: `src/lib/sale-dm-letter/inquiry-notify.ts`
- Test: `src/lib/__tests__/sale-dm-inquiry-notify.test.ts`

**Interfaces:**
- Consumes: `loadMailSendConfig`(Task 3)、`sendPlainMail`(Task 3)、`checkSaleDmAccessFor`(Task 2)、`buildInquiryNotifyMail`(Task 7)、`coarsePropertyLocation`/`propertyTypeLabel`(`./tags`)、`isPlainOwnerLevel`(`@/lib/dm-export`)、`writeAuditLog`
- Produces:
  ```ts
  export const NOTIFY_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
  export const NOTIFY_STALE_CLAIM_MS = 15 * 60_000;
  export type NotifyOutcome = "sent" | "failed" | "skipped";
  export async function notifyInquiry(inquiryId: string, opts?: { now?: () => Date }): Promise<NotifyOutcome>; // 1回目+再試行を全部やって最終結果を返す(テスト用に await できる)
  export function startInquiryNotify(inquiryId: string): void; // route 用・throw しない・待たない
  export async function countInquiryNotifyRecipients(): Promise<number>; // isActive && inquiryNotifyEnabled
  ```

- [ ] **Step 1: 失敗するテストを書く** — `prisma` をモック(`dmInquiry.updateMany`・`dmInquiry.findUnique`・`dmInquiry.update`・`user.findMany`)、`sendPlainMail`・`loadMailSendConfig`・`checkSaleDmAccessFor`・`writeAuditLog` をモック、`vi.useFakeTimers()`。次をすべて固定する:
  1. **取り合い**: 最初の `updateMany` の where が `{ id, OR: [{ notifyStatus: { in: ["pending", "failed"] } }, { notifyStatus: "sending", notifyClaimedAt: { lt: now-15分 } }] }`、data が `{ notifyStatus: "sending", notifyClaimedAt: now }`。count 0 なら `skipped` で何も送らない。
  2. **設定未完成**: `loadMailSendConfig` → null なら送らず `update` data `{ notifyStatus: "failed", notifyLastError: "mail_not_configured", notifyAttempts: { increment: 1 } }`・監査 `inquiry_notify_failed` `{ attempt: 1, code: "mail_not_configured" }`・**再試行のタイマーを張らない**(`vi.getTimerCount()===0`)。
  3. **宛先0人**(通知ONの有効な利用者なし、または全員 `checkSaleDmAccessFor` が ok:false): `no_recipients` で同様・再試行なし。
  4. **field_staff の範囲**: 物件の `createdBy/assignedTo` のどちらでもない field_staff には送らない。office_staff/admin には送る。
  5. **宛先アドレス**: `inquiryNotifyEmail ?? email`。
  6. **受け手ごとの詳しさ**: 設定 `full` で、受け手Aは phone/email とも plain → full 本文(電話を含む)、受け手Bは email が masked → minimal 本文(電話を含まない)。設定 `minimal` なら全員 minimal。
  7. **成功**: 全員成功 → `update` `{ notifyStatus: "sent", notifyLastError: null, notifyAttempts: { increment: 1 } }`・監査 `inquiry_notify_sent` `{ attempt: 1, recipientUserIds: [...] }`(アドレスを含まない)・戻り値 `sent`。
  8. **再試行**: 1回目で B だけ失敗 → `notifyClaimedAt` を更新して 30秒待ち → 2回目は **B にだけ**送る → 成功で `sent`。3回とも B が失敗し続けたら(1回目+再試行3回=計4試行)→ `failed`+`partial`(A には1回しか送っていない)・監査 `inquiry_notify_failed` `{ attempt: 4, code: "partial" }`。全員失敗し続けたら `send_failed`。待ち時間は `NOTIFY_RETRY_DELAYS_MS` の順(`vi.advanceTimersByTimeAsync` で確認)。
  9. **申込が消えていた**(`findUnique` → null)→ 状態を戻さず `skipped`。
  10. **例外で落ちない**: `startInquiryNotify` は内部で何が throw しても外に投げない(`console.error` は `{ name, code }` だけ)。
  11. `countInquiryNotifyRecipients` は `user.count({ where: { isActive: true, inquiryNotifyEnabled: true } })`。

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 実装**

```ts
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import { loadMailSendConfig, type MailSendConfig } from "@/lib/mail/mail-config";
import { sendPlainMail } from "@/lib/mail/transport";
import { checkSaleDmAccessFor } from "./route-guard";
import { buildInquiryNotifyMail, type InquiryNotifyFacts } from "./inquiry-notify-mail";
import { coarsePropertyLocation, propertyTypeLabel } from "./tags";

export const NOTIFY_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
export const NOTIFY_STALE_CLAIM_MS = 15 * 60_000;
export type NotifyOutcome = "sent" | "failed" | "skipped";

interface Recipient {
  userId: string;
  address: string;
  detail: "minimal" | "full";
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

export async function countInquiryNotifyRecipients(): Promise<number> {
  return prisma.user.count({ where: { isActive: true, inquiryNotifyEnabled: true } });
}

async function loadFacts(inquiryId: string) {
  return prisma.dmInquiry.findUnique({
    where: { id: inquiryId },
    select: {
      id: true, submittedAt: true, name: true, phone: true, email: true, contactPref: true, contactTime: true, message: true,
      draft: {
        select: {
          campaign: { select: { name: true } },
          variant: { select: { label: true } },
          lpVariant: { select: { label: true } },
          property: { select: { address: true, propertyType: true, createdBy: true, assignedTo: true } },
        },
      },
    },
  });
}

async function resolveRecipients(
  property: { createdBy: string | null; assignedTo: string | null },
  config: MailSendConfig,
): Promise<Recipient[]> {
  const users = await prisma.user.findMany({
    where: { isActive: true, inquiryNotifyEnabled: true },
    select: { id: true, email: true, role: true, inquiryNotifyEmail: true },
    orderBy: { id: "asc" },
  });
  const out: Recipient[] = [];
  for (const u of users) {
    if (u.role === "field_staff" && property.createdBy !== u.id && property.assignedTo !== u.id) continue;
    const access = await checkSaleDmAccessFor(u.id);
    if (!access.ok) continue;
    const bothPlain = isPlainOwnerLevel(access.ownerDisplayConfig.phone) && isPlainOwnerLevel(access.ownerDisplayConfig.email);
    const address = u.inquiryNotifyEmail && u.inquiryNotifyEmail.trim() !== "" ? u.inquiryNotifyEmail : u.email;
    out.push({ userId: u.id, address, detail: config.inquiryMailDetail === "full" && bothPlain ? "full" : "minimal" });
  }
  return out;
}

async function finish(inquiryId: string, attempts: number, result: { status: "sent" } | { status: "failed"; code: string }, recipientUserIds: string[]) {
  await prisma.dmInquiry.update({
    where: { id: inquiryId },
    data:
      result.status === "sent"
        ? { notifyStatus: "sent", notifyLastError: null, notifyAttempts: { increment: attempts } }
        : { notifyStatus: "failed", notifyLastError: result.code, notifyAttempts: { increment: attempts } },
  });
  await writeAuditLog(
    result.status === "sent"
      ? { action: "inquiry_notify_sent", targetTable: "dm_inquiries", targetId: inquiryId, detail: { attempt: attempts, recipientUserIds } }
      : { action: "inquiry_notify_failed", targetTable: "dm_inquiries", targetId: inquiryId, detail: { attempt: attempts, code: result.code } },
  );
}

// 通知の本体(設計 §2.6)。申込の記録が終わってから呼ぶ。1回目+再試行(30秒→2分→10分)。
// ⚠宛先アドレス・申込者の入力・SMTP の応答をログ/監査/notify_last_error に出さない。
export async function notifyInquiry(inquiryId: string, opts: { now?: () => Date } = {}): Promise<NotifyOutcome> {
  const now = opts.now ?? (() => new Date());
  const claimedAt = now();
  const claim = await prisma.dmInquiry.updateMany({
    where: {
      id: inquiryId,
      OR: [
        { notifyStatus: { in: ["pending", "failed"] } },
        { notifyStatus: "sending", notifyClaimedAt: { lt: new Date(claimedAt.getTime() - NOTIFY_STALE_CLAIM_MS) } },
      ],
    },
    data: { notifyStatus: "sending", notifyClaimedAt: claimedAt },
  });
  if (claim.count === 0) return "skipped";

  const row = await loadFacts(inquiryId);
  if (!row) return "skipped";

  const config = await loadMailSendConfig();
  if (!config) {
    await finish(inquiryId, 1, { status: "failed", code: "mail_not_configured" }, []);
    return "failed";
  }
  const recipients = await resolveRecipients(row.draft.property, config);
  if (recipients.length === 0) {
    await finish(inquiryId, 1, { status: "failed", code: "no_recipients" }, []);
    return "failed";
  }

  const facts: InquiryNotifyFacts = {
    inquiryId: row.id,
    submittedAt: row.submittedAt,
    campaignName: row.draft.campaign.name,
    dmVariantLabel: row.draft.variant.label,
    lpVariantLabel: row.draft.lpVariant?.label ?? null,
    location: coarsePropertyLocation(row.draft.property.address),
    propertyTypeLabel: propertyTypeLabel(row.draft.property.propertyType),
    name: row.name, phone: row.phone, email: row.email, contactPref: row.contactPref, contactTime: row.contactTime, message: row.message,
  };

  const succeeded = new Set<string>();
  let attempts = 0;
  for (let i = 0; i <= NOTIFY_RETRY_DELAYS_MS.length; i += 1) {
    if (i > 0) {
      await sleep(NOTIFY_RETRY_DELAYS_MS[i - 1]);
      await prisma.dmInquiry.updateMany({ where: { id: inquiryId, notifyStatus: "sending" }, data: { notifyClaimedAt: now() } });
    }
    attempts += 1;
    for (const r of recipients) {
      if (succeeded.has(r.userId)) continue;
      const mail = buildInquiryNotifyMail(facts, { detail: r.detail, appBaseUrl: config.appBaseUrl });
      const res = await sendPlainMail(config, { to: r.address, subject: mail.subject, text: mail.text });
      if (res.ok) succeeded.add(r.userId);
    }
    if (succeeded.size === recipients.length) {
      await finish(inquiryId, attempts, { status: "sent" }, recipients.map((r) => r.userId));
      return "sent";
    }
  }
  await finish(inquiryId, attempts, { status: "failed", code: succeeded.size > 0 ? "partial" : "send_failed" }, []);
  return "failed";
}

// 受け口 route 用。待たない・throw しない。
export function startInquiryNotify(inquiryId: string): void {
  void notifyInquiry(inquiryId).catch((err: unknown) => {
    console.error("[sale_dm_inquiry_notify] failed", {
      name: err instanceof Error ? err.name : "Unknown",
      code: typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : null,
    });
  });
}
```

(`coarsePropertyLocation(address: string | null): string | null`・`propertyTypeLabel(propertyType: string | null): string | null` は確認済み。`draft.variant` は必須リレーション・`draft.lpVariant` は任意。)

- [ ] **Step 4: 通る** — PASS(フェイクタイマーのテストは `{ timeout: 20_000 }` を明示)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/inquiry-notify.ts src/lib/__tests__/sale-dm-inquiry-notify.test.ts
git commit -m "feat(sale-dm): 査定申込の通知(宛先・二重送信防止・再試行)"
```

---

### Task 9: 受け口からの起動と再送 API

**Files:**
- Modify: `src/app/t/[token]/inquiry/route.ts`, `src/lib/__tests__/sale-dm-inquiry-route.test.ts`, `src/lib/__tests__/sale-dm-inquiry-route-quota.test.ts`
- Create: `src/app/api/properties/sale-dm/inquiries/[inquiryId]/notify/route.ts`
- Test: `src/lib/__tests__/sale-dm-inquiry-notify-resend-route.test.ts`

**Interfaces:**
- Consumes: `startInquiryNotify`, `notifyInquiry`(Task 8)、`requireSaleDmAccess`、`filterDraftsByFieldStaffScope`
- Produces: `POST /api/properties/sale-dm/inquiries/[inquiryId]/notify` → 202 `{ data: { started: true } }` / 404 / 409 `NOT_FAILED`

- [ ] **Step 1: 失敗するテスト**
  - 受け口: `vi.mock("@/lib/sale-dm-letter/inquiry-notify", () => ({ startInquiryNotify: vi.fn() }))`。`recorded` のときだけ `startInquiryNotify("inq1")` が**監査の後に1回**呼ばれる。bot/invalid/404/409/429/503 では呼ばれない。`startInquiryNotify` が throw するモックでも応答は 200(route 側でも try/catch で囲む)。quota テストのモックにも同じ行を足す。
  - 再送: 門=`requireSaleDmAccess`(403 はそのまま)・申込なし/field_staff 範囲外 → 404・`notifyStatus` が `failed` 以外 → 409 `NOT_FAILED`・`failed` → `startInquiryNotify` を呼び 202。**キャンペーン作成者でなくても**(`campaign.createdBy !== session.id`)通る。

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 実装** — 受け口の監査 `sale_dm_inquiry_submit` の直後:

```ts
  // 通知メールは記録の後に起動するだけ(待たない)。失敗しても申込者への応答は変えない(設計 §2.6)。
  try {
    startInquiryNotify(result.inquiryId);
  } catch {
    // startInquiryNotify は throw しない設計。念のため応答を守る。
  }
```

  再送 route は `inquiries/[inquiryId]/route.ts` の読み取り部分と同じ select で `notifyStatus` を足し、作成者の条件は入れない。`Cache-Control: no-store`。

- [ ] **Step 4: 通る**

- [ ] **Step 5: Commit**

```bash
git add "src/app/t/[token]/inquiry/route.ts" "src/app/api/properties/sale-dm/inquiries/[inquiryId]/notify/route.ts" src/lib/__tests__/sale-dm-inquiry-route.test.ts src/lib/__tests__/sale-dm-inquiry-route-quota.test.ts src/lib/__tests__/sale-dm-inquiry-notify-resend-route.test.ts
git commit -m "feat(sale-dm): 申込の記録後に通知を起動し、失敗時は画面から再送できる"
```

---

### Task 10: 申込の閲覧範囲を「売却DMを使える人全員」に

**Files:**
- Create: `src/app/api/properties/sale-dm/inquiries/route.ts`
- Modify: `src/app/api/properties/sale-dm/inquiries/[inquiryId]/route.ts`, `src/lib/sale-dm-letter/inquiry-list.ts`, `src/lib/api-client.ts`
- Test: `src/lib/__tests__/sale-dm-inquiry-all-route.test.ts`, 既存 `src/lib/__tests__/sale-dm-inquiry-patch-route*.test.ts`(名前は `grep -rln "inquiries/\[inquiryId\]/route" src/lib/__tests__`)

**Interfaces:**
- Consumes: `toInquiryListRows`, `countInquiriesByGroup`, cursor 関数(PR4)、`countInquiryNotifyRecipients`(Task 8)、`coarsePropertyLocation`/`propertyTypeLabel`
- Produces:
  - `InquiryListRow` に `notifyStatus: string` を追加(`SourceRow` にも。per-campaign route の select にも足す)。
  - `GET /api/properties/sale-dm/inquiries?cursor=` → `{ inquiries: Array<InquiryListRow & { campaignId, campaignName, location: string | null, propertyTypeLabel: string | null }>, hasMore, nextCursor, counts, notifyRecipientCount }`
  - `api-client`: `getAllSaleDmInquiries(cursor?)`, `resendSaleDmInquiryNotify(inquiryId)`

- [ ] **Step 1: 失敗するテスト**
  - 横断 GET: `requireSaleDmAccess` を通れば**作成者でなくても**全キャンペーンの申込が返る(where に `campaign.createdBy` を含まない)・field_staff は where に `draft.property.OR[createdBy/assignedTo]`・並びと cursor は PR4 と同じ・電話/メール/自由記述/お名前の伏せは `toInquiryListRows` のまま(2×2 のうち (T,F) を1本)・監査 `sale_dm_inquiry_view` は `targetTable: "dm_inquiries"`・targetId なし・detail `{ count, viewedAt }`・`notifyRecipientCount` を返す。
  - PATCH: 作成者でない利用者でも `requireSaleDmWriteAccess`+担当範囲を満たせば 200(ロック後の再判定からも `campaign.createdBy` 条件を外す)。field_staff 範囲外は 404 のまま。
  - `toInquiryListRows` は `notifyStatus` をそのまま返す(伏せない)。

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 実装** — 横断 GET は per-campaign route をもとに `campaign` の読み取りと作成者判定を除き、`scopeWhere` を `session.role === "field_staff" ? { draft: { property: { OR: [...] } } } : {}` にする。select に `notifyStatus`・`draft.campaign { id, name }`・`draft.property { address, propertyType, createdBy, assignedTo }` を足し、行に `campaignId, campaignName, location: coarsePropertyLocation(address), propertyTypeLabel: propertyTypeLabel(propertyType)` を付ける(物件の住所そのものは返さない)。PATCH は `found.draft.campaign.createdBy !== session.id ||` と `locked.draft.campaign.createdBy !== session.id ||` を消し、select から `campaign` を外す。コメントに「発注者判断 2026-09-18: 申込は売却DMを使える人全員が対応できる」を残す。

- [ ] **Step 4: 通る**

- [ ] **Step 5: Commit**

```bash
git add src/app/api/properties/sale-dm/inquiries/route.ts "src/app/api/properties/sale-dm/inquiries/[inquiryId]/route.ts" "src/app/api/properties/sale-dm/campaigns/[id]/inquiries/route.ts" src/lib/sale-dm-letter/inquiry-list.ts src/lib/api-client.ts <変更したテスト>
git commit -m "feat(sale-dm): 申込を売却DMを使える人全員が見て対応できるようにする"
```

---

### Task 11: 「査定の申込」画面と通知状況の表示

**Files:**
- Create: `src/app/(dashboard)/properties/sale-dm/inquiries/page.tsx`
- Modify: `src/components/sale-dm/inquiry-list.tsx`, `src/components/layout/sidebar-model.tsx`, `src/components/layout/__tests__/sidebar-reorg.test.ts`
- Test: `src/components/sale-dm/__tests__/inquiry-list-notify-source.test.ts`

**Interfaces:**
- Consumes: Task 10 の API・`resendSaleDmInquiryNotify`
- Produces: `SaleDmInquiryList` が `mode: "campaign" | "all"` を受ける(`campaign` は従来どおり campaign を渡す・`all` は横断 API を使い、各行に「キャンペーン名・町名の種別」を出す)。

- [ ] **Step 1: 走査テスト(失敗する)**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const root = process.cwd();
const list = readFileSync(path.join(root, "src/components/sale-dm/inquiry-list.tsx"), "utf8");
const page = readFileSync(path.join(root, "src/app/(dashboard)/properties/sale-dm/inquiries/page.tsx"), "utf8");
const sidebar = readFileSync(path.join(root, "src/components/layout/sidebar-model.tsx"), "utf8");

describe("査定の申込 画面", () => {
  it("通知の失敗と再送・通知先未設定の案内", () => {
    expect(list).toContain("通知できていません");
    expect(list).toContain("再送");
    expect(list).toContain("resendSaleDmInquiryNotify");
    expect(list).toContain("通知先が未設定です");
  });
  it("横断モードとリンクの focus", () => {
    expect(page).toContain('mode="all"');
    expect(page).toMatch(/searchParams|useSearchParams/);
    expect(page).toContain("focus");
  });
  it("画面保護の印を保つ", () => {
    expect(list).toContain('data-pii-protected');
  });
  it("サイドバー: DM グループに office_staff で「査定の申込」", () => {
    expect(sidebar).toMatch(/label:\s*"査定の申込",\s*href:\s*"\/properties\/sale-dm\/inquiries"[^}]*minRole:\s*"office_staff"/);
  });
});
```

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 実装**
  - ページ: 既存 dashboard ページの見出し部品で「査定の申込」+説明「公開LPから届いた査定のお申込みです。売却DMを使える人は誰でも対応できます。」。`useSearchParams().get("focus")` を `SaleDmInquiryList` に `focusId` として渡し、該当行へ `scrollIntoView` し枠を強調(行の `id={\`inquiry-${id}\`}`)。focus の行が1ページ目に無ければ「さらに読み込む」を案内するだけ(自動で全件読まない)。`useSearchParams` は `Suspense` で包む(Next の build 要件)。
  - 一覧: `notifyStatus === "failed"` の行に赤い小さな札「通知できていません」+`type="button"` の「再送」(押すと `resendSaleDmInquiryNotify` → 成功で札を「通知を送り直しています」に変え、数秒後に再読込)。`notifyRecipientCount === 0`(横断モードの応答)なら一覧の上に黄色の案内「通知先が未設定です。管理者に、利用者一覧の「通知」から設定を依頼してください。」。キャンペーン画面のモードでは `notifyRecipientCount` が無いので出さない。
  - サイドバー: DM グループ「DMメニュー」の直後に `{ label: "査定の申込", href: "/properties/sale-dm/inquiries", icon: ic(Inbox), minRole: "office_staff" }`(`Inbox` を lucide-react から import)。`PROPERTIES_NON_LIST`(`sidebar-model.tsx` 187行付近)に `/properties/sale-dm` が既にあるので物件一覧の強調と衝突しないことをテストで確認。

- [ ] **Step 4: 通る** — 走査テスト・`sidebar-reorg.test.ts`・eslint 0・build OK

- [ ] **Step 5: ローカル実機確認**(`local-dev-env-setup` の手順・`npx next dev -p <port>`・本物の SMTP には繋がない)
  1. 作成者でない office_staff でログイン → サイドバー「査定の申込」→ 他人のキャンペーンの申込が見える・対応状況を変えられる。
  2. field_staff は担当物件の申込だけ。
  3. DB で1件を `notify_status='failed'` にする → 「通知できていません」「再送」→ 押すと `sending` に変わる(設定未完成なら数秒で `failed`+`mail_not_configured` に戻る)。
  4. `?focus=<id>` で該当行が強調される。
  5. 管理者で「メール送信設定」→ 保存 → 再読込でパスワード欄は空・「設定済み」表示。通知先0人の案内が出る → 利用者一覧の「通知」でONにすると消える。

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/properties/sale-dm/inquiries/page.tsx" src/components/sale-dm/inquiry-list.tsx src/components/layout/sidebar-model.tsx src/components/layout/__tests__/sidebar-reorg.test.ts src/components/sale-dm/__tests__/inquiry-list-notify-source.test.ts
git commit -m "feat(sale-dm): 「査定の申込」画面と通知の失敗・再送の表示"
```

---

### Task 12: 反映手順と使い方の資料

**Files:**
- Modify: `docs/deploy.md`, 社内資料2本(`grep -rln "申込" docs public/docs` で場所を確認)と `public/docs/guide.html`・`public/docs/manual.html`
- Test: `src/lib/__tests__/deploy-doc-mail.test.ts`

- [ ] **Step 1: 走査テスト(失敗する)** — `docs/deploy.md` に「nodemailer」「465」「SPF」「DKIM」「メール送信設定」「通知」の語、`public/docs/guide.html` に「査定の申込」「通知」が含まれる。

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 書く**
  - `deploy.md`(公開LPの節の後に「申込の通知メール」): 新依存 `nodemailer`(`npm ci` の到達確認=registry.npmjs.org に届くこと)・migration `20260918100000_add_mail_config_and_inquiry_notify`(追加のみ)・反映後の設定手順(管理者「メール送信設定」に Xserver のサーバー名 `sv****.xserver.jp`・465・SSL・ユーザー=`info@ligarejapan.com`・メールボックスのパスワード・送信元・アプリのURL=Tailscale の HTTPS)→「テスト送信」→利用者一覧の「通知」で受け取る人をON)・Xserver サーバーパネルで SPF/DKIM を有効化(迷惑メール対策・アプリの変更なし)・**VPS から Xserver の 465 へ外向き接続できること**(`nc -vz sv****.xserver.jp 465`)・パスワードはチャットや資料に書かない。
  - 使い方ガイド/マニュアル: 「査定の申込」画面の見方(対応状況・通知できていません・再送)と、管理者の設定手順(上と同じ要点を平易に)。アプリ内複製 `public/docs/*.html` も同じ内容に同期(`<body>` を欠落させない)。

- [ ] **Step 4: 通る** — 走査テスト PASS・フル `npx vitest run`・`npx tsc --noEmit`・eslint・build

- [ ] **Step 5: Commit**

```bash
git add docs/deploy.md public/docs/guide.html public/docs/manual.html <社内資料2本> src/lib/__tests__/deploy-doc-mail.test.ts
git commit -m "docs: 申込の通知メールの反映手順と使い方"
```

---

## 実機確認(本番反映後・発注者)

1. 管理者「メール送信設定」に Xserver の値を入れ「テスト送信」→ 自分の通知先に届く。
2. 利用者一覧で自分の「通知」をON → 送付済みの宛先のQRから申込(テスト用の宛先で)→ 数十秒以内に「【査定申込】…」が届く・リンクで「査定の申込」画面の該当行が開く。
3. 作成者でない社員でも「査定の申込」に同じ申込が見え、対応状況を変えられる。
4. 迷惑メールフォルダに入らない(入るなら SPF/DKIM の設定)。
