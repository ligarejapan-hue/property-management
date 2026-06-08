# field-survey 写真 遡及 EXIF/GPS strip 運用 Runbook（PR-R2a: dry-run / inventory 専用）

既存アップロード済み field-survey 写真（`FieldSurveyPinPhoto`）に残る EXIF/GPS を遡及的に
除去する作業に向けた、**inventory（棚卸し）と dry-run（無害な事前確認）専用**の手順書です。

> ⚠ **このフェーズ（PR-R2a）は読み取り専用です。**
> 本番 DB の更新・storage への書き込み（upload / delete）・DB の repoint・旧 key の
> cleanup は **一切行いません**。実際に strip して保存する処理（`--apply`）は **未実装**で、
> 別 PR・**別承認**（PR-R2b 以降）です。

関連: [field-survey-photo-privacy-checklist.md](./field-survey-photo-privacy-checklist.md) §6
（遡及 strip = 別タスク・別承認）／ コアロジックは PR #148 で main 反映済み
（`src/lib/field-survey/retro-exif-strip.ts`）。

---

## 1. このPRでできること / できないこと

| 区分 | 内容 |
| --- | --- |
| できる（本PR） | inventory（対象件数・mimeType 分布・key 抽出可否・legacy absolute 件数・非対応 MIME 件数・thumbnail 有無）／ dry-run（storage read + strip を**メモリ上だけ**で実施し outcome 集計・JSONL run-log 出力） |
| できない（別承認） | 実 strip（新 key で再アップロード）／ DB repoint（fileUrl 付け替え）／ 旧 key・旧 thumbnail の削除（cleanup）／ `--apply` |

`--apply` を指定すると**エラー終了**します（実装されていません）。

---

## 2. 方式の前提（PR #148 の設計）

- **新 key 再アップロード + DB repoint 方式**（同一 key の in-place 上書きはしない）。
  /uploads の ETag が key 由来のため、in-place 上書きはキャッシュ済みクライアントに
  旧バイト（GPS 入り）を返し続けるため。**本 dry-run では再アップロードも repoint もしない**。
- **HEIC/HEIF は skip + flag**（変換しない）。遡及 strip の対象外として残る = GPS 残存候補。
- **malformed（壊れた画像）は skip + flag**（削除・上書きしない）。
- **legacy absolute URL 対応済み**：古い upload route が `result.url`（server adapter 由来の
  `https://{host}/uploads/...`）をそのまま DB 保存していた時期のデータも、key を復元して
  対象化する（Codex P1 対応）。非 canonical key（backslash / 連続スラッシュ等）は対象外。
- **旧 key 削除は未実装・別承認**。実 strip 後も旧 key は rollback 窓として保持する設計。

---

## 3. 実行前に必要な確認

1. **対象環境の確認**：本番 VPS で実行する場合、`DATABASE_URL` と `STORAGE_BACKEND`
   （本番は通常 `server`）が `/etc/property-management/app.env` 経由で設定されていること。
2. **mock でないこと**：`NEXT_PUBLIC_USE_MOCK=true` のときは CLI が**停止**します
   （mock では実データを反映しないため）。
3. **READ 専用であることの再確認**：本 CLI は `findMany`（DB read）と storage の `read`
   のみを使います。書き込み導線は存在しません。
4. **tsx が使えること**（下記）。
5. dry-run の JSONL 出力先（任意）に書き込み権限があること。

### `npm ci --include=dev` / `tsx` についての注意

- この CLI は TypeScript で書かれており、**`tsx`（devDependency）で実行**します。
- 本番デプロイは `npm prune --omit=dev` で devDeps を削除するため、**steady-state の本番では
  `tsx` が入っていません**。実行するには次のいずれか:
  - デプロイ中の **devDeps が入っている時間帯**（`npm ci --include=dev` 後・`npm prune` 前）に実行する、または
  - 一時的に `npm ci --include=dev` を実行して `tsx` を復元してから CLI を実行し、終了後に
    `npm prune --omit=dev` で元に戻す。
- いずれの場合も、本 CLI 自体は DB/storage を**変更しません**（READ のみ）。

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
```

オプション:

| オプション | 意味 |
| --- | --- |
| `--inventory` | DB 集計のみ（storage 未読） |
| `--dry-run` | storage read + strip をメモリ上で実施し outcome 集計 |
| `--jsonl <path>` | dry-run の run-log を JSONL（非 PII）で出力 |
| `--batch-size <n>` | 1 バッチの取得件数（既定 500） |
| `--limit <n>` | 処理対象の上限（部分確認用） |
| `--help`, `-h` | ヘルプ |
| `--apply` | **未実装**（指定するとエラー終了） |

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

- **would_strip** = 実 strip フェーズ（別承認）で新 key + repoint される見込み件数。
- `repointed` / `skipped_row_changed` が **0 以外**になることは dry-run では**ありません**
  （なった場合は異常 → §8 の停止条件）。
- JSONL run-log（`--jsonl`）は 1 行 1 写真の非 PII レコード（photoId / outcome /
  oldKey(path のみ) / bytes / errorName 等）。**fileName・座標・EXIF 値・所有者情報は含めません**。
- **per-row の詳細（どの photoId が `failed` / `skipped_malformed` だったか等）を見るには
  `--jsonl <path>` を付ける**こと。未指定時は集計（outcome 別件数）のみが stdout に出ます。

---

## 7. 非 PII 出力方針

- 標準出力・JSONL とも、**写真の内容・EXIF/GPS 値・ファイル名・所有者情報は出力しません**。
- 出力されるのは：件数・mimeType・outcome・storage key（path のみ＝氏名や座標を含まない）・
  バイト数・エラー名のみ。
- 予期しない例外時もエラー**名**のみを表示（メッセージ本文は path/PII 混入の可能性があるため出さない）。

---

## 8. NG 時の停止条件（該当したら作業を止めて報告）

- dry-run で `repointed` または `skipped_row_changed` が **0 以外**になった
  （= 書き込み導線が動いている疑い。本 PR では起き得ない）。
- `failed` が想定外に多い（storage backend / 認証 / ネットワーク異常の疑い）。
- inventory の `対象件数` が想定と大きく食い違う（DB 接続先の取り違え）。
- CLI が `NEXT_PUBLIC_USE_MOCK=true` で停止した（mock 環境を本番と取り違えた）。
- `--apply` が必要になった（→ 本 PR の範囲外。別承認の PR-R2b 以降）。
- DB スキーマ / storage 契約の変更が必要になった（→ 停止して設計見直し）。

いずれも「環境要因」と決めつけず、原因を切り分けてから次へ進むこと。

---

## 9. このPRで変更していないもの（重要）

- 本番 DB・本番 storage（READ のみ。**一切変更しない**）。
- production route / upload route / authorization のコード。
- Prisma schema / migration / package / lock / env。
- 実 strip / repoint / 旧 key cleanup（**未実装・別承認**）。

実 strip（`--apply`）・cleanup（旧 key 削除）は **PR-R2b 以降で別承認**として扱います。
