# DMの種類ごとの添え書き+現地調査の自動振り分けを「古い家」へ(計画・2026-11-08)

発注者決定(11-08):
1. 社名の横の添え書きを種類ごとに切り替える(手紙=上部の社名の横+署名の下の2か所/ご案内ページ=/t/ と /lp/)。
   - 相続(inheritance)・相続マンション(inheritance_unit) → 「相続・不動産のご相談窓口」
   - 空き家(vacant) → 「空き家・不動産のご相談窓口」
   - 古い家 → 「住まい・不動産のご相談窓口」
   - それ以外(種類なし=古いやり方の発送を含む) → 「住まい・不動産のご相談窓口」
2. 現地調査(introductionRoute=field_survey)の自動の振り分け先を「空き家」→「古い家」。古い家が使えない・削除済み・台帳に無いときは 空き家 → 発送の既定 の順に落ちる。

やらないこと: 本文の変更/`/lp/furuiie` の公開・受付時間/VPS 反映。

## 1. 種類の見分け方 = autoKey(列は足さない)

- 古い家の行に `auto_key = 'old_house'` を付け、添え書きは autoKey から決める純関数で引く。
- 列(例 `tagline`)を足す案は採らない: 添え書きは決まった4通りで、管理画面で自由に書ける必要がない。列にすると migration+管理画面の入力欄+確定後の扱いが増える。振り分けにも autoKey が要るので、見分けを1つにそろえられる。
- schema の変更なし。migration は「古い家の行に autoKey を付ける」データ更新1本だけ。

## 2. 本番の「古い家」の行に autoKey を付ける方法 = migration のデータ更新

前提: 本番の台帳に「古い家」の行がある(発注者が画面で確認)。管理画面には autoKey を変える欄が無い(作ると誰でも振り分けを変えられる)ので、migration で付ける。

```sql
-- 20261108000000_dm_scenario_old_house_auto_key
UPDATE "dm_scenarios" SET "auto_key" = 'old_house', "updated_at" = now()
WHERE "id" = (
  SELECT "id" FROM "dm_scenarios"
  WHERE "name" = '古い家' AND "deleted_at" IS NULL AND "auto_key" IS NULL
)
AND (SELECT count(*) FROM "dm_scenarios" WHERE "name" = '古い家' AND "deleted_at" IS NULL AND "auto_key" IS NULL) = 1
AND NOT EXISTS (SELECT 1 FROM "dm_scenarios" WHERE "auto_key" = 'old_house');
```
- 名前が完全一致する、消されていない行がちょうど1件のときだけ付ける。0件・2件以上なら何もしない(=現地調査は今までどおり空き家に落ちる・壊れない)。
- 行を新しく作ることはしない(文面の無い種類が自動で選ばれるのを防ぐ)。
- 戻すとき: `UPDATE dm_scenarios SET auto_key = NULL WHERE auto_key = 'old_house'`。
- 副作用: autoKey の付いた行は削除できない(既存の守り・409)。古い家も「使わない」で止める扱いになる。
- ⚠発注者に確認すること: 本番の行の名前が「古い家」ちょうどか(「古い家の手紙」などなら SQL の名前を合わせる)。

## 3. 変えるファイル

| ファイル | 変更 |
|---|---|
| `src/lib/sale-dm-letter/scenario-tagline.ts`(新規) | `taglineForAutoKey(autoKey: string \| null): string`。4通り+それ以外 |
| `src/lib/sale-dm-letter/scenario-resolve.ts` | `AUTO_KEY_BY_ROUTE.field_survey` を `["old_house","vacant"]` の順に(配列化して落ちる先を持たせる) |
| `src/lib/sale-dm-letter/letter-layout.ts` | `LETTER_FIXED_TEXT.tagline` を外す(または既定値扱い) |
| `src/lib/sale-dm-letter/templates/types.ts`・`templates/index.ts` | `LetterRenderInput.tagline` を足し、上部と署名の下の2か所で使う |
| `src/app/api/properties/sale-dm/campaigns/[id]/print/route.ts` | 宛先の型(variant)→ 種類の autoKey から添え書きを渡す |
| `src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx`(+ campaign GET API) | 画面の見本にも同じ添え書き |
| `src/lib/sale-dm-letter/lp-brand.ts`・`lp-page.ts` | `LP_BRAND.tagline` を外し、`LpRenderInput.tagline` で受ける |
| `lp-page-loader.ts`(/t/)・`lp-public-loader.ts`(/lp/)・LP のプレビュー2本 | 種類の autoKey から添え書きを渡す(/t/ は LP型の種類 → 無ければ手紙の型の種類) |
| `src/app/api/properties/sale-dm/scenarios/[id]/route.ts`・`admin/dm-scenarios/page.tsx` のコメント・説明 | 「相続・空き家」→ 古い家も含める |
| `public/docs` と正本の guide/manual | 「現地調査の物件は空き家」→「古い家(無ければ空き家)」・添え書きの説明 |

## 4. テスト

- 直す: `scenario-resolve` のテスト(現地調査 → 古い家/古い家が使わない・削除済み・台帳に無い → 空き家/空き家も無い → 既定/物件の欄が先)。`letter-layout.test.ts`・`sale-dm-templates.test.ts` の固定の添え書きの assert。
- 足す: `taglineForAutoKey` の4通り+null+知らない値。手紙の HTML に添え書きが2か所・エスケープ済み。LP のヘッダーの添え書き(/t/・/lp/ の読み込み側で種類ごと)。印刷 route が種類の添え書きを渡す。migration の SQL の走査(名前一致・1件だけ・作らない)。物件の「DMの種類」欄の自動の表示(現地調査 → 古い家)。

## 5. 確定済み・送付済みの手紙への影響

- 宛先ごとの種類(=どの手紙か)は発送を作った時点で決まっている。振り分けの変更は**これから作る発送だけ**に効き、作成済みの発送の宛先は動かない。本文も写し取り済みで変わらない。
- 添え書きは本文ではなく印刷のときに描く固定の文字。そのため:
  - 郵送済みの紙は当然変わらない。
  - **作成済みの発送をこれから印刷・刷り直すと、新しい添え書きで出る**(例: 空き家の手紙 = 「相続・不動産」→「空き家・不動産」/種類を使わない古いやり方の発送 = 「相続・不動産」→「住まい・不動産」)。これまでも固定の文字を変えたときは同じ扱い。
  - 刷り直しで郵送したものと一字も違えたくない場合は、発送ごとに添え書きを写し取る列が要る(migration)。今回は要らないと判断(発注者に確認)。
- 送付済みの手紙の QR から開くご案内ページ(/t/)は、開いた時点の添え書きになる(画面のみ)。
