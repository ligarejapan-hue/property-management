/**
 * 謄本の有料取得「月の上限」の純関数と定数(2026-10-29 発注者決定=5万円/月)。
 *
 * ⚠ここは**画面からも読む**(上限・値段・表示の文言)。DB や prisma を import しない
 *   (読み出しと予約は monthly-cap-store.ts)。
 *
 * ## 何を数えるか(2026-10-29)
 * 二重課金ガードと**同じ台帳**(AuditLog action=registry_location_purchase)。
 * この台帳は「請求ボタンを押した後」にだけ書かれる:
 *   - outcome:"charged"            … provider が PDF を返した直後(=課金済み)
 *   - outcome:"charged_but_failed" … 課金後(またはその可能性がある段)で失敗
 * どちらも**お金が動いた(かもしれない)取得**なので数える。課金前に止まった取得は
 * 台帳に書かれない=数えない(既存の分類にそのまま乗る)。
 * ⚠1回の取得で「charged」を書いた後に後段(PDF検証・添付)で失敗すると、同じ鍵で
 *   「charged_but_failed」がもう1行書かれる。これは**1件**として数える(組にする)。
 * ⚠中身が読めない記録・知らない outcome は数える(高い方の値段で)。迷う記録は安全側。
 */
import type { RegistryCertificateType } from "./types";

/** 月の上限(円)。⚠env では変えない(発注者決定の値をコードに固定する)。 */
export const REGISTRY_PURCHASE_MONTHLY_CAP_YEN = 50_000;

/**
 * 証明書の種類ごとの1通の値段(円)。
 * - owner(所有者事項)=140円: 2026-08-19/21 の実課金で確認画面の金額を実測。
 * - all(全部事項)=335円: ⚠**未実測**。公表の手数料(330円台)より少し多めに置いた
 *   見積もり(多めに数える=上限の手前で止まる側)。実課金で確認したら直すこと。
 */
export const REGISTRY_CERTIFICATE_PRICE_YEN: Readonly<
  Record<RegistryCertificateType, number>
> = {
  owner: 140,
  all: 335,
};

/** 二重課金ガードの台帳(auto-fetch.ts の REGISTRY_PURCHASE_AUDIT_ACTION と同じ値)。 */
export const REGISTRY_PURCHASE_LEDGER_ACTION = "registry_location_purchase";

/** 上限で止めたときの分類コード(ApiError.code)。画面・一括の分類が見る。 */
export const MONTHLY_CAP_REACHED_CODE = "REGISTRY_PURCHASE_MONTHLY_CAP_REACHED";
/** 今月の額を数えられなかった(台帳が読めない)ときの分類コード。買わずに止める。 */
export const MONTHLY_CAP_UNAVAILABLE_CODE =
  "REGISTRY_PURCHASE_MONTHLY_CAP_UNAVAILABLE";

/** 上限で止めたときの文言(1件の取得・一括の作成で共通)。 */
export const MONTHLY_CAP_REACHED_MESSAGE =
  "月の上限（5万円）に達したため取得しませんでした（課金していません）。来月1日から取得できます。";

/** 日本時間(UTC+9・夏時間なし)。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 「charged → charged_but_failed」を同じ取得の組とみなす間隔。
 * 同じ鍵は二重課金ガードで30日買い直せないので、1日以内の組は同じ取得しかあり得ない。
 * ⚠長くすると**別の取得を1件に潰して少なく数える**余地が出るので広げない。
 */
export const LEDGER_PAIR_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 種類の値段。⚠分からない種類は高い方(少なく数えない)。 */
export function registryCertificatePriceYen(type: unknown): number {
  if (type === "owner" || type === "all") {
    return REGISTRY_CERTIFICATE_PRICE_YEN[type];
  }
  return Math.max(...Object.values(REGISTRY_CERTIFICATE_PRICE_YEN));
}

/** 日本時間の暦月の範囲 [start, end)(どちらも UTC の Date)。 */
export function jstMonthRange(now: Date): { start: Date; end: Date } {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1) - JST_OFFSET_MS),
    end: new Date(Date.UTC(y, m + 1, 1) - JST_OFFSET_MS),
  };
}

export interface PurchaseLedgerRow {
  createdAt: Date;
  detail: unknown;
}

function detailField(detail: unknown, key: string): unknown {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return undefined;
  }
  return (detail as Record<string, unknown>)[key];
}

/**
 * 台帳の記録から、範囲 [start, end) に入る課金額の合計を出す。
 * ⚠範囲より前の記録は**組を作るためだけ**に使う(前月末の charged と月初の
 *   charged_but_failed は前月の1件)。
 */
export function sumMonthlyPurchaseYen(
  rows: PurchaseLedgerRow[],
  range: { start: Date; end: Date },
): number {
  const sorted = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  // 鍵ごとの、まだ組になっていない直近の charged の時刻。
  const lastChargedAt = new Map<string, number>();
  let total = 0;
  for (const row of sorted) {
    const t = row.createdAt.getTime();
    const hash = detailField(row.detail, "purchaseKeyHash");
    const outcome = detailField(row.detail, "outcome");
    const key = typeof hash === "string" && hash ? hash : null;

    let pairedWithCharged = false;
    if (key && outcome === "charged_but_failed") {
      const prev = lastChargedAt.get(key);
      if (prev !== undefined && t - prev <= LEDGER_PAIR_WINDOW_MS) {
        pairedWithCharged = true;
        // 1つの charged に組ませるのは1回だけ。
        lastChargedAt.delete(key);
      }
    }
    if (key && outcome === "charged") {
      lastChargedAt.set(key, t);
    }

    if (pairedWithCharged) continue;
    if (t < range.start.getTime() || t >= range.end.getTime()) continue;
    total += registryCertificatePriceYen(
      detailField(row.detail, "certificateType"),
    );
  }
  return total;
}

export interface MonthlyCapDecision {
  allowed: boolean;
  /** 今月の額(台帳)+取得中(まだ台帳に無い)。 */
  usedYen: number;
  /** 上限までの残り(0 未満にしない)。 */
  remainingYen: number;
}

/**
 * 「今月の額+取得中+今回の値段 > 上限」なら止める。ちょうど上限は通す。
 */
export function decideMonthlyCap(input: {
  spentYen: number;
  pendingYen: number;
  priceYen: number;
  capYen: number;
}): MonthlyCapDecision {
  const usedYen = input.spentYen + input.pendingYen;
  return {
    allowed: usedYen + input.priceYen <= input.capYen,
    usedYen,
    remainingYen: Math.max(0, input.capYen - usedYen),
  };
}

/** 1,400円 の形(ロケールに依らない)。 */
export function formatYen(yen: number): string {
  return `${String(Math.trunc(yen)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}円`;
}

/** 「今月の有料取得 ◯円/50,000円」。 */
export function describeMonthlyUsage(usedYen: number, capYen: number): string {
  return `今月の有料取得 ${formatYen(usedYen)}/${formatYen(capYen)}`;
}

/** 画面用: 利用額(GET /api/registry-fetch/monthly-usage の応答)。 */
export interface RegistryMonthlyUsage {
  capYen: number;
  /** 台帳から数えた今月の額。 */
  spentYen: number;
  /** 取得中(予約済み・まだ台帳に無い)の額。 */
  pendingYen: number;
  /** spentYen + pendingYen。 */
  usedYen: number;
  prices: Record<RegistryCertificateType, number>;
  /** 次に数え直しが始まる時刻(日本時間の翌月1日 0:00・ISO)。 */
  resetsAt: string;
}

/** その種類をもう1通買えるか(画面のボタンの可否)。 */
export function canAffordCertificate(
  usage: Pick<RegistryMonthlyUsage, "usedYen" | "capYen">,
  type: RegistryCertificateType,
): boolean {
  return usage.usedYen + registryCertificatePriceYen(type) <= usage.capYen;
}

/**
 * 押せないときの理由(押せるなら null)。
 * 安い方(所有者事項)ならまだ入るときは、全部事項だけ止めて残りの額を伝える
 * (「上限に達した」と言うと、まだ取れる所有者事項まで諦めさせてしまう)。
 */
export function monthlyCapBlockedReason(
  usage: Pick<RegistryMonthlyUsage, "usedYen" | "capYen">,
  type: RegistryCertificateType,
): string | null {
  if (canAffordCertificate(usage, type)) return null;
  if (type === "all" && canAffordCertificate(usage, "owner")) {
    return `今月の残り（${formatYen(Math.max(0, usage.capYen - usage.usedYen))}）では全部事項は取得できません（月の上限 5万円）。所有者事項なら取得できます。`;
  }
  return "月の上限（5万円）に達したため、今月はこれ以上取得できません（来月1日から取得できます）。";
}
