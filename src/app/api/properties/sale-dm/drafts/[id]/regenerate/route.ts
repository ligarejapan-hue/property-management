import { NextRequest, NextResponse } from "next/server";

/**
 * AI 直結による本文の再生成（廃止・設計 §2.1）。
 *
 * 発注者の方針は「AI の API 直結を**やめる**」であり、置き換えであって共存ではない。
 * ボタンを隠すだけだと、設定が入っている環境で**宛先の個人情報を外部APIへ送る旧経路**が
 * 生き残る。設定の有無に関わらず 410 で閉じる。
 *
 * ⚠復活させたくなったときは、この無効化を外して旧実装（git 履歴）を戻すだけでよい。
 *   文面は外部AI方式（プロンプト表示→貼り付け→適用）で作る。
 */
export async function POST(_req: NextRequest) {
  return NextResponse.json(
    {
      error: {
        message:
          "AIによる本文の生成は廃止されました。型ごとのプロンプトを表示して、お手元のAIで作った本文を貼り付けてください",
        code: "GONE",
      },
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
