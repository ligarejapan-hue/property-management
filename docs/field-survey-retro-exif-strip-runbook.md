# field-survey 写真 遡及 EXIF/GPS strip 運用 Runbook（inventory / dry-run / apply）

既存アップロード済み field-survey 写真（`FieldSurveyPinPhoto`）に残る EXIF/GPS を遡及的に
除去する作業の手順書です。**inventory（棚卸し）/ dry-run（無害な事前確認）/ apply（実 strip）**
の 3 モードを扱います。

> ⚠ **`--apply` は本番データを変更します。**
> apply は新 key での再アップロードと DB の repoint を行います（実 strip）。**本番での apply 実行は
> 別承認**で、本 Runbook の事前手順（DB backup・inventory/dry-run レビュー・低トラフィック窓）を
> 完了してから行ってください。**旧 key / 旧 thumbnail key の削除（cleanup）は本 PR の範囲外**で、
> さらに別承認（PR-R2c）です。

関連: [field-survey-photo-privacy-checklist.md](./field-survey-photo-privacy-checklist.md) §6
（遡及 strip = 別タスク・別承認）／ コアロジックは PR #148 で main 反映済み
（`src/lib/field-survey/retro-exif-strip.ts`）／ CLI/配線は
`src/lib/field-survey/retro-exif-strip-cli.ts`・`scripts/retro-exif-strip-field-survey.ts`。

---

## 1. このPRでできること / できないこと

| 区分 | 内容 |
| --- | --- |
| できる（本PR） | inventory（対象件数・mimeType 分布・key 抽出可否・legacy absolute 件数・非対応 MIME 件数・thumbnail 有無）／ dry-run（storage read + strip を**メモリ上だけ**で実施し outcome 集計・JSONL run-log）／ **apply（実 strip：新 key 再アップロード + 楽観ガード付き DB repoint・新 key 補償削除）** |
| できない（別承認） | 旧 key・旧 thumbnail key の削除（cleanup = **PR-R2c**）／ 孤児新 key の reconciliation ／ resume checkpoint ／ storage ファイルの別バックアップ tooling ／ **本番での apply 実行そのもの**（= 本 Runbook 手順の実行は別承認） |

`--apply` は実装済みですが、**本番での実行は別承認**です（runbook の事前手順を完了してから）。

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
- **旧 key / 旧 thumbnail key は削除しない**。apply 後も旧 key は **rollback 窓**として保持する
  設計（cleanup = 別承認の PR-R2c）。

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
- 旧 key の削除（cleanup）が必要になった（→ 本 PR の範囲外。別承認の PR-R2c）。
- DB スキーマ / storage 契約の変更が必要になった（→ 停止して設計見直し）。

いずれも「環境要因」と決めつけず、原因を切り分けてから次へ進むこと。

---

## 10. rollback / 復旧

- **storage 側**：apply は旧 key を**削除しない**ため、旧バイト（GPS 入り）が rollback 窓として
  残っている。DB の `fileUrl` を旧 key に戻せば旧バイトに復帰できる（run-log の `oldKey` / `newKey`
  対が逆適用の材料）。
- **DB 側**：`restore-db.sh`（事前に `backup-db.sh` を取得していること）。
- **クラッシュ窓**（すべて良性）:
  - upload 後 repoint 前 = 新 key 孤児（非配信。run-log に現れない場合あり）→ cleanup（PR-R2c）で掃除。
  - repoint 後（apply 完了）= 旧 key 孤児（非配信。DB は新 key を指す）→ cleanup（PR-R2c）で掃除。
  - いずれも原本（旧 key）は無傷のまま。再実行は冪等。

---

## 11. このPRで変更していないもの（重要）

- 本番 DB スキーマ・migration・package / lock / env（**変更なし**）。
- production route / upload route / authorization のコード（**変更なし**）。
- AuditLog（apply は AuditLog を書きません。処理記録は JSONL run-log が正）。
- 旧 key / 旧 thumbnail key の削除（cleanup）= **未実装・別承認（PR-R2c）**。
- 孤児新 key の reconciliation / resume checkpoint = **別承認**。

実 strip（`--apply`）の**本番実行そのもの**、および cleanup（旧 key 削除）は **別承認**として
扱います（本 Runbook はその手順書）。
