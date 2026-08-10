# 所有者の「現住所」と「登記上住所」の分離 設計

> **作成日**: 2026-08-10 / **性質**: 設計のみ(この PR にコード変更は無い)
> 発注者指示に基づく。実装は別 PR。

---

## 0. 発注者の決定事項(2026-08-10)

| 論点 | 決定 |
|---|---|
| 背景 | CSV の「住所」列は**登記上の住所**。ただし**所有者が引っ越して登記を変更していない**ことがあるため、現住所を別に持ちたい |
| UI | 所有者情報の**現住所欄の横にボタン**。ポインタが触れたら「**登記上の住所と現在の所在が違う場合はクリックしてください**」と表示。クリックで**現住所欄の下に登記上住所欄が出て**、登記上の住所がそちらへ移り、現住所欄が自由編集になる |
| 郵便番号 | **同様**。下に登記上の郵便番号欄を追加し、郵便番号欄は自由入力にする |
| DM の宛先 | **現住所を優先**。無ければ登記上の住所 |
| 既存データ | **配慮不要**。CSV はシステム完成後に一度削除して入れ直す |
| 着手順 | この件を先に(謄本のポップアップ方式は後) |

## 1. 現状(2026-08-10 実測)

- `Owner` の住所欄は **`zip` / `address` の1組だけ**(`prisma/schema.prisma` model Owner)。登記上/現住所の区別は無い。
- `owner.address` / `owner.zip` を**読む**箇所は約40ファイル。用途は6種類:
  1. **DM 宛先**(宛名CSV・売却DM・印刷)
  2. 画面表示・編集
  3. 検索(表示レベルが生値のときのみ対象・`properties/suggest`)
  4. **所有者の重複判定(名寄せ)**(`owner-dedup.ts` の「氏名+住所」完全一致)
  5. **物件との自動リンク**(`owner-property-linker.ts`: 所有者住所 == 物件住所)
  6. 品質チェック・補正(郵便番号監査・登記文字列の除去・住所補完)
- **書く**箇所は17経路。内訳:
  - **登記由来**: 謄本PDF取込(`registry-pdf/process.ts`)・受付帳取込・所有者CSV取込・住所補完(address-fill)・登記文字列の除去(registry-address-cleanup)
  - **利用者の手入力**: 所有者の PATCH/POST・物件詳細からの作成・取込エラー行の編集/再試行
  - **第三の値(国税庁の現在の本店所在地)**: `corporate-apply` / `corporate-restore-apply`(addressMode=nta)
- DM 宛先の実体は **`src/lib/dm-export.ts` の3関数**(`ownerAddressGroupKey` / `groupPropertyOwnersByAddress` / `buildDmRow`)。宛名CSV(控え方式)・売却DM・売却DM印刷の**3経路が全部ここを通る**。
- ただし DB 側の「送付可能な所有者」の絞り込み `address: { not: "" }` は **dm-batches と sale-dm の2箇所に別々に**書かれている。
- 表示レベル(PII)は `owner_address` / `owner_zip` の2 resource で全経路マスクされる。**`zip` にも表示レベルはある**(現地担当=住所 partial・郵便番号 masked / 事務・管理者=full)。
- 売却DMは宛先を `DmRecipientDraft.recipientZip` / `recipientAddress` に**スナップショット保存**し、印刷・CSV・プレビューはその保存値だけを読む(作成後に owner を読み直す箇所はゼロ)。

## 2. 方式: **既存 `address` / `zip` は「登記上」のまま据え置き、「現住所」を新設する**

```prisma
model Owner {
  zip             String?   // ← 据え置き: 登記上の郵便番号
  address         String?   // ← 据え置き: 登記上の住所
  currentZip      String?   @map("current_zip")      // 新設: 現住所の郵便番号
  currentAddress  String?   @map("current_address")  // 新設: 現住所
}
```

### なぜ逆にしないか(重要)

「`address` を現住所にして登記上を新列へ移す」方式は、**§1 の書込17経路と、名寄せ・自動リンク・郵便番号監査・登記文字列の除去のすべてを直す**ことになる。これらはいずれも「この列には登記由来の住所が入っている」ことを前提に書かれており、意味を反転させると:

- 謄本取込・受付帳取込が**利用者の手入力した現住所を毎回上書きする**(本件で防ぎたかった事故そのもの)
- 登記文字列の除去(受付番号・和暦・持分などの削除)が**手入力の現住所を勝手に削る**
- 名寄せの「氏名+住所」キーが現住所基準になり、**引っ越し済みの同一人物が別人として二重登録**される
- 自動リンク(所有者住所 == 物件住所)が現住所基準になり、**引っ越し済み所有者が別物件へ誤リンク**される

据え置けば、これら**6用途のうち5用途は一切変更不要**で、直すのは **DM 宛先の解決だけ**になる。

### 画面の見え方は発注者指示どおりになる

DB 上は値が移動しないが、画面では指示どおりに見える:

- ボタンを押す前: 欄は1つ。中身は `address`(登記上の値) = **現状と同じ**
- ボタンを押した後: 上が**現住所**(`currentAddress`・自由編集)、下が**登記上住所**(`address`・読み取り専用)

「登記上の住所が下の欄へ移った」ように見え、上の欄が編集可能になる。

### 現住所を「使っているか」の判定

`currentAddress` が **null または空白のみ** = 現住所は未設定 = 従来どおり登記上を使う。
**フラグ列は作らない**(列の値そのものが状態。フラグと値の二重管理は不整合の元)。

## 3. UI

### 3.1 表示位置

対象は所有者情報を編集できる**2箇所**(両方に同じものを実装する。片方だけだと「作成してから編集し直す」2手になる):

- 物件詳細ページの所有者カード(`src/app/(dashboard)/properties/[id]/page.tsx`)
- 所有者の新規作成モーダル(`src/components/owners/owner-link-modal.tsx`)

⚠ **管理者用の所有者詳細も直す**(@codex #369 R4 P2)。`src/app/api/admin/owners/[id]/corporate-candidate/route.ts` は `ownerAddressMasked` を **`owner.address` から作っており**、`src/app/(dashboard)/admin/owners/[id]/page.tsx` はその値に「**現住所**」というラベルを付けている。§6 のとおり国税庁の本店所在地の反映(`corporate-apply` の `addressMode=nta`)は `currentAddress` へ書くので、**このままだと反映後に画面を開き直しても登記上の住所が「現住所」として出続け、更新が失敗したように見える**。→ この API と画面で**両方を返し・両方を表示**し、ラベルを「現住所」「登記上住所」に正す。

### 3.2 レイアウト

```
郵便番号  [ 231-0842                    ]
住所      [ 横浜市南区井土ケ谷中町69-2    ]  [⇅ 現住所を分ける]
                                              ↑ ホバー:「登記上の住所と現在の所在が
                                                違う場合はクリックしてください」
```

押した後:

```
郵便番号(現)   [ 231-0842                    ]   ← 自由入力
郵便番号(登記) [ 231-0842                    ]   ← 参考表示
現住所         [ 横浜市南区井土ケ谷中町69-2    ]   ← 自由編集
登記上住所     [ 横浜市南区井土ケ谷中町69-2    ]   ← 参考表示
```

- ボタンを押した時点で、**現住所の初期値に登記上の住所をコピーして開始**する(引っ越し先は多くの場合一部だけ違うため、まっさらより編集が速い)。
- ⚠ **郵便番号はコピーしない**(@codex #369 R1 P1)。住所だけ書き換えて郵便番号が古いまま残ると、§4 の「ペアで解決する」規則が**そのズレたペアを正しい宛先として採用**し、**新しい住所に古い郵便番号を刷った郵便物**ができる。よって:
  - 現住所の郵便番号は**空で開始**する
  - **現住所を編集したら、現住所の郵便番号を空に戻す**(前の住所に対応した番号を残さない)
  - `AddressLookupControls` で住所から引き直して入れる
  - 保存時に「現住所はあるが現住所の郵便番号が空」なら**画面に注意を出す**(保存自体は妨げない。番号が分からないまま登録できないと運用が止まるため)
- ⚠ **この打ち消しは画面だけでなく API 側でも効かせる**(@codex #369 R6 P1)。`updateOwnerSchema` は**部分更新**で、`PATCH /api/owners/[id]` は渡された項目をそのまま反映する。よって**`currentAddress` だけを送る呼び出し**(画面を経由しない更新・将来の一括処理・取込のリトライ)では**古い `currentZip` が残り**、§4 の解決規則がそのズレたペアを採用してしまう。→ **サーバー側で「`currentAddress` が変わるのに `currentZip` が同時に来ていなければ `currentZip` を null にする」**(= 郵便番号は住所と一緒にしか更新できない)。`POST`(新規作成)も同じ規則。
- 現住所を空にして保存すれば「未設定」に戻る(= 登記上を使う状態へ戻せる)。専用の解除ボタンは作らない。
- ⚠ **郵便番号⇄住所の自動補完(`AddressLookupControls`)は現住所側にだけ付ける**。登記上の欄に効かせると、郵便番号APIの正規化表記で**登記の記載を書き換えて**しまい、謄本との突合が壊れる。

## 4. DM 宛先の解決規則(**1本のヘルパーに集約する**)

```ts
/** 送付に使う宛先。現住所があればそちら、無ければ登記上。zip と address は必ず同じ側から取る。 */
export function resolveMailingAddress(owner: {
  zip: string | null; address: string | null;
  currentZip: string | null; currentAddress: string | null;
}): { zip: string | null; address: string | null; source: "current" | "registry" };
```

⚠ **`zip` と `address` を別々に解決してはいけない**(住所は現・郵便番号は登記、の混在した郵便物ができる)。**必ずペアで同じ側から取る**。現住所が設定されているのに現住所の郵便番号が空の場合は、**郵便番号は空**とする(登記上の郵便番号を混ぜない)。

このヘルパーを通す箇所(**5系統・全部通す**。1つでも漏らすと控えと CSV と確定で宛先がズレて 409 ループになる):

| 箇所 | 直す内容 |
|---|---|
| `src/lib/dm-export.ts` | `ownerAddressGroupKey` / `groupPropertyOwnersByAddress` / `buildDmRow` を**解決後の値**で作る。空住所 skip の判定も「現住所も登記上も空」に変える |
| `src/app/api/properties/dm-batches/route.ts` | 宛先資格の where `address: { not: "" }` → 「現住所 or 登記上のどちらかが非空」。住所なし件数の集計も同様。`select` に新列2つを追加 |
| `src/app/api/properties/dm-batches/[id]/csv/route.ts` | `select` に新列2つを追加し、解決関数を通す |
| `src/lib/dm-batch/eligibility.ts` | owner の型と資格判定を新列対応にする(控えの凍結時の住所グループ再計算がここ) |
| `src/app/api/properties/sale-dm/campaigns/route.ts` + `src/lib/sale-dm-letter/recipients.ts` | `mailableOwner` の絞り込みと、`recipientZip`/`recipientAddress` への保存値を解決後の値にする |

⚠ **グルーピングキーを解決後の値で作ること**が肝。ここだけ旧 `address` のままだと、**同一人物が現住所と登記上住所で2通に分裂**して二重送付になる。

### 4.1 既存の売却DM下書きは追随させない

`DmRecipientDraft` は宛先のスナップショット。**作成済みの下書きは現住所を後から入れても更新しない**。確定・送付済みの宛先を後から書き換えると、承認時に見た宛名と実際の郵送物・送付記録がズレる(この一致は承認ゲートとして意図的)。本番は売却DM休眠中で対象はほぼゼロ。

### 4.2 どちらの住所で送ったかを残す

理由: 返戻(宛先不明)が来たとき、**登記上へ送って返ってきたのか、現住所へ送って返ってきたのか**で意味がまったく違う(前者は現住所を入れれば送れる/後者は現住所も誤り)。残さないと業務判断ができない。

**記録する時点が2つの経路で違う**(@codex #369 R1 P1)。

⚠ **出所は「所有者ごと」に持つ**(@codex #369 R3 P1)。1通は**同一送付先住所の共有者を束ねた1件**なので、**同じ住所に別々の出所からたどり着く**ことがある(所有者Aは現住所がX、所有者Bは登記上住所がX)。列を1つしか持たないと、返ってきた封筒が **Aにとっては現住所の失敗・Bにとっては登記上の失敗**という状態を表現できず、返戻の解釈が片方について必ず誤る。

| 経路 | 列 | **書く時点** |
|---|---|---|
| 売却DM | **`DmRecipientDraftOwner.address_source`(所有者ごと・権威)** + `DmRecipientDraft.recipient_address_source`(代表の出所) | **下書き作成時**。draft は作成時点の宛先スナップショット(`recipientZip`/`recipientAddress`)そのものなので、同じ tx で source も確定する |
| 宛名CSV(控え方式) | **`DmExportBatchItemOwner.address_source`(所有者ごと・権威)** + `DmExportBatchItem.recipient_address_source`(代表の出所) | ⚠**控えの作成時ではなく、初回ダウンロードの凍結時** |

- **所有者ごとの列が権威**。返戻の解釈は必ずこちらを見る。
- 代表側の1列は**連関を持たない旧行のためのフォールバック**として残す(既存設計で、移行前に作られた売却DM下書きは代表のみで連関が空)。連関がある行では代表側の値は参考情報。
- **混在グループのテストを必須にする**(所有者Aは現住所・所有者Bは登記上で同じ住所 → 1通に畳まれ、所有者ごとの出所が別々に記録されること)。

⚠ **宛名CSV側で控え作成時に書いてはいけない理由**: `DmExportBatchItem` は控え作成(POST)の時点で作られるが、**CSV は初回ダウンロード時に所有者の現在値から作り直される**。控え作成とダウンロードの間に現住所が登録されると、**配られる CSV は現住所なのに item の記録は "registry" のまま**になり、返戻の解釈が逆になる。

さらに、既存の凍結時検査(§1 の `checkBatchEligibility`)は**所有者IDの集合とグループ構成しか比べていない**ため、**単独所有者の住所が登記上→現住所へ変わってもグループ不一致にならず検出できない**。

よって:

- `recipient_address_source` は **初回GETの凍結 tx 内で、`csvDigest` と `downloadedAt` と同時に書き込む**(=「配った CSV の中身」と「どちらの住所で送ったか」を必ず一致させる)。
- 再試行GETは既存規則どおり `csvDigest` 一致のみ配信するので、記録とのズレは生じない。
- ⚠ この列は**控え作成直後は NULL**(まだ配っていない)。確定(confirm)は `downloadedAt` 必須なので、**確定される item は必ず source を持つ**。NULL のまま確定される経路は無い。

### 4.4 記録した出所を**返戻を扱う画面で実際に見せる**

⚠ 出所を保存しても、**返戻を記録する画面がそれを読まないなら意味がない**(@codex #369 R4 P2)。「宛先不明」を付ける担当者が、**その所有者へどちらの住所で送ったのか**を見られないと、現住所を入れれば送れるのか、現住所も誤りなのかを判断できない。

⚠ **確定した送付記録(`PropertyDmLog`)から控えの item へ遡れない**。ログは `batchId` は持つが **item の id は持たない**。`(batchId, propertyId)` で引く方法は、物件削除で `property_id` が null 化された行に対して破綻する。

→ **確定(confirm)の時点で、item と item_owners の出所を `PropertyDmLog` / `PropertyDmLogOwner` へコピーする**(§9 の列追加)。遡る必要がなくなり、履歴の表示も返戻の判断もログだけで完結する。

⚠ **売却DMの `mark-sent` も同じことをする**(@codex #369 R5 P2)。`src/app/api/properties/sale-dm/drafts/[id]/mark-sent/route.ts` は draft から `PropertyDmLog` と `PropertyDmLogOwner` を**直接**作っており、宛名CSVの確定とは別経路。ここを直さないと**売却DM由来の記録だけ出所が空**になり、履歴画面に出せない。draft と draft_owners の出所をコピーする(単一出所と混在出所の両方をテスト)。

⚠ **連関を持たない旧下書きは、合成する連関行に「親の出所」を写す**(@codex #369 R8 P2)。`mark-sent` は、下書きに `draftOwners` が無いとき **代表所有者ぶんの `PropertyDmLogOwner` を合成**する既存挙動を持つ。`draft_owners` からコピーするだけだとこの行は空のままで、**§4.2 が「連関があればそれが権威」と決めている以上、親にバックフィルした `registry` は参照されず「出所不明」になる**。→ **合成する行には下書き側(親)の出所をコピーする**。

> **本番実測(2026-08-10)**: 売却DMの下書きは **50件あり、その全件が連関なし**(`dm_recipient_draft_owners` は0行)・全件に宛先住所あり・送付済みは0件。つまり**この旧経路が現時点の本番の既定**であって、例外処理ではない。**連関が空の旧下書きのテストを必ず書く**。

⚠ **`mark-sent` は住所そのもの(§4.5)もコピーする**(@codex #369 R6 P1)。「draft を見ればよい」は成り立たない: **物件を削除すると draft は Cascade で消える**のに、`PropertyDmLog` は `propertyId=null` で**意図的に残す**設計。draft から読む前提だと、その孤児ログでは**実際に刷った住所が失われる**。→ `mark-sent` の同一 tx で `recipientZip`/`recipientAddress` を `deliveryZip`/`deliveryAddress` へコピーし、**物件削除後の孤児ログでも住所が残ることをテストする**。

### 4.5 ⚠**実際に刷った住所そのものを控える**(既存方針の変更を含む)

@codex #369 R5 P1: 出所の区分(現住所/登記上)だけでは足りない。**ダウンロード後に所有者の住所が訂正されると、実際に刷って郵送した住所がどこにも残らない**(csvDigest はハッシュなので復元不能)。返戻が来たとき、担当者が**訂正後の新しい現住所を「返ってきた住所」と取り違える**。

→ **初回ダウンロードの凍結時に、解決後の郵便番号と住所そのものを控える**。確定時にログへ引き継ぐ。

```sql
ALTER TABLE "dm_export_batch_items" ADD COLUMN "delivery_zip" TEXT;
ALTER TABLE "dm_export_batch_items" ADD COLUMN "delivery_address" TEXT;
ALTER TABLE "property_dm_logs"      ADD COLUMN "delivery_zip" TEXT;
ALTER TABLE "property_dm_logs"      ADD COLUMN "delivery_address" TEXT;
```

⚠ **これは既存の設計判断を変更する**([[dm-sending-management]] §2.1「CSV の中身(氏名・住所)は保存しない。控えは propertyId/代表 ownerId のみ=非PII寄りの最小構成」)。変更する理由:

- 保存するのは**氏名ではなく住所のみ**、かつ**実際に郵送した事実の記録**である(送る前の控えではない。凍結＝ダウンロード後にだけ入る)。
- 売却DM側は**既に同じものを保存している**(`DmRecipientDraft.recipientZip`/`recipientAddress`)。宛名CSV側だけ保存しないのは非対称で、同じ返戻の判断ができない。
- 保存しないと、**訂正のたびに過去の郵送先が失われる**。返戻の解釈は「その時どこへ送ったか」がすべてなので、これが無いと機能自体が成り立たない。

⚠ **表示は `owner_address` の表示レベルでマスクする**(生の住所を権限の無い利用者に出さない)。⚠ 未ダウンロードの item には入らない(凍結前は郵送していない)。

**テスト**: ダウンロード → 所有者の住所を訂正 → 確定 → 履歴に**訂正前の(実際に刷った)住所**が出ること。

読む/見せる箇所:

| 画面・API | 表示 |
|---|---|
| `GET /api/properties/[id]/dm-logs` + 物件詳細の「DM送付履歴」 | 行に**送付先の出所**を出す(例: 「現住所へ送付」/「登記上の住所へ送付」)。反響を「宛先不明」にするときの判断材料になる |
| 売却DMの宛先一覧・反響(outcome)の画面 | 同様に出所を出す |
| 共有者が複数いる行 | **所有者ごとに出所が違い得る**ので、行を開いたときに所有者別に出す |
| ⚠**孤児DM記録の訂正**(`GET /api/admin/orphan-dm-logs` + `src/app/(dashboard)/admin/orphan-dm-logs/page.tsx`) | **必ず含める**(@codex #369 R9 P2)。§4.5 は「物件を削除しても住所を残す」ためにあるのに、**削除後は物件の履歴画面が開けず、孤児の画面が唯一の入口**。現状この API は新しい住所欄も所有者ごとの出所も返していない。→ **返す・表示する**。住所は `owner_address` の表示レベルでマスク。**孤児の返戻を扱うテストを書く** |

**混在グループの返戻テストを必須にする**(所有者Aは現住所・所有者Bは登記上で1通 → 返戻 → 画面で所有者ごとに別々の出所が出ること)。

### 4.3 返戻後に現住所を入れても自動で送付可へは戻さない

現設計(返戻 → 物件 `dmStatus=no_send` + `dmUndeliverableAt`)は**人が戻す**運用。現住所の登録をトリガに自動解除すると、返戻の事実を人が見る前に再送してしまう。
ただし**物件一覧の「宛先不明のみ」の画面に「現住所が登録されました」の印を出す**ことは有効(実装は本 PR の範囲外・別途判断)。

## 5. 表示レベル(PII)

**新しい resource は作らず、`owner_address` / `owner_zip` を流用する**(現住所も登記上住所も同じ機微度。権限を増やすと管理画面2枚・seed・migration・テンプレの更新が必要になり、運用が複雑になるだけで守れるものは増えない)。

⚠ ただし**流用でも、以下を全部足さないと穴になる**(fail-open):

| ファイル | 追加する内容 | 漏らすと |
|---|---|---|
| `src/lib/display-level.ts` | `OwnerDisplayConfig` / DEFAULT / full・hidden プリセット / `applyDisplayToOwner` / field masking 表 | **マスクされない生の住所がそのまま返る** |
| `src/lib/api-helpers.ts` | `getOwnerDisplayConfig` の解決に新列を追加(`owner_address`/`owner_zip` の値を流用) | 全員 hidden になって消える |
| `src/app/api/properties/suggest/route.ts` | 検索対象に新列を足す(表示レベルが生値のときのみ) | 現住所で検索できない/またはマスク中に検索オラクルができる |
| `src/app/api/owners/search/route.ts` | 同上。⚠**この route は `applyDisplayToOwner` を通さず、住所の検索条件・select・マスクを手書きしている** | 所有者リンクのモーダルから現住所で所有者を探せない。後から素朴に足すと**フィールドレベルの検索オラクル封じとマスク規則を迂回**する |
| `src/app/api/owners/route.ts`(一覧) | 同上。ここも手書きの検索とマスク | 同上 |

**検索の扱い**: 現住所も**表示レベルが生値のときだけ**検索対象に加える(既存の `SEARCHABLE_LEVELS` と同じ規則)。

⚠ **所有者住所で検索できる入口は3つある**(@codex #369 R1 P2)。`properties/suggest` だけでなく `owners/search`(所有者リンクのモーダルが使う)と `owners` 一覧も対象。**3つとも同じ規則で足し、生値のときとマスク時の両方のテストを書く**。1つでも漏らすと「現住所で探せない入口」が残り、後から足すときに検索オラクルの穴を作る。

## 6. 書込経路の振り分け

| 経路 | 書込先 | 理由 |
|---|---|---|
| 謄本PDF取込 (`registry-pdf/process.ts`) | **`address`/`zip`(登記上)** | 登記由来 |
| 受付帳取込 (`import/reception-owner`) | **`address`/`zip`(登記上)** | 登記由来 |
| 所有者CSV取込 (`import/owner-csv`) | **`address`/`zip`(登記上)** | 既存ヘッダ「住所」「郵便番号」の意味は据え置き。**新ヘッダ「現住所」「現住所郵便番号」を追加**して現住所側にも入れられるようにする。⚠下記の**3箇所すべて**を直す |
| 取込エラー行の編集/再試行 | 同上 | ⚠ `rows/[rowId]/route.ts` と `rows/[rowId]/retry/route.ts` は**完全なコピペ重複**。片方だけ直す事故が最も起きやすい。**共通モジュールへ切り出してから**足す |
| 住所補完 (address-fill) | **`address`(登記上)** | 取込 rawData 由来 = 登記由来 |
| 登記文字列の除去 (registry-address-cleanup) | **`address`(登記上)** | 登記の記載にしか意味がない |
| 文字化け補正 (text-fix) | **両方**を対象に(`FIELD_RESOURCE` に現住所を追加) | どちらにも制御文字は混入し得る。⚠**直す route だけでは足りない**(下記) |

⚠ **文字化けの「候補探し」も直さないと現住所は永久に見つからない**(@codex #369 R9 P2)。`src/app/api/admin/owners/text-hygiene-candidates/route.ts` は `TextHygieneField` / `SCANNED_FIELDS` / Prisma の select / 値の対応表が**すべて `address` 決め打ち**で、品質チェックの画面側も型の並びを明示列挙している。直す route(`text-fix`)に現住所を足しても、**候補として出てこないので誰も直せない**。→ **候補APIと品質チェック画面の型・配線も含める**。⚠ 候補一覧は所有者の住所を出すので、**表示レベルによる見え方(検索オラクル封じ)のテストと、実際に補正できるテストの両方**を書く。
| 郵便番号の整形 (contact-fix) | **両方** | 同上 |
| 法人番号の混入除去 (corporate-cleanup) | **`address`(登記上)** | 分断型の法人番号は登記由来の住所に混入する |
| **国税庁の本店所在地の反映** (`corporate-apply` / `corporate-restore-apply` の addressMode=nta) | **`currentAddress`/`currentZip`(現住所)** | 国税庁が持つのは**現在の**本店所在地であって登記の記載ではない。ここを登記上へ書くと謄本と突合できなくなる。⚠**住所と郵便番号を別々に反映させない**(下記) |

⚠ **`corporate-apply` は住所と郵便番号を別々のチェックで選べる**(`corporate-lookup-panel.tsx`)。**郵便番号だけを反映**すると、国税庁の郵便番号が `currentZip` に入る一方で `currentAddress` は元のまま残り、§4 の解決規則が**そのズレたペアを郵送先として採用**する(@codex #369 R7 P1)。国税庁の郵便番号は**国税庁の住所に付いた番号**なので、片方だけ採ってはいけない。

→ **住所と郵便番号は一組でしか反映できないようにする**(郵便番号だけの選択を許さない)。**郵便番号だけの選択のテストを必ず書く**。
| 所有者の手入力(PATCH/POST/create-and-link) | **両方**(画面で入れた欄に入る) | — |
| 名寄せ(merge) | §7 参照 | — |

## 7. 名寄せ・自動リンク・監査は**登記上のまま**(変更しない)

| 処理 | 使う住所 | 理由 |
|---|---|---|
| 所有者の重複判定 (`owner-dedup.ts`・品質チェック・取込の突合7箇所) | **登記上** | 同一人物の判定は登記上の住所のほうが安定。現住所基準にすると引っ越し済みの同一人物が二重登録される |
| 物件との自動リンク (`owner-property-linker.ts`・owner-csv 内の同ロジック) | **登記上** | 「所有者住所 == 物件住所 = その物件に住んでいる」の推定。現住所基準にすると引っ越し済み所有者が別物件へ誤リンクされる |
| 郵便番号監査 (`admin/postal-code-audit`) | **登記上の zip × 登記上の address** | 現住所の zip と登記上の address を突き合わせると全件「不一致」になる。⚠ **現住所側の監査は別途対応(本設計の範囲外)** |

⚠ **名寄せ(merge)に穴が1つ生まれる**: 現在の統合は source を archive するだけで住所を master へ移さない。新列を足すと、**現住所を持つ source を統合したときに現住所が完全に消える**(復元手段なし)。→ **統合 tx に「master が空欄なら source の `currentAddress`/`currentZip` を引き継ぐ」処理を追加する**。

⚠ **統合で「所有者ごとの出所」が消える**(@codex #369 R7 P1)。master と source が**同じ下書き・同じ控えの item・同じログ**に両方いる場合(共有者を統合したときに起きる)、既存の統合は複合キーの衝突を避けるため**source 側の連関行を先に削除してから付け替える**。混在グループではこの2行の `address_source` が**別々の値**を持ち得るので、素直に消すと**片方の権威な出所が復元不能に失われる**。さらに、source の現住所を master へ引き継いだ直後に、生き残った連関が `registry` のまま取り残される。

→ **連関3表それぞれについて衝突時の扱いを決める**:
- 生き残る行の `address_source` は、**「その所有者がその郵送物をどちらの住所で受け取ったか」を変えてはいけない**。統合は同一人物の名寄せであって、郵送の事実は変わらない。
- したがって **master 行が既に値を持つならそれを維持し、master 行が NULL で source 行が値を持つ場合のみ source の値を採る**。両方が値を持ち**食い違う**場合は、**master 側を維持**し、監査に `addressSourceConflict` を残す(事実としては同じ封筒に2人が載っていただけで、どちらも正しい)。
- **この統合のテストを必ず書く**(混在出所のグループを統合しても、生き残った行の出所が書き換わらないこと)。

⚠ **その引き継ぎは変更履歴に残らない**(@codex #369 R2 P2)。統合 route は ChangeLog の行を**手で組み立てており、`recordChanges`(= `OWNER_TRACKED_FIELDS` を使う共通処理)を呼んでいない**。したがって §8 の定数に新列を足しただけでは**この経路だけ履歴が残らない**(所有者のデータが変わったのに前後が追えない)。→ **統合 tx の中で、引き継いだ2列それぞれについて ChangeLog 行を明示的に作る**(既存の手組みの並びに追加する)。

## 8. 変更履歴・権限・型

| ファイル | 追加 | 漏らすと |
|---|---|---|
| `src/lib/property-field-constants.ts` `OWNER_TRACKED_FIELDS` | 新列2つ | **変更履歴に残らない**。過去に踏んだ「変更履歴が嘘をつく穴」と同型。さらに address-fill は ChangeLog の有無で安全判定しているので**ガードも素通り**する |
| `src/app/api/owners/[id]/route.ts` `fieldWriteChecks` | 新列2つ | 権限の無い利用者が書き換えられる(フィールドレベル権限のバイパス) |
| `src/app/api/owners/route.ts` `createFieldWriteChecks` + create の明示列挙 | 新列2つ | schema に足すだけでは**保存されない**(明示列挙のため) |
| `src/app/api/properties/[id]/owners/create-and-link/route.ts` | create の明示列挙 | 物件詳細から追加した所有者だけ新欄が保存されない |
| `src/lib/owner-create.ts` `OwnerCreateData` / `OWNER_FIELD_WRITE_RESOURCES` | 新列2つ | 権限マップに無いフィールドは**黙って書込許可**される |
| `src/lib/validators.ts` `createOwnerSchema` / `updateOwnerSchema` | 新列2つ(**両方**) | 「新規は入るが編集で消せない」の非対称 |
| `src/lib/owner-edit-utils.ts` | `OwnerEditableFields` / `OwnerFormValues` / `buildOwnerUpdatePayload` | 画面で入力できても保存されない(エラーも出ない) |
| `src/lib/api-client.ts` | Owner 系レスポンス型 | 画面で受け取れない |
| **`src/app/api/properties/[id]/route.ts`** の **GET と PATCH 両方**の owner `select` | 新列2つ | ⚠**登録済みの現住所が画面に出ず、編集フォームが空のまま保存して現住所を消す**(@codex #369 R2 P2)。所有者カードはこの応答で初期化される |

⚠ **所有者を返す「明示 select」は他にもある**。実装時に `select` の中に `address: true` を含む箇所を**全部 grep して洗い出し**、同じ2列を足す(既知: 物件詳細 GET/PATCH・宛名CSV・売却DM キャンペーン作成)。**select 漏れは無言の劣化**(型は optional で通り、現住所が常に undefined → 登記上へフォールバックし続ける)。
| `src/lib/csv-parser.ts` `OWNER_CSV_COLUMN_MAP` | 「現住所」「現住所郵便番号」ヘッダ | CSV から現住所を入れられない |

⚠ **CSV の列は末尾に追加する**。途中に挿すと既存の差込テンプレ(列位置ベース)が全部ずれる。

⚠ **所有者CSV取込は「列の対応表」が2つある**(@codex #369 R3 P2)。`src/lib/csv-parser.ts` の `OWNER_CSV_COLUMN_MAP`(自動判定用)に足すだけでは取り込めない:

| 直す箇所 | 内容 | 漏らすと |
|---|---|---|
| `src/lib/csv-parser.ts` `OWNER_CSV_COLUMN_MAP` | 新ヘッダ2つ | ヘッダ自動判定で拾われない |
| `src/app/api/import/owner-csv/route.ts` の **route 内 `JAPANESE_FIELD_TO_PROPERTY`** | 同じ2つ | **利用者が列の対応を明示指定した取込だけ**新欄が無視される |
| 同 route の **`createData` の明示列挙** | 新列2つを書込 | **自動判定の取込でも** `prisma.owner.create` の直前で捨てられる |

テストは**「ヘッダ自動判定」と「列の対応を明示指定」の両方**で書く(片方だけだともう片方の経路が素通りする)。

## 9. migration

`add_owner_current_address`(additive・1本):

```sql
-- 所有者の現住所
ALTER TABLE "owners" ADD COLUMN "current_zip" TEXT;
ALTER TABLE "owners" ADD COLUMN "current_address" TEXT;

-- どちらの住所へ送ったか(代表: 連関を持たない旧行のフォールバック)
ALTER TABLE "dm_recipient_drafts"   ADD COLUMN "recipient_address_source" TEXT;
ALTER TABLE "dm_export_batch_items" ADD COLUMN "recipient_address_source" TEXT;

-- ⚠どちらの住所へ送ったか(所有者ごと=権威・§4.2)。親テーブルだけでは足りない
ALTER TABLE "dm_recipient_draft_owners"   ADD COLUMN "address_source" TEXT;
ALTER TABLE "dm_export_batch_item_owners" ADD COLUMN "address_source" TEXT;

-- ⚠確定した送付記録にも持たせる(§4.4)
ALTER TABLE "property_dm_logs"       ADD COLUMN "address_source" TEXT;
ALTER TABLE "property_dm_log_owners" ADD COLUMN "address_source" TEXT;

-- ⚠実際に刷った住所そのもの(§4.5)。凍結時に控え、確定でログへ引き継ぐ
ALTER TABLE "dm_export_batch_items" ADD COLUMN "delivery_zip" TEXT;
ALTER TABLE "dm_export_batch_items" ADD COLUMN "delivery_address" TEXT;
ALTER TABLE "property_dm_logs"      ADD COLUMN "delivery_zip" TEXT;
ALTER TABLE "property_dm_logs"      ADD COLUMN "delivery_address" TEXT;
```

⚠ **手渡し等の個別記録(`POST /api/properties/[id]/dm-logs`)は対象外**(@codex #369 R5 P1)。この経路は `ownerId`・`dmType`・`batchId`・`draftId` をすべて null で作り、方法も「手渡し」等が入る=**そもそも所有者の登録住所へ送っていない**。ここを `registry` で埋めると、履歴画面に**嘘の「登記上の住所へ送付」**が出る。NULL のまま(=出所の記録なし)にして、画面でも何も出さない。

**⚠ ただし `recipient_address_source` は NULL のままにしない**(@codex #369 R2 P2)。

```sql
-- 既存のDM記録は、現住所の列が存在しなかった時期に作られた = 必ず登記上の住所で送っている
UPDATE "dm_recipient_drafts"       SET "recipient_address_source" = 'registry' WHERE "recipient_address_source" IS NULL;
UPDATE "dm_recipient_draft_owners" SET "address_source" = 'registry' WHERE "address_source" IS NULL;
-- ⚠ログは「宛先が特定できる行」だけ。手渡し等の個別記録は対象外(@codex #369 R5 P1)
UPDATE "property_dm_logs" SET "address_source" = 'registry'
  WHERE "address_source" IS NULL
    AND ("batch_id" IS NOT NULL OR "draft_id" IS NOT NULL OR "dm_type" = 'owner_address');
UPDATE "property_dm_log_owners" SET "address_source" = 'registry'
  WHERE "address_source" IS NULL
    AND "log_id" IN (
      SELECT "id" FROM "property_dm_logs"
      WHERE "batch_id" IS NOT NULL OR "draft_id" IS NOT NULL OR "dm_type" = 'owner_address'
    );

-- 控え側はダウンロード済みのバッチのみ(未DLの item は凍結時に書かれる)
UPDATE "dm_export_batch_items" SET "recipient_address_source" = 'registry'
  WHERE "recipient_address_source" IS NULL
    AND "batch_id" IN (SELECT "id" FROM "dm_export_batches" WHERE "downloaded_at" IS NOT NULL);
UPDATE "dm_export_batch_item_owners" SET "address_source" = 'registry'
  WHERE "address_source" IS NULL
    AND "item_id" IN (
      SELECT i."id" FROM "dm_export_batch_items" i
      JOIN "dm_export_batches" b ON b."id" = i."batch_id"
      WHERE b."downloaded_at" IS NOT NULL
    );
```

**実際に刷った住所も、分かるものは埋める**(@codex #369 R8 P2)。売却DM由来のログ(`draft_id` あり)は、印刷した宛先が下書きに残っている:

```sql
UPDATE "property_dm_logs" l
   SET "delivery_zip"     = d."recipient_zip",
       "delivery_address" = d."recipient_address"
  FROM "dm_recipient_drafts" d
 WHERE d."id" = l."draft_id"
   AND l."delivery_address" IS NULL;
```

埋めないと、**その後に物件を削除した時点で下書きが消えて住所が復元不能**になる(ログは残す設計なので、履歴に宛先が出ない行が永久に残る)。

**ダウンロード済みで未確定の控えの扱い**(@codex #369 R8 P2): この migration より前にダウンロードされた控えは `downloadedAt` が既に立っているため、**§4.5 の「初回DLで住所を控える」を通らない**。そのまま確定すると **NULL のままログへ写り、実際に配ったCSVの宛先が失われる**。→ **反映時に残っていれば「再出力してください」として無効化する**(`downloadedAt` と `csvDigest` を消して未DL状態へ戻す。控えの意味は「配った集合の凍結」なので、住所を控えていない控えは凍結として不完全)。

> **本番実測(2026-08-10)**: 控え0件・ダウンロード済み未確定0件・送付記録0件。**現時点では上の2つはいずれも対象ゼロ**だが、反映日までに増える可能性があるため手順として残す。⚠**反映の直前にもう一度数える**。

⚠ **連関(所有者ごと)のバックフィルを忘れない**(@codex #369 R4 P1)。§4.2 で所有者ごとの値を**権威**と決めた以上、既存の連関行が NULL のままだと、**親のフォールバックは連関がある行では参照しない規則**に従って「出所不明」になる。

理由:
- 過去の返戻(宛先不明)を後から見たときに **source が無いと解釈できない**。既存分は定義上すべて登記上なので、そう埋めるのが事実に一致する。
- ⚠**既にダウンロード済みで未確定の控えが残っていると、確定 route は `downloadedAt` しか見ない**ため §4.2 の「初回DLの凍結時に書く」を通らずに確定されてしまう。**ダウンロード済みの item を `registry` で埋めることでこの窓を塞ぐ**(埋めた値は事実と一致する)。未ダウンロードの item は NULL のままでよい(これから凍結時に書かれる)。

- owners の新2列は既存行すべて NULL = 現住所未設定 = **従来どおりの動作**(既存データへの影響ゼロ)。
- enum は作らない(TEXT + アプリ側 allowlist。#361 と同方針)。
- 索引は張らない(現住所での検索・絞り込みは表示レベルが生値のときの `contains` 検索のみで、既存の `address` にも索引は無い)。

### 9.1 反映の順序と戻し方(@codex #369 R6 P2)

実装後のアプリは新しい列を読み書きするので、**列が無い状態でアプリだけ先に出すと所有者とDMの画面が壊れる**。

**反映の順序(必ずこの順)**:

1. `prisma migrate deploy`(列追加+バックフィル。**additive のみ**なので旧アプリは動き続ける)
2. `npm run build` → `systemctl restart`(新アプリを出す)

= このリポの通常手順(`docs/deploy.md`: ci → generate → **migrate deploy** → build → restart)と同じ並びで、**追加の手当ては不要**。⚠ ただし「migrate は後でいい」と順序を入れ替えないこと。

⚠ **ダウンロード済み控えの無効化は「再起動の後」に行う**(@codex #369 R9 P2)。migration と再起動の間は**旧アプリが動いたまま**なので、その窓で利用者が再ダウンロードすると、**旧アプリが `downloadedAt`/`csvDigest` を書き戻す**(住所の控えは持たないまま)。その後に新アプリの確定がそれを受け入れ、**NULL の宛先が永久の記録へ写る**。

→ **2重に塞ぐ**:
1. 無効化(§9 の「再出力してください」に倒す処理)は **restart の後**に実行する(順序: migrate → build → restart → **無効化** → prune)。
2. **確定(confirm)側で「住所の控えが無いダウンロード済み item は受け付けない」**(409「再出力してください」)。タイミングに依存しない防御。こちらが本命で、1 は運用上の後始末。

**戻し方(アプリだけ戻す)**:

- **列は消さない**。旧アプリは新しい列を知らないので、**存在しても無害**(Prisma は自分が知る列しか読まない)。
- したがって**アプリのコードだけ前のコミットへ戻して再起動**すれば復旧する。**新しく書かれた出所・住所のデータは消えない**(戻した後に前へ進めば、そのまま使える)。
- ⚠ **列を落とす方向のロールバックはしない**。落とすと、戻すまでの間に記録された「どの住所へ送ったか」が**永久に失われる**(返戻の判断ができなくなる)。

## 10. テスト方針

- **`resolveMailingAddress` は純関数**でユニット(現あり/現のみ/登記のみ/両方空/現住所ありだが郵便番号だけ空、の組み合わせ)。
- **`dm-export.test.ts` を走査型に拡張**: 現住所・登記上住所の組み合わせで、(a) 同じ現住所の共有者は1通に畳む (b) 別々の現住所なら分ける (c) 登記上が空でも現住所があれば送付対象 を固定する。⚠ 単数住所前提の既存アサーションは緑のまま通ってしまうので、**組み合わせを明示的に足す**。
- **表示レベルのテスト**: 新列がマスクされること(fail-open の検出)。
- **配線のソース固定**: §4 の5系統すべてが `resolveMailingAddress` を通ること(1つでも直呼びが残ると宛先がズレる)。
- **走査型ガード**: `owner` の列を足したとき `OWNER_TRACKED_FIELDS` / `display-level` / `fieldWriteChecks` の3点に入っていなければ落ちるテスト(今回と同種の抜けを将来も自動検出する)。

### 10.1 追加のテスト(R1 対応分)

- **郵便番号のズレ**: 分離ボタン→住所だけ編集→保存、で `currentZip` が空になっていること(古い番号が残らない)。
- **控えの source**: 控え作成 → 現住所を登録 → 初回DL、の順で、配られた CSV の住所と item の `recipient_address_source` が**一致**すること。
- **検索3入口**: `properties/suggest` / `owners/search` / `owners` 一覧のそれぞれで、表示レベルが生値なら現住所で当たり、マスク時は当たらない(検索オラクルにならない)こと。

## 11. レビューで特に見てほしい論点

1. **既存 `address` を「登記上」に据え置く判断**(§2)。逆にしたほうがよい理由があるか。
2. `zip` と `address` を必ずペアで解決する規則(§4)で、**現住所ありだが現住所の郵便番号が空**のときに「郵便番号は空」とする扱いは妥当か(登記上の郵便番号を混ぜないため)。
3. 表示レベルを新設せず `owner_address`/`owner_zip` を流用する判断(§5)。
4. 名寄せ・自動リンク・郵便番号監査を登記上のまま据え置く判断(§7)と、統合時の現住所引き継ぎ。
5. §4.2 の `recipient_address_source` を2表に持たせる設計(返戻の解釈のために必要か)。
