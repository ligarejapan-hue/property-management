import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";
import { isCrossSiteOrigin } from "@/lib/public-origin";
import { parseInquiryForm, INQUIRY_ERROR_MESSAGES } from "@/lib/sale-dm-letter/inquiry-input";
import { recordInquiry, type InquiryClientLike } from "@/lib/sale-dm-letter/inquiry-record";
import { PUBLIC_PAGE_HEADERS } from "@/lib/sale-dm-letter/unsubscribe-page";
import {
  renderInquiryBusyPage,
  renderInquiryDonePage,
  renderInquiryInvalidPage,
  renderInquiryPreviewPage,
  renderInquiryThrottledPage,
  renderInquiryUnavailablePage,
} from "@/lib/sale-dm-letter/inquiry-page";

/**
 * 公開LPの査定申込の受け口(設計 §2.5)。認証不要(proxy.ts の PUBLIC_PATHS "/t/"・nginx の公開範囲 /t/ の中)。
 *
 * 守り(多層・/u/ と同じ考え方):
 *  1. 端末IPの回数制限(10/分・溢れたら拒否) — 尽力ベース(送信元IPは偽装し得る)。
 *  2. 送信元判定(public-origin.ts) — よそのサイトから踏ませる送信を 403。DB に触らない。
 *  3. honeypot — 機械送信は「受け付けました」を返して何も残さない。
 *  4. 入力検証(inquiry-input.ts) — 不備は 422。入力値は画面に送り返さない。
 *  5. token の回数制限(5/時)と全体の回数制限(120/時) — 検証を通った送信だけが消費する
 *     (でたらめな連投で正規の申込枠を使い切らせない)。
 *  6. 送付済みの宛先だけ記録 — 送付前は 409・未知 token は 404(記録なし)。
 *  7. 監査は draftId と非PII(first/at)のみ。入力文字は出さない。
 */
const ipLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 }, { onOverflow: "deny" });
const tokenLimiter = createRateLimiter({ limit: 5, windowMs: 3_600_000 });
const globalLimiter = createRateLimiter({ limit: 120, windowMs: 3_600_000 });
// 全体上限に達した事実の監査は5分に1回まで(攻撃中に audit_logs を肥大させない)。
const throttleAuditLimiter = createRateLimiter({ limit: 1, windowMs: 300_000 });

function html(body: string, status: number): NextResponse {
  return new NextResponse(body, { status, headers: { ...PUBLIC_PAGE_HEADERS } });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!ipLimiter.hit(`inq-ip:${clientRateKey(req.headers)}`)) {
    return html(renderInquiryThrottledPage(), 429);
  }
  if (isCrossSiteOrigin(req.headers, req.url)) {
    return html(renderInquiryUnavailablePage(), 403);
  }
  const { token } = await params;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return html(renderInquiryUnavailablePage(), 400);
  }
  const get = (key: string): string | null => {
    const v = form.get(key);
    return typeof v === "string" ? v : null;
  };

  const parsed = parseInquiryForm(get);
  if (parsed.kind === "bot") {
    return html(renderInquiryDonePage(), 200);
  }
  if (parsed.kind === "invalid") {
    const messages = parsed.errors.map((e) => INQUIRY_ERROR_MESSAGES[e]);
    return html(renderInquiryInvalidPage(messages, `/t/${encodeURIComponent(token)}#inquiry`), 422);
  }

  if (!tokenLimiter.hit(`inq-token:${token}`)) {
    return html(renderInquiryThrottledPage(), 429);
  }
  if (!globalLimiter.hit("global")) {
    if (throttleAuditLimiter.hit("audit")) {
      await writeAuditLog({
        action: "sale_dm_inquiry_submit",
        targetTable: "dm_recipient_drafts",
        detail: { result: "throttled", at: new Date().toISOString() },
      });
    }
    return html(renderInquiryThrottledPage(), 429);
  }

  let result: Awaited<ReturnType<typeof recordInquiry>>;
  try {
    result = await recordInquiry(prisma as unknown as InquiryClientLike, token, parsed.value);
  } catch {
    return html(renderInquiryBusyPage(), 503);
  }

  if (result.kind === "unknown") return html(renderInquiryUnavailablePage(), 404);
  if (result.kind === "not_sent") return html(renderInquiryPreviewPage(), 409);

  await writeAuditLog({
    action: "sale_dm_inquiry_submit",
    targetTable: "dm_recipient_drafts",
    targetId: result.draftId,
    detail: { first: result.first, at: new Date().toISOString() },
  });
  return html(renderInquiryDonePage(), 200);
}
