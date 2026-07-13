# 売却DM 対象選択の強化 — 設計

- 日付: 2026-07-13
- スコープ: 売却促進DMの「対象の選び方」を3点強化。**データ列の追加なし**（送信回数は既存DM履歴を集計）。性能のため `PropertyDmLog` に `propertyId` 索引を1本だけ追加（@codex R3・ユーザー承認・追加のみ）。
- @codex 対応で当初設計から変わった主点: (a) 50件上限は撤廃せず**維持**（同期生成の安全上・R1/R4）(b) 選択経路は no_send を除外（R2）(c) 送信回数集計は全体で数え notIn 除外＋索引（R2/R3）。
- 前提: 既存の売却DM機能（作成→A/B型→確定→印刷）はそのまま。UI簡素化（かんたん作成ウィザード）は今回スコープ外。

## 機能1: チェックした物件から作成

物件一覧には既にチェックボックス（一括操作用 `selectedIds`）がある。今の「売却DMを作成」は絞り込み条件（`filters`）で対象を決めているのを、**チェックした物件**基準に置き換える。

- `validators-sale-dm.ts`: `saleDmCampaignBodySchema` に `propertyIds: z.array(z.string().uuid()).min(1).max(2000).optional()` を追加（`max(2000)` は絶対URL/巨大ペイロードと同様の安全上限。実用の上限ではない）。
- `campaigns/route.ts`: `body.propertyIds` があればそれを対象にする。
  - `where` = field_staff 可視スコープ（`propertyVisibilityScopeWhere`）＋ `id: { in: propertyIds }` ＋ `isArchived: false` ＋ 既存と同じ「所有者に住所あり」。
  - `dmStatus` は send/hold(未判断)は対象にするが **no_send(送付不可＝オプトアウト)は除外**（誤って全選択で送らない・@codex R2）。`propertyIds` 未指定時は従来どおり `filters` パス（`dmStatus=send` 強制）を維持＝後方互換。
  - 宛先を作れない物件（住所なし／権限外／アーカイブ済）は結果的に対象から外れる。`requested`（選択数）と `generated`（実生成数）の差は既存の監査 detail に載る。
- `page.tsx`: `handleCreateSaleDm` は `filters` の代わりに `propertyIds: Array.from(selectedIds)` を送る。ボタンは `selectedIds.size === 0` で無効。ラベルに件数（例:「売却DMを作成（12件）」）。

## 機能2: 件数確認 + 1回の生成は50件まで維持

当初は「50件上限の撤廃」を検討したが、同期生成のため大量一括はタイムアウト/冪等失効による二重課金リスクがある（@codex R1/R4）。ユーザー判断で **1回の生成は `MAX_GENERATE_ITEMS`(=50)件までを維持**。超過分は `truncated` で「先頭50件のみ生成・残りは別途」と通知。真の無制限はバックグラウンド生成（別機能）が前提。

- `campaigns/route.ts`: 両経路とも `generateLetters({ max: MAX_GENERATE_ITEMS })` で50件に切詰。`propertyIds`（明示選択）経路は `take` せず全件取得して「対象外(住所なし/送付不可等)」件数を正確に数える（`filters` 経路は該当多数になり得るので `take: MAX_GENERATE_ITEMS + 1`）。
- `page.tsx`: 作成前 `window.confirm` に選択件数を明示（AI料金・オーナー情報の外部送信の同意）。共有者が別住所の物件は手紙数>物件数になるため「◯件の物件（共有者ぶんで複数通になる場合あり）」と表現し、除外通知は物件数（`matchedProperties`）で数える。

## 機能3: DM送信回数で並べ替え＋抽出

送信回数 = 物件ごとの `PropertyDmLog` 件数（`Property.dmLogs`）。**データ列は足さず**（集計高速化のため `propertyId` 索引は1本追加）ソート・フィルタする。

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

- 新規依存なし。migration は `propertyId` 索引の追加1本のみ（追加のみ・データ無変更・@codex R3 + ユーザー承認）。
- 大量選択時の課金は「件数確認」で担保（本番Claude時）。今は mock で無料。
- UI 簡素化（ウィザード等）は別途。
