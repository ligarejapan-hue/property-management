import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";
import { isCrossSiteOrigin } from "@/lib/public-origin";
import { parseInquiryForm, INQUIRY_ERROR_MESSAGES } from "@/lib/sale-dm-letter/inquiry-input";
import { startInquiryNotify } from "@/lib/sale-dm-letter/inquiry-notify";
import { startInquiryAutoReply } from "@/lib/sale-dm-letter/inquiry-auto-reply";
import { hasRenderableLpVariant } from "@/lib/sale-dm-letter/lp-render-input";
import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";
import { normalizePublicSlug, readAdParams, publicLpPath } from "@/lib/sale-dm-letter/lp-public";
import { recordPublicInquiry } from "@/lib/sale-dm-letter/lp-public-record";
import { createResponder, readFormBody, wantsJsonReply } from "@/lib/sale-dm-letter/inquiry-http";

/**
 * 広告用の公開ページの査定申込の受け口(設計 2026-10-20 §2)。認証不要(proxy.ts の PUBLIC_PATHS "/lp/")。
 *
 * 守り(多層・/t/<token>/inquiry と同じ考え方):
 *  1. 端末IPの回数制限(10/分・溢れたら拒否) — 尽力ベース。
 *  2. 送信元判定(public-origin.ts) — よそのサイトから踏ませる送信を 403。
 *  3. 公開名の形式門前払い(DB 無アクセス)→ 公開ゲート(lpPublicEnabled)— 無効なら 404。
 *  4. 本文の形式・上限(32KB)。
 *  5. honeypot — 機械送信は「受け付けました」を返して何も残さない。
 *  6. 入力検証(inquiry-input.ts) — 不備は 422。入力値は画面に送り返さない。
 *  7. 存在確認(読み取りのみ) — 公開名に合う「使う」種類が無い・文章が無ければ 404(記録・監査なし)。
 *     判定はページを出す条件(lp-public-loader.ts)と同じ関数(hasRenderableLpVariant)。
 *  8. 端末IPの1時間の上限(5/時)・公開名ごとの上限(200/時)・全体の上限(120/時・DM 用とは別の枠) — 存在確認を通った
 *     要求だけが消費する。⚠公開名は秘密ではない(/t/<token> と違う)ので、1つの端末が公開名の枠を使い切って正規の
 *     訪問者を締め出せないよう、端末ごとの1時間の上限を先に置く(内部レビュー 2026-10-20 P2)。
 *  9. 記録(recordPublicInquiry)→ 通知メール・受付メールの起動。監査は scenarioId と非PII のみ。
 */
const ipLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 }, { onOverflow: "deny" });
const ipHourLimiter = createRateLimiter({ limit: 5, windowMs: 3_600_000 });
const slugLimiter = createRateLimiter({ limit: 200, windowMs: 3_600_000 });
const globalLimiter = createRateLimiter({ limit: 120, windowMs: 3_600_000 });
const throttleAuditLimiter = createRateLimiter({ limit: 1, windowMs: 300_000 });

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params;
  const normalized = normalizePublicSlug(rawSlug);
  const slug = normalized.kind === "ok" ? normalized.value : null;
  const backHref = slug ? `${publicLpPath(slug)}#inquiry` : "/";
  const reply = createResponder(wantsJsonReply(req), backHref);

  if (!ipLimiter.hit(`lp-inq-ip:${clientRateKey(req.headers)}`)) return reply("throttled", 429);
  if (isCrossSiteOrigin(req.headers, req.url)) return reply("unavailable", 403);
  if (slug === null) return reply("unavailable", 404);

  let publicEnabled = false;
  try {
    publicEnabled = (await loadSaleDmPublicPageConfig()).lpPublicEnabled;
  } catch {
    publicEnabled = false;
  }
  if (!publicEnabled) return reply("unavailable", 404);

  const body = await readFormBody(req);
  if (!body.ok) return reply("unavailable", body.status);
  const get = (key: string): string | null => body.fields.get(key);

  const parsed = parseInquiryForm(get);
  // 機械送信は人と同じ「受け付けました」を返すが、silent=ページが申込完了の合図(Google のコンバージョン)を出さない。
  if (parsed.kind === "bot") return reply("done", 200, [], { silent: true });
  if (parsed.kind === "invalid") return reply("invalid", 422, parsed.errors.map((e) => INQUIRY_ERROR_MESSAGES[e]));

  let scenario: { id: string; lpHeadline: string | null; lpBodyText: string | null } | null;
  try {
    scenario = await prisma.dmScenario.findFirst({
      where: { publicSlug: slug, deletedAt: null, active: true },
      select: { id: true, lpHeadline: true, lpBodyText: true },
    });
  } catch (err) {
    console.error("[lp_public_inquiry] scenario lookup failed", { name: err instanceof Error ? err.name : "Unknown" });
    return reply("busy", 503);
  }
  if (!scenario || !hasRenderableLpVariant({ headline: scenario.lpHeadline, bodyText: scenario.lpBodyText })) {
    return reply("unavailable", 404);
  }

  const rateNow = Date.now();
  const ipHourKey = `lp-inq-ip-h:${clientRateKey(req.headers)}`;
  const slugKey = `lp-inq-slug:${slug}`;
  if (!ipHourLimiter.wouldAllow(ipHourKey, rateNow)) return reply("throttled", 429);
  if (!slugLimiter.wouldAllow(slugKey, rateNow)) return reply("throttled", 429);
  if (!globalLimiter.wouldAllow("global", rateNow)) {
    if (throttleAuditLimiter.hit("audit")) {
      await writeAuditLog({
        action: "lp_public_inquiry_submit",
        targetTable: "dm_scenarios",
        detail: { result: "throttled", at: new Date().toISOString() },
      });
    }
    return reply("throttled", 429);
  }
  ipHourLimiter.hit(ipHourKey, rateNow);
  slugLimiter.hit(slugKey, rateNow);
  globalLimiter.hit("global", rateNow);

  let recorded: Awaited<ReturnType<typeof recordPublicInquiry>>;
  try {
    recorded = await recordPublicInquiry(prisma, { id: scenario.id, slug }, parsed.value, readAdParams(get));
  } catch (err) {
    console.error("[lp_public_inquiry] record failed", { name: err instanceof Error ? err.name : "Unknown" });
    return reply("busy", 503);
  }
  // 存在確認から記録までの間に種類が削除・「使わない」・公開名の変更をされた(ロック下の読み直しが最終判定)。
  if (recorded.kind === "unavailable") return reply("unavailable", 404);
  const inquiryId = recorded.inquiryId;

  await writeAuditLog({
    action: "lp_public_inquiry_submit",
    targetTable: "dm_scenarios",
    targetId: scenario.id,
    detail: { slug, at: new Date().toISOString() },
  });
  try {
    startInquiryNotify(inquiryId);
  } catch {
    // 通知の起動失敗は受付の成否に影響させない(本体は記録済み)。
  }
  try {
    startInquiryAutoReply(inquiryId);
  } catch {
    // 同上。
  }
  return reply("done", 200);
}
