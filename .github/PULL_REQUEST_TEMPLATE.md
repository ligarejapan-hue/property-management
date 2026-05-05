## 概要
<!-- このPRで何をしたか、1〜3行で記述 -->

## 関連 Issue
Closes #

## 変更ファイル
<!-- 主要な変更ファイルをリストアップ -->
- 

## 変更内容
<!-- 何をどう変えたか。コード全文ではなく差分・要点のみ -->

## 変更しない範囲
<!-- このPRで意図的に触れていない領域 -->

---

## DB migration
- [ ] migration あり（`prisma/migrations/` に追加済み）
- [ ] migration なし

migration がある場合：
- 後方互換性：
- 本番反映手順・ダウンタイム有無：
- ロールバック手順：

## 環境変数変更
- [ ] 変更あり（`.env.example` / `app.env` への追記内容を記載）
- [ ] 変更なし

---

## テスト結果

```
npm run build: 
npx vitest run: 
```

追加・変更したテスト：

---

## Codex レビュー確認
- [ ] セキュリティ・権限チェックに問題なし
- [ ] DB / データ破壊リスクなし
- [ ] CSV import / rollback / audit log / upload / storage への影響なし
- [ ] Blocker 指摘がない、または対応済み

---

## VPS 反映要否
- [ ] 必要（反映コマンドを下記に記載）
- [ ] 不要

反映コマンド（必要な場合）：
```bash
cd /opt/property-management
sudo -u www-data git pull origin main
sudo -u www-data npm run build
sudo systemctl restart property-management
sudo systemctl is-active property-management
```

## rollback 方法
<!-- このPRをrevertする手順、またはDBロールバックが必要な場合の手順 -->

## 残リスク
<!-- マージ後に懸念される点、継続監視が必要な事項 -->
