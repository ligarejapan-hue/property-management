# 住所自動入力: 住所データ(号・番)の取込 runbook

「ピンの位置から住所を入力」を精細化するためのデータ取込手順。精度は三段構えで、
データが無い地域は自動で次の段にフォールバックする(**取込は営業エリアの分だけでよい**):

1. **号まで**(例: 東京都杉並区西荻北3-19-4) — デジタル庁 アドレス・ベース・レジストリ(第3弾)
2. **番まで**(例: 東京都杉並区西荻北3-1) — 国土交通省 位置参照情報(第2弾)
3. **町丁目まで** — 国土地理院 API(第1弾・座標のみ外部送信)

## 1. 号データ(デジタル庁 アドレス・ベース・レジストリ)

住居番号(号)1つごとの代表点。実測ヒットは2〜14m=**番の精度も街区データより高い**ため、
住居表示のある市区町村ではこれが主力になる(街区データは住居表示未実施地域=地番の補完用)。

### 入手(年1回程度の更新)

都道府県ごとに**2種類**をダウンロードし、zip を展開して同じフォルダに置く:

- 町字マスター: `https://data.address-br.digital.go.jp/mt_town/pref/mt_town_pref<県番号2桁>.csv.zip`
- 住居表示-住居マスター位置参照拡張:
  `https://data.address-br.digital.go.jp/mt_rsdtdsp_rsdt_pos/pref/mt_rsdtdsp_rsdt_pos_pref<県番号2桁>.csv.zip`
- 例(東京都): `...mt_town_pref13.csv.zip` + `...mt_rsdtdsp_rsdt_pos_pref13.csv.zip`(約28MB)
- カタログ: https://dataset.address-br.digital.go.jp/ (全47都道府県整備済み・2026-08-02確認)

### 取込

```bash
# 件数の事前確認(DB に書かない)
npx tsx scripts/import-address-residences.ts --version 2026-08 --dry-run /path/to/folder

# 取込(東京都=約175万点・数分)
npx tsx scripts/import-address-residences.ts --version 2026-08 /path/to/folder

# 版の更新(都道府県一括のとき): --prune-stale で旧版の残存も掃除
npx tsx scripts/import-address-residences.ts --version 2027-08 --prune-stale /path/to/new-folder
```

`--version` は任意の版ラベル(取込年月がわかりやすい)。

## 2. 番データ(国土交通省 位置参照情報・街区レベル)

住居表示未実施の地域(地番ベースの住所)もカバーする補完層。地番地域では
照合値が**地番そのもの**なので、物件の地番欄への初期値提案(50m以内のみ)にも使う。

### 入手

1. 国土交通省「位置参照情報ダウンロードサービス」 https://nlftp.mlit.go.jp/isj/
2. **「街区レベル」**を選び、都道府県単位または市区町村単位でダウンロード
   - 直リンク形式: `https://nlftp.mlit.go.jp/isj/dls/data/<版>/<コード>-<版>.zip`
     - 例(東京都一括・2025年整備版): `.../24.0a/13000-24.0a.zip`
   - 最新版の番号はサイトで確認(2026-08-01 時点の最新 = `24.0a`)
3. zip を展開し、CSV をフォルダにまとめる(文字コードは Shift_JIS のまま・変換不要)

### 取込

```bash
npx tsx scripts/import-address-blocks.ts --version 24.0a --dry-run /path/to/csv-folder
npx tsx scripts/import-address-blocks.ts --version 24.0a /path/to/csv-folder
npx tsx scripts/import-address-blocks.ts --version 25.0a --prune-stale /path/to/new-csv-folder
```

## 共通の運用ルール

- `DATABASE_URL` が必要。**本番(VPS)では root で `set -a; . /etc/property-management/app.env; set +a`
  してから www-data で実行**(vps-deploy の他スクリプトと同じ流儀)。devDeps の tsx が必要なので
  `npm ci --include=dev` 後・`npm prune` 前に実行する。
- 取込は市区町村単位の全置換=同じデータの再実行は二重にならない。版の更新は
  **都道府県一括なら --prune-stale を付けて**旧版の残存(改称・合併で消えた旧市区町村名)も
  掃除する。残存があると取込後に警告が出る。
- 安全装置(両スクリプト共通): 不正行1%超のファイルは停止(--allow-skipped で強行) /
  行ゼロ(ヘッダのみ)のファイルは停止 / 文字コード破損は強行不可で停止 /
  既存の半分未満へ縮む置換は停止(--allow-shrink で強行) / 同時実行は県単位で直列化
- ⚠**取込エリアの境界の外**(例: 未取込の隣県側)でピンを打つと、境界越しに点を拾って
  隣県の住所が出ることがある(**営業エリアの都道府県は一括で取り込む**のが安全)。
  提案値は必ず確認する運用(号は自動判定のため隣の建物になることもある)

## 実測(2026-08-01〜02)

| 場所 | 号データ(第3弾) | 番データ(第2弾) |
|---|---|---|
| 西荻窪駅北口 | 西荻北3-19-4 (2m) | 西荻北3-1 (18m) |
| 荻窪駅北口 | 天沼3-3-5 (32m) | 上荻1-9 (19m) |
| 高円寺 | 高円寺北3-22-15 (14m) | 高円寺北2-6 (12m) |

※駅前広場など建物の無い場所では両者がずれる(どちらも「最寄りの点」のため)。
家の前で撮る通常の使い方では号データが最も正確。

## 仕組み(概要)

- テーブル: `address_residence_points`(号・migration `20260802020000`) /
  `address_block_points`(番・`20260801120000`+index `20260802010000`)。空なら挙動不変
- 照合はローカル DB で完結(**外部送信ゼロ**)。号(50m以内)→番(100m以内)→
  国土地理院(町丁目まで・座標のみ送信)の順にフォールバック
- 実装: `src/lib/address-blocks/`(parse-isj / parse-abr / nearest / lookup /
  residence-lookup / format / import-cli / import-files) +
  `src/app/api/field-survey/pins/[id]/suggest-address/route.ts`
