# 業者からの反響の受付 PR3(メイン画面側)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** メイン画面に「物件の反響欄(件数・広告の可否の切り替え・時系列)」「業者の名簿(一覧・詳細・編集・しまう)」「ホームの件数」を足し、受付の窓と行き来できるようにする(PR1 の API・PR2 の受付の窓は本番反映済み)。

**Architecture:** 裏側(API)は PR1 でほぼ出来ているので、足すのは「名簿の一覧・詳細が `canWrite`(書ける人か)を返す」だけ。画面は PR2 と同じ分け方=判定は純関数 `src/lib/agent-inquiry/main-view.ts`、見た目は props で描く View、取得・保存は親。受付の窓で保存した内容をメイン画面へすぐ映すために、同じブラウザの窓どうしの合図(`BroadcastChannel`・中身は「変わった」の一言だけ)を `src/lib/agent-inquiry/desk-sync.ts` に置く。

**Tech Stack:** Next.js 16 app router / React 19 client components / Tailwind v4 / vitest(node 環境・`renderToStaticMarkup` と文字列走査)/ Playwright(実ブラウザ確認)。**migration なし・新しい依存なし**。

**Spec:** `docs/superpowers/specs/2026-09-28-agent-inquiry-desk-design.md`(§2.3 メイン画面・§3 API・§4 権限・§5 の PR3 行)

## 範囲の判断(設計書・引き継ぎメモとの違い)

- **第2段の積み残しはこの PR に入れない**(引き継ぎメモでは「第3段で一緒に」)。理由=積み残しは全部 受付の窓側のファイルで、メイン画面側と重ならない/「二重登録を防ぐ鍵」は表に列を足す(migration)ので別に承認が要る/PR2 はレビューが 27 巡かかったので1本を小さく保つ。→ **次の PR「受付の窓の仕上げ」**にまとめる(末尾「この PR でやらないこと」)。
- **名簿の検索は今ある業者検索(`GET /api/agents?q=`)をそのまま使う**。検索の結果には反響件数・最終日が付かず、しまった業者は出ない(しまった業者は「しまった業者」タブの一覧で探す)。件数つきの検索を作ると API が増えるため見送り。
- **名簿での新規登録は、探し終えて見つからなかったときだけ出す**(受付の窓と同じ規則=二重登録を防ぐ)。常設の「新規」ボタンは置かない。
- **広告の可否は押すたびにすぐ保存**(○→×→△→未設定→○・設計 §2.3 のとおり)。物件の「編集中の鍵」とは連動させない(別の表で、画面の値と今の値の照合[from]で先勝ちを防いでいる)。
- **ホームの2つの件数はどちらも受付の窓を開くだけ**(未対応タブが既定・今日明日の内見は窓の一番上)。タブ指定つきの URL は作らない。
- **物件の時系列・名簿の履歴から「その反響を受付の窓で開く」は作らない**(窓を読み直すので、打ちかけの登録が消える)。要るなら「受付の窓の仕上げ」で検討。
- **受付の窓の名前も揃える**(設計書に無い追加)。ブックマークから開いた窓は名前が空で、メイン画面の「反響の受付」を押すと2枚目が開く → 窓の名前が空のときだけ `pm-inquiry-desk` を名乗らせる。メイン画面は `pm-main`。

## Global Constraints

- **migration・schema・新しい依存は足さない**。
- 物件画面の反響欄・広告の可否は**物件の権限**に従う(読む=`property:read`+現地スタッフは担当/作成のみ、変える=`property:write`。API 側で実装済み)。画面は `canWriteProperty` を受け取るだけで、`useScreenProtection()` から `permissions` を取らない(取ると `permission-freshness-pattern.test.ts` の3点セットが要る)。
- 業者の名簿は `agent_inquiry:read`(見る)/`agent_inquiry:write`(登録・編集・しまう)。**書けるかどうかはサーバーが返す `canWrite` で決める**(画面で権限表を読まない)。
- 別の窓へは**素の `<a href target>`**(`window.open` は使わない)。受付の窓=`target="pm-inquiry-desk"`、メイン画面=`target="pm-main"`。**名前付きの窓に `rel="noopener"` を付けない**(付けると毎回新しい窓になる)。
- 問い合わせ者の名前(個人情報)を出す所は `data-pii-protected` の内側に置く。**ボタンの中に出すときは `data-pii-protected="true" data-pii-surface="dashboard"` の span で包む**(画面保護はボタンの中を外から見ない)。
- 左メニューから行く画面の題名は `<PageHeader title="…" />` の**素の文字列**でメニュー名と一字一句同じ(`sidebar-page-title-parity.test.ts`)。`src/components` の部品に `<h1` を書かない。
- ボタン・検索窓・小窓・タブ・確認は共通部品(`@/components/ui/button`・`search-field`・`modal-shell`・`tabs`・`confirm-dialog`)。
- 409 `VERSION_CONFLICT` は黙って上書きしない。保存できたか分からない失敗(通信切れ・5xx=`isAmbiguousSaveError`)を「失敗」と言い切らない。
- 日時は JST で表示。履歴・時系列は年をまたぐので**年つき**(`2026/10/2(金) 14:00`)。
- 合図(`BroadcastChannel`)に載せるのは `{ type: "changed" }` だけ。名前・電話・id を載せない。
- ダークモードの色(`dark:`)を付ける。スマホ幅(390px)で横にはみ出さない。
- commit 末尾:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WmeoVwkUWvtup1T1ajZNL5
  ```

## Review Focus

1. **広告の可否の連打**: ○を続けて2回押すと、1回目の保存中に2回目が古い値(from)で飛んで 409 になる → 保存中は6つとも押せなくし、押した結果は保存の応答で描く(Task 5 のテスト「保存中は押せない」)。
2. **他の人が先に広告の可否を変えていた**: 古い画面のまま押すと 409 → 文言を出し、今の値を読み直す(押した値にはならない)(Task 5 のテスト「409 の文言」+実ブラウザ)。
3. **受付の窓で登録した直後の物件画面・ホーム**: 開きっぱなしのメイン画面が古い件数のまま → 合図で読み直す。合図が使えないブラウザでも落ちない(Task 4 のテスト「BroadcastChannel が無くても何も起きない」)。
4. **名簿の編集中に他の人が同じ業者を直した**: 触っていない欄まで古い値で上書きしない=**触った欄だけ送る**。409 のあと読み直しても、触った欄の打ちかけは残る(Task 3 `agentEditPatch` のテスト)。
5. **権限が無い人が `/agents` を直接開いた/途中で外された**: 真っ白やエラー連発ではなく「反響の受付の権限がありません」を1つ。書く権限だけ無い人には編集欄・しまうボタンを出さない(Task 7・8 のテスト)。

---

## File Structure

| ファイル | 役割 |
|---|---|
| `src/app/api/agents/route.ts`・`src/app/api/agents/[id]/route.ts`(変更) | 名簿の一覧・詳細の応答に `canWrite` を足す |
| `src/lib/api-client.ts`(変更・末尾に追記) | 物件の反響欄・広告の可否・名簿の一覧/詳細/更新の呼び出しと型 |
| `src/lib/agent-inquiry/main-view.ts`(新) | 純関数: 広告の可否の次の値・時系列の表示・年つき日時・名簿の編集(触った欄だけ)・ホームの件数・窓の名前 |
| `src/lib/agent-inquiry/desk-sync.ts`(新) | 窓どうしの「変わった」の合図 |
| `src/components/agent-inquiry/ad-permission-chips.tsx`(変更) | 色の表 `AD_TONE` を外へ出す(反響欄と共用) |
| `src/components/properties/agent-inquiry-tab.tsx`(新) | 物件画面の「反響」タブ(件数・広告の可否・時系列) |
| `src/app/(dashboard)/properties/[id]/page.tsx`(変更) | タブ「反響」を足す |
| `src/components/home/home-inquiry-counts.tsx`(新)・`HomeContent.tsx`(変更) | ホームの「未対応の反響」「今日・明日の内見」 |
| `src/components/agent-inquiry/agent-directory.tsx`(新) | 名簿の一覧・検索結果の見た目 |
| `src/app/(dashboard)/agents/page.tsx`(新) | 名簿の一覧画面 |
| `src/components/agent-inquiry/agent-detail.tsx`(新) | 名簿の詳細の見た目(会社情報の欄・履歴) |
| `src/app/(dashboard)/agents/[id]/page.tsx`(新) | 名簿の詳細画面(編集・しまう/戻す・履歴) |
| `src/components/layout/sidebar-model.tsx`(変更) | 「業者の名簿」 |
| `src/components/layout/dashboard-layout.tsx`・`src/components/agent-inquiry/desk-shell.tsx`(変更) | 窓の名前(`pm-main`/`pm-inquiry-desk`) |
| `src/app/(desk)/inquiry-desk/page.tsx`(変更) | 保存・変更のたびに合図を出す |
| テスト | `src/lib/__tests__/agent-main-*.test.ts`・`src/components/**/__tests__/*.test.tsx`・既存の `agent-inquiry-agents-route.test.ts`・`sidebar-reorg.test.ts`・`agent-desk-routing.test.ts` |

---

### Task 0: worktree の準備(済み)

worktree `C:/Users/issin/Desktop/Claude/property-management-worktrees/agent-inquiry-main`(branch `feat/agent-inquiry-main`・origin/main `981b8889` から)。`npm ci`・`prisma generate` 済み。基準の確認=`npx vitest run src/lib/__tests__/agent- src/components/layout src/components/home src/components/agent-inquiry` → 33 files / 429 tests 通過(2026-09-30)。

---

### Task 1: 名簿の API が「書ける人か」を返す

**Files:**
- Modify: `src/app/api/agents/route.ts`(GET の `list=1` の分岐)
- Modify: `src/app/api/agents/[id]/route.ts`(GET)
- Test: `src/lib/__tests__/agent-inquiry-agents-route.test.ts`(追記)

**Interfaces:**
- Produces: `GET /api/agents?list=1` の応答 `{ agents, nextCursor, canWrite: boolean }`/`GET /api/agents/[id]` の応答 `{ agent, inquiries, nextCursor, canWrite: boolean }`。`canWrite` = `agent_inquiry:write` を持つか。

- [ ] **Step 1: 失敗するテスト**(`describe("業者 API", …)` の中に追記)

```ts
  it("名簿の一覧・詳細は、書ける人かどうか(canWrite)を返す", async () => {
    grant("read");
    const list = await (await SEARCH(new Request("http://x/api/agents?list=1"))).json();
    expect(list.canWrite).toBe(false);
    pm.agent.findUnique.mockResolvedValueOnce({ id: AID, companyName: "x", version: 1 });
    const detail = await (await DETAIL(new Request("http://x/api/agents/" + AID), ctx)).json();
    expect(detail.canWrite).toBe(false);

    grant("read", "write");
    expect((await (await SEARCH(new Request("http://x/api/agents?list=1"))).json()).canWrite).toBe(true);
    pm.agent.findUnique.mockResolvedValueOnce({ id: AID, companyName: "x", version: 1 });
    expect((await (await DETAIL(new Request("http://x/api/agents/" + AID), ctx)).json()).canWrite).toBe(true);
  });
  it("検索(q=)の応答の形は変えない(受付の窓が使っている)", async () => {
    const body = await (await SEARCH(new Request("http://x/api/agents?q=" + encodeURIComponent("不動産")))).json();
    expect(Object.keys(body)).toEqual(["agents"]);
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/__tests__/agent-inquiry-agents-route.test.ts`
Expected: FAIL(`expected undefined to be false`)

- [ ] **Step 3: 実装**

`src/app/api/agents/route.ts` — import に `hasPermission` を足し、GET を次の形にする:

```ts
import { hasPermission } from "@/lib/permissions";
```
```ts
export async function GET(request: Request) {
  try {
    const { perms } = await requireAgentInquiry("read");
    const sp = new URL(request.url).searchParams;
    if (sp.get("list") === "1") {
      const cursorRaw = sp.get("cursor");
      const cursor = cursorRaw ? z.string().uuid().parse(cursorRaw) : undefined;
      const page = await listAgents({ archived: sp.get("archived") === "1", cursor });
      // 名簿の画面は、編集・しまうを出すかどうかをこの値で決める(画面で権限表を読まない)。
      return NextResponse.json(
        { ...page, canWrite: hasPermission(perms, "agent_inquiry", "write") },
        { headers: NO_STORE },
      );
    }
    const q = sp.get("q") ?? "";
    return NextResponse.json({ agents: await searchAgents(q) }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
```

`src/app/api/agents/[id]/route.ts` — 同じ import を足し、GET の先頭と応答を変える:

```ts
    const { perms } = await requireAgentInquiry("read");
```
```ts
    return NextResponse.json(
      {
        agent,
        inquiries: page,
        nextCursor: inquiries.length > HISTORY_PAGE ? page[page.length - 1].id : null,
        canWrite: hasPermission(perms, "agent_inquiry", "write"),
      },
      { headers: NO_STORE },
    );
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/__tests__/agent-inquiry-agents-route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/agents src/lib/__tests__/agent-inquiry-agents-route.test.ts
git commit -m "feat(agent-inquiry): 名簿の一覧・詳細が書ける人か(canWrite)を返す"
```

---

### Task 2: API 呼び出しと型(api-client.ts)

**Files:**
- Modify: `src/lib/api-client.ts`(末尾に追記)
- Test: `src/lib/__tests__/agent-main-api-client.test.ts`(新)

**Interfaces:**
- Consumes: 既存の `apiFetch`・`USE_MOCK`・`mockDelay`・`deskJsonInit`・型 `AdMediumKey`・`AdValueKey`・`InquiryKindKey`・`InquiryStatusKey`・`ViewingTypeKey`・`DeskProperty`・`DeskAgentInput`
- Produces(型): `PropertyInquiryCounts`・`PropertyTimelineEntry`・`PropertyAgentInquiries`・`AdPermissionChange`・`AgentDirectoryRow`・`AgentDetail`・`AgentHistoryItem`
- Produces(関数):
  - `fetchPropertyAgentInquiries(propertyId: string): Promise<PropertyAgentInquiries>`
  - `putPropertyAdPermission(propertyId: string, change: AdPermissionChange): Promise<{ adPermissions: Partial<Record<AdMediumKey, AdValueKey>> }>`
  - `fetchAgentDirectory(p: { archived?: boolean; cursor?: string }): Promise<{ agents: AgentDirectoryRow[]; nextCursor: string | null; canWrite: boolean }>`
  - `fetchAgentDetail(id: string, cursor?: string): Promise<{ agent: AgentDetail; inquiries: AgentHistoryItem[]; nextCursor: string | null; canWrite: boolean }>`
  - `updateAgent(id: string, body: { version: number; isArchived?: boolean } & Partial<Record<keyof DeskAgentInput, string | null>>): Promise<{ version: number }>`

- [ ] **Step 1: 失敗するテスト**

```ts
// src/lib/__tests__/agent-main-api-client.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchPropertyAgentInquiries, putPropertyAdPermission, fetchAgentDirectory, fetchAgentDetail, updateAgent,
} from "@/lib/api-client";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
const call = (n = 0) => ({ url: fetchMock.mock.calls[n][0] as string, init: (fetchMock.mock.calls[n][1] ?? {}) as RequestInit });
const PID = "11111111-1111-4111-8111-111111111111";
const AID = "22222222-2222-4222-8222-222222222222";

describe("メイン画面側の API 呼び出し(反響)", () => {
  it("物件の反響欄を読む", async () => {
    await fetchPropertyAgentInquiries(PID);
    expect(call().url).toBe(`/api/properties/${PID}/agent-inquiries`);
  });
  it("広告の可否は1媒体ずつ PUT し、画面に出ていた値(from)を必ず添える", async () => {
    await putPropertyAdPermission(PID, { medium: "suumo", value: "ng", from: "ok" });
    expect(call().url).toBe(`/api/properties/${PID}/ad-permissions`);
    expect(call().init.method).toBe("PUT");
    expect(JSON.parse(String(call().init.body))).toEqual({ items: [{ medium: "suumo", value: "ng", from: "ok" }] });
    await putPropertyAdPermission(PID, { medium: "flyer", value: null, from: "ask" });
    expect(JSON.parse(String(call(1).init.body))).toEqual({ items: [{ medium: "flyer", value: null, from: "ask" }] });
  });
  it("名簿の一覧は list=1。しまった業者・続きは条件があるときだけ載せる", async () => {
    await fetchAgentDirectory({});
    expect(call().url).toBe("/api/agents?list=1");
    await fetchAgentDirectory({ archived: true, cursor: AID });
    expect(call(1).url).toBe(`/api/agents?list=1&archived=1&cursor=${AID}`);
  });
  it("名簿の詳細と履歴の続き", async () => {
    await fetchAgentDetail(AID);
    expect(call().url).toBe(`/api/agents/${AID}`);
    await fetchAgentDetail(AID, PID);
    expect(call(1).url).toBe(`/api/agents/${AID}?cursor=${PID}`);
  });
  it("業者の更新は PATCH で、渡した欄だけ送る", async () => {
    await updateAgent(AID, { version: 3, fax: null });
    expect(call().url).toBe(`/api/agents/${AID}`);
    expect(call().init.method).toBe("PATCH");
    expect(JSON.parse(String(call().init.body))).toEqual({ version: 3, fax: null });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/__tests__/agent-main-api-client.test.ts`
Expected: FAIL(`fetchPropertyAgentInquiries is not a function` など import の失敗)

- [ ] **Step 3: 実装**(`src/lib/api-client.ts` の末尾に追記)

```ts
// ---- 業者からの反響の受付: メイン画面側(設計 §2.3) ----
export interface PropertyInquiryCounts {
  total: number;
  guided: number;
  preview: number;
  materialRequest: number;
  adPermission: number;
}
export interface PropertyTimelineEntry {
  key: string;
  at: string;
  inquiryId: string;
  kind: InquiryKindKey;
  viewingType: ViewingTypeKey | null;
  agentName: string;
  contactName: string | null;
  attendantName: string | null;
  resultNote: string | null;
  canceled: boolean;
  unscheduled: boolean;
}
export interface PropertyAgentInquiries {
  counts: PropertyInquiryCounts;
  timeline: PropertyTimelineEntry[];
  adPermissions: Partial<Record<AdMediumKey, AdValueKey>>;
}
/** 広告の可否の変更1件。from=画面に出ていた値(null=未設定)。今の値と違えば 409。 */
export interface AdPermissionChange {
  medium: AdMediumKey;
  value: AdValueKey | null;
  from: AdValueKey | null;
}
export interface AgentDirectoryRow {
  id: string;
  companyName: string;
  branchName: string | null;
  phone: string;
  isArchived: boolean;
  inquiryCount: number;
  lastReceivedAt: string | null;
}
export interface AgentDetail {
  id: string;
  companyName: string;
  companyKana: string | null;
  branchName: string | null;
  licenseNo: string | null;
  phone: string;
  fax: string | null;
  email: string | null;
  address: string | null;
  note: string | null;
  isArchived: boolean;
  version: number;
}
export interface AgentHistoryItem {
  id: string;
  kind: InquiryKindKey;
  status: InquiryStatusKey;
  receivedAt: string;
  contactName: string | null;
  property: DeskProperty;
}

const EMPTY_PROPERTY_INQUIRIES: PropertyAgentInquiries = {
  counts: { total: 0, guided: 0, preview: 0, materialRequest: 0, adPermission: 0 },
  timeline: [],
  adPermissions: {},
};

export async function fetchPropertyAgentInquiries(propertyId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return EMPTY_PROPERTY_INQUIRIES;
  }
  return apiFetch<PropertyAgentInquiries>(`/api/properties/${propertyId}/agent-inquiries`);
}
export async function putPropertyAdPermission(propertyId: string, change: AdPermissionChange) {
  if (USE_MOCK) {
    await mockDelay();
    return { adPermissions: (change.value ? { [change.medium]: change.value } : {}) as PropertyAgentInquiries["adPermissions"] };
  }
  return apiFetch<{ adPermissions: PropertyAgentInquiries["adPermissions"] }>(
    `/api/properties/${propertyId}/ad-permissions`,
    deskJsonInit("PUT", { items: [change] }),
  );
}
export async function fetchAgentDirectory(p: { archived?: boolean; cursor?: string }) {
  if (USE_MOCK) {
    await mockDelay();
    return { agents: [] as AgentDirectoryRow[], nextCursor: null as string | null, canWrite: true };
  }
  const sp = new URLSearchParams({ list: "1" });
  if (p.archived) sp.set("archived", "1");
  if (p.cursor) sp.set("cursor", p.cursor);
  return apiFetch<{ agents: AgentDirectoryRow[]; nextCursor: string | null; canWrite: boolean }>(`/api/agents?${sp.toString()}`);
}
export async function fetchAgentDetail(id: string, cursor?: string) {
  if (USE_MOCK) {
    await mockDelay();
    throw new Error("モックでは業者の詳細を読めません");
  }
  return apiFetch<{ agent: AgentDetail; inquiries: AgentHistoryItem[]; nextCursor: string | null; canWrite: boolean }>(
    `/api/agents/${id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
}
export async function updateAgent(
  id: string,
  body: { version: number; isArchived?: boolean } & Partial<Record<keyof DeskAgentInput, string | null>>,
) {
  if (USE_MOCK) {
    await mockDelay();
    return { version: body.version + 1 };
  }
  return apiFetch<{ version: number }>(`/api/agents/${id}`, deskJsonInit("PATCH", body));
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/__tests__/agent-main-api-client.test.ts && npx tsc --noEmit`
Expected: PASS・tsc 0

- [ ] **Step 5: Commit**

```bash
git add src/lib/api-client.ts src/lib/__tests__/agent-main-api-client.test.ts
git commit -m "feat(agent-inquiry): メイン画面側の API 呼び出し(物件の反響欄・広告の可否・名簿)"
```

---

### Task 3: 純関数(main-view.ts)

**Files:**
- Create: `src/lib/agent-inquiry/main-view.ts`
- Test: `src/lib/__tests__/agent-main-view.test.ts`

**Interfaces:**
- Consumes: `KIND_LABEL`・`VIEWING_TYPE_LABEL`(`@/lib/agent-inquiry/desk-form`)・Task 2 の型
- Produces:
  - `nextAdValue(v: AdValueKey | null): AdValueKey | null` — ○→×→△→未設定→○
  - `AD_VALUE_WORD: Record<AdValueKey | "none", string>` — 読み上げ用の言葉
  - `formatJstFull(iso: string): string` — `2026/10/2(金) 14:00`
  - `formatJstDate(iso: string): string` — `2026/10/2`
  - `timelineKindLabel(e: Pick<PropertyTimelineEntry, "kind" | "viewingType">): string`
  - `timelineWhen(e: Pick<PropertyTimelineEntry, "at" | "unscheduled">): string`
  - `AGENT_EDIT_FIELDS: readonly { key: AgentEditKey; label: string; phone?: true; multiline?: true }[]`・`type AgentEditKey`・`type AgentEdits = Partial<Record<AgentEditKey, string>>`
  - `agentFieldValue(agent: AgentDetail, edits: AgentEdits, key: AgentEditKey): string`
  - `agentEditError(agent: AgentDetail, edits: AgentEdits): string | null`
  - `agentEditPatch(agent: AgentDetail, edits: AgentEdits): Partial<Record<AgentEditKey, string | null>> | null`
  - `homeInquiryChips(c: InquiryCounts): { key: "open" | "viewings"; label: string; count: number; tone: "alert" | "info" | "quiet" }[]`
  - `MAIN_WINDOW_NAME = "pm-main"`・`DESK_WINDOW_NAME = "pm-inquiry-desk"`・`windowNameFor(current: string, wanted: string): string | null`

- [ ] **Step 1: 失敗するテスト**

```ts
// src/lib/__tests__/agent-main-view.test.ts
import { describe, it, expect } from "vitest";
import type { AgentDetail } from "@/lib/api-client";
import {
  nextAdValue, formatJstFull, formatJstDate, timelineKindLabel, timelineWhen, agentFieldValue, agentEditError,
  agentEditPatch, homeInquiryChips, windowNameFor, MAIN_WINDOW_NAME, DESK_WINDOW_NAME, AGENT_EDIT_FIELDS,
} from "@/lib/agent-inquiry/main-view";

const agent: AgentDetail = {
  id: "a1", companyName: "○○不動産", companyKana: null, branchName: "新宿支店", licenseNo: null,
  phone: "03-1234-5678", fax: null, email: "info@example.jp", address: null, note: null, isArchived: false, version: 4,
};

describe("広告の可否の次の値", () => {
  it("○→×→△→未設定→○ と一巡する(設計 §2.3)", () => {
    expect(nextAdValue("ok")).toBe("ng");
    expect(nextAdValue("ng")).toBe("ask");
    expect(nextAdValue("ask")).toBeNull();
    expect(nextAdValue(null)).toBe("ok");
  });
});

describe("日時の表示(JST・年つき)", () => {
  it("UTC の 15:00 は翌日の 0:00(JST)", () => {
    expect(formatJstFull("2026-12-31T15:00:00.000Z")).toBe("2027/1/1(金) 0:00");
    expect(formatJstDate("2026-12-31T15:00:00.000Z")).toBe("2027/1/1");
  });
  it("分は2桁", () => {
    expect(formatJstFull("2026-10-02T05:05:00.000Z")).toBe("2026/10/2(金) 14:05");
  });
});

describe("時系列の1行", () => {
  it("内見は案内/下見、それ以外は用件の名前", () => {
    expect(timelineKindLabel({ kind: "viewing", viewingType: "guided" })).toBe("案内");
    expect(timelineKindLabel({ kind: "viewing", viewingType: "preview" })).toBe("下見");
    expect(timelineKindLabel({ kind: "viewing", viewingType: null })).toBe("内見");
    expect(timelineKindLabel({ kind: "material_request", viewingType: null })).toBe("資料請求");
    expect(timelineKindLabel({ kind: "ad_permission", viewingType: null })).toBe("広告の許可");
  });
  it("日程が決まっていない内見は、受けた日時を添えて日程調整中と出す", () => {
    expect(timelineWhen({ at: "2026-10-02T05:00:00.000Z", unscheduled: true })).toBe("日程調整中(受付 2026/10/2(金) 14:00)");
    expect(timelineWhen({ at: "2026-10-02T05:00:00.000Z", unscheduled: false })).toBe("2026/10/2(金) 14:00");
  });
});

describe("名簿の編集=触った欄だけ送る", () => {
  it("触っていなければ最新の値を出し、送るものは無い", () => {
    expect(agentFieldValue(agent, {}, "branchName")).toBe("新宿支店");
    expect(agentFieldValue(agent, {}, "fax")).toBe("");
    expect(agentEditPatch(agent, {})).toBeNull();
  });
  it("触った欄だけを送る。空にした任意の欄は null", () => {
    expect(agentEditPatch(agent, { branchName: " 渋谷支店 ", email: "" })).toEqual({ branchName: "渋谷支店", email: null });
  });
  it("触ったが元と同じ(前後の空白だけ違う)なら送らない", () => {
    expect(agentEditPatch(agent, { branchName: "新宿支店 ", fax: "  " })).toBeNull();
  });
  it("★他の人が別の欄を直した後でも、触っていない欄は送らない(古い値で上書きしない)", () => {
    const newer: AgentDetail = { ...agent, address: "東京都新宿区1-1", version: 5 };
    expect(agentEditPatch(newer, { note: "要注意" })).toEqual({ note: "要注意" });
  });
  it("商号・代表電話を空にしたら保存させない", () => {
    expect(agentEditError(agent, { companyName: "  " })).toBe("商号と代表電話を入れてください");
    expect(agentEditError(agent, { phone: "" })).toBe("商号と代表電話を入れてください");
    expect(agentEditError(agent, { note: "x" })).toBeNull();
  });
  it("欄の並びに API の入力項目が全部ある", () => {
    expect(AGENT_EDIT_FIELDS.map((f) => f.key)).toEqual([
      "companyName", "companyKana", "branchName", "phone", "fax", "email", "licenseNo", "address", "note",
    ]);
  });
});

describe("ホームの件数", () => {
  it("未対応があれば目立たせ、0件は静かに出す(消さない=受付の窓の入口でもある)", () => {
    expect(homeInquiryChips({ open: 3, upcomingViewings: 0 })).toEqual([
      { key: "open", label: "未対応の反響", count: 3, tone: "alert" },
      { key: "viewings", label: "今日・明日の内見", count: 0, tone: "quiet" },
    ]);
    expect(homeInquiryChips({ open: 0, upcomingViewings: 2 })[1].tone).toBe("info");
  });
});

describe("窓の名前", () => {
  it("名前が空の窓だけ名乗る(受付の窓として開いた窓をメイン画面と呼ばない)", () => {
    expect(windowNameFor("", MAIN_WINDOW_NAME)).toBe("pm-main");
    expect(windowNameFor("pm-inquiry-desk", MAIN_WINDOW_NAME)).toBeNull();
    expect(windowNameFor("pm-main", MAIN_WINDOW_NAME)).toBeNull();
    expect(windowNameFor("", DESK_WINDOW_NAME)).toBe("pm-inquiry-desk");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/__tests__/agent-main-view.test.ts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装**

```ts
// src/lib/agent-inquiry/main-view.ts
import type { AdValueKey, AgentDetail, InquiryCounts, PropertyTimelineEntry } from "@/lib/api-client";
import { KIND_LABEL, VIEWING_TYPE_LABEL } from "./desk-form";

/** メイン画面側(物件の反響欄・業者の名簿・ホーム)の判定と表示(設計 2026-09-28 §2.3)。純関数だけ。 */

const AD_CYCLE: (AdValueKey | null)[] = ["ok", "ng", "ask", null];
/** 広告の可否を押したときの次の値。○→×→△→未設定→○。 */
export function nextAdValue(v: AdValueKey | null): AdValueKey | null {
  return AD_CYCLE[(AD_CYCLE.indexOf(v) + 1) % AD_CYCLE.length];
}
/** 読み上げ・説明用の言葉(記号だけでは伝わらないため)。 */
export const AD_VALUE_WORD: Record<AdValueKey | "none", string> = {
  ok: "可",
  ng: "不可",
  ask: "担当者に確認",
  none: "未設定",
};

const JST_MS = 9 * 60 * 60 * 1000;
const WEEK = "日月火水木金土";
const jst = (iso: string) => new Date(new Date(iso).getTime() + JST_MS);
/** 年つきの日付(JST・例「2026/10/2」)。履歴は年をまたぐ。 */
export function formatJstDate(iso: string): string {
  const j = jst(iso);
  return `${j.getUTCFullYear()}/${j.getUTCMonth() + 1}/${j.getUTCDate()}`;
}
/** 年つきの日時(JST・例「2026/10/2(金) 14:00」)。 */
export function formatJstFull(iso: string): string {
  const j = jst(iso);
  return `${formatJstDate(iso)}(${WEEK[j.getUTCDay()]}) ${j.getUTCHours()}:${String(j.getUTCMinutes()).padStart(2, "0")}`;
}

/** 時系列の1行の種類。内見の予定は案内/下見、それ以外は用件の名前。 */
export function timelineKindLabel(e: Pick<PropertyTimelineEntry, "kind" | "viewingType">): string {
  return e.viewingType ? VIEWING_TYPE_LABEL[e.viewingType] : KIND_LABEL[e.kind];
}
/** 時系列の1行の日時。日程未定の内見は受けた日時の位置に並ぶので、その旨を出す。 */
export function timelineWhen(e: Pick<PropertyTimelineEntry, "at" | "unscheduled">): string {
  return e.unscheduled ? `日程調整中(受付 ${formatJstFull(e.at)})` : formatJstFull(e.at);
}

/** 名簿の会社情報の欄(並びは画面の並び)。 */
export const AGENT_EDIT_FIELDS = [
  { key: "companyName", label: "商号(必須)" },
  { key: "companyKana", label: "ふりがな" },
  { key: "branchName", label: "支店名" },
  { key: "phone", label: "代表電話(必須)", phone: true },
  { key: "fax", label: "FAX", phone: true },
  { key: "email", label: "メール" },
  { key: "licenseNo", label: "免許番号" },
  { key: "address", label: "所在地" },
  { key: "note", label: "メモ", multiline: true },
] as const satisfies readonly { key: keyof AgentDetail; label: string; phone?: true; multiline?: true }[];
export type AgentEditKey = (typeof AGENT_EDIT_FIELDS)[number]["key"];
/** 触った欄だけを持つ(触っていない欄は最新の値をそのまま出す)。 */
export type AgentEdits = Partial<Record<AgentEditKey, string>>;
const REQUIRED: readonly AgentEditKey[] = ["companyName", "phone"];

export function agentFieldValue(agent: AgentDetail, edits: AgentEdits, key: AgentEditKey): string {
  return edits[key] ?? agent[key] ?? "";
}
export function agentEditError(agent: AgentDetail, edits: AgentEdits): string | null {
  return REQUIRED.some((k) => agentFieldValue(agent, edits, k).trim() === "") ? "商号と代表電話を入れてください" : null;
}
/**
 * 保存で送る変更。**触った欄のうち、今の値と違うものだけ**=読み直した後に他の人が直した別の欄を、
 * 古い値で上書きしない。任意の欄を空にしたら null(消す)。何も無ければ null(送らない)。
 */
export function agentEditPatch(agent: AgentDetail, edits: AgentEdits): Partial<Record<AgentEditKey, string | null>> | null {
  const patch: Partial<Record<AgentEditKey, string | null>> = {};
  for (const { key } of AGENT_EDIT_FIELDS) {
    const typed = edits[key];
    if (typed === undefined) continue;
    const next = typed.trim();
    if (next === (agent[key] ?? "").trim()) continue;
    patch[key] = next === "" && !REQUIRED.includes(key) ? null : next;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** ホームに出す2つの件数(設計 方針9)。0件でも出す=受付の窓の入口を兼ねる。 */
export function homeInquiryChips(c: InquiryCounts) {
  return [
    { key: "open" as const, label: "未対応の反響", count: c.open, tone: c.open > 0 ? ("alert" as const) : ("quiet" as const) },
    {
      key: "viewings" as const,
      label: "今日・明日の内見",
      count: c.upcomingViewings,
      tone: c.upcomingViewings > 0 ? ("info" as const) : ("quiet" as const),
    },
  ];
}

export const MAIN_WINDOW_NAME = "pm-main";
export const DESK_WINDOW_NAME = "pm-inquiry-desk";
/**
 * この窓が名乗るべき名前(null=変えない)。名前が空の窓だけ名乗る=リンクの target から開いた窓
 * (すでに名前がある)を別の名前に付け替えない。
 */
export function windowNameFor(current: string, wanted: string): string | null {
  return current === "" ? wanted : null;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/__tests__/agent-main-view.test.ts && npx tsc --noEmit`
Expected: PASS・tsc 0

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-inquiry/main-view.ts src/lib/__tests__/agent-main-view.test.ts
git commit -m "feat(agent-inquiry): メイン画面側の純関数(広告の可否の次の値・時系列・名簿の編集・窓の名前)"
```

---

### Task 4: 窓どうしの合図・窓の名前

**Files:**
- Create: `src/lib/agent-inquiry/desk-sync.ts`
- Modify: `src/app/(desk)/inquiry-desk/page.tsx`(`reloadAll` で合図を出す)
- Modify: `src/components/layout/dashboard-layout.tsx`(窓の名前 `pm-main`)
- Modify: `src/components/agent-inquiry/desk-shell.tsx`(窓の名前 `pm-inquiry-desk`)
- Test: `src/lib/__tests__/agent-main-sync.test.ts`

**Interfaces:**
- Consumes: `windowNameFor`・`MAIN_WINDOW_NAME`・`DESK_WINDOW_NAME`(Task 3)
- Produces: `INQUIRY_SYNC_CHANNEL = "pm-agent-inquiry"`・`notifyInquiryChanged(): void`・`onInquiryChanged(cb: () => void): () => void`(戻り値=やめる関数)

- [ ] **Step 1: 失敗するテスト**

```ts
// src/lib/__tests__/agent-main-sync.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INQUIRY_SYNC_CHANNEL, notifyInquiryChanged, onInquiryChanged } from "@/lib/agent-inquiry/desk-sync";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

/** 同じ名前の相手(自分以外)へ届ける、最小限の偽物。 */
class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(public name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(data: unknown) {
    for (const c of FakeChannel.all) if (c !== this && !c.closed && c.name === this.name) c.onmessage?.({ data });
  }
  close() {
    this.closed = true;
  }
}
afterEach(() => {
  FakeChannel.all = [];
  vi.unstubAllGlobals();
});

describe("窓どうしの合図", () => {
  it("変わったと知らせると、聞いている側が呼ばれる", () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const cb = vi.fn();
    const off = onInquiryChanged(cb);
    notifyInquiryChanged();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    notifyInquiryChanged();
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it("合図の中身は「変わった」だけ(名前・電話・id を載せない)", () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const seen: unknown[] = [];
    const listener = new FakeChannel(INQUIRY_SYNC_CHANNEL);
    listener.onmessage = (e) => seen.push(e.data);
    notifyInquiryChanged();
    expect(seen).toEqual([{ type: "changed" }]);
  });
  it("知らない合図では呼ばない", () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const cb = vi.fn();
    onInquiryChanged(cb);
    new FakeChannel(INQUIRY_SYNC_CHANNEL).postMessage({ type: "other" });
    new FakeChannel(INQUIRY_SYNC_CHANNEL).postMessage(null);
    expect(cb).not.toHaveBeenCalled();
  });
  it("知らせた側の通り道は閉じる(開きっぱなしにしない)", () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    notifyInquiryChanged();
    expect(FakeChannel.all.every((c) => c.closed)).toBe(true);
  });
  it("★BroadcastChannel が無いブラウザでも何も起きない(落ちない)", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(() => notifyInquiryChanged()).not.toThrow();
    expect(() => onInquiryChanged(() => {})()).not.toThrow();
  });
  it("★作るときに例外を投げる環境でも落ちない", () => {
    vi.stubGlobal("BroadcastChannel", class { constructor() { throw new Error("blocked"); } });
    expect(() => notifyInquiryChanged()).not.toThrow();
    expect(() => onInquiryChanged(() => {})()).not.toThrow();
  });
});

describe("受付の窓は、保存・変更のたびに合図を出す", () => {
  it("reloadAll の中で notifyInquiryChanged を呼ぶ", () => {
    const src = read("src/app/(desk)/inquiry-desk/page.tsx");
    const at = src.indexOf("const reloadAll = useCallback(");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 200)).toContain("notifyInquiryChanged()");
  });
});

describe("窓の名前", () => {
  it("メイン画面の枠は pm-main を名乗る(名前が空のときだけ)", () => {
    const src = read("src/components/layout/dashboard-layout.tsx");
    expect(src).toContain("windowNameFor(window.name, MAIN_WINDOW_NAME)");
  });
  it("受付の窓の枠は pm-inquiry-desk を名乗る(ブックマークから開いても2枚目が増えない)", () => {
    const src = read("src/components/agent-inquiry/desk-shell.tsx");
    expect(src).toContain("windowNameFor(window.name, DESK_WINDOW_NAME)");
  });
  it("メニューの窓の名前と同じ値を使っている", () => {
    expect(read("src/components/layout/sidebar-model.tsx")).toContain('windowName: "pm-inquiry-desk"');
    expect(read("src/components/agent-inquiry/inquiry-detail.tsx")).toContain('target="pm-main"');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/__tests__/agent-main-sync.test.ts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装**

```ts
// src/lib/agent-inquiry/desk-sync.ts
/**
 * 受付の窓とメイン画面(同じブラウザの別の窓)の間の合図。受付の窓で反響を登録・変更したら、
 * 開きっぱなしのメイン画面(物件の反響欄・ホームの件数)が読み直す。
 * ⚠載せるのは「変わった」の一言だけ(名前・電話・id を載せない)。受けた側は自分の権限で API を読み直す。
 * ⚠使えないブラウザ・塞がれた環境では何もしない(画面は「読み直す」ボタンと窓に戻ったときの読み直しで追いつく)。
 */
export const INQUIRY_SYNC_CHANNEL = "pm-agent-inquiry";
type SyncMessage = { type: "changed" };

export function notifyInquiryChanged(): void {
  try {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(INQUIRY_SYNC_CHANNEL);
    ch.postMessage({ type: "changed" } satisfies SyncMessage);
    ch.close();
  } catch {
    // 合図は「あれば便利」なもの。出せなくても保存そのものは済んでいる。
  }
}

/** 合図を聞く。戻り値=やめる関数(effect の後片付けにそのまま渡せる)。 */
export function onInquiryChanged(cb: () => void): () => void {
  try {
    if (typeof BroadcastChannel === "undefined") return () => {};
    const ch = new BroadcastChannel(INQUIRY_SYNC_CHANNEL);
    ch.onmessage = (e: MessageEvent) => {
      if ((e.data as SyncMessage | null)?.type === "changed") cb();
    };
    return () => ch.close();
  } catch {
    return () => {};
  }
}
```

`src/app/(desk)/inquiry-desk/page.tsx` — import を足し、`reloadAll` を変える:

```ts
import { notifyInquiryChanged } from "@/lib/agent-inquiry/desk-sync";
```
```ts
  // 読み直しの合図(保存・変更のたびに1つ進める)。取得は下の effect がまとめて行う。
  // メイン画面(物件の反響欄・ホームの件数)にも「変わった」と知らせる。
  const [reloadKey, setReloadKey] = useState(0);
  const reloadAll = useCallback(() => {
    setReloadKey((k) => k + 1);
    notifyInquiryChanged();
  }, []);
```

`src/components/layout/dashboard-layout.tsx` — import を足し、`useSession()` の行の直後(早期 return より前)に effect を置く:

```ts
import { useEffect } from "react";
import { MAIN_WINDOW_NAME, windowNameFor } from "@/lib/agent-inquiry/main-view";
```
```ts
  // 受付の窓の「メイン画面で物件を開く」(target="pm-main")が、この窓に開くようにする。
  // 名前が空の窓だけ名乗る(受付の窓として開いた窓をメイン画面と呼ばない)。
  useEffect(() => {
    const name = windowNameFor(window.name, MAIN_WINDOW_NAME);
    if (name) window.name = name;
  }, []);
```

`src/components/agent-inquiry/desk-shell.tsx` — import を足し、`DeskShell` の `useOpenCount()` の行の直後に置く:

```ts
import { DESK_WINDOW_NAME, windowNameFor } from "@/lib/agent-inquiry/main-view";
```
```ts
  // ブックマークから直接開いた窓は名前が空。メイン画面の「反響の受付」がこの窓に開くよう名乗る。
  useEffect(() => {
    const name = windowNameFor(window.name, DESK_WINDOW_NAME);
    if (name) window.name = name;
  }, []);
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/__tests__/agent-main-sync.test.ts src/lib/__tests__/agent-desk-page-scan.test.ts src/components/agent-inquiry src/components/layout && npx tsc --noEmit`
Expected: PASS・tsc 0

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-inquiry/desk-sync.ts src/lib/__tests__/agent-main-sync.test.ts "src/app/(desk)/inquiry-desk/page.tsx" src/components/layout/dashboard-layout.tsx src/components/agent-inquiry/desk-shell.tsx
git commit -m "feat(agent-inquiry): 窓どうしの合図と窓の名前(pm-main / pm-inquiry-desk)"
```

---

### Task 5: 物件画面の「反響」タブ

**Files:**
- Modify: `src/components/agent-inquiry/ad-permission-chips.tsx`(色の表を `AD_TONE` として外へ出す)
- Create: `src/components/properties/agent-inquiry-tab.tsx`
- Modify: `src/app/(dashboard)/properties/[id]/page.tsx`(タブの定義と中身)
- Test: `src/components/properties/__tests__/agent-inquiry-tab.test.tsx`

**Interfaces:**
- Consumes: `fetchPropertyAgentInquiries`・`putPropertyAdPermission`・`apiErrorCode`(api-client)/`nextAdValue`・`AD_VALUE_WORD`・`timelineKindLabel`・`timelineWhen`(Task 3)/`notifyInquiryChanged`・`onInquiryChanged`(Task 4)/`AD_MEDIA_ORDER`・`AD_MEDIUM_LABEL`・`AD_VALUE_MARK`・`isAmbiguousSaveError`(desk-form)
- Produces: `PropertyInquiryView`(見た目・props だけ)/`default AgentInquiryTab({ propertyId, canWrite })`/`adSaveErrorMessage(e: unknown): string`

- [ ] **Step 1: 失敗するテスト**

```tsx
// src/components/properties/__tests__/agent-inquiry-tab.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PropertyAgentInquiries } from "@/lib/api-client";
import { PropertyInquiryView, adSaveErrorMessage } from "../agent-inquiry-tab";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const data: PropertyAgentInquiries = {
  counts: { total: 4, guided: 2, preview: 1, materialRequest: 1, adPermission: 0 },
  adPermissions: { suumo: "ok", athome: "ng", flyer: "ask" },
  timeline: [
    { key: "viewing:v1", at: "2026-10-02T05:00:00.000Z", inquiryId: "q1", kind: "viewing", viewingType: "guided", agentName: "○○不動産", contactName: "田中", attendantName: "佐藤", resultNote: "前向き", canceled: false, unscheduled: false },
    { key: "viewing:v2", at: "2026-09-30T01:00:00.000Z", inquiryId: "q1", kind: "viewing", viewingType: "preview", agentName: "○○不動産", contactName: null, attendantName: null, resultNote: null, canceled: true, unscheduled: false },
    { key: "inquiry:q2", at: "2026-09-29T01:00:00.000Z", inquiryId: "q2", kind: "material_request", viewingType: null, agentName: "△△住宅", contactName: null, attendantName: null, resultNote: null, canceled: false, unscheduled: false },
  ],
};
const view = (p: Partial<Parameters<typeof PropertyInquiryView>[0]> = {}) =>
  renderToStaticMarkup(
    <PropertyInquiryView data={data} canEditAds savingMedium={null} message={null} onToggleAd={() => {}} onReload={() => {}} {...p} />,
  );

describe("物件画面の反響欄", () => {
  it("件数(反響・案内・下見・資料請求)を出す", () => {
    const out = view();
    expect(out).toContain("反響 4件");
    expect(out).toContain("案内 2");
    expect(out).toContain("下見 1");
    expect(out).toContain("資料請求 1");
  });
  it("編集できる人には広告の可否を6つのボタンで出す。今の値と、押すとどうなるかを読み上げで伝える", () => {
    const out = view();
    expect((out.match(/<button[^>]*data-ad-medium=/g) ?? []).length).toBe(6);
    expect(out).toContain('aria-label="SUUMO: 可。押すと 不可 に変わります"');
    expect(out).toContain('aria-label="自社HP: 未設定。押すと 可 に変わります"');
  });
  it("編集できない人にはボタンを出さない(値は見える)", () => {
    const out = view({ canEditAds: false });
    expect(out).not.toMatch(/<button[^>]*data-ad-medium=/);
    expect(out).toContain("SUUMO");
    expect(out).toContain("○");
  });
  it("★保存中は6つとも押せない(連打で古い値のまま2回目を送らない)", () => {
    const out = view({ savingMedium: "suumo" });
    expect((out.match(/<button[^>]*data-ad-medium=[^>]*disabled=""/g) ?? []).length).toBe(6);
  });
  it("時系列は新しい順のまま・年つきの日時・案内/下見・業者・立ち会い・結果", () => {
    const out = view();
    expect(out.indexOf("2026/10/2(金) 14:00")).toBeLessThan(out.indexOf("2026/9/29(火) 10:00"));
    expect(out).toContain("案内");
    expect(out).toContain("○○不動産");
    expect(out).toContain("立ち会い:佐藤");
    expect(out).toContain("前向き");
  });
  it("取り消した内見は薄くして「取り消し」と出す", () => {
    expect(view()).toMatch(/opacity-50[^>]*>[\s\S]*?取り消し/);
  });
  it("反響が無ければ「まだありません」", () => {
    expect(view({ data: { ...data, timeline: [], counts: { total: 0, guided: 0, preview: 0, materialRequest: 0, adPermission: 0 } } })).toContain("この物件への反響はまだありません");
  });
  it("知らせ(409 など)を出す", () => {
    expect(view({ message: "他の人が先に変えました" })).toContain("他の人が先に変えました");
  });
  it("受付の窓へは名前付きの窓で開く素のリンク(noopener を付けない)", () => {
    const out = view();
    expect(out).toMatch(/<a href="\/inquiry-desk" target="pm-inquiry-desk"/);
    expect(out).not.toMatch(/target="pm-inquiry-desk"[^>]*rel=/);
  });
});

describe("広告の可否の保存の失敗の文言", () => {
  const err = (code: string, status: number) => Object.assign(new Error("x"), { code, status });
  it("★409 は「他の人が先に変えた」と伝える(押した値になったとは言わない)", () => {
    expect(adSaveErrorMessage(err("VERSION_CONFLICT", 409))).toBe("他の人が先に変えました。今の表示が最新です。変えるときはもう一度押してください。");
  });
  it("403 は権限が無い", () => {
    expect(adSaveErrorMessage(err("FORBIDDEN", 403))).toBe("広告の可否を変える権限がありません。");
  });
  it("通信切れ・5xx は、変わったか分からないと伝える", () => {
    expect(adSaveErrorMessage(new Error("Failed to fetch"))).toBe("変更できたか分かりません(通信が切れました)。今の表示が最新です。");
    expect(adSaveErrorMessage(err("INTERNAL_ERROR", 502))).toBe("変更できたか分かりません(通信が切れました)。今の表示が最新です。");
  });
});

describe("物件画面への組み込み", () => {
  const page = read("src/app/(dashboard)/properties/[id]/page.tsx");
  it("タブ「反響」がネクストアクションの次にある", () => {
    expect(page).toMatch(/\{ key: "actions", label: "ネクストアクション" \},\n\s*\{ key: "inquiries", label: "反響" \},/);
  });
  it("物件ごとに作り直し(key)、物件の編集権限を渡す", () => {
    expect(page).toMatch(/<AgentInquiryTab key=\{property\.id\} propertyId=\{property\.id\} canWrite=\{canWriteProperty\} \/>/);
  });
  it("反響タブは権限表を自分で読まない(3点セットの対象にしない)", () => {
    expect(read("src/components/properties/agent-inquiry-tab.tsx")).not.toContain("useScreenProtection");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/components/properties/__tests__/agent-inquiry-tab.test.tsx`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装**

`src/components/agent-inquiry/ad-permission-chips.tsx` — `const TONE = {` を `export const AD_TONE = {` に変え、ファイル内の `TONE[` を `AD_TONE[` に置き換える(中身は変えない)。

```tsx
// src/components/properties/agent-inquiry-tab.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiErrorCode,
  fetchPropertyAgentInquiries,
  putPropertyAdPermission,
  type AdMediumKey,
  type PropertyAgentInquiries,
} from "@/lib/api-client";
import { AD_MEDIA_ORDER, AD_MEDIUM_LABEL, AD_VALUE_MARK, isAmbiguousSaveError } from "@/lib/agent-inquiry/desk-form";
import { AD_VALUE_WORD, nextAdValue, timelineKindLabel, timelineWhen } from "@/lib/agent-inquiry/main-view";
import { notifyInquiryChanged, onInquiryChanged } from "@/lib/agent-inquiry/desk-sync";
import { AD_TONE } from "@/components/agent-inquiry/ad-permission-chips";
import { Button } from "@/components/ui/button";

/** 広告の可否の保存に失敗したときの文言。 */
export function adSaveErrorMessage(e: unknown): string {
  const code = apiErrorCode(e);
  if (code === "VERSION_CONFLICT") return "他の人が先に変えました。今の表示が最新です。変えるときはもう一度押してください。";
  if (code === "FORBIDDEN") return "広告の可否を変える権限がありません。";
  // 通信が切れた・中継の時間切れは、サーバー側では変わっていることがある=失敗と言い切らない。
  if (isAmbiguousSaveError(e)) return "変更できたか分かりません(通信が切れました)。今の表示が最新です。";
  return e instanceof Error && e.message ? e.message : "変更できませんでした。";
}

/** 物件画面の反響欄の見た目(設計 §2.3)。件数 → 広告の可否 → 時系列(新しい順)。 */
export function PropertyInquiryView({
  data,
  canEditAds,
  savingMedium,
  message,
  onToggleAd,
  onReload,
}: {
  data: PropertyAgentInquiries;
  canEditAds: boolean;
  savingMedium: AdMediumKey | null;
  message: string | null;
  onToggleAd: (m: AdMediumKey) => void;
  onReload: () => void;
}) {
  const c = data.counts;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-700 dark:text-gray-300">
          <b>反響 {c.total}件</b>
          <span>案内 {c.guided}</span>
          <span>下見 {c.preview}</span>
          <span>資料請求 {c.materialRequest}</span>
          <span>広告の許可 {c.adPermission}</span>
        </p>
        <span className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onReload}>
            読み直す
          </Button>
          {/* 名前付きの窓に開く(同じ窓があればそこへ)。noopener を付けると毎回新しい窓になる。 */}
          <a href="/inquiry-desk" target="pm-inquiry-desk" className="text-sm text-indigo-600 underline dark:text-indigo-400">
            反響の受付を開く ↗
          </a>
        </span>
      </div>

      <section aria-label="広告の可否">
        <h3 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">広告の可否</h3>
        <ul className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-3">
          {AD_MEDIA_ORDER.map((m) => {
            const v = data.adPermissions[m] ?? null;
            const tone = AD_TONE[v ?? "none"];
            const mark = v ? AD_VALUE_MARK[v] : "—";
            if (!canEditAds) {
              return (
                <li key={m} className={`flex justify-between rounded px-2 py-1.5 ${tone}`}>
                  <span>{AD_MEDIUM_LABEL[m]}</span>
                  <b>{mark}</b>
                </li>
              );
            }
            return (
              <li key={m}>
                <button
                  type="button"
                  data-ad-medium={m}
                  // 保存中は6つとも止める=連打で古い値(from)のまま2回目を送らない。
                  disabled={savingMedium != null}
                  onClick={() => onToggleAd(m)}
                  aria-label={`${AD_MEDIUM_LABEL[m]}: ${AD_VALUE_WORD[v ?? "none"]}。押すと ${AD_VALUE_WORD[nextAdValue(v) ?? "none"]} に変わります`}
                  className={`flex w-full justify-between rounded px-2 py-1.5 ring-1 ring-inset ring-black/5 hover:ring-indigo-400 disabled:cursor-not-allowed disabled:opacity-60 dark:ring-white/10 ${tone}`}
                >
                  <span>{AD_MEDIUM_LABEL[m]}</span>
                  <b>{savingMedium === m ? "…" : mark}</b>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          ○=可 ×=不可 △=担当者に確認 —=未設定
          {canEditAds && "。押すたびに ○→×→△→未設定 と切り替わり、その場で保存されます。"}
        </p>
        {message && (
          <p role="alert" className="mt-1 text-sm text-rose-600 dark:text-rose-400">
            {message}
          </p>
        )}
      </section>

      <section aria-label="反響の時系列">
        <h3 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">これまでの反響(新しい順)</h3>
        {data.timeline.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">この物件への反響はまだありません。</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {data.timeline.map((e) => (
              <li key={e.key} className={`py-2 text-sm${e.canceled ? " opacity-50" : ""}`}>
                <span className="mr-2 text-xs text-gray-500 dark:text-gray-400">{timelineWhen(e)}</span>
                <span className="mr-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-gray-800">{timelineKindLabel(e)}</span>
                {e.canceled && <span className="mr-2 text-xs text-gray-500">取り消し</span>}
                <span className="font-medium">{e.agentName}</span>
                {e.contactName && <span>{`(${e.contactName}様)`}</span>}
                {e.attendantName && <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{`立ち会い:${e.attendantName}`}</span>}
                {e.resultNote && <p className="mt-0.5 whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-300">{e.resultNote}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * 物件画面の「反響」タブ。読む=物件の閲覧権限、広告の可否を変える=物件の編集権限(canWrite は親が渡す)。
 * ⚠ここでは権限表を読まない(API が物件の規則で 403 を返す)。
 */
export default function AgentInquiryTab({ propertyId, canWrite }: { propertyId: string; canWrite: boolean }) {
  const [data, setData] = useState<PropertyAgentInquiries | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingMedium, setSavingMedium] = useState<AdMediumKey | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 読み込みの世代。新しい読み込みを始めたら、古い読み込みの結果は捨てる(順番が入れ替わっても古い値で上書きしない)。
  const genRef = useRef(0);
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    const gen = ++genRef.current;
    try {
      const d = await fetchPropertyAgentInquiries(propertyId);
      if (genRef.current !== gen) return;
      setData(d);
      setLoadError(null);
    } catch (e) {
      if (genRef.current !== gen) return;
      setLoadError(
        apiErrorCode(e) === "FORBIDDEN" ? "この物件の反響を見る権限がありません。" : "反響を読み込めませんでした。",
      );
    }
  }, [propertyId]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    // 受付の窓で登録・変更されたら読み直す。窓に戻ってきたときも読み直す(合図が使えない環境の保険)。
    const off = onInquiryChanged(() => void load());
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(first);
      off();
      window.removeEventListener("focus", onFocus);
      genRef.current += 1;
    };
  }, [load]);

  const toggle = async (medium: AdMediumKey) => {
    if (!data || savingRef.current) return;
    const from = data.adPermissions[medium] ?? null;
    savingRef.current = true;
    setSavingMedium(medium);
    setMessage(null);
    try {
      const r = await putPropertyAdPermission(propertyId, { medium, value: nextAdValue(from), from });
      setData((d) => (d ? { ...d, adPermissions: r.adPermissions } : d));
      notifyInquiryChanged();
    } catch (e) {
      setMessage(adSaveErrorMessage(e));
    }
    // 成功でも失敗でも、保存の後に始めた読み込みで今の値に揃える(保存中に始まった古い読み込みは世代で捨てる)。
    await load();
    savingRef.current = false;
    setSavingMedium(null);
  };

  if (loadError && !data) {
    return (
      <div className="text-sm">
        <p className="mb-2 text-rose-600 dark:text-rose-400">{loadError}</p>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          もう一度読む
        </Button>
      </div>
    );
  }
  if (!data) return <p className="text-sm text-gray-500 dark:text-gray-400">読み込み中…</p>;
  return (
    <>
      {loadError && (
        <p role="alert" className="mb-2 text-sm text-rose-600 dark:text-rose-400">
          {loadError}(下の表示は最新ではないかもしれません)
        </p>
      )}
      <PropertyInquiryView
        data={data}
        canEditAds={canWrite}
        savingMedium={savingMedium}
        message={message}
        onToggleAd={(m) => void toggle(m)}
        onReload={() => void load()}
      />
    </>
  );
}
```

`src/app/(dashboard)/properties/[id]/page.tsx`:
1. import を足す: `import AgentInquiryTab from "@/components/properties/agent-inquiry-tab";`
2. `tabs` の `{ key: "actions", label: "ネクストアクション" },` の次の行に `{ key: "inquiries", label: "反響" },` を足す。
3. タブの中身の `{activeTab === "actions" && (…)}` の次に足す:
```tsx
        {/* 業者からの反響(設計 2026-09-28 §2.3)。広告の可否を変えられるのは物件の編集権限がある人だけ。 */}
        {activeTab === "inquiries" && (
          <AgentInquiryTab key={property.id} propertyId={property.id} canWrite={canWriteProperty} />
        )}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/components/properties src/components/agent-inquiry "src/app/(dashboard)" src/lib/__tests__/permission-freshness-pattern.test.ts && npx tsc --noEmit && npx eslint src/components/properties/agent-inquiry-tab.tsx "src/app/(dashboard)/properties/[id]/page.tsx"`
Expected: PASS・tsc 0・eslint 0。⚠eslint が effect 内の setState(`react-hooks/set-state-in-effect`)を指摘したら、初回の読み込みが `setTimeout` の中(=effect の本体の外)にあることを確かめる。物件画面のタブの数を固定している既存テストが落ちたら、「反響」が増えたことに合わせて期待値を直す(意図した変更)。

- [ ] **Step 5: Commit**

```bash
git add src/components/properties/agent-inquiry-tab.tsx src/components/properties/__tests__/agent-inquiry-tab.test.tsx src/components/agent-inquiry/ad-permission-chips.tsx "src/app/(dashboard)/properties/[id]/page.tsx"
git commit -m "feat(agent-inquiry): 物件画面に反響タブ(件数・広告の可否の切り替え・時系列)"
```

---

### Task 6: ホームの件数

**Files:**
- Create: `src/components/home/home-inquiry-counts.tsx`
- Modify: `src/components/home/HomeContent.tsx`
- Test: `src/components/home/__tests__/home-inquiry-counts.test.tsx`

**Interfaces:**
- Consumes: `fetchAgentInquiryCounts`・型 `InquiryCounts`(api-client・既存)/`homeInquiryChips`(Task 3)/`onInquiryChanged`(Task 4)
- Produces: `HomeInquiryCountsView({ counts })`/`default HomeInquiryCounts()`

- [ ] **Step 1: 失敗するテスト**

```tsx
// src/components/home/__tests__/home-inquiry-counts.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import HomeInquiryCounts, { HomeInquiryCountsView } from "../home-inquiry-counts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("ホームの反響の件数(設計 方針9)", () => {
  it("未対応の反響と今日・明日の内見の件数を出す", () => {
    const out = renderToStaticMarkup(<HomeInquiryCountsView counts={{ open: 3, upcomingViewings: 1 }} />);
    expect(out).toContain("未対応の反響");
    expect(out).toMatch(/>3<span[^>]*>件<\/span>/);
    expect(out).toContain("今日・明日の内見");
    expect(out).toMatch(/>1<span[^>]*>件<\/span>/);
  });
  it("どちらも受付の窓を名前付きの窓で開く(noopener を付けない)", () => {
    const out = renderToStaticMarkup(<HomeInquiryCountsView counts={{ open: 0, upcomingViewings: 0 }} />);
    expect((out.match(/<a href="\/inquiry-desk" target="pm-inquiry-desk"/g) ?? []).length).toBe(2);
    expect(out).not.toContain("noopener");
  });
  it("読めるまで(権限が無い・失敗も含む)は何も出さない", () => {
    expect(renderToStaticMarkup(<HomeInquiryCounts />)).toBe("");
  });
  it("失敗したら消す(古い件数を残さない)", () => {
    const src = read("src/components/home/home-inquiry-counts.tsx");
    expect(src).toMatch(/catch[\s\S]{0,120}setCounts\(null\)/);
  });
  it("ホームの題名の下・カードの上に置く", () => {
    const src = read("src/components/home/HomeContent.tsx");
    const a = src.indexOf("<PageHeader");
    const b = src.indexOf("<HomeInquiryCounts />");
    const c = src.indexOf("cards.map(");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/components/home`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装**

```tsx
// src/components/home/home-inquiry-counts.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { fetchAgentInquiryCounts, type InquiryCounts } from "@/lib/api-client";
import { homeInquiryChips } from "@/lib/agent-inquiry/main-view";
import { onInquiryChanged } from "@/lib/agent-inquiry/desk-sync";

const TONE = {
  alert: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200",
  info: "border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-200",
  quiet: "border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300",
} as const;

/** ホームの「未対応の反響」「今日・明日の内見」(見た目)。押すと受付の窓(同じ名前の窓があればそこ)。 */
export function HomeInquiryCountsView({ counts }: { counts: InquiryCounts }) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-3" aria-label="業者からの反響">
      {homeInquiryChips(counts).map((c) => (
        <a
          key={c.key}
          href="/inquiry-desk"
          target="pm-inquiry-desk"
          className={`flex items-baseline justify-between gap-2 rounded-xl border p-4 shadow-sm transition-colors hover:border-indigo-300 dark:hover:border-indigo-700 ${TONE[c.tone]}`}
        >
          <span className="text-sm font-semibold">{c.label}</span>
          <span className="text-2xl font-bold">
            {c.count}
            <span className="ml-0.5 text-sm font-medium">件</span>
          </span>
        </a>
      ))}
    </div>
  );
}

/** 件数を読んで出す。読めない(権限が無い・通信の失敗)ときは何も出さない=ホームを壊さない。 */
export default function HomeInquiryCounts() {
  const [counts, setCounts] = useState<InquiryCounts | null>(null);
  const genRef = useRef(0);
  useEffect(() => {
    const load = async () => {
      const gen = ++genRef.current;
      try {
        const c = await fetchAgentInquiryCounts();
        if (genRef.current === gen) setCounts(c);
      } catch {
        // 権限を外された後・ログインが切れた後に、古い件数を残さない。
        if (genRef.current === gen) setCounts(null);
      }
    };
    const first = setTimeout(() => void load(), 0);
    const off = onInquiryChanged(() => void load());
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(first);
      off();
      window.removeEventListener("focus", onFocus);
      genRef.current += 1;
    };
  }, []);
  if (!counts) return null;
  return <HomeInquiryCountsView counts={counts} />;
}
```

`src/components/home/HomeContent.tsx` — import を足し、`<PageHeader … />` の次の行に置く:

```tsx
import HomeInquiryCounts from "./home-inquiry-counts";
```
```tsx
      <PageHeader title="ホーム" description="やりたいことを選んでください。" />
      {/* 業者からの反響(設計 2026-09-28 方針9)。権限が無い人には出ない。 */}
      <HomeInquiryCounts />
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/components/home src/components/layout && npx tsc --noEmit && npx eslint src/components/home`
Expected: PASS・tsc 0・eslint 0

- [ ] **Step 5: Commit**

```bash
git add src/components/home
git commit -m "feat(agent-inquiry): ホームに未対応の反響と今日・明日の内見の件数"
```

---

### Task 7: 業者の名簿(一覧)とメニュー

**Files:**
- Create: `src/components/agent-inquiry/agent-directory.tsx`
- Create: `src/app/(dashboard)/agents/page.tsx`
- Modify: `src/components/layout/sidebar-model.tsx`
- Modify(期待値): `src/components/layout/__tests__/sidebar-reorg.test.ts`・`src/lib/__tests__/agent-desk-routing.test.ts`
- Test: `src/components/agent-inquiry/__tests__/agent-directory.test.tsx`

**Interfaces:**
- Consumes: `fetchAgentDirectory`・`searchDeskAgents`・`apiErrorCode`・型 `AgentDirectoryRow`・`AgentHit`(api-client)/`agentLabel`・`hitsForQuery`・`newAgentAction`・`splitNewAgentPhone`・型 `SearchResult`(desk-form)/`agentQueryReady`(agent-query)/`formatJstDate`(Task 3)/`AgentCreateModal`(既存)
- Produces: `AgentDirectoryRows({ rows })`・`AgentSearchHits({ hits })`/画面 `/agents`/メニュー項目 `{ label: "業者の名簿", href: "/agents", minRole: "field_staff" }`

- [ ] **Step 1: 失敗するテスト**

```tsx
// src/components/agent-inquiry/__tests__/agent-directory.test.tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
import { AgentDirectoryRows, AgentSearchHits } from "../agent-directory";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("業者の名簿の一覧(設計 §2.3)", () => {
  const rows = [
    { id: "a1", companyName: "○○不動産", branchName: "新宿支店", phone: "03-1234-5678", isArchived: false, inquiryCount: 7, lastReceivedAt: "2026-09-29T01:00:00.000Z" },
    { id: "a2", companyName: "△△住宅", branchName: null, phone: "03-9876-5432", isArchived: false, inquiryCount: 0, lastReceivedAt: null },
  ];
  it("支店名まで・代表電話・反響件数・最終日を出し、詳細へ行ける", () => {
    const out = renderToStaticMarkup(<AgentDirectoryRows rows={rows} />);
    expect(out).toContain("○○不動産 新宿支店");
    expect(out).toContain("03-1234-5678");
    expect(out).toContain("反響 7件");
    expect(out).toContain("最終 2026/9/29");
    expect(out).toContain('href="/agents/a1"');
  });
  it("反響がまだ無い業者は「反響なし」", () => {
    expect(renderToStaticMarkup(<AgentDirectoryRows rows={rows} />)).toContain("反響なし");
  });
  it("0件のとき", () => {
    expect(renderToStaticMarkup(<AgentDirectoryRows rows={[]} />)).toContain("業者がありません");
  });
  it("検索の結果=携帯で当たったら前回の問い合わせ者の名前に保護の印を付ける", () => {
    const out = renderToStaticMarkup(
      <AgentSearchHits hits={[{ id: "a1", companyName: "○○不動産", branchName: null, phone: "03-1234-5678", matchedBy: "mobile", lastContact: { name: "田中", mobile: "090-1111-2222", email: null } }]} />,
    );
    expect(out).toContain('href="/agents/a1"');
    expect(out).toMatch(/data-pii-protected="true" data-pii-surface="dashboard"[^>]*>[^<]*田中様/);
  });
});

describe("名簿の画面", () => {
  const page = () => read("src/app/(dashboard)/agents/page.tsx");
  it("題名はメニューの名前と同じ(素の文字列)", () => {
    expect(page()).toContain('<PageHeader title="業者の名簿"');
  });
  it("★権限が無いときは1つの文言", () => {
    expect(page()).toContain("反響の受付の権限がありません");
    expect(page()).toMatch(/FORBIDDEN/);
  });
  it("読み込みの失敗を「業者がありません」に見せない", () => {
    expect(page()).toContain("読み込めませんでした");
    expect(page()).toContain("もう一度読む");
  });
  it("新しく登録は、探し終えてから・書ける人にだけ出す(二重登録を防ぐ)", () => {
    expect(page()).toContain("newAgentAction(");
    expect(page()).toMatch(/canWrite && createAction !== "none"/);
  });
  it("候補は今の検索語のものだけ", () => {
    expect(page()).toContain("hitsForQuery(");
  });
  it("権限表を自分で読まない(書けるかはサーバーの canWrite)", () => {
    expect(page()).not.toContain("useScreenProtection");
  });
  it("個人情報の保護の対象にする", () => {
    expect(page()).toMatch(/data-pii-protected data-pii-surface="dashboard"/);
  });
});
```

`src/lib/__tests__/agent-desk-routing.test.ts` の `describe` の中に追記:

```ts
  it("業者の名簿もログイン必須・全員に見える・メイン画面の中で開く(別窓にしない)", () => {
    expect(isPublicPath("/agents")).toBe(false);
    const item = SIDEBAR_GROUPS.flatMap((g) => g.items).find((i) => i.href === "/agents");
    expect(item).toMatchObject({ label: "業者の名簿", minRole: "field_staff" });
    expect(item?.external).toBeUndefined();
  });
```

`src/components/layout/__tests__/sidebar-reorg.test.ts` の「スマホの現場スタッフに出るメニュー」の期待値で、`"/inquiry-desk",` の次の行に `"/agents",` を足す(コメントに「+ 業者の名簿(反響の受付と同じく全員が使う・2026-09-30)」を1行足す)。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/components/agent-inquiry/__tests__/agent-directory.test.tsx src/lib/__tests__/agent-desk-routing.test.ts src/components/layout`
Expected: FAIL(モジュールが無い・メニューに `/agents` が無い)

- [ ] **Step 3: 実装**

```tsx
// src/components/agent-inquiry/agent-directory.tsx
import Link from "next/link";
import type { AgentDirectoryRow, AgentHit } from "@/lib/api-client";
import { agentLabel } from "@/lib/agent-inquiry/desk-form";
import { formatJstDate } from "@/lib/agent-inquiry/main-view";

const LIST = "divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900";
const ROW = "flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-indigo-50/40 dark:hover:bg-indigo-900/20";

/** 名簿の一覧(名前順)。支店名まで・代表電話・反響件数・最終日。押すと詳細。 */
export function AgentDirectoryRows({ rows }: { rows: AgentDirectoryRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-gray-500 dark:text-gray-400">業者がありません。</p>;
  return (
    <ul className={LIST}>
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`/agents/${r.id}`} className={ROW}>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">{agentLabel(r)}</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">代表 {r.phone}</span>
            </span>
            <span className="text-right text-xs text-gray-500 dark:text-gray-400">
              <span className="block">反響 {r.inquiryCount}件</span>
              <span className="block">{r.lastReceivedAt ? `最終 ${formatJstDate(r.lastReceivedAt)}` : "反響なし"}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** 検索の結果(代表電話・携帯・会社名)。しまった業者は出ない。 */
export function AgentSearchHits({ hits }: { hits: AgentHit[] }) {
  return (
    <ul className={LIST}>
      {hits.map((h) => (
        <li key={h.id}>
          <Link href={`/agents/${h.id}`} className={ROW}>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">{agentLabel(h)}</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                代表 {h.phone}
                {/* リンクの中の個人情報には自前の印を付ける(画面保護は押せる要素の中を外から見ない)。 */}
                {h.lastContact?.name && (
                  <span data-pii-protected="true" data-pii-surface="dashboard">{` ・ 前回 ${h.lastContact.name}様`}</span>
                )}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
```

```tsx
// src/app/(dashboard)/agents/page.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiErrorCode, fetchAgentDirectory, searchDeskAgents, type AgentDirectoryRow, type AgentHit } from "@/lib/api-client";
import { hitsForQuery, newAgentAction, splitNewAgentPhone, type SearchResult } from "@/lib/agent-inquiry/desk-form";
import { agentQueryReady } from "@/lib/agent-inquiry/agent-query";
import { PageHeader } from "@/components/ui/page-header";
import { SearchField } from "@/components/ui/search-field";
import { Tabs, tabPanelProps } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { AgentDirectoryRows, AgentSearchHits } from "@/components/agent-inquiry/agent-directory";
import { AgentCreateModal } from "@/components/agent-inquiry/agent-create-modal";

type Filter = "active" | "archived";
const FILTERS = [
  { key: "active", label: "名簿" },
  { key: "archived", label: "しまった業者" },
] as const;

/** 業者の名簿(設計 2026-09-28 §2.3)。電話帳型・会社の情報だけ。 */
export default function AgentsPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("active");
  const [rows, setRows] = useState<AgentDirectoryRow[]>([]);
  // rows がどの絞り込みで読んだ行か。今の絞り込みと違う間は出さない(タブを替えた直後に別のタブの行を見せない)。
  const [rowsFilter, setRowsFilter] = useState<Filter | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  // 書けるかどうかはサーバーが返す(画面で権限表を読まない)。分かるまでは出さない側。
  const [canWrite, setCanWrite] = useState(false);
  const [state, setState] = useState<"loading" | "ok" | "forbidden" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [res, setRes] = useState<SearchResult<AgentHit> | null>(null);
  const [creating, setCreating] = useState(false);
  // 一覧の世代(絞り込み・読み直しで進む)。もっと見るの応答が古い世代なら捨てる。
  const genRef = useRef(0);
  const moreRef = useRef(-1);

  useEffect(() => {
    genRef.current += 1;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchAgentDirectory({ archived: filter === "archived" });
        if (cancelled) return;
        setRows(r.agents);
        setCursor(r.nextCursor);
        setCanWrite(r.canWrite);
        setRowsFilter(filter);
        setState("ok");
      } catch (e) {
        if (cancelled) return;
        setCanWrite(false);
        setState(apiErrorCode(e) === "FORBIDDEN" ? "forbidden" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, reloadKey]);

  const loadMore = async () => {
    if (!cursor || moreRef.current === genRef.current) return;
    const gen = genRef.current;
    moreRef.current = gen;
    try {
      const r = await fetchAgentDirectory({ archived: filter === "archived", cursor });
      if (genRef.current !== gen) return;
      setRows((prev) => [...prev, ...r.agents]);
      setCursor(r.nextCursor);
    } catch (e) {
      if (genRef.current === gen) setState(apiErrorCode(e) === "FORBIDDEN" ? "forbidden" : "error");
    } finally {
      if (moreRef.current === gen) moreRef.current = -1;
    }
  };

  // 検索(代表電話・携帯・会社名)。打ち終わって 250ms 後に探す(受付の窓の業者の欄と同じ)。
  const searching = agentQueryReady(query);
  useEffect(() => {
    if (!searching) return;
    let stale = false;
    const t = setTimeout(() => {
      searchDeskAgents(query)
        .then((r) => {
          if (!stale) setRes({ query, hits: r.agents, failed: false });
        })
        .catch((e) => {
          if (stale) return;
          if (apiErrorCode(e) === "FORBIDDEN") setState("forbidden");
          else setRes({ query, hits: [], failed: true });
        });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, searching]);
  // 今の検索語の結果だけ出す(打ち直している間に前の候補を見せない)。
  const shown = hitsForQuery(res, query);
  // 探し終える前に「新しく登録」を出すと、名簿にある業者を二重に作れてしまう。
  const createAction = newAgentAction({ selected: false, searching, shown });

  return (
    // 検索の結果に問い合わせ者の名前(個人情報)が出るので画面保護の対象にする。
    <div data-pii-protected data-pii-surface="dashboard" className="mx-auto max-w-4xl">
      <PageHeader title="業者の名簿" description="反響をくれた不動産会社の電話帳です。会社名か電話番号で探せます。" />
      {state === "forbidden" ? (
        <p className="rounded-md bg-white p-6 text-center text-sm dark:bg-gray-900">
          反響の受付の権限がありません。管理者にお問い合わせください。
        </p>
      ) : (
        <div className="space-y-3">
          <SearchField
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="例: ○○不動産 / 0312345 / 09012"
            aria-label="業者を探す"
          />
          {searching ? (
            <div className="space-y-2">
              {shown == null && <p className="text-sm text-gray-500 dark:text-gray-400">探しています…</p>}
              {shown?.failed && <p className="text-sm text-rose-600 dark:text-rose-400">検索できませんでした(通信を確かめてください)。</p>}
              {shown && !shown.failed && shown.hits.length > 0 && <AgentSearchHits hits={shown.hits} />}
              {shown && !shown.failed && shown.hits.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  見つかりません(しまった業者は検索に出ません。「しまった業者」の一覧で探してください)。
                </p>
              )}
              {canWrite && createAction !== "none" && (
                <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
                  {createAction === "empty" ? "＋ 名簿にない業者を新しく登録" : "上の候補に無い(別の支店など)ときだけ、新しく登録"}
                </Button>
              )}
            </div>
          ) : (
            <>
              <Tabs idBase="agent-directory" tabs={FILTERS} active={filter} onChange={setFilter} />
              <div {...tabPanelProps("agent-directory", filter)} className="space-y-2">
                {state === "error" && (
                  <div role="alert" className="flex items-center justify-between gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-200">
                    <span>読み込めませんでした。</span>
                    <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                      もう一度読む
                    </Button>
                  </div>
                )}
                {state === "loading" || rowsFilter !== filter ? (
                  state !== "error" && <p className="text-sm text-gray-500 dark:text-gray-400">読み込み中…</p>
                ) : (
                  <AgentDirectoryRows rows={rows} />
                )}
                {rowsFilter === filter && cursor != null && (
                  <Button variant="secondary" className="w-full" onClick={() => void loadMore()}>
                    もっと見る
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {creating && (
        <AgentCreateModal
          // 電話番号らしい語で探していたら代表電話の欄へ(携帯は会社の代表電話には入れない)。
          initialPhone={splitNewAgentPhone(query).agentPhone}
          onClose={() => setCreating(false)}
          onCreated={(hit) => {
            setCreating(false);
            router.push(`/agents/${hit.id}`);
          }}
        />
      )}
    </div>
  );
}
```

`src/components/layout/sidebar-model.tsx` — lucide の import に `BookUser,` を足し、`home` グループの「反響の受付」の項目の次に足す:

```tsx
      // 業者の名簿(設計 2026-09-28 §2.3)。反響の受付と同じく全員が使う。こちらはメイン画面の中で開く。
      { label: "業者の名簿", href: "/agents", icon: ic(BookUser), minRole: "field_staff" },
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/components/agent-inquiry src/components/layout src/components/home src/lib/__tests__/agent-desk-routing.test.ts src/lib/__tests__/permission-freshness-pattern.test.ts && npx tsc --noEmit && npx eslint "src/app/(dashboard)/agents" src/components/agent-inquiry/agent-directory.tsx src/components/layout/sidebar-model.tsx`
Expected: PASS・tsc 0・eslint 0。`sidebar-page-title-parity.test.ts` の「/agents の題名が『業者の名簿』である」が通ること。`Tabs` の `tabs` の型が `readonly` の配列を受けない旨の型エラーが出たら、`FILTERS` の `as const` をやめて `const FILTERS: { key: Filter; label: string }[] = [...]` にする。

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/agents/page.tsx" src/components/agent-inquiry/agent-directory.tsx src/components/agent-inquiry/__tests__/agent-directory.test.tsx src/components/layout src/lib/__tests__/agent-desk-routing.test.ts
git commit -m "feat(agent-inquiry): 業者の名簿(一覧・検索・しまった業者)とメニュー"
```

---

### Task 8: 業者の名簿(詳細・編集・しまう/戻す・履歴)

**Files:**
- Create: `src/components/agent-inquiry/agent-detail.tsx`
- Create: `src/app/(dashboard)/agents/[id]/page.tsx`
- Test: `src/components/agent-inquiry/__tests__/agent-detail.test.tsx`

**Interfaces:**
- Consumes: `fetchAgentDetail`・`updateAgent`・`apiErrorCode`・型 `AgentDetail`・`AgentHistoryItem`(api-client)/`AGENT_EDIT_FIELDS`・`agentFieldValue`・`agentEditError`・`agentEditPatch`・`formatJstFull`・型 `AgentEdits`・`AgentEditKey`(Task 3)/`KIND_LABEL`・`STATUS_LABEL`・`agentLabel`・`isAmbiguousSaveError`(desk-form)/`formatPhoneJp`・`isValidPhoneJp`(`@/lib/phone-format-jp`)/`notifyInquiryChanged`(Task 4)
- Produces: `AgentInfoFields({ agent, edits, canWrite, saving, onEdit, onBlurPhone })`・`AgentHistoryList({ items })`・`agentSaveErrorMessage(e: unknown): string`/画面 `/agents/[id]`

- [ ] **Step 1: 失敗するテスト**

```tsx
// src/components/agent-inquiry/__tests__/agent-detail.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDetail, AgentHistoryItem } from "@/lib/api-client";
import { AgentInfoFields, AgentHistoryList, agentSaveErrorMessage } from "../agent-detail";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const agent: AgentDetail = {
  id: "a1", companyName: "○○不動産", companyKana: null, branchName: "新宿支店", licenseNo: "東京都知事(3)第12345号",
  phone: "03-1234-5678", fax: null, email: null, address: null, note: "午前は不在", isArchived: false, version: 4,
};
const fields = (p: Partial<Parameters<typeof AgentInfoFields>[0]> = {}) =>
  renderToStaticMarkup(
    <AgentInfoFields agent={agent} edits={{}} canWrite saving={false} onEdit={() => {}} onBlurPhone={() => {}} {...p} />,
  );

describe("業者の詳細の会社情報", () => {
  it("書ける人には9つの欄を入力できる形で出す", () => {
    const out = fields();
    expect((out.match(/<input/g) ?? []).length + (out.match(/<textarea/g) ?? []).length).toBe(9);
    expect(out).toContain('value="○○不動産"');
    expect(out).toContain("午前は不在");
  });
  it("触った欄は打ちかけの値を出す(読み直しても消えない)", () => {
    expect(fields({ edits: { branchName: "渋谷支店" } })).toContain('value="渋谷支店"');
  });
  it("★書けない人には入力欄を出さず、文字で見せる", () => {
    const out = fields({ canWrite: false });
    expect(out).not.toMatch(/<input|<textarea/);
    expect(out).toContain("○○不動産");
    expect(out).toContain("東京都知事(3)第12345号");
  });
  it("保存中は欄を止める(保存は押したときの値で進む)", () => {
    expect(fields({ saving: true })).toMatch(/<fieldset[^>]*disabled=""/);
  });
  it("電話の桁がおかしければ黄色で知らせる(保存は止めない)", () => {
    expect(fields({ edits: { phone: "03-12" } })).toContain("電話番号の桁をご確認ください(このままでも保存できます)");
  });
});

describe("その業者からの反響", () => {
  const items: AgentHistoryItem[] = [
    { id: "q1", kind: "viewing", status: "done", receivedAt: "2026-09-29T01:00:00.000Z", contactName: "田中", property: { id: "p1", name: "サンライズ", roomNo: "305", town: "新宿区西新宿", propertyType: "unit", adPermissions: {} } },
  ];
  it("年つきの日時・用件・状態・物件(部屋まで)・町名・問い合わせ者", () => {
    const out = renderToStaticMarkup(<AgentHistoryList items={items} />);
    expect(out).toContain("2026/9/29(火) 10:00");
    expect(out).toContain("内見");
    expect(out).toContain("対応済み");
    expect(out).toContain("サンライズ 305");
    expect(out).toContain("新宿区西新宿");
    expect(out).toContain("田中様");
  });
  it("0件のとき", () => {
    expect(renderToStaticMarkup(<AgentHistoryList items={[]} />)).toContain("この業者からの反響はまだありません");
  });
});

describe("保存の失敗の文言", () => {
  const err = (code: string, status: number) => Object.assign(new Error("x"), { code, status });
  it("409・403・入力の誤り・通信切れを言い分ける", () => {
    expect(agentSaveErrorMessage(err("VERSION_CONFLICT", 409))).toBe("他の人が先に更新しました。最新の内容を読み直しました。内容を確かめて、もう一度保存してください。");
    expect(agentSaveErrorMessage(err("FORBIDDEN", 403))).toBe("業者を変更する権限がありません。");
    expect(agentSaveErrorMessage(err("VALIDATION_ERROR", 422))).toBe("入力を確かめてください(メールの形式・文字数など)。");
    expect(agentSaveErrorMessage(new Error("Failed to fetch"))).toBe("保存できたか分かりません(通信が切れました)。最新の内容を読み直しました。変わっていれば押し直さないでください。");
  });
});

describe("詳細の画面", () => {
  const page = () => read("src/app/(dashboard)/agents/[id]/page.tsx");
  it("業者ごとに作り直す(前の業者の打ちかけを持ち越さない)", () => {
    expect(page()).toMatch(/<AgentDetailBody key=\{id\} id=\{id\} \/>/);
  });
  it("★保存で送るのは触った欄だけ・版番号つき", () => {
    expect(page()).toContain("agentEditPatch(agent, edits)");
    expect(page()).toMatch(/send\(\{ version: agent\.version, \.\.\.patch \}/);
    expect(page()).toContain("updateAgent(agent.id, body)");
  });
  it("しまう前に確かめ、戻すのは1回で", () => {
    expect(page()).toContain("<ConfirmDialog");
    expect(page()).toContain("名簿に戻す");
  });
  it("書く操作(保存・しまう・戻す)は書ける人にだけ出す", () => {
    expect(page()).toMatch(/\{canWrite && \(/);
  });
  it("名簿へ戻る導線", () => {
    expect(page()).toMatch(/back=\{\{ href: "\/agents", to: "業者の名簿" \}\}/);
  });
  it("権限表を自分で読まない", () => {
    expect(page()).not.toContain("useScreenProtection");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/components/agent-inquiry/__tests__/agent-detail.test.tsx`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装**

```tsx
// src/components/agent-inquiry/agent-detail.tsx
import { apiErrorCode, type AgentDetail, type AgentHistoryItem } from "@/lib/api-client";
import { KIND_LABEL, STATUS_LABEL, isAmbiguousSaveError } from "@/lib/agent-inquiry/desk-form";
import { AGENT_EDIT_FIELDS, agentFieldValue, formatJstFull, type AgentEditKey, type AgentEdits } from "@/lib/agent-inquiry/main-view";
import { isValidPhoneJp } from "@/lib/phone-format-jp";

const inputCls =
  "mt-0.5 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

/** 業者の保存(編集・しまう・戻す)に失敗したときの文言。 */
export function agentSaveErrorMessage(e: unknown): string {
  const code = apiErrorCode(e);
  if (code === "VERSION_CONFLICT") return "他の人が先に更新しました。最新の内容を読み直しました。内容を確かめて、もう一度保存してください。";
  if (code === "FORBIDDEN") return "業者を変更する権限がありません。";
  if (code === "VALIDATION_ERROR") return "入力を確かめてください(メールの形式・文字数など)。";
  if (isAmbiguousSaveError(e)) return "保存できたか分かりません(通信が切れました)。最新の内容を読み直しました。変わっていれば押し直さないでください。";
  return e instanceof Error && e.message ? e.message : "保存できませんでした。";
}

/** 会社情報の欄。書ける人=入力欄(触った欄は打ちかけの値)/書けない人=文字。 */
export function AgentInfoFields({
  agent,
  edits,
  canWrite,
  saving,
  onEdit,
  onBlurPhone,
}: {
  agent: AgentDetail;
  edits: AgentEdits;
  canWrite: boolean;
  saving: boolean;
  onEdit: (key: AgentEditKey, value: string) => void;
  onBlurPhone: (key: AgentEditKey) => void;
}) {
  if (!canWrite) {
    return (
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {AGENT_EDIT_FIELDS.map((f) => (
          <div key={f.key} className={"multiline" in f ? "sm:col-span-2" : ""}>
            <dt className="text-xs text-gray-500 dark:text-gray-400">{f.label.replace("(必須)", "")}</dt>
            <dd className="whitespace-pre-wrap text-gray-900 dark:text-gray-100">{agent[f.key] || "—"}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    // 保存中は欄も打てない(保存は押したときの値で進むので、その後の直しは届かず黙って消える)。
    <fieldset disabled={saving} className="m-0 grid min-w-0 gap-x-6 gap-y-2 border-0 p-0 sm:grid-cols-2">
      {AGENT_EDIT_FIELDS.map((f) => {
        const value = agentFieldValue(agent, edits, f.key);
        const isPhone = "phone" in f;
        return (
          <label key={f.key} className={`block text-sm${"multiline" in f ? " sm:col-span-2" : ""}`}>
            <span className="text-xs text-gray-500 dark:text-gray-400">{f.label}</span>
            {"multiline" in f ? (
              <textarea value={value} onChange={(e) => onEdit(f.key, e.target.value)} rows={3} className={inputCls} />
            ) : (
              <input
                value={value}
                onChange={(e) => onEdit(f.key, e.target.value)}
                onBlur={isPhone ? () => onBlurPhone(f.key) : undefined}
                inputMode={isPhone ? "tel" : undefined}
                className={inputCls}
              />
            )}
            {isPhone && value.trim() !== "" && !isValidPhoneJp(value) && (
              <span className="text-[11px] text-amber-700 dark:text-amber-300">
                電話番号の桁をご確認ください(このままでも保存できます)
              </span>
            )}
          </label>
        );
      })}
    </fieldset>
  );
}

/** その業者からの反響(新しい順)。物件は許可リストの形(物件名・部屋・町名まで)。 */
export function AgentHistoryList({ items }: { items: AgentHistoryItem[] }) {
  if (items.length === 0) return <p className="text-sm text-gray-500 dark:text-gray-400">この業者からの反響はまだありません。</p>;
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
      {items.map((q) => (
        <li key={q.id} className="py-2 text-sm">
          <span className="mr-2 text-xs text-gray-500 dark:text-gray-400">{formatJstFull(q.receivedAt)}</span>
          <span className="mr-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-gray-800">{KIND_LABEL[q.kind]}</span>
          <span className="mr-2 text-xs text-gray-500 dark:text-gray-400">{STATUS_LABEL[q.status]}</span>
          <span className="font-medium">{q.property.roomNo ? `${q.property.name} ${q.property.roomNo}` : q.property.name}</span>
          <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">{q.property.town}</span>
          {q.contactName && <span className="ml-2">{`${q.contactName}様`}</span>}
        </li>
      ))}
    </ul>
  );
}
```

```tsx
// src/app/(dashboard)/agents/[id]/page.tsx
"use client";

import { use, useEffect, useRef, useState } from "react";
import { apiErrorCode, fetchAgentDetail, updateAgent, type AgentDetail, type AgentHistoryItem } from "@/lib/api-client";
import { agentLabel } from "@/lib/agent-inquiry/desk-form";
import { agentEditError, agentEditPatch, agentFieldValue, type AgentEditKey, type AgentEdits } from "@/lib/agent-inquiry/main-view";
import { notifyInquiryChanged } from "@/lib/agent-inquiry/desk-sync";
import { formatPhoneJp } from "@/lib/phone-format-jp";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AgentHistoryList, AgentInfoFields, agentSaveErrorMessage } from "@/components/agent-inquiry/agent-detail";

type LoadState = "loading" | "ok" | "forbidden" | "notfound" | "error";

function AgentDetailBody({ id }: { id: string }) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [history, setHistory] = useState<AgentHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  // 書けるかどうかはサーバーが返す。分かるまでは出さない側。
  const [canWrite, setCanWrite] = useState(false);
  const [state, setState] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  // 触った欄だけ(触っていない欄は最新の値を出す=読み直しても、他の人の直しを古い値で上書きしない)。
  const [edits, setEdits] = useState<AgentEdits>({});
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const moreRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchAgentDetail(id);
        if (cancelled) return;
        setAgent(r.agent);
        setHistory(r.inquiries);
        setCursor(r.nextCursor);
        setCanWrite(r.canWrite);
        setState("ok");
      } catch (e) {
        if (cancelled) return;
        const code = apiErrorCode(e);
        setCanWrite(false);
        setState(code === "FORBIDDEN" ? "forbidden" : code === "NOT_FOUND" ? "notfound" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  /** 保存・しまう・戻すの共通の流れ。成功したら読み直し、失敗は言い分ける。 */
  const send = async (body: Parameters<typeof updateAgent>[1], okText: string, onOk: () => void) => {
    if (!agent || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setNotice(null);
    try {
      await updateAgent(agent.id, body);
      onOk();
      setNotice({ tone: "ok", text: okText });
      // 受付の窓の業者の検索(しまった業者は出ない・商号)が変わるので知らせる。
      notifyInquiryChanged();
    } catch (e) {
      setNotice({ tone: "error", text: agentSaveErrorMessage(e) });
    }
    // 成功でも失敗でも読み直す(版番号・書けるかどうか・保存できたか分からないときの本当の値)。
    reload();
    savingRef.current = false;
    setSaving(false);
  };

  const save = () => {
    if (!agent) return;
    const err = agentEditError(agent, edits);
    if (err) {
      setNotice({ tone: "error", text: err });
      return;
    }
    const patch = agentEditPatch(agent, edits);
    if (!patch) {
      setEdits({});
      setNotice({ tone: "ok", text: "変更はありません。" });
      return;
    }
    void send({ version: agent.version, ...patch }, "保存しました。", () => setEdits({}));
  };

  const loadMore = async () => {
    if (!cursor || moreRef.current) return;
    moreRef.current = true;
    try {
      const r = await fetchAgentDetail(id, cursor);
      setHistory((prev) => [...prev, ...r.inquiries]);
      setCursor(r.nextCursor);
    } catch {
      setNotice({ tone: "error", text: "反響の続きを読み込めませんでした。" });
    } finally {
      moreRef.current = false;
    }
  };

  if (state === "loading" && !agent) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">読み込み中…</p>;
  }
  if (state === "forbidden" || state === "notfound" || (state === "error" && !agent)) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="業者" back={{ href: "/agents", to: "業者の名簿" }} />
        <div className="rounded-md bg-white p-6 text-center text-sm dark:bg-gray-900">
          <p className="mb-2">
            {state === "forbidden"
              ? "反響の受付の権限がありません。管理者にお問い合わせください。"
              : state === "notfound"
                ? "業者が見つかりません。"
                : "読み込めませんでした。"}
          </p>
          {state === "error" && (
            <Button variant="secondary" size="sm" onClick={reload}>
              もう一度読む
            </Button>
          )}
        </div>
      </div>
    );
  }
  if (!agent) return null;

  return (
    // 反響の履歴に問い合わせ者の名前(個人情報)が出るので画面保護の対象にする。
    <div data-pii-protected data-pii-surface="dashboard" className="mx-auto max-w-4xl">
      <PageHeader
        title={agentLabel(agent)}
        description={agent.isArchived ? "しまった業者です(受付の窓の検索には出ません)。" : undefined}
        back={{ href: "/agents", to: "業者の名簿" }}
      />
      {state === "error" && (
        <p role="alert" className="mb-3 text-sm text-rose-600 dark:text-rose-400">
          読み直せませんでした(下の表示は最新ではないかもしれません)。
        </p>
      )}
      <section className="mb-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">会社の情報</h2>
        <AgentInfoFields
          agent={agent}
          edits={edits}
          canWrite={canWrite}
          saving={saving}
          onEdit={(key, value) => setEdits((p) => ({ ...p, [key]: value }))}
          onBlurPhone={(key: AgentEditKey) =>
            setEdits((p) => (p[key] === undefined ? p : { ...p, [key]: formatPhoneJp(agentFieldValue(agent, p, key)).value }))
          }
        />
        {notice && (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={`mt-3 text-sm ${notice.tone === "error" ? "text-rose-600 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-300"}`}
          >
            {notice.text}
          </p>
        )}
        {canWrite && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {agent.isArchived ? (
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => void send({ version: agent.version, isArchived: false }, "名簿に戻しました。", () => {})}
              >
                名簿に戻す
              </Button>
            ) : (
              <Button variant="secondary" disabled={saving} onClick={() => setConfirmArchive(true)}>
                しまう
              </Button>
            )}
            <Button disabled={saving} onClick={save}>
              {saving ? "保存中…" : "保存する"}
            </Button>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">この業者からの反響(新しい順)</h2>
        <AgentHistoryList items={history} />
        {cursor != null && (
          <Button variant="secondary" className="mt-2 w-full" onClick={() => void loadMore()}>
            もっと見る
          </Button>
        )}
      </section>

      {confirmArchive && (
        <ConfirmDialog
          title="この業者をしまいますか?"
          message="しまうと、受付の窓の業者の検索に出なくなります。これまでの反響は残り、「しまった業者」の一覧からいつでも戻せます。"
          confirmLabel="しまう"
          busy={saving}
          onCancel={() => setConfirmArchive(false)}
          onConfirm={() => {
            setConfirmArchive(false);
            void send({ version: agent.version, isArchived: true }, "しまいました。", () => {});
          }}
        />
      )}
    </div>
  );
}

/** 業者の詳細(設計 2026-09-28 §2.3)。会社情報の編集・しまう/戻す・その業者からの反響。 */
export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // 業者ごとに作り直す=前の業者の打ちかけ・履歴を持ち越さない。
  return <AgentDetailBody key={id} id={id} />;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/components/agent-inquiry src/components/layout src/lib/__tests__/permission-freshness-pattern.test.ts && npx tsc --noEmit && npx eslint "src/app/(dashboard)/agents" src/components/agent-inquiry/agent-detail.tsx`
Expected: PASS・tsc 0・eslint 0。`agent[f.key] || "—"` の型で `isArchived`/`version` が混ざる旨のエラーが出たら、`AGENT_EDIT_FIELDS` の `key` が文字列の欄だけ(Task 3 の9つ)であることを確かめる。

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/agents/[id]/page.tsx" src/components/agent-inquiry/agent-detail.tsx src/components/agent-inquiry/__tests__/agent-detail.test.tsx
git commit -m "feat(agent-inquiry): 業者の詳細(会社情報の編集・しまう/戻す・その業者からの反響)"
```

---

### Task 9: 全ゲート・実ブラウザ確認・レビュー・PR

- [ ] **Step 1: 全ゲート**(⚠テストは終了コードで判定し、通ったときだけ次へ)
```bash
npx tsc --noEmit
npx vitest run > /tmp/aim-full.log 2>&1; echo "exit=$?"; tail -6 /tmp/aim-full.log
npx eslint "src/app/(dashboard)/agents" "src/app/(dashboard)/properties/[id]/page.tsx" "src/app/(desk)" src/app/api/agents src/components/agent-inquiry src/components/properties/agent-inquiry-tab.tsx src/components/home src/components/layout src/lib/agent-inquiry src/lib/api-client.ts
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build   # route 一覧に /agents と /agents/[id]
git diff --stat origin/main | grep -i " Bin " || true   # 制御文字の混入が無いこと
```

- [ ] **Step 2: 実ブラウザ確認**(共用の開発DBに触れない=使い捨てDB `pm_agent_main_check` を作って migrate+seed。devサーバはこの worktree から `DATABASE_URL=… NEXTAUTH_URL=http://localhost:3100 PORT=3100 npm run dev`。手順は前段と同じ・メモリ `local-dev-env-setup`)。Playwright(`chromium.launch({channel:'chrome'})`)で:
  1. 管理者でログイン → ホームに「未対応の反響 0件」「今日・明日の内見 0件」
  2. ホームの件数を押す → `pm-inquiry-desk` の窓で受付の窓が開く。もう一度押しても窓が増えない
  3. 受付の窓で 新しい業者+物件+内見(案内・明日の日時)を登録 → **メイン画面を触らずに**ホームの件数が 1件/1件 になる
  4. 物件画面の「反響」タブ: 反響 1件・案内 1・時系列に業者名と「案内」が年つきの日時で出る
  5. 広告の可否の SUUMO を押す → ○。続けて押す → ×→△→—。読み直しても残る
  6. 別タブで同じ物件の SUUMO を先に変えてから、元のタブで押す → 「他の人が先に変えました」・表示は相手の値になる
  7. 受付の窓の詳細「メイン画面で物件を開く」→ 新しい窓ではなく**元のメイン画面**に開く
  8. メニュー「業者の名簿」→ 登録した業者が 反響 1件・最終日つきで出る。会社名・電話 7桁で探せる
  9. 詳細で支店名を直して保存 → 「保存しました」・一覧に反映。別タブで先に直してから保存 → 409 の文言・触っていない欄が相手の値になっている
  10. 「しまう」→ 確認 → 名簿から消え「しまった業者」に出る・受付の窓の業者の検索に出ない → 「名簿に戻す」で戻る
  11. 現地スタッフでログイン → 担当外の物件の URL を直接開いても物件画面は今まで通り開けない。名簿は見える・編集できる(既定で write あり)
  12. `agent_inquiry` の権限を外した利用者 → ホームに件数が出ない・`/agents` は「反響の受付の権限がありません」
  13. write だけ外した利用者 → 名簿の詳細が文字の表示になり、保存・しまうが出ない
  14. スマホ幅(390px)で 反響タブ・名簿・詳細 が横にはみ出さない
  スクリーンショットを scratchpad に残し、使い捨てDBを消す。

- [ ] **Step 3: 提出前レビュー** — `git add -A` の後、`feature-dev:code-reviewer` に staged diff を渡す。ホットスポット: 広告の可否の連打と 409(押した値が残らないか)/名簿の編集で触っていない欄を送っていないか/書く操作が `canWrite` のときだけか/合図に個人情報が載っていないか/名前付きの窓に noopener が付いていないか/effect 内の setState/古い読み込みが新しい表示を上書きしないか/スマホ幅。

- [ ] **Step 4: push・PR・@codex**(PR 本文は平易な日本語で Summary/できるようになること/設計書から変えた点/テスト/セキュリティ・末尾に Generated with 行とセッション URL)。PR 作成直後に**到着監視を Monitor で張る**(inline/issue/reviews の3系統+CI=`gh run list --branch feat/agent-inquiry-main --limit 1 --json conclusion`)。指摘の仕分けは codex-triage。修正は新しい commit → push → 自分で `@codex review`。マージは発注者。

- [ ] **Step 5: メモリ更新** — `next-epic-agent-inquiry-management.md` に PR 番号・状態・この計画で決めたこと(積み残しを別 PR に分けた)。`MEMORY.md` の該当1行を更新。

---

## この PR でやらないこと(次の候補)

- **受付の窓の仕上げ(次の PR)**: Enter で送信されない(または意図どおり送る)ようにする/日付だけ・時刻だけのヒント/切り替えボタンの読み上げ(aria-pressed)/詳細の読み込み中の表示/**二重登録を防ぐ鍵**(反響・業者の登録に1回きりの合言葉を付ける=**表に列を足す migration が要る→発注者の承認が先**)/対応済みタブの期間の絞り込み(API に日付の条件を足す)/アプリ全体の小窓の透かし漏れ(既存)。
- 時系列・履歴から「その反響を受付の窓で開く」。
- メイン画面で広告の可否を変えたとき、受付の窓で**すでに選んである物件**の表示をその場で更新する(今は物件を選び直すと最新になる)。
- メイン画面から受付の窓を開くと、窓が読み直されて**打ちかけの登録が消える**(第2段からの既存の動き)。離れる前の確認は、無操作の自動ログアウトを止めてしまうので入れていない。
- 使い方ガイド・取り扱いマニュアルへの追記(マージ・本番反映の後に別の docs PR)。
