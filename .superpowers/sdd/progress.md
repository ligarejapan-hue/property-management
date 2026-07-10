# SDD Progress — sales-sheet レイアウト最適化エンジン(機能A)
Plan: docs/superpowers/plans/2026-07-10-sales-sheet-layout-engine.md
Spec: docs/superpowers/specs/2026-07-10-sales-sheet-layout-polish-design.md
Base commit (impl starts here): 36207df

- [x] Task 1: computeSpecSheetLayout 純関数 (commit 90be84f・test5/5+full8493緑・tsc0)。⚠concern: splitX=lerp(84,145)は写真少時に表が広くならず(1枚で写真96mm)・0枚で左に空き=バランス比率は→比率補正済(splitX min94・fix commit)。最終Task6でverify実物確認
- [x] Task 2: buildSpecSheetDocument エンジン駆動 (commit db5167d・full8494緑・parity緑・tsc0・build-mansion/spec-sheet-doc の座標assertをengine期待値へ更新・font証跡test追加)
- [x] Task 3: autoBalanceLayout reducer (commit be38480・6/6+full8500緑・tsc0・DEFAULT_FOOTER_H を layout-engine へ集約)
- [x] Task 4+5(統合): レイアウト自動調整ボタン+文字サイズ変更連動 (commit 705da8c・649緑+1・tsc0・eslint0)
- [x] (Task5はTask4に統合済)
- [x] Task 6: 完了。全ゲート緑・broad review(opus)→Critical0/Important2+lower を fix subagent で解消(a490434・full8505緑)・PR#271作成・@codex起動済。マージはユーザー。

## 最終レビューで対応する既知事項
- ⚠循環import: layout-engine.ts が editor-document.ts の packPhotoCells を import・editor-document.ts が layout-engine の computeSpecSheetLayout/DEFAULT_FOOTER_H を import。動作OKだが@codex要注意。**fix=packPhotoCells/PhotoCell を layout-engine.ts へ移設し editor-document は逆import**（min cell 定数はローカル化）。broad review 後の fix pass で。

## broad review 所見(要ユーザー共有)
- Fix中: (1)間取り図の重なり[latentだが実欠陥] (2)文字再バランスをテンプレ要素にスコープ (3)footer下限clamp。
- ⚠設計の深い論点(PRで共有): 機能②「文字サイズ→枠最適化」は、レイアウトを駆動する唯一のフォント=概要表(table)フォントがeditText非対象(engine駆動)のため、text要素のフォント変更は実質レイアウトを変えず「再バランスで手動配置が戻る」だけになりがち。今回はテンプレ要素へスコープして害を減らすが、②を本来の形にするには「表フォントをユーザー可変化→それで再fit」の小設計が要る(follow-up候補)。

## @codex PR#271
- R1(head a490434): P1×2 セールスポイント帯の重なり(写真下端/overview列)・P2 autoBalanceLayoutが表フォント再計算しない=**全て実在**→fix subagent実行中(salesPoints幅を左カラムに+写真敷詰めで帯確保/overviewFontPt渡さず再計算)。CI pass。
