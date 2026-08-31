import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { lockOwnersForUpdate, type RawTx } from "@/lib/dm-batch/locks";
import {
  syncSaleDmReaction,
  SyncOwnerSetChangedError,
  type ReactionSyncTx,
} from "@/lib/dm-reaction/sync";
import {
  applyManualReaction,
  isRefusalProtected,
  isTerminalReaction,
  jstCalendarDay,
} from "@/lib/dm-reaction/core";
import {
  deriveUnsubscribeKey,
  parseUnsubscribeToken,
  verifyUnsubscribeToken,
} from "@/lib/sale-dm-letter/unsubscribe-token";
import {
  PUBLIC_PAGE_HEADERS,
  renderUnsubscribeBusyPage,
  renderUnsubscribeConfirmPage,
  renderUnsubscribeDonePage,
  renderUnsubscribeInvalidPage,
  renderUnsubscribeThrottledPage,
} from "@/lib/sale-dm-letter/unsubscribe-page";
import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";

/**
 * 認証不要の公開エンドポイント(proxy.ts の PUBLIC_PATHS に "/u/" を追加済み)。
 * 郵送QRからの**配信停止の受付**。受け手(所有者)はログインユーザーではない。
 *
 * 守り(多層):
 *  1. 形式門前払い(parseUnsubscribeToken) — 形式外は DB にも HMAC にも触らせない。
 *  2. HMAC署名(停止専用鍵・timing-safe) — 追跡トークン単体や当てずっぽうでは停止できない。
 *  3. GET は表示だけ(DB 無アクセス)・停止は POST のみ — プレビューbot の誤停止防止。
 *  4. Origin 検査 — 第三者サイトのフォームから踏ませる攻撃を拒否。
 *  5. 回数制限 — per-IP(尽力ベース・XFFは偽装可能) + **全体上限**(偽装の影響を受けない)。
 *  6. 在否を答えない — 宛先が見つからなくても同じ「受け付けました」(列挙耐性)。
 *  7. 書き込みは手動反響と同じ applyManualReaction + R47 ロック順序(Owner→物件→子)。
 *  8. すべての結果を監査ログへ(出所 result 付き) — 異常な停止の集中を後から追える。
 */

// 回数制限(プロセス内保持=単一インスタンス運用前提。詳細は public-rate-limit.ts)。
const getLimiter = createRateLimiter(
  { limit: 30, windowMs: 60_000 },
  { onOverflow: "allow" }, // 読み取り(表示)系: 溢れても正規利用者を巻き込まない
);
const postIpLimiter = createRateLimiter(
  { limit: 10, windowMs: 60_000 },
  { onOverflow: "deny" }, // 書き込み系: fail-closed
);
// 全体上限: XFF 偽装で per-IP をすり抜けても、1時間あたりの停止処理はここで頭打ち。
// 正規運用では1キャンペーンでも停止は数件/日の想定=60/時は十分に余裕がある。
const postGlobalLimiter = createRateLimiter({ limit: 60, windowMs: 3_600_000 });
// 全体上限に達した事実の監査は5分に1回まで(攻撃中に audit_logs を肥大させない)。
const throttleAuditLimiter = createRateLimiter({ limit: 1, windowMs: 300_000 });

let cachedKey: Buffer | null = null;
function getKey(): Buffer | null {
  if (cachedKey) return cachedKey;
  try {
    cachedKey = deriveUnsubscribeKey();
    return cachedKey;
  } catch {
    return null; // NEXTAUTH_SECRET 不在(その場合アプリの認証自体が動かない)
  }
}

function html(body: string, status: number): NextResponse {
  return new NextResponse(body, { status, headers: { ...PUBLIC_PAGE_HEADERS } });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!getLimiter.hit(`u-get:${clientRateKey(req.headers)}`)) {
    return html(renderUnsubscribeThrottledPage(), 429);
  }
  const { token } = await params;
  // 表示は形式チェックのみ(署名検証もDBもしない=GETに副作用と情報を持たせない)。
  if (!parseUnsubscribeToken(token)) {
    return html(renderUnsubscribeInvalidPage(), 404);
  }
  return html(renderUnsubscribeConfirmPage(), 200);
}

type UnsubscribeResult = "recorded" | "already" | "unsent" | "conflict";

const NOTE_MARK = "QRコードからの配信停止申込";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  // 回数制限(per-IP → 全体)。
  if (!postIpLimiter.hit(`u-post:${clientRateKey(req.headers)}`)) {
    return html(renderUnsubscribeThrottledPage(), 429);
  }
  if (!postGlobalLimiter.hit("global")) {
    if (throttleAuditLimiter.hit("audit")) {
      await writeAuditLog({
        action: "sale_dm_qr_unsubscribe",
        targetTable: "property_dm_logs",
        detail: { result: "throttled", at: new Date().toISOString() },
      });
    }
    return html(renderUnsubscribeThrottledPage(), 429);
  }

  // Origin 検査: ブラウザが付ける Origin が自ホストと違えば第三者サイト経由=拒否。
  // Origin 無し(直接POST等)は素通し — その場合も署名の所持が前提で、CSRF(被害者の
  // ブラウザに踏ませる攻撃)は Origin が必ず付くため、この検査で塞がる。
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(req.url).host) {
        return html(renderUnsubscribeInvalidPage(), 403);
      }
    } catch {
      return html(renderUnsubscribeInvalidPage(), 403);
    }
  }

  const key = getKey();
  if (!key) return html(renderUnsubscribeInvalidPage(), 503);

  const { token } = await params;
  const trackingToken = verifyUnsubscribeToken(token, key);
  if (!trackingToken) {
    // 形式外/署名不一致。404/400 の出し分けで情報を増やさないよう、どちらも同じ画面。
    return html(
      renderUnsubscribeInvalidPage(),
      parseUnsubscribeToken(token) ? 400 : 404,
    );
  }

  // 署名を通った要求だけが DB に到達する。
  const draft = await prisma.dmRecipientDraft.findUnique({
    where: { trackingToken },
    select: { id: true, propertyId: true },
  });
  if (!draft) {
    // 正当な署名だが宛先が消えている(キャンペーン削除等)。在否を答えず同じ完了画面。
    await writeAuditLog({
      action: "sale_dm_qr_unsubscribe",
      targetTable: "property_dm_logs",
      detail: { result: "missing", at: new Date().toISOString() },
    });
    return html(renderUnsubscribeDonePage(), 200);
  }

  const LOG_SELECT = {
    id: true,
    ownerId: true,
    reactionStatus: true,
    reactedAt: true,
    reactionNote: true,
    reactionSource: true,
    manualReactionShadow: true,
    logOwners: { select: { ownerId: true } },
  } as const;

  let result: UnsubscribeResult;
  try {
    result = await prisma.$transaction(async (tx) => {
      // 先読み(無ロック): ロック対象の所有者集合を知る(手動反響 PATCH と同じ型)。
      const pre = await tx.propertyDmLog.findMany({
        where: { draftId: draft.id },
        select: LOG_SELECT,
      });
      // ブリッジ行なし=「送付済み」の印がまだ押されていない。作らない(勝手な送付記録を
      // 増やさない)。監査に残し、完了画面は同じにする(お客様の申し出は受理した扱い。
      // 運用は「投函したらその場で送付済みを押す」が前提=この窓は狭い)。
      if (pre.length === 0) return "unsent";

      const preOwnerIds = pre.flatMap((r) => [
        ...(r.ownerId ? [r.ownerId] : []),
        ...r.logOwners.map((o) => o.ownerId),
      ]);
      // R47: Owner(FOR UPDATE・id順) → 物件親行 → 子行。terminal(拒否)を書くため必須。
      await lockOwnersForUpdate(tx as unknown as RawTx, preOwnerIds);
      await lockPropertyRow(tx, draft.propertyId);

      // ロック下で再読取。所有者集合が変わっていたら中止(名寄せの付け替えレース)。
      const fresh = await tx.propertyDmLog.findMany({
        where: { draftId: draft.id },
        select: LOG_SELECT,
      });
      const lockedSet = new Set(preOwnerIds);
      const freshOwnerIds = fresh.flatMap((r) => [
        ...(r.ownerId ? [r.ownerId] : []),
        ...r.logOwners.map((o) => o.ownerId),
      ]);
      if (freshOwnerIds.some((id) => !lockedSet.has(id))) return "conflict";

      const reactedAt = new Date(`${jstCalendarDay(new Date())}T00:00:00Z`);
      let changed = false;
      for (const row of fresh) {
        // すでに拒否(退避含む)・宛先不明なら書かない(冪等: 同じQRの二度読みで壊れない。
        // terminal は既に全出口の自動除外が効いている)。
        if (isTerminalReaction(row.reactionStatus) || isRefusalProtected(row)) {
          continue;
        }
        // 手動記録と同一の適用規則(優先規則に新しい経路を作らない)。出所はメモと監査で残す。
        const note = row.reactionNote?.includes(NOTE_MARK)
          ? row.reactionNote
          : row.reactionNote
            ? `${row.reactionNote}／${NOTE_MARK}`
            : NOTE_MARK;
        const next = applyManualReaction(row, {
          status: "refused",
          reactedAt,
          note,
        });
        await tx.propertyDmLog.update({
          where: { id: row.id },
          data: {
            reactionStatus: next.reactionStatus,
            reactedAt: next.reactedAt,
            reactionNote: next.reactionNote,
            reactionSource: next.reactionSource,
            manualReactionShadow:
              next.manualReactionShadow == null
                ? Prisma.DbNull
                : (next.manualReactionShadow as Prisma.InputJsonValue),
          },
        });
        changed = true;
      }
      if (changed) {
        // ブリッジ行の保存直後に同一 tx で再導出(手動反響 PATCH と同じ後処理)。
        await syncSaleDmReaction(tx as unknown as ReactionSyncTx, draft.id);
      }
      return changed ? "recorded" : "already";
    });
  } catch (e) {
    if (e instanceof SyncOwnerSetChangedError) {
      result = "conflict";
    } else {
      throw e;
    }
  }

  await writeAuditLog({
    action: "sale_dm_qr_unsubscribe",
    targetTable: "property_dm_logs",
    detail: { result, draftId: draft.id, at: new Date().toISOString() },
  });

  if (result === "conflict") {
    // まれな並行競合。虚偽の「受け付けました」を出さず、もう一度押していただく。
    return html(renderUnsubscribeBusyPage(), 409);
  }
  return html(renderUnsubscribeDonePage(), 200);
}
