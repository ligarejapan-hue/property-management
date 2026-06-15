# 表示名監査(Display Name Audit)設計

- 日付: 2026-06-14
- エピック: 22-A / C トラック(import-display-name-audit)
- 種別: read-only 監査機能(データ更新・統一適用は本スコープ外=別承認)
- base: `1e08ac0`(main・本番同期済)
- branch: `feat/display-name-audit`

## 背景 / 動機

所有者宛 DM は外注先へ **CSV 納品**する運用。取込時、所有者名・建物名は **as-is(trim のみ)で保存**され、正規化(`normalizeName`/`normalizeBuildingName`)は **重複判定の比較専用**で保存値は変えない。このため、同一人物・同一建物が **全半角・空白違いなどの表記ゆれで別名義として残る**余地がある。

既存 `owner-dedup` は取込時に **住所/電話一致**で重複作成を防ぐ書込ガードであり、誤統合防止のため **name 単独では名寄せしない**。よって「同じ正規化名キーなのに別レコードで生 name が割れている」ケースは捕捉されない。

本機能は、この表記ゆれを **人が確認できる read-only レポート**として可視化し、外注 CSV の宛名品質を底上げする。**自動統一(適用)は行わない**(将来別 PR・別承認)。

## スコープ

### やること
- 同一正規化名キーに **生 name が2バリアント以上**ある群の検出(Owner と Building の両方)
- admin 限定の監査レポート画面(owner/building タブ)
- 監査結果の CSV 出力

### やらないこと(YAGNI / 別承認)
- 統一候補の自動適用(owner.name / building.name の更新)
- 外注 CSV で化ける文字・制御文字の検出(今回の核から除外)
- 空・異常な宛名の検出(同上)
- 住所/電話を用いた name 単独名寄せ(既存 dedup の領域)

## アーキテクチャ / モジュール構成

### 1. 純関数 lib: `src/lib/display-name-audit.ts`
DB 非依存・テスト容易な純関数。

```
interface AuditRecord { id: string; name: string }
interface AuditVariant { name: string; count: number; ids: string[] }
interface AuditGroup { key: string; variants: AuditVariant[]; totalRecords: number }
interface AuditResult { groups: AuditGroup[]; truncated: boolean }

function buildDisplayNameAuditGroups(
  records: AuditRecord[],
  normalizer: (name: string) => string,
  options?: { maxGroups?: number },
): AuditResult
```

- 正規化キーで group 化 → **distinct な生 name が2つ以上**ある群のみ残す
- 各群の variants は生 name 単位で件数・id 集約
- 群は「totalRecords 降順 → key 昇順」で安定ソート
- `maxGroups`(既定 1000)超過は先頭 maxGroups 群に制限し `truncated: true`
- Owner は `normalizeName`、Building は `normalizeBuildingName` を注入して再利用

### 2. route: `GET /api/admin/display-name-audit`
- admin 限定。owner 群と building 群の両方を返す。**DB 書込なし**。
- `?format=csv` で CSV 返却(既定 JSON)
- `?entity=owner|building`(任意・既定は両方)

### 3. UI: admin 配下 監査ページ
- owner/building タブ
- 群一覧: 正規化キー / バリアント(生 name + 件数)/ 総レコード数
- CSV ダウンロードボタン(route の `?format=csv` を叩く)
- `truncated` 時は上限到達の注意表示

## 認可 / データ範囲

- route は **admin 限定**(既存 admin ガード踏襲)
- 所有者名は PII。生値を返すため **`owner:read` + 表示レベルが生値(full/read/edit)** を必須化。満たさない場合 **owner 群は返さない(空)**。building 名は PII でないため別扱いで返す。
- 監査ログは **PII 本文を記録しない**。操作種別 `display_name_audit_view` のみ記録。
- データ範囲: `isArchived: false` のみ(既存 dedup と一貫)
- 取得列は最小化: `select: { id: true, name: true }`

## データフロー

1. route が owner/building を `select:{id,name}` + `isArchived:false` で取得
2. 純関数で正規化キー化 → 2バリアント以上の群を抽出 → 件数降順ソート → 上限適用
3. JSON 返却。`?format=csv` 時は同データを行展開
   - CSV 列: `種別, 正規化キー, 表示名, 件数, 対象ID`
   - 既存 `sanitizeCsvCellForExcel`(formula injection 対策)を流用
4. UI はタブ切替表示、CSV ボタンで `?format=csv&entity=...`

## エラー処理

- 認可不足 → 403(既存パターン)
- 表示レベル不足 → owner 群は空配列(building 群は返す)
- 表記ゆれ 0 件 → 200 で空群(エラーにしない)
- 取得対象が極端に多い場合 → 群の最大返却数に上限(既定 1000)、超過は `truncated: true` で明示(**silent 切り捨て禁止**)

## テスト(TDD)

### 純関数 unit
- 同一キー複数バリアント → 検出
- 単一バリアントのみ → 非検出
- 全半角・空白違いの吸収(`田中　太郎` = `田中太郎`)
- 建物名の内部空白全除去(`ABC マンション` = `ABCマンション`)
- 空文字・空白のみ name の扱い(正規化後空キーは群化しない or 明示扱いを決定 → **空キーは群化しない**)
- 件数・ID 集約の正しさ
- `maxGroups` 超過時の truncation と件数

### route test
- admin 認可必須(非 admin → 403)
- 表示レベルゲート(生値レベル不足で owner 群が空・building は返る)
- `?format=csv` の Content-Type と行展開
- 空結果 200
- 監査ログに PII 本文が出ない

## 影響範囲 / 非改変(禁止パス)

- backend 契約(`OwnerDisplayConfig` / `maskValue`)は **読むだけ・非改変**
- 既存 import / dedup / normalize の純関数は **再利用・非改変**
- schema / migration: **不要**(read-only)
- 新規依存: **なし**(既存 CSV ユーティリティ流用)

## PR 方針

- 案A: 単一機能 PR(純関数 → route → UI を TDD で内部段階実装)。read-only・低リスクのため一括。
- 統一適用(PR-4 相当)は本 PR に含めない。
