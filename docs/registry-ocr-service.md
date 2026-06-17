# Registry OCR Local Service — HTTP IF 仕様 / ops メモ

> scanned/printed 謄本 PDF（`likely_scanned`）の**下書きテキスト生成**に使う、VPS 上の
> **localhost 専用 PaddleOCR サービス**の契約と運用メモ。
>
> **Python サービス本体は本 repo の実装対象外（別 deploy 物）**。本 repo 側は
> `src/lib/registry-ocr/*`（gated client + localhost allowlist）と
> `POST /api/import/registry-pdf/ocr-draft`（admin 限定・OCR 未設定で 501）まで。
> OCR は「admin 確認前提の下書き生成補助」であり**自動確定しない**。raw OCR text・PDF 本文は
> **DB 非永続・ログ非出力**。設計詳細は `deliverables/21E/21E-registry-ocr-local-service-design.md`。

## 1. HTTP IF 契約（Node client ↔ PaddleOCR サービス）

### `POST /ocr`
- **Bind**: `127.0.0.1` のみ（外部・LAN へは bind しない）。Node 側 allowlist も
  `http://127.0.0.1:<port>/ocr` / `http://localhost:<port>/ocr` のみ許可（https/外部/private IP 拒否）。
- **Request**: `multipart/form-data`、フィールド `file`（PDF bytes）。
- **Response (200)**:
  ```json
  {
    "text": "OCR 抽出テキスト",
    "pages": 3,
    "warnings": ["low_confidence_page_2"],
    "elapsedMs": 12345
  }
  ```
  - `text`(string・必須) / `pages`(int>=0・必須) / `warnings`(string[]・既定 []) / `elapsedMs`(number・任意)。
  - Node 側 `ocrResponseSchema`（zod）で検証。不一致は `BAD_RESPONSE` で fallback。
- **エラー**: 破損 PDF / 空 PDF / size・page 上限超過 / timeout は 4xx/5xx を返す
  （Node 側は status 非 2xx を `UPSTREAM` 扱い → UI は手動貼付へ fallback）。

### リソース制限（Node ＋ Python の二重）
| 項目 | Node 側 | Python 側 |
|---|---|---|
| 最大 PDF サイズ | 8MB（`client.ts` MAX_PDF_BYTES） | 同等で再チェック |
| timeout | `REGISTRY_OCR_TIMEOUT_MS`（既定 60000ms・`AbortSignal.timeout`） | per-request / per-page timeout |
| 最大ページ数 | （Python 側で enforce） | `REGISTRY_OCR_MAX_PAGES`（推奨 30） |
| ラスタ化 DPI | — | 上限 300dpi |
| 同時処理数 | 逐次 | concurrency=1（低 volume・常駐 1 プロセス） |
| redirect | `redirect: "error"`（拒否） | — |
- 超過・失敗はすべて **OCR 失敗扱い → 手動貼付 fallback**。

### PII 不変条件
- OCR は同一 host 内 `127.0.0.1` のみ＝**外部送信ゼロ**。
- raw OCR text・PDF 本文・氏名・住所・地番・家屋番号・所有者名・個人名入りファイル名は
  **DB 非永続・access log/app log 非出力**。
- 監査は非PII のみ（`registry_ocr_draft`: status/pages/charCount/previewGenerated/errorCode）。

## 2. systemd ops メモ（本番有効化は別 ops 承認後）

- 専用ユーザーで実行（アプリと分離）。`127.0.0.1` bind。
- access log に本文（PII）を出さない。temporary directory は処理後に削除。
- systemd hardening:
  ```ini
  [Service]
  NoNewPrivileges=true
  PrivateTmp=true
  ProtectSystem=strict
  # 書込先は一時ディレクトリのみ。OCR モデルディレクトリは read-only。
  ReadWritePaths=/var/tmp/registry-ocr
  ReadOnlyPaths=/opt/registry-ocr/models
  ```
- CPU 推論前提・モデル重み数百 MB 規模を想定・常駐 1 プロセス or 低 concurrency で開始。
- **本番有効化手順（別承認）**: サービス起動 → 疎通確認 → app の `REGISTRY_OCR_URL` を
  `http://127.0.0.1:<port>/ocr` に設定 → app restart。env 未設定の間は OCR 無効（現行挙動維持）。

## 3. Python サービス側の将来テスト項目（本 repo 実装外）
- PDF→text / 空 PDF / 破損 PDF / timeout / size・page limit / 中間ファイル削除 / 本文非ログ。

## 4. repo 側スコープ（実装済 / 本 PR）
- `src/lib/registry-ocr/url-allowlist.ts`（strict localhost allowlist）
- `src/lib/registry-ocr/types.ts`（`ocrResponseSchema` / `RegistryExtraction` / `reliabilityFromConfidence`）
- `src/lib/registry-ocr/client.ts`（`isRegistryOcrConfigured` / `requestOcrText`・gated・fail-closed）
- `src/lib/registry-ocr/visibility.ts`（`shouldOfferOcrDraft` 純関数・UI 出し分け用）
- `src/app/api/import/registry-pdf/ocr-draft/route.ts`（admin + import:write・501 gate・DB 書込なし）
- `audit-log-detail-safety.ts` に `registry_ocr_draft` 登録（非PII）
- **UI seam（registry-pdf page の「OCRで下書き生成」ボタン）は follow-up PR**
  （`shouldOfferOcrDraft` を消費・admin かつ likely_scanned かつ configured のときのみ表示）。
