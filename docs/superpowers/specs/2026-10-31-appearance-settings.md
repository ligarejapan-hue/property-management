# 見た目の設定(色テーマ・文字サイズ・レイアウト)設計メモ

2026-10-31 発注者の実装指示と回答にもとづく。段階1〜4で PR を分ける。

## 決定(発注者 2026-10-31)

- 色テーマ = 自動 + 7つ(スタンダード/ブルー/ダーク/和モダン/紺と金/森/ウォームペーパー)。初期値は「自動」(パソコンが明るい設定ならスタンダード、暗いならダーク)
- **スタンダード = 今の見た目**(藍と白・温かみのある灰色)。付録A の青い版は「ブルー」として別に足す
- 文字サイズ = 詰める/標準/大きめ。レイアウト = 左サイドバー/上部ナビ
- 1万か所のクラスを書き換えず、**Tailwind の色・大きさの元の値をテーマごとに差し替える**
- テーマで変えないもの: 状態の色(赤・琥珀・緑)・仲介/買取再販の色・帳票(PDF/Excel/見本)・印刷
- 保存 = users に theme/density/layout(NULL=会社の初期値)。会社の初期値 = system_settings の `appearance.default.*`
- 新しい画面・部品は意味の名前(`bg-surface` `text-fg-2` `bg-accent` …)で書く。既存は触ったついでに少しずつ

## 仕組み

### 段階1: 意味の名前の変数(見た目は変えない)
- `globals.css` の `:root` / `.dark` に付録A・B の名前の変数。値は Tailwind の `--color-gray-*` / `--color-indigo-*` / `--color-white` などを指すだけ
- `@theme inline` でクラス名に(`bg-page` `bg-surface` `text-fg-2` `bg-accent` `bg-side-bg` …)
- `--color-iris-*` = テーマで変わらない藍(Tailwind 既定の indigo と同じ値)。藍が「状態・種類の色の組の1つ」の箇所はこちら

### 段階2: テーマと文字サイズの切り替え
- 色: next-themes(今までのダークモードの仕組み)に乗せる。`attribute=["class","data-theme"]`・`themes=NEXT_THEMES`・`value=NEXT_THEME_VALUES`(全テーマを書くこと)。今まで「自動/明るい/暗い」を選んでいた人の保存値(system/light/dark)は、そのまま 自動/スタンダード/ダーク になる
- テーマの色: `html[data-theme="…"]` で gray・indigo の11段と white、サイドバーの変数を差し替える。値は `scripts/appearance/gen-themes.mjs` が付録A から作る(gray-50=ページ背景/100=薄い面/200=枠線/500=注記/700=補足/900=本文、indigo-50=薄いアクセント/600=主ボタン/700=押したとき)
  - ⚠必ず html に置く(下の要素に置くと、:root で決まった意味の変数が追従しない)
  - ダーク = 今のダーク(`.dark`)のまま。付録A のダークの値は使っていない(スタンダード=今の見た目に合わせた判断・発注者に報告済み)
  - 注記の色(gray-500)は付録A の text-3 を少し濃くした(ページの背景の上で 3:1 に届かなかったため)。`node scripts/appearance/contrast.mjs src/app/globals.css` で確かめる
- 文字サイズ: `html[data-density]` の font-size(詰める 14px/標準 16px/大きめ 18.75px)。Tailwind の文字・余白・角丸は rem なので全体が伸び縮みする。大きめは UD フォント・入力欄の線 2px・チェック 26px
- 画面だけ: `dark:` と `.dark` とテーマの差し替えは `@media screen` の中。**印刷はどの設定でもスタンダード**
- 白い紙: 画面の中に直接描く紙(販売図面の編集)は `.paper-sheet` でスタンダードの色に戻す。iframe の見本(資金計画表・事業計画書・LP)はもともと切り離されている
- 保存と反映:
  - `PATCH /api/me/preferences`(自分の分だけ・選択肢以外は 422・null=会社の標準に戻す)/`GET` で 個人・会社・実際の値
  - ルートの layout がログイン中の人の設定を DB から読み、`<head>` の小さなスクリプト(`boot-script.ts`)で画面を描く前に付ける=別の PC でも同じ・ちらつかない。端末の localStorage はキャッシュ(正は DB)。使えない環境でも落ちない
  - ヘッダーとスマホのメニューに「色」「文字」の選択。選んだ瞬間に反映し、裏で保存

### 段階3: レイアウト(side/top)
- 上部ナビ = `src/components/layout/top-nav.tsx`。項目は左メニューと同じ定義(`sidebar-model.tsx` の SIDEBAR_GROUPS → visibleSidebar)から `top-nav-model.ts` の純関数で作る=項目を足すのは1か所
  - ホーム・中が1つの柱=リンク/中が複数の柱=開くメニュー/柱でないグループ(物件データ編集・システム管理・資料)=「その他」に見出しごと
  - 現在地=左メニューと同じ isNavItemActive(aria-current)。位置(#)の追い方は `use-nav-hash.ts` で左メニューと共通
  - 開いたメニューは 外を押す・Esc(ボタンへ戻る)・項目・画面の移動 で閉じる。右に入りきらないときだけ右寄せ(menuAlignRight)・長いメニューは画面の高さで止めて中を送る
- 出し分け = globals.css。`html[data-layout]` は描画前に付く=ちらつかない。広い画面(64rem=lg 以上)だけ。狭い幅はどちらの設定でも今までのドロワー(左上の ≡)=指示の「760px 以下は同じスマホ用」を含み、タブレット幅も今まで通り
- ヘッダーの「配置」の選択欄は xl(1280px)以上だけ(1024px・大きめで溢れたため)。ログアウトの文字も xl 以上(絵だけでも aria-label)
- Ctrl+K などアプリ全体のショートカットは今のアプリに無い(Ctrl+P の印刷止めは枠に関係なく同じ)
### 段階4: 設定画面(設定 > 表示)・会社の初期値
- 画面 = `/settings/display`(「表示の設定」・だれでも自分の分)。部品 = `src/components/settings/display-settings.tsx`・見本 = `display-previews.tsx`
  - 3つの設定を見本付きの選択肢で並べる。選択肢は本物のラジオ(fieldset+legend・矢印キーで選べる・キーボードで選んだ枠を出す)
  - 色の見本 = ミニ画面(サイドバー・ヘッダー・カード・主ボタン)。色は各テーマの値で描く(`src/lib/appearance/swatches.ts`。5テーマは globals.css と同じ値=テストで突き合わせ・スタンダード/ダークは Tailwind の元の色)。自動はスタンダードとダークを半分ずつ
  - 文字の見本 = 「目黒区中町 マンション 302号室」を、その設定のときの px で(rem で描くと今の大きさになり見比べられない)
  - 押した瞬間に反映し、保存は自動。「保存しました」を小さく出して 2.5 秒で消す(失敗の知らせは消さない)
  - 「会社の標準に戻す」= 3つとも null を保存 → 保存後の実際の値で描き直す
- 会社の標準(管理者=user_management:write だけ・同じ画面の下の欄 `#company`)
  - 保存 = `PUT /api/admin/appearance-defaults`(監査ログ `appearance_defaults_update`・対象 system_settings)。system_settings の `appearance.default.theme/density/layout`(null=行を消す=既定)
  - 選べる色テーマ = `appearance.allowed.themes`(カンマ区切り・**行が無い=全部許可**=今の運用)。外した色は 設定画面・利用者メニュー・スマホのメニューの選択肢から消え、`PATCH /api/me/preferences` も 422。会社の標準の色は選べる色に入っていないと保存できない
  - 個人の色が許可外になった人は、会社の標準の色で描く(resolveAppearance の3つ目の引数)
  - `GET`/`PATCH /api/me/preferences` は同じ形(user・company・allowedThemes・effective・canEditCompany)。⚠PATCH の応答に canEditCompany が無いと、保存した直後に管理者の欄が消えた(実機で発見)
- ヘッダー = 利用者メニュー(`src/components/layout/user-menu.tsx`)。名前を押すと 色テーマ をすぐ切り替え・「表示の設定」へのリンク(スマホの幅ではパスワード変更も)。段階2・3 でヘッダーに並べていた 色・配置・文字 の選択欄はここと 設定画面 へ移した(1024px でヘッダーが溢れる問題・上部ナビの人が戻せない問題が無くなった)。ログアウトの文字は md 以上
  - スマホの幅ではメニューを画面の両端に合わせる(ボタンの右端にそろえると左へはみ出した)。鍵の絵は sm 以上だけ(題名の幅を残す)
- スマホのメニュー(ドロワー)は今まで通り 色・文字 の選択欄+「表示の設定を開く」
- コントラスト: 追加の5テーマの注記(gray-400)が白地で 2.3〜2.6 → `gen-themes.mjs` で白地・背景とも 3:1 以上になるまで濃くした(`contrast.mjs` に 背景との組も追加)。**スタンダード(今の見た目)の gray-400 は 2.6・ダークは基準以上**=スタンダードは今の見た目を変えるので発注者に判断をあおぐ
- 動き: 選択肢の枠・矢印は `motion-reduce:transition-none`
