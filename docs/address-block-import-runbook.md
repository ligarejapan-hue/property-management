# 住所自動入力: 街区データ(番まで)の取込 runbook

「ピンの位置から住所を入力」を**番まで**(例: 東京都杉並区西荻北3-1)にするためのデータ取込手順。
データが無い地域は自動で従来どおり国土地理院(町丁目まで)にフォールバックするので、
**取込は営業エリアの分だけでよい**。

## データの入手(年1回程度の更新)

1. 国土交通省「位置参照情報ダウンロードサービス」 https://nlftp.mlit.go.jp/isj/
2. **「街区レベル」**を選び、都道府県単位(例: 東京都)または市区町村単位でダウンロード
   - 直リンク形式: `https://nlftp.mlit.go.jp/isj/dls/data/<版>/<コード>-<版>.zip`
     - 例(東京都一括・2025年整備版): `.../24.0a/13000-24.0a.zip`
     - 例(杉並区のみ): `.../24.0a/13115-24.0a.zip`
   - 最新版の番号はサイトで確認(2026-08-01 時点の最新 = `24.0a`)
3. zip を展開し、CSV をフォルダにまとめる(文字コードは Shift_JIS のまま・変換不要)

出典表記: アプリ側 UI が「出典: 国土交通省 位置参照情報」を表示する(位置参照情報
ダウンロードサービス利用約款に基づく出典明記)。

## 取込コマンド

```bash
# 件数の事前確認(DB に書かない)
npx tsx scripts/import-address-blocks.ts --version 24.0a --dry-run /path/to/csv-folder

# 取込(市区町村単位で全置換 = 再実行しても二重にならない)
npx tsx scripts/import-address-blocks.ts --version 24.0a /path/to/csv-folder
```

- `DATABASE_URL` が必要。**本番(VPS)では root で `set -a; . /etc/property-management/app.env; set +a`
  してから www-data で実行**(vps-deploy の他スクリプトと同じ流儀)。devDeps の tsx が必要なので
  `npm ci --include=dev` 後・`npm prune` 前に実行する。
- 版の更新時は同じコマンドを新しい CSV で再実行するだけ(全置換)。

## 目安(実測 2026-08-01)

- 杉並区 = 7,387 点(zip 130KB)・取込数秒。東京都全体 ≒ 15万点程度
- 照合精度: 西荻窪駅北口→西荻北3-1(18m) / 荻窪駅北口→上荻1-9(19m) / 高円寺→高円寺北2-6(12m)
- 号(-8 など)はこのデータに含まれない = 利用者が現地で確認して追記する

## 仕組み(概要)

- テーブル `address_block_points`(migration `20260801120000`)。空なら挙動不変
- 照合はローカル DB で完結(**外部送信ゼロ**)。ピンから150m以内に点が無ければ
  国土地理院(町丁目まで・座標のみ送信)へフォールバック
- 実装: `src/lib/address-blocks/`(parse-isj / nearest / lookup / format) +
  `src/app/api/field-survey/pins/[id]/suggest-address/route.ts`
