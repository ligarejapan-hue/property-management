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
| 1b 受け取り箱 | 「査定報告書の受け取り箱」を「書類の受け取り箱」へ(下の §6.1) | migration 1本(列追加のみ) |
| 2 ドライブ | 別の接続(drive 全体)・物件とフォルダの紐づけ画面・5分ごとの見回り・アプリ→ドライブの複製・往復防止・削除は同期しない | Cloud Console の権限追加と認可(発注者)・app.env の合言葉・timer |
| 3 撮影 | 物件画面とホームの「📷 撮る」・連続撮影→サーバーで PDF 化(Pillow/pikepdf)・Tesseract で文字読み取り→判別・現地写真は写真タブへ | Tesseract と日本語辞書の apt 導入 |

過去分の一括判別・名前の付け直しは、1a が入って結果を見てから別に判断してもらう(勝手に名前を変えない)。

### 6.1 第1段b 書類の受け取り箱(2026-10-24・発注者決定: 使える人は今のまま/本人確認書類は開ける人を絞る)

- 受けるもの: PDF(50MB・8MB 超は圧縮)に加えて、物件の添付と同じ種類(画像・Excel・Word・CSV・20MB)。PDF 以外は本文を読まない。
- 受け取ったときに決めるもの(`report_inbox_items` に列を足す=`mime_type`・`doc_kind`・`doc_stage`・`doc_confidence`・`doc_date`): 種類・段階(名前→本文の順・§3 の表)、本文の日付、物件の手がかり(今の見出し読み。見出しに名前が無ければ**登録済みの物件名を本文から探す**=`findKnownBuildingName`・呼び出した人が開ける物件の名前だけ)。
- 添付: `{ propertyId, docKind? }`。人が種類を選び直せば `manual`。
  - 査定報告書(SRE の書式、または種類が 査定書・査定報告書)= 今までどおり `report`(定型名・ファイルは写さない・開けるのは所有者情報を見られる人・案件ステータス「査定中」への自動切替)。種類の列には `appraisal_report`(①調査資料等に出す)。
  - それ以外 = `general`。**ファイルを物件の置き場所へ写してから**付ける(`report-inbox/` の下は所有者情報の守りがかかるため、通常の書類はそこを指さない)。写した後に記録を切り替えられなければ写しを消して 409。付け終えたら受け取り箱の側のファイルを消す(消せなくても害はない)。
- 画面: 名前を「書類の受け取り箱」に。行に種類の選択(段階ごと)と「種類を確認」のしるし。「報告書を開く」→「開く」。
- 本人確認書類の閲覧制限(種類 `identity_document` の添付は所有者情報を見られる人だけ・ブラウザに控えさせない)は、**別の PR(1c)**で uploads-authorization に足す(守りの変更は単独でレビューする)。

### 6.2 第1段c 本人確認書類の閲覧制限(2026-10-24)

- 守り: `uploads-authorization` の PII 判定を「行の type」から「行の type と docKind」へ(`isOwnerPiiDocument`)。`docKind=identity_document` の添付は type が general でも反響資料・査定報告書と同じ=開けるのは所有者の項目をすべて素通しで見られる人・削除済みでも守りは外れない(sticky)・配信は no-store・手元に落ちる名前は定型 `本人確認書類_YYYY-MM-DD.<ext>`(`identity-display-name.ts`)。
- 種類の変更(PATCH): 本人確認書類への変更・からの変更は、その書類を開ける人だけ(物件を編集できるだけの人が「その他」に直して守りを外せない)。判定は読んだ時点とロック後に読み直した行の両方で(同時操作で守りを外せない)。
- 同じ PII 判定を使う場所もすべて docKind 対応: 反響の資料送付の候補と送る直前の判定(本人確認書類は送らない)・添付のお掃除(削除済みの本人確認書類の記録も、同じファイルを他の記録が指す間は残す=保持期限後も sticky が崩れない)。
- 画面は変えない(一覧には出る・開くと 403/404)。資料に1文。DB 変更なし。

### 6.3 第2段 Google ドライブ双方向(2026-10-24 設計・発注者決定: ドライブ側で人が置いたファイルの名前は触らない/認可は実装ができてから)

**ねらい**: 発注者の Google ドライブ(ligare.japan@gmail.com のマイドライブ・物件ごとのフォルダ)とアプリの添付を往復させる。アプリが触るのは**物件に紐づけたフォルダの中だけ**。削除は同期しない。人が置いたファイルの名前は変えない(アプリに取り込んだ写しだけ、そろえた名前にする)。

**接続(バックアップ用の rclone とは別)**
- Google Cloud Console(既存の案件 `pm-backup`)に **ウェブ アプリケーション型の OAuth クライアント**を1つ足す(今の rclone 用はデスクトップ型で、ブラウザの戻り先を登録できない)。スコープ=`https://www.googleapis.com/auth/drive`(ドライブ全体の読み書き・人が置いたファイルを見るため)。戻り先=`https://property-management.tail182d6b.ts.net/api/drive/oauth/callback`。クライアント ID・シークレットは app.env(`GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET`)=個別承認。
- 認可はアプリの画面から: 管理 › ドライブ連携 の「Google に接続」→ Google の同意画面 → 戻り先で refresh token を受け取り、`drive_connection`(1行)に **暗号化して保存**(`secret-crypto.ts` の `encryptSecret`=メール設定のパスワードと同じ守り)。state は CSRF 対策の乱数(セッションに紐づけ・10分)。接続できる・切れるのは管理者だけ。アクセストークンは都度 refresh(メモリに短時間だけ)。
- Google の API は `fetch` で直接呼ぶ(npm の新しい部品なし)。使う口: `files.list`(フォルダの一覧・候補探し)・`files.get?alt=media`(取り込み)・`files.create`(multipart・複製)・`files.update`(自分が置いた写しの名前の付け直しだけ)・`changes.getStartPageToken` / `changes.list`(見回り)。

**データ(migration 1本・足すだけ)**
- `drive_connection`: id(singleton)・account_email・refresh_token_enc・start_page_token(見回りの続き)・last_sync_at・last_error・consecutive_failures・connected_by・updated_at。
- `property_drive_folders`: id・property_id(unique)・folder_id(unique)・folder_name・folder_path(表示用「ハマイハイライズ 305 › 売却」)・linked_by・created_at。1物件=1フォルダ(売却|購入 の下の階層を紐づける)。
- `drive_sync_files`(往復の台帳=重複と往復ループの防止): id・folder_link_id・drive_file_id(unique)・md5・name(⚠表示は管理画面だけ)・mime_type・size・modified_time・direction(`in`=ドライブ→アプリ / `out`=アプリ→ドライブ)・attachment_id?・status(`imported`|`inbox`|`duplicate`|`unsupported`|`failed`)・error・created_at。
- `attachments.drive_file_id String?`(アプリ→ドライブの写しの id・「ドライブ同期済」のしるし)。

**物件とフォルダの紐づけ(管理 › ドライブ連携・管理者)**
- 接続の状態(アカウント・最後の見回り・連続失敗)・「Google に接続」「接続を切る」。
- フォルダの一覧: マイドライブ直下のフォルダ(名前順・検索)→ 中の「売却|購入|仕入|販売」を選ぶ。右に**アプリの物件の候補**(純関数 `matchFolderToProperties`: フォルダ名から建物名と号室を切り出し、`buildingName`+`roomNo` の一致=「名前一致」、所在地の町名一致=「住所が近い」。根拠の無い候補は出さない)。「紐づける」/「物件を選ぶ」(検索)/「外す」。紐づけ・外しは監査ログ(物件 ID とフォルダ ID だけ・フォルダ名は書かない)。
- 紐づけた物件の添付タブに「ドライブ: フォルダ名 › 開く」(ドライブへのリンク・`<a target=_blank>`)。
- 2024 年分など**別アカウントが所有するフォルダ**も、共有されていれば一覧に出る(所有者を小さく表示)。

**見回り(timer 5分ごと・`POST /api/drive/sync-run`・合言葉 `DRIVE_SYNC_SECRET`・未設定なら 503 で休眠・proxy の公開パスに追加)**
1. アプリ → ドライブ(複製): 紐づけた物件の添付で `type=general`・未削除・`drive_file_id` が空のもの → 段階のフォルダ(無ければ作る。既存の「契約資料・契約書類・契約書類関係」は③契約関係として、「決済資料・決済関係」は④決済関係として**そのまま使う**=名前は変えない)へ、そろえた名前(`docTitle` ?? 元の名前)で `files.create`。`appProperties: { pmAttachmentId, pmSource: "app" }` を付ける(往復防止の目印)。写しの id を `attachments.drive_file_id` に。種類を直して名前が変わったら、自分が置いた写しだけ `files.update` で名前を合わせる。⚠謄本(`registry`)・反響資料(`referral`)・査定報告書(`report`)・**本人確認書類(`docKind=identity_document`・発注者決定 10-24「複製しない」)**は複製しない(課金した原本・所有者情報の守りの対象=`isOwnerPiiDocument` で判定)。1回の見回りで最大 20 件・1件 20MB まで。
2. ドライブ → アプリ(取り込み): `changes.list`(前回の page token から)→ 紐づけたフォルダの**中**(親をたどって最大3階層)にある・フォルダでない・ゴミ箱でない・`appProperties.pmSource` が無い・台帳に無い・md5 が同じ物件の添付と重複しない、ファイルだけ。Google ドキュメント形式(エクスポートが要るもの)は `unsupported` として台帳に残し取り込まない。20MB 超・許可外の MIME も同じ。
   - 段階のフォルダの中(①〜⑤・本人確認書類・写真)にあるもの → ダウンロード → PDF は本文を読んで種類を判別(§3)。フォルダ名が段階を示していれば、判別が `low`/当たらないときの段階の補助に使う(`docStage` に入れる)。その物件の添付(`general`)として登録(`uploadedBy`=接続した管理者・`docConfidence` は判別どおり・当たらなければ「その他」+「種類を確認」)。**「写真」フォルダの画像は物件の写真(写真タブ)に登録する**(発注者決定 10-24): 今の写真の登録口と同じ処理(EXIF の位置情報の除去・縮小版の作成・`PropertyPhoto`)を通す。画像でないもの(PDF など)が写真フォルダにあれば添付「その他」。
   - 紐づけたフォルダの直下(段階のフォルダの外)にあるもの → **書類の受け取り箱**へ(候補=その物件・根拠「フォルダ一致」)。
   - 紐づけ外のフォルダのもの → 何もしない(台帳にも書かない)。
   - 取り込んだ行は台帳 `in` に。重複(md5 一致)は `duplicate`。
3. 削除・移動・名前変更(ドライブ側の人の操作)はアプリに反映しない。アプリ側の削除もドライブに反映しない。
4. 失敗: 1件ごとに台帳 `failed`+理由(PII なし)。見回り全体の失敗(認可切れ・API エラー)は `drive_connection.last_error`・`consecutive_failures` に。3回続いたら管理者にベル通知(通知の仕組み・1日1回まで)=2026-10-25 に別の小さな PR で入れた(画面を開いている間の知らせ=ベル・右下。スマホへの送信はしない)。認可切れ(`invalid_grant`)は「再接続が必要です」と画面に。
5. 鍵: 見回りは同時に1つ(`pg_try_advisory_lock`)。timer は `pm-drive-sync.timer`(5分・`pm-attachment-cleanup` と同じ作り)=個別承認。
6. **実装で変えた点(2b・2026-10-25)**: ①`changes.list` ではなく、紐づけたフォルダの中を毎回たどる(3階層・50フォルダまで)=紐づける前から置いてあった書類も取り込める・続きの位置が壊れる心配がない。台帳(drive_file_id 一意)で二度は取り込まない。失敗したものはドライブ側で更新されたときだけやり直す。②同時に1つ=プロセスの印(業者一覧の収集と同じ。advisory lock は接続を固定できない)+写しは条件つき更新で1つ。③アプリの添付を複製する前に中身(md5)を比べ、人が同じものを置いてあれば複製せずにそのファイルと結ぶ(往復で同じ書類が2つにならない)。取り込んだ添付には `drive_file_id` を付ける=ドライブへ複製し直さない。④写真は位置情報を消せる JPEG・PNG・WebP(8MB まで)だけ写真タブへ。HEIC などは添付「その他」(サーバーで変換する部品が無い)。⑤3回続いた失敗のベル通知は今回入れない(サーバーからベルへ出す仕組みが無い=別の小さな PR)。いまは管理 › ドライブ連携に「最後の見回り」「直近の失敗(N回続いています)」を出す。
7. **紐づけを外しても台帳を残す(2026-10-25・発注者「直してください」・migration `20261025100000_drive_sync_keep_ledger`)**: `folder_link_id` を null 可・外部キーを ON DELETE SET NULL に、`property_id`(書いたときの物件・外部キーなし)を追加。外したあとに残った行は、受け取り箱の行と、**同じ物件に付け直したとき**だけ扱い済みに数える(別の物件に付け直したら写真・添付はその物件へ取り込む)。今も紐づいている行は、これまでどおり物件を問わず扱い済み。

**守り**
- 取り込んだファイルは物件の置き場所(`properties/<id>/attachments/`)に `storage.upload`=今の添付と同じ守り。本人確認書類と判別されれば 1c の守りがそのまま効く。
- 管理画面の API は `admin` だけ。フォルダ名・ファイル名は PII の可能性がある(所有者名が付いたフォルダなど)=監査ログ・journal に書かない(ID と件数だけ)。
- トークンは `drive_connection` に暗号化・API の応答に出さない・画面にはアカウントのメールだけ。

**PR の分け方**
- 2a: 接続(OAuth の往復・暗号化保存)+ 管理 › ドライブ連携(フォルダの一覧・候補・紐づけ)+ migration(表3つ+列1つ)+ 資料。見回りは無し(紐づけだけできる)。
- 2b: 見回り(複製・取り込み・台帳・失敗の表示・ベル通知)+ timer + proxy の公開パス。
- 発注者の作業(2a のマージ後・反映の前): Cloud Console でウェブ型 OAuth クライアントの作成(戻り先 URL の登録)→ ID・シークレットを app.env へ(私が手順を出す・値は見ない)→ 反映後に管理画面の「Google に接続」。

## 7. テスト

- 判別・名前・日付・段階の純関数: 表のすべての種類に1件以上、名前一致/見出し一致/本文一致/当たらない/領収書の振り分け/重複名の連番/使えない文字。
- PATCH route: 権限・404・registry 422・未知の種類 422・manual になる・監査に名前を出さない。
- POST route: PDF で判別が入る・抽出が落ちても 201・画像は名前だけ。
- 添付タブ: 段階ごとの分け方(純関数)と、開く段階の決め方。
