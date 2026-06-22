# 売却促進DM 作成 — Plan 1: 基盤(データモデル+生成+最小レビュー)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 物件を選んで「売却DM下書き」をAIで人数分生成し、保存・確認・編集・再生成・確定できる最小フローを作る。

**Architecture:** 住所補完バックエンド(`src/lib/address-lookup/`)と同型の層分離。純関数のプロンプト構築 → 生成プロバイダ抽象(claude/mock)→ オーケストレータ(env gate・並列・件数上限)→ 生成route → 最小レビューroute。データは「キャンペーン → 型(variant)→ 宛先下書き」の3階層(Prisma 新規)。宛先・敬称・住所は既存 `dm-export.ts` のグルーピング/敬称/CSV/権限ゲートを再利用。

**Tech Stack:** Next.js 16 (App Router) / Prisma 7 / PostgreSQL / next-auth v5 / zod 4 / vitest 4 / `@anthropic-ai/sdk`(新規追加)。

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-06-22-sale-dm-letter-assist-design.md`(本プランの上位)。
- 実装は**専用 git worktree** で行う(`superpowers:using-git-worktrees` を実行時に使用)。base = `main`(`530a317`)・branch = `feat/sale-dm-letter-assist`。
- AIキー等の秘密は**サーバー側のみ**。`NEXT_PUBLIC_*` で露出させない。client から外部API直叩き禁止(route 経由)。
- env 未設定なら**fail-closed**: orchestrator が `SaleDmError('NOT_CONFIGURED')` を throw → route で **503**。既存挙動は不変。
- 生成本文・宛名・住所は **PII**。route レスポンスは `Cache-Control: no-store`。AuditLog に本文/PII を残さない(非PIIメタのみ)。
- 権限ゲートは既存所有者宛DMと同一: `property:read` + `csv_export:read` + `csv_export_personal:read` + `owner:read`、かつ owner 氏名/郵便番号/住所が「生値レベル」(`isPlainOwnerLevel`)。不可なら 403(副作用なし)。
- 既定モデル = `claude-sonnet-4-6`(env `SALE_DM_LETTER_MODEL` で上書き可)。`max_tokens` は 1200。`temperature`/`budget_tokens` は使わない(4.6 系は adaptive)。
- 差出人(自社)既定 env: `SALE_DM_SENDER_NAME` / `SALE_DM_SENDER_CONTACT`(UI 入力が無い経路=再生成・Plan 2 印刷で `resolveSender()` 経由で使用)。
- 既存ヘルパ再利用(再実装しない): `@/lib/api-helpers`(getApiSession/getUserPermissions/getOwnerDisplayConfig/ApiError/handleApiError/OwnerDisplayConfig), `@/lib/permissions`(hasPermission/maskValue), `@/lib/audit`(writeAuditLog), `@/lib/csv-encode`, `@/lib/dm-export`(groupPropertyOwnersByAddress/isPlainOwnerLevel/DmRowPropertyOwner ほか), `@/lib/owner-honorific`(honorificForOwner), `@/lib/property-list-query`(buildPropertyListWhere/buildPropertyListOrderBy), `@/lib/validators`(propertyListQuerySchema), `@/lib/property-types`, `@/lib/prisma`。
- テストは `src/lib/__tests__/*.test.ts`。実行: `npm test`(= `vitest run`)。単体は `npx vitest run <file>`。
- DM件数上限超過は **400 ではなく `truncated:true`** で先頭 N 件にして返す(下書き生成は不完全CSVと違い、明示警告で続行してよい。所有者宛DMの 400 とは扱いを変える)。
- DRY / YAGNI / TDD / こまめにコミット。raw SQL は入れない(既存 dm-export の方針踏襲)。
- 本プランのスコープ外(後続プラン): デザインテンプレ/印刷/CSV(P2)・A/B複数型と割当(P3)・配達/反響/宛先不明連動/集計(P4)・LP追跡(P5)・物件一覧反映/作業画面UI(P6)。Plan 1 は「型=1キャンペーン1既定型」で動かす。

---

### Task 1: Prisma データモデル + マイグレーション

**Files:**
- Modify: `prisma/schema.prisma`(モデル3つ + enum4つ + `Property.dmUndeliverableAt` 追加 + `Property` 逆リレーション)
- Test: 手動検証(`prisma migrate dev` / `prisma generate` が成功すること)

**Interfaces:**
- Produces(後続が依存): モデル `DmCampaign` / `DmVariant` / `DmRecipientDraft`、enum `DmCampaignStatus`/`DmDraftStatus`/`DmOutcome`/`DmDeliveryStatus`、`Property.dmUndeliverableAt: DateTime?`。

- [ ] **Step 1: schema に追記**

`prisma/schema.prisma` の末尾(他モデルの近く・既存の書式に合わせる)に追記:

```prisma
model DmCampaign {
  id             String           @id @default(uuid()) @db.Uuid
  name           String
  status         DmCampaignStatus @default(draft)
  filterSnapshot Json?            @map("filter_snapshot")
  createdBy      String           @map("created_by") @db.Uuid
  createdAt      DateTime         @default(now()) @map("created_at")
  updatedAt      DateTime         @updatedAt @map("updated_at")

  creator    User              @relation("DmCampaignCreator", fields: [createdBy], references: [id])
  variants   DmVariant[]
  recipients DmRecipientDraft[]

  @@map("dm_campaigns")
}

model DmVariant {
  id               String  @id @default(uuid()) @db.Uuid
  campaignId       String  @map("campaign_id") @db.Uuid
  label            String
  designTemplate   String  @map("design_template")
  tone             String
  length           String
  appeal           String
  strength         String
  extraInstruction String? @map("extra_instruction")

  campaign   DmCampaign        @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  recipients DmRecipientDraft[]

  @@map("dm_variants")
}

model DmRecipientDraft {
  id                    String           @id @default(uuid()) @db.Uuid
  campaignId            String           @map("campaign_id") @db.Uuid
  propertyId            String           @map("property_id") @db.Uuid
  representativeOwnerId String?          @map("representative_owner_id") @db.Uuid
  variantId             String           @map("variant_id") @db.Uuid
  overrideJson          Json?            @map("override_json")
  recipientName         String           @map("recipient_name")
  recipientZip          String?          @map("recipient_zip")
  recipientAddress      String?          @map("recipient_address")
  honorific             String
  body                  String
  model                 String?
  status                DmDraftStatus    @default(draft)
  sentAt                DateTime?        @map("sent_at")
  deliveryStatus        DmDeliveryStatus @default(unknown) @map("delivery_status")
  returnedAt            DateTime?        @map("returned_at")
  trackingToken         String           @unique @map("tracking_token")
  lpFirstAccessAt       DateTime?        @map("lp_first_access_at")
  lpAccessCount         Int              @default(0) @map("lp_access_count")
  phoneInquiryAt        DateTime?        @map("phone_inquiry_at")
  outcome               DmOutcome        @default(none)
  outcomeNote           String?          @map("outcome_note")
  generatedBy           String           @map("generated_by") @db.Uuid
  createdAt             DateTime         @default(now()) @map("created_at")
  updatedAt             DateTime         @updatedAt @map("updated_at")
  confirmedAt           DateTime?        @map("confirmed_at")

  campaign  DmCampaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  variant   DmVariant  @relation(fields: [variantId], references: [id])
  property  Property   @relation(fields: [propertyId], references: [id], onDelete: Cascade)
  generator User       @relation("DmRecipientGenerator", fields: [generatedBy], references: [id])

  @@index([campaignId])
  @@index([propertyId])
  @@map("dm_recipient_drafts")
}

enum DmCampaignStatus {
  draft
  ready
  sent
  closed
}

enum DmDraftStatus {
  draft
  confirmed
  sent
}

enum DmOutcome {
  none
  inquiry
}

enum DmDeliveryStatus {
  unknown
  delivered
  returned_undeliverable
  returned_other
}
```

`Property` モデルに列と逆リレーションを追加(既存 `model Property { ... }` 内の適切な位置):

```prisma
  dmUndeliverableAt DateTime?          @map("dm_undeliverable_at")
  dmRecipientDrafts DmRecipientDraft[]
```

`User` モデルに逆リレーションを追加(既存 `model User { ... }` 内・他の `@relation` と同様の場所):

```prisma
  dmCampaigns        DmCampaign[]       @relation("DmCampaignCreator")
  dmRecipientDrafts  DmRecipientDraft[] @relation("DmRecipientGenerator")
```

- [ ] **Step 2: マイグレーション作成 + クライアント生成**

Run: `cd <worktree> && npx prisma migrate dev --name sale_dm_foundation`
Expected: 新テーブル3 + Property 列追加のマイグレーションが生成され、エラーなく適用。続けて `npx prisma generate` がエラーなく完了。

- [ ] **Step 3: コミット**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(sale-dm): add DmCampaign/DmVariant/DmRecipientDraft models + Property.dmUndeliverableAt"
```

---

### Task 2: プロンプト構築(純関数)

**Files:**
- Create: `src/lib/sale-dm-letter/types.ts`
- Create: `src/lib/sale-dm-letter/prompt.ts`
- Test: `src/lib/__tests__/sale-dm-prompt.test.ts`

**Interfaces:**
- Produces: `LetterRecipient` / `LetterOptions` / `BuiltPrompt` 型、`buildLetterPrompt(recipient, options): BuiltPrompt`。

- [ ] **Step 1: 型を定義**

`src/lib/sale-dm-letter/types.ts`:

```ts
export interface LetterRecipient {
  representativeName: string; // 代表所有者名(生値)
  honorific: string;          // "様" / "御中" 等(honorificForOwner の戻り)
  coOwnerCount: number;       // 同送付先の共有者数(>1 で「他共有者様」)
  propertyAddress: string;
  propertyTypeLabel: string;  // PROPERTY_TYPE_LABELS 経由
  roomNo?: string | null;
}

export interface LetterOptions {
  designTemplate: string; // "formal" | "soft" | "impact"(P2 で使用・P1 は保持)
  tone: string;           // "formal" | "standard" | "soft"
  length: string;         // "short" | "medium" | "long"
  appeal: string;         // "price" | "inheritance" | "vacant" | "buyer"
  strength: string;       // "low" | "medium" | "high"
  senderName: string;
  senderContact: string;
  extraInstruction?: string;
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

export interface LetterProvider {
  readonly name: string;
  generate(prompt: BuiltPrompt): Promise<{ body: string }>;
}

export type SaleDmErrorCode =
  | "NOT_CONFIGURED"
  | "TIMEOUT"
  | "NETWORK"
  | "AUTH_FAILED"
  | "UPSTREAM_4XX"
  | "UPSTREAM_5XX"
  | "RATE_LIMITED"
  | "GENERATION_FAILED";

export class SaleDmError extends Error {
  readonly code: SaleDmErrorCode;
  readonly httpStatus: number | null;
  constructor(code: SaleDmErrorCode, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "SaleDmError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
```

- [ ] **Step 2: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildLetterPrompt } from "../sale-dm-letter/prompt";
import type { LetterRecipient, LetterOptions } from "../sale-dm-letter/types";

const recipient: LetterRecipient = {
  representativeName: "田中 一郎",
  honorific: "様",
  coOwnerCount: 1,
  propertyAddress: "東京都〇〇区△△1-2-3",
  propertyTypeLabel: "土地",
  roomNo: null,
};
const options: LetterOptions = {
  designTemplate: "formal",
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "low",
  senderName: "△△不動産",
  senderContact: "000-000-0000",
  extraInstruction: "地域の成約事例にも触れて",
};

describe("buildLetterPrompt", () => {
  it("宛名(氏名+敬称)を user プロンプトに含める", () => {
    const { user } = buildLetterPrompt(recipient, options);
    expect(user).toContain("田中 一郎");
    expect(user).toContain("様");
  });

  it("複数共有者のとき宛名に共有者数を反映する情報を含める", () => {
    const { user } = buildLetterPrompt({ ...recipient, coOwnerCount: 3 }, options);
    expect(user).toContain("他共有者");
  });

  it("差出人・物件情報・補足指示を user に含める", () => {
    const { user } = buildLetterPrompt(recipient, options);
    expect(user).toContain("△△不動産");
    expect(user).toContain("東京都〇〇区△△1-2-3");
    expect(user).toContain("地域の成約事例にも触れて");
  });

  it("system にコンプライアンス制約(誇大広告/断定価格)を含める", () => {
    const { system } = buildLetterPrompt(recipient, options);
    expect(system).toContain("誇大");
    expect(system).toContain("断定");
  });

  it("同一入力で system は決定的(キャッシュ前提・宛先非依存)", () => {
    const a = buildLetterPrompt(recipient, options);
    const b = buildLetterPrompt({ ...recipient, representativeName: "佐藤 花子" }, options);
    expect(a.system).toBe(b.system);
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-prompt.test.ts`
Expected: FAIL(`buildLetterPrompt` 未定義 / モジュール解決不可)。

- [ ] **Step 4: 実装**

`src/lib/sale-dm-letter/prompt.ts`:

```ts
import type { LetterRecipient, LetterOptions, BuiltPrompt } from "./types";

const TONE_JA: Record<string, string> = {
  formal: "フォーマルで丁寧",
  standard: "標準的な丁寧さ",
  soft: "やわらかく親しみやすい",
};
const LENGTH_JA: Record<string, string> = {
  short: "はがき向けに短く(200〜300字目安)",
  medium: "封書向けに中程度(350〜500字目安)",
  long: "封書向けにやや長め(500〜700字目安)",
};
const APPEAL_JA: Record<string, string> = {
  price: "需要が高く好条件での売却が見込めること",
  inheritance: "相続・税の観点での早めの検討",
  vacant: "空き家・管理負担の軽減",
  buyer: "この地域で購入を希望する顧客がいること",
};
const STRENGTH_JA: Record<string, string> = {
  low: "控えめ・押し付けない",
  medium: "標準的な後押し",
  high: "積極的に売却を勧める(ただし誇張はしない)",
};

// 全通共通・宛先非依存の指示(prompt caching 前提で決定的に保つ)。
function buildSystem(options: LetterOptions): string {
  return [
    "あなたは日本の不動産会社の営業担当者です。所有者へ「不動産の売却」を促す日本語のダイレクトメール本文を作成します。",
    "次の制約を必ず守ってください:",
    "- 誇大広告・誇張表現を避ける。",
    "- 価格や売却の確実性を断定しない(「必ず高く売れます」等は禁止)。",
    "- 宅地建物取引業法に照らして問題となる断定・誇張をしない。",
    "- 敬称は宛名の指定に厳密に従う(個人=様 / 法人=御中)。",
    "- 差出人(会社名・連絡先)を本文末尾に明示する。",
    "- 無料査定など、相手の負担なく行動できる導線を1つ入れる。",
    `文体の方針: トーン=${TONE_JA[options.tone] ?? options.tone} / 長さ=${LENGTH_JA[options.length] ?? options.length} / 訴求の軸=${APPEAL_JA[options.appeal] ?? options.appeal} / 押しの強さ=${STRENGTH_JA[options.strength] ?? options.strength}。`,
    "出力は手紙本文のみ。前置きや説明・マークダウン記法は付けない。",
  ].join("\n");
}

export function buildLetterPrompt(recipient: LetterRecipient, options: LetterOptions): BuiltPrompt {
  const addressee =
    recipient.coOwnerCount > 1
      ? `${recipient.representativeName} ${recipient.honorific} 他共有者様`
      : `${recipient.representativeName} ${recipient.honorific}`;

  const user = [
    `宛名: ${addressee}`,
    `物件の所在地: ${recipient.propertyAddress}`,
    recipient.roomNo ? `部屋番号: ${recipient.roomNo}` : null,
    `物件種別: ${recipient.propertyTypeLabel}`,
    `差出人: ${options.senderName}(連絡先: ${options.senderContact})`,
    options.extraInstruction ? `補足指示: ${options.extraInstruction}` : null,
    "上記の宛名・物件情報・差出人で、売却を促すダイレクトメール本文を作成してください。",
  ]
    .filter(Boolean)
    .join("\n");

  return { system: buildSystem(options), user };
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-prompt.test.ts`
Expected: PASS(5 件)。

- [ ] **Step 6: コミット**

```bash
git add src/lib/sale-dm-letter/types.ts src/lib/sale-dm-letter/prompt.ts src/lib/__tests__/sale-dm-prompt.test.ts
git commit -m "feat(sale-dm): add letter prompt builder (pure) + types"
```

---

### Task 3: 生成プロバイダ抽象 + mock provider

**Files:**
- Create: `src/lib/sale-dm-letter/providers/mock.ts`
- Test: `src/lib/__tests__/sale-dm-mock-provider.test.ts`

**Interfaces:**
- Consumes: `LetterProvider` / `BuiltPrompt`(Task 2)。
- Produces: `MockLetterProvider`(decision的・外部I/Oなし)。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-mock-provider.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MockLetterProvider } from "../sale-dm-letter/providers/mock";

describe("MockLetterProvider", () => {
  it("name は 'mock'", () => {
    expect(new MockLetterProvider().name).toBe("mock");
  });
  it("body を決定的に返す(外部I/Oなし)", async () => {
    const p = new MockLetterProvider();
    const r1 = await p.generate({ system: "S", user: "宛名: 田中 一郎 様" });
    const r2 = await p.generate({ system: "S", user: "宛名: 田中 一郎 様" });
    expect(r1.body).toBe(r2.body);
    expect(r1.body.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-mock-provider.test.ts`
Expected: FAIL(モジュール未解決)。

- [ ] **Step 3: 実装**

`src/lib/sale-dm-letter/providers/mock.ts`:

```ts
import type { LetterProvider, BuiltPrompt } from "../types";

export class MockLetterProvider implements LetterProvider {
  readonly name = "mock";
  async generate(prompt: BuiltPrompt): Promise<{ body: string }> {
    const firstLine = prompt.user.split("\n")[0] ?? "";
    return {
      body: `（mock生成）${firstLine}\n平素より大変お世話になっております。当エリアでは不動産の需要が高まっております。無料査定を承っておりますのでお気軽にご連絡ください。`,
    };
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-mock-provider.test.ts`
Expected: PASS。

- [ ] **Step 5: コミット**

```bash
git add src/lib/sale-dm-letter/providers/mock.ts src/lib/__tests__/sale-dm-mock-provider.test.ts
git commit -m "feat(sale-dm): add mock letter provider"
```

---

### Task 4: Claude provider(@anthropic-ai/sdk)

**Files:**
- Modify: `package.json`(`@anthropic-ai/sdk` を dependencies に追加)
- Create: `src/lib/sale-dm-letter/providers/claude.ts`
- Test: `src/lib/__tests__/sale-dm-claude-provider.test.ts`

**Interfaces:**
- Consumes: `LetterProvider` / `BuiltPrompt` / `SaleDmError`(Task 2)。
- Produces: `ClaudeLetterProvider`(注入可能な `createMessage` でテスト)、`ClaudeProviderOptions`。

- [ ] **Step 1: 依存を追加**

Run: `cd <worktree> && npm install @anthropic-ai/sdk`
Expected: `package.json` の dependencies に `@anthropic-ai/sdk` が入り、`npm test` が引き続き解決可能。

- [ ] **Step 2: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-claude-provider.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ClaudeLetterProvider } from "../sale-dm-letter/providers/claude";
import { SaleDmError } from "../sale-dm-letter/types";

describe("ClaudeLetterProvider", () => {
  it("createMessage の text を body として返す", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "拝啓 …(本文)… 敬具" }],
    });
    const p = new ClaudeLetterProvider({ apiKey: "k", model: "claude-sonnet-4-6", createMessage });
    const r = await p.generate({ system: "S", user: "U" });
    expect(r.body).toBe("拝啓 …(本文)… 敬具");
    expect(createMessage).toHaveBeenCalledOnce();
    const arg = createMessage.mock.calls[0][0];
    expect(arg.model).toBe("claude-sonnet-4-6");
    expect(arg.max_tokens).toBe(1200);
    expect(arg.system).toBe("S");
  });

  it("createMessage が throw したら SaleDmError(GENERATION_FAILED)", async () => {
    const createMessage = vi.fn().mockRejectedValue(new Error("boom"));
    const p = new ClaudeLetterProvider({ apiKey: "k", model: "claude-sonnet-4-6", createMessage });
    await expect(p.generate({ system: "S", user: "U" })).rejects.toBeInstanceOf(SaleDmError);
  });

  it("refusal 応答は SaleDmError(GENERATION_FAILED)", async () => {
    const createMessage = vi.fn().mockResolvedValue({ stop_reason: "refusal", content: [] });
    const p = new ClaudeLetterProvider({ apiKey: "k", model: "claude-sonnet-4-6", createMessage });
    await expect(p.generate({ system: "S", user: "U" })).rejects.toBeInstanceOf(SaleDmError);
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-claude-provider.test.ts`
Expected: FAIL(モジュール未解決)。

- [ ] **Step 4: 実装**

`src/lib/sale-dm-letter/providers/claude.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { LetterProvider, BuiltPrompt } from "../types";
import { SaleDmError } from "../types";

// テスト注入用: 実 SDK 呼び出しを差し替えられるようにする(address-lookup の fetchFn 注入と同型)。
type CreateMessage = (args: {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: "user"; content: string }[];
}) => Promise<{ content?: Array<{ type: string; text?: string }>; stop_reason?: string }>;

export interface ClaudeProviderOptions {
  apiKey: string;
  model: string;
  createMessage?: CreateMessage;
}

export class ClaudeLetterProvider implements LetterProvider {
  readonly name = "claude";
  private readonly model: string;
  private readonly createMessage: CreateMessage;

  constructor(opts: ClaudeProviderOptions) {
    this.model = opts.model;
    if (opts.createMessage) {
      this.createMessage = opts.createMessage;
    } else {
      const client = new Anthropic({ apiKey: opts.apiKey });
      this.createMessage = (args) => client.messages.create(args) as unknown as ReturnType<CreateMessage>;
    }
  }

  async generate(prompt: BuiltPrompt): Promise<{ body: string }> {
    let res;
    try {
      res = await this.createMessage({
        model: this.model,
        max_tokens: 1200,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      });
    } catch (e) {
      throw new SaleDmError("GENERATION_FAILED", "本文生成に失敗しました");
    }
    if (res.stop_reason === "refusal") {
      throw new SaleDmError("GENERATION_FAILED", "本文生成が拒否されました");
    }
    const text = (res.content ?? []).find((b) => b.type === "text")?.text;
    if (!text) {
      throw new SaleDmError("GENERATION_FAILED", "本文が空でした");
    }
    return { body: text };
  }
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-claude-provider.test.ts`
Expected: PASS(3 件)。

- [ ] **Step 6: コミット**

```bash
git add package.json package-lock.json src/lib/sale-dm-letter/providers/claude.ts src/lib/__tests__/sale-dm-claude-provider.test.ts
git commit -m "feat(sale-dm): add Claude letter provider (injectable) + @anthropic-ai/sdk"
```

---

### Task 5: オーケストレータ(env gate + 並列 + 件数上限)

**Files:**
- Create: `src/lib/sale-dm-letter/index.ts`
- Test: `src/lib/__tests__/sale-dm-orchestrator.test.ts`

**Interfaces:**
- Consumes: `LetterProvider`/`LetterRecipient`/`LetterOptions`/`SaleDmError`(Task 2)、`MockLetterProvider`(Task 3)、`ClaudeLetterProvider`(Task 4)、`buildLetterPrompt`(Task 2)。
- Produces:
  - `isSaleDmConfigured(): boolean`
  - `resolveProvider(): LetterProvider`(env gate)
  - `MAX_GENERATE_ITEMS = 50`
  - `interface GeneratedDraft { recipientIndex: number; body: string | null; error: SaleDmErrorCode | null }`
  - `generateLetters(items: { recipient: LetterRecipient; options: LetterOptions }[], opts?: { provider?: LetterProvider; concurrency?: number; max?: number }): Promise<{ drafts: GeneratedDraft[]; truncated: boolean }>`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-orchestrator.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateLetters, isSaleDmConfigured, resolveProvider, MAX_GENERATE_ITEMS } from "../sale-dm-letter";
import { MockLetterProvider } from "../sale-dm-letter/providers/mock";
import { SaleDmError } from "../sale-dm-letter/types";
import type { LetterRecipient, LetterOptions, LetterProvider } from "../sale-dm-letter/types";

const recipient: LetterRecipient = {
  representativeName: "田中 一郎", honorific: "様", coOwnerCount: 1,
  propertyAddress: "東京都〇〇区", propertyTypeLabel: "土地", roomNo: null,
};
const options: LetterOptions = {
  designTemplate: "formal", tone: "formal", length: "medium", appeal: "price",
  strength: "low", senderName: "△△不動産", senderContact: "000",
};
const items = (n: number) => Array.from({ length: n }, () => ({ recipient, options }));

const ENV_KEYS = ["NEXT_PUBLIC_USE_MOCK", "SALE_DM_LETTER_PROVIDER", "ANTHROPIC_API_KEY", "SALE_DM_LETTER_MODEL"];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("env gate", () => {
  it("未設定なら isSaleDmConfigured=false / resolveProvider が NOT_CONFIGURED throw", () => {
    expect(isSaleDmConfigured()).toBe(false);
    try { resolveProvider(); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(SaleDmError); expect((e as SaleDmError).code).toBe("NOT_CONFIGURED"); }
  });
  it("NEXT_PUBLIC_USE_MOCK=true なら mock provider", () => {
    process.env.NEXT_PUBLIC_USE_MOCK = "true";
    expect(isSaleDmConfigured()).toBe(true);
    expect(resolveProvider().name).toBe("mock");
  });
  it("provider=claude + APIキーで claude provider", () => {
    process.env.SALE_DM_LETTER_PROVIDER = "claude";
    process.env.ANTHROPIC_API_KEY = "k";
    expect(resolveProvider().name).toBe("claude");
  });
});

describe("generateLetters", () => {
  it("各 item の本文を生成して返す", async () => {
    const { drafts, truncated } = await generateLetters(items(3), { provider: new MockLetterProvider() });
    expect(truncated).toBe(false);
    expect(drafts).toHaveLength(3);
    expect(drafts.every((d) => d.body && d.error === null)).toBe(true);
  });

  it("MAX 超過は先頭 N 件 + truncated=true", async () => {
    const { drafts, truncated } = await generateLetters(items(MAX_GENERATE_ITEMS + 5), { provider: new MockLetterProvider() });
    expect(truncated).toBe(true);
    expect(drafts).toHaveLength(MAX_GENERATE_ITEMS);
  });

  it("一部失敗しても全体は止めず該当のみ error", async () => {
    let n = 0;
    const flaky: LetterProvider = {
      name: "flaky",
      async generate() { n += 1; if (n === 2) throw new SaleDmError("GENERATION_FAILED", "x"); return { body: "ok" }; },
    };
    const { drafts } = await generateLetters(items(3), { provider: flaky });
    expect(drafts.filter((d) => d.error).length).toBe(1);
    expect(drafts.filter((d) => d.body).length).toBe(2);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-orchestrator.test.ts`
Expected: FAIL(モジュール未解決)。

- [ ] **Step 3: 実装**

`src/lib/sale-dm-letter/index.ts`:

```ts
import type {
  LetterProvider, LetterRecipient, LetterOptions, SaleDmErrorCode,
} from "./types";
import { SaleDmError } from "./types";
import { buildLetterPrompt } from "./prompt";
import { MockLetterProvider } from "./providers/mock";
import { ClaudeLetterProvider } from "./providers/claude";

export const MAX_GENERATE_ITEMS = 50;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MODEL = "claude-sonnet-4-6";

export function isSaleDmConfigured(): boolean {
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") return true;
  const provider = process.env.SALE_DM_LETTER_PROVIDER;
  if (provider === "mock") return true;
  if (provider === "claude") return Boolean(process.env.ANTHROPIC_API_KEY);
  return false;
}

export function resolveProvider(): LetterProvider {
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") return new MockLetterProvider();
  const provider = process.env.SALE_DM_LETTER_PROVIDER;
  if (provider === "mock") return new MockLetterProvider();
  if (provider === "claude") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new SaleDmError("NOT_CONFIGURED", "ANTHROPIC_API_KEY が未設定です");
    }
    return new ClaudeLetterProvider({ apiKey, model: process.env.SALE_DM_LETTER_MODEL ?? DEFAULT_MODEL });
  }
  throw new SaleDmError("NOT_CONFIGURED", "売却DM生成が未設定です(SALE_DM_LETTER_PROVIDER)");
}

export interface GeneratedDraft {
  recipientIndex: number;
  body: string | null;
  error: SaleDmErrorCode | null;
}

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

export async function generateLetters(
  items: { recipient: LetterRecipient; options: LetterOptions }[],
  opts?: { provider?: LetterProvider; concurrency?: number; max?: number },
): Promise<{ drafts: GeneratedDraft[]; truncated: boolean }> {
  const max = opts?.max ?? MAX_GENERATE_ITEMS;
  const truncated = items.length > max;
  const sliced = truncated ? items.slice(0, max) : items;
  const provider = opts?.provider ?? resolveProvider();

  const tasks = sliced.map((item, i) => async (): Promise<GeneratedDraft> => {
    try {
      const prompt = buildLetterPrompt(item.recipient, item.options);
      const { body } = await provider.generate(prompt);
      return { recipientIndex: i, body, error: null };
    } catch (e) {
      const code = e instanceof SaleDmError ? e.code : "GENERATION_FAILED";
      return { recipientIndex: i, body: null, error: code };
    }
  });

  const drafts = await runWithConcurrency(tasks, opts?.concurrency ?? DEFAULT_CONCURRENCY);
  return { drafts, truncated };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-orchestrator.test.ts`
Expected: PASS(6 件)。

- [ ] **Step 5: コミット**

```bash
git add src/lib/sale-dm-letter/index.ts src/lib/__tests__/sale-dm-orchestrator.test.ts
git commit -m "feat(sale-dm): add orchestrator with env gate, concurrency, item cap"
```

---

### Task 6: 生成route(キャンペーン作成 + 下書き生成・保存)

**Files:**
- Create: `src/lib/sale-dm-letter/recipients.ts`(対象集約の純関数ヘルパ)
- Create: `src/app/api/properties/sale-dm/campaigns/route.ts`(POST)
- Create: `src/lib/validators-sale-dm.ts`(zod: options + body)
- Test: `src/lib/__tests__/sale-dm-campaigns-route.test.ts`

**Interfaces:**
- Consumes: `generateLetters`/`isSaleDmConfigured`/`resolveProvider`/`SaleDmError`/`LetterRecipient`/`LetterOptions`(Task 2,5)、既存ヘルパ(Global Constraints 参照)。
- Produces: `buildRecipientsFromProperties(properties, ownerDisplayConfig): { recipients: LetterRecipient[]; meta: { propertyId; representativeOwnerId; recipientName; recipientZip; recipientAddress; honorific }[] }`、`saleDmCampaignBodySchema`、route `POST /api/properties/sale-dm/campaigns`。

- [ ] **Step 1: zod スキーマ + 対象集約ヘルパのテストを書く**

`src/lib/__tests__/sale-dm-campaigns-route.test.ts`(まず純関数 `buildRecipientsFromProperties` をテスト。route 統合テストは Step 5 で追加):

```ts
import { describe, it, expect } from "vitest";
import { buildRecipientsFromProperties } from "../sale-dm-letter/recipients";

// dm-export と同じ select 形状の最小 fixture
const ownerDisplayConfig = { name: "full", zip: "full", address: "full", nameKana: "full" } as never;

const property = {
  id: "p1",
  address: "東京都〇〇区△△1-2-3",
  propertyType: "land",
  roomNo: null,
  propertyOwners: [
    { isPrimary: true, relationship: null, owner: { name: "田中 一郎", nameKana: null, zip: "1000001", address: "東京都〇〇区△△1-2-3", corporateNumber: null } },
  ],
};

describe("buildRecipientsFromProperties", () => {
  it("代表者・敬称・物件種別ラベルを持つ recipient を作る", () => {
    const { recipients, meta } = buildRecipientsFromProperties([property as never], ownerDisplayConfig);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].representativeName).toBe("田中 一郎");
    expect(recipients[0].honorific).toBe("様");
    expect(recipients[0].propertyTypeLabel).toBeTruthy();
    expect(meta[0].propertyId).toBe("p1");
    expect(meta[0].recipientAddress).toBe("東京都〇〇区△△1-2-3");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-campaigns-route.test.ts`
Expected: FAIL(`buildRecipientsFromProperties` 未定義)。

- [ ] **Step 3: zod スキーマ + 対象集約ヘルパを実装**

`src/lib/validators-sale-dm.ts`:

```ts
import { z } from "zod";

export const saleDmOptionsSchema = z.object({
  designTemplate: z.enum(["formal", "soft", "impact"]),
  tone: z.enum(["formal", "standard", "soft"]),
  length: z.enum(["short", "medium", "long"]),
  appeal: z.enum(["price", "inheritance", "vacant", "buyer"]),
  strength: z.enum(["low", "medium", "high"]),
  senderName: z.string().min(1),
  senderContact: z.string().min(1),
  extraInstruction: z.string().optional(),
});

export const saleDmCampaignBodySchema = z.object({
  name: z.string().min(1),
  options: saleDmOptionsSchema,
  filters: z.record(z.string(), z.string()).optional(), // 物件一覧と同じ検索条件
});

export type SaleDmCampaignBody = z.infer<typeof saleDmCampaignBodySchema>;
```

`src/lib/sale-dm-letter/recipients.ts`:

```ts
import type { OwnerDisplayConfig } from "@/lib/api-helpers";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";
import { honorificForOwner } from "@/lib/owner-honorific";
import {
  groupPropertyOwnersByAddress,
  selectGroupRepresentative,
  type DmRowPropertyOwner,
} from "@/lib/dm-export";
import type { LetterRecipient } from "./types";

export interface RecipientMeta {
  propertyId: string;
  representativeOwnerId: string | null;
  recipientName: string;
  recipientZip: string | null;
  recipientAddress: string | null;
  honorific: string;
}

// route の select は owner.id も取得するが、DmRowPropertyOwner の owner 型は id を含まないため widen する。
type OwnerWithId = DmRowPropertyOwner["owner"] & { id?: string };

type PropertyForRecipients = {
  id: string;
  address: string;
  propertyType: string;
  roomNo: string | null;
  propertyOwners: DmRowPropertyOwner[];
};

// dm-export の「1送付先住所=1通」グルーピングを再利用。groups は DmRowPropertyOwner[][]。
// 各グループの代表は selectGroupRepresentative で取り、敬称は honorificForOwner(name, hasCorporateNumber)。
export function buildRecipientsFromProperties(
  properties: PropertyForRecipients[],
  _ownerDisplayConfig: OwnerDisplayConfig,
): { recipients: LetterRecipient[]; meta: RecipientMeta[] } {
  const recipients: LetterRecipient[] = [];
  const meta: RecipientMeta[] = [];

  for (const p of properties) {
    const { groups } = groupPropertyOwnersByAddress(p.propertyOwners);
    for (const group of groups) {
      const repPo = selectGroupRepresentative(group);
      const repOwner = repPo.owner as OwnerWithId;
      const hasCorporateNumber =
        typeof repOwner.corporateNumber === "string" && repOwner.corporateNumber.length > 0;
      const honorific = honorificForOwner(repOwner.name, hasCorporateNumber);
      recipients.push({
        representativeName: repOwner.name,
        honorific,
        coOwnerCount: group.length,
        propertyAddress: p.address,
        propertyTypeLabel: PROPERTY_TYPE_LABELS[p.propertyType] ?? p.propertyType,
        roomNo: p.roomNo,
      });
      meta.push({
        propertyId: p.id,
        representativeOwnerId: repOwner.id ?? null,
        recipientName: repOwner.name,
        recipientZip: repOwner.zip ?? null,
        recipientAddress: repOwner.address ?? null,
        honorific,
      });
    }
  }
  return { recipients, meta };
}
```

> 実APIメモ(裏取り済): `groupPropertyOwnersByAddress(propertyOwners)` は `{ groups: DmRowPropertyOwner[][], skippedAddressCount }` を返す(groups は配列の配列)。代表者は `selectGroupRepresentative(group)` で取り、`po.owner.{name,zip,address,corporateNumber}` を読む。敬称は `honorificForOwner(name, hasCorporateNumber)` の2引数(owner オブジェクトではない)。`representativeOwnerId` 用に owner.id が必要なので Step 4 の route `select` に `owner.select.id: true` を入れる(`DmRowPropertyOwner` は id を型に含まないため recipients.ts 側で widen 済み)。

- [ ] **Step 4: 生成 route を実装**

`src/app/api/properties/sale-dm/campaigns/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession, getUserPermissions, getOwnerDisplayConfig, handleApiError, ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { propertyListQuerySchema } from "@/lib/validators";
import { buildPropertyListWhere, buildPropertyListOrderBy } from "@/lib/property-list-query";
import { isPlainOwnerLevel, type DmRowPropertyOwner } from "@/lib/dm-export";
import { saleDmCampaignBodySchema } from "@/lib/validators-sale-dm";
import { buildRecipientsFromProperties } from "@/lib/sale-dm-letter/recipients";
import { generateLetters, isSaleDmConfigured, MAX_GENERATE_ITEMS } from "@/lib/sale-dm-letter";
import { SaleDmError } from "@/lib/sale-dm-letter/types";
import { randomBytes } from "crypto";

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 権限ゲート(副作用なし)。dm-export と同一の4種。
    if (!hasPermission(permissions, "property", "read")) throw new ApiError(403, "物件一覧の閲覧権限がありません", "FORBIDDEN");
    if (!hasPermission(permissions, "csv_export", "read")) throw new ApiError(403, "CSV エクスポートの権限がありません", "FORBIDDEN");
    if (!hasPermission(permissions, "csv_export_personal", "read")) throw new ApiError(403, "個人情報を含む出力の権限がありません", "FORBIDDEN");
    if (!hasPermission(permissions, "owner", "read")) throw new ApiError(403, "所有者情報の閲覧権限がありません", "FORBIDDEN");

    const ownerDisplayConfig = await getOwnerDisplayConfig(session.id, permissions);
    if (!isPlainOwnerLevel(ownerDisplayConfig.name) || !isPlainOwnerLevel(ownerDisplayConfig.zip) || !isPlainOwnerLevel(ownerDisplayConfig.address)) {
      throw new ApiError(403, "DM作成に必要な所有者情報(氏名・郵便番号・住所)の表示権限がありません", "FORBIDDEN");
    }

    // env 未設定なら fail-closed(503)。DB に何も書かない。
    if (!isSaleDmConfigured()) throw new ApiError(503, "売却DM生成が未設定です", "NOT_CONFIGURED");

    const body = saleDmCampaignBodySchema.parse(await request.json());
    const query = propertyListQuerySchema.parse(body.filters ?? {});
    const { where, mgmtShortCircuitEmpty } = await buildPropertyListWhere(query, session);
    where.dmStatus = "send";
    where.isArchived = false;
    const orderBy = buildPropertyListOrderBy(query);

    const properties = mgmtShortCircuitEmpty ? [] : await prisma.property.findMany({
      where: {
        ...where,
        AND: [...(where.AND ?? []), { propertyOwners: { some: { owner: { isArchived: false, address: { not: "" } } } } }],
      },
      select: {
        id: true, address: true, propertyType: true, roomNo: true,
        propertyOwners: {
          where: { owner: { isArchived: false } },
          select: { isPrimary: true, relationship: true, owner: { select: { id: true, name: true, nameKana: true, zip: true, address: true, corporateNumber: true } } },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        },
      },
      orderBy,
      take: MAX_GENERATE_ITEMS + 1,
    });

    const { recipients, meta } = buildRecipientsFromProperties(
      properties as never,
      ownerDisplayConfig,
    );

    const { drafts, truncated } = await generateLetters(
      recipients.map((r) => ({ recipient: r, options: body.options })),
    );

    // キャンペーン + 既定型(1つ)+ 宛先下書きを保存(生成成功分のみ body 入り。失敗分は空+メモ)。
    const created = await prisma.$transaction(async (tx) => {
      const campaign = await tx.dmCampaign.create({
        data: { name: body.name, createdBy: session.id, filterSnapshot: body.filters ?? {} },
      });
      const variant = await tx.dmVariant.create({
        data: {
          campaignId: campaign.id, label: "A",
          designTemplate: body.options.designTemplate, tone: body.options.tone,
          length: body.options.length, appeal: body.options.appeal,
          strength: body.options.strength, extraInstruction: body.options.extraInstruction ?? null,
        },
      });
      const sliced = meta.slice(0, drafts.length);
      for (let i = 0; i < sliced.length; i++) {
        const d = drafts[i];
        await tx.dmRecipientDraft.create({
          data: {
            campaignId: campaign.id, variantId: variant.id, propertyId: sliced[i].propertyId,
            representativeOwnerId: sliced[i].representativeOwnerId,
            recipientName: sliced[i].recipientName, recipientZip: sliced[i].recipientZip,
            recipientAddress: sliced[i].recipientAddress, honorific: sliced[i].honorific,
            body: d.body ?? "", model: process.env.SALE_DM_LETTER_MODEL ?? "claude-sonnet-4-6",
            outcomeNote: d.error ? `生成失敗(${d.error})` : null,
            trackingToken: randomBytes(8).toString("base64url"),
            generatedBy: session.id,
          },
        });
      }
      return campaign;
    });

    // AuditLog は非PIIメタのみ(本文・宛名・住所は残さない)。
    await writeAuditLog({
      userId: session.id, action: "sale_dm_campaign_create", targetTable: "dm_campaigns",
      detail: { campaignId: created.id, requested: recipients.length, generated: drafts.length, failed: drafts.filter((d) => d.error).length, truncated, createdAt: new Date().toISOString() },
    });

    return NextResponse.json(
      { campaignId: created.id, generated: drafts.length, failed: drafts.filter((d) => d.error).length, truncated },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SaleDmError && error.code === "NOT_CONFIGURED") {
      return handleApiError(new ApiError(503, "売却DM生成が未設定です", "NOT_CONFIGURED"));
    }
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: route 統合テストを追加(dm-export route と同じ mock 流儀)**

`src/lib/__tests__/sale-dm-campaigns-route.test.ts` に追記(ファイル冒頭で `vi.mock` を宣言。dm-export route test の `vi.mock("next/server"|"@/lib/api-helpers"|"@/lib/audit"|"@/lib/prisma")` をそのまま流用し、`prisma.dmCampaign.create`/`dmVariant.create`/`dmRecipientDraft.create`/`$transaction` を mock する):

```ts
import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(), getOwnerDisplayConfig: vi.fn(),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findMany: vi.fn() },
    dmCampaign: { create: vi.fn() }, dmVariant: { create: vi.fn() }, dmRecipientDraft: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      dmCampaign: { create: vi.fn(async () => ({ id: "c1" })) },
      dmVariant: { create: vi.fn(async () => ({ id: "v1" })) },
      dmRecipientDraft: { create: vi.fn() },
    })),
  },
}));

import { describe as d2, it as i2, expect as e2, beforeEach as b2 } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { POST } from "../../app/api/properties/sale-dm/campaigns/route";

// getUserPermissions は { resource, action, granted } の配列を返す(dm-export route test と同形)。
const grant = (...keys: string[]) => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(
  ["property", "csv_export", "csv_export_personal", "owner"].map((r) => ({ resource: r, action: "read", granted: keys.includes(r) })),
);
const plain = { name: "full", zip: "full", address: "full", nameKana: "full" };
const req = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) });
const validBody = { name: "テスト", options: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", senderName: "△△", senderContact: "000" } };

b2(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_USE_MOCK = "true"; // generation を mock provider + 設定済みに
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue(plain);
  (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany.mockResolvedValue([]);
});

d2("POST /api/properties/sale-dm/campaigns", () => {
  i2("権限不足(property:read なし)で 403・生成も保存もしない", async () => {
    grant("csv_export", "csv_export_personal", "owner");
    const res = await POST(req(validBody) as never);
    e2(res.status).toBe(403);
  });

  i2("0件対象でも 200・campaignId を返す", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner");
    const res = await POST(req(validBody) as never);
    e2(res.status).toBe(200);
    const json = await res.json();
    e2(json.campaignId).toBe("c1");
    e2(res.headers.get("Cache-Control")).toBe("no-store");
  });

  i2("env 未設定(mock off + provider 未設定)で 503", async () => {
    delete process.env.NEXT_PUBLIC_USE_MOCK;
    grant("property", "csv_export", "csv_export_personal", "owner");
    const res = await POST(req(validBody) as never);
    e2(res.status).toBe(503);
  });
});
```

> 注: `getUserPermissions` の戻り値の形・`hasPermission` の引数は dm-export route test の fixture に厳密に合わせること(本リポジトリの permissions 実装に依存)。fixture が合わない場合は dm-export route test の grant ヘルパをコピーして使う。

- [ ] **Step 6: 実行**

Run: `npx vitest run src/lib/__tests__/sale-dm-campaigns-route.test.ts`
Expected: PASS(`buildRecipientsFromProperties` 1 + route 3)。

- [ ] **Step 7: コミット**

```bash
git add src/lib/validators-sale-dm.ts src/lib/sale-dm-letter/recipients.ts src/app/api/properties/sale-dm/campaigns/route.ts src/lib/__tests__/sale-dm-campaigns-route.test.ts
git commit -m "feat(sale-dm): add campaign generate route (gate + recipients + persist)"
```

---

### Task 7: 最小レビューroute(取得・編集・再生成・確定)

**Files:**
- Create: `src/app/api/properties/sale-dm/campaigns/[id]/route.ts`(GET)
- Create: `src/app/api/properties/sale-dm/drafts/[id]/route.ts`(PATCH=本文編集)
- Create: `src/app/api/properties/sale-dm/drafts/[id]/regenerate/route.ts`(POST)
- Create: `src/app/api/properties/sale-dm/drafts/confirm/route.ts`(POST=bulk 確定)
- Test: `src/lib/__tests__/sale-dm-review-routes.test.ts`

**Interfaces:**
- Consumes: 権限ゲート一式(Task 6 と同じ4種+PII)、`generateLetters`/`buildLetterPrompt`(再生成)、prisma モデル。
- Produces: 4 route。すべて `no-store`、PII 権限ゲート、AuditLog は非PIIメタのみ。

- [ ] **Step 1: 失敗するテストを書く(4 route の主要パスのみ)**

`src/lib/__tests__/sale-dm-review-routes.test.ts`(Task 6 と同じ `vi.mock` ブロックを流用し、`prisma.dmRecipientDraft.findUnique/update/updateMany`・`dmCampaign.findUnique`・`dmVariant.findUnique` を mock):

```ts
// vi.mock ブロックは Task 6 のテストと同一(next/server, api-helpers, audit, prisma)。
// prisma mock に dmCampaign.findUnique / dmRecipientDraft.{findUnique,update,updateMany} / dmVariant.findUnique を追加する。

import { describe, it, expect, beforeEach, vi } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET as getCampaign } from "../../app/api/properties/sale-dm/campaigns/[id]/route";
import { PATCH as patchDraft } from "../../app/api/properties/sale-dm/drafts/[id]/route";
import { POST as confirmDrafts } from "../../app/api/properties/sale-dm/drafts/confirm/route";

const pm = prismaMock as never as {
  dmCampaign: { findUnique: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
};
const grant = (...keys: string[]) => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(["property", "csv_export", "csv_export_personal", "owner"].map((r) => ({ resource: r, action: "read", granted: keys.includes(r) })));
const ALL = ["property", "csv_export", "csv_export_personal", "owner"];

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
});

describe("GET campaign", () => {
  it("権限ありで 200・no-store・campaign+drafts を返す", async () => {
    grant(...ALL);
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "x", variants: [], recipients: [{ id: "r1", body: "本文" }] });
    const res = await getCampaign(new Request("http://x") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("権限不足で 403", async () => {
    grant("property");
    const res = await getCampaign(new Request("http://x") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(403);
  });
});

describe("PATCH draft (本文編集)", () => {
  it("body を更新し 200", async () => {
    grant(...ALL);
    pm.dmRecipientDraft.update.mockResolvedValue({ id: "r1", body: "編集後" });
    const res = await patchDraft(new Request("http://x", { method: "PATCH", body: JSON.stringify({ body: "編集後" }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.update).toHaveBeenCalled();
  });
});

describe("POST confirm (bulk)", () => {
  it("指定 id を confirmed にし 200", async () => {
    grant(...ALL);
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 2 });
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids: ["r1", "r2"] }) }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(2);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-review-routes.test.ts`
Expected: FAIL(route 未実装)。

- [ ] **Step 3: 共通の権限ゲートを小さなヘルパに切り出す**

`src/lib/sale-dm-letter/route-guard.ts`:

```ts
import { getApiSession, getUserPermissions, getOwnerDisplayConfig, ApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { isPlainOwnerLevel } from "@/lib/dm-export";

// 4権限 + PII生値レベルを確認し session を返す。不足は ApiError(403) throw(副作用なし)。
export async function requireSaleDmAccess() {
  const session = await getApiSession();
  const permissions = await getUserPermissions(session.id);
  for (const [res, msg] of [
    ["property", "物件一覧の閲覧権限がありません"],
    ["csv_export", "CSV エクスポートの権限がありません"],
    ["csv_export_personal", "個人情報を含む出力の権限がありません"],
    ["owner", "所有者情報の閲覧権限がありません"],
  ] as const) {
    if (!hasPermission(permissions, res, "read")) throw new ApiError(403, msg, "FORBIDDEN");
  }
  const cfg = await getOwnerDisplayConfig(session.id, permissions);
  if (!isPlainOwnerLevel(cfg.name) || !isPlainOwnerLevel(cfg.zip) || !isPlainOwnerLevel(cfg.address)) {
    throw new ApiError(403, "DM作成に必要な所有者情報の表示権限がありません", "FORBIDDEN");
  }
  return { session, permissions, ownerDisplayConfig: cfg };
}
```

> リファクタ: Task 6 の route も `requireSaleDmAccess()` を使うよう置き換えてよい(DRY)。置き換える場合は Task 6 のテストを再実行して緑を確認すること。

- [ ] **Step 4: 4 route を実装**

`src/app/api/properties/sale-dm/campaigns/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSaleDmAccess();
    const { id } = await params;
    const campaign = await prisma.dmCampaign.findUnique({
      where: { id },
      include: { variants: true, recipients: { orderBy: { createdAt: "asc" } } },
    });
    if (!campaign) return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ campaign }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
```

`src/app/api/properties/sale-dm/drafts/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";

const patchSchema = z.object({ body: z.string().min(1) });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSaleDmAccess();
    const { id } = await params;
    const { body } = patchSchema.parse(await request.json());
    const updated = await prisma.dmRecipientDraft.update({ where: { id }, data: { body } });
    return NextResponse.json({ id: updated.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
```

`src/app/api/properties/sale-dm/drafts/[id]/regenerate/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { isSaleDmConfigured, generateLetters } from "@/lib/sale-dm-letter";
import { resolveSender } from "@/lib/sale-dm-letter/sender";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSaleDmAccess();
    if (!isSaleDmConfigured()) throw new ApiError(503, "売却DM生成が未設定です", "NOT_CONFIGURED");
    const { id } = await params;
    const draft = await prisma.dmRecipientDraft.findUnique({ where: { id }, include: { variant: true, property: { select: { address: true, propertyType: true, roomNo: true } } } });
    if (!draft) throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");
    const v = draft.variant;
    const sender = resolveSender();
    const { drafts } = await generateLetters([{
      recipient: {
        representativeName: draft.recipientName, honorific: draft.honorific, coOwnerCount: 1,
        propertyAddress: draft.property.address, propertyTypeLabel: PROPERTY_TYPE_LABELS[draft.property.propertyType] ?? draft.property.propertyType, roomNo: draft.property.roomNo,
      },
      options: { designTemplate: v.designTemplate, tone: v.tone, length: v.length, appeal: v.appeal, strength: v.strength, senderName: sender.senderName, senderContact: sender.senderContact, extraInstruction: v.extraInstruction ?? undefined },
    }]);
    const body = drafts[0]?.body;
    if (!body) throw new ApiError(502, "再生成に失敗しました", "GENERATION_FAILED");
    await prisma.dmRecipientDraft.update({ where: { id }, data: { body } });
    return NextResponse.json({ id, body }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
```

差出人ヘルパ `src/lib/sale-dm-letter/sender.ts`(再生成・Plan 2 印刷で共有。Task 7 より前=このタスク内で作る):

```ts
export interface SaleDmSender { senderName: string; senderContact: string }

// 差出人(自社)既定。env から読む(未設定はプレースホルダ)。生成 route は UI 入力(body.options)を
// 優先し、UI 入力が無い経路(再生成・印刷)ではこの既定を使う。
export function resolveSender(): SaleDmSender {
  return {
    senderName: process.env.SALE_DM_SENDER_NAME ?? "(差出人名 未設定)",
    senderContact: process.env.SALE_DM_SENDER_CONTACT ?? "",
  };
}
```

`src/app/api/properties/sale-dm/drafts/confirm/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";

const confirmSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });

export async function POST(request: NextRequest) {
  try {
    const { session } = await requireSaleDmAccess();
    const { ids } = confirmSchema.parse(await request.json());
    const result = await prisma.dmRecipientDraft.updateMany({
      where: { id: { in: ids }, status: "draft" },
      data: { status: "confirmed", confirmedAt: new Date() },
    });
    await writeAuditLog({ userId: session.id, action: "sale_dm_drafts_confirm", targetTable: "dm_recipient_drafts", detail: { count: result.count, confirmedAt: new Date().toISOString() } });
    return NextResponse.json({ count: result.count }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-review-routes.test.ts`
Expected: PASS(GET 2 + PATCH 1 + confirm 1)。

- [ ] **Step 6: 全テスト + lint + build を確認**

Run: `npm test` → 既存 + 新規すべて green。
Run: `npm run lint` → エラーなし。
Run: `npm run build` → 成功(route が manifest に出る)。

- [ ] **Step 7: コミット**

```bash
git add src/lib/sale-dm-letter/route-guard.ts src/app/api/properties/sale-dm src/lib/__tests__/sale-dm-review-routes.test.ts
git commit -m "feat(sale-dm): add review routes (get campaign / edit / regenerate / confirm)"
```

---

## Self-Review(本プラン → 設計書の突合)

- 生成(AIサーバー側・fail-closed・mock/claude切替): Task 4,5,6 ✅
- データモデル(キャンペーン/型/宛先・PII分離・migration): Task 1 ✅(配達/反響/追跡の列は将来プランで使うが schema は本プランで先に用意=後続の migration を増やさない)
- 宛名=このシステムの所有者データ(代表者/敬称/同住所まとめ再利用): Task 6 `buildRecipientsFromProperties` ✅
- 権限ゲート4種+PII生値+no-store+AuditLog非PII: Task 6,7 ✅
- 件数上限→truncated(400でなく): Task 5,6 ✅
- 失敗時の部分継続: Task 5 ✅
- **未カバー(意図的に後続プラン)**: デザイン/印刷/CSV(P2)・複数型と割当(P3)・配達/反響/宛先不明連動/集計(P4)・LP追跡/公開エンドポイント/proxy.ts(P5)・物件一覧反映/作業画面(P6)。`trackingToken` は本プランで生成だけ行い、`/t/[token]` は P5。
- Placeholder スキャン: なし(各 step に実コード/実コマンド)。
- 型整合: `LetterRecipient`/`LetterOptions`/`BuiltPrompt`/`LetterProvider`/`SaleDmError`/`GeneratedDraft` を Task 2,5 で定義し Task 3-7 で同名使用 ✅。

> 実装時確認点(裏取り反映済): (1) ✅ `groupPropertyOwnersByAddress`→`{groups: DmRowPropertyOwner[][]}` + `selectGroupRepresentative(group)` + `honorificForOwner(name, hasCorporateNumber)` に修正済み。(2) ✅ `getUserPermissions` は `{resource,action,granted}[]` を返す→テスト fixture は配列形(grant ヘルパに反映済み)。(3) `OwnerDisplayConfig` のキー(name/zip/address/nameKana 等)を `api-helpers` で最終確認(本プランは name/zip/address のみ参照)。
