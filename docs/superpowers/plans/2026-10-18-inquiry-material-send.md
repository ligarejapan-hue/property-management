# 反響の受付から資料を送る Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「資料請求」の反響から、物件の添付ファイルを付けたメールを業者の問い合わせ者へ直接送り、送った記録を残して反響を自動で「対応済み」にする。

**Architecture:** 送ってよい添付の判定・文面の差し込み・二重送信の判定を純関数(`src/lib/agent-inquiry/material-send.ts`)に集め、一覧 API と送信 API の両方がそれを通す。送信は要求の中で同期的に行い(待ち行列なし)、送る前に `sending` の行を一意制約で予約して二重送信を防ぐ。画面は自己完結の小窓 `MaterialSendDialog` を、受付の窓の反響詳細と物件画面の反響タブの両方から開く。

**Tech Stack:** Next.js 16 App Router / Prisma 7 (PostgreSQL) / nodemailer 10 / zod / vitest + Testing Library / Tailwind

**Spec:** `docs/superpowers/specs/2026-10-18-inquiry-material-send-design.md`

## Global Constraints

- 送るのは物件の添付(`attachments` の `targetType="property"`)だけ。システムの販売図面は使わない。
- 種類の許可リスト = `general`・`registry` だけ。`isOwnerPiiDocumentType(type)` が真のもの(`referral`・`report`)は出さない・送らない。
- 謄本(`registry`)は `registry_pdf:preview` と `registry_pdf:download` の両方がある人だけ。選ぶと黄色の注意「所有者の名前・住所が載っています。送ってよい相手か確かめてください」。
- 合計 20MB(`20 * 1024 * 1024` バイト)まで・1回 1〜20 ファイル・宛先は1件だけ・件名 200 字・本文 10,000 字。
- BCC/CC は付けない。
- 送れる人 = `agent_inquiry:write` + 物件を開ける人(`assertPropertyReadable`)。
- 成功で反響を `done` に(既に `done` なら変えない)・`version` を1つ進める。失敗では状態を変えない。
- 差し込みは `{物件名}` `{会社名}` `{担当者名}` `{自分の名前}` の4つだけ。担当者名が空なら「ご担当者」。
- 既定の件名 `【資料送付】{物件名}`、既定の本文は spec §4.2 の文。
- SMTP の生メッセージ・パスワードは応答・ログ・DB に出さない(`safeErrorCode` の許可リストだけ)。
- migration は追加だけ・1本。
- 返答・画面の文言は平易な日本語。
- 業務ルール違反は `ApiError(400, …)`、zod の入力エラーは既存どおり 422(`handleApiError`)。

## Review Focus

1. 小窓を開いたあとで、別の人がその添付をゴミ箱に入れた/種類を変えた → 送信時の読み直しで弾き、何も送らない(Task 5 のテストで固定)。
2. 送信中に通信が切れて利用者がもう一度押す → 同じ `clientToken` なら2通目を出さず「送信中」/前回の結果を返す(Task 5)。
3. 宛先に `a@x.jp, b@y.jp` や改行入りを入れる → 400 で弾く(Task 2 の `isSingleAddress`)。
4. ひな形に `{物件名}` を2回書く・知らない `{xxx}` を書く → 全部置き換え/知らないものはそのまま残す(Task 2)。
5. 送信は成功したが、反響を `done` にする更新が他の人の更新とぶつかる → 送信の記録は必ず残り、状態は `done` になる(version を見ない更新・Task 5)。

---

## ファイル構成

| ファイル | 役割 |
|---|---|
| `prisma/schema.prisma`(変更) | `AgentInquiryMaterialSend` モデル・`MaterialSendResult` enum・`MailConfig` に2列 |
| `prisma/migrations/20261018120000_add_agent_inquiry_material_sends/migration.sql`(新規) | 上の追加だけの SQL |
| `src/lib/agent-inquiry/material-send.ts`(新規) | 純関数: 判定・上限・差し込み・宛先・送信中の古さ |
| `src/lib/mail/transport.ts`(変更) | `sendMailWithAttachments` を足す |
| `src/app/api/admin/mail-settings/route.ts`(変更) | ひな形の2欄の読み書き |
| `src/app/(dashboard)/admin/mail-settings/page.tsx`(変更) | ひな形の2欄 |
| `src/app/api/agent-inquiries/[id]/material-candidates/route.ts`(新規) | 送ってよい添付+初期文面 |
| `src/app/api/agent-inquiries/[id]/material-sends/route.ts`(新規) | 記録の一覧(GET)・送信(POST) |
| `src/lib/api-client.ts`(変更) | 3つの呼び出しと型 |
| `src/components/agent-inquiry/material-send-dialog.tsx`(新規) | 小窓と送った記録の一覧 |
| `src/components/agent-inquiry/inquiry-detail.tsx`(変更) | 資料請求のときボタン+記録 |
| `src/components/properties/agent-inquiry-tab.tsx`(変更) | 資料請求の行にボタン |
| `docs/` と `public/docs/` のガイド・マニュアル(変更) | 「資料を送る」の節 |

テストはすべて `src/lib/__tests__/` と `src/components/**/__tests__/` の既存の並びに置く。

---

### Task 1: データの追加(migration 1本)

**Files:**
- Modify: `prisma/schema.prisma`(`model AgentInquiry` の近く・`model MailConfig`)
- Create: `prisma/migrations/20261018120000_add_agent_inquiry_material_sends/migration.sql`
- Test: `src/lib/__tests__/agent-inquiry-material-send-migration-scan.test.ts`

**Interfaces:**
- Produces: Prisma の `prisma.agentInquiryMaterialSend`(列: `id, inquiryId, sentById, toAddress, subject, body, attachments(Json), totalSize, result("sending"|"sent"|"failed"), errorCode, clientToken, createdAt, finishedAt`)、`MailConfig.materialSendSubject` / `materialSendBody`。

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const sql = read("prisma/migrations/20261018120000_add_agent_inquiry_material_sends/migration.sql");

describe("資料送付 migration(spec §5)", () => {
  it("enum と表を作る", () => {
    expect(sql).toMatch(/CREATE TYPE "MaterialSendResult" AS ENUM \('sending', 'sent', 'failed'\);/);
    expect(sql).toMatch(/CREATE TABLE "agent_inquiry_material_sends"/);
  });
  it("反響・送った人へは RESTRICT", () => {
    expect(sql).toMatch(/"agent_inquiry_material_sends_inquiry_id_fkey" FOREIGN KEY \("inquiry_id"\) REFERENCES "agent_inquiries"\("id"\) ON DELETE RESTRICT/);
    expect(sql).toMatch(/"agent_inquiry_material_sends_sent_by_id_fkey" FOREIGN KEY \("sent_by_id"\) REFERENCES "users"\("id"\) ON DELETE RESTRICT/);
  });
  it("押し直しの鍵は送った人ごとに一意・反響×日時の索引", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "agent_inquiry_material_sends_sent_by_id_client_token_key" ON "agent_inquiry_material_sends"\("sent_by_id", "client_token"\);/);
    expect(sql).toMatch(/CREATE INDEX "agent_inquiry_material_sends_inquiry_id_created_at_idx" ON "agent_inquiry_material_sends"\("inquiry_id", "created_at"\);/);
  });
  it("メール設定にひな形の2列(null 可)", () => {
    expect(sql).toMatch(/ALTER TABLE "mail_config" ADD COLUMN "material_send_subject" TEXT,\s*ADD COLUMN "material_send_body" TEXT;/);
  });
  it("足すだけ(消す・型を変える・NOT NULL 化をしない)", () => {
    expect(sql).not.toMatch(/DROP |ALTER COLUMN|SET NOT NULL/);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/__tests__/agent-inquiry-material-send-migration-scan.test.ts`
Expected: FAIL(ファイルが無い ENOENT)

- [ ] **Step 3: schema.prisma に足す**

`enum ViewingType` の後に:

```prisma
enum MaterialSendResult {
  sending
  sent
  failed
}
```

`model AgentInquiry` の関連に1行足す: `materialSends AgentInquiryMaterialSend[]`

`model AgentInquiry` の後に:

```prisma
/// 資料請求への資料送付メール(2026-10-18)。1回送るごとに1行。ファイルの中身は持たない(名前と大きさだけ)。
model AgentInquiryMaterialSend {
  id          String             @id @default(uuid()) @db.Uuid
  inquiryId   String             @map("inquiry_id") @db.Uuid
  sentById    String             @map("sent_by_id") @db.Uuid
  toAddress   String             @map("to_address")
  subject     String
  body        String
  /// [{attachmentId, fileName, fileSize, type}]
  attachments Json               @db.JsonB
  totalSize   Int                @map("total_size")
  /// sending=送る前の予約(二重送信の防止)。sent/failed=結果。
  result      MaterialSendResult @default(sending)
  /// 失敗の短いコード(safeErrorCode の許可リストだけ)。SMTP の生メッセージは入れない。
  errorCode   String?            @map("error_code")
  clientToken String             @map("client_token") @db.Uuid
  createdAt   DateTime           @default(now()) @map("created_at")
  finishedAt  DateTime?          @map("finished_at")

  inquiry AgentInquiry @relation(fields: [inquiryId], references: [id], onDelete: Restrict)
  sentBy  User         @relation("AgentInquiryMaterialSendSentBy", fields: [sentById], references: [id], onDelete: Restrict)

  @@unique([sentById, clientToken])
  @@index([inquiryId, createdAt])
  @@map("agent_inquiry_material_sends")
}
```

`model User` の関連に1行: `materialSends AgentInquiryMaterialSend[] @relation("AgentInquiryMaterialSendSentBy")`

`model MailConfig` の `inquiryAutoReplyBody` の後に:

```prisma
  // 資料請求への資料送付メールのひな形(2026-10-18)。未入力(null)なら既定の文面。
  materialSendSubject     String? @map("material_send_subject")
  materialSendBody        String? @map("material_send_body")
```

- [ ] **Step 4: migration.sql を書く**

```sql
-- 資料請求への資料送付メールの記録と、メール設定のひな形2列(2026-10-18 発注者承認)。足すだけ。
CREATE TYPE "MaterialSendResult" AS ENUM ('sending', 'sent', 'failed');

CREATE TABLE "agent_inquiry_material_sends" (
    "id" UUID NOT NULL,
    "inquiry_id" UUID NOT NULL,
    "sent_by_id" UUID NOT NULL,
    "to_address" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attachments" JSONB NOT NULL,
    "total_size" INTEGER NOT NULL,
    "result" "MaterialSendResult" NOT NULL DEFAULT 'sending',
    "error_code" TEXT,
    "client_token" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    CONSTRAINT "agent_inquiry_material_sends_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_inquiry_material_sends_sent_by_id_client_token_key" ON "agent_inquiry_material_sends"("sent_by_id", "client_token");
CREATE INDEX "agent_inquiry_material_sends_inquiry_id_created_at_idx" ON "agent_inquiry_material_sends"("inquiry_id", "created_at");
ALTER TABLE "agent_inquiry_material_sends" ADD CONSTRAINT "agent_inquiry_material_sends_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "agent_inquiries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_inquiry_material_sends" ADD CONSTRAINT "agent_inquiry_material_sends_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "mail_config" ADD COLUMN "material_send_subject" TEXT,
ADD COLUMN "material_send_body" TEXT;
```

- [ ] **Step 5: テストと型を通す**

Run: `npx vitest run src/lib/__tests__/agent-inquiry-material-send-migration-scan.test.ts && npx prisma generate && npx prisma validate`
Expected: PASS・`The schema ... is valid`
※ schema と migration のずれを調べるテスト(`*schema*drift*` など既存のものがあれば)も `npx vitest run src/lib/__tests__ -t migration` で通ることを確かめる。

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261018120000_add_agent_inquiry_material_sends src/lib/__tests__/agent-inquiry-material-send-migration-scan.test.ts
git commit -m "feat(反響): 資料送付の記録の表とメール設定のひな形2列(migration 1本・足すだけ)"
```

---

### Task 2: 純関数(判定・上限・差し込み・宛先)

**Files:**
- Create: `src/lib/agent-inquiry/material-send.ts`
- Test: `src/lib/__tests__/agent-inquiry-material-send.test.ts`

**Interfaces:**
- Consumes: `isOwnerPiiDocumentType`(`@/lib/uploads-authorization`)、`hasPermission`(`@/lib/permissions`)、`PermissionEntry`(`@/lib/api-helpers`)
- Produces:
  - `MATERIAL_SEND_LIMITS = { maxTotalBytes: 20971520, maxFiles: 20, subject: 200, body: 10000 }`
  - `type MaterialAttachmentRow = { id: string; targetType: string; targetId: string; type: string; isDeleted: boolean; fileName: string; fileSize: number; fileUrl: string; mimeType: string; createdAt: Date }`
  - `selectableForMaterialSend(a: MaterialAttachmentRow, propertyId: string, perms: PermissionEntry[]): boolean`
  - `checkMaterialSelection(rows: MaterialAttachmentRow[], requestedIds: string[], propertyId: string, perms: PermissionEntry[]): { ok: true; rows: MaterialAttachmentRow[]; totalSize: number } | { ok: false; code: "NOT_SELECTABLE" | "TOO_LARGE" | "NO_FILES" | "TOO_MANY" }`
  - `DEFAULT_MATERIAL_SUBJECT`、`DEFAULT_MATERIAL_BODY`
  - `fillMaterialTemplate(tpl: string, v: { propertyName: string; companyName: string; contactName: string | null; senderName: string }): string`
  - `propertyDisplayName(p: { name: string | null; roomNo: string | null; town: string | null }): string`
  - `isSingleAddress(to: string): boolean`
  - `SENDING_STALE_MS = 10 * 60 * 1000`、`sendStateLabel(row: { result: "sending" | "sent" | "failed"; createdAt: Date | string }, now: Date): "送信中" | "結果不明" | "送信済み" | "送れなかった"`
  - `REGISTRY_WARNING = "所有者の名前・住所が載っています。送ってよい相手か確かめてください"`

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect } from "vitest";
import {
  MATERIAL_SEND_LIMITS,
  selectableForMaterialSend,
  checkMaterialSelection,
  fillMaterialTemplate,
  propertyDisplayName,
  isSingleAddress,
  sendStateLabel,
  DEFAULT_MATERIAL_SUBJECT,
  type MaterialAttachmentRow,
} from "@/lib/agent-inquiry/material-send";

const PID = "11111111-1111-4111-8111-111111111111";
const row = (o: Partial<MaterialAttachmentRow> = {}): MaterialAttachmentRow => ({
  id: "a1", targetType: "property", targetId: PID, type: "general", isDeleted: false,
  fileName: "図面.pdf", fileSize: 1000, fileUrl: "/uploads/attachments/x.pdf", mimeType: "application/pdf",
  createdAt: new Date("2026-10-01T00:00:00Z"), ...o,
});
const perm = (...pairs: [string, string][]) => pairs.map(([resource, action]) => ({ resource, action, granted: true }));
const REG = perm(["registry_pdf", "preview"], ["registry_pdf", "download"]);

describe("送ってよい添付(spec §3)", () => {
  it("ふつうの添付は送れる", () => expect(selectableForMaterialSend(row(), PID, [])).toBe(true));
  it("反響資料・査定報告書は送れない", () => {
    expect(selectableForMaterialSend(row({ type: "referral" }), PID, REG)).toBe(false);
    expect(selectableForMaterialSend(row({ type: "report" }), PID, REG)).toBe(false);
  });
  it("知らない種類は送れない(許可リスト)", () => expect(selectableForMaterialSend(row({ type: "photo" }), PID, REG)).toBe(false));
  it("削除済み・別の物件・物件以外は送れない", () => {
    expect(selectableForMaterialSend(row({ isDeleted: true }), PID, [])).toBe(false);
    expect(selectableForMaterialSend(row({ targetId: "other" }), PID, [])).toBe(false);
    expect(selectableForMaterialSend(row({ targetType: "owner" }), PID, [])).toBe(false);
  });
  it("謄本は preview と download の両方が要る", () => {
    expect(selectableForMaterialSend(row({ type: "registry" }), PID, REG)).toBe(true);
    expect(selectableForMaterialSend(row({ type: "registry" }), PID, perm(["registry_pdf", "preview"]))).toBe(false);
    expect(selectableForMaterialSend(row({ type: "registry" }), PID, [])).toBe(false);
  });
});

describe("選んだ添付の確かめ", () => {
  it("1つも無いと NO_FILES", () => expect(checkMaterialSelection([], [], PID, [])).toEqual({ ok: false, code: "NO_FILES" }));
  it("21個は TOO_MANY", () => {
    const ids = Array.from({ length: 21 }, (_, i) => `a${i}`);
    expect(checkMaterialSelection(ids.map((id) => row({ id })), ids, PID, [])).toEqual({ ok: false, code: "TOO_MANY" });
  });
  it("頼んだ ID が DB に無い(他の物件・消えた)なら NOT_SELECTABLE", () => {
    expect(checkMaterialSelection([row()], ["a1", "zz"], PID, [])).toEqual({ ok: false, code: "NOT_SELECTABLE" });
  });
  it("1つでも送れないものが混ざれば NOT_SELECTABLE", () => {
    expect(checkMaterialSelection([row(), row({ id: "a2", type: "referral" })], ["a1", "a2"], PID, REG))
      .toEqual({ ok: false, code: "NOT_SELECTABLE" });
  });
  it("合計がちょうど 20MB は通る・1バイト超えると TOO_LARGE", () => {
    const max = MATERIAL_SEND_LIMITS.maxTotalBytes;
    expect(checkMaterialSelection([row({ fileSize: max })], ["a1"], PID, [])).toMatchObject({ ok: true, totalSize: max });
    expect(checkMaterialSelection([row({ fileSize: max - 10 }), row({ id: "a2", fileSize: 11 })], ["a1", "a2"], PID, []))
      .toEqual({ ok: false, code: "TOO_LARGE" });
  });
  it("通ったら頼んだ順で返す", () => {
    const r = checkMaterialSelection([row({ id: "a1" }), row({ id: "a2" })], ["a2", "a1"], PID, []);
    expect(r.ok && r.rows.map((x) => x.id)).toEqual(["a2", "a1"]);
  });
});

describe("文面の差し込み(spec §4)", () => {
  const v = { propertyName: "サンプル荘 101", companyName: "△△不動産", contactName: null, senderName: "山田" };
  it("4つを全部置き換え・同じものが2回でも全部", () => {
    expect(fillMaterialTemplate("{物件名}/{物件名} {会社名} {担当者名} {自分の名前}", v))
      .toBe("サンプル荘 101/サンプル荘 101 △△不動産 ご担当者 山田");
  });
  it("知らない差し込みはそのまま", () => expect(fillMaterialTemplate("{住所}", v)).toBe("{住所}"));
  it("既定の件名", () => expect(fillMaterialTemplate(DEFAULT_MATERIAL_SUBJECT, v)).toBe("【資料送付】サンプル荘 101"));
  it("物件名=名前+部屋番号・名前が無ければ所在地", () => {
    expect(propertyDisplayName({ name: "サンプル荘", roomNo: "101", town: "品川区" })).toBe("サンプル荘 101");
    expect(propertyDisplayName({ name: null, roomNo: null, town: "品川区南品川" })).toBe("品川区南品川");
  });
});

describe("宛先は1件だけ", () => {
  it.each([["a@example.jp", true], ["a@x.jp, b@y.jp", false], ["a@x.jp\nBcc: c@z.jp", false], ["a@x.jp;b@y.jp", false], ["", false], ["山田 <a@x.jp>", false]])(
    "%s → %s",
    (to, ok) => expect(isSingleAddress(to)).toBe(ok),
  );
});

describe("記録の表示", () => {
  const now = new Date("2026-10-18T10:00:00Z");
  it("送信中は10分を過ぎると結果不明", () => {
    expect(sendStateLabel({ result: "sending", createdAt: new Date("2026-10-18T09:55:00Z") }, now)).toBe("送信中");
    expect(sendStateLabel({ result: "sending", createdAt: new Date("2026-10-18T09:49:59Z") }, now)).toBe("結果不明");
  });
  it("sent/failed", () => {
    expect(sendStateLabel({ result: "sent", createdAt: now }, now)).toBe("送信済み");
    expect(sendStateLabel({ result: "failed", createdAt: now }, now)).toBe("送れなかった");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/__tests__/agent-inquiry-material-send.test.ts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装する**

```ts
import { z } from "zod";
import type { PermissionEntry } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { isOwnerPiiDocumentType } from "@/lib/uploads-authorization";

/** 資料送付の上限(spec §2.2・§6)。相手のメールの受け取りが多くは 20〜25MB で止まるため合計 20MB。 */
export const MATERIAL_SEND_LIMITS = { maxTotalBytes: 20 * 1024 * 1024, maxFiles: 20, subject: 200, body: 10_000 } as const;

export const REGISTRY_WARNING = "所有者の名前・住所が載っています。送ってよい相手か確かめてください";

export type MaterialAttachmentRow = {
  id: string;
  targetType: string;
  targetId: string;
  type: string;
  isDeleted: boolean;
  fileName: string;
  fileSize: number;
  fileUrl: string;
  mimeType: string;
  createdAt: Date;
};

/** 送ってよい種類(許可リスト)。⚠所有者の個人情報が載った書類は種類が増えても isOwnerPiiDocumentType で外す。 */
const SENDABLE_TYPES: ReadonlySet<string> = new Set(["general", "registry"]);

/** その物件の、送ってよい添付か(spec §3)。画面の一覧と送信の両方がこれを通す。 */
export function selectableForMaterialSend(a: MaterialAttachmentRow, propertyId: string, perms: PermissionEntry[]): boolean {
  if (a.isDeleted || a.targetType !== "property" || a.targetId !== propertyId) return false;
  if (isOwnerPiiDocumentType(a.type) || !SENDABLE_TYPES.has(a.type)) return false;
  // 謄本を送る=写しを渡す=ダウンロードと同じ扱い(uploads-authorization の preview+download と同じ線)。
  if (a.type === "registry") {
    return hasPermission(perms, "registry_pdf", "preview") && hasPermission(perms, "registry_pdf", "download");
  }
  return true;
}

export type MaterialSelectionResult =
  | { ok: true; rows: MaterialAttachmentRow[]; totalSize: number }
  | { ok: false; code: "NOT_SELECTABLE" | "TOO_LARGE" | "NO_FILES" | "TOO_MANY" };

/** 送信の直前に、DB から読み直した行で頼まれた ID を確かめる(1つでもだめなら何も送らない)。 */
export function checkMaterialSelection(
  rows: MaterialAttachmentRow[],
  requestedIds: string[],
  propertyId: string,
  perms: PermissionEntry[],
): MaterialSelectionResult {
  if (requestedIds.length === 0) return { ok: false, code: "NO_FILES" };
  if (requestedIds.length > MATERIAL_SEND_LIMITS.maxFiles) return { ok: false, code: "TOO_MANY" };
  const byId = new Map(rows.map((r) => [r.id, r]));
  const picked: MaterialAttachmentRow[] = [];
  for (const id of requestedIds) {
    const r = byId.get(id);
    if (!r || !selectableForMaterialSend(r, propertyId, perms)) return { ok: false, code: "NOT_SELECTABLE" };
    picked.push(r);
  }
  const totalSize = picked.reduce((s, r) => s + r.fileSize, 0);
  if (totalSize > MATERIAL_SEND_LIMITS.maxTotalBytes) return { ok: false, code: "TOO_LARGE" };
  return { ok: true, rows: picked, totalSize };
}

export const DEFAULT_MATERIAL_SUBJECT = "【資料送付】{物件名}";
export const DEFAULT_MATERIAL_BODY = [
  "{会社名}",
  "{担当者名} 様",
  "",
  "お世話になっております。",
  "お問い合わせいただきました「{物件名}」の資料をお送りいたします。",
  "ご確認のほど、よろしくお願いいたします。",
  "",
  "{自分の名前}",
].join("\n");

/** 差し込みは決まった4つだけ。知らない {…} はそのまま残す。 */
export function fillMaterialTemplate(
  tpl: string,
  v: { propertyName: string; companyName: string; contactName: string | null; senderName: string },
): string {
  const map: Record<string, string> = {
    "{物件名}": v.propertyName,
    "{会社名}": v.companyName,
    "{担当者名}": v.contactName?.trim() || "ご担当者",
    "{自分の名前}": v.senderName,
  };
  return tpl.replace(/\{(物件名|会社名|担当者名|自分の名前)\}/g, (m) => map[m]);
}

export function propertyDisplayName(p: { name: string | null; roomNo: string | null; town: string | null }): string {
  const name = p.name?.trim();
  if (name) return p.roomNo ? `${name} ${p.roomNo}` : name;
  return p.town?.trim() || "物件";
}

/** 宛先は正しい形式のアドレス1件だけ(カンマ・セミコロン・改行・表示名つきは受けない=ヘッダ注入の多層防御)。 */
export function isSingleAddress(to: string): boolean {
  if (/[\r\n,;<>\s]/.test(to)) return false;
  return z.string().email().max(254).safeParse(to).success;
}

export const SENDING_STALE_MS = 10 * 60 * 1000;

export function sendStateLabel(
  row: { result: "sending" | "sent" | "failed"; createdAt: Date | string },
  now: Date,
): "送信中" | "結果不明" | "送信済み" | "送れなかった" {
  if (row.result === "sent") return "送信済み";
  if (row.result === "failed") return "送れなかった";
  return now.getTime() - new Date(row.createdAt).getTime() > SENDING_STALE_MS ? "結果不明" : "送信中";
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/__tests__/agent-inquiry-material-send.test.ts`
Expected: PASS
※ `uploads-authorization` を import すると prisma を読み込む。テストが DB 接続で落ちる場合は、テスト先頭に `vi.mock("@/lib/prisma", () => ({ default: {} }))` を足す。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-inquiry/material-send.ts src/lib/__tests__/agent-inquiry-material-send.test.ts
git commit -m "feat(反響): 資料送付の判定・上限・文面の差し込みを純関数に"
```

---

### Task 3: 添付つきメールの送信

**Files:**
- Modify: `src/lib/mail/transport.ts`
- Test: `src/lib/__tests__/mail-transport-attachments.test.ts`

**Interfaces:**
- Produces:
  - `interface MailAttachment { filename: string; content: Buffer; contentType: string }`
  - `interface AttachmentMail extends PlainMail { attachments: MailAttachment[] }`
  - `sendMailWithAttachments(config: MailSendConfig, mail: AttachmentMail): Promise<SendResult>`(throw しない)
  - テスト用 `setMailSenderForTest` の差し替え関数は `(config, mail: PlainMail | AttachmentMail) => Promise<void>` を受ける

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { sendMailWithAttachments, setMailSenderForTest } from "@/lib/mail/transport";

const config = { host: "h", port: 465, secure: true, user: "u", pass: "p", from: "info@example.jp", appBaseUrl: null, inquiryMailDetail: "minimal" as const };
afterEach(() => setMailSenderForTest(null));

describe("添付つきの送信", () => {
  it("件名の改行を除き・添付をそのまま渡す", async () => {
    const seen = vi.fn(async () => {});
    setMailSenderForTest(seen);
    const r = await sendMailWithAttachments(config, {
      to: "a@x.jp", subject: "件名\r\nBcc: z@z.jp", text: "本文",
      attachments: [{ filename: "図面.pdf", content: Buffer.from("x"), contentType: "application/pdf" }],
    });
    expect(r).toEqual({ ok: true });
    const mail = (seen.mock.calls[0] as unknown[])[1] as { subject: string; attachments: unknown[] };
    expect(mail.subject).toBe("件名Bcc: z@z.jp");
    expect(mail.attachments).toHaveLength(1);
  });
  it("失敗は throw せず code だけ返す(メッセージは出さない)", async () => {
    setMailSenderForTest(async () => { throw Object.assign(new Error("550 secret@x.jp rejected"), { code: "EENVELOPE" }); });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendMailWithAttachments(config, { to: "a@x.jp", subject: "s", text: "t", attachments: [] }))
      .toEqual({ ok: false, code: "EENVELOPE" });
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret@x.jp");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/__tests__/mail-transport-attachments.test.ts`
Expected: FAIL(`sendMailWithAttachments` が無い)

- [ ] **Step 3: 実装する(既存の守りを共有)**

`transport.ts` を次の形にする(既存の `sendPlainMail` の外からの振る舞いは変えない):

```ts
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}
export interface AttachmentMail extends PlainMail {
  attachments: MailAttachment[];
}

type Sender = (config: MailSendConfig, mail: PlainMail | AttachmentMail) => Promise<void>;
```

`realSender` の `sendMail` 呼び出しを:

```ts
  await transporter.sendMail({
    from: config.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    ...("attachments" in mail ? { attachments: mail.attachments } : {}),
  });
```

`sendPlainMail` の本体を共通関数に移して両方から呼ぶ:

```ts
async function sendSafely(config: MailSendConfig, mail: PlainMail | AttachmentMail): Promise<SendResult> {
  const safe = { ...mail, subject: mail.subject.replace(/[\r\n]+/g, "") };
  try {
    await (senderOverride ?? realSender)(config, safe);
    return { ok: true };
  } catch (err) {
    const code = safeErrorCode(err);
    console.error("[mail] send failed", { name: err instanceof Error ? err.name : "Unknown", code });
    return { ok: false, code };
  }
}

// 1通送る。throw しない。件名の改行は除く(ヘッダ注入の多層防御)。
// ⚠失敗の message は SMTP 応答・宛先を含み得るので出さない(name/code の許可リストだけ)。
export async function sendPlainMail(config: MailSendConfig, mail: PlainMail): Promise<SendResult> {
  return sendSafely(config, { to: mail.to, subject: mail.subject, text: mail.text });
}

/** 添付つきで1通送る(資料送付)。守りは sendPlainMail と同じ。 */
export async function sendMailWithAttachments(config: MailSendConfig, mail: AttachmentMail): Promise<SendResult> {
  return sendSafely(config, mail);
}
```

- [ ] **Step 4: 通ることと、既存のメールのテストが壊れていないことを確かめる**

Run: `npx vitest run src/lib/__tests__/mail-transport-attachments.test.ts src/lib/__tests__/sale-dm-inquiry-auto-reply-mail.test.ts src/lib/__tests__/sale-dm-inquiry-notify-mail.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/mail/transport.ts src/lib/__tests__/mail-transport-attachments.test.ts
git commit -m "feat(メール): 添付つきの送信(守りは受付メールと共通)"
```

---

### Task 4: メール設定にひな形の2欄

**Files:**
- Modify: `src/app/api/admin/mail-settings/route.ts`(`putSchema`・`MailConfigRow`・`buildResponseData`・保存の `data`)
- Modify: `src/app/(dashboard)/admin/mail-settings/page.tsx`(受付メールの欄の下に「資料送付メール」)
- Modify: `src/lib/api-client.ts`(メール設定の型に2つ)
- Test: 既存のメール設定の route テスト(`src/lib/__tests__/` で `mail-settings` を含むもの)に追記。無ければ `src/lib/__tests__/mail-settings-material-template.test.ts` を作る。

**Interfaces:**
- Consumes: `MATERIAL_SEND_LIMITS`・`DEFAULT_MATERIAL_SUBJECT`・`DEFAULT_MATERIAL_BODY`(Task 2)
- Produces: GET/PUT の応答に `materialSendSubject: string | null`・`materialSendBody: string | null`・`defaultMaterialSendSubject: string`・`defaultMaterialSendBody: string`。PUT は空文字で null(既定に戻す)。

- [ ] **Step 1: 既存のテストを探して、形を合わせる**

Run: `ls src/lib/__tests__ | grep -i mail-settings`
既存のテストの mock の組み方(prisma の `mailConfig.upsert` を見る形)をそのまま使う。

- [ ] **Step 2: 失敗するテストを書く**(既存ファイルに追記する形。mock 名は既存に合わせる)

```ts
it("資料送付のひな形を保存できる・空文字は null(既定に戻す)", async () => {
  const res = await PUT(json("PUT", { materialSendSubject: "【資料】{物件名}", materialSendBody: "" }));
  expect(res.status).toBe(200);
  expect(pm.mailConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
    update: expect.objectContaining({ materialSendSubject: "【資料】{物件名}", materialSendBody: null }),
  }));
});
it("資料送付の件名に改行は入れられない", async () => {
  expect((await PUT(json("PUT", { materialSendSubject: "a\nb" }))).status).toBe(422);
});
it("GET は既定の文面も返す", async () => {
  const body = await (await GET()).json();
  expect(body.data.defaultMaterialSendSubject).toBe("【資料送付】{物件名}");
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run src/lib/__tests__/<そのファイル>`
Expected: FAIL

- [ ] **Step 4: route を直す**

`putSchema` に(既存の受付メールの欄と同じ作り):

```ts
  // 資料請求への資料送付メールのひな形(2026-10-18)。空文字で「既定の文面に戻す」(null で保存)。
  materialSendSubject: z
    .string()
    .trim()
    .max(MATERIAL_SEND_LIMITS.subject)
    .refine((v) => !/[\r\n]/.test(v) && isPlainMailText(v), { message: "件名は1行で入力してください" })
    .optional(),
  materialSendBody: z
    .string()
    .max(MATERIAL_SEND_LIMITS.body)
    .refine(isPlainMailText, { message: "本文に使えない文字が含まれています" })
    .optional(),
```

`MailConfigRow` に `materialSendSubject?: string | null; materialSendBody?: string | null;`、`buildResponseData` の戻り値に:

```ts
    materialSendSubject: row?.materialSendSubject ?? null,
    materialSendBody: row?.materialSendBody ?? null,
    defaultMaterialSendSubject: DEFAULT_MATERIAL_SUBJECT,
    defaultMaterialSendBody: DEFAULT_MATERIAL_BODY,
```

保存の `data` を組むところで、受付メールの件名・本文と同じく「`undefined` なら触らない・空文字なら null」:

```ts
    if (input.materialSendSubject !== undefined) data.materialSendSubject = input.materialSendSubject === "" ? null : input.materialSendSubject;
    if (input.materialSendBody !== undefined) data.materialSendBody = input.materialSendBody.trim() === "" ? null : input.materialSendBody;
```

(既存コードの変数名が `data` 以外なら、そちらに合わせる。監査ログに文面の値は書かず、変えた欄の名前だけ書く既存の流儀に合わせる。)

- [ ] **Step 5: 画面に欄を足す**

`page.tsx` の受付メールの件名・本文の欄の直後に、同じ部品で:

```tsx
<section className="space-y-2">
  <h2 className="text-base font-semibold">資料送付メール</h2>
  <p className="text-xs text-gray-500">
    反響の受付で「資料を送る」を押したときの最初の文面です。送る前にその場で直せます。
    使える差し込み: {"{物件名}"} {"{会社名}"} {"{担当者名}"} {"{自分の名前}"}。空のままなら既定の文面を使います。
  </p>
  <label className="block">
    <span className="text-xs text-gray-500">件名</span>
    <input value={materialSubject} onChange={(e) => setMaterialSubject(e.target.value)} placeholder={data.defaultMaterialSendSubject} maxLength={200} className={inputCls} />
  </label>
  <label className="block">
    <span className="text-xs text-gray-500">本文(会社の署名もここに書いてください)</span>
    <textarea value={materialBody} onChange={(e) => setMaterialBody(e.target.value)} placeholder={data.defaultMaterialSendBody} rows={10} maxLength={10000} className={inputCls} />
  </label>
</section>
```

状態の作り方・保存ボタンへの組み込み・`inputCls` の名前は、同じ画面の受付メールの欄に合わせる(保存の要求に `materialSendSubject`・`materialSendBody` を足す)。

- [ ] **Step 6: 通ることを確かめる**

Run: `npx vitest run src/lib/__tests__/<そのファイル> && npx tsc --noEmit -p .`
Expected: PASS・型エラーなし

- [ ] **Step 7: Commit**

```bash
git add src/app/api/admin/mail-settings/route.ts "src/app/(dashboard)/admin/mail-settings/page.tsx" src/lib/api-client.ts src/lib/__tests__/
git commit -m "feat(メール設定): 資料送付メールのひな形(件名・本文)"
```

---

### Task 5: 送ってよい添付の一覧 API と送信 API

**Files:**
- Create: `src/lib/agent-inquiry/material-send-service.ts`(DB とストレージを使う部分。route を薄くする)
- Create: `src/app/api/agent-inquiries/[id]/material-candidates/route.ts`
- Create: `src/app/api/agent-inquiries/[id]/material-sends/route.ts`
- Test: `src/lib/__tests__/agent-inquiry-material-send-route.test.ts`

**Interfaces:**
- Consumes: Task 2 の全部、Task 3 の `sendMailWithAttachments`、`loadMailSendConfig`、`requireAgentInquiry`、`assertPropertyReadable`、`getStorage().keyFromUrl` / `.read(key)`、`writeAuditLog`
- Produces(API):
  - `GET /api/agent-inquiries/[id]/material-candidates` → `{ mailConfigured: boolean, to: string, subject: string, body: string, files: { id, fileName, fileSize, type, createdAt, warning: string | null }[], maxTotalBytes: number, maxFiles: number }`
  - `GET /api/agent-inquiries/[id]/material-sends` → `{ items: { id, createdAt, sentBy: { name }, toAddress, subject, body, attachments: { attachmentId, fileName, fileSize, type }[], totalSize, result, errorCode, state: "送信中"|"結果不明"|"送信済み"|"送れなかった" }[] }`
  - `POST /api/agent-inquiries/[id]/material-sends` 入力 `{ to, subject, body, attachmentIds, clientToken }` → 成功 201 `{ id, result: "sent", version }` / 押し直し 200 `{ id, result, replayed: true }` / 失敗 502 `{ error: { code: "SEND_FAILED" }, id }`
  - エラーコード: `NOT_MATERIAL_REQUEST`(400)・`INVALID_ADDRESS`(400)・`NOT_SELECTABLE`/`TOO_LARGE`/`NO_FILES`/`TOO_MANY`(400)・`MAIL_NOT_CONFIGURED`(409)・`FILE_UNAVAILABLE`(409)・`SEND_FAILED`(502)

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
const h = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  loadMailSendConfig: vi.fn(),
  sendMailWithAttachments: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: h.writeAuditLog }));
vi.mock("@/lib/mail/mail-config", () => ({ loadMailSendConfig: h.loadMailSendConfig, MAIL_CONFIG_ID: "singleton" }));
vi.mock("@/lib/mail/transport", () => ({ sendMailWithAttachments: h.sendMailWithAttachments }));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ keyFromUrl: (u: string) => u.replace("/uploads/", ""), read: h.read }) }));
vi.mock("@/lib/agent-inquiry/property-access", () => ({ assertPropertyReadable: vi.fn(async () => {}) }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    agentInquiry: { findUnique: vi.fn(), update: vi.fn(async () => ({ version: 3 })) },
    attachment: { findMany: vi.fn(async () => []) },
    mailConfig: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ name: "山田" })) },
    agentInquiryMaterialSend: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "s1" })),
      update: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { assertPropertyReadable } from "@/lib/agent-inquiry/property-access";
import { jsonRequest as json } from "./agent-inquiry-route-mocks";
import { POST, GET as LIST } from "../../app/api/agent-inquiries/[id]/material-sends/route";
import { GET as CANDIDATES } from "../../app/api/agent-inquiries/[id]/material-candidates/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  agentInquiry: { findUnique: Fn; update: Fn };
  attachment: { findMany: Fn };
  mailConfig: { findUnique: Fn };
  agentInquiryMaterialSend: { findFirst: Fn; findMany: Fn; create: Fn; update: Fn };
};
const IID = "33333333-3333-4333-8333-333333333333";
const PID = "11111111-1111-4111-8111-111111111111";
const A1 = "44444444-4444-4444-8444-444444444444";
const A2 = "55555555-5555-4555-8555-555555555555";
const TOKEN = "66666666-6666-4666-8666-666666666666";
const ctx = { params: Promise.resolve({ id: IID }) };
const inquiry = (o: Record<string, unknown> = {}) => ({
  id: IID, kind: "material_request", status: "open", version: 2, propertyId: PID,
  contactName: "佐藤", contactEmail: "sato@agent.jp",
  agent: { companyName: "△△不動産" }, property: { name: "サンプル荘", roomNo: "101", town: "品川区" }, ...o,
});
const att = (o: Record<string, unknown> = {}) => ({
  id: A1, targetType: "property", targetId: PID, type: "general", isDeleted: false, fileName: "図面.pdf",
  fileSize: 1000, fileUrl: "/uploads/attachments/a.pdf", mimeType: "application/pdf", createdAt: new Date(), ...o,
});
const body = (o: Record<string, unknown> = {}) => ({ to: "sato@agent.jp", subject: "件名", body: "本文", attachmentIds: [A1], clientToken: TOKEN, ...o });
const grant = (...p: [string, string][]) =>
  (getUserPermissions as Fn).mockResolvedValue(p.map(([resource, action]) => ({ resource, action, granted: true })));
const CONFIG = { host: "h", port: 465, secure: true, user: "u", pass: "p", from: "info@example.jp", appBaseUrl: null, inquiryMailDetail: "minimal" };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "office_staff" });
  grant(["agent_inquiry", "read"], ["agent_inquiry", "write"], ["property", "read"]);
  pm.agentInquiry.findUnique.mockResolvedValue(inquiry());
  pm.attachment.findMany.mockResolvedValue([att()]);
  h.loadMailSendConfig.mockResolvedValue(CONFIG);
  h.read.mockResolvedValue({ body: Buffer.from("pdf"), contentType: "application/pdf", size: 3 });
  h.sendMailWithAttachments.mockResolvedValue({ ok: true });
});

describe("資料の送信 API", () => {
  it("書く権限が無ければ 403・何も送らない", async () => {
    grant(["agent_inquiry", "read"]);
    expect((await POST(json("POST", body()), ctx)).status).toBe(403);
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("物件を開けなければ送らない", async () => {
    (assertPropertyReadable as Fn).mockRejectedValueOnce(Object.assign(new Error("x"), { status: 403, code: "FORBIDDEN" }));
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).not.toBe(201);
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("資料請求でない反響は 400", async () => {
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ kind: "viewing" }));
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("NOT_MATERIAL_REQUEST");
  });
  it("宛先が2件なら 400 INVALID_ADDRESS", async () => {
    const res = await POST(json("POST", body({ to: "a@x.jp, b@y.jp" })), ctx);
    expect((await res.json()).error.code).toBe("INVALID_ADDRESS");
  });
  it("メール設定が無ければ 409 MAIL_NOT_CONFIGURED", async () => {
    h.loadMailSendConfig.mockResolvedValue(null);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("MAIL_NOT_CONFIGURED");
  });
  it("別の物件の添付 ID を混ぜると 400・予約の行も作らない", async () => {
    pm.attachment.findMany.mockResolvedValue([att(), att({ id: A2, targetId: "other" })]);
    const res = await POST(json("POST", body({ attachmentIds: [A1, A2] })), ctx);
    expect((await res.json()).error.code).toBe("NOT_SELECTABLE");
    expect(pm.agentInquiryMaterialSend.create).not.toHaveBeenCalled();
  });
  it("小窓を開いた後にゴミ箱へ入った添付は送らない(Review Focus 1)", async () => {
    pm.attachment.findMany.mockResolvedValue([att({ isDeleted: true })]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("反響資料は権限があっても送れない", async () => {
    grant(["agent_inquiry", "write"], ["property", "read"], ["owner", "read"], ["registry_pdf", "preview"], ["registry_pdf", "download"]);
    pm.attachment.findMany.mockResolvedValue([att({ type: "referral" })]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("NOT_SELECTABLE");
  });
  it("合計 20MB 超は 400 TOO_LARGE", async () => {
    pm.attachment.findMany.mockResolvedValue([att({ fileSize: 20 * 1024 * 1024 + 1 })]);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("TOO_LARGE");
  });
  it("ファイルが読めなければ 409 FILE_UNAVAILABLE・送らない", async () => {
    h.read.mockResolvedValue(null);
    expect((await (await POST(json("POST", body()), ctx)).json()).error.code).toBe("FILE_UNAVAILABLE");
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("成功: 予約→送信→sent・反響を done(version を見ずに進める)・宛先を保存", async () => {
    const res = await POST(json("POST", body({ to: "new@agent.jp" })), ctx);
    expect(res.status).toBe(201);
    expect(pm.agentInquiryMaterialSend.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ result: "sending", clientToken: TOKEN, sentById: "u1", toAddress: "new@agent.jp", totalSize: 1000 }),
    }));
    const sent = h.sendMailWithAttachments.mock.calls[0][1];
    expect(sent).toMatchObject({ to: "new@agent.jp", subject: "件名", text: "本文" });
    expect(sent.attachments[0]).toMatchObject({ filename: "図面.pdf", contentType: "application/pdf" });
    expect(pm.agentInquiryMaterialSend.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ result: "sent" }) }));
    const upd = pm.agentInquiry.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: IID }); // version を条件にしない(Review Focus 5)
    expect(upd.data).toMatchObject({ status: "done", contactEmail: "new@agent.jp", version: { increment: 1 } });
  });
  it("既に done で宛先も同じなら反響は更新しない", async () => {
    pm.agentInquiry.findUnique.mockResolvedValue(inquiry({ status: "done" }));
    await POST(json("POST", body()), ctx);
    expect(pm.agentInquiry.update).not.toHaveBeenCalled();
  });
  it("SMTP 失敗: failed を残し 502・状態は変えない", async () => {
    h.sendMailWithAttachments.mockResolvedValue({ ok: false, code: "ECONNECTION" });
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).toBe(502);
    expect(pm.agentInquiryMaterialSend.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ result: "failed", errorCode: "ECONNECTION" }),
    }));
    expect(pm.agentInquiry.update).not.toHaveBeenCalled();
  });
  it("同じ鍵の押し直しは送らずに前の結果を返す(Review Focus 2)", async () => {
    pm.agentInquiryMaterialSend.findFirst.mockResolvedValue({ id: "s0", result: "sending" });
    const res = await POST(json("POST", body()), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "s0", result: "sending", replayed: true });
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("同じ鍵が同時に届いて一意制約にぶつかった方は送らない", async () => {
    pm.agentInquiryMaterialSend.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "s0", result: "sending" });
    pm.agentInquiryMaterialSend.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    const res = await POST(json("POST", body()), ctx);
    expect(await res.json()).toMatchObject({ id: "s0", replayed: true });
    expect(h.sendMailWithAttachments).not.toHaveBeenCalled();
  });
  it("謄本を送ったら監査に1行(宛先は書かない)", async () => {
    grant(["agent_inquiry", "write"], ["property", "read"], ["registry_pdf", "preview"], ["registry_pdf", "download"]);
    pm.attachment.findMany.mockResolvedValue([att({ type: "registry", fileName: "謄本.pdf" })]);
    await POST(json("POST", body()), ctx);
    const call = h.writeAuditLog.mock.calls.find((c) => c[0].action === "registry_pdf_mail_send");
    expect(call).toBeTruthy();
    expect(JSON.stringify(call)).not.toContain("sato@agent.jp");
  });
});

describe("候補と記録の API", () => {
  it("候補: 送れないものは出さず・謄本は権限があるときだけ注意つきで出す・文面は差し込み済み", async () => {
    grant(["agent_inquiry", "read"], ["property", "read"], ["registry_pdf", "preview"], ["registry_pdf", "download"]);
    pm.attachment.findMany.mockResolvedValue([att(), att({ id: A2, type: "registry", fileName: "謄本.pdf" }), att({ id: "r", type: "report" })]);
    const res = await CANDIDATES(new Request("http://x"), ctx);
    const d = await res.json();
    expect(d.files.map((f: { id: string }) => f.id)).toEqual([A1, A2]);
    expect(d.files[1].warning).toContain("所有者の名前・住所");
    expect(d.subject).toBe("【資料送付】サンプル荘 101");
    expect(d.body).toContain("佐藤 様");
    expect(d.to).toBe("sato@agent.jp");
    expect(d.mailConfigured).toBe(true);
  });
  it("記録: 新しい順・状態の表示つき", async () => {
    pm.agentInquiryMaterialSend.findMany.mockResolvedValue([
      { id: "s1", createdAt: new Date(), result: "sent", sentBy: { name: "山田" }, toAddress: "a@x.jp", subject: "s", body: "b", attachments: [], totalSize: 1, errorCode: null },
    ]);
    const d = await (await LIST(new Request("http://x"), ctx)).json();
    expect(d.items[0].state).toBe("送信済み");
    expect(pm.agentInquiryMaterialSend.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: "desc" } }));
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/__tests__/agent-inquiry-material-send-route.test.ts`
Expected: FAIL(route が無い)

- [ ] **Step 3: サービスを書く**(`src/lib/agent-inquiry/material-send-service.ts`)

```ts
import prisma from "@/lib/prisma";
import { ApiError, type ApiSession, type PermissionEntry } from "@/lib/api-helpers";
import { assertPropertyReadable } from "@/lib/agent-inquiry/property-access";
import { MAIL_CONFIG_ID } from "@/lib/mail/mail-config";
import {
  DEFAULT_MATERIAL_BODY,
  DEFAULT_MATERIAL_SUBJECT,
  fillMaterialTemplate,
  propertyDisplayName,
  type MaterialAttachmentRow,
} from "./material-send";

export const MATERIAL_ATTACHMENT_SELECT = {
  id: true, targetType: true, targetId: true, type: true, isDeleted: true,
  fileName: true, fileSize: true, fileUrl: true, mimeType: true, createdAt: true,
} as const;

/** 反響を読み、資料請求か・物件を開けるかを確かめる(候補・記録・送信で共通)。 */
export async function loadMaterialInquiry(id: string, session: ApiSession, perms: PermissionEntry[]) {
  const q = await prisma.agentInquiry.findUnique({
    where: { id },
    select: {
      id: true, kind: true, status: true, version: true, propertyId: true, contactName: true, contactEmail: true,
      agent: { select: { companyName: true } },
      property: { select: { name: true, roomNo: true, town: true } },
    },
  });
  if (!q) throw new ApiError(404, "反響が見つかりません", "NOT_FOUND");
  if (q.kind !== "material_request") throw new ApiError(400, "資料請求の反響だけ資料を送れます", "NOT_MATERIAL_REQUEST");
  await assertPropertyReadable(q.propertyId, session, perms);
  return q;
}

/** 物件の添付(削除済みも含めて読む=判定は純関数に任せる)。 */
export async function loadPropertyAttachments(propertyId: string, ids?: string[]): Promise<MaterialAttachmentRow[]> {
  return prisma.attachment.findMany({
    where: { targetType: "property", targetId: propertyId, ...(ids ? { id: { in: ids } } : {}) },
    orderBy: { createdAt: "desc" },
    select: MATERIAL_ATTACHMENT_SELECT,
  });
}

/** ひな形(未登録なら既定)に差し込んだ件名・本文。 */
export async function initialMaterialText(
  q: Awaited<ReturnType<typeof loadMaterialInquiry>>,
  senderName: string,
): Promise<{ subject: string; body: string }> {
  const row = await prisma.mailConfig.findUnique({
    where: { id: MAIL_CONFIG_ID },
    select: { materialSendSubject: true, materialSendBody: true },
  });
  const v = {
    propertyName: propertyDisplayName(q.property),
    companyName: q.agent.companyName,
    contactName: q.contactName,
    senderName,
  };
  return {
    subject: fillMaterialTemplate(row?.materialSendSubject || DEFAULT_MATERIAL_SUBJECT, v),
    body: fillMaterialTemplate(row?.materialSendBody || DEFAULT_MATERIAL_BODY, v),
  };
}
```

⚠ `ids` を指定しても `targetId: propertyId` の条件は外さない。他の物件の ID は「見つからない」になり、`checkMaterialSelection` が `NOT_SELECTABLE` を返す。

- [ ] **Step 4: 候補の route を書く**(`material-candidates/route.ts`)

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { loadMailSendConfig } from "@/lib/mail/mail-config";
import { MATERIAL_SEND_LIMITS, REGISTRY_WARNING, selectableForMaterialSend } from "@/lib/agent-inquiry/material-send";
import { initialMaterialText, loadMaterialInquiry, loadPropertyAttachments } from "@/lib/agent-inquiry/material-send-service";

const NO_STORE = { "Cache-Control": "no-store" };
type Ctx = { params: Promise<{ id: string }> };

/** 送ってよい添付と、差し込み済みの最初の文面(spec §7)。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireAgentInquiry("read");
    const id = z.string().uuid().parse((await ctx.params).id);
    const q = await loadMaterialInquiry(id, session, perms);
    const me = await prisma.user.findUnique({ where: { id: session.id }, select: { name: true } });
    const [rows, text, config] = await Promise.all([
      loadPropertyAttachments(q.propertyId),
      initialMaterialText(q, me?.name ?? ""),
      loadMailSendConfig(),
    ]);
    const files = rows
      .filter((r) => selectableForMaterialSend(r, q.propertyId, perms))
      .map((r) => ({
        id: r.id, fileName: r.fileName, fileSize: r.fileSize, type: r.type, createdAt: r.createdAt,
        warning: r.type === "registry" ? REGISTRY_WARNING : null,
      }));
    return NextResponse.json(
      {
        mailConfigured: config != null,
        to: q.contactEmail ?? "",
        ...text,
        files,
        maxTotalBytes: MATERIAL_SEND_LIMITS.maxTotalBytes,
        maxFiles: MATERIAL_SEND_LIMITS.maxFiles,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
```

⚠ `config` の中身(パスワード)は応答に入れない。真偽値だけ。

- [ ] **Step 5: 記録と送信の route を書く**(`material-sends/route.ts`)

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { loadMailSendConfig } from "@/lib/mail/mail-config";
import { sendMailWithAttachments, type MailAttachment } from "@/lib/mail/transport";
import { getStorage } from "@/lib/storage";
import {
  MATERIAL_SEND_LIMITS,
  checkMaterialSelection,
  isSingleAddress,
  sendStateLabel,
} from "@/lib/agent-inquiry/material-send";
import { loadMaterialInquiry, loadPropertyAttachments } from "@/lib/agent-inquiry/material-send-service";

const NO_STORE = { "Cache-Control": "no-store" };
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => z.string().uuid().parse((await ctx.params).id);

const sendSchema = z.object({
  to: z.string().trim().max(254),
  subject: z.string().trim().min(1).max(MATERIAL_SEND_LIMITS.subject).refine((v) => !/[\r\n]/.test(v)),
  body: z.string().min(1).max(MATERIAL_SEND_LIMITS.body),
  attachmentIds: z.array(z.string().uuid()).max(MATERIAL_SEND_LIMITS.maxFiles)
    .refine((a) => new Set(a).size === a.length),
  clientToken: z.string().uuid(),
});

/** 送った記録(新しい順)。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireAgentInquiry("read");
    const id = await idOf(ctx);
    await loadMaterialInquiry(id, session, perms);
    const rows = await prisma.agentInquiryMaterialSend.findMany({
      where: { inquiryId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true, createdAt: true, result: true, toAddress: true, subject: true, body: true,
        attachments: true, totalSize: true, errorCode: true, sentBy: { select: { name: true } },
      },
    });
    const now = new Date();
    return NextResponse.json({ items: rows.map((r) => ({ ...r, state: sendStateLabel(r, now) })) }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 資料を送る(spec §6)。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireAgentInquiry("write");
    const id = await idOf(ctx);
    const input = sendSchema.parse(await parseJsonBody(request));
    const replay = () =>
      prisma.agentInquiryMaterialSend.findFirst({
        where: { sentById: session.id, clientToken: input.clientToken },
        select: { id: true, result: true },
      });
    const prev = await replay();
    if (prev) return NextResponse.json({ ...prev, replayed: true }, { headers: NO_STORE });

    const q = await loadMaterialInquiry(id, session, perms);
    if (!isSingleAddress(input.to)) throw new ApiError(400, "宛先のメールアドレスを1件、正しい形で入れてください", "INVALID_ADDRESS");
    const config = await loadMailSendConfig();
    if (!config) throw new ApiError(409, "管理画面のメール設定が必要です", "MAIL_NOT_CONFIGURED");

    // 送る直前に DB から読み直して確かめ直す(画面の古い一覧・手で作った要求を通さない)。
    const rows = await loadPropertyAttachments(q.propertyId, input.attachmentIds);
    const sel = checkMaterialSelection(rows, input.attachmentIds, q.propertyId, perms);
    if (!sel.ok) {
      const msg = {
        NOT_SELECTABLE: "送れないファイルが含まれています。画面を開き直してください",
        TOO_LARGE: "ファイルの合計が 20MB を超えています",
        NO_FILES: "送るファイルを選んでください",
        TOO_MANY: "一度に送れるのは 20 ファイルまでです",
      }[sel.code];
      throw new ApiError(400, msg, sel.code);
    }

    const storage = getStorage();
    const files: MailAttachment[] = [];
    for (const r of sel.rows) {
      const key = storage.keyFromUrl(r.fileUrl);
      const got = key ? await storage.read(key) : null;
      if (!got) throw new ApiError(409, `「${r.fileName}」を読み出せませんでした`, "FILE_UNAVAILABLE");
      files.push({ filename: r.fileName, content: got.body, contentType: r.mimeType || got.contentType });
    }

    // 予約の行(一意制約で二重送信を防ぐ)。
    let claim: { id: string };
    try {
      claim = await prisma.agentInquiryMaterialSend.create({
        data: {
          inquiryId: id,
          sentById: session.id,
          toAddress: input.to,
          subject: input.subject,
          body: input.body,
          attachments: sel.rows.map((r) => ({ attachmentId: r.id, fileName: r.fileName, fileSize: r.fileSize, type: r.type })),
          totalSize: sel.totalSize,
          result: "sending",
          clientToken: input.clientToken,
        },
        select: { id: true },
      });
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "P2002") {
        const again = await replay();
        if (again) return NextResponse.json({ ...again, replayed: true }, { headers: NO_STORE });
      }
      throw e;
    }

    const result = await sendMailWithAttachments(config, { to: input.to, subject: input.subject, text: input.body, attachments: files });
    if (!result.ok) {
      await prisma.agentInquiryMaterialSend.update({
        where: { id: claim.id },
        data: { result: "failed", errorCode: result.code, finishedAt: new Date() },
      });
      return NextResponse.json(
        { id: claim.id, error: { code: "SEND_FAILED", message: "送れませんでした。時間をおいてもう一度押してください" } },
        { status: 502, headers: NO_STORE },
      );
    }

    // 送信は済んだ=記録は必ず残す。反響の更新は version を見ない(他の人の更新とぶつかっても done にする)。
    const changeEmail = (q.contactEmail ?? "") !== input.to;
    const version = await prisma.$transaction(async (tx) => {
      await tx.agentInquiryMaterialSend.update({ where: { id: claim.id }, data: { result: "sent", finishedAt: new Date() } });
      if (q.status === "done" && !changeEmail) return q.version;
      const u = await tx.agentInquiry.update({
        where: { id },
        data: { status: "done", ...(changeEmail ? { contactEmail: input.to } : {}), version: { increment: 1 } },
        select: { version: true },
      });
      return u.version;
    });

    await writeAuditLog({
      userId: session.id,
      action: "agent_inquiry_material_send",
      targetTable: "agent_inquiries",
      targetId: id,
      detail: { files: sel.rows.length, totalSize: sel.totalSize, statusChanged: q.status !== "done" },
    });
    for (const r of sel.rows.filter((x) => x.type === "registry")) {
      // 謄本の取り扱いの記録。宛先は書かない(送った記録の表で見る)。
      await writeAuditLog({
        userId: session.id,
        action: "registry_pdf_mail_send",
        targetTable: "attachments",
        targetId: r.id,
        detail: { inquiryId: id, sendId: claim.id },
      });
    }
    return NextResponse.json({ id: claim.id, result: "sent", version }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
```

注意: テストの順番(押し直しの確認 → 反響の確かめ)に合わせて、`replay()` は権限確認の直後・反響を読む前に呼ぶ。`requireAgentInquiry("write")` より前には呼ばない(権限の無い人に記録の有無を見せない)。

- [ ] **Step 6: 通ることを確かめる**

Run: `npx vitest run src/lib/__tests__/agent-inquiry-material-send-route.test.ts`
Expected: PASS

- [ ] **Step 7: 守りの走査テストを足す**(`src/lib/__tests__/agent-inquiry-material-send-scan.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("資料送付の守り(走査)", () => {
  const send = read("src/app/api/agent-inquiries/[id]/material-sends/route.ts");
  const cand = read("src/app/api/agent-inquiries/[id]/material-candidates/route.ts");
  it("送信は checkMaterialSelection を通してからストレージを読む", () => {
    expect(send.indexOf("checkMaterialSelection(")).toBeGreaterThan(-1);
    expect(send.indexOf("checkMaterialSelection(")).toBeLessThan(send.indexOf("storage.read("));
  });
  it("候補は selectableForMaterialSend で絞る", () => expect(cand).toContain("selectableForMaterialSend("));
  it("BCC・CC を付けない", () => expect(send).not.toMatch(/\b(bcc|cc)\s*:/i));
  it("メール設定の中身を応答に入れない", () => expect(cand).toMatch(/mailConfigured: config != null/));
});
```

Run: `npx vitest run src/lib/__tests__/agent-inquiry-material-send-scan.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/lib/agent-inquiry/material-send-service.ts "src/app/api/agent-inquiries/[id]/material-candidates" "src/app/api/agent-inquiries/[id]/material-sends" src/lib/__tests__/agent-inquiry-material-send-route.test.ts src/lib/__tests__/agent-inquiry-material-send-scan.test.ts
git commit -m "feat(反響): 資料の候補・送った記録・送信の API(送る直前に確かめ直す・二重送信の予約)"
```

---

### Task 6: 呼び出しと小窓

**Files:**
- Modify: `src/lib/api-client.ts`(反響の関数群の近く)
- Create: `src/components/agent-inquiry/material-send-dialog.tsx`
- Test: `src/components/agent-inquiry/__tests__/material-send-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 5 の API の形、`ModalShell`(`@/components/ui/modal-shell`)、`Button`、`apiErrorCode`(`@/lib/api-client`)、`REGISTRY_WARNING`・`MATERIAL_SEND_LIMITS`・`isSingleAddress`(Task 2)
- Produces:
  - `fetchMaterialCandidates(inquiryId: string): Promise<MaterialCandidates>`
  - `fetchMaterialSends(inquiryId: string): Promise<{ items: MaterialSendView[] }>`
  - `sendMaterial(inquiryId: string, input: { to: string; subject: string; body: string; attachmentIds: string[]; clientToken: string }): Promise<{ id: string; result: string; version?: number; replayed?: boolean }>`
  - 型 `MaterialCandidates`・`MaterialSendView`(Task 5 の応答と同じ形)
  - `<MaterialSendDialog inquiryId={string} hidden={boolean} onHide={() => void} onClose={() => void} onSent={() => void} />`(×=`onHide`=親は `hidden` にするだけで入力は残る/キャンセル=`onClose`=親が外す=入力は消える。既存の決まり「小窓の×は入力を残す・キャンセルは消す」)
  - `<MaterialSendHistory inquiryId={string} reloadKey={number} />`

- [ ] **Step 1: api-client に足す**(既存の `fetchAgentInquiry` と同じ流儀。モックでは使えない旨を throw)

```ts
export interface MaterialCandidateFile { id: string; fileName: string; fileSize: number; type: string; createdAt: string; warning: string | null }
export interface MaterialCandidates { mailConfigured: boolean; to: string; subject: string; body: string; files: MaterialCandidateFile[]; maxTotalBytes: number; maxFiles: number }
export interface MaterialSendView {
  id: string; createdAt: string; result: "sending" | "sent" | "failed"; state: "送信中" | "結果不明" | "送信済み" | "送れなかった";
  sentBy: { name: string }; toAddress: string; subject: string; body: string;
  attachments: { attachmentId: string; fileName: string; fileSize: number; type: string }[]; totalSize: number; errorCode: string | null;
}
export async function fetchMaterialCandidates(inquiryId: string) {
  if (USE_MOCK) throw new Error("モックでは資料を送れません");
  return apiFetch<MaterialCandidates>(`/api/agent-inquiries/${inquiryId}/material-candidates`);
}
export async function fetchMaterialSends(inquiryId: string) {
  if (USE_MOCK) return { items: [] as MaterialSendView[] };
  return apiFetch<{ items: MaterialSendView[] }>(`/api/agent-inquiries/${inquiryId}/material-sends`);
}
export async function sendMaterial(
  inquiryId: string,
  input: { to: string; subject: string; body: string; attachmentIds: string[]; clientToken: string },
) {
  if (USE_MOCK) throw new Error("モックでは資料を送れません");
  return apiFetch<{ id: string; result: string; version?: number; replayed?: boolean }>(
    `/api/agent-inquiries/${inquiryId}/material-sends`,
    { method: "POST", body: JSON.stringify(input) },
  );
}
```

(`apiFetch` の引数の形・JSON ヘッダの付け方は、同じファイルの `updateAgentInquiry` に合わせる。)

- [ ] **Step 2: 失敗するテストを書く**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ fetchMaterialCandidates: vi.fn(), sendMaterial: vi.fn(), fetchMaterialSends: vi.fn(), apiErrorCode: vi.fn() }));
vi.mock("@/lib/api-client", () => api);
import { MaterialSendDialog } from "../material-send-dialog";

const MB = 1024 * 1024;
const cand = (o = {}) => ({
  mailConfigured: true, to: "sato@agent.jp", subject: "【資料送付】サンプル荘", body: "本文", maxTotalBytes: 20 * MB, maxFiles: 20,
  files: [
    { id: "a1", fileName: "図面.pdf", fileSize: 2 * MB, type: "general", createdAt: "2026-10-01T00:00:00Z", warning: null },
    { id: "a2", fileName: "謄本.pdf", fileSize: 1 * MB, type: "registry", createdAt: "2026-10-01T00:00:00Z", warning: "所有者の名前・住所が載っています。送ってよい相手か確かめてください" },
  ],
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchMaterialCandidates.mockResolvedValue(cand());
  api.sendMaterial.mockResolvedValue({ id: "s1", result: "sent", version: 3 });
});
const open = async () => {
  const onSent = vi.fn();
  render(<MaterialSendDialog inquiryId="i1" onHide={vi.fn()} onClose={vi.fn()} onSent={onSent} />);
  await screen.findByDisplayValue("sato@agent.jp");
  return { onSent };
};

describe("資料を送る小窓", () => {
  it("1つも選ばないと送信できない", async () => {
    await open();
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });
  it("謄本を選ぶと黄色の注意", async () => {
    await open();
    fireEvent.click(screen.getByLabelText(/謄本\.pdf/));
    expect(screen.getByText(/所有者の名前・住所が載っています/)).toBeInTheDocument();
  });
  it("合計が 20MB を超えると送信できない", async () => {
    api.fetchMaterialCandidates.mockResolvedValue(cand({ files: [
      { id: "a1", fileName: "大.pdf", fileSize: 15 * MB, type: "general", createdAt: "x", warning: null },
      { id: "a2", fileName: "大2.pdf", fileSize: 6 * MB, type: "general", createdAt: "x", warning: null },
    ] }));
    await open();
    fireEvent.click(screen.getByLabelText(/大\.pdf/));
    fireEvent.click(screen.getByLabelText(/大2\.pdf/));
    expect(screen.getByText(/20MB を超えています/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });
  it("宛先が正しくないと送信できない", async () => {
    await open();
    fireEvent.click(screen.getByLabelText(/図面\.pdf/));
    fireEvent.change(screen.getByLabelText("宛先"), { target: { value: "a@x.jp, b@y.jp" } });
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });
  it("送れたら onSent・選んだ ID と直した文面を送る", async () => {
    const { onSent } = await open();
    fireEvent.click(screen.getByLabelText(/図面\.pdf/));
    fireEvent.change(screen.getByLabelText("本文"), { target: { value: "直した本文" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(api.sendMaterial).toHaveBeenCalledWith("i1", expect.objectContaining({ to: "sato@agent.jp", body: "直した本文", attachmentIds: ["a1"] }));
  });
  it("失敗したら入力を残してメッセージ・次は新しい鍵で送る", async () => {
    api.sendMaterial.mockRejectedValueOnce(new Error("送れませんでした"));
    await open();
    fireEvent.click(screen.getByLabelText(/図面\.pdf/));
    fireEvent.change(screen.getByLabelText("本文"), { target: { value: "残す本文" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("送れませんでした");
    expect(screen.getByLabelText("本文")).toHaveValue("残す本文");
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() => expect(api.sendMaterial).toHaveBeenCalledTimes(2));
    const [t1, t2] = api.sendMaterial.mock.calls.map((c) => c[1].clientToken);
    expect(t1).not.toBe(t2);
  });
  it("×(onHide)で隠して戻しても入力が残る", async () => {
    const onHide = vi.fn();
    const { rerender } = render(<MaterialSendDialog inquiryId="i1" onHide={onHide} onClose={vi.fn()} onSent={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("本文"), { target: { value: "書きかけ" } });
    rerender(<MaterialSendDialog inquiryId="i1" hidden onHide={onHide} onClose={vi.fn()} onSent={vi.fn()} />);
    expect(screen.queryByLabelText("本文")).toBeNull();
    rerender(<MaterialSendDialog inquiryId="i1" onHide={onHide} onClose={vi.fn()} onSent={vi.fn()} />);
    expect(screen.getByLabelText("本文")).toHaveValue("書きかけ");
  });
  it("メール設定が無ければ案内を出して送信できない", async () => {
    api.fetchMaterialCandidates.mockResolvedValue(cand({ mailConfigured: false }));
    render(<MaterialSendDialog inquiryId="i1" onHide={vi.fn()} onClose={vi.fn()} onSent={vi.fn()} />);
    expect(await screen.findByText(/管理画面のメール設定が必要です/)).toBeInTheDocument();
  });
  it("添付が無ければ資料一覧への案内", async () => {
    api.fetchMaterialCandidates.mockResolvedValue(cand({ files: [] }));
    render(<MaterialSendDialog inquiryId="i1" onHide={vi.fn()} onClose={vi.fn()} onSent={vi.fn()} />);
    expect(await screen.findByText(/資料一覧にファイルがありません/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run src/components/agent-inquiry/__tests__/material-send-dialog.test.tsx`
Expected: FAIL(コンポーネントが無い)

- [ ] **Step 4: 小窓を書く**

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import {
  fetchMaterialCandidates,
  fetchMaterialSends,
  sendMaterial,
  type MaterialCandidates,
  type MaterialSendView,
} from "@/lib/api-client";
import { isSingleAddress } from "@/lib/agent-inquiry/material-send";

const inputCls = "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900";
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;

/** 資料請求への資料送付の小窓(spec §2.2)。×=onHide(親は hidden にするだけ=入力が残る)・キャンセル=onClose(親が外す=消える)。 */
export function MaterialSendDialog({
  inquiryId, hidden = false, onHide, onClose, onSent,
}: { inquiryId: string; hidden?: boolean; onHide: () => void; onClose: () => void; onSent: () => void }) {
  const [c, setC] = useState<MaterialCandidates | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let alive = true;
    fetchMaterialCandidates(inquiryId)
      .then((d) => {
        if (!alive) return;
        setC(d);
        setTo(d.to);
        setSubject(d.subject);
        setBody(d.body);
      })
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : "読み込めませんでした"));
    return () => {
      alive = false;
    };
  }, [inquiryId]);

  const chosen = useMemo(() => (c ? c.files.filter((f) => picked.includes(f.id)) : []), [c, picked]);
  const total = chosen.reduce((s, f) => s + f.fileSize, 0);
  const tooLarge = c != null && total > c.maxTotalBytes;
  const tooMany = c != null && chosen.length > c.maxFiles;
  const warnings = [...new Set(chosen.map((f) => f.warning).filter((w): w is string => !!w))];
  const canSend =
    !!c && c.mailConfigured && chosen.length > 0 && !tooLarge && !tooMany && isSingleAddress(to.trim()) &&
    subject.trim() !== "" && body.trim() !== "" && !busy;

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendMaterial(inquiryId, { to: to.trim(), subject, body, attachmentIds: picked, clientToken: token });
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : "送れませんでした");
      setToken(crypto.randomUUID()); // 送り直しは新しい鍵(spec §6.2)
    } finally {
      setBusy(false);
    }
  };

  if (hidden) return null; // 状態は残したまま見せないだけ
  return (
    <ModalShell
      size="lg"
      title="資料を送る"
      onClose={busy ? undefined : onHide}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button onClick={() => void submit()} disabled={!canSend}>{busy ? "送信中…" : "送信"}</Button>
        </div>
      }
    >
      {loadError ? (
        <p role="alert" className="text-sm text-rose-600">{loadError}</p>
      ) : !c ? (
        <p className="text-sm text-gray-500">読み込み中…</p>
      ) : (
        <div className="space-y-3 text-sm">
          {!c.mailConfigured && (
            <p className="rounded bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              管理画面のメール設定が必要です。<a href="/admin/mail-settings" className="underline">メール設定を開く</a>
            </p>
          )}
          <label className="block">
            <span className="text-xs text-gray-500">宛先</span>
            <input aria-label="宛先" type="email" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">件名</span>
            <input aria-label="件名" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} className={inputCls} />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">本文</span>
            <textarea aria-label="本文" value={body} onChange={(e) => setBody(e.target.value)} rows={8} maxLength={10000} className={inputCls} />
          </label>
          <fieldset>
            <legend className="text-xs text-gray-500">付けるファイル(資料一覧から)</legend>
            {c.files.length === 0 ? (
              <p>資料一覧にファイルがありません。物件画面の「添付」タブでアップロードしてから送ってください。</p>
            ) : (
              <ul className="space-y-1">
                {c.files.map((f) => (
                  <li key={f.id}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={picked.includes(f.id)} onChange={() => toggle(f.id)} />
                      <span>{f.fileName}</span>
                      <span className="text-xs text-gray-500">{mb(f.fileSize)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className={`mt-1 text-xs ${tooLarge ? "font-bold text-rose-600" : "text-gray-500"}`}>
              合計 {mb(total)} / 20MB{tooLarge && "(20MB を超えています。ファイルを減らしてください)"}
            </p>
            {tooMany && <p className="text-xs font-bold text-rose-600">一度に送れるのは {c.maxFiles} ファイルまでです</p>}
          </fieldset>
          {warnings.map((w) => (
            <p key={w} className="rounded bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-950 dark:text-amber-200">{w}</p>
          ))}
          {error && <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-rose-700 dark:bg-rose-950 dark:text-rose-200">{error}</p>}
        </div>
      )}
    </ModalShell>
  );
}

/** 送った記録の一覧(spec §2.3)。行を押すと中身を開く。 */
export function MaterialSendHistory({ inquiryId, reloadKey }: { inquiryId: string; reloadKey: number }) {
  const [items, setItems] = useState<MaterialSendView[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchMaterialSends(inquiryId).then((d) => alive && setItems(d.items)).catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [inquiryId, reloadKey]);
  if (!items || items.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-gray-500">資料送付の記録</p>
      <ul className="space-y-1">
        {items.map((s) => (
          <li key={s.id} className="rounded border border-gray-200 px-2 py-1 dark:border-gray-700">
            <button type="button" className="w-full text-left" onClick={() => setOpenId(openId === s.id ? null : s.id)}>
              {new Date(s.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} ・ {s.sentBy.name} ・ {s.toAddress} ・ {s.attachments.length}ファイル ・{" "}
              <span className={s.state === "送信済み" ? "text-teal-700" : "text-rose-600"}>{s.state}</span>
            </button>
            {openId === s.id && (
              <div className="mt-1 space-y-1 text-xs">
                <p className="font-medium">{s.subject}</p>
                <p className="whitespace-pre-wrap">{s.body}</p>
                <ul>{s.attachments.map((a) => <li key={a.attachmentId}>{a.fileName}({mb(a.fileSize)})</li>)}</ul>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

⚠ 本文・宛先は業者の担当者の情報。既存の反響詳細が「書けないときは保護つきの文章」で出している流儀(`data-pii-protected`)が記録の本文にも要るかを、`inquiry-detail.tsx` の `ProtectedText` と同じ判断で確かめる(要るなら `<p data-pii-protected="true" data-pii-surface="dashboard">` にする)。

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run src/components/agent-inquiry/__tests__/material-send-dialog.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/api-client.ts src/components/agent-inquiry/material-send-dialog.tsx src/components/agent-inquiry/__tests__/material-send-dialog.test.tsx
git commit -m "feat(反響): 資料を送る小窓と送った記録の一覧"
```

---

### Task 7: 受付の窓と物件画面にボタンを付ける

**Files:**
- Modify: `src/components/agent-inquiry/inquiry-detail.tsx`(`InquiryDetailView` の内見の欄の後・エラー表示の前)と、その親(同じファイルの 371 行目あたりの読み込み側)
- Modify: `src/components/properties/agent-inquiry-tab.tsx`(時系列の行)
- Test: `src/components/agent-inquiry/__tests__/inquiry-detail-material.test.tsx`、`src/components/properties/__tests__/agent-inquiry-tab.test.tsx`(追記)

**Interfaces:**
- Consumes: `MaterialSendDialog`・`MaterialSendHistory`(Task 6)
- Produces: `InquiryDetailView` の新しい任意の props `canSendMaterial?: boolean`・`onMaterialSent?: () => void`

- [ ] **Step 1: 失敗するテストを書く**

`inquiry-detail-material.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("../material-send-dialog", () => ({
  MaterialSendDialog: () => <div>小窓</div>,
  MaterialSendHistory: () => <div>記録</div>,
}));
import { InquiryDetailView } from "../inquiry-detail";

const base = {
  id: "i1", status: "open", channel: "phone", receivedAt: "2026-10-18T00:00:00Z", version: 1,
  contactName: "佐藤", contactMobile: null, contactEmail: "sato@agent.jp", note: null, assignee: null,
  agent: { id: "g1", companyName: "△△不動産", branchName: null, phone: "03-1234-5678" }, viewings: [],
  property: { id: "p1", name: "サンプル荘", roomNo: null, town: "品川区" },
} as const;
const props = { canOpenProperty: true, users: [], busy: false, error: null, onStatus: vi.fn(), onAssignee: vi.fn(), onSaveNote: vi.fn(), onAddViewing: vi.fn(), onSaveViewing: vi.fn(), onClose: vi.fn() };

describe("反響の詳細の「資料を送る」", () => {
  it("資料請求で送れる人にだけ出る", () => {
    const { rerender } = render(<InquiryDetailView {...props} inquiry={{ ...base, kind: "material_request" } as never} canSendMaterial />);
    expect(screen.getByRole("button", { name: "資料を送る" })).toBeInTheDocument();
    rerender(<InquiryDetailView {...props} inquiry={{ ...base, kind: "viewing" } as never} canSendMaterial />);
    expect(screen.queryByRole("button", { name: "資料を送る" })).toBeNull();
    rerender(<InquiryDetailView {...props} inquiry={{ ...base, kind: "material_request" } as never} canSendMaterial={false} />);
    expect(screen.queryByRole("button", { name: "資料を送る" })).toBeNull();
  });
});
```

`agent-inquiry-tab.test.tsx` に追記(既存の mock の組み方に合わせる):

```tsx
it("資料請求の行にだけ「資料を送る」", async () => {
  // 既存の fetch の mock に timeline を返させる: material_request 1件と viewing 1件
  // …既存テストのデータ作りに合わせて kind: "material_request" の行を足す
  expect(await screen.findAllByRole("button", { name: "資料を送る" })).toHaveLength(1);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/components/agent-inquiry/__tests__/inquiry-detail-material.test.tsx src/components/properties/__tests__/agent-inquiry-tab.test.tsx`
Expected: FAIL

- [ ] **Step 3: 反響の詳細に組み込む**

`InquiryDetailView` の props に `canSendMaterial = false` と `onMaterialSent` を足し、内見の欄の `)}` の直後に:

```tsx
        {q.kind === "material_request" && (
          <div className="space-y-1">
            {canSendMaterial && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setMaterialOpen(true);
                  setMaterialHidden(false);
                }}
                className="rounded bg-teal-700 px-3 py-1 text-xs text-white disabled:opacity-60"
              >
                資料を送る
              </button>
            )}
            <MaterialSendHistory inquiryId={q.id} reloadKey={materialReload} />
          </div>
        )}
```

コンポーネントの先頭に:

```tsx
  const [materialOpen, setMaterialOpen] = useState(false);
  const [materialHidden, setMaterialHidden] = useState(false);
  const [materialReload, setMaterialReload] = useState(0);
```

`</ModalShell>` の直後(戻り値を `<>…</>` で包む)に:

```tsx
      {materialOpen && (
        <MaterialSendDialog
          inquiryId={q.id}
          hidden={materialHidden}
          onHide={() => setMaterialHidden(true)}
          onClose={() => setMaterialOpen(false)}
          onSent={() => {
            setMaterialOpen(false);
            setMaterialReload((n) => n + 1);
            onMaterialSent?.();
          }}
        />
      )}
```

親(読み込み側)では、`canSendMaterial` = 反響を書ける(既存の `useDeskAccess` が返す書き込み可否)かつ `canOpenProperty`、`onMaterialSent` = 既存の読み直し(`fetchAgentInquiry` を呼んで状態と version を最新にする関数)を渡す。

- [ ] **Step 4: 物件画面の反響タブに組み込む**

`PropertyInquiryView` の時系列の `<li>` の中、`resultNote` の行の前に:

```tsx
                {e.kind === "material_request" && canSendMaterial && (
                  <button
                    type="button"
                    onClick={() => onOpenMaterial(e.inquiryId)}
                    className="ml-2 rounded border border-teal-700 px-2 py-0.5 text-xs text-teal-700 dark:text-teal-300"
                  >
                    資料を送る
                  </button>
                )}
```

`PropertyInquiryView` の props に `canSendMaterial: boolean`・`onOpenMaterial: (inquiryId: string) => void` を足す。`AgentInquiryTab` 側で(`onOpenMaterial={openMaterial}` を渡す):

```tsx
  const [materialFor, setMaterialFor] = useState<string | null>(null);
  const [materialHidden, setMaterialHidden] = useState(false);
  // 行のボタン: 同じ反響なら隠していた小窓を戻す(入力が残る)・別の反響なら作り直す。
  const openMaterial = (id: string) => {
    setMaterialHidden(false);
    setMaterialFor(id);
  };
  // …
  {materialFor && (
    <MaterialSendDialog
      key={materialFor}
      inquiryId={materialFor}
      hidden={materialHidden}
      onHide={() => setMaterialHidden(true)}
      onClose={() => setMaterialFor(null)}
      onSent={() => {
        setMaterialFor(null);
        void load();
      }}
    />
  )}
```

`canSendMaterial` は、この画面は権限表を読まない決まり(ファイル先頭の注意)なので、物件画面の親から `agent_inquiry:write` の可否を props で渡す(`canWrite` と同じ渡し方)。親の権限の取り方は `src/app/(dashboard)/properties/[id]/` のページで `canWrite` を作っているところに合わせる。API 側でも必ず 403 になるので、ボタンの出し分けは見た目のためだけ。

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run src/components/agent-inquiry src/components/properties/__tests__/agent-inquiry-tab.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/agent-inquiry/inquiry-detail.tsx src/components/properties/agent-inquiry-tab.tsx "src/app/(dashboard)/properties" src/components/agent-inquiry/__tests__ src/components/properties/__tests__
git commit -m "feat(反響): 受付の窓と物件画面の資料請求に「資料を送る」"
```

---

### Task 8: 使い方ガイド・マニュアル+全体の確認

**Files:**
- Modify: 使い方ガイドとマニュアルの「反響の受付」の節(`docs/` の正本と `public/docs/` の写し。場所は `grep -rln "反響の受付" docs public/docs` で探す)
- Test: 既存の資料同期のテスト(`public/docs` と正本の一致を見るものがあれば)

- [ ] **Step 1: 節を足す**(ガイド・マニュアルとも同じ中身。画面名にはリンクを付ける決まり=既存の書き方に合わせる)

```markdown
### 資料請求に資料を送る

1. 種類が「資料請求」の反響を開き、「資料を送る」を押します(受付の窓・物件画面の「反響」タブのどちらからでも)。
2. 宛先・件名・本文を確かめます。文面は[メール設定](/admin/mail-settings)の「資料送付メール」がもとになり、その場で直せます。
3. 物件の資料一覧(添付)から付けるファイルを選びます。合計 20MB・20 ファイルまでです。
   - 謄本を選ぶと「所有者の名前・住所が載っています」と出ます。送ってよい相手か確かめてください。
   - 反響資料や査定報告書など、所有者の個人情報が載った書類は出てきません。
4. 「送信」を押すと会社のメールアドレスから届きます。送れたら反響は自動で「対応済み」になり、「資料送付の記録」に残ります。
   - 送れなかったときは入力が残ります。もう一度「送信」を押してください。
```

- [ ] **Step 2: 全部のテスト・型・lint を通す**

Run: `npm test > /tmp/mat-test.log 2>&1; echo exit=$?` → `exit=0` を確かめる(落ちたら `tail -50` で原因を読む)
Run: `npx tsc --noEmit -p . ; echo exit=$?` → `exit=0`
Run: `npx eslint src/lib/agent-inquiry src/components/agent-inquiry "src/app/api/agent-inquiries" src/lib/mail ; echo exit=$?` → 新しいエラーなし
⚠手元のフルテストがメモリ不足で止められたときは、勝手に再実行せず CI の結果で確かめる。

- [ ] **Step 3: Commit**

```bash
git add docs public/docs
git commit -m "docs: ガイド・マニュアルに「資料請求に資料を送る」"
```

---

## 反映のあとにすること(計画の外・メモ)

- 本番反映は migration 1本(追加だけ)。反映は発注者の「反映して」のあとで vps-deploy の手順どおり。
- 確認リストに追加: 自分のアドレス宛てに1通送る(ファイルが開ける・件名と本文・対応済みになる・記録が出る)/謄本の注意/20MB の止め/メール設定のひな形。
