"use client";

import { useEffect, useState } from "react";
import {
  answerScreenTokenProbes,
  ensureUniqueScreenToken,
} from "@/lib/edit-lock/screen-token-client";

/**
 * 編集中の鍵(仕様 6.1)の「合言葉の一生」を1本に括り出した hook。
 *
 * 外部レビュー(@codex)P1・round2で見つかった穴: この一生はもともと
 * `properties/[id]/page.tsx` にしか書かれていなかった。しかし
 * `CorporateLookupPanel`(`applyOwnerCorporate`経由で鍵のヘッダ=合言葉を送る)は
 * `admin/owners/[id]/page.tsx` からも描かれるのに、その画面は応答器も一意化も
 * 持っていなかった。物件詳細タブを複製 → 片方が先に鍵を取る → 管理画面の
 * 複製タブが古い合言葉のまま反映を送ると、サーバは「合言葉が保持者と同じ=
 * 同じ画面からの操作」と分類して**鍵をすり抜けさせてしまう**(defeats the lock)。
 *
 * Ruling: この一生は「物件詳細の画面」のものではなく、**鍵のヘッダを送る
 * すべての画面**のもの。新しく鍵のヘッダを送る画面を作るときは、必ずこの
 * hook を呼ぶ(呼んでいるか否かはラチェット=`screen-token-client.test.ts` の
 * 「応答器の設置箇所」テストが導出型で検査する)。
 */
export function useEditScreenToken(): { tokenReady: boolean } {
  // 他のタブからの「その合言葉を使っていますか」に、この画面が開いている間
  // ずっと答える。
  // ⚠**画面につき1本・画面の寿命ぶん**。波括弧なしの暗黙return(停止関数を
  //   捨てない)。編集中かどうかで絞ってはいけない(`if (editing)` 等を入れた
  //   瞬間がP1の再発):空いている(まだ何も編集していない)タブを複製したとき、
  //   元のタブが答えないと複製タブは写し取った合言葉を使い続け、あとで両方が
  //   編集し始めても `held_by_self_other_screen` にならず同じ画面として
  //   扱われる(D6「自分の別の窓も待つ」が黙って壊れる)。
  useEffect(() => answerScreenTokenProbes(), []);

  // 複製タブ確認(最大300ms)は画面が開いたとき**1回だけ**行う。
  // ⚠上の応答器より**後**に置く(自分自身の答えは `docId` が一致するので
  //   複製と数えない=Task 6 fix round 1。この順序は変えない)。
  const [tokenReady, setTokenReady] = useState(false);
  useEffect(() => {
    let alive = true;
    // ⚠複製タブ確認そのものが失敗しても(fail open・screen-token-client.ts と
    //   同じ姿勢)、呼び出し側の「確認待ち」だけは解除する
    //   (.catchで拾い、unhandled rejectionにしない)。
    ensureUniqueScreenToken()
      .catch(() => {})
      .finally(() => {
        if (alive) setTokenReady(true);
      });
    return () => {
      alive = false;
    };
    // 開いたとき1回だけ。
  }, []);

  return { tokenReady };
}
