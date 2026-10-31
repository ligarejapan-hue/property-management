import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { isCrossSiteOrigin } from "@/lib/public-origin";
import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";
import { DOC_FILE_MAX_BYTES } from "@/lib/deals/doc-links/constants";
import { inspectSubmittedFile } from "@/lib/deals/doc-links/inspect-file";
import { badTokenLimiter } from "@/lib/deals/doc-links/public-limits";
import { submitHeaders } from "@/lib/deals/doc-links/public-page";
import { loadOpenLink, recordSubmittedFile } from "@/lib/deals/doc-links/public-store";
import { docLinkKey, verifyDocLinkToken } from "@/lib/deals/doc-links/token";

type Ctx = { params: Promise<{ token: string }> };

/**
 * お客様の提出の受け口。守りの順番:
 *  1. 端末の回数制限(10/分)→ よそのサイトからの送信を断る。
 *  2. 本文の大きさを読む前に確かめる(Content-Length・無ければ 411)。proxy の 10MB に届かない。
 *  3. 署名を確かめる(鍵が無ければ動かない)→ リンクが使えるか。使えないものはすべて同じ 404。
 *  4. 端末(60/時)・リンク(60/時)・全体(600/時)の枠。全部通るときだけ消費する。同時に読むのは4本まで。
 *  5. 中身で種類を決め、画像はメタデータを落とす(inspect-file.ts)。元のファイル名は使わない。
 *  6. 取引の行を押さえて確かめ直してから記録する(public-store.ts)。監査は事実と取引と件数だけ。
 */
const ipLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 }, { onOverflow: "deny" });
const ipHourLimiter = createRateLimiter({ limit: 60, windowMs: 3_600_000 }, { onOverflow: "deny" });
const linkLimiter = createRateLimiter({ limit: 60, windowMs: 3_600_000 }, { onOverflow: "deny" });
const globalLimiter = createRateLimiter({ limit: 600, windowMs: 3_600_000 }, { onOverflow: "deny" });
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 4;
let inFlight = 0;

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: submitHeaders("application/json; charset=utf-8") });
const fail = (status: number, error: string) => reply(status, { ok: false, error });
const UNAVAILABLE = "このリンクは使えません。お手数ですが、担当者へご連絡ください。";
const THROTTLED = "送信が集中しています。しばらくしてからもう一度お試しください。";
const TOO_LARGE = "ファイルが大きすぎます。8MB以下にしてください。";
const UNSUPPORTED = "写真(JPEG・PNG・WebP)かPDFを送ってください。";

export async function POST(req: Request, { params }: Ctx) {
  const ip = clientRateKey(req.headers);
  if (!ipLimiter.hit(`submit-up:${ip}`) || !badTokenLimiter.wouldAllow(`submit-bad:${ip}`)) return fail(429, THROTTLED);
  if (isCrossSiteOrigin(req.headers, req.url)) return fail(403, UNAVAILABLE);

  const header = req.headers.get("content-length");
  const length = header === null ? NaN : Number(header.trim());
  if (!Number.isFinite(length) || length < 0) return fail(411, UNAVAILABLE);
  if (length > DOC_FILE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES) return fail(413, TOO_LARGE);

  const key = docLinkKey();
  const publicId = key ? verifyDocLinkToken((await params).token, key) : null;
  if (!publicId) {
    badTokenLimiter.hit(`submit-bad:${ip}`);
    return fail(404, UNAVAILABLE);
  }

  const now = new Date();
  if (inFlight >= MAX_IN_FLIGHT) return fail(429, THROTTLED);
  inFlight += 1;
  try {
    const link = await loadOpenLink(publicId, now);
    if (!link) return fail(404, UNAVAILABLE);

    const at = now.getTime();
    const ipKey = `submit-up-h:${ip}`;
    const linkKey = `submit-link:${publicId}`;
    if (!ipHourLimiter.wouldAllow(ipKey, at) || !linkLimiter.wouldAllow(linkKey, at) || !globalLimiter.wouldAllow("global", at)) return fail(429, THROTTLED);
    ipHourLimiter.hit(ipKey, at);
    linkLimiter.hit(linkKey, at);
    globalLimiter.hit("global", at);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail(422, UNSUPPORTED);
    }
    const requestId = z.string().uuid().safeParse(form.get("requestId"));
    const file = form.get("file");
    if (!requestId.success || !(file instanceof Blob)) return fail(422, UNSUPPORTED);
    if (file.size > DOC_FILE_MAX_BYTES) return fail(413, TOO_LARGE);

    const inspected = inspectSubmittedFile(Buffer.from(await file.arrayBuffer()));
    if (!inspected.ok) return inspected.reason === "too_large" ? fail(413, TOO_LARGE) : fail(422, UNSUPPORTED);

    const result = await recordSubmittedFile({
      publicId, dealId: link.dealId, requestId: requestId.data, buffer: inspected.buffer, mimeType: inspected.mimeType, ext: inspected.ext, now,
    });
    if (result.kind !== "ok") {
      if (result.kind === "received") return fail(409, "この書類はすでに確認が済んでいます。");
      if (result.kind === "too_many") return fail(409, "送れるファイル数の上限です。担当者へご連絡ください。");
      return fail(404, UNAVAILABLE);
    }

    await writeAuditLog({ action: "deal_doc_submit", targetTable: "deals", targetId: link.dealId, detail: { count: 1 } });
    return reply(200, { ok: true, status: result.status, count: result.count });
  } catch (err) {
    console.error("[deal_doc_submit] failed", { name: err instanceof Error ? err.name : "Unknown" });
    return fail(503, "送信できませんでした。しばらくしてからもう一度お試しください。");
  } finally {
    inFlight -= 1;
  }
}
