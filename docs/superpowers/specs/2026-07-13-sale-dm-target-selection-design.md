# 売却DM 対象選択の強化 — 設計

- 日付: 2026-07-13
- スコープ: 売却促進DMの「対象の選び方」を3点強化。**DB変更なし（コードのみ）**。
- 前提: 既存の売却DM機能（作成→A/B型→確定→印刷）はそのまま。UI簡素化（かんたん作成ウィザード）は今回スコープ外。

## 機能1: チェックした物件から作成

物件一覧には既にチェックボックス（一括操作用 `selectedIds`）がある。今の「売却DMを作成」は絞り込み条件（`filters`）で対象を決めているのを、**チェックした物件**基準に置き換える。

- `validators-sale-dm.ts`: `saleDmCampaignBodySchema` に `propertyIds: z.array(z.string().uuid()).min(1).max(2000).optional()` を追加（`max(2000)` は絶対URL/巨大ペイロードと同様の安全上限。実用の上限ではない）。
- `campaigns/route.ts`: `body.propertyIds` があればそれを対象にする。
  - `where` = field_staff 可視スコープ（`propertyVisibilityScopeWhere`）＋ `id: { in: propertyIds }` ＋ `isArchived: false` ＋ 既存と同じ「所有者に住所あり」。
  - **`dmStatus="send"` の強制はしない**（明示選択したものが対象＝ユーザーの意図）。`propertyIds` 未指定時は従来どおり `filters` パス（`dmStatus=send` 強制）を維持＝後方互換。
  - 宛先を作れない物件（住所なし／権限外／アーカイブ済）は結果的に対象から外れる。`requested`（選択数）と `generated`（実生成数）の差は既存の監査 detail に載る。
- `page.tsx`: `handleCreateSaleDm` は `filters` の代わりに `propertyIds: Array.from(selectedIds)` を送る。ボタンは `selectedIds.size === 0` で無効。ラベルに件数（例:「売却DMを作成（12件）」）。

## 機能2: 50件上限の撤廃＋件数確認

- `sale-dm-letter/index.ts`: `generateLetters` の既定 `max` を無制限（`Number.POSITIVE_INFINITY`）に。`truncated` は常に false（フィールドは後方互換で残す）。`MAX_GENERATE_ITEMS` export は残すが既定の切り詰めには使わない。
- `campaigns/route.ts`: **`propertyIds`（明示選択）経路のみ**上限なしにする（配列上限=2000 が実質のガード）。**従来の `filters` 経路（`propertyIds` 無し）は上限を維持**（`take: MAX_GENERATE_ITEMS + 1` と `generateLetters({ max: MAX_GENERATE_ITEMS })`）＝`filters:{}` の1リクエストで数千通の課金/PII送信になるのを防ぐ（無制限にするには `propertyIds` を必須にする）。
- `page.tsx`: 作成前 `window.confirm` に**件数**を明示：「選択した ◯件 にAIで手紙を生成します（◯通）。AI料金が発生し、オーナー情報がAI提供元へ送信されます。続けますか？」。上限撤廃後、この件数確認が唯一の歯止め。

## 機能3: DM送信回数で並べ替え＋抽出

送信回数 = 物件ごとの `PropertyDmLog` 件数（`Property.dmLogs`）。**列追加なし**でソート・フィルタする。

- `validators.ts`（`propertyListQuerySchema`）: `sortBy` の enum に `dmSendCount` を追加。`dmSentMax: z.coerce.number().int().min(0).optional()` を追加（「N回以下」）。
- `property-list-query.ts`:
  - `buildPropertyListOrderBy`: `sortBy === "dmSendCount"` のとき `{ dmLogs: { _count: sortOrder } }`（Prisma のリレーション件数ソート）。それ以外は従来どおり `{ [sortBy]: sortOrder }`。
  - `buildPropertyListWhere`: `dmSentMax` 指定時、
    - `dmSentMax === 0` → `where.AND.push({ dmLogs: { none: {} } })`（未送信のみ・ネイティブで効率的）。
    - `dmSentMax >= 1` → `propertyDmLog.groupBy({ by:['propertyId'], _count:{propertyId:true}, having:{ propertyId:{ _count:{ gt: dmSentMax } } } })` で「N回超」の propertyId を取得し `where.AND.push({ id: { notIn: overIds } })`（0件なら追加しない）。field_staff スコープは主クエリの where で別途 AND 済み＝可視範囲は保たれる。
- `api/properties/route.ts`: 一覧 findMany の select に `_count: { select: { dmLogs: true } }` を追加し、行に送信回数を返す（並べ替え/抽出の対象を目視できるように）。
- `page.tsx`:
  - 並べ替えドロップダウンに「送信回数（少ない順）」「送信回数（多い順）」を追加（`sort` = `dmSendCount:asc` / `dmSendCount:desc`）。
  - 「送信回数」フィルタ（select: 指定なし / 0回（未送信）/ 1回以下 / 2回以下 / 3回以下 → `dmSentMax`）。`buildFilterParams` に `dmSentMax` を追加。
  - 各行に「送信◯回」を小さく表示。

## テスト

- 機能1: route の `propertyIds` パス（選択物件のみ生成／権限外・住所なしは除外／field_staff スコープ）。page のボタン無効化・確認文言（source wiring）。
- 機能2: `generateLetters` が既定で切り詰めない（51件以上でも全生成・`truncated=false`）。route が take 無しで全件対象。
- 機能3: `buildPropertyListOrderBy` の `dmSendCount` 分岐。`buildPropertyListWhere` の `dmSentMax`（0=none / N=notIn）。list route の `_count` 返却。
- 全ゲート（tsc / 全 vitest / eslint / build）緑。

## 非スコープ / 前提

- DB migration なし・新規依存なし。
- 大量選択時の課金は「件数確認」で担保（本番Claude時）。今は mock で無料。
- UI 簡素化（ウィザード等）は別途。
