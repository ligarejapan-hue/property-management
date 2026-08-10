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

| 経路 | 列 | **書く時点** |
|---|---|---|
| 売却DM | `DmRecipientDraft.recipient_address_source` | **下書き作成時**。draft は作成時点の宛先スナップショット(`recipientZip`/`recipientAddress`)そのものなので、同じ tx で source も確定する |
| 宛名CSV(控え方式) | `DmExportBatchItem.recipient_address_source` | ⚠**控えの作成時ではなく、初回ダウンロードの凍結時** |

⚠ **宛名CSV側で控え作成時に書いてはいけない理由**: `DmExportBatchItem` は控え作成(POST)の時点で作られるが、**CSV は初回ダウンロード時に所有者の現在値から作り直される**。控え作成とダウンロードの間に現住所が登録されると、**配られる CSV は現住所なのに item の記録は "registry" のまま**になり、返戻の解釈が逆になる。

さらに、既存の凍結時検査(§1 の `checkBatchEligibility`)は**所有者IDの集合とグループ構成しか比べていない**ため、**単独所有者の住所が登記上→現住所へ変わってもグループ不一致にならず検出できない**。

よって:

- `recipient_address_source` は **初回GETの凍結 tx 内で、`csvDigest` と `downloadedAt` と同時に書き込む**(=「配った CSV の中身」と「どちらの住所で送ったか」を必ず一致させる)。
- 再試行GETは既存規則どおり `csvDigest` 一致のみ配信するので、記録とのズレは生じない。
- ⚠ この列は**控え作成直後は NULL**(まだ配っていない)。確定(confirm)は `downloadedAt` 必須なので、**確定される item は必ず source を持つ**。NULL のまま確定される経路は無い。

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
| 所有者CSV取込 (`import/owner-csv`) | **`address`/`zip`(登記上)** | 既存ヘッダ「住所」「郵便番号」の意味は据え置き。**新ヘッダ「現住所」「現住所郵便番号」を追加**して現住所側にも入れられるようにする |
| 取込エラー行の編集/再試行 | 同上 | ⚠ `rows/[rowId]/route.ts` と `rows/[rowId]/retry/route.ts` は**完全なコピペ重複**。片方だけ直す事故が最も起きやすい。**共通モジュールへ切り出してから**足す |
| 住所補完 (address-fill) | **`address`(登記上)** | 取込 rawData 由来 = 登記由来 |
| 登記文字列の除去 (registry-address-cleanup) | **`address`(登記上)** | 登記の記載にしか意味がない |
| 文字化け補正 (text-fix) | **両方**を対象に(`FIELD_RESOURCE` に現住所を追加) | どちらにも制御文字は混入し得る |
| 郵便番号の整形 (contact-fix) | **両方** | 同上 |
| 法人番号の混入除去 (corporate-cleanup) | **`address`(登記上)** | 分断型の法人番号は登記由来の住所に混入する |
| **国税庁の本店所在地の反映** (`corporate-apply` / `corporate-restore-apply` の addressMode=nta) | **`currentAddress`/`currentZip`(現住所)** | 国税庁が持つのは**現在の**本店所在地であって登記の記載ではない。ここを登記上へ書くと謄本と突合できなくなる |
| 所有者の手入力(PATCH/POST/create-and-link) | **両方**(画面で入れた欄に入る) | — |
| 名寄せ(merge) | §7 参照 | — |

## 7. 名寄せ・自動リンク・監査は**登記上のまま**(変更しない)

| 処理 | 使う住所 | 理由 |
|---|---|---|
| 所有者の重複判定 (`owner-dedup.ts`・品質チェック・取込の突合7箇所) | **登記上** | 同一人物の判定は登記上の住所のほうが安定。現住所基準にすると引っ越し済みの同一人物が二重登録される |
| 物件との自動リンク (`owner-property-linker.ts`・owner-csv 内の同ロジック) | **登記上** | 「所有者住所 == 物件住所 = その物件に住んでいる」の推定。現住所基準にすると引っ越し済み所有者が別物件へ誤リンクされる |
| 郵便番号監査 (`admin/postal-code-audit`) | **登記上の zip × 登記上の address** | 現住所の zip と登記上の address を突き合わせると全件「不一致」になる。⚠ **現住所側の監査は別途対応(本設計の範囲外)** |

⚠ **名寄せ(merge)に穴が1つ生まれる**: 現在の統合は source を archive するだけで住所を master へ移さない。新列を足すと、**現住所を持つ source を統合したときに現住所が完全に消える**(復元手段なし)。→ **統合 tx に「master が空欄なら source の `currentAddress`/`currentZip` を引き継ぐ」処理を追加する**。

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
| `src/lib/csv-parser.ts` `OWNER_CSV_COLUMN_MAP` | 「現住所」「現住所郵便番号」ヘッダ | CSV から現住所を入れられない |

⚠ **CSV の列は末尾に追加する**。途中に挿すと既存の差込テンプレ(列位置ベース)が全部ずれる。

## 9. migration

`add_owner_current_address`(additive・1本):

```sql
ALTER TABLE "owners" ADD COLUMN "current_zip" TEXT;
ALTER TABLE "owners" ADD COLUMN "current_address" TEXT;
ALTER TABLE "dm_recipient_drafts" ADD COLUMN "recipient_address_source" TEXT;
ALTER TABLE "dm_export_batch_items" ADD COLUMN "recipient_address_source" TEXT;
```

- 既存行は全て NULL = 現住所未設定 = **従来どおりの動作**(既存データへの影響ゼロ)。
- enum は作らない(TEXT + アプリ側 allowlist。#361 と同方針)。
- 索引は張らない(現住所での検索・絞り込みは表示レベルが生値のときの `contains` 検索のみで、既存の `address` にも索引は無い)。

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
