/**
 * 鍵を持たない入口が 423 `EDIT_LOCKED` を受けたときの文言を組み立てる
 * (仕様 6.5・fix round 1〜2)。
 *
 * ⚠窓口(`assertNotEditLockedByOther`・`src/lib/edit-lock/service.ts`)の423は
 *   保持者名も開始時刻も返さない(「他の画面で編集中です」だけ)。そのデータは
 *   状態の窓口(`fetchEditLockStatus`)にしかないため、`EDIT_LOCKED` を受けた
 *   **そのときだけ**その資源1件を状態窓口へ問い合わせ、帯(`EditLockBanner`)と
 *   同じ文言(「{氏名}さんが編集中です({HH:mm}〜)」・`formatSince` を再利用)を
 *   組み立てる。まれな経路の1回きりの追加リクエストであり、先読み・ポーリングは
 *   しない。
 * ⚠問い合わせが失敗した・該当行が無い・「他の人が持っている」以外(自分の別画面
 *   ・free 等)なら、呼び出し側が渡した封筒の `message` にフォールバックする。
 *   どの分岐でも画面を無言のままにしない(仕様 6.5)。
 * ⚠**このモジュールは `src/lib/` に置く純関数/非同期関数だけの集まりで、
 *   component モジュール("use client" な `.tsx`)を import しない**(review round2
 *   Important B)。`formatSince` は `edit-lock-banner.tsx`(`ui/button`・
 *   `ui/confirm-dialog`・`api-client` を引き込む)ではなく、それらを持たない
 *   `ui-state.ts` から取る。Task 6 fix round 1 #3 が `canSubmitSave`/
 *   `shouldShowLockUnavailableNotice` を同じ理由でコンポーネントモジュールの
 *   外へ出した判断と揃える(そちらを踏襲せず一度違反していたのを、この回で直す)。
 * ⚠**問い合わせには上限時間(`EDIT_LOCK_MESSAGE_LOOKUP_TIMEOUT_MS`)を設ける**
 *   (review round2 Important A・round3 Minor H)。上限を超えたら封筒の message
 *   にフォールバックする(`Promise.race`)。⚠この上限は「控え(ボタン等)を
 *   塞がないため」ではない(round2時点の誤り。round3で訂正=呼び出し側が
 *   もう `await` しないため、控えは既に即座に解放されている)。役目は
 *   ①`setTimeout` をいつまでも宙に浮かせないこと、②Important G の世代の
 *   見張り(`prev === envelopeMessage`)が効く現実的な時間内に組み立てを
 *   届かせること、の2つだけ。内部の問い合わせ自体は自前で catch して
 *   常に解決する(reject しない)ので、負けた側が後で reject しても
 *   unhandled rejection にはならない。
 * ⚠**負けた側のタイマーは片付ける**(review round3 Minor I)。`Promise.race` で
 *   タイムアウト側が勝っても・負けても、`setTimeout` のハンドルは
 *   `clearTimeout` する(勝った側=問い合わせが先に終わったときに、タイマーだけ
 *   宙に浮いたまま残らないようにする)。
 * ⚠**呼び出し元が既に持っている状態の行は、それが氏名を名乗っているときだけ使う**
 *   (Task 9・review round1 Important 2で訂正)。物件詳細(見ている側)は
 *   `useEditLockStatus` で30秒ごとに状態を持っているため、案件ステータス・
 *   導入ルートのプルダウン(`page.tsx`)はその場で持っている行を `preFetchedRows`
 *   に渡せる。**しかし**この関数を呼ぶ入口(プルダウン)は、渡している行と
 *   **同じ行**で保存ボタン自体を無効化している(`disabled={... || editLockHeld}`)
 *   ため、保存が実際に実行できて423を受け取れる経路では、渡された行は
 *   ほぼ常に `free`/`mine`(=直前の30秒ポーリングと今の423の間に、たった今
 *   誰かが鍵を取った)であり、**保存を拒んだ本人の氏名を持っていない**。
 *   渡された行をそのまま「他の人が持っている」の根拠として使うと、氏名を
 *   名乗れる状態の窓口への問い合わせを飛ばしてしまい、仕様6.5の
 *   「{氏名}さんが編集中です({HH:mm}〜)」が汎用の封筒文言へ**後退**する
 *   (氏名を知る機会を自ら潰す退行)。そこで、渡された行が
 *   `held_by_other` かつ `holderName` を持つ(=氏名を名乗れる)ときだけ
 *   その場で使い、そうでなければ(free/mine/該当資源が無い/等)従来どおり
 *   状態窓口へ1回問い合わせる——「渡された行が使い物になる場合だけ節約する」
 *   契約にする(節約できない場合でも氏名を諦めない)。
 */
import { fetchEditLockStatus, type EditLockStatusRow } from "@/lib/api-client";
import { formatSince } from "@/lib/edit-lock/ui-state";
import { EDIT_LOCK_MESSAGE_LOOKUP_TIMEOUT_MS } from "@/lib/edit-lock/rules";

/** 「他の人が持っている」と氏名まで名乗っている行か(=そのまま使ってよい)。 */
function namesHolder(row: EditLockStatusRow | undefined): row is EditLockStatusRow & { holderName: string } {
  return row?.state === "held_by_other" && !!row.holderName;
}

async function lookupComposedMessage(
  resourceType: EditLockStatusRow["resourceType"],
  resourceId: string,
  envelopeMessage: string,
  preFetchedRows?: EditLockStatusRow[],
): Promise<string> {
  try {
    const preFetchedRow = preFetchedRows?.find(
      (r) => r.resourceType === resourceType && r.resourceId === resourceId,
    );
    // ⚠(review round1 Important 2) 渡された行を使うのは、それが氏名を
    //   名乗っているときだけ。該当資源が preFetchedRows に無い場合
    //   (find が undefined を返す)も含め、それ以外は必ず1回問い合わせる
    //   ——「渡されたから」というだけで氏名を諦めて封筒文言へ落とさない。
    const row = namesHolder(preFetchedRow)
      ? preFetchedRow
      : (await fetchEditLockStatus([{ resourceType, resourceId }])).find(
          (r) => r.resourceType === resourceType && r.resourceId === resourceId,
        );
    if (namesHolder(row)) {
      return `${row.holderName}さんが編集中です(${formatSince(row.since)}〜)`;
    }
  } catch {
    // 問い合わせの失敗は無視してフォールバックへ落ちる(下の return)。
  }
  return envelopeMessage;
}

export async function composeEditLockedMessage(
  resourceType: EditLockStatusRow["resourceType"],
  resourceId: string,
  envelopeMessage: string,
  /** 呼び出し元が既に持っている最新の状態行(Task 9)。渡せば問い合わせを省く。 */
  preFetchedRows?: EditLockStatusRow[],
): Promise<string> {
  const lookup = lookupComposedMessage(resourceType, resourceId, envelopeMessage, preFetchedRows);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(envelopeMessage), EDIT_LOCK_MESSAGE_LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    // ⚠review round3 Minor I: 問い合わせが先に終わって timeout 側が負けても、
    //   宙に浮いた setTimeout をここで必ず片付ける。
    clearTimeout(timer);
  }
}
