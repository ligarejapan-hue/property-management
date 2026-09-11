// LP型ごと/組み合わせの集計を出してよいかの判定(@codex R10 P1)。
//
// 公開LPのロールアウトゲート(SALE_DM_LP_PUBLIC_ENABLED)と**同じ env** を見る。スイッチが未投入の
// うちは /t/ が全員を同じ外部LPへ転送するため、lpVariantId で束ねた「閲覧」はページの成績ではなく
// 外部LPへの訪問でしかない(計数 recordTrackingHit はページの出し分けより前に走るので数字は付く)。
// スイッチ投入後も、LP型ごと/組み合わせの「閲覧」はアプリ内ページを実際に返せた宛先だけを数える
// (集計 aggregate.ts が lpPageFirstAt を使う)。
//
// ⚠画面と API は必ず一致させる。ただし画面(client)は env を読めないため、
//   **API が集計JSONに lpMetricsEnabled を載せ、画面はその項目を見る**(この関数を import しない)。
import { parseLpPublicEnabled } from "./config";

export function isLpMetricsEnabled(): boolean {
  return parseLpPublicEnabled(process.env.SALE_DM_LP_PUBLIC_ENABLED);
}
