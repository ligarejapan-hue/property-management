import { randomUUID } from "crypto";
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
// トークン単位の上限: **1枚の手紙(正当な署名)の連打再送**が全体枠を食い潰さないように、
// 全体枠より先に同一トークンを 5回/時 で頭打ちにする(@codex #416 R3 P1)。正規の利用は
// 1回(+押し直し数回)で足りる。これにより1トークンが消費できる全体枠は最大5に絞られる。
const tokenLimiter = createRateLimiter({ limit: 5, windowMs: 3_600_000 });
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

type UnsubscribeResult =
  | { kind: "recorded"; markedSent: boolean }
  | { kind: "already" }
  | { kind: "unsent" }
  | { kind: "conflict" };

const NOTE_MARK = "QRコードからの配信停止申込";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  // per-IP 制限(尽力ベース)。全体上限は**署名検証の後**で消費する(下記)。
  if (!postIpLimiter.hit(`u-post:${clientRateKey(req.headers)}`)) {
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

  // トークン単位の上限(5/時)。同一の手紙の連打・再送をここで頭打ちにし、
  // 全体枠(60/時)を1枚の手紙が使い切れないようにする。
  if (!tokenLimiter.hit(`u-token:${trackingToken}`)) {
    return html(renderUnsubscribeThrottledPage(), 429);
  }

  // 全体上限(60/時)は**正当な署名を通った要求だけ**が消費する(@codex #416 P1)。
  // 検証前に消費すると、署名を持たない攻撃者がでたらめな連投で枠を使い切り、
  // 正規の停止申込を1時間まるごと 429 にできてしまう(per-IP は XFF 偽装ですり抜く)。
  // 署名は紙面の所持者しか作れないため、ここでの上限は「大量の実手紙を使った濫用」だけを
  // 頭打ちにし、正規の少数の申込を巻き込まない。
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
      // ロック対象の所有者集合。ブリッジ行があれば行から、無ければ draft から列挙する。
      let preOwnerIds: string[];
      let draftForSend: {
        status: string;
        representativeOwnerId: string | null;
        generatedBy: string;
        draftOwners: { ownerId: string }[];
      } | null = null;
      if (pre.length > 0) {
        preOwnerIds = pre.flatMap((r) => [
          ...(r.ownerId ? [r.ownerId] : []),
          ...r.logOwners.map((o) => o.ownerId),
        ]);
      } else {
        // ブリッジ行なし=「送付済み」の印がまだ押されていない(@codex #416 R2 P1)。
        // 署名付きQRの所持=印刷済みの手紙が実在する証拠なので、**その場で送付済みへの
        // 遷移+送付記録の作成を mark-sent と同じ規律で行い**、拒否まで一続きに記録する。
        // 「受け付けました」と言いながら何も残さない虚偽応答を作らない。
        const d = await tx.dmRecipientDraft.findUnique({
          where: { id: draft.id },
          select: {
            status: true,
            representativeOwnerId: true,
            generatedBy: true,
            draftOwners: { select: { ownerId: true } },
          },
        });
        if (!d) return { kind: "conflict" } as const;
        // sent なのに行が無いのは mark-sent との一瞬の交差=再押下で解決(conflict)。
        if (d.status === "sent") return { kind: "conflict" } as const;
        // confirmed 以外(編集で下書きへ戻った等)は正規の手紙が確認できない扱い。
        if (d.status !== "confirmed") return { kind: "unsent" } as const;
        draftForSend = d;
        preOwnerIds = [
          ...(d.representativeOwnerId ? [d.representativeOwnerId] : []),
          ...d.draftOwners.map((o) => o.ownerId),
        ];
      }

      // R47: Owner(FOR UPDATE・id順) → 物件親行 → 子行。terminal(拒否)を書くため必須
      // (mark-sent の FOR SHARE より強い側に寄せる=このtxは必ず拒否を書く)。
      await lockOwnersForUpdate(tx as unknown as RawTx, preOwnerIds);
      await lockPropertyRow(tx, draft.propertyId);

      // ロック下で再読取。所有者集合が変わっていたら中止(名寄せの付け替えレース)。
      let fresh = await tx.propertyDmLog.findMany({
        where: { draftId: draft.id },
        select: LOG_SELECT,
      });
      const lockedSet = new Set(preOwnerIds);
      const freshOwnerIds = fresh.flatMap((r) => [
        ...(r.ownerId ? [r.ownerId] : []),
        ...r.logOwners.map((o) => o.ownerId),
      ]);
      if (freshOwnerIds.some((id) => !lockedSet.has(id)))
        return { kind: "conflict" } as const;

      let markedSent = false;
      if (fresh.length === 0) {
        if (!draftForSend) return { kind: "conflict" } as const;
        // ロック下で draft を読み直し、所有者集合・状態を検証してから
        // confirmed→sent(mark-sent と同じ条件付き遷移。並行の mark-sent が先に勝てば
        // count=0=そちらが行を作る途中なので中止→もう一度押していただく)。
        const d2 = await tx.dmRecipientDraft.findUnique({
          where: { id: draft.id },
          select: {
            status: true,
            representativeOwnerId: true,
            generatedBy: true,
            draftOwners: { select: { ownerId: true } },
          },
        });
        const d2Owners = [
          ...(d2?.representativeOwnerId ? [d2.representativeOwnerId] : []),
          ...(d2?.draftOwners.map((o) => o.ownerId) ?? []),
        ];
        if (!d2 || d2Owners.some((id) => !lockedSet.has(id)))
          return { kind: "conflict" } as const;
        if (d2.status !== "confirmed") return { kind: "conflict" } as const;
        const now = new Date();
        const transitioned = await tx.dmRecipientDraft.updateMany({
          where: { id: draft.id, status: "confirmed" },
          data: { status: "sent", sentAt: now },
        });
        if (transitioned.count === 0) return { kind: "conflict" } as const;
        // PropertyDmLog.sentAt は @db.Date=+9h して UTC暦日=JST暦日(mark-sent と同じ規約)。
        // sentBy はこの手紙を生成した利用者(公開経路にセッションは無い)。
        const logId = randomUUID();
        await tx.propertyDmLog.create({
          data: {
            id: logId,
            propertyId: draft.propertyId,
            ownerId: d2.representativeOwnerId,
            dmType: null,
            batchId: null,
            draftId: draft.id,
            sentAt: new Date(now.getTime() + 9 * 60 * 60 * 1000),
            method: "sale_dm",
            sentBy: d2.generatedBy,
          },
        });
        const linkTargets =
          d2.draftOwners.length > 0
            ? d2.draftOwners.map((o) => o.ownerId)
            : d2.representativeOwnerId
              ? [d2.representativeOwnerId]
              : [];
        if (linkTargets.length > 0) {
          await tx.propertyDmLogOwner.createMany({
            data: linkTargets.map((ownerId) => ({ logId, ownerId })),
            skipDuplicates: true,
          });
        }
        markedSent = true;
        // 作った行はこの tx 内の既知の初期値(no_response)。再取得せず手元で組む。
        fresh = [
          {
            id: logId,
            ownerId: d2.representativeOwnerId,
            reactionStatus: "no_response",
            reactedAt: null,
            reactionNote: null,
            reactionSource: null,
            manualReactionShadow: null,
            logOwners: linkTargets.map((ownerId) => ({ ownerId })),
          },
        ];
      }

      const reactedAt = new Date(`${jstCalendarDay(new Date())}T00:00:00Z`);
      let changed = false;
      for (const row of fresh) {
        // スキップは**守られた拒否(退避含む)だけ**(冪等: 同じQRの二度読みで壊れない)。
        // ⚠「宛先不明」はスキップしない(@codex #416 R4 P1): 同期由来の undeliverable は
        // 後から返送記録の訂正で cleared→no_response に戻り得る。その上に拒否を残さないと、
        // お客様の停止の意思が訂正と同時に消える。手動 refused は同期 undeliverable にも
        // cleared にも上書きされない(core の優先規則)ため、ここで書いておけば消えない。
        if (isRefusalProtected(row)) {
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
      return changed
        ? ({ kind: "recorded", markedSent } as const)
        : ({ kind: "already" } as const);
    });
  } catch (e) {
    if (e instanceof SyncOwnerSetChangedError) {
      result = { kind: "conflict" };
    } else {
      throw e;
    }
  }

  await writeAuditLog({
    action: "sale_dm_qr_unsubscribe",
    targetTable: "property_dm_logs",
    // 対象の draft を targetId にも入れる(detail の許可リスト運用と独立に対象を辿れるように)。
    targetId: draft.id,
    detail: {
      result: result.kind,
      ...(result.kind === "recorded" && result.markedSent
        ? { markedSent: true }
        : {}),
      draftId: draft.id,
      at: new Date().toISOString(),
    },
  });

  if (result.kind === "conflict") {
    // まれな並行競合。虚偽の「受け付けました」を出さず、もう一度押していただく。
    return html(renderUnsubscribeBusyPage(), 409);
  }
  if (result.kind === "unsent") {
    // 正規の手紙が確認できない(編集で下書きへ戻った等)。**成功と言わない**
    // (@codex #416 R2 P1)。お手紙の連絡先(電話)での停止受付へ誘導する。
    return html(renderUnsubscribeInvalidPage(), 200);
  }
  return html(renderUnsubscribeDonePage(), 200);
}
