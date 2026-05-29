## 概要
<!-- このPRで何を変更するか、1〜3行で記述 -->

## 関連 Issue
Closes #

---

## 変更内容
<!-- 何をどう変えたか。コード全文ではなく差分・要点のみ -->
-

**主要な変更ファイル**
-

**変更の種別**
- [ ] docs / config-only（アプリコード・schema 非変更）
- [ ] 実装変更あり

**影響範囲**
- migration：[ ] あり（`prisma/migrations/` に追加済み） / [ ] なし
- schema 変更（`prisma/schema.prisma`）：[ ] あり / [ ] なし
- API 変更：[ ] あり / [ ] なし
- 環境変数変更（`.env.example` / `app.env`）：[ ] あり / [ ] なし

### 変更しない範囲
<!-- このPRで意図的に触れていない領域 -->

---

## 確認項目
- [ ] `git diff --check` 実行済み（問題なし）
- build / test 実施結果：
  ```
  npm run build:
  npx vitest run:
  ```
- [ ] docs / config-only のため build / test は実施せず（理由を記載：）
- migration deploy：[ ] 必要（本番反映時 `prisma migrate deploy`） / [ ] 不要
- [ ] VPS 未反映であることを確認（反映はユーザー明示時のみ）

migration がある場合：
- 後方互換性：
- 本番反映手順・ダウンタイム有無：
- ロールバック手順：

---

## セキュリティ・レビュー観点
<!-- 該当しない項目は「該当なし」と明記 -->
- [ ] PII（所有者名・住所・電話・メール・法人番号等）の漏洩なし（UI / console / ログ / AuditLog / エラー文）
- [ ] GPS / 位置情報・緯度経度の漏洩なし
- [ ] raw response / rawData の漏洩なし
- [ ] API key / token / env 値の漏洩なし
- [ ] AuditLog は最小情報のみ（生PII・大量座標・認証情報を記録していない）
- 権限 / role / permission の変更：[ ] なし / [ ] あり（内容を記載：）
- rollback / data correction への影響：[ ] なし / [ ] あり
- storage / upload / path traversal への影響：[ ] なし / [ ] あり

---

## Codex review
- Codex review：[ ] 推奨 / [ ] 不要
- 推奨理由（DB / migration / 権限 / PII / AuditLog / import / rollback / storage / GPS / security 等）：
- `needs-codex-review` ラベルを付けると、CI green 後に `@codex review` 自動依頼の対象になります（opt-in 運用）。

---

## 運用ルール確認
- [ ] main へ直接 push していない
- [ ] force-push していない
- [ ] merge はユーザー側で行う
- [ ] VPS 反映はユーザー明示時のみ（このPR単体では未反映）

VPS 反映コマンド（必要な場合）：
```bash
cd /opt/property-management
sudo -u www-data git pull origin main
sudo -u www-data npm run build
sudo systemctl restart property-management
sudo systemctl is-active property-management
```

---

## 残リスク
<!-- マージ後に懸念される点、継続監視が必要な事項 -->
