# field-survey 写真 遡及 EXIF/GPS strip 運用 Runbook（inventory / dry-run / apply / cleanup）

既存アップロード済み field-survey 写真（`FieldSurveyPinPhoto`）に残る EXIF/GPS を遡及的に
除去する作業の手順書です。**inventory（棚卸し）/ dry-run（無害な事前確認）/ apply（実 strip）**
の 3 モードに加え、apply 後の **cleanup（旧 key 削除：dry-run 列挙 R2c-i / 実削除 R2c-ii）**（§12）を扱います。

> ⚠ **`--apply` は本番データを変更します。**
> apply は新 key での再アップロードと DB の repoint を行います（実 strip）。**本番での apply 実行は
> 別承認**で、本 Runbook の事前手順（DB backup・inventory/dry-run レビュー・低トラフィック窓）を
> 完了してから行ってください。**旧 key / 旧 thumbnail key の削除（cleanup）は実装済み**
> （dry-run 列挙 = PR #159 / 実削除 = PR #161）ですが、**本番での cleanup 実行は別承認**で
> **不可逆**です（手順は §12）。

関連: [field-survey-photo-privacy-checklist.md](./field-survey-photo-privacy-checklist.md) §6
（遡及 strip = 別タスク・別承認）／ コアロジックは PR #148 で main 反映済み
（`src/lib/field-survey/retro-exif-strip.ts`）／ CLI/配線は
`src/lib/field-survey/retro-exif-strip-cli.ts`・`scripts/retro-exif-strip-field-survey.ts`。

---

## 1. このPRでできること / できないこと

| 区分 | 内容 |
| --- | --- |
| できる（本PR） | inventory（対象件数・mimeType 分布・key 抽出可否・legacy absolute 件数・非対応 MIME 件数・thumbnail 有無）／ dry-run（storage read + strip を**メモリ上だけ**で実施し outcome 集計・JSONL run-log）／ **apply（実 strip：新 key 再アップロード + 楽観ガード付き DB repoint・新 key 補償削除）** |
| できる（別 CLI・実装済） | **cleanup**（旧 key / 旧 thumbnail key 削除）：dry-run 列挙（R2c-i・PR #159）／ 実削除（R2c-ii・PR #161・二重ゲート `--delete --confirm`）。手順は §12。**本番での cleanup 実行は別承認** |
| できない（別承認） | 孤児新 key の reconciliation ／ resume checkpoint ／ storage ファイルの別バックアップ tooling ／ **本番での apply / cleanup 実行そのもの**（= 本 Runbook 手順の実行は別承認） |

`--apply`（§4）・cleanup（§12）は実装済みですが、**本番での実行はいずれも別承認**です（runbook の事前手順を完了してから）。

---

## 2. 方式の前提（PR #148 の設計）

- **新 key 再アップロード + DB repoint 方式**（同一 key の in-place 上書きはしない）。
  /uploads の ETag が key 由来のため、in-place 上書きはキャッシュ済みクライアントに
  旧バイト（GPS 入り）を返し続ける。新 key にすれば fileUrl が変わり、旧 URL は DB 逆引き
  不一致で 401/403 化する。
- apply の per-row 処理（core が完結）:
  1. `fileUrl` → 旧 key 復元（不能 = `skipped_unmappable_url`・storage に触れない）
  2. 非対応 MIME（HEIC/HEIF 等）は read 前に `skipped_unsupported_mime`
  3. `storage.read`（実体なし = `skipped_missing_bytes`）
  4. strip（malformed = `skipped_malformed`）／ 既に clean = `unchanged`（書き込みなし＝冪等 skip）
  5. 新 key（`field-survey/pins/{pinId}/photos/{uuid}.{ext}`）で upload → **canonical 検証**
     （返却 key が旧 key を指す/非 canonical なら repoint せず `failed`・新 key のみ補償削除）
  6. 楽観ガード付き repoint：`updateMany({ where: { id, fileUrl: 読み取り時の値 }, data: { fileUrl, thumbnailUrl, fileSize } })`
     （`fileSize` は strip 後バイト長。**mimeType は更新しない**＝format 不変）
     - `count = 1` → `repointed`
     - `count = 0`（並行で削除/変更）→ **新 key のみ補償削除**して `skipped_row_changed`
       （旧 key には決して触れない）
- **HEIC/HEIF は skip + flag**（変換しない）。遡及 strip の対象外として残る = GPS 残存候補。
- **malformed（壊れた画像）は skip + flag**（削除・上書きしない）。
- **legacy absolute URL 対応済み**：古い upload route が `result.url`（server adapter 由来の
  `https://{host}/uploads/...`）をそのまま DB 保存していた時期のデータも、key を復元して
  対象化する（Codex P1 対応）。非 canonical key（backslash / 連続スラッシュ等）は対象外。
- **apply は旧 key / 旧 thumbnail key を削除しない**。apply 後も旧 key は **rollback 窓**として保持する
  設計。旧 key の削除（cleanup）は apply とは別の CLI（§12・R2c-i dry-run / R2c-ii 実削除）で行い、
  **cleanup を実行するとこの rollback 窓は閉じる**（不可逆）。

---

## 3. 実行前に必要な確認

### 共通（全モード）

1. **対象環境の確認**：本番 VPS で実行する場合、`DATABASE_URL` と `STORAGE_BACKEND`
   （本番は通常 `server`）が `/etc/property-management/app.env` 経由で設定されていること。
2. **mock でないこと**：`NEXT_PUBLIC_USE_MOCK=true` のときは CLI が**停止**します
   （mock では実データを反映しないため）。
3. **tsx が使えること**（下記）。

### apply（実 strip）を実行する前に追加で必須（**本番実行は別承認**）

4. **⚠ `STORAGE_BACKEND` を明示設定・稼働 app と一致**（最重要・Codex P1）：`--apply` は
   `STORAGE_BACKEND` が **未設定 / 空 / 未対応値**のとき、**DB へ触れる前（storage 取得・DB repoint
   前）に停止**する（暗黙の local fallback を禁止）。許可値は `local` / `server` / `s3`。
   - **稼働中アプリと同じ backend** を指すこと。**`local` backend のまま production DB へ apply して
     はいけない**（strip 画像が local disk に置かれ、production DB が new key を指すと、稼働 app
     〔server backend 等〕がその new key を読めず写真が 404 化する）。
   - `DATABASE_URL` だけでなく **storage 系 env も実行前チェック対象**：`server` なら
     `STORAGE_SERVER_URL` / `STORAGE_SERVER_API_KEY`、`s3` なら `STORAGE_S3_BUCKET` /
     `STORAGE_S3_REGION` / `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY`。不足時は
     storage 取得時点（= repoint 前）に fail-closed で停止する。
   - 実行開始時にログへ出る `storage backend（明示確認済み）: <値>` が想定どおりか必ず確認する。
     **backend 確認は DB repoint 前の停止条件**。
5. **DB backup を取得済み**：`backup-db.sh`（DB の論理バックアップ）。rollback の DB 側手段。
6. **inventory を実施・レビュー済み**：対象件数 / mimeType 分布 / 非対応 MIME 数 / unmappable 数 /
   thumbnail 有無 を把握。
7. **dry-run を実施・レビュー済み**：`would_strip`（変更見込み件数）・skip 内訳・`failed` が
   想定どおりか確認（§6）。dry-run のログ冒頭に出る `storage backend` が apply で使う backend と
   一致しているかも確認する。
8. **thumbnail probe**：thumbnail を持つ行がある場合、apply で `thumbnailUrl` が **upload 返却値**に
   置き換わる。server backend が再アップロード時に thumbnail を生成して返すならクリーンな
   thumbnail に更新されるが、**返さない場合は `thumbnailUrl` が null 化し得る**。事前に 1 件
   probe して挙動を確認すること（影響範囲はリポジトリからは判定不能）。
9. **ディスク空き**：新 key を旧 key と並存させるため、対象 corpus 相当の追加容量＋余裕。
10. **低トラフィック窓**：楽観ガードで並行安全だが、`skipped_row_changed`（並行変更）が増えると
    再実行が必要になるため、書き込みの少ない時間帯を選ぶ。
11. **run-log（`--jsonl`）の保存先**：apply では rollback / cleanup 判断の根拠になるため保存を推奨。

### `npm ci --include=dev` / `tsx` についての注意

- この CLI は TypeScript で書かれており、**`tsx`（devDependency）で実行**します。
- 本番デプロイは `npm prune --omit=dev` で devDeps を削除するため、**steady-state の本番では
  `tsx` が入っていません**。実行するには次のいずれか:
  - デプロイ中の **devDeps が入っている時間帯**（`npm ci --include=dev` 後・`npm prune` 前）に実行する、または
  - 一時的に `npm ci --include=dev` を実行して `tsx` を復元してから CLI を実行し、終了後に
    `npm prune --omit=dev` で元に戻す。
- inventory / dry-run は DB/storage を**変更しません**（READ のみ）。apply は新 key の upload と
  DB repoint を行います（旧 key は保持）。

---

## 4. 使い方

```sh
# ヘルプ
npx tsx scripts/retro-exif-strip-field-survey.ts --help

# inventory（DB のみ。storage は読まない）
npx tsx scripts/retro-exif-strip-field-survey.ts --inventory

# dry-run（storage read + strip をメモリ上で実施。書き込みなし）
npx tsx scripts/retro-exif-strip-field-survey.ts --dry-run --jsonl /tmp/retro-dryrun.jsonl

# 部分確認（先頭 N 件だけ）
npx tsx scripts/retro-exif-strip-field-survey.ts --dry-run --limit 50

# apply（実 strip：新 key 再アップロード + DB repoint）※本番実行は別承認・上記 §3 を完了後
npx tsx scripts/retro-exif-strip-field-survey.ts --apply --jsonl /tmp/retro-apply.jsonl
```

オプション:

| オプション | 意味 |
| --- | --- |
| `--inventory` | DB 集計のみ（storage 未読） |
| `--dry-run` | storage read + strip をメモリ上で実施し outcome 集計（書き込みなし） |
| `--apply` | 実 strip（新 key 再アップロード + 楽観ガード付き DB repoint・新 key 補償削除）。旧 key は保持 |
| `--jsonl <path>` | run-log を JSONL（非 PII）で出力。apply では保存を推奨 |
| `--batch-size <n>` | 1 バッチの取得件数（既定 500） |
| `--limit <n>` | 処理対象の上限（部分確認用） |
| `--help`, `-h` | ヘルプ |

`--inventory` / `--dry-run` / `--apply` は排他（同時指定はエラー）。

---

## 5. inventory 結果の読み方

```
対象件数: <N>
mimeType 分布:
  image/jpeg: ...
  image/png: ...
  image/heic: ...
fileUrl から key 抽出可能（処理候補）: <mappable>
  うち legacy absolute URL: <absoluteLegacy>
fileUrl 抽出不可（skip 予定）: <unmappable>
strip 対象 MIME かつ mappable（実処理候補の上限）: <supportedAndMappable>
非対応 MIME（HEIC/HEIF 等・skip 予定・GPS 残存候補）: <unsupportedMime>
thumbnail あり: <withThumbnail>（うち key 抽出可: <thumbnailMappable>）
```

- **実処理候補の上限** = `strip 対象 MIME かつ mappable`。これより多く処理されることはない。
- **非対応 MIME** と **unmappable** は遡及 strip の対象外として残る（= GPS 残存が残り得る）。
  HEIC/HEIF の扱いや orphan の扱いは別承認の領域。
- **legacy absolute URL** が多い場合、過去データの URL 形式が混在している兆候。対象化済みだが、
  件数として把握しておく。

---

## 6. dry-run 結果の読み方

```
処理件数: <N>
  repointed: 0            ← dry-run では必ず 0（書き込みしない）
  unchanged: ...          ← 既に clean（strip 不要）
  would_strip: ...        ← 実 strip で「変更される見込み」の件数（最重要）
  skipped_unsupported_mime: ...  ← HEIC/HEIF 等
  skipped_malformed: ...   ← 壊れた画像
  skipped_unmappable_url: ...    ← key 復元不可
  skipped_missing_bytes: ...     ← DB 行はあるが storage に実体なし
  skipped_row_changed: 0   ← dry-run では発生しない
  failed: ...              ← read エラー等（stage/errorName を JSONL で確認）
```

- **would_strip** = apply で新 key + repoint される見込み件数。apply 後の `repointed` の上限。
- dry-run では `repointed` / `skipped_row_changed` は**必ず 0**（書き込み導線が動かない）。
  0 以外になったら異常 → §9 の停止条件。
- JSONL run-log（`--jsonl`）は 1 行 1 写真の非 PII レコード。**per-row の詳細を見るには
  `--jsonl <path>` を付ける**こと。

---

## 7. apply 結果の読み方 / exit code

```
処理件数: <N>
  repointed: ...               ← 新 key 再アップロード + DB repoint 成功（実 strip された）
  unchanged: ...               ← 既に clean（書き込みなし）
  skipped_unsupported_mime: ...← HEIC/HEIF 等（対象外として残る）
  skipped_malformed: ...       ← 壊れた画像（触らない）
  skipped_unmappable_url: ...  ← key 復元不可（触らない）
  skipped_missing_bytes: ...   ← storage に実体なし
  skipped_row_changed: ...     ← 楽観ガード負け（並行で削除/変更）。新 key は補償削除済み
  failed: ...                  ← read/upload/repoint 例外・非 canonical key 等
```

**exit code**:

| code | 意味 | 対応 |
| --- | --- | --- |
| `0` | clean（`failed` も `skipped_row_changed` も無い） | 期待された skip のみ。§8 の検証へ |
| `1` | `failed > 0` | 要調査。run-log の `stage` / `errorName` / `newKey`（孤児候補）を確認 |
| `2` | `failed` なし・`skipped_row_changed > 0` | 並行変更。低トラフィック窓で**再実行**すれば収束（冪等） |

- JSONL run-log（apply）には outcome 別に以下が出ます（すべて非 PII＝key の path / 数値 / エラー名）:
  - `repointed`: `oldKey` / `newKey` /（旧 thumbnail があれば）`oldThumbnailKey` / `bytesBefore` / `bytesAfter`
  - `skipped_row_changed`: `oldKey` / `newKey` / `compensationDeleted`（false = 新 key 孤児・要 cleanup）
  - `failed`: `stage` / `errorName` /（あれば）`newKey` / `compensationDeleted`
  - **fileName・座標・EXIF 値・所有者情報・newFileUrl は含めません**。
- **再実行は冪等**：repoint 済みの行は再 read で `unchanged`（changed=false）になり、書き込みは
  発生しません。中断した場合は先頭から再実行して問題ありません（checkpoint は持ちません）。

---

## 8. apply の検証（実行後）

1. **サマリ照合**：`処理件数 == repointed + unchanged + 各 skip + failed` が一致するか。
2. **再スキャン検証**：`--dry-run` をもう一度実行し、`would_strip` が（新規アップロードを除き）
   **0 に収束**していることを確認する（FieldSurveyPinPhoto は hash 列を持てない invariant の
   ため、再 read + 再 strip で changed=false 率 100% を確認する方式）。
   - 注: apply は read-back（再 GET）を行いません。完了の検証は「楽観ガード（fileUrl 値）+ upload 後の
     canonical round-trip 検証（core）」＋この再スキャンで担保します。
3. **サンプル目視**：表示 / 回転（Orientation）を数枚チェック（チェックリスト化推奨）。
4. **run-log 保管**：`--jsonl` の出力を保管（rollback / cleanup の根拠）。

---

## 9. NG 時の停止条件（該当したら作業を止めて報告）

- **apply が `STORAGE_BACKEND` 未設定 / 空 / 未対応で停止した**（暗黙 local fallback の防止＝正常な
  fail-closed・Codex P1）。backend を稼働 app と一致させて明示してから再実行する。実行開始ログの
  `storage backend（明示確認済み）` が想定と違う場合も止めて確認する（**DB repoint 前の停止条件**）。
- dry-run で `repointed` または `skipped_row_changed` が **0 以外**になった（書き込み導線が
  動いている疑い。dry-run では起き得ない）。
- apply の `failed` が想定外に多い（storage backend / 認証 / ネットワーク異常、または非 canonical
  key の混入の疑い → run-log の `errorName` を確認）。
- apply の run-log に `compensationDeleted: false` がある（**新 key 孤児が残存**＝cleanup 対象。
  PR-R2c の領域。orphan の reconciliation は別承認）。
- thumbnail を持つ行で apply 後に `thumbnailUrl` が意図せず null 化した（§3-7 の probe を怠った
  疑い → 影響範囲を確認）。
- inventory の `対象件数` が想定と大きく食い違う（DB 接続先の取り違え）。
- CLI が `NEXT_PUBLIC_USE_MOCK=true` で停止した（mock 環境を本番と取り違えた）。
- 旧 key の削除（cleanup）が必要になった（→ cleanup は実装済み〔§12〕。**本番実行は別承認・不可逆**。
  apply 検証〔§8〕完了後に §12 の手順で行う）。
- DB スキーマ / storage 契約の変更が必要になった（→ 停止して設計見直し）。

いずれも「環境要因」と決めつけず、原因を切り分けてから次へ進むこと。

---

## 10. rollback / 復旧

- **storage 側**：apply は旧 key を**削除しない**ため、旧バイト（GPS 入り）が rollback 窓として
  残っている。DB の `fileUrl` を旧 key に戻せば旧バイトに復帰できる（run-log の `oldKey` / `newKey`
  対が逆適用の材料）。**ただしこの storage 側 rollback は cleanup（§12・R2c-ii 実削除）を実行していない
  間に限る**。cleanup で旧 key を消すと旧バイトは復元できなくなる（不可逆）。
- **DB 側**：`restore-db.sh`（事前に `backup-db.sh` を取得していること）。
- **クラッシュ窓**（すべて良性）:
  - upload 後 repoint 前 = **新 key 孤児**（非配信。run-log に現れない場合あり）→ 新 key 孤児の
    reconciliation は**別承認**（cleanup〔§12〕は旧 key 削除であって新 key 孤児は対象外）。
  - repoint 後（apply 完了）= **旧 key 孤児**（非配信。DB は新 key を指す）→ cleanup（§12・R2c-ii）で掃除。
  - いずれも原本（旧 key）は cleanup 未実行の間は無傷のまま。再実行は冪等。

---

## 11. このPRで変更していないもの（重要）

- 本番 DB スキーマ・migration・package / lock / env（**変更なし**）。
- production route / upload route / authorization のコード（**変更なし**）。
- AuditLog（apply は AuditLog を書きません。処理記録は JSONL run-log が正）。
- 旧 key / 旧 thumbnail key の **cleanup は実装済み**：dry-run 列挙（R2c-i・PR #159・storage 非削除・
  読み取り専用）+ **実削除（R2c-ii・PR #161・`--delete --confirm` 二重ゲート + Codex P1 の削除前
  pre-validation 込み）**。別 CLI `scripts/retro-exif-strip-cleanup-field-survey.ts`。**手順・前提条件・
  outcome / exit code の解釈は §12**。**本番での cleanup 実行は別承認・不可逆**。cleanup は DB を変更せず
  storage 実体のみ削除する（apply の repoint 済み行はそのまま）。
- 孤児新 key の reconciliation / resume checkpoint = **別承認**（cleanup〔§12〕は旧 key 削除であって
  新 key 孤児の reconciliation は対象外）。
- AuditLog は apply・cleanup とも書きません（処理記録は JSONL run-log / delete log が正）。

実 strip（`--apply`）の**本番実行そのもの**、および cleanup（旧 key 削除）の**本番実行**は
**別承認**として扱います（本 Runbook はその手順書）。cleanup の手順は §12 を参照。

---

## 12. cleanup（旧 key / 旧 thumbnail key の削除）— R2c-i dry-run 列挙 / R2c-ii 実削除

> ⚠ **storage delete は不可逆です。** cleanup は apply 後に rollback 窓として残していた旧 key /
> 旧 thumbnail key を storage から**実体削除**します（DB は変更しません）。実行すると §10 の storage 側
> rollback（旧 key へ戻す）は**できなくなります**。**本番での cleanup 実行は別承認**で、本 §12 の
> 前提条件・順序を完了してから行ってください。

実装: dry-run 列挙 = PR #159（R2c-i）、実削除配線 = PR #161（R2c-ii・Codex P1 対応込み）。CLI は
`scripts/retro-exif-strip-cleanup-field-survey.ts`（lib = `src/lib/field-survey/retro-exif-strip-cleanup.ts`）。
**入力は apply の JSONL run-log**（`repointed` 行の `oldKey` / 非 null `oldThumbnailKey` が削除対象候補）。
DB は変更せず **storage 実体のみ削除**する（apply で repoint 済みの行はそのまま）。

### 12.1 cleanup 実行の全体順序

1. **apply run-log を保存**：apply（§4・§7）を `--jsonl <path>` 付きで実行し、その run-log を保管する。
   これが cleanup の削除対象を決める**権威ソース**（DB 単独では apply 後の旧 key を逆算できない）。
   run-log が無い / 部分的な apply は cleanup できない。
2. **R2c-i dry-run を実行**（列挙のみ・storage 非削除）:
   ```sh
   npx tsx scripts/retro-exif-strip-cleanup-field-survey.ts \
     --apply-run-log /tmp/retro-apply.jsonl --out /tmp/retro-cleanup-dryrun.jsonl
   ```
3. **dry-run exit 0 を確認**：`malformed_line`（exit 1）/ `skipped_still_referenced`（exit 2）が出て
   いないこと。**exit 0 でなければ delete に進まない**（§12.2）。
4. **delete 実行前に対象 / 件数 / log を確認**：dry-run の summary（`deletable` 件数・skip 内訳）と
   `--out` の delete log（per-candidate の outcome / candidateKey）をレビューし、削除対象が想定どおりか
   確認する。
5. **R2c-ii delete を実行**（二重ゲート + `--out` 必須・§12.3）。
6. **delete log を保存**：`--out` の出力（deleted / delete_failed / skip 内訳）を保管（不可逆操作の
   証跡・唯一の記録＝AuditLog は書かない）。
7. **結果を確認**（§12.4 exit code / §12.7 実行後確認）。

### 12.2 delete 実行の前提条件

- **VPS に #161 以降が反映済みであること**（最重要）：現 VPS は `d1cb908` で **#161 は未反映**。
  delete mode（`--delete --confirm`）は **#161（PR-R2c-ii）で初めて実装**された（R2c-i では
  `--delete` / `--confirm` は拒否）。#161 未反映の VPS では delete を実行できない。**本番 delete 実行前に
  #161 以降を VPS へ反映済み**であることを確認する（反映手順そのものは VPS release runbook 側）。
- **`STORAGE_BACKEND` が明示されていること**（稼働 app と一致）：未設定 / 空 / 未対応値のときは
  storage 取得前に **fail-closed で停止**（暗黙 local fallback 禁止）。許可値 `local` / `server` / `s3`。
  稼働 app と違う backend を指すと、稼働中の正しい key を消す / 別 store を消す事故になり得る。
- **mock 環境でないこと**：`NEXT_PUBLIC_USE_MOCK=true` では停止。
- **apply run-log が正であること**：削除対象の権威ソース。apply 時に保存した run-log をそのまま使う。
- **直前 dry-run が exit 0 であること**（運用ゲート）：malformed / still_referenced があるまま delete に
  進まない。delete mode は malformed が 1 行でもあれば削除前に abort（§12.4）するが、運用としても
  dry-run exit 0 を delete の前提とする。
- **input / output 同一パス禁止**：`--apply-run-log`（入力）と `--out`（出力）を同一ファイルにしない
  （出力 sink が入力 run-log を truncate して破壊するため・CLI が同一パスを拒否）。
- **delete 時は `--out` 必須**：不可逆操作ゆえ delete log を必ず残す（`--out` 無しの `--delete --confirm`
  は parse でエラー）。

### 12.3 delete コマンド形

```sh
# 実削除（二重ゲート --delete --confirm + delete log 必須 + STORAGE_BACKEND 明示）
STORAGE_BACKEND=server \
npx tsx scripts/retro-exif-strip-cleanup-field-survey.ts \
  --apply-run-log /tmp/retro-apply.jsonl \
  --delete --confirm \
  --out /tmp/retro-cleanup-delete.jsonl
```

- **`--delete --confirm` の二重ゲート**：`--delete` 単独 / `--confirm` 単独はエラー（削除しない）。
  両方そろったときだけ実削除経路に入る。
- **`STORAGE_BACKEND` 明示**：稼働 app と一致（`server` 等）。`DATABASE_URL` と storage 系 env
  （`server` なら `STORAGE_SERVER_URL` / `STORAGE_SERVER_API_KEY` 等）は §3-4 と同じ。
- **app.env の扱い**：本番 VPS では env（`DATABASE_URL` / `STORAGE_BACKEND` / storage creds）を
  `/etc/property-management/app.env` から CLI の実行環境へ読み込むこと（apply（§3）と同じ要領で env を
  source し CLI へ引き継ぐ）。`STORAGE_BACKEND` は明示し、実行開始ログの
  `storage backend（明示確認済み）: <値>` で確認する。VPS 反映そのものの手順は本 Runbook の対象外。
- **tsx**：apply と同じく devDependency。`npm ci --include=dev` 後・`npm prune` 前に実行（§3）。

### 12.4 exit code 解釈（delete mode）

| code | 意味 | 対応 |
| --- | --- | --- |
| `0` | 成功（`deleted` / 期待 skip のみ・`delete_failed` なし） | 完了。delete log を保管（§12.7） |
| `1` | `malformed_line`（致命的な入力不正） | **delete mode は malformed があれば削除前に abort**（何も削除していない）。run-log を修復してから再実行 |
| `2` | `skipped_still_referenced` あり | 現 DB がまだ旧 key を参照（手動 rollback / 未 repoint の疑い）。削除しない判断・調査（§12.7） |
| `3` | `delete_failed` あり | storage 削除に失敗（orphan 残存）。delete log を確認し手動対応（§12.7） |

- **delete mode は run-log に malformed が 1 行でもあれば、storage 取得 / delete log 出力（truncate）/
  削除の前に pre-validation で abort する**（fail-before-delete・Codex P1）。「壊れた run-log は権威
  ソースとして信用できない」ため、後続の valid な deletable 行も**削除しない**（exit 1・何も消さない）。
- precedence（致命優先）: `malformed_line(1)` → `delete_failed(3)` → `skipped_still_referenced(2)` → `0`。
- dry-run の exit code は別系統（`0` / `1` malformed / `2` still_referenced。`3`=delete_failed は
  delete mode のみ）。

### 12.5 outcome 解釈

delete log（`--out`）の per-candidate outcome（実 CLI が出力する enum 名）:

| outcome | 意味 |
| --- | --- |
| `deleted` | storage から削除した（`StorageAdapter.delete` が throw せず完了） |
| `delete_failed` | storage 削除が失敗した（orphan 残存・`errorName` のみ記録） |
| `skipped_still_referenced` | 現 DB の `fileUrl` / `thumbnailUrl` のどちらかがまだ旧 key を参照 → 削除しない（cross-column 照合・手動 rollback / 未 repoint） |
| `skipped_unmappable` | 現 URL（non-null）から key を復元できない → 非参照を証明できず fail-closed で削除しない |
| `skipped_row_missing` | 該当 photo 行が現 DB に無い（pin cascade 削除等） |
| `skipped_invalid_key` | 候補 key が非 canonical（traversal / `?` / `#` 等） → 削除しない |
| `skipped_not_repointed` | run-log 行が `repointed` 以外（新 key 孤児等・別スコープ） → 候補化しない |
| `malformed_line` | run-log 行が壊れている（delete mode は §12.4 のとおり削除前 abort） |

- **既存 dry-run（R2c-i）outcome との違い**：dry-run は削除対象候補を `deletable` として列挙するのみ
  （storage 非削除）。delete mode はその `deletable` を実削除して **`deleted` / `delete_failed` に
  re-label** する（よって delete mode では `deletable` は出ない）。`skipped_*` 系の意味は dry-run と同一。

### 12.6 安全上の注意

- **storage delete は不可逆**：旧 key を消すと §10 の storage 側 rollback（旧 key へ戻す）ができなく
  なる。apply の検証（§8）完了・rollback 窓が不要と確認できてから実行する。
- **`deleted` / `already_absent` は区別しない**：`StorageAdapter.delete` は戻り値 void で「実際に
  消えたか / 既に無かったか」を返さない（全 backend が冪等で missing を成功扱い）。**`deleted` は
  「delete が throw せず完了した試行数」**であり「実体が確かに消えた」確証ではない（read probe は
  追加しない）。
- **`delete_failed` 時は best-effort 継続**：1 件の delete 失敗で batch を全停止しない。失敗は
  `delete_failed` に集計し、後続候補の処理を続ける。
- **記録は `errorName` のみ**：delete 失敗時も `error.name` だけを記録し、**`error.message` 本文や
  PII（fileName / 座標 / 所有者情報）は出さない**。
- **部分削除は正常に起こり得る**：file 候補は `deleted`・thumbnail 候補は `skipped_still_referenced`
  （または逆）のように、1 行内で片方だけ削除されることがある（per-candidate 独立評価）。これは異常では
  ない。
- **再実行時の summary は backend 挙動で変わり得る**：同じ run-log で 2 回実行すると、1 回目で消えた key
  の 2 回目は backend により `deleted`（local/server が missing を成功扱い）/ `delete_failed`（一部 S3
  互換が throw）に分岐し、summary が backend 依存でぶれ得る。
- **本番 cleanup 実行は別承認**。

### 12.7 実行後確認

1. **delete log を保存**：`--out` の JSONL（deleted / delete_failed / skip 内訳）を保管。不可逆操作の
   唯一の証跡（AuditLog は書かない＝run-log が正）。
2. **summary を確認**：`処理行数` と outcome 別件数の整合。`deleted` 件数が dry-run の `deletable` 件数と
   整合するか（間に手動 rollback 等が入ると `skipped_still_referenced` へ転じ得る）。
3. **`delete_failed` がある場合**：orphan が残存している。delete log で該当 `candidateKey` を確認し、
   backend 障害が原因なら復旧後に再実行、個別なら手動削除を検討（**手動 storage 操作は別承認**）。
4. **`skipped_still_referenced` がある場合**：現 DB がまだ旧 key を参照している＝**削除しない判断が
   正しい**。手動 rollback / 未 repoint の疑いがあるため原因を調査する（exit 2）。
5. **本番 storage / DB に対する追加操作は別承認**：本 Runbook の手順を超える手動介入は行わない。

### 12.8 明確な禁止事項（本 runbook 作成 PR の範囲）

- **runbook 作成 PR 内で本番実行しない**（docs-only）。
- **VPS 操作をしない**。
- **production DB / production storage 操作をしない**。
- **retro EXIF apply / cleanup CLI を実行しない**。
- **`--delete --confirm` を実行しない**。
