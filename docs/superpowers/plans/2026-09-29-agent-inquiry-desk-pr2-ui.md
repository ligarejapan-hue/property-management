# 業者からの反響の受付 PR2(受付の窓の画面)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** メニューの無い受付専用画面 `/inquiry-desk` を作り、電話を受けながら反響を登録・一覧・対応できるようにする(PR1 の API は本番反映済み)。

**Architecture:** 新しいルートグループ `src/app/(desk)/` に、サイドバーの無いレイアウト(SessionProvider+無操作ログアウト+読み込み/セッション切れの表示)を置く。判定・変換・次の手順は純関数 `src/lib/agent-inquiry/desk-form.ts` に集め、画面部品は `src/components/agent-inquiry/` に「props で描く見た目の部品」と「取得・保存をする親」に分ける。API 呼び出しは既存の慣習どおり `src/lib/api-client.ts` に足す。

**Tech Stack:** Next.js 16 app router / React 19 client components / Tailwind v4 / next-auth `useSession` / vitest(node 環境・`renderToStaticMarkup` と文字列走査)/ Playwright(実ブラウザ確認)。

**Spec:** `docs/superpowers/specs/2026-09-28-agent-inquiry-desk-design.md`(§0 方針・§2.1 受付の窓・§2.2 登録フォーム・§4 権限)

## 範囲の判断(設計書 §5 との違い)

- **サイドバーの「反響の受付」はこの PR に前倒し**(設計書では PR3)。無いと画面に辿り着けず「ここで使い始められる」にならないため。ホームの件数・メイン画面の別窓ボタン・物件画面の反響欄・業者の名簿画面は PR3 のまま。
- 対応済みタブの「直近30日を既定」は、API に日付の絞り込みが無いので**新しい順+もっと見る**で代える(月30件未満の規模では同じ見え方)。
- 「メイン画面で物件を開く」は**詳細の中だけ**に置く(一覧の各行には置かない=押し間違いを減らす)。

## Global Constraints

- 画面の URL は `/inquiry-desk`。**サイドバーを出さない**。ログイン必須(proxy.ts の公開パスに足さない)。
- 登録の並び順=**業者 → 問い合わせ者(名前・携帯・メール) → 物件 → 用件 → 内見の予定 → 入口 → 保存**(方針12)。「その場で回答した」チェックは**付けない**。
- 用件は **内見/広告の許可/資料請求**。内見なら **案内/下見は必須**・日時は空でよい(日程調整中)。
- 入口の既定は**電話**。担当は登録者(API 側で自動)。
- 資料請求でメールが空なら黄色で「資料の送り先のメールが空です」(保存は止めない)。
- 携帯・代表電話は blur で `formatPhoneJp(x).value`、桁不正なら `電話番号の桁をご確認ください(このままでも保存できます)`(所有者編集と同じ文言)。
- 物件は許可リストの形(`DeskProperty`=物件名・部屋・町名・種別・広告の可否)だけを扱う。**「メイン画面で物件を開く」は `canOpenProperty` のときだけ**、素の `<a href target="pm-main">`(`window.open` は使わない)。
- 次に押す所を光らせる+吹き出し(方針14)。消す設定は端末ごと localStorage `pm-agent-desk-guide-off`(値 `"1"`・読み書きは try/catch)。
- 409 `VERSION_CONFLICT` のときは「他の人が先に更新しました。開き直してください。」を出し、入力は消さない。
- 日時は JST で入力・表示し、API へは `toISOString()`(UTC)で送る。
- スマホ幅でも1枚で使える(`max-w-5xl` の中で2列→狭い幅は1列)。
- commit 末尾:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015eJAMGUbK65d3qvTbeSJBb
  ```

## Review Focus

1. **二重登録**: 保存ボタンの連打・通信中の再押下で同じ反響が2件できる → 保存中はボタンを無効にし、`submitting` の間は `onSubmit` を無視(Task 4 のテストで固定)。
2. **業者を選んだ後に検索欄を打ち直す**: 選んだ業者と画面の表示が食い違ったまま保存される → 検索欄を触ったら選択を外す(Task 2 の reducer テスト)。
3. **日付だけ/時刻だけの入力**: 片方だけでは日時を送らない=日程調整中として保存し、画面に「日程調整中」と出る(Task 2 `jstInputsToIso` テスト)。
4. **権限が外された人**(`agent_inquiry:read` なし)が開いた: 真っ白やエラー連発ではなく「反響の受付の権限がありません」を1つ出す(Task 6 のテスト)。
5. **他人の画面で先に対応済みにされた反響を古い版で更新**: 409 の文言を出し、詳細を読み直せる(Task 5 のテスト)。

---

## File Structure

| ファイル | 役割 |
|---|---|
| `src/lib/api-client.ts`(変更) | 受付の窓が使う API 呼び出しと型 |
| `src/lib/agent-inquiry/desk-form.ts`(新) | フォームの状態・reducer・検証・送る形・次の手順・日時変換・表示ラベル(純関数) |
| `src/app/(desk)/layout.tsx`(新) | SessionProvider+IdleSessionGuard+DeskShell |
| `src/components/agent-inquiry/desk-shell.tsx`(新) | 読み込み中/セッション切れ/見出し(サイドバー無し) |
| `src/components/agent-inquiry/ad-permission-chips.tsx`(新) | 広告の可否 6媒体の ○×△ 表示 |
| `src/components/agent-inquiry/agent-picker.tsx`(新) | 業者の検索と選択(候補一覧は props で描く部品に分ける) |
| `src/components/agent-inquiry/agent-create-modal.tsx`(新) | 名簿にない業者の登録小窓 |
| `src/components/agent-inquiry/property-picker.tsx`(新) | 物件の検索と選択 |
| `src/components/agent-inquiry/inquiry-form.tsx`(新) | 登録フォーム(並び順・光る目印つき) |
| `src/components/agent-inquiry/upcoming-viewings.tsx`(新) | 今日・明日の内見 |
| `src/components/agent-inquiry/inquiry-list.tsx`(新) | 状態タブ・担当の絞り込み・一覧 |
| `src/components/agent-inquiry/inquiry-detail.tsx`(新) | 反響の詳細(状態・担当・メモ・内見の追加/変更/取り消し/結果) |
| `src/components/agent-inquiry/desk-step-guide.tsx`(新) | 次に押す所の光と吹き出し・消す設定 |
| `src/app/(desk)/inquiry-desk/page.tsx`(新) | 画面の組み立て(取得・再読込) |
| `src/components/layout/sidebar-model.tsx`・`sidebar.tsx`(変更) | 「反響の受付」を名前付きの別窓で開く項目 |
| テスト | `src/lib/__tests__/agent-desk-*.test.ts(x)`・`src/components/agent-inquiry/__tests__/*.test.tsx` |

---

### Task 0: worktree の準備

- [ ] **Step 1:** 
```bash
cd C:/Users/issin/Desktop/Claude/property-management-worktrees/agent-inquiry-desk-ui
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npx prisma generate
npx vitest run src/lib/__tests__/agent-inquiry- src/components/layout 2>&1 | tail -3
```
Expected: 失敗 0。

---

### Task 1: API 呼び出しと型(api-client.ts)

**Files:**
- Modify: `src/lib/api-client.ts`(末尾に追記)
- Test: `src/lib/__tests__/agent-desk-api-client.test.ts`

**Interfaces:**
- Produces(型): `DeskProperty`, `AgentHit`, `InquiryView`, `ViewingView`, `UpcomingViewing`, `InquiryCounts`
- Produces(関数):
  - `searchDeskAgents(q: string): Promise<{ agents: AgentHit[] }>`
  - `createDeskAgent(body: DeskAgentInput): Promise<{ id: string }>`
  - `searchDeskProperties(q: string): Promise<{ properties: DeskProperty[] }>`
  - `createAgentInquiry(body: AgentInquiryCreateBody): Promise<{ id: string }>`
  - `fetchAgentInquiries(p: { status?: string; assignee?: string; cursor?: string }): Promise<{ items: InquiryView[]; nextCursor: string | null }>`
  - `fetchAgentInquiry(id: string): Promise<{ inquiry: InquiryView; canOpenProperty: boolean }>`
  - `updateAgentInquiry(id: string, body: { version: number; status?: string; assigneeId?: string | null; note?: string | null }): Promise<{ version: number }>`
  - `addAgentViewing(inquiryId: string, body: { viewingType: "guided" | "preview"; scheduledAt?: string | null; attendantId?: string | null }): Promise<{ id: string }>`
  - `updateAgentViewing(inquiryId: string, viewingId: string, body: { version: number; scheduledAt?: string | null; viewingType?: "guided" | "preview"; attendantId?: string | null; resultNote?: string | null; canceled?: boolean }): Promise<{ ok: true; version: number }>`
  - `fetchAgentInquiryCounts(): Promise<InquiryCounts>`
  - `fetchUpcomingViewings(): Promise<{ viewings: UpcomingViewing[] }>`

- [ ] **Step 1: 失敗するテスト**

```ts
// src/lib/__tests__/agent-desk-api-client.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  searchDeskAgents, createDeskAgent, searchDeskProperties, createAgentInquiry, fetchAgentInquiries,
  fetchAgentInquiry, updateAgentInquiry, addAgentViewing, updateAgentViewing, fetchAgentInquiryCounts,
  fetchUpcomingViewings, apiErrorCode,
} from "@/lib/api-client";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
const call = (n = 0) => ({ url: fetchMock.mock.calls[n][0] as string, init: (fetchMock.mock.calls[n][1] ?? {}) as RequestInit });

describe("受付の窓の API 呼び出し", () => {
  it("検索語は URL に符号化して載せる", async () => {
    await searchDeskAgents("○○ 不動産");
    expect(call().url).toBe("/api/agents?q=%E2%97%8B%E2%97%8B%20%E4%B8%8D%E5%8B%95%E7%94%A3");
    await searchDeskProperties("サンライズ 305");
    expect(call(1).url).toBe("/api/agent-inquiries/property-search?q=" + encodeURIComponent("サンライズ 305"));
  });
  it("登録系は POST+JSON", async () => {
    await createDeskAgent({ companyName: "x", phone: "03" });
    expect(call().url).toBe("/api/agents");
    expect(call().init.method).toBe("POST");
    await createAgentInquiry({ propertyId: "p", agentId: "a", kind: "ad_permission", channel: "phone" });
    expect(call(1).url).toBe("/api/agent-inquiries");
    expect(JSON.parse(String(call(1).init.body))).toMatchObject({ kind: "ad_permission" });
  });
  it("一覧は空の条件を URL に載せない", async () => {
    await fetchAgentInquiries({ status: "open" });
    expect(call().url).toBe("/api/agent-inquiries?status=open");
    await fetchAgentInquiries({ status: "done", assignee: "me", cursor: "c1" });
    expect(call(1).url).toBe("/api/agent-inquiries?status=done&assignee=me&cursor=c1");
  });
  it("詳細・変更・内見", async () => {
    await fetchAgentInquiry("i1");
    expect(call().url).toBe("/api/agent-inquiries/i1");
    await updateAgentInquiry("i1", { version: 2, status: "done" });
    expect(call(1).init.method).toBe("PATCH");
    await addAgentViewing("i1", { viewingType: "guided" });
    expect(call(2).url).toBe("/api/agent-inquiries/i1/viewings");
    await updateAgentViewing("i1", "v1", { version: 1, canceled: true });
    expect(call(3).url).toBe("/api/agent-inquiries/i1/viewings/v1");
    await fetchAgentInquiryCounts();
    expect(call(4).url).toBe("/api/agent-inquiries/counts");
    await fetchUpcomingViewings();
    expect(call(5).url).toBe("/api/agent-inquiries/upcoming");
  });
  it("409 は code=VERSION_CONFLICT として読める", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "VERSION_CONFLICT", message: "x" } }), { status: 409 }));
    const e = await updateAgentInquiry("i1", { version: 1, status: "done" }).catch((err) => err);
    expect(apiErrorCode(e)).toBe("VERSION_CONFLICT");
  });
});
```

- [ ] **Step 2: 失敗を確認** — `npx vitest run src/lib/__tests__/agent-desk-api-client.test.ts` → FAIL(export がない)

- [ ] **Step 3: 実装**(`src/lib/api-client.ts` の末尾に追記。`apiFetch` は同じファイルの private 関数)

```ts
// ============================================================
// 業者からの反響の受付(受付の窓)— 設計 docs/superpowers/specs/2026-09-28-agent-inquiry-desk-design.md
// ============================================================
export type AdMediumKey = "own_site" | "athome" | "suumo" | "homes" | "other_portal" | "flyer";
export type AdValueKey = "ok" | "ng" | "ask";
export type InquiryKindKey = "viewing" | "ad_permission" | "material_request";
export type InquiryStatusKey = "open" | "in_progress" | "done";
export type InquiryChannelKey = "phone" | "email" | "fax";
export type ViewingTypeKey = "guided" | "preview";

/** 受付の窓に出してよい物件の形(API の許可リストと同じ)。 */
export interface DeskProperty {
  id: string;
  name: string;
  roomNo: string | null;
  town: string;
  propertyType: string;
  adPermissions: Partial<Record<AdMediumKey, AdValueKey>>;
}
export interface AgentHit {
  id: string;
  companyName: string;
  branchName: string | null;
  phone: string;
  lastContact: { name: string | null; mobile: string | null; email: string | null } | null;
  matchedBy: "phone" | "mobile" | "text";
}
export interface ViewingView {
  id: string;
  scheduledAt: string | null;
  viewingType: ViewingTypeKey;
  canceledAt: string | null;
  resultNote: string | null;
  version: number;
  attendant: { id: string; name: string } | null;
}
export interface InquiryView {
  id: string;
  kind: InquiryKindKey;
  status: InquiryStatusKey;
  channel: InquiryChannelKey;
  receivedAt: string;
  version: number;
  contactName: string | null;
  contactMobile: string | null;
  contactEmail: string | null;
  note: string | null;
  assignee: { id: string; name: string } | null;
  agent: { id: string; companyName: string; branchName: string | null; phone: string };
  viewings: ViewingView[];
  property: DeskProperty;
}
export interface UpcomingViewing {
  id: string;
  scheduledAt: string;
  viewingType: ViewingTypeKey;
  version: number;
  attendant: { id: string; name: string } | null;
  inquiry: { id: string; contactName: string | null; agent: { companyName: string }; property: DeskProperty };
}
export interface InquiryCounts { open: number; upcomingViewings: number }
export interface DeskAgentInput {
  companyName: string;
  phone: string;
  companyKana?: string | null;
  branchName?: string | null;
  licenseNo?: string | null;
  fax?: string | null;
  email?: string | null;
  address?: string | null;
  note?: string | null;
}
export interface AgentInquiryCreateBody {
  propertyId: string;
  agentId: string;
  kind: InquiryKindKey;
  channel: InquiryChannelKey;
  contactName?: string | null;
  contactMobile?: string | null;
  contactEmail?: string | null;
  note?: string | null;
  viewing?: { viewingType: ViewingTypeKey; scheduledAt?: string | null; attendantId?: string | null };
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function searchDeskAgents(q: string) {
  if (USE_MOCK) { await mockDelay(); return { agents: [] as AgentHit[] }; }
  return apiFetch<{ agents: AgentHit[] }>(`/api/agents?q=${encodeURIComponent(q)}`);
}
export async function createDeskAgent(body: DeskAgentInput) {
  if (USE_MOCK) { await mockDelay(); return { id: "mock-agent" }; }
  return apiFetch<{ id: string }>("/api/agents", jsonInit("POST", body));
}
export async function searchDeskProperties(q: string) {
  if (USE_MOCK) { await mockDelay(); return { properties: [] as DeskProperty[] }; }
  return apiFetch<{ properties: DeskProperty[] }>(`/api/agent-inquiries/property-search?q=${encodeURIComponent(q)}`);
}
export async function createAgentInquiry(body: AgentInquiryCreateBody) {
  if (USE_MOCK) { await mockDelay(); return { id: "mock-inquiry" }; }
  return apiFetch<{ id: string }>("/api/agent-inquiries", jsonInit("POST", body));
}
export async function fetchAgentInquiries(p: { status?: string; assignee?: string; cursor?: string }) {
  if (USE_MOCK) { await mockDelay(); return { items: [] as InquiryView[], nextCursor: null as string | null }; }
  const sp = new URLSearchParams();
  if (p.status) sp.set("status", p.status);
  if (p.assignee) sp.set("assignee", p.assignee);
  if (p.cursor) sp.set("cursor", p.cursor);
  const qs = sp.toString();
  return apiFetch<{ items: InquiryView[]; nextCursor: string | null }>(`/api/agent-inquiries${qs ? `?${qs}` : ""}`);
}
export async function fetchAgentInquiry(id: string) {
  if (USE_MOCK) { await mockDelay(); throw new Error("mock"); }
  return apiFetch<{ inquiry: InquiryView; canOpenProperty: boolean }>(`/api/agent-inquiries/${id}`);
}
export async function updateAgentInquiry(
  id: string,
  body: { version: number; status?: string; assigneeId?: string | null; note?: string | null },
) {
  if (USE_MOCK) { await mockDelay(); return { version: body.version + 1 }; }
  return apiFetch<{ version: number }>(`/api/agent-inquiries/${id}`, jsonInit("PATCH", body));
}
export async function addAgentViewing(
  inquiryId: string,
  body: { viewingType: ViewingTypeKey; scheduledAt?: string | null; attendantId?: string | null },
) {
  if (USE_MOCK) { await mockDelay(); return { id: "mock-viewing" }; }
  return apiFetch<{ id: string }>(`/api/agent-inquiries/${inquiryId}/viewings`, jsonInit("POST", body));
}
export async function updateAgentViewing(
  inquiryId: string,
  viewingId: string,
  body: {
    version: number;
    scheduledAt?: string | null;
    viewingType?: ViewingTypeKey;
    attendantId?: string | null;
    resultNote?: string | null;
    canceled?: boolean;
  },
) {
  if (USE_MOCK) { await mockDelay(); return { ok: true as const, version: body.version + 1 }; }
  return apiFetch<{ ok: true; version: number }>(
    `/api/agent-inquiries/${inquiryId}/viewings/${viewingId}`,
    jsonInit("PATCH", body),
  );
}
export async function fetchAgentInquiryCounts() {
  if (USE_MOCK) { await mockDelay(); return { open: 0, upcomingViewings: 0 }; }
  return apiFetch<InquiryCounts>("/api/agent-inquiries/counts");
}
export async function fetchUpcomingViewings() {
  if (USE_MOCK) { await mockDelay(); return { viewings: [] as UpcomingViewing[] }; }
  return apiFetch<{ viewings: UpcomingViewing[] }>("/api/agent-inquiries/upcoming");
}
```
⚠ `mockDelay` と `USE_MOCK` は同じファイルにある既存のもの。`apiErrorCode` も既存の export。

- [ ] **Step 4: 通過を確認** → PASS・`npx tsc --noEmit` = 0
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-inquiry): 受付の窓の API 呼び出しと型"`

---

### Task 2: フォームの純関数(desk-form.ts)

**Files:**
- Create: `src/lib/agent-inquiry/desk-form.ts`
- Test: `src/lib/__tests__/agent-desk-form.test.ts`

**Interfaces:**
- Consumes: Task 1 の型(`AgentHit`, `DeskProperty`, `InquiryKindKey`, `InquiryChannelKey`, `ViewingTypeKey`, `AgentInquiryCreateBody`)
- Produces:
  - `DeskFormState`・`EMPTY_DESK_FORM`・`deskFormReducer(state, action): DeskFormState`
  - `DeskFormAction` = `{type:"agentQuery", value}` | `{type:"agentSelected", agent: AgentHit}` | `{type:"contact", field: "contactName"|"contactMobile"|"contactEmail", value}` | `{type:"propertyQuery", value}` | `{type:"propertySelected", property: DeskProperty}` | `{type:"kind", value: InquiryKindKey}` | `{type:"viewing", field: "viewingType"|"date"|"time"|"attendantId", value}` | `{type:"channel", value: InquiryChannelKey}` | `{type:"note", value}` | `{type:"reset"}`
  - `DeskGuideStep = "agent" | "property" | "kind" | "viewingType" | "save"` と `nextDeskGuideStep(state): DeskGuideStep`・`DESK_GUIDE_TIPS: Record<DeskGuideStep, string>`
  - `validateDeskForm(state): Partial<Record<"agent"|"property"|"kind"|"viewingType", string>>`
  - `materialEmailWarning(state): string | null`
  - `buildCreateBody(state): AgentInquiryCreateBody`(検証が通った前提)
  - `jstInputsToIso(date: string, time: string): string | null`・`isoToJstInputs(iso: string | null): { date: string; time: string }`・`formatJst(iso: string | null): string`
  - `KIND_LABEL`, `STATUS_LABEL`, `CHANNEL_LABEL`, `VIEWING_TYPE_LABEL`, `AD_MEDIA_ORDER`, `AD_MEDIUM_LABEL`, `AD_VALUE_MARK`
  - `CONFLICT_MESSAGE = "他の人が先に更新しました。開き直してください。"`

- [ ] **Step 1: 失敗するテスト**

```ts
// src/lib/__tests__/agent-desk-form.test.ts
import { describe, it, expect } from "vitest";
import {
  EMPTY_DESK_FORM, deskFormReducer, nextDeskGuideStep, validateDeskForm, materialEmailWarning,
  buildCreateBody, jstInputsToIso, isoToJstInputs, formatJst, type DeskFormState,
} from "@/lib/agent-inquiry/desk-form";

const agent = { id: "a1", companyName: "○○不動産", branchName: null, phone: "03-1", matchedBy: "mobile" as const,
  lastContact: { name: "田中", mobile: "090-1234-5678", email: "t@x.jp" } };
const property = { id: "p1", name: "サンライズ中野", roomNo: "305", town: "東京都中野区中野2丁目", propertyType: "apartment_unit", adPermissions: {} };
const run = (...actions: Parameters<typeof deskFormReducer>[1][]) =>
  actions.reduce((s, a) => deskFormReducer(s, a), EMPTY_DESK_FORM);

describe("フォームの状態", () => {
  it("携帯で当たった業者を選ぶと問い合わせ者を前回の値で埋める", () => {
    const s = run({ type: "agentSelected", agent });
    expect(s.agent?.id).toBe("a1");
    expect([s.contactName, s.contactMobile, s.contactEmail]).toEqual(["田中", "090-1234-5678", "t@x.jp"]);
    expect(s.agentQuery).toBe("○○不動産");
  });
  it("選んだ後に検索欄を打ち直したら選択を外す(表示と中身の食い違いを防ぐ)", () => {
    const s = run({ type: "agentSelected", agent }, { type: "agentQuery", value: "△△" });
    expect(s.agent).toBeNull();
    const p = run({ type: "propertySelected", property }, { type: "propertyQuery", value: "別" });
    expect(p.property).toBeNull();
  });
  it("用件を内見以外にすると内見の入力を消す", () => {
    const s = run({ type: "kind", value: "viewing" }, { type: "viewing", field: "viewingType", value: "guided" }, { type: "kind", value: "ad_permission" });
    expect(s.viewingType).toBeNull();
  });
  it("reset で空に戻る(入口は電話)", () => {
    expect(run({ type: "channel", value: "fax" }, { type: "reset" })).toEqual(EMPTY_DESK_FORM);
    expect(EMPTY_DESK_FORM.channel).toBe("phone");
  });
});

describe("次に押す所", () => {
  it.each<[string, DeskFormState, string]>([
    ["最初は業者", EMPTY_DESK_FORM, "agent"],
    ["業者の次は物件", run({ type: "agentSelected", agent }), "property"],
    ["物件の次は用件", run({ type: "agentSelected", agent }, { type: "propertySelected", property }), "kind"],
    ["内見なら案内/下見", run({ type: "agentSelected", agent }, { type: "propertySelected", property }, { type: "kind", value: "viewing" }), "viewingType"],
    ["揃ったら保存", run({ type: "agentSelected", agent }, { type: "propertySelected", property }, { type: "kind", value: "ad_permission" }), "save"],
  ])("%s", (_l, s, want) => expect(nextDeskGuideStep(s)).toBe(want));
});

describe("検証と送る形", () => {
  it("業者・物件・用件は必須・内見なら案内/下見も必須", () => {
    expect(Object.keys(validateDeskForm(EMPTY_DESK_FORM)).sort()).toEqual(["agent", "kind", "property"]);
    const s = run({ type: "agentSelected", agent }, { type: "propertySelected", property }, { type: "kind", value: "viewing" });
    expect(validateDeskForm(s)).toEqual({ viewingType: "案内か下見かを選んでください" });
  });
  it("資料請求でメールが空なら黄色の知らせ(保存は止めない)", () => {
    const s = run({ type: "agentSelected", agent: { ...agent, lastContact: null } }, { type: "propertySelected", property }, { type: "kind", value: "material_request" });
    expect(materialEmailWarning(s)).toBe("資料の送り先のメールが空です");
    expect(validateDeskForm(s)).toEqual({});
  });
  it("送る形: 内見は日時つき(JST→UTC)・空欄は送らない", () => {
    const s = run(
      { type: "agentSelected", agent }, { type: "propertySelected", property }, { type: "kind", value: "viewing" },
      { type: "viewing", field: "viewingType", value: "guided" }, { type: "viewing", field: "date", value: "2026-10-02" },
      { type: "viewing", field: "time", value: "14:00" }, { type: "note", value: "  " },
    );
    expect(buildCreateBody(s)).toEqual({
      propertyId: "p1", agentId: "a1", kind: "viewing", channel: "phone",
      contactName: "田中", contactMobile: "090-1234-5678", contactEmail: "t@x.jp", note: null,
      viewing: { viewingType: "guided", scheduledAt: "2026-10-02T05:00:00.000Z", attendantId: null },
    });
  });
  it("広告の許可は viewing を付けない", () => {
    const s = run({ type: "agentSelected", agent }, { type: "propertySelected", property }, { type: "kind", value: "ad_permission" });
    expect(buildCreateBody(s).viewing).toBeUndefined();
  });
});

describe("日時(JST)", () => {
  it("日付と時刻が揃ったときだけ UTC にする(片方だけ=日程調整中)", () => {
    expect(jstInputsToIso("2026-10-02", "14:00")).toBe("2026-10-02T05:00:00.000Z");
    expect(jstInputsToIso("2026-10-02", "")).toBeNull();
    expect(jstInputsToIso("", "14:00")).toBeNull();
    expect(jstInputsToIso("2026-13-40", "14:00")).toBeNull();
  });
  it("戻す・表示する", () => {
    expect(isoToJstInputs("2026-10-02T05:00:00.000Z")).toEqual({ date: "2026-10-02", time: "14:00" });
    expect(isoToJstInputs(null)).toEqual({ date: "", time: "" });
    expect(formatJst("2026-10-01T15:30:00.000Z")).toBe("10/2(金) 0:30");
    expect(formatJst(null)).toBe("日程調整中");
  });
});
```

- [ ] **Step 2: 失敗を確認** → FAIL(module not found)

- [ ] **Step 3: 実装**

```ts
// src/lib/agent-inquiry/desk-form.ts
import type {
  AgentHit, AgentInquiryCreateBody, AdMediumKey, AdValueKey, DeskProperty, InquiryChannelKey, InquiryKindKey,
  InquiryStatusKey, ViewingTypeKey,
} from "@/lib/api-client";

/** 受付の窓の登録フォーム(設計 §2.2)。並び順=業者→問い合わせ者→物件→用件→内見→入口→保存。 */
export interface DeskFormState {
  agentQuery: string;
  agent: AgentHit | null;
  contactName: string;
  contactMobile: string;
  contactEmail: string;
  propertyQuery: string;
  property: DeskProperty | null;
  kind: InquiryKindKey | null;
  viewingType: ViewingTypeKey | null;
  viewingDate: string;
  viewingTime: string;
  attendantId: string;
  channel: InquiryChannelKey;
  note: string;
}

export const EMPTY_DESK_FORM: DeskFormState = {
  agentQuery: "", agent: null, contactName: "", contactMobile: "", contactEmail: "",
  propertyQuery: "", property: null, kind: null, viewingType: null, viewingDate: "", viewingTime: "",
  attendantId: "", channel: "phone", note: "",
};

export type DeskFormAction =
  | { type: "agentQuery"; value: string }
  | { type: "agentSelected"; agent: AgentHit }
  | { type: "contact"; field: "contactName" | "contactMobile" | "contactEmail"; value: string }
  | { type: "propertyQuery"; value: string }
  | { type: "propertySelected"; property: DeskProperty }
  | { type: "kind"; value: InquiryKindKey }
  | { type: "viewing"; field: "viewingType" | "date" | "time" | "attendantId"; value: string }
  | { type: "channel"; value: InquiryChannelKey }
  | { type: "note"; value: string }
  | { type: "reset" };

export function deskFormReducer(s: DeskFormState, a: DeskFormAction): DeskFormState {
  switch (a.type) {
    case "agentQuery":
      // 選んだ後に打ち直したら選択を外す(画面の表示と保存される業者が食い違わないように)。
      return { ...s, agentQuery: a.value, agent: null };
    case "agentSelected": {
      const c = a.agent.lastContact;
      return {
        ...s,
        agent: a.agent,
        agentQuery: a.agent.companyName,
        ...(c
          ? { contactName: c.name ?? "", contactMobile: c.mobile ?? "", contactEmail: c.email ?? "" }
          : {}),
      };
    }
    case "contact":
      return { ...s, [a.field]: a.value };
    case "propertyQuery":
      return { ...s, propertyQuery: a.value, property: null };
    case "propertySelected":
      return {
        ...s,
        property: a.property,
        propertyQuery: a.property.roomNo ? `${a.property.name} ${a.property.roomNo}` : a.property.name,
      };
    case "kind":
      return a.value === "viewing"
        ? { ...s, kind: a.value }
        : { ...s, kind: a.value, viewingType: null, viewingDate: "", viewingTime: "", attendantId: "" };
    case "viewing":
      if (a.field === "viewingType") return { ...s, viewingType: a.value === "preview" ? "preview" : "guided" };
      if (a.field === "date") return { ...s, viewingDate: a.value };
      if (a.field === "time") return { ...s, viewingTime: a.value };
      return { ...s, attendantId: a.value };
    case "channel":
      return { ...s, channel: a.value };
    case "note":
      return { ...s, note: a.value };
    case "reset":
      return EMPTY_DESK_FORM;
  }
}

export type DeskGuideStep = "agent" | "property" | "kind" | "viewingType" | "save";
export const DESK_GUIDE_TIPS: Record<DeskGuideStep, string> = {
  agent: "まず業者を探します。電話番号か会社名を打ってください",
  property: "次に物件を選びます。物件名・部屋番号・所在地で探せます",
  kind: "用件を選んでください",
  viewingType: "案内(お客様連れ)か下見(業者だけ)かを選んでください",
  save: "あとは保存するだけです",
};

/** 次に押す所(方針14)。 */
export function nextDeskGuideStep(s: DeskFormState): DeskGuideStep {
  if (!s.agent) return "agent";
  if (!s.property) return "property";
  if (!s.kind) return "kind";
  if (s.kind === "viewing" && !s.viewingType) return "viewingType";
  return "save";
}

export function validateDeskForm(s: DeskFormState) {
  const e: Partial<Record<"agent" | "property" | "kind" | "viewingType", string>> = {};
  if (!s.agent) e.agent = "業者を選んでください";
  if (!s.property) e.property = "物件を選んでください";
  if (!s.kind) e.kind = "用件を選んでください";
  if (s.kind === "viewing" && !s.viewingType) e.viewingType = "案内か下見かを選んでください";
  return e;
}

export function materialEmailWarning(s: DeskFormState): string | null {
  return s.kind === "material_request" && s.contactEmail.trim() === "" ? "資料の送り先のメールが空です" : null;
}

const orNull = (v: string) => (v.trim() === "" ? null : v.trim());

export function buildCreateBody(s: DeskFormState): AgentInquiryCreateBody {
  return {
    propertyId: s.property!.id,
    agentId: s.agent!.id,
    kind: s.kind!,
    channel: s.channel,
    contactName: orNull(s.contactName),
    contactMobile: orNull(s.contactMobile),
    contactEmail: orNull(s.contactEmail),
    note: orNull(s.note),
    ...(s.kind === "viewing" && s.viewingType
      ? {
          viewing: {
            viewingType: s.viewingType,
            scheduledAt: jstInputsToIso(s.viewingDate, s.viewingTime),
            attendantId: orNull(s.attendantId),
          },
        }
      : {}),
  };
}

/** 日付と時刻(JST)が揃ったときだけ UTC の ISO にする。片方だけ=日程調整中(null)。 */
export function jstInputsToIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = new Date(`${date}T${time}:00+09:00`);
  if (Number.isNaN(d.getTime())) return null;
  // 2026-13-40 のような日付は Date が繰り上げるので、戻して一致するかで弾く。
  return isoToJstInputs(d.toISOString()).date === date ? d.toISOString() : null;
}

const JST_MS = 9 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");
export function isoToJstInputs(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const j = new Date(new Date(iso).getTime() + JST_MS);
  return {
    date: `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}`,
    time: `${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`,
  };
}
const WEEK = "日月火水木金土";
export function formatJst(iso: string | null): string {
  if (!iso) return "日程調整中";
  const j = new Date(new Date(iso).getTime() + JST_MS);
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()}(${WEEK[j.getUTCDay()]}) ${j.getUTCHours()}:${pad(j.getUTCMinutes())}`;
}

export const KIND_LABEL: Record<InquiryKindKey, string> = { viewing: "内見", ad_permission: "広告の許可", material_request: "資料請求" };
export const STATUS_LABEL: Record<InquiryStatusKey, string> = { open: "未対応", in_progress: "対応中", done: "対応済み" };
export const CHANNEL_LABEL: Record<InquiryChannelKey, string> = { phone: "電話", email: "メール", fax: "FAX" };
export const VIEWING_TYPE_LABEL: Record<ViewingTypeKey, string> = { guided: "案内", preview: "下見" };
export const AD_MEDIA_ORDER: AdMediumKey[] = ["own_site", "athome", "suumo", "homes", "other_portal", "flyer"];
export const AD_MEDIUM_LABEL: Record<AdMediumKey, string> = {
  own_site: "自社HP", athome: "at home", suumo: "SUUMO", homes: "HOME'S", other_portal: "その他", flyer: "チラシ",
};
export const AD_VALUE_MARK: Record<AdValueKey, string> = { ok: "○", ng: "×", ask: "△" };
export const CONFLICT_MESSAGE = "他の人が先に更新しました。開き直してください。";
```

- [ ] **Step 4: 通過を確認** → PASS(`formatJst` の曜日は 2026-10-02 が金曜で合っていることを確認)
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-inquiry): 受付の窓のフォームの純関数"`

---

### Task 3: サイドバーの無いレイアウト・「反響の受付」メニュー

**Files:**
- Create: `src/app/(desk)/layout.tsx`, `src/components/agent-inquiry/desk-shell.tsx`
- Modify: `src/components/layout/sidebar-model.tsx`(NavLeaf に `windowName?` と項目追加), `src/components/layout/sidebar.tsx`(`target`)
- Test: `src/components/agent-inquiry/__tests__/desk-shell.test.tsx`, `src/lib/__tests__/agent-desk-routing.test.ts`

**Interfaces:**
- Produces: `DeskShellView({ status, userName, openCount, pathname, children })`(見た目だけ・SSR テスト用)と既定エクスポート `DeskShell({ children })`(useSession を読む)

- [ ] **Step 1: 失敗するテスト**

```tsx
// src/components/agent-inquiry/__tests__/desk-shell.test.tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null, status: "loading" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/inquiry-desk" }));
import { DeskShellView } from "../desk-shell";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("受付の窓の枠(サイドバー無し)", () => {
  it("読み込み中/セッション切れ/通常", () => {
    expect(renderToStaticMarkup(<DeskShellView status="loading" userName="" openCount={null} pathname="/inquiry-desk">x</DeskShellView>)).toContain("読み込み中");
    const out = renderToStaticMarkup(<DeskShellView status="unauthenticated" userName="" openCount={null} pathname="/inquiry-desk">x</DeskShellView>);
    expect(out).toContain("セッションが切れました");
    expect(out).toContain("/login?callbackUrl=%2Finquiry-desk");
    const ok = renderToStaticMarkup(<DeskShellView status="authenticated" userName="佐藤" openCount={3} pathname="/inquiry-desk"><p>中身</p></DeskShellView>);
    expect(ok).toContain("反響の受付");
    expect(ok).toContain("佐藤");
    expect(ok).toContain("未対応 3件");
    expect(ok).toContain("<p>中身</p>");
  });
  it("レイアウトはログイン管理と無操作ログアウトを持ち、サイドバーを読み込まない", () => {
    const src = read("src/app/(desk)/layout.tsx");
    expect(src).toMatch(/<SessionProvider>/);
    expect(src).toMatch(/<IdleSessionGuard \/>/);
    expect(src).not.toMatch(/sidebar|DashboardLayout/i);
  });
});
```

```ts
// src/lib/__tests__/agent-desk-routing.test.ts
import { describe, it, expect } from "vitest";
import { isPublicPath } from "@/proxy";
import { SIDEBAR_GROUPS } from "@/components/layout/sidebar-model";

describe("受付の窓への入口", () => {
  it("ログイン必須(公開パスではない)", () => {
    expect(isPublicPath("/inquiry-desk")).toBe(false);
  });
  it("サイドバーに「反響の受付」=名前付きの別窓で開く・全員に見える", () => {
    const item = SIDEBAR_GROUPS.flatMap((g) => g.items).find((i) => i.href === "/inquiry-desk");
    expect(item).toMatchObject({ label: "反響の受付", external: true, windowName: "pm-inquiry-desk", minRole: "field_staff" });
  });
});
```
(`isPublicPath` の実際の export 名・引数は `src/proxy.ts` を読んで合わせる。既存テスト `sale-dm-proxy-public-path.test.ts` の呼び方を写す。)

- [ ] **Step 2: 失敗を確認** → FAIL

- [ ] **Step 3: 実装**

```tsx
// src/app/(desk)/layout.tsx
import { SessionProvider } from "next-auth/react";
import { IdleSessionGuard } from "@/components/auth/idle-session-guard";
import DeskShell from "@/components/agent-inquiry/desk-shell";

/** 受付の窓(設計 §2.1・方針11)。メイン画面と分けて開きっぱなしにする=サイドバーを出さない。 */
export default function DeskRouteLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      {/* 無操作1時間でログアウト(メイン画面と同じ)。 */}
      <IdleSessionGuard />
      <DeskShell>{children}</DeskShell>
    </SessionProvider>
  );
}
```

```tsx
// src/components/agent-inquiry/desk-shell.tsx
"use client";

import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { USE_MOCK } from "@/lib/api-client";

type ShellStatus = "loading" | "authenticated" | "unauthenticated";

/** 見た目だけ(テスト用に切り出し)。読み込み中/セッション切れの扱いはメイン画面の枠と同じ。 */
export function DeskShellView({
  status, userName, openCount, pathname, children,
}: {
  status: ShellStatus;
  userName: string;
  openCount: number | null;
  pathname: string;
  children: React.ReactNode;
}) {
  if (status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="flex flex-col items-center gap-3 text-gray-500 dark:text-gray-400">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-teal-600 dark:border-gray-700" />
          <p className="text-sm">読み込み中…</p>
        </div>
      </div>
    );
  }
  if (status === "unauthenticated") {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 p-6 dark:bg-gray-950">
        <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <p className="mb-1 text-base font-semibold text-gray-900 dark:text-gray-100">セッションが切れました</p>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">ログインし直してください。</p>
          <a
            href={`/login?callbackUrl=${encodeURIComponent(pathname)}`}
            className="inline-block rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-600"
          >
            ログイン画面へ
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <header className="sticky top-0 z-20 flex items-center justify-between bg-teal-700 px-4 py-2 text-white">
        <h1 className="text-base font-bold">反響の受付</h1>
        <p className="text-xs">
          {userName}
          {openCount != null && <span className="ml-2 rounded bg-white/20 px-2 py-0.5">未対応 {openCount}件</span>}
        </p>
      </header>
      <main className="mx-auto max-w-5xl p-3 sm:p-4">{children}</main>
    </div>
  );
}

/** 未対応件数は画面(page)が読み込んで window イベントで渡す(枠は取得しない)。 */
export const DESK_OPEN_COUNT_EVENT = "pm-agent-desk-open-count";

export default function DeskShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/inquiry-desk";
  const { data: session, status } = useSession();
  const openCount = useOpenCount();
  const effective: ShellStatus = USE_MOCK ? "authenticated" : status;
  return (
    <DeskShellView
      status={effective}
      userName={USE_MOCK ? "モック管理者" : (session?.user?.name ?? "")}
      openCount={openCount}
      pathname={pathname}
    >
      {children}
    </DeskShellView>
  );
}

import { useEffect, useState } from "react";
function useOpenCount() {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    const on = (e: Event) => setN((e as CustomEvent<number>).detail);
    window.addEventListener(DESK_OPEN_COUNT_EVENT, on);
    return () => window.removeEventListener(DESK_OPEN_COUNT_EVENT, on);
  }, []);
  return n;
}
```
(import はファイル先頭へまとめる。上は説明の都合で分けて書いている。)

`sidebar-model.tsx`: `NavLeaf` に
```ts
  /** external のとき開く窓の名前(同じ名前の窓があればそこに開く)。無ければ新しいタブ。 */
  windowName?: string;
```
を足し、`home` グループの items を
```ts
    items: [
      { label: "ホーム", href: "/home", icon: ic(Home), minRole: "field_staff" },
      // 受付の窓(設計 §2.1)=メイン画面と分けて別窓で開きっぱなしにする。全員が使う(方針10)。
      { label: "反響の受付", href: "/inquiry-desk", icon: ic(PhoneIncoming), minRole: "field_staff", external: true, windowName: "pm-inquiry-desk" },
    ],
```
にする(`PhoneIncoming` を lucide-react の import に足す)。`sidebar.tsx` の external の `<a>` の `target="_blank"` を `target={item.windowName ?? "_blank"}` にする。

- [ ] **Step 4: 通過を確認** — 2ファイル+`npx vitest run src/components/layout src/components/home` も PASS(ホームのカードとサイドバーの整合テスト)。tsc 0。
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-inquiry): 受付の窓の枠(サイドバー無し)とメニュー"`

---

### Task 4: 登録フォーム(業者・物件の選択・新しい業者の小窓・広告の可否)

**Files:**
- Create: `src/components/agent-inquiry/ad-permission-chips.tsx`, `agent-picker.tsx`, `agent-create-modal.tsx`, `property-picker.tsx`, `inquiry-form.tsx`
- Test: `src/components/agent-inquiry/__tests__/inquiry-form.test.tsx`

**Interfaces:**
- Consumes: Task 1 の API・型、Task 2 の reducer・ラベル・検証
- Produces:
  - `AdPermissionChips({ value }: { value: DeskProperty["adPermissions"] })`
  - `AgentResults({ hits, onPick })`(候補一覧の見た目)・`AgentPicker({ query, selected, onQuery, onPick, onCreateNew })`
  - `AgentCreateModal({ initialPhone, onClose, onCreated })`(`onCreated(hit: AgentHit)`)
  - `PropertyResults({ hits, onPick })`・`PropertyPicker({ query, selected, onQuery, onPick })`
  - `InquiryFormView({ state, dispatch, users, errors, warning, submitting, message, onSubmit, onCreateAgent })`(見た目・SSR テスト)と既定 `InquiryForm({ users, onSaved })`(状態と保存を持つ親)

- [ ] **Step 1: 失敗するテスト**

```tsx
// src/components/agent-inquiry/__tests__/inquiry-form.test.tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_DESK_FORM, deskFormReducer } from "@/lib/agent-inquiry/desk-form";
import { InquiryFormView } from "../inquiry-form";
import { AdPermissionChips } from "../ad-permission-chips";
import { AgentResults } from "../agent-picker";

const agent = { id: "a1", companyName: "○○不動産", branchName: "新宿店", phone: "03-1234-5678", matchedBy: "mobile" as const,
  lastContact: { name: "田中", mobile: "090-1234-5678", email: null } };
const property = { id: "p1", name: "サンライズ中野", roomNo: "305", town: "東京都中野区中野2丁目", propertyType: "apartment_unit",
  adPermissions: { athome: "ok" as const, homes: "ng" as const, other_portal: "ask" as const } };
const view = (over: Partial<Parameters<typeof InquiryFormView>[0]> = {}) =>
  renderToStaticMarkup(
    <InquiryFormView state={EMPTY_DESK_FORM} dispatch={() => {}} users={[]} errors={{}} warning={null}
      submitting={false} message={null} onSubmit={() => {}} onCreateAgent={() => {}} {...over} />,
  );

describe("登録フォーム", () => {
  it("並び順=業者→問い合わせ者→物件→用件→入口→保存(方針12)", () => {
    const html = view();
    const idx = ["業者(代表電話・携帯・会社名)", "問い合わせ者", "物件(物件名・部屋・所在地)", "用件", "入口", "保存する"].map((t) => html.indexOf(t));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
  it("内見のときだけ内見の予定が出て、案内/下見・日付・時刻・立ち会い", () => {
    expect(view()).not.toContain("内見の予定");
    const s = deskFormReducer(EMPTY_DESK_FORM, { type: "kind", value: "viewing" });
    const html = view({ state: s, users: [{ id: "u1", name: "佐藤" }] });
    for (const t of ["内見の予定", "案内(お客様連れ)", "下見(業者のみ)", 'type="date"', 'type="time"', "立ち会い", "佐藤"]) expect(html).toContain(t);
  });
  it("光る目印(data-guide)が各所にある", () => {
    const s = deskFormReducer(EMPTY_DESK_FORM, { type: "kind", value: "viewing" });
    const html = view({ state: s });
    for (const k of ["agent", "property", "kind", "viewingType", "save"]) expect(html).toContain(`data-guide="${k}"`);
  });
  it("「その場で回答した」チェックは無い(方針12)", () => {
    expect(view()).not.toContain("その場で回答");
  });
  it("保存中はボタンを押せない(二重登録を防ぐ)", () => {
    expect(view({ submitting: true })).toMatch(/<button[^>]*disabled=""[^>]*data-guide="save"|<button[^>]*data-guide="save"[^>]*disabled=""/);
    expect(view({ submitting: true })).toContain("保存中…");
  });
  it("エラーと資料請求のメール空の知らせ", () => {
    const html = view({ errors: { agent: "業者を選んでください" }, warning: "資料の送り先のメールが空です" });
    expect(html).toContain("業者を選んでください");
    expect(html).toContain("資料の送り先のメールが空です");
  });
  it("選んだ物件の広告の可否が出る", () => {
    const s = deskFormReducer(EMPTY_DESK_FORM, { type: "propertySelected", property });
    const html = view({ state: s });
    expect(html).toContain("サンライズ中野 305");
    expect(html).toContain("東京都中野区中野2丁目");
  });
});

describe("広告の可否", () => {
  it("6媒体を ○×△/— で出す", () => {
    const html = renderToStaticMarkup(<AdPermissionChips value={property.adPermissions} />);
    for (const t of ["自社HP", "at home", "SUUMO", "HOME'S", "その他", "チラシ", "○", "×", "△", "—"]) expect(html).toContain(t);
  });
});

describe("業者の候補", () => {
  it("携帯で当たったら前回の問い合わせ者を出す", () => {
    const html = renderToStaticMarkup(<AgentResults hits={[agent]} onPick={vi.fn()} />);
    expect(html).toContain("○○不動産 新宿店");
    expect(html).toContain("代表 03-1234-5678");
    expect(html).toContain("前回 田中様");
  });
});
```

- [ ] **Step 2: 失敗を確認** → FAIL(module not found)

- [ ] **Step 3: 実装**

```tsx
// src/components/agent-inquiry/ad-permission-chips.tsx
import type { DeskProperty } from "@/lib/api-client";
import { AD_MEDIA_ORDER, AD_MEDIUM_LABEL, AD_VALUE_MARK } from "@/lib/agent-inquiry/desk-form";

const TONE = {
  ok: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  ng: "bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  ask: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  none: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
} as const;

/** 広告の可否 6媒体(設計 方針8)。未設定は「—」。△=担当者に確認。 */
export function AdPermissionChips({ value }: { value: DeskProperty["adPermissions"] }) {
  return (
    <ul className="grid grid-cols-3 gap-1 text-xs" aria-label="この物件の広告の可否">
      {AD_MEDIA_ORDER.map((m) => {
        const v = value[m];
        return (
          <li key={m} className={`flex justify-between rounded px-2 py-1 ${TONE[v ?? "none"]}`}>
            <span>{AD_MEDIUM_LABEL[m]}</span>
            <b>{v ? AD_VALUE_MARK[v] : "—"}</b>
          </li>
        );
      })}
    </ul>
  );
}
```

```tsx
// src/components/agent-inquiry/agent-picker.tsx
"use client";

import { useEffect, useState } from "react";
import { searchDeskAgents, type AgentHit } from "@/lib/api-client";

export function AgentResults({ hits, onPick }: { hits: AgentHit[]; onPick: (a: AgentHit) => void }) {
  return (
    <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-700 dark:bg-gray-900">
      {hits.map((h) => (
        <li key={h.id}>
          <button type="button" onClick={() => onPick(h)} className="block w-full px-3 py-2 text-left hover:bg-teal-50 dark:hover:bg-gray-800">
            <span className="block text-sm font-medium">{h.branchName ? `${h.companyName} ${h.branchName}` : h.companyName}</span>
            <span className="block text-xs text-gray-500">
              代表 {h.phone}
              {h.lastContact?.name ? ` ・ 前回 ${h.lastContact.name}様` : ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 業者を探す1つの欄(代表電話・携帯・会社名のどれでも・設計 §2.2-1)。250ms 待ってから探す。 */
export function AgentPicker({
  query, selected, onQuery, onPick, onCreateNew,
}: {
  query: string;
  selected: AgentHit | null;
  onQuery: (v: string) => void;
  onPick: (a: AgentHit) => void;
  onCreateNew: () => void;
}) {
  const [hits, setHits] = useState<AgentHit[]>([]);
  useEffect(() => {
    if (selected || query.trim().length < 2) return;
    let stale = false;
    const t = setTimeout(() => {
      searchDeskAgents(query)
        .then((r) => { if (!stale) setHits(r.agents); })
        .catch(() => { if (!stale) setHits([]); });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [query, selected]);
  const showHits = !selected && query.trim().length >= 2;
  return (
    <div className="space-y-1">
      <input
        data-guide="agent"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        inputMode="text"
        placeholder="例: 0312345 / 09012 / ○○不動産"
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900"
      />
      {showHits && hits.length > 0 && <AgentResults hits={hits} onPick={onPick} />}
      {!selected && (
        <button type="button" onClick={onCreateNew} className="text-sm text-teal-700 underline dark:text-teal-300">
          ＋ 名簿にない業者を新しく登録
        </button>
      )}
    </div>
  );
}
```

```tsx
// src/components/agent-inquiry/agent-create-modal.tsx
"use client";

import { useState } from "react";
import ModalShell from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { createDeskAgent, type AgentHit } from "@/lib/api-client";
import { formatPhoneJp, isValidPhoneJp } from "@/lib/phone-format-jp";

const MLIT = "https://etsuran2.mlit.go.jp/TAKKEN/";
const FIELDS = [
  ["companyName", "商号(必須)"], ["branchName", "支店名"], ["phone", "代表電話(必須)"], ["fax", "FAX"],
  ["email", "メール"], ["licenseNo", "免許番号"], ["address", "所在地"], ["note", "メモ"],
] as const;
type Key = (typeof FIELDS)[number][0];

/** 名簿にない業者をその場で登録(設計 §2.2-1・方針7)。会社の情報だけ。 */
export function AgentCreateModal({
  initialPhone, onClose, onCreated,
}: {
  initialPhone: string;
  onClose: () => void;
  onCreated: (hit: AgentHit) => void;
}) {
  const [v, setV] = useState<Record<Key, string>>({
    companyName: "", branchName: "", phone: initialPhone, fax: "", email: "", licenseNo: "", address: "", note: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: Key, val: string) => setV((p) => ({ ...p, [k]: val }));
  const submit = async () => {
    if (saving) return;
    if (!v.companyName.trim() || !v.phone.trim()) { setError("商号と代表電話を入れてください"); return; }
    setSaving(true);
    setError(null);
    try {
      const phone = formatPhoneJp(v.phone).value;
      const { id } = await createDeskAgent({
        companyName: v.companyName, phone, branchName: v.branchName || null, fax: v.fax || null,
        email: v.email || null, licenseNo: v.licenseNo || null, address: v.address || null, note: v.note || null,
      });
      onCreated({ id, companyName: v.companyName.trim(), branchName: v.branchName.trim() || null, phone, lastContact: null, matchedBy: "text" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "登録できませんでした");
      setSaving(false);
    }
  };
  return (
    <ModalShell size="md" onClose={onClose} title="新しい業者">
      <div className="space-y-2">
        {FIELDS.map(([k, label]) => (
          <label key={k} className="block text-sm">
            <span className="text-xs text-gray-500">{label}</span>
            <input
              value={v[k]}
              onChange={(e) => set(k, e.target.value)}
              onBlur={k === "phone" || k === "fax" ? () => set(k, formatPhoneJp(v[k]).value) : undefined}
              className="mt-0.5 w-full rounded-md border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
            />
            {(k === "phone" || k === "fax") && v[k].trim() !== "" && !isValidPhoneJp(v[k]) && (
              <span className="text-[11px] text-amber-700 dark:text-amber-300">電話番号の桁をご確認ください(このままでも保存できます)</span>
            )}
          </label>
        ))}
        <a href={MLIT} target="_blank" rel="noopener noreferrer" className="block text-sm text-teal-700 underline dark:text-teal-300">
          国の宅建業者検索を開いて確かめる ↗
        </a>
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>やめる</Button>
          <Button onClick={submit} disabled={saving}>{saving ? "登録中…" : "登録して戻る"}</Button>
        </div>
      </div>
    </ModalShell>
  );
}
```
⚠ `ModalShell` の実際の props(`title` の有無・default/named export)は `src/components/ui/modal-shell.tsx` を読んで合わせる。`Button` も同様。

```tsx
// src/components/agent-inquiry/property-picker.tsx
"use client";

import { useEffect, useState } from "react";
import { searchDeskProperties, type DeskProperty } from "@/lib/api-client";

export function PropertyResults({ hits, onPick }: { hits: DeskProperty[]; onPick: (p: DeskProperty) => void }) {
  return (
    <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-700 dark:bg-gray-900">
      {hits.map((p) => (
        <li key={p.id}>
          <button type="button" onClick={() => onPick(p)} className="block w-full px-3 py-2 text-left hover:bg-teal-50 dark:hover:bg-gray-800">
            <span className="block text-sm font-medium">{p.roomNo ? `${p.name} ${p.roomNo}` : p.name}</span>
            <span className="block text-xs text-gray-500">{p.town}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 物件を探す欄(物件名・部屋番号・所在地・設計 §2.2-3)。返るのは許可リストの形だけ。 */
export function PropertyPicker({
  query, selected, onQuery, onPick,
}: {
  query: string;
  selected: DeskProperty | null;
  onQuery: (v: string) => void;
  onPick: (p: DeskProperty) => void;
}) {
  const [hits, setHits] = useState<DeskProperty[]>([]);
  useEffect(() => {
    if (selected || query.trim().length < 2) return;
    let stale = false;
    const t = setTimeout(() => {
      searchDeskProperties(query)
        .then((r) => { if (!stale) setHits(r.properties); })
        .catch(() => { if (!stale) setHits([]); });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [query, selected]);
  return (
    <div className="space-y-1">
      <input
        data-guide="property"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="例: サンライズ 305 / 本町"
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900"
      />
      {!selected && query.trim().length >= 2 && hits.length > 0 && <PropertyResults hits={hits} onPick={onPick} />}
      {!selected && query.trim().length >= 2 && hits.length === 0 && (
        <p className="text-xs text-gray-500">見つかりません(しまった物件は出ません)</p>
      )}
    </div>
  );
}
```

```tsx
// src/components/agent-inquiry/inquiry-form.tsx
"use client";

import { useReducer, useState, type Dispatch } from "react";
import { createAgentInquiry, type AgentHit } from "@/lib/api-client";
import {
  EMPTY_DESK_FORM, deskFormReducer, validateDeskForm, materialEmailWarning, buildCreateBody,
  KIND_LABEL, CHANNEL_LABEL, type DeskFormAction, type DeskFormState,
} from "@/lib/agent-inquiry/desk-form";
import { formatPhoneJp, isValidPhoneJp } from "@/lib/phone-format-jp";
import { AgentPicker } from "./agent-picker";
import { PropertyPicker } from "./property-picker";
import { AdPermissionChips } from "./ad-permission-chips";
import { AgentCreateModal } from "./agent-create-modal";

const inputCls = "w-full rounded-md border border-gray-300 px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900";
const segCls = (on: boolean) =>
  `rounded-md border px-2 py-2 text-sm ${on ? "border-teal-700 bg-teal-700 font-bold text-white" : "border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-900"}`;
const Label = ({ children }: { children: React.ReactNode }) => <p className="text-xs font-medium text-gray-500">{children}</p>;
const Err = ({ text }: { text?: string }) => (text ? <p className="text-xs text-rose-600">{text}</p> : null);

type Errors = ReturnType<typeof validateDeskForm>;

/** 見た目(SSR テスト用)。並び順=業者→問い合わせ者→物件→用件→内見→入口→保存(方針12)。 */
export function InquiryFormView({
  state: s, dispatch, users, errors, warning, submitting, message, onSubmit, onCreateAgent,
}: {
  state: DeskFormState;
  dispatch: Dispatch<DeskFormAction>;
  users: { id: string; name: string }[];
  errors: Errors;
  warning: string | null;
  submitting: boolean;
  message: string | null;
  onSubmit: () => void;
  onCreateAgent: () => void;
}) {
  const phoneField = (field: "contactMobile", label: string) => (
    <label className="block">
      <Label>{label}</Label>
      <input
        value={s[field]}
        inputMode="tel"
        onChange={(e) => dispatch({ type: "contact", field, value: e.target.value })}
        onBlur={() => dispatch({ type: "contact", field, value: formatPhoneJp(s[field]).value })}
        className={inputCls}
      />
      {s[field].trim() !== "" && !isValidPhoneJp(s[field]) && (
        <span className="text-[11px] text-amber-700 dark:text-amber-300">電話番号の桁をご確認ください(このままでも保存できます)</span>
      )}
    </label>
  );
  return (
    <form
      className="space-y-3 rounded-lg border-2 border-teal-700 bg-white p-3 dark:bg-gray-900"
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
    >
      <section className="space-y-1">
        <Label>業者(代表電話・携帯・会社名)</Label>
        <AgentPicker
          query={s.agentQuery}
          selected={s.agent}
          onQuery={(v) => dispatch({ type: "agentQuery", value: v })}
          onPick={(a) => dispatch({ type: "agentSelected", agent: a })}
          onCreateNew={onCreateAgent}
        />
        <Err text={errors.agent} />
      </section>

      <section className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <Label>問い合わせ者</Label>
          <input value={s.contactName} onChange={(e) => dispatch({ type: "contact", field: "contactName", value: e.target.value })} className={inputCls} />
        </label>
        {phoneField("contactMobile", "携帯")}
        <label className="block">
          <Label>メール(資料の送り先)</Label>
          <input type="email" value={s.contactEmail} onChange={(e) => dispatch({ type: "contact", field: "contactEmail", value: e.target.value })} className={inputCls} />
        </label>
      </section>

      <section className="space-y-1">
        <Label>物件(物件名・部屋・所在地)</Label>
        <PropertyPicker
          query={s.propertyQuery}
          selected={s.property}
          onQuery={(v) => dispatch({ type: "propertyQuery", value: v })}
          onPick={(p) => dispatch({ type: "propertySelected", property: p })}
        />
        {s.property && (
          <div className="space-y-1 rounded-md bg-teal-50 p-2 dark:bg-gray-800">
            <p className="text-sm font-medium">{s.property.roomNo ? `${s.property.name} ${s.property.roomNo}` : s.property.name}</p>
            <p className="text-xs text-gray-500">{s.property.town}</p>
            <AdPermissionChips value={s.property.adPermissions} />
          </div>
        )}
        <Err text={errors.property} />
      </section>

      <section className="space-y-1">
        <Label>用件</Label>
        <div className="grid grid-cols-3 gap-1" data-guide="kind">
          {(["viewing", "ad_permission", "material_request"] as const).map((k) => (
            <button key={k} type="button" className={segCls(s.kind === k)} onClick={() => dispatch({ type: "kind", value: k })}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <Err text={errors.kind} />
      </section>

      {s.kind === "viewing" && (
        <section className="space-y-2">
          <Label>内見の予定</Label>
          <div className="grid grid-cols-2 gap-1" data-guide="viewingType">
            <button type="button" className={segCls(s.viewingType === "guided")} onClick={() => dispatch({ type: "viewing", field: "viewingType", value: "guided" })}>案内(お客様連れ)</button>
            <button type="button" className={segCls(s.viewingType === "preview")} onClick={() => dispatch({ type: "viewing", field: "viewingType", value: "preview" })}>下見(業者のみ)</button>
          </div>
          <Err text={errors.viewingType} />
          <div className="grid grid-cols-2 gap-2">
            <input type="date" value={s.viewingDate} onChange={(e) => dispatch({ type: "viewing", field: "date", value: e.target.value })} className={inputCls} />
            <input type="time" value={s.viewingTime} onChange={(e) => dispatch({ type: "viewing", field: "time", value: e.target.value })} className={inputCls} />
          </div>
          <p className="text-[11px] text-gray-500">日付と時刻の両方を入れると予定になります(空=日程調整中)</p>
          <label className="block">
            <Label>立ち会い(こちら)</Label>
            <select value={s.attendantId} onChange={(e) => dispatch({ type: "viewing", field: "attendantId", value: e.target.value })} className={inputCls}>
              <option value="">なし・未定</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
        </section>
      )}

      <section className="space-y-1">
        <Label>入口</Label>
        <div className="grid grid-cols-3 gap-1">
          {(["phone", "email", "fax"] as const).map((c) => (
            <button key={c} type="button" className={segCls(s.channel === c)} onClick={() => dispatch({ type: "channel", value: c })}>{CHANNEL_LABEL[c]}</button>
          ))}
        </div>
        <textarea
          value={s.note}
          onChange={(e) => dispatch({ type: "note", value: e.target.value })}
          rows={2}
          placeholder="メモ(メールの本文を貼ってもよい)"
          className={inputCls}
        />
      </section>

      {warning && <p className="rounded bg-amber-50 px-2 py-1 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">{warning}</p>}
      {message && <p className="text-sm text-teal-700 dark:text-teal-300">{message}</p>}
      <button
        type="submit"
        disabled={submitting}
        data-guide="save"
        className="w-full rounded-lg bg-teal-700 py-3 text-base font-bold text-white disabled:opacity-60"
      >
        {submitting ? "保存中…" : "保存する"}
      </button>
    </form>
  );
}

/** 状態と保存を持つ親。保存できたら空に戻し onSaved で一覧を読み直させる。 */
export default function InquiryForm({
  users, onSaved, stateRef,
}: {
  users: { id: string; name: string }[];
  onSaved: () => void;
  /** 光る案内が次の手順を読むために、今の状態を親へ渡す。 */
  stateRef?: (s: DeskFormState) => void;
}) {
  const [state, dispatch] = useReducer(deskFormReducer, EMPTY_DESK_FORM);
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  stateRef?.(state);
  const submit = async () => {
    if (submitting) return;
    const e = validateDeskForm(state);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setSubmitting(true);
    setMessage(null);
    try {
      await createAgentInquiry(buildCreateBody(state));
      dispatch({ type: "reset" });
      setMessage("登録しました");
      onSaved();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "登録できませんでした");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <>
      <InquiryFormView
        state={state}
        dispatch={dispatch}
        users={users}
        errors={errors}
        warning={materialEmailWarning(state)}
        submitting={submitting}
        message={message}
        onSubmit={submit}
        onCreateAgent={() => setCreating(true)}
      />
      {creating && (
        <AgentCreateModal
          initialPhone={/^[0-9０-９\-‐ー－\s]+$/.test(state.agentQuery) ? state.agentQuery : ""}
          onClose={() => setCreating(false)}
          onCreated={(hit: AgentHit) => { dispatch({ type: "agentSelected", agent: hit }); setCreating(false); }}
        />
      )}
    </>
  );
}
```
⚠ `stateRef?.(state)` を描画中に呼ぶのは React の規則(副作用)に反する → `useEffect(() => { stateRef?.(state); }, [state, stateRef]);` にする(実装時にこちらを採る)。

- [ ] **Step 4: 通過を確認** → PASS・tsc 0・`npx eslint src/components/agent-inquiry`
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-inquiry): 受付の窓の登録フォーム(業者・物件・新しい業者)"`

---

### Task 5: 一覧・今日明日の内見・詳細

**Files:**
- Create: `src/components/agent-inquiry/upcoming-viewings.tsx`, `inquiry-list.tsx`, `inquiry-detail.tsx`
- Test: `src/components/agent-inquiry/__tests__/inquiry-list.test.tsx`

**Interfaces:**
- Consumes: Task 1(`fetchAgentInquiry`, `updateAgentInquiry`, `addAgentViewing`, `updateAgentViewing`, 型)、Task 2(ラベル・`formatJst`・`isoToJstInputs`・`jstInputsToIso`・`CONFLICT_MESSAGE`)、`apiErrorCode`
- Produces:
  - `UpcomingViewingsView({ viewings })`
  - `InquiryListView({ tab, onTab, mine, onMine, items, openCount, onOpen, hasMore, onMore })`(`tab: InquiryStatusKey`)
  - `InquiryDetailView({ inquiry, canOpenProperty, users, busy, error, onStatus, onAssignee, onSaveNote, onAddViewing, onSaveViewing, onClose })` と既定 `InquiryDetail({ inquiryId, users, onClose, onChanged })`
  - `mainWindowPropertyHref(id: string): string` = `/properties/${id}`

- [ ] **Step 1: 失敗するテスト**

```tsx
// src/components/agent-inquiry/__tests__/inquiry-list.test.tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UpcomingViewingsView } from "../upcoming-viewings";
import { InquiryListView } from "../inquiry-list";
import { InquiryDetailView } from "../inquiry-detail";

const property = { id: "p1", name: "サンライズ中野", roomNo: "305", town: "東京都中野区中野2丁目", propertyType: "apartment_unit", adPermissions: {} };
const inquiry = {
  id: "i1", kind: "viewing" as const, status: "open" as const, channel: "phone" as const, receivedAt: "2026-09-30T07:20:00.000Z", version: 1,
  contactName: "田中", contactMobile: "090-1234-5678", contactEmail: null, note: null,
  assignee: { id: "u1", name: "佐藤" }, agent: { id: "a1", companyName: "○○不動産", branchName: null, phone: "03-1" },
  viewings: [
    { id: "v1", scheduledAt: "2026-10-02T05:00:00.000Z", viewingType: "guided" as const, canceledAt: null, resultNote: null, version: 1, attendant: { id: "u1", name: "佐藤" } },
    { id: "v2", scheduledAt: null, viewingType: "preview" as const, canceledAt: "2026-09-30T00:00:00.000Z", resultNote: "見送り", version: 2, attendant: null },
  ],
  property,
};
const noop = vi.fn();

describe("今日・明日の内見", () => {
  it("時刻・案内/下見・物件・業者・立ち会い", () => {
    const html = renderToStaticMarkup(<UpcomingViewingsView viewings={[{ id: "v1", scheduledAt: "2026-10-02T05:00:00.000Z", viewingType: "guided", version: 1,
      attendant: { id: "u1", name: "佐藤" }, inquiry: { id: "i1", contactName: "田中", agent: { companyName: "○○不動産" }, property } }]} />);
    for (const t of ["今日・明日の内見", "10/2(金) 14:00", "案内", "サンライズ中野 305", "○○不動産", "立会 佐藤"]) expect(html).toContain(t);
  });
  it("0件なら「ありません」", () => {
    expect(renderToStaticMarkup(<UpcomingViewingsView viewings={[]} />)).toContain("ありません");
  });
});

describe("一覧", () => {
  it("3つのタブ(未対応に件数)・自分の分だけ・1件の中身", () => {
    const html = renderToStaticMarkup(<InquiryListView tab="open" onTab={noop} mine={false} onMine={noop} items={[inquiry]} openCount={3}
      onOpen={noop} hasMore={false} onMore={noop} />);
    for (const t of ["未対応 3", "対応中", "対応済み", "自分の担当だけ", "サンライズ中野 305", "○○不動産", "田中様", "内見", "担当:佐藤", "電話"]) expect(html).toContain(t);
    expect(html).toContain('aria-selected="true"');
  });
  it("続きがあれば「もっと見る」", () => {
    expect(renderToStaticMarkup(<InquiryListView tab="done" onTab={noop} mine onMine={noop} items={[]} openCount={0}
      onOpen={noop} hasMore onMore={noop} />)).toContain("もっと見る");
  });
});

describe("詳細", () => {
  const view = (over: Partial<Parameters<typeof InquiryDetailView>[0]> = {}) =>
    renderToStaticMarkup(<InquiryDetailView inquiry={inquiry} canOpenProperty={false} users={[{ id: "u1", name: "佐藤" }]} busy={false} error={null}
      onStatus={noop} onAssignee={noop} onSaveNote={noop} onAddViewing={noop} onSaveViewing={noop} onClose={noop} {...over} />);
  it("物件を開く権限が無ければ「メイン画面で物件を開く」を出さない", () => {
    expect(view()).not.toContain("メイン画面で物件を開く");
    const html = view({ canOpenProperty: true });
    expect(html).toContain("メイン画面で物件を開く");
    expect(html).toMatch(/href="\/properties\/p1"[^>]*target="pm-main"|target="pm-main"[^>]*href="\/properties\/p1"/);
  });
  it("状態・担当・メモ・内見(取り消し済みは印・結果・内見を足す)", () => {
    const html = view();
    for (const t of ["未対応", "対応中", "対応済み", "担当", "メモ", "10/2(金) 14:00", "日程調整中", "取り消し済み", "見送り", "内見を足す"]) expect(html).toContain(t);
  });
  it("409 などの文言を出す", () => {
    expect(view({ error: "他の人が先に更新しました。開き直してください。" })).toContain("他の人が先に更新しました");
  });
  it("問い合わせ者の携帯・メールを出す(折り返し用)", () => {
    expect(view()).toContain("090-1234-5678");
  });
});
```

- [ ] **Step 2: 失敗を確認** → FAIL

- [ ] **Step 3: 実装**

```tsx
// src/components/agent-inquiry/upcoming-viewings.tsx
import type { UpcomingViewing } from "@/lib/api-client";
import { formatJst, VIEWING_TYPE_LABEL } from "@/lib/agent-inquiry/desk-form";

const propLabel = (p: { name: string; roomNo: string | null }) => (p.roomNo ? `${p.name} ${p.roomNo}` : p.name);

/** 今日・明日の内見(設計 §2.1)。 */
export function UpcomingViewingsView({ viewings }: { viewings: UpcomingViewing[] }) {
  return (
    <section className="rounded-lg bg-teal-50 p-3 dark:bg-gray-900">
      <h2 className="mb-1 text-sm font-bold">今日・明日の内見</h2>
      {viewings.length === 0 ? (
        <p className="text-sm text-gray-500">ありません</p>
      ) : (
        <ul className="space-y-1 text-sm tabular-nums">
          {viewings.map((v) => (
            <li key={v.id}>
              {formatJst(v.scheduledAt)} {VIEWING_TYPE_LABEL[v.viewingType]} {propLabel(v.inquiry.property)} ― {v.inquiry.agent.companyName}
              {v.inquiry.contactName ? `(${v.inquiry.contactName}様)` : ""}
              {v.attendant ? ` ・ 立会 ${v.attendant.name}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

```tsx
// src/components/agent-inquiry/inquiry-list.tsx
import type { InquiryStatusKey, InquiryView } from "@/lib/api-client";
import { CHANNEL_LABEL, KIND_LABEL, STATUS_LABEL, formatJst } from "@/lib/agent-inquiry/desk-form";

const TABS: InquiryStatusKey[] = ["open", "in_progress", "done"];

/** 反響の一覧(設計 §2.1)。状態タブ・自分の担当だけ・新しい順・もっと見る。 */
export function InquiryListView({
  tab, onTab, mine, onMine, items, openCount, onOpen, hasMore, onMore,
}: {
  tab: InquiryStatusKey;
  onTab: (t: InquiryStatusKey) => void;
  mine: boolean;
  onMine: (v: boolean) => void;
  items: InquiryView[];
  openCount: number | null;
  onOpen: (id: string) => void;
  hasMore: boolean;
  onMore: () => void;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-end justify-between gap-2 border-b border-gray-200 dark:border-gray-800" role="tablist">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === tab}
              onClick={() => onTab(t)}
              className={`px-3 py-1.5 text-sm ${t === tab ? "border-b-2 border-teal-700 font-bold text-teal-800 dark:text-teal-300" : "text-gray-500"}`}
            >
              {STATUS_LABEL[t]}
              {t === "open" && openCount != null ? ` ${openCount}` : ""}
            </button>
          ))}
        </div>
        <label className="mb-1 flex items-center gap-1 text-xs">
          <input type="checkbox" checked={mine} onChange={(e) => onMine(e.target.checked)} />
          自分の担当だけ
        </label>
      </div>
      <ul className="space-y-1">
        {items.map((q) => (
          <li key={q.id}>
            <button type="button" onClick={() => onOpen(q.id)} className="block w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-left hover:border-teal-600 dark:border-gray-800 dark:bg-gray-900">
              <span className="flex justify-between text-xs text-gray-500">
                <span>{formatJst(q.receivedAt)} ・ {CHANNEL_LABEL[q.channel]}</span>
                <span>{KIND_LABEL[q.kind]}</span>
              </span>
              <span className="block text-sm font-medium">
                {q.property.roomNo ? `${q.property.name} ${q.property.roomNo}` : q.property.name} ― {q.agent.companyName}
                {q.contactName ? `(${q.contactName}様)` : ""}
              </span>
              <span className="block text-xs text-gray-500">担当:{q.assignee?.name ?? "未定"}</span>
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="text-sm text-gray-500">ありません</li>}
      </ul>
      {hasMore && (
        <button type="button" onClick={onMore} className="w-full rounded-md border border-gray-300 py-2 text-sm dark:border-gray-700">もっと見る</button>
      )}
    </section>
  );
}
```

```tsx
// src/components/agent-inquiry/inquiry-detail.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import ModalShell from "@/components/ui/modal-shell";
import {
  addAgentViewing, apiErrorCode, fetchAgentInquiry, updateAgentInquiry, updateAgentViewing,
  type InquiryStatusKey, type InquiryView, type ViewingTypeKey, type ViewingView,
} from "@/lib/api-client";
import {
  CONFLICT_MESSAGE, KIND_LABEL, STATUS_LABEL, VIEWING_TYPE_LABEL, formatJst, isoToJstInputs, jstInputsToIso,
} from "@/lib/agent-inquiry/desk-form";

export const mainWindowPropertyHref = (id: string) => `/properties/${id}`;
const inputCls = "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900";

type ViewingPatch = { scheduledAt?: string | null; viewingType?: ViewingTypeKey; attendantId?: string | null; resultNote?: string | null; canceled?: boolean };

function ViewingRow({ v, users, busy, onSave }: {
  v: ViewingView; users: { id: string; name: string }[]; busy: boolean; onSave: (patch: ViewingPatch) => void;
}) {
  const init = isoToJstInputs(v.scheduledAt);
  const [date, setDate] = useState(init.date);
  const [time, setTime] = useState(init.time);
  const [result, setResult] = useState(v.resultNote ?? "");
  const canceled = v.canceledAt != null;
  return (
    <li className={`space-y-1 rounded-md border border-gray-200 p-2 dark:border-gray-700 ${canceled ? "opacity-60" : ""}`}>
      <p className="text-sm font-medium tabular-nums">
        {formatJst(v.scheduledAt)} {VIEWING_TYPE_LABEL[v.viewingType]}
        {v.attendant ? ` ・ 立会 ${v.attendant.name}` : ""}
        {canceled ? " ・ 取り消し済み" : ""}
      </p>
      <div className="grid grid-cols-2 gap-1">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputCls} />
      </div>
      <select defaultValue={v.attendant?.id ?? ""} onChange={(e) => onSave({ attendantId: e.target.value || null })} className={inputCls} disabled={busy}>
        <option value="">立ち会い なし・未定</option>
        {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
      <textarea value={result} onChange={(e) => setResult(e.target.value)} rows={2} placeholder="内見後の結果" className={inputCls} />
      <div className="flex flex-wrap gap-1">
        <button type="button" disabled={busy} onClick={() => onSave({ scheduledAt: jstInputsToIso(date, time), resultNote: result })} className="rounded bg-teal-700 px-3 py-1 text-xs text-white disabled:opacity-60">日時と結果を保存</button>
        <button type="button" disabled={busy} onClick={() => onSave({ canceled: !canceled })} className="rounded border border-gray-300 px-3 py-1 text-xs dark:border-gray-700">{canceled ? "取り消しを戻す" : "この内見を取り消す"}</button>
      </div>
    </li>
  );
}

/** 見た目(SSR テスト用)。 */
export function InquiryDetailView({
  inquiry: q, canOpenProperty, users, busy, error, onStatus, onAssignee, onSaveNote, onAddViewing, onSaveViewing, onClose,
}: {
  inquiry: InquiryView;
  canOpenProperty: boolean;
  users: { id: string; name: string }[];
  busy: boolean;
  error: string | null;
  onStatus: (s: InquiryStatusKey) => void;
  onAssignee: (id: string | null) => void;
  onSaveNote: (note: string) => void;
  onAddViewing: (t: ViewingTypeKey) => void;
  onSaveViewing: (v: ViewingView, patch: ViewingPatch) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(q.note ?? "");
  return (
    <ModalShell size="lg" onClose={onClose} title={`${KIND_LABEL[q.kind]} ― ${q.agent.companyName}`}>
      <div className="space-y-3 text-sm">
        <p className="font-medium">{q.property.roomNo ? `${q.property.name} ${q.property.roomNo}` : q.property.name}<span className="ml-2 text-xs text-gray-500">{q.property.town}</span></p>
        {canOpenProperty && (
          // 素の <a target> で名前付きの窓に開く(window.open はブロックされる環境がある)。
          <a href={mainWindowPropertyHref(q.property.id)} target="pm-main" className="text-teal-700 underline dark:text-teal-300">メイン画面で物件を開く ↗</a>
        )}
        <p>問い合わせ者:{q.contactName ?? "—"} ・ 携帯 {q.contactMobile ?? "—"} ・ メール {q.contactEmail ?? "—"}</p>
        <p className="text-xs text-gray-500">受けた日時 {formatJst(q.receivedAt)} ・ 代表 {q.agent.phone}</p>
        <div className="grid grid-cols-3 gap-1">
          {(["open", "in_progress", "done"] as const).map((s) => (
            <button key={s} type="button" disabled={busy} onClick={() => onStatus(s)}
              className={`rounded-md border px-2 py-2 ${q.status === s ? "border-teal-700 bg-teal-700 font-bold text-white" : "border-gray-300 dark:border-gray-700"}`}>
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <label className="block">
          <span className="text-xs text-gray-500">担当</span>
          <select defaultValue={q.assignee?.id ?? ""} disabled={busy} onChange={(e) => onAssignee(e.target.value || null)} className={inputCls}>
            <option value="">未定</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">メモ</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={inputCls} />
          <button type="button" disabled={busy} onClick={() => onSaveNote(note)} className="mt-1 rounded bg-teal-700 px-3 py-1 text-xs text-white disabled:opacity-60">メモを保存</button>
        </label>
        {q.kind === "viewing" && (
          <div className="space-y-1">
            <p className="text-xs text-gray-500">内見の予定</p>
            <ul className="space-y-1">
              {q.viewings.map((v) => (
                <ViewingRow key={`${v.id}:${v.version}`} v={v} users={users} busy={busy} onSave={(p) => onSaveViewing(v, p)} />
              ))}
            </ul>
            <div className="flex gap-1">
              <button type="button" disabled={busy} onClick={() => onAddViewing("guided")} className="rounded border border-gray-300 px-3 py-1 text-xs dark:border-gray-700">内見を足す(案内)</button>
              <button type="button" disabled={busy} onClick={() => onAddViewing("preview")} className="rounded border border-gray-300 px-3 py-1 text-xs dark:border-gray-700">内見を足す(下見)</button>
            </div>
          </div>
        )}
        {error && <p className="rounded bg-rose-50 px-2 py-1 text-rose-700 dark:bg-rose-950 dark:text-rose-200">{error}</p>}
      </div>
    </ModalShell>
  );
}

/** 取得・保存を持つ親。保存のたびに読み直し、409 は文言を出して読み直す。 */
export default function InquiryDetail({
  inquiryId, users, onClose, onChanged,
}: {
  inquiryId: string;
  users: { id: string; name: string }[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<{ inquiry: InquiryView; canOpenProperty: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setData(await fetchAgentInquiry(inquiryId));
  }, [inquiryId]);
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "読み込めませんでした"));
  }, [load]);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(apiErrorCode(e) === "VERSION_CONFLICT" ? CONFLICT_MESSAGE : e instanceof Error ? e.message : "保存できませんでした");
    } finally {
      await load().catch(() => {});
      setBusy(false);
    }
  };
  if (!data) return error ? <ModalShell size="sm" onClose={onClose} title="反響"><p className="text-sm text-rose-600">{error}</p></ModalShell> : null;
  const q = data.inquiry;
  return (
    <InquiryDetailView
      key={`${q.id}:${q.version}`}
      inquiry={q}
      canOpenProperty={data.canOpenProperty}
      users={users}
      busy={busy}
      error={error}
      onStatus={(status) => run(() => updateAgentInquiry(q.id, { version: q.version, status }))}
      onAssignee={(assigneeId) => run(() => updateAgentInquiry(q.id, { version: q.version, assigneeId }))}
      onSaveNote={(note) => run(() => updateAgentInquiry(q.id, { version: q.version, note }))}
      onAddViewing={(viewingType) => run(() => addAgentViewing(q.id, { viewingType }))}
      onSaveViewing={(v, patch) => run(() => updateAgentViewing(q.id, v.id, { version: v.version, ...patch }))}
      onClose={onClose}
    />
  );
}
```
⚠ `ModalShell` の props(`title` があるか・default export か)は Task 4 と同じく実物に合わせる。

- [ ] **Step 4: 通過を確認** → PASS・tsc 0
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-inquiry): 受付の窓の一覧・今日明日の内見・詳細"`

---

### Task 6: 光る案内と画面の組み立て

**Files:**
- Create: `src/components/agent-inquiry/desk-step-guide.tsx`, `src/app/(desk)/inquiry-desk/page.tsx`
- Test: `src/components/agent-inquiry/__tests__/desk-step-guide.test.tsx`, `src/lib/__tests__/agent-desk-page-scan.test.ts`

**Interfaces:**
- Consumes: Task 2 `nextDeskGuideStep`・`DESK_GUIDE_TIPS`、Task 3 `DESK_OPEN_COUNT_EVENT`、Task 4/5 の部品
- Produces: `DeskStepGuideView({ step, off, onToggle })` と既定 `DeskStepGuide({ step })`・`DESK_GUIDE_STORAGE_KEY = "pm-agent-desk-guide-off"`・`DESK_GLOW_CLASSES`

- [ ] **Step 1: 失敗するテスト**

```tsx
// src/components/agent-inquiry/__tests__/desk-step-guide.test.tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeskStepGuideView, DESK_GUIDE_STORAGE_KEY } from "../desk-step-guide";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("次に押す所の案内", () => {
  it("今の手順の吹き出しと「案内を消す」", () => {
    const html = renderToStaticMarkup(<DeskStepGuideView step="property" off={false} onToggle={vi.fn()} />);
    expect(html).toContain("次に物件を選びます");
    expect(html).toContain("案内を消す");
  });
  it("消しているときは「案内を出す」だけ", () => {
    const html = renderToStaticMarkup(<DeskStepGuideView step="property" off onToggle={vi.fn()} />);
    expect(html).not.toContain("次に物件を選びます");
    expect(html).toContain("案内を出す");
  });
  it("消す設定は端末ごと(localStorage・読み書きは try/catch)", () => {
    expect(DESK_GUIDE_STORAGE_KEY).toBe("pm-agent-desk-guide-off");
    const src = read("src/components/agent-inquiry/desk-step-guide.tsx");
    expect(src).toMatch(/try\s*\{[\s\S]*?localStorage\.getItem/);
    expect(src).toMatch(/try\s*\{[\s\S]*?localStorage\.setItem/);
  });
});
```

```ts
// src/lib/__tests__/agent-desk-page-scan.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src/app/(desk)/inquiry-desk/page.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("受付の窓の画面", () => {
  it("上から 今日明日の内見 → 登録フォーム → 一覧 の順に並べる(設計 §2.1)", () => {
    const a = src.indexOf("<UpcomingViewingsView"), b = src.indexOf("<InquiryForm"), c = src.indexOf("<InquiryListView");
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
  it("権限が無いときは1つの文言(反響の受付の権限がありません)", () => {
    expect(src).toContain("反響の受付の権限がありません");
    expect(src).toMatch(/FORBIDDEN/);
  });
  it("保存したら 一覧・今日明日・件数 を読み直す", () => {
    expect(src).toMatch(/onSaved=\{reloadAll\}/);
  });
  it("未対応件数を枠へ渡す", () => {
    expect(src).toContain("DESK_OPEN_COUNT_EVENT");
  });
});
```

- [ ] **Step 2: 失敗を確認** → FAIL

- [ ] **Step 3: 実装**

```tsx
// src/components/agent-inquiry/desk-step-guide.tsx
"use client";

import { useEffect, useSyncExternalStore } from "react";
import { DESK_GUIDE_TIPS, type DeskGuideStep } from "@/lib/agent-inquiry/desk-form";

export const DESK_GUIDE_STORAGE_KEY = "pm-agent-desk-guide-off";
export const DESK_GLOW_CLASSES = ["ring-4", "ring-amber-400", "ring-offset-2", "motion-safe:animate-pulse"];

const listeners = new Set<() => void>();
let memoryOff = false;
function readOff(): boolean {
  try {
    return window.localStorage.getItem(DESK_GUIDE_STORAGE_KEY) === "1";
  } catch {
    return memoryOff;
  }
}
function writeOff(v: boolean) {
  memoryOff = v;
  try {
    if (v) window.localStorage.setItem(DESK_GUIDE_STORAGE_KEY, "1");
    else window.localStorage.removeItem(DESK_GUIDE_STORAGE_KEY);
  } catch {
    // 保存できない環境でもこの画面の間は memoryOff で効かせる。
  }
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

/** 見た目(SSR テスト用)。 */
export function DeskStepGuideView({ step, off, onToggle }: { step: DeskGuideStep; off: boolean; onToggle: () => void }) {
  if (off) {
    return <button type="button" onClick={onToggle} className="text-xs text-teal-700 underline dark:text-teal-300">案内を出す</button>;
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-gray-900 px-3 py-2 text-sm text-white dark:bg-gray-100 dark:text-gray-900" role="status">
      <span>{DESK_GUIDE_TIPS[step]}</span>
      <button type="button" onClick={onToggle} className="shrink-0 text-xs underline">案内を消す</button>
    </div>
  );
}

/** 次に押す所を光らせる(方針14)。対象は data-guide="<step>" の要素。DOM のクラスを直接付け外しする。 */
export default function DeskStepGuide({ step }: { step: DeskGuideStep }) {
  const off = useSyncExternalStore(subscribe, readOff, () => false);
  useEffect(() => {
    if (off) return;
    const el = document.querySelector<HTMLElement>(`[data-guide="${step}"]`);
    if (!el) return;
    el.classList.add(...DESK_GLOW_CLASSES);
    return () => el.classList.remove(...DESK_GLOW_CLASSES);
  }, [step, off]);
  return <DeskStepGuideView step={step} off={off} onToggle={() => writeOff(!off)} />;
}
```

```tsx
// src/app/(desk)/inquiry-desk/page.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  apiErrorCode, fetchAgentInquiries, fetchAgentInquiryCounts, fetchUpcomingViewings, fetchUsers,
  type InquiryStatusKey, type InquiryView, type UpcomingViewing,
} from "@/lib/api-client";
import { EMPTY_DESK_FORM, nextDeskGuideStep, type DeskFormState } from "@/lib/agent-inquiry/desk-form";
import InquiryForm from "@/components/agent-inquiry/inquiry-form";
import { UpcomingViewingsView } from "@/components/agent-inquiry/upcoming-viewings";
import { InquiryListView } from "@/components/agent-inquiry/inquiry-list";
import InquiryDetail from "@/components/agent-inquiry/inquiry-detail";
import DeskStepGuide from "@/components/agent-inquiry/desk-step-guide";
import { DESK_OPEN_COUNT_EVENT } from "@/components/agent-inquiry/desk-shell";

/** 受付の窓(設計 §2.1)。上から 今日・明日の内見 → 登録フォーム → 一覧。 */
export default function InquiryDeskPage() {
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingViewing[]>([]);
  const [openCount, setOpenCount] = useState<number | null>(null);
  const [tab, setTab] = useState<InquiryStatusKey>("open");
  const [mine, setMine] = useState(false);
  const [items, setItems] = useState<InquiryView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [formState, setFormState] = useState<DeskFormState>(EMPTY_DESK_FORM);

  const onError = (e: unknown) => {
    if (apiErrorCode(e) === "FORBIDDEN") setForbidden(true);
  };
  const loadList = useCallback(async (more?: string) => {
    const r = await fetchAgentInquiries({ status: tab, assignee: mine ? "me" : undefined, cursor: more });
    setItems((prev) => (more ? [...prev, ...r.items] : r.items));
    setCursor(r.nextCursor);
  }, [tab, mine]);
  const reloadAll = useCallback(() => {
    loadList().catch(onError);
    fetchUpcomingViewings().then((r) => setUpcoming(r.viewings)).catch(onError);
    fetchAgentInquiryCounts()
      .then((c) => {
        setOpenCount(c.open);
        window.dispatchEvent(new CustomEvent(DESK_OPEN_COUNT_EVENT, { detail: c.open }));
      })
      .catch(onError);
  }, [loadList]);

  useEffect(() => { reloadAll(); }, [reloadAll]);
  useEffect(() => {
    fetchUsers().then((r) => setUsers(r.data.map((u) => ({ id: u.id, name: u.name })))).catch(() => {});
  }, []);

  if (forbidden) {
    return <p className="rounded-md bg-white p-6 text-center text-sm dark:bg-gray-900">反響の受付の権限がありません。管理者にお問い合わせください。</p>;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        <UpcomingViewingsView viewings={upcoming} />
        <DeskStepGuide step={nextDeskGuideStep(formState)} />
        <InquiryForm users={users} onSaved={reloadAll} stateRef={setFormState} />
      </div>
      <div>
        <InquiryListView
          tab={tab}
          onTab={setTab}
          mine={mine}
          onMine={setMine}
          items={items}
          openCount={openCount}
          onOpen={setOpenId}
          hasMore={cursor != null}
          onMore={() => { if (cursor) loadList(cursor).catch(onError); }}
        />
      </div>
      {openId && <InquiryDetail inquiryId={openId} users={users} onClose={() => setOpenId(null)} onChanged={reloadAll} />}
    </div>
  );
}
```
⚠ `fetchUsers()` の戻りの型(`MOCK_USERS` の要素型)に `id`/`name` があることを確認する。eslint `react-hooks/set-state-in-effect` に当たったら、`reloadAll` の呼び出しを effect の外の関数に分けるか、既存画面(`import/page.tsx`)と同じ書き方に揃える。

- [ ] **Step 4: 通過を確認** → PASS・tsc 0・`npx eslint "src/app/(desk)" src/components/agent-inquiry`
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-inquiry): 受付の窓の画面の組み立てと光る案内"`

---

### Task 7: 全ゲート・実ブラウザ確認・レビュー・PR

- [ ] **Step 1: 全ゲート**
```bash
npx tsc --noEmit
npx vitest run            # ⚠終了コードで判定し、通ったときだけ commit/push
npx eslint "src/app/(desk)" src/components/agent-inquiry src/lib/agent-inquiry/desk-form.ts src/lib/api-client.ts src/components/layout src/lib/__tests__/agent-desk-*.ts
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build   # route 一覧に /inquiry-desk
```

- [ ] **Step 2: 実ブラウザ確認**(共用の開発DBに触れない=PR1 と同じく使い捨てDB `pm_agent_desk_ui_check` を作って migrate+seed。devサーバはこの worktree から `DATABASE_URL=… NEXTAUTH_URL=http://localhost:3100 PORT=3100 npm run dev`)。Playwright(`chromium.launch({channel:'chrome'})`)で:
  1. field@example.com でログイン → `/inquiry-desk` にサイドバーが無い
  2. 「＋名簿にない業者」で 商号+代表電話(0312345678)を登録 → 業者欄に入る
  3. 物件を検索して選ぶ → 広告の可否 6媒体が出る
  4. 内見・案内・日時を入れて保存 → 「登録しました」・今日明日の内見/一覧に出る
  5. 一覧から開く → 対応中にする → 別タブで同じ反響を対応済みにしてから元のタブでメモ保存 → 「他の人が先に更新しました」
  6. 携帯 0901234 で業者を探すと「前回 ○○様」が出る
  7. スマホ幅(390px)で1列に並ぶ
  8. メイン画面のサイドバー「反響の受付」で `pm-inquiry-desk` の窓に開く
  スクリーンショットを scratchpad に残し、使い捨てDBを消す。

- [ ] **Step 3: 提出前レビュー** — `feature-dev:code-reviewer` に diff を渡す。ホットスポット: 物件の中身が許可リスト以外に出ていないか/「物件を開く」が canOpenProperty のときだけか/二重登録/409 の扱い/effect 内の setState/スマホ幅。

- [ ] **Step 4: push・PR・@codex**(PR 本文は平易な日本語・末尾に Generated with 行とセッション URL)。到着監視は Monitor の3系統+CI(`gh run list -R ligarejapan-hue/property-management`)。

- [ ] **Step 5: メモリ更新** — `next-epic-agent-inquiry-management.md` に PR 番号・状態。
