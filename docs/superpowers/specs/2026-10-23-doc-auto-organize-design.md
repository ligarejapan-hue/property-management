# 書類の自動整理・スマホ撮影・Google ドライブ連携 設計書

- 日付: 2026-10-23
- 元の依頼: 発注者「添付ファイルの自動整理(契約関係書類と決済関係書類)。フォルダ分け、Google driveとの連携」「携帯のカメラを使った外出先からのファイル自動生成、保存」
- 画面案(了承済): https://claude.ai/artifact/5NsaSCdafWymBrGM5nCr3h
- 隣の設計との関係: `2026-10-23-deals-documents-design.md`(取引・帳票)は**アプリが作る書類**(精算書・ご案内・領収書など)を `deals/<取引ID>/` に置く。本設計は**外から入ってくる書類**(添付)を整理する。表は触り合わない。第2段(ドライブ)で取引の発行物も同じフォルダへ複製するかは、その段で決める。

## 0. 発注者の決定(2026-10-23)

- 自動整理の中身 = 種類を自動で当てる + ファイル名をそろえる + 物件へ振り分ける
- 物件への振り分けは**候補を出して人が確認**(添付は自動にしない。誤リンク事故 2026-09-10 の教訓・査定報告書の受け取り箱と同じ守り)
- Google ドライブ = 今の Gmail のマイドライブ・**双方向**・今ある物件フォルダをそのまま使う・権限を広げる認可のやり直しは可
- スマホで撮るもの = 書類(PDF化)と現地写真の両方。撮った書類の種類は**文字読み取り(OCR)で自動**
- 未回答で推奨どおり進める点: 判別表は画面案のまま/名前は `種類_物件名 号室_YYYYMMDD`/順番は 第1段 → 第2段 → 第3段。ドライブ側で人が置いたファイルの付け直しは第2段の前に伺う

## 1. 段階(フォルダ)と種類

| 段階 | code | 種類(code) |
|---|---|---|
| ① 調査資料等 | `pre_contract`(code は初版「契約前」のまま=DB の値を変えないため) | 媒介契約書 `brokerage_agreement` / 査定書・査定報告書 `appraisal_report` / 公図・測量図・建物図面 `drawings` / 評価証明・公課証明 `tax_certificate` |
| ② 管理関係 | `management` | 重要事項調査報告書 `mgmt_report` / 管理規約・使用細則 `bylaws` / 長期修繕計画 `repair_plan` / 総会・理事会の議事録 `assembly_minutes` / 管理費・修繕積立金の通知 `mgmt_fees` |
| ③ 契約関係 | `contract` | 売買契約書 `sales_contract` / 重要事項説明書 `disclosure` / 付帯設備表 `fixtures_list` / 物件状況告知書 `condition_report` / 手付金 領収書・預り証 `deposit_receipt` |
| ④ 決済関係 | `settlement` | 決済のご案内 `settlement_notice` / 精算書 `settlement_statement` / 領収書(残代金・仲介手数料) `settlement_receipt` / 取引完了確認書 `completion_confirmation` / 区分所有者変更届・口座振替依頼書 `owner_change_forms` / 鍵・引渡し関係 `key_handover` |
| ⑤ 賃貸関係 | `rental` | 賃貸借契約書 `lease_contract` / レントロール `rent_roll` / 管理委託契約書(賃貸) `pm_agreement` / 入居者(賃借人)の情報 `tenant_info` / 敷金・保証金 `security_deposit` / 更新の覚書 `renewal_memo` / 解約通知 `termination_notice` / 所有者変更通知(入居者あて) `owner_change_notice` |
| 本人確認(番号なし・最後) | `identity` | 本人確認書類 `identity_document` |
| その他 | `other`(列は NULL) | 種類なし |

- 並びは発注者決定(2026-10-23 夜)。⑤賃貸関係は**現況が賃貸中(`occupancyStatus="rented"`)のときだけ**空でも出す。賃貸中でなくても中に書類があれば出す。
- 添付タブで最初に開く段階: 契約予定→③契約関係・契約完了/決済完了→④決済関係・それ以外→①調査資料等。

- 写真(画像で文字がほぼ無いもの)は第3段で写真タブへ。第1段では画像は名前だけで判別し、当たらなければ「その他」。
- 謄本(`type="registry"`)は今のまま別枠。段階・種類は付けない。
- 反響資料(`referral`)・査定報告書(`report`)の既存の種類はそのまま(配信の守りを変えない)。`report` には段階 ① と種類 `appraisal_report` を付ける(第1段では付けず、受け取り箱を広げる第1段bで扱う)。

## 2. データ(Attachment に列を足すだけ)

| 列 | 型 | 意味 |
|---|---|---|
| `doc_stage` | text NULL | 段階 code。NULL = その他 |
| `doc_kind` | text NULL | 種類 code。NULL = 種類なし |
| `doc_title` | text NULL | そろえた名前(拡張子つき)。NULL = 元の名前のまま |
| `doc_confidence` | text NULL | `high`(名前か見出しで確定)/`low`(本文の語だけ・人の確認待ち)/`manual`(人が決めた) |

migration は ADD COLUMN ×4 のみ。既存の行は NULL(=その他・元の名前)。

## 3. 判別(純関数 `src/lib/doc-classify/`)

- `normalizeForMatch`: NFKC → 空白除去 → 小文字。
- `classifyDocument({ fileName, text })`:
  1. ファイル名に種類の語があれば、その種類・`high`
  2. なければ本文(PDF の抽出文字)の先頭 3,000 文字で探す。見出し域(先頭 400 文字)で見つかれば `high`、それより後ろなら `low`。複数の種類が見つかったら最も前に出た種類
  3. 「領収書」は手付・預り → `deposit_receipt`、残代金・残金・仲介手数料・精算 → `settlement_receipt`、どちらも無ければ `settlement_receipt` の `low`
  4. どれにも当たらなければ `null`(その他)
- `extractDocumentDate(text)`: 本文の先頭 3,000 文字から `YYYY年M月D日` または `令和N年M月D日`(元号は既存の `warekiToSeireki` の表)の最初の1つ。無ければ null。
- `buildDocTitle({ kindLabel, buildingName, roomNo, address, date, ext })` → `種類_物件名号室_YYYYMMDD.ext`。物件名が無ければ所在地(郵便番号を外し空白を除いたもの)。ファイル名に使えない文字は `_`。同じ名前が既にあれば `_2`、`_3`。
- `defaultOpenStage(caseStatus)`: `contract_planned` → ② / `contracted`・`sold` → ③ / それ以外 → ①。

## 4. API

- `POST /api/properties/[id]/attachments`(既存): `general` のとき、PDF なら本文を抽出(失敗しても登録は続ける)して判別し、4列を埋める。画像・Excel などは名前だけ。
- `PATCH /api/properties/[id]/attachments/[attachmentId]`(新規): body `{ docKind: string | null }`。権限は削除と同じ(property:write + 担当の範囲)。`registry` は 422。種類から段階を決め、名前を作り直し(日付は今の名前の日付を引き継ぐ・無ければ登録日)、`doc_confidence = manual`。親の物件行をロックした tx の中で更新。監査 `update`(detail は propertyId と docKind だけ)。
- `GET`(既存)は列が増えるだけ。

## 5. 画面(添付タブ)

- 通常添付を段階ごとの折りたたみ(①②③④その他)に分けて出す。件数つき。案件ステータスに合わせて今の段階を開いた状態にする(`defaultOpenStage`)。
- 行の名前は `doc_title`(無ければ元の名前)。元の名前と違うときは小さく「元: …」。
- `doc_confidence = low` または `doc_kind` が無い PDF には「種類を確認」のしるし。押すと種類の選択(段階ごとに分けた一覧+その他)が出て、選ぶと PATCH → 一覧を読み直す。
- ダウンロード名は `doc_title`(`download` 属性。通常添付は Content-Disposition を付けていないので属性が効く)。
- 謄本の枠は今のまま。

## 6. 段(1段=1 PR)

| 段 | 中身 | 承認が要るもの |
|---|---|---|
| 1a 土台 | 列4つ・判別の純関数・POST での自動判別・PATCH・添付タブの段階表示と種類の直し・ヘルプ/資料 | migration 1本(列追加のみ) |
| 1b 受け取り箱 | 「査定報告書の受け取り箱」を全書類へ広げる(候補の根拠・種類の判別・段階) | なし |
| 2 ドライブ | 別の接続(drive 全体)・物件とフォルダの紐づけ画面・5分ごとの見回り・アプリ→ドライブの複製・往復防止・削除は同期しない | Cloud Console の権限追加と認可(発注者)・app.env の合言葉・timer |
| 3 撮影 | 物件画面とホームの「📷 撮る」・連続撮影→サーバーで PDF 化(Pillow/pikepdf)・Tesseract で文字読み取り→判別・現地写真は写真タブへ | Tesseract と日本語辞書の apt 導入 |

過去分の一括判別・名前の付け直しは、1a が入って結果を見てから別に判断してもらう(勝手に名前を変えない)。

## 7. テスト

- 判別・名前・日付・段階の純関数: 表のすべての種類に1件以上、名前一致/見出し一致/本文一致/当たらない/領収書の振り分け/重複名の連番/使えない文字。
- PATCH route: 権限・404・registry 422・未知の種類 422・manual になる・監査に名前を出さない。
- POST route: PDF で判別が入る・抽出が落ちても 201・画像は名前だけ。
- 添付タブ: 段階ごとの分け方(純関数)と、開く段階の決め方。
