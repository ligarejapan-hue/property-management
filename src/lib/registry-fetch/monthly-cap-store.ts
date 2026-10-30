/**
 * 謄本の有料取得「月の上限」の読み出しと予約(2026-10-29)。
 *
 * ## なぜ「予約」が要るか
 * 台帳(AuditLog)は**課金した後**に書かれる(provider が返った直後 / 課金後の失敗時)。
 * 台帳だけで判定すると、「判定は通った・まだ台帳に無い」取得(順番待ち・取得中)が
 * 見えず、並行する取得(一括の各件・別の人が同時に押す)が**揃って上限の内側と
 * 判断して超える**。そこで判定を通した取得の額をプロセス内で「予約」として持ち、
 * 判定は「台帳の額+予約の額+今回の値段」で行う。
 *
 * ## 並行しても超えない根拠
 *  1. 判定(台帳を読む→足し算→予約を足す)と予約の取り外しを**1本の列**で直列にする。
 *     → 判定の途中(読んでから足すまで)に予約が外れることはない。
 *  2. 予約を外すのは、その取得の台帳を**書き終えた後**(または課金していないと
 *     確定した後)だけ(runRegistryAutoFetch の finally)。
 *     → どの判定から見ても、ある取得の額は「予約」か「台帳」の少なくとも一方に入る
 *       (両方に入る瞬間はあり得る=多めに数える側)。
 *  3. 課金したのに台帳が書けなかった取得は予約を**外さない**(retain)。
 *     → 記録の無い課金も、このプロセスが動いている限り、**その課金の月(日本時間)の間**数え続ける
 *       (翌月の枠は食わない=@codex #614 R1。取得中の予約は月をまたいでも数える)。
 * 総当たりの検証=__tests__/monthly-cap-store.test.ts。
 *
 * ⚠列はプロセス内だけで効く(runExclusivePurchase と同じ前提。本番は単一プロセス
 *   運用・purchase-safety.ts 冒頭)。複数台/複数ワーカーにするならDB側の鍵へ移すこと。
 */
import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import type { RegistryCertificateType } from "./types";
import {
  REGISTRY_PURCHASE_MONTHLY_CAP_YEN,
  REGISTRY_CERTIFICATE_PRICE_YEN,
  REGISTRY_PURCHASE_LEDGER_ACTION,
  LEDGER_PAIR_WINDOW_MS,
  MONTHLY_CAP_REACHED_CODE,
  MONTHLY_CAP_REACHED_MESSAGE,
  MONTHLY_CAP_UNAVAILABLE_CODE,
  decideMonthlyCap,
  describeMonthlyUsage,
  jstMonthRange,
  registryCertificatePriceYen,
  sumMonthlyPurchaseYen,
  type RegistryMonthlyUsage,
} from "./monthly-cap";

/** 判定を通した取得の予約。 */
export interface MonthlyCapHold {
  readonly priceYen: number;
  /**
   * 予約を外す。⚠**台帳を書き終えた後**(または課金していないと確定した後)にだけ呼ぶ。
   * 何度呼んでも1回分。retain の後は何もしない。
   */
  release(): Promise<void>;
  /** 課金したのに台帳が書けなかった=予約を外さずに残し続ける。 */
  retain(): void;
}

export type MonthlyCapReservation =
  | { ok: true; hold: MonthlyCapHold }
  | { ok: false; spentYen: number; pendingYen: number; usedYen: number };

export interface MonthlyPurchaseGate {
  /** 判定して、通れば予約する。台帳が読めなければ reject(予約しない)。 */
  reserve(priceYen: number): Promise<MonthlyCapReservation>;
  /** 今の予約の合計(表示用)。 */
  pendingYen(): number;
}

/** 判定と予約の取り外しを1本の列で直列にする門(テストで読み出しを差し替える)。 */
export function createMonthlyPurchaseGate(opts: {
  capYen: number;
  readSpentYen: () => Promise<number>;
  /** 今の時刻(テストで差し替える)。 */
  now?: () => Date;
}): MonthlyPurchaseGate {
  const now = opts.now ?? (() => new Date());
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T> | T): Promise<T> => {
    // 直前が失敗しても後続は動かす(失敗で列が詰まらない・runExclusivePurchase と同型)。
    const result = chain.then(fn, fn);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  // monthStartMs: retain した予約だけに付く「課金した月の初め」。取得中の予約には無い。
  const holds = new Set<{ yen: number; monthStartMs?: number }>();
  const sumHolds = () => {
    const thisMonth = jstMonthRange(now()).start.getTime();
    let s = 0;
    for (const h of holds) {
      if (h.monthStartMs === undefined || h.monthStartMs === thisMonth) s += h.yen;
      // 前の月に残した予約はもう数えない(その月の課金として済んでいる)。
      else if (h.monthStartMs < thisMonth) holds.delete(h);
    }
    return s;
  };

  return {
    reserve(priceYen: number) {
      return serial(async (): Promise<MonthlyCapReservation> => {
        const spentYen = await opts.readSpentYen();
        // ⚠読み出しの後、この同期区間で足し算と予約をまとめて行う(間に await を挟まない)。
        const pendingYen = sumHolds();
        const decision = decideMonthlyCap({
          spentYen,
          pendingYen,
          priceYen,
          capYen: opts.capYen,
        });
        if (!decision.allowed) {
          return { ok: false, spentYen, pendingYen, usedYen: decision.usedYen };
        }
        const entry: { yen: number; monthStartMs?: number } = { yen: priceYen };
        holds.add(entry);
        let settled = false;
        return {
          ok: true,
          hold: {
            priceYen,
            release() {
              if (settled) return Promise.resolve();
              settled = true;
              // ⚠取り外しも列に通す(判定の「読んでから足すまで」の間に外さない)。
              return serial(() => {
                holds.delete(entry);
              });
            },
            retain() {
              if (settled) return;
              settled = true;
              entry.monthStartMs = jstMonthRange(now()).start.getTime();
            },
          },
        };
      });
    },
    pendingYen: sumHolds,
  };
}

/** 今月(日本時間)の課金額を台帳から数える。 */
export async function readMonthlyPurchaseSpentYen(
  now: Date = new Date(),
): Promise<number> {
  const range = jstMonthRange(now);
  const rows = await prisma.auditLog.findMany({
    where: {
      action: REGISTRY_PURCHASE_LEDGER_ACTION,
      createdAt: {
        // 前月末の charged と月初の charged_but_failed を組にするため、組の窓ぶん前から読む。
        gte: new Date(range.start.getTime() - LEDGER_PAIR_WINDOW_MS),
        lt: range.end,
      },
    },
    select: { createdAt: true, detail: true },
  });
  return sumMonthlyPurchaseYen(rows, range);
}

let gate: MonthlyPurchaseGate = createMonthlyPurchaseGate({
  capYen: REGISTRY_PURCHASE_MONTHLY_CAP_YEN,
  readSpentYen: () => readMonthlyPurchaseSpentYen(new Date()),
});

/** テスト用。予約と列を空に戻す。 */
export function __resetMonthlyPurchaseGateForTest(): void {
  gate = createMonthlyPurchaseGate({
    capYen: REGISTRY_PURCHASE_MONTHLY_CAP_YEN,
    readSpentYen: () => readMonthlyPurchaseSpentYen(new Date()),
  });
}

/**
 * 有料取得の直前に呼ぶ。上限内なら予約を返し、超えるなら 409 で止める(課金前)。
 * ⚠台帳が読めない=数えられないまま買わない(503)。
 */
export async function reserveMonthlyPurchaseBudget(
  certificateType: RegistryCertificateType,
): Promise<MonthlyCapHold> {
  let r: MonthlyCapReservation;
  try {
    r = await gate.reserve(registryCertificatePriceYen(certificateType));
  } catch {
    throw new ApiError(
      503,
      "今月の有料取得額を確認できなかったため取得しませんでした（課金していません）。時間をおいてやり直してください。",
      MONTHLY_CAP_UNAVAILABLE_CODE,
    );
  }
  if (!r.ok) {
    throw new ApiError(
      409,
      `${MONTHLY_CAP_REACHED_MESSAGE}（${describeMonthlyUsage(r.usedYen, REGISTRY_PURCHASE_MONTHLY_CAP_YEN)}）`,
      MONTHLY_CAP_REACHED_CODE,
    );
  }
  return r.hold;
}

/** 画面用の利用額(台帳+取得中)。 */
export async function getMonthlyPurchaseUsage(
  now: Date = new Date(),
): Promise<RegistryMonthlyUsage> {
  const spentYen = await readMonthlyPurchaseSpentYen(now);
  const pendingYen = gate.pendingYen();
  return {
    capYen: REGISTRY_PURCHASE_MONTHLY_CAP_YEN,
    spentYen,
    pendingYen,
    usedYen: spentYen + pendingYen,
    prices: { ...REGISTRY_CERTIFICATE_PRICE_YEN },
    resetsAt: jstMonthRange(now).end.toISOString(),
  };
}
