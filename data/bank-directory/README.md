# 金融機関・支店の名簿(控え)

取引の「お金の受け渡し」と取引の設定の口座で、銀行名・支店名の候補に使うデータです。

- `zengin.json`: 金融機関と支店の略称・読み・ローマ字(1金融機関1行)
- 出典: [zengin-code/source-data](https://github.com/zengin-code/source-data)(MIT License・元データは ykaku.net)
- どの版か: ファイルの先頭の `version`・`commit`・`updatedAt`

## 本番の表に入れる

```
npx tsx scripts/import-bank-directory.ts --dry-run   # 件数だけ見る
npx tsx scripts/import-bank-directory.ts             # 全件入れ替え
```

取引に入れた口座は名前の文字で持っているので、入れ替えても変わりません。

## 新しくする

```
git clone --depth 1 https://github.com/zengin-code/source-data.git <置き場所>
npx tsx scripts/build-bank-directory-snapshot.ts <置き場所>
```

`zengin.json` が書き換わるので、差分を PR にしてから本番で入れ直します。
