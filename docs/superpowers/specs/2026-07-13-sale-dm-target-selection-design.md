# 売却DM 対象選択の強化 — 設計

- 日付: 2026-07-13
- スコープ: 売却促進DMの「対象の選び方」を3点強化。**データ列の追加なし**（送信回数は既存DM履歴を集計）。性能のため `PropertyDmLog` に `propertyId` 索引を1本だけ追加（@codex R3・ユーザー承認・追加のみ）。
- @codex 対応で当初設計から変わった主点: (a) 1回の生成は**50物件まで**（配列上限=50・選択物件は全宛先生成で50通の境界に分断しない・`filters` は50通で切詰／R1/R4/R8）(b) 選択経路は送付可(send)のみ対象＝hold/no_send 除外（R2/R6）(c) 送信回数集計は全体で数え notIn 除外＋索引（R2/R3）(d) 選択は表示中の物件に intersect（stale 送信防止・R7）。
- 前提: 既存の売却DM機能（作成→A/B型→確定→印刷）はそのまま。UI簡素化（かんたん作成ウィザード）は今回スコープ外。

## 機能1: チェックした物件から作成

物件一覧には既にチェックボックス（一括操作用 `selectedIds`）がある。今の「売却DMを作成」は絞り込み条件（`filters`）で対象を決めているのを、**チェックした物件**基準に置き換える。

- `validators-sale-dm.ts`: `saleDmCampaignBodySchema` に `propertyIds: z.array(z.string().uuid()).min(1).max(50).optional()` を追加（1回の生成上限 `MAX_GENERATE_ITEMS`(=50)物件と一致。51件以上は 422 で弾く＝切り詰め/物件分断を起こさない・@codex R8）。
- `campaigns/route.ts`: `body.propertyIds` があればそれを対象にする。
  - `where` = field_staff 可視スコープ（`propertyVisibilityScopeWhere`）＋ `id: { in: propertyIds }` ＋ `isArchived: false` ＋ 既存と同じ「所有者に住所あり」。
  - DM は **送付可(send)の物件にのみ生成**（hold/no_send は除外・`filters` 経路と同じ不変条件＝アプリのDMモデル）。一覧は全ステータス表示ゆえ、未判断/送付不可をうっかり選んでも送らない（@codex R2/R6）。`propertyIds` 未指定時は従来どおり `filters` パス（`dmStatus=send` 強制）＝後方互換。
  - 宛先を作れない物件（住所なし／権限外／アーカイブ済）は結果的に対象から外れる。`requested`（選択数）と `generated`（実生成数）の差は既存の監査 detail に載る。
- `page.tsx`: `handleCreateSaleDm` は `filters` の代わりに `propertyIds: Array.from(selectedIds)` を送る。ボタンは `selectedIds.size === 0` で無効。ラベルに件数（例:「売却DMを作成（12件）」）。

## 機能2: 件数確認 + 1回の生成は50物件まで

当初は「50件上限の撤廃」を検討したが、同期生成のため大量一括はタイムアウト/冪等失効による二重課金リスクがある（@codex R1/R4）。ユーザー判断で **1回の生成は50物件まで**。単位は「物件」で統一する（@codex R8: 手紙数で切ると共有者の多い物件が途中で分断される）:

- **選択（`propertyIds`）経路**: 配列上限=50物件で件数が閉じる。選んだ物件の宛先は共有者ぶんも含め **letter cap 無しで全て生成**（`generateLetters` に `max` を渡さない）＝物件を50通の境界で分断せず `truncated` も出さない。`take` もせず全件取得して「対象外(住所なし/送付可でない等)」件数を正確に数える。通数は50物件で有界＝冪等失効(STALE_MS)内に収まる。
- **`filters`（後方互換）経路**: 該当が数千件になり得るので `take: MAX_GENERATE_ITEMS + 1` で取得を絞り、`generateLetters({ max: MAX_GENERATE_ITEMS })` で50通に切詰＋`truncated` 通知。
- `page.tsx`: 作成前 `window.confirm` に選択件数を明示（AI料金・オーナー情報の外部送信の同意）。共有者が別住所の物件は手紙数>物件数になるため「◯件の物件（共有者ぶんで複数通になる場合あり）」と表現し、除外通知は物件数（`matchedProperties`）で数える。真の大量一括はバックグラウンド生成（別機能）が前提。

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
- 機能2: `propertyIds` 経路は take 無し・`max` 無しで全宛先生成（`truncated=false`）。schema が51物件以上を弾く。`filters` 経路は50通で `truncated=true`。
- 機能3: `buildPropertyListOrderBy` の `dmSendCount` 分岐。`buildPropertyListWhere` の `dmSentMax`（0=none / N=notIn）。list route の `_count` 返却。
- 全ゲート（tsc / 全 vitest / eslint / build）緑。

## 非スコープ / 前提

- 新規依存なし。migration は `propertyId` 索引の追加1本のみ（追加のみ・データ無変更・@codex R3 + ユーザー承認）。
- 大量選択時の課金は「件数確認」で担保（本番Claude時）。今は mock で無料。
- UI 簡素化（ウィザード等）は別途。
