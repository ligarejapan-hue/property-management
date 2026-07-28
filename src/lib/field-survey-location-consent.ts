/**
 * 位置記録の同意を「その端末で一度出したか」だけ覚えておく。
 *
 * 業務判断 (2026-07-29): **同意文は初回だけ**。巡回のたびに出すと毎日の
 * 業務で邪魔になる。一方、従業員の位置を記録する機能なので「一度も
 * 知らせない」にはしない。
 *
 * ⚠サーバには持たない。端末ごと・ブラウザごとの表示制御であって、
 * 同意の法的記録ではない (端末を変えればもう一度出る = 安全側)。
 * ⚠localStorage は SSR に無く、プライベートモードでは参照・書込とも
 * 例外を投げうる。**失敗しても業務を止めない**。最悪もう一度同意文が
 * 出るだけで、記録が止まったり巡回が始まらなかったりはしない。
 */

/** 同意文の内容を変えたら版を上げて取り直す。 */
export const FIELD_SURVEY_LOCATION_CONSENT_KEY =
  "field-survey.location-consent.v1";

/** 保存する印。座標・氏名・ID の類は一切入れない。 */
const CONSENT_MARK = "1";

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // プライベートモードでは参照自体が投げることがある。
    return null;
  }
}

/** その端末で既に同意文を出して同意済みか。 */
export function hasLocationConsent(): boolean {
  const s = storage();
  if (!s) return false;
  try {
    return s.getItem(FIELD_SURVEY_LOCATION_CONSENT_KEY) === CONSENT_MARK;
  } catch {
    return false;
  }
}

/** 同意を記録する。失敗しても黙って諦める (次回もう一度出る)。 */
export function markLocationConsent(): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(FIELD_SURVEY_LOCATION_CONSENT_KEY, CONSENT_MARK);
  } catch {
    // 容量超過 / プライベートモード。業務は続行する。
  }
}
