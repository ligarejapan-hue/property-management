import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { isCrossSiteOrigin } from "@/lib/public-origin";
import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";
import { DOC_FILE_MAX_BYTES, DOC_PDF_UPLOAD_MAX_BYTES } from "@/lib/deals/doc-links/constants";
import { fitSubmittedPdf } from "@/lib/deals/doc-links/fit-pdf";
import { inspectSubmittedFile } from "@/lib/deals/doc-links/inspect-file";
import { badTokenLimiter } from "@/lib/deals/doc-links/public-limits";
import { submitHeaders } from "@/lib/deals/doc-links/public-page";
import { loadOpenLink, recordSubmittedFile } from "@/lib/deals/doc-links/public-store";
import { docLinkKey, verifyDocLinkToken } from "@/lib/deals/doc-links/token";
import { tryReserveCompressionSlot } from "@/lib/pdf-compress/run";

type Ctx = { params: Promise<{ token: string }> };

/**
 * お客様の提出の受け口。守りの順番:
 *  1. 端末の回数制限(10/分)→ よそのサイトからの送信を断る。
 *  2. 本文の大きさを読む前に確かめる(Content-Length・無ければ 411)。上限は PDF の 30MB+上乗せ分。
 *     ⚠この口は proxy を通さない(proxy は本文を 10MB で黙って切る・src/proxy.ts の SUBMIT_UPLOAD_PATTERN)。
 *  3. 署名を確かめる(鍵が無ければ動かない)→ リンクが使えるか。使えないものはすべて同じ 404。
 *  4. 端末(60/時)・リンク(60/時)・全体(600/時)の枠。全部通るときだけ消費する。同時に読むのは4本まで。
 *     8MB を超える送信は、本文を読む前に圧縮の席を取る(社内の添付と共通・埋まっていれば 429)。
 *  5. 中身で種類を決め、画像はメタデータを落とす(inspect-file.ts)。元のファイル名は使わない。
 *     8MB を超える PDF は縮める(fit-pdf.ts・2026-11-06 発注者)。写真はスマホの中で縮めてから届く。
 *  6. 取引の行を押さえて確かめ直してから記録する(public-store.ts)。監査は事実と取引と件数だけ。
 */
const ipLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 }, { onOverflow: "deny" });
const ipHourLimiter = createRateLimiter({ limit: 60, windowMs: 3_600_000 }, { onOverflow: "deny" });
const linkLimiter = createRateLimiter({ limit: 60, windowMs: 3_600_000 }, { onOverflow: "deny" });
const globalLimiter = createRateLimiter({ limit: 600, windowMs: 3_600_000 }, { onOverflow: "deny" });
/** 1つのリンクで大きい PDF を縮めるのは1時間に10回まで(縮められなかった回も数える)。 */
const compressLinkLimiter = createRateLimiter({ limit: 10, windowMs: 3_600_000 }, { onOverflow: "deny" });
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
/**
 * 圧縮の席(社内の添付と共通で2つ)のうち、この口が同時に使うのは1つまで。
 * ⚠ログインなしの口から2つとも埋められると、社内の大きい PDF の添付がずっと「混み合っています」になる。
 */
let publicSlotInUse = false;
function reservePublicSlot(): (() => void) | null {
  if (publicSlotInUse) return null;
  const release = tryReserveCompressionSlot();
  if (release === null) return null;
  publicSlotInUse = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    publicSlotInUse = false;
    release();
  };
}

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: submitHeaders("application/json; charset=utf-8") });
const fail = (status: number, error: string) => reply(status, { ok: false, error });
const UNAVAILABLE = "このリンクは使えません。お手数ですが、担当者へご連絡ください。";
const THROTTLED = "送信が集中しています。しばらくしてからもう一度お試しください。";
const BUSY = "いま混み合っています。1分ほど待ってから、もう一度お試しください。";
const TOO_LARGE = "ファイルが大きすぎます。写真は8MBまで、PDFは30MBまでです。";
const PDF_TOO_LARGE = "PDFを小さくできませんでした。ページを分けるか、写真で撮って送ってください。";
const PDF_ENCRYPTED = "パスワード付きのPDFは小さくできません。パスワードを外すか、写真で撮って送ってください。";
const PDF_UNREADABLE = "このPDFは読み取れませんでした。写真で撮って送ってください。";
const UNSUPPORTED = "写真(JPEG・PNG・WebP)かPDFを送ってください。";

export async function POST(req: Request, { params }: Ctx) {
  const ip = clientRateKey(req.headers);
  if (!ipLimiter.hit(`submit-up:${ip}`) || !badTokenLimiter.wouldAllow(`submit-bad:${ip}`)) return fail(429, THROTTLED);
  if (isCrossSiteOrigin(req.headers, req.url)) return fail(403, UNAVAILABLE);

  const header = req.headers.get("content-length");
  const length = header === null ? NaN : Number(header.trim());
  if (!Number.isFinite(length) || length < 0) return fail(411, UNAVAILABLE);
  if (length > DOC_PDF_UPLOAD_MAX_BYTES + MULTIPART_OVERHEAD_BYTES) return fail(413, TOO_LARGE);

  const key = docLinkKey();
  const publicId = key ? verifyDocLinkToken((await params).token, key) : null;
  if (!publicId) {
    badTokenLimiter.hit(`submit-bad:${ip}`);
    return fail(404, UNAVAILABLE);
  }

  const now = new Date();
  if (inFlight >= MAX_IN_FLIGHT) return fail(429, THROTTLED);
  inFlight += 1;
  let releaseSlot: (() => void) | null = null;
  try {
    const link = await loadOpenLink(publicId, now);
    if (!link) return fail(404, UNAVAILABLE);

    const at = now.getTime();
    const ipKey = `submit-up-h:${ip}`;
    const linkKey = `submit-link:${publicId}`;
    if (!ipHourLimiter.wouldAllow(ipKey, at) || !linkLimiter.wouldAllow(linkKey, at) || !globalLimiter.wouldAllow("global", at)) return fail(429, THROTTLED);
    // ⚠基準は送信全体(ファイルが 8MB を超えるなら送信全体も必ず超える)。本文を読む前に席を取る。
    //   混んでいて断るときは枠を消費しない(やり直しで1時間の枠を食わない)。
    const compressKey = `submit-cmp:${publicId}`;
    if (length > DOC_FILE_MAX_BYTES) {
      if (!compressLinkLimiter.wouldAllow(compressKey, at)) return fail(429, THROTTLED);
      releaseSlot = reservePublicSlot();
      if (releaseSlot === null) return fail(429, BUSY);
      compressLinkLimiter.hit(compressKey, at);
    }
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
    if (file.size > DOC_PDF_UPLOAD_MAX_BYTES) return fail(413, TOO_LARGE);

    const inspected = inspectSubmittedFile(Buffer.from(await file.arrayBuffer()));
    if (!inspected.ok) return inspected.reason === "too_large" ? fail(413, TOO_LARGE) : fail(422, UNSUPPORTED);
    let buffer = inspected.buffer;
    if (inspected.mimeType === "application/pdf") {
      const fitted = await fitSubmittedPdf(buffer);
      if (!fitted.ok) {
        if (fitted.reason === "encrypted") return fail(422, PDF_ENCRYPTED);
        if (fitted.reason === "unreadable") return fail(422, PDF_UNREADABLE);
        return fail(413, PDF_TOO_LARGE);
      }
      buffer = fitted.buffer;
    }

    const result = await recordSubmittedFile({
      publicId, dealId: link.dealId, requestId: requestId.data, buffer, mimeType: inspected.mimeType, ext: inspected.ext, now,
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
    releaseSlot?.();
    inFlight -= 1;
  }
}
