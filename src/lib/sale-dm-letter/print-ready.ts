/**
 * 「売却DMを作成して印刷できる前提が揃っているか」の**唯一の判定規則**（純関数・env非依存）。
 *
 * ⚠なぜ1本化するか: 実績91で**AI直結の生成を廃止**したあとも、設定画面だけが
 *   「AI種別＋APIキー」を要求し続け、**使えるのに「使えません」と表示**していた。
 *   管理者が不要な有料API契約に進みかねない実害があった。原因は同じ規則を画面と
 *   サーバーに別々に書いたことなので、規則はここだけに置き、両方がこれを使う。
 * ⚠env を読まない: 設定画面（client component）から import するため、
 *   env 値がクライアントの束に混ざらないようにする。env からの解決はサーバー側で行い、
 *   解決済みの値をこの関数に渡す。
 */

/** 絶対 http(s) URL のみ有効として返す。空/相対/非http は undefined（=未設定扱い）。 */
export function resolveAbsoluteHttpUrl(
  raw: string | null | undefined,
): string | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:" ? trimmed : undefined;
  } catch {
    return undefined; // scheme/host の無い相対値(example.com, /app 等)は使えない。
  }
}

/** 郵送先で機能するには絶対URLが必須（非空なだけでは足りない）。 */
export function isAbsoluteHttpUrl(raw: string | null | undefined): boolean {
  return resolveAbsoluteHttpUrl(raw) !== undefined;
}

export interface SaleDmPrintReadyInput {
  /** 郵送QRの追跡URLの基点（絶対URL）。 */
  trackingBaseUrl?: string | null;
  /** 短縮URLの遷移先 既定LP（絶対URL）。 */
  lpUrl?: string | null;
  senderName?: string | null;
  senderContact?: string | null;
}

/** 揃っていなければならない4項目（表示順＝画面の並び順）。 */
const REQUIREMENTS: ReadonlyArray<{
  label: string;
  ok: (v: SaleDmPrintReadyInput) => boolean;
}> = [
  { label: "追跡URL", ok: (v) => isAbsoluteHttpUrl(v.trackingBaseUrl) },
  { label: "既定LP URL", ok: (v) => isAbsoluteHttpUrl(v.lpUrl) },
  { label: "差出人名", ok: (v) => !!v.senderName?.trim() },
  { label: "差出人の連絡先", ok: (v) => !!v.senderContact?.trim() },
];

/**
 * ⚠AIの種類・APIキーは条件に**入れない**（外部AI方式に変えたため。設計 §2.5）。
 *   引数として受け取らないことで、書き足しでも混ざらないようにしている。
 */
export function isSaleDmPrintReady(v: SaleDmPrintReadyInput): boolean {
  return REQUIREMENTS.every((r) => r.ok(v));
}

/** 足りない項目だけを日本語で返す（画面の案内文の唯一の出所）。 */
export function missingSaleDmPrintRequirements(
  v: SaleDmPrintReadyInput,
): string[] {
  return REQUIREMENTS.filter((r) => !r.ok(v)).map((r) => r.label);
}
