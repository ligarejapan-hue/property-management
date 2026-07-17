# 内蔵謄本 所在検索フル対応（候補検索 → 請求 → PDF取得）設計

- 日付: 2026-07-17
- 状態: 承認済み（段階実装: ①無料検索 → ②有料請求）
- 対象: `src/lib/registry-fetch/`（`auto-fetch.ts` の adapter が中心）＋呼び出し口ルート
- 前提: ログイン（認証）は PR#295/#297 で解決済み。本設計は**ログイン後の所在検索フロー本体**を実サイトの実手順に合わせて作り直す。

## 背景・問題

実機テストで謄本取得が `provider_error`（「謄本取得サービスでエラーが発生しました」）になる。原因は、現行 `searchByLocation` が実サイトの実フローと不一致であること（本番VPSの headless chromium probe で確定）:

- 所在検索は**ログイン直後の「請求情報受付メニュー」にはない**。「不動産請求」リンク（`a[href*="menuClick('FUDOSAN')"]`）で `/mypage/my-page?tab=fu`（請求事項入力画面）へ遷移した先にある。現行実装はこの遷移を欠く。
- 検索実行は単純な「次へ」一発ではなく、**「地番・家屋番号一覧」ボタン（`#fuChibanKaokuIchiran`）→ 地番検索ダイアログ**という多段UI。現行の `#myPageTable_next`（一覧ページネーション）は誤り。
- 実サイトの「所在検索」が返す候補は**地番のリスト**。実際の謄本（書類）取得には有料の「請求」操作が必須（サイト仕様）。

## ゴール

所在（＋地番）から謄本PDFを**アプリ内で自動取得**し物件へ添付する。検索が1件に定まれば自動で請求まで進み、複数なら候補を提示して利用者が選ぶ。お金の事故（誤請求・二重課金）を設計で防ぐ。

## スコープと段階

> ⚠ **重要な設計上の発見（2026-07-17 提出前レビュー）**: 既存の候補→取得パイプライン（`search.ts` の `obtainable` フィルタ・`candidate-cache.ts`・取得ルートの `resolveRegistryCandidate`）は **不動産番号(realEstateNumber)を検索時に得られる前提**で作られている。しかし実サイトの所在検索は不動産番号を返さず候補は**地番**（不動産番号は有料請求後にしか得られない）。このため:
> - 旧 `obtainable = candidates.filter(c => !!c.realEstateNumber)` は地番候補を全て捨てる→画面ゼロ件。段階①で **`candidateRef` ベースの表示フィルタに変更**して候補を表示する。
> - 取得（obtain）は不動産番号ベースの旧経路のままでは地番候補を扱えない（`resolveCachedCandidate` が null → 409・課金なし）。ユーザー決定（案A）で **段階①は取得ボタンを「準備中」で disabled にゲート**し、段階②で地番ベースの請求→PDF取得に作り直す。
> - 安全: 取得 API はサーバ側で地番候補に 409（課金なし）を返すため、表示フィルタを広げても誤課金は起きない。UI のゲートは誤操作の体験改善。

**段階①（無料・先行）**: 所在検索を実フローに合わせて作り直し、**地番候補一覧を返す**まで。課金なし（請求・確定はしない／ダイアログはキャンセルで閉じる）。検索失敗の診断ログを追加。**呼び出し側 `search.ts` の表示フィルタを `candidateRef` ベースへ変更＋UI の取得ボタンを「準備中」でゲート**（案A・ユーザー決定 2026-07-17）。取得の実装（地番ベース）は段階②。
**段階②（有料・後続）**: 選ばれた1候補を**請求（課金）→ 謄本PDFダウンロード → 物件添付**。検索が1件なら自動で②へ、複数なら利用者選択後に②。お金の安全機構を実装。②は実装後に**御社承認のもと1回だけ実課金の通しテスト**で検証（無料ドライランは原理的に不可）。

本設計書は全体（①②）を記述し、実装計画（plan）で①→②に分割する。

## 実サイトのフロー（probe で確定済み・座標は非PIIの構造のみ）

1. ログイン（既存）→ 二重ログインなら強制ログイン突破（既存）。
2. 「不動産請求」: `a[href*="menuClick('FUDOSAN')"]` を DOM click → `/mypage/my-page?tab=fu`。
3. 請求方法=所在: `#fuSeikyuMethodSHOZAI`（radio name=seikyuMethod value=SHOZAI）。
4. 種別: 家屋番号あり=建物 `#fuShozaiTypeTATEMONO` / なし=土地 `#fuShozaiTypeTOCHI`。
5. 都道府県: `#fuTodofukenShozai`（select・option は表示ラベル「東京都」等）。
6. 直接入力ON: `#fuShozaiChokusetuNyuryoku`（checkbox）。
7. 所在（市区町村以下）: `#fuChibanKuiki`（text）。地番: `#fuChibanKaoku`（text）。
8. 地番検索ダイアログを開く: `#fuChibanKaokuIchiran`（onclick=fuBtnChibanKaokuIchiran()）。
9. ダイアログ（`#cbnDlgChibanDialog`）内:
   - 地番種別: `#cbnDlgChibanType0`（数字/ハイフンのみ）/`#cbnDlgChibanType1`。
   - 地番範囲: `#cbnDlgSearchChibanStart`（〜`#cbnDlgSearchChibanEnd`）。
   - 検索: `#cbnDlgChibanSearch`（GFuChibanDialog.btnChibanSearch）。
   - 結果テーブル: `#cbnDlgChibanCheckTbl`。**検索は非同期ロード**＝クリック直後は「データ取得中・・・」表示。行が現れるまで待つ（"データ取得中" を含まなくなり checkbox 行が入るまでポーリング）。
   - **候補行構造（probe 確定・2026-07-17）**: 各 `<tr>` に `td.col_w1 > input[type=checkbox]#cbnDlgChibanChk_{N}`（onclick=GFuChibanDialog.chkChibanChk）＋ `td.col_w2#cbnDlgChibanDt_{N}` に地番テキスト（例「１－１」「１－２」…全角）。1所在の地番範囲検索で数十件返る（例 千代田区丸の内一丁目・範囲1 → 「１－１」〜59件）。
   - ページ: `#cbnDlgBtnPageNext`/`#cbnDlgBtnPageBefore`。確定: `#cbnDlgBtnOk`。取消: `#cbnDlgBtnCancel`。
   - 選択反映: `#cbnDlgCheckedChibanString`/`#cbnDlgCheckedChibanDsp`/`#cbnDlgCheckedChibanSeqNo`。
10. 【②のみ】確定でメイン画面へ地番が反映 → 請求事項の種類（`#fuAll` 全部事項 / 所有者事項ラジオ等・既定=所有者事項）→ 確定（`fuBtnForward()`・id無 text「確定」）で請求リスト（`#fudosanIchiranTbl`）へ → 請求（`#myPageSeikyu`・**課金**）→ 表示・保存（PDFダウンロード）。

> ✅ **候補行構造は確定済み（2026-07-17 probe）**: 上記のとおり `#cbnDlgChibanChk_{N}`＋`#cbnDlgChibanDt_{N}`・非同期ロード待ち。段階①はこの構造で実装できる。
> ⚠ **[要live・段階②のみ・実課金]**: 請求ボタン（`#myPageSeikyu`）確定後の**ダウンロード発火**（`waitForEvent("download")` かボタン `表示・保存`）は実課金でのみ最終確認。段階②の通しテストで御社承認のもと1回確認する。

## 設計（部品と責務）

`RegistryBrowserPage`（`official-provider.ts` の interface）を拡張し、DOM 操作は `auto-fetch.ts` の adapter に閉じ込める既存構造を踏襲する。

### 段階①: `searchByLocation`（作り直し・無料）

- 入力: `{ address, lotNumber?, buildingNumber? }`（既存シグネチャ維持）。
- 手順: 上記フロー 2〜9（ダイアログ検索まで）。`#cbnDlgChibanCheckTbl` の各行を `RegistryCandidate[]` に変換して返す。
- **課金しない**: `#cbnDlgBtnOk`（確定）を押さず、`#cbnDlgBtnCancel` でダイアログを閉じてから `close()`。
- 候補 = 所在＋地番（＋非PII参照 `candidateRef`＝行の seq/選択文字列）。`realEstateNumber` は所在検索段では得られない（サイト仕様）ため null 許容。
- 純関数 `extractChibanCandidateRows(els)` を `$$eval` に渡して抽出（self-contained・既存 `extractLocationCandidateRows` を実構造へ改訂）。
- 住所分解 `splitAddressForLocationSearch`（既存・都道府県/所在）を再利用。
- 失敗時: `provider_error`/`timeout` を段階別に分類し、**診断ログ**（`summarizeRegistryLoginError` と同方針で secret/PII 除去）を `console.warn("[registry-search] ...")` に残す。

### 段階②: `requestAndDownloadByCandidate`（新規・有料）

- 入力: 候補（所在/地番/参照）＋ `certificateType`（既定 所有者事項）。
- 手順: フロー 2〜9 を再走行し**その候補の地番を選択**（`#cbnDlgChibanCheckTbl` で該当行 check → `#cbnDlgBtnOk`）→ 10（請求事項選択 → 確定 → 請求＝課金 → ダウンロード）。
- 返り値: 謄本 PDF `Buffer`（既存 `downloadRegistryPdf` と同じ扱い）。
- provider は `OfficialRegistryProvider` に**新メソッド**（例 `fetchByLocationCandidate`）を追加。`fetchRegistryPdf` と同じ安全構造（throttle → browserFactory → 起動timeout → login → … → 必ず close）。

### 呼び出し口（ルート）オーケストレーション

- 検索ルート（`/registry/search`）: ①を実行し候補を返す。
- 取得ルート（`/registry/auto-fetch` 拡張 or 新ルート）: 候補1件を受けて②を実行。
- **1件自動化**: 検索結果が**ちょうど1件**なら、検索ルート（またはオーケストレータ）が続けて②を呼ぶ。複数なら候補を返して UI で選択 → 選択が②を呼ぶ。この「1件で自動②」判定はサーバ側で行う（クライアント改ざんで誤請求させない）。

## お金の安全機構（②の必須要件）

- **同時実行の直列化**: プロセス内 mutex（Promise chain）で②を1件ずつ逐次化。既存 throttle（開始間隔30秒）は残すが、それだけでは重なりを防げない（@codex 指摘対応）。実行中操作と stale セッションを区別してから強制ログインする（実行中の自分の請求を切らない）。
- **二重課金防止（冪等）**: 同一物件＋地番で直近に取得済み（添付済み or 進行中ロック）なら再請求しない。取得ルートのロック（`auto-fetch` の行指紋ロック）を踏襲・拡張。
- **失敗時に自動リトライしない**: 請求（課金）ステップ以降の失敗は自動再試行せず、明示エラーで停止（空振り・二重課金回避）。
- **確認フラグ**: 取得ルートは `confirmed:true` 必須（検索ルートと同様）。1件自動化でもサーバ側で確認境界を通す。
- **診断ログ**: ②各段の失敗も secret/PII 除去のうえ `console.warn("[registry-fetch] ...")` に残す。

## 認可・PII

- 権限: 既存 `registry:auto_fetch` ＋ `property:read/write`（新 permission は作らない）。取得（添付）は `property:write` 相当。
- PII: 候補（所在/地番）・謄本内容・資格情報を**ログ/監査 detail/エラー応答に出さない**（既存方針）。監査は非PII の件数/結果コードのみ。中間成果物（Cookie/DL/スクショ）は adapter で永続せず即破棄。

## テスト方針

- 単体: fake page 注入で①②の DOM 操作順序・候補抽出・課金安全（mutex/冪等/非リトライ）・エラー分類を検証（実 Playwright/実サイト非依存）。既存 `playwright-adapter.test.ts` 方式（selector/state/呼び出し順のアサート）。
- 純関数 `extractChibanCandidateRows`・住所分解・1件自動化判定をユニットで固定。
- 実サイト: ①は無料検索1回で候補行構造を確定（実装時）。②は御社承認のもと実課金1回で通し確認（マージ・反映後）。

## 段階と受け入れ

- **段階①**: `searchByLocation` 作り直し＋診断ログ＋候補抽出。全ゲート緑＋無料probeで候補一覧を実サイトから取得。→ PR・反映・実機で「候補一覧が出る」確認。
- **段階②**: 請求＋ダウンロード＋安全機構＋オーケストレーション。全ゲート緑。→ PR・反映・**実課金1回の通しテスト**で謄本PDF添付を確認。

## 非対象（YAGNI）

- 番号（不動産番号）検索の変更（既存 `searchByRealEstateNumber` は据え置き）。
- 複数候補の一括請求（1件ずつ・利用者選択）。
- 請求事項の複雑な組合せ（既定=所有者事項＋既存 certificateType の範囲）。
