import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import { loadMailSendConfig, type MailSendConfig } from "@/lib/mail/mail-config";
import { sendPlainMail, safeErrorCode } from "@/lib/mail/transport";
import { checkSaleDmAccessFor } from "./route-guard";
import { buildInquiryNotifyMail, type InquiryNotifyFacts } from "./inquiry-notify-mail";
import { coarsePropertyLocation, propertyTypeLabel } from "./tags";

export const NOTIFY_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
export const NOTIFY_STALE_CLAIM_MS = 15 * 60_000;
export type NotifyOutcome = "sent" | "failed" | "skipped";

interface Recipient {
  userId: string;
  address: string;
  detail: "minimal" | "full";
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

export async function countInquiryNotifyRecipients(): Promise<number> {
  return prisma.user.count({ where: { isActive: true, inquiryNotifyEnabled: true } });
}

async function loadFacts(inquiryId: string) {
  return prisma.dmInquiry.findUnique({
    where: { id: inquiryId },
    select: {
      id: true,
      submittedAt: true,
      name: true,
      phone: true,
      email: true,
      contactPref: true,
      contactTime: true,
      message: true,
      draft: {
        select: {
          campaign: { select: { name: true } },
          variant: { select: { label: true } },
          lpVariant: { select: { label: true } },
          // ⚠物件の createdBy/assignedTo(現場担当範囲の判定)はここでは取らない。ここで読むのは
          // メール本文の材料(住所/種別)だけで、担当範囲は試行のたびに loadPropertyScope で
          // 読み直す(P1修正・下記参照)。propertyId だけはその読み直しの鍵として保持する。
          propertyId: true,
          property: { select: { address: true, propertyType: true } },
        },
      },
    },
  });
}

// 物件の現在の担当範囲(createdBy/assignedTo)だけを読み直す。P1修正: resolveRecipients は
// 試行のたびに呼ぶようになったが、渡す物件情報が最初の1回だけ読んだスナップショット
// (row.draft.property)のままでは、待ち時間(最長10分)の間に現場担当者が付け替えられても
// 古い担当者のままスコープ判定してしまい、外れた元担当者に個人情報が届いてしまう。そこで
// この関数だけを試行のたびに呼び、常に「今の」createdBy/assignedTo で絞り込む。
// ⚠メール本文の材料(住所/種別/申込者情報)は最初の1回の読み込み(loadFacts)のまま変えない
// (設計どおり=担当範囲の判定だけを新鮮にする)。
// ⚠物件がすでに読めない(削除済み等)場合は null を返す。呼び出し側は「この試行は誰も適格
// でない」として扱う(既存の no_recipients 相当の分岐に合流させる。例外にはしない)。
async function loadPropertyScope(
  propertyId: string,
): Promise<{ createdBy: string | null; assignedTo: string | null } | null> {
  return prisma.property.findUnique({
    where: { id: propertyId },
    select: { createdBy: true, assignedTo: true },
  });
}

// 1人ぶんの適格性判定+詳しさ算出(設計 §2.6 の核心)。field_staff は自分が作成/担当の物件の
// スコープ内のみ・売却DMの表示権限が平文でない利用者には送らない(通知メールに載せる情報を
// 本人が画面でも見られない、はNG)。
// P1修正(Finding1): ラウンド先頭の一括解決(resolveRecipients)と、送信「直前」の最終チェック
// (recheckRecipientBeforeSend)の両方がこの関数を通ることで、2つの判定基準が絶対にズレない
// ようにする。⚠checkSaleDmAccessFor は権限/表示の拒否は ok:false で返すが、DB 例外は投げ得る。
// 1人の失敗で他の宛先まで巻き込まないよう、ここで try/catch する(呼び出し側はもう包まない)。
async function resolveOneRecipient(
  u: { id: string; email: string; role: string; inquiryNotifyEmail: string | null },
  scope: { createdBy: string | null; assignedTo: string | null },
  config: MailSendConfig,
): Promise<Recipient | null> {
  if (u.role === "field_staff" && scope.createdBy !== u.id && scope.assignedTo !== u.id) return null;
  let access;
  try {
    access = await checkSaleDmAccessFor(u.id);
  } catch {
    // この利用者の判定だけ諦める(1人のDB例外で通知全体を止めない)。
    return null;
  }
  if (!access.ok) return null;
  const bothPlain = isPlainOwnerLevel(access.ownerDisplayConfig.phone) && isPlainOwnerLevel(access.ownerDisplayConfig.email);
  const address = u.inquiryNotifyEmail && u.inquiryNotifyEmail.trim() !== "" ? u.inquiryNotifyEmail : u.email;
  return { userId: u.id, address, detail: config.inquiryMailDetail === "full" && bothPlain ? "full" : "minimal" };
}

// 通知先の絞り込み(ラウンド先頭の一括解決)。在籍/通知ONの利用者を一括で読み、1人ずつ
// resolveOneRecipient に判定させる。
async function resolveRecipients(
  scope: { createdBy: string | null; assignedTo: string | null },
  config: MailSendConfig,
): Promise<Recipient[]> {
  const users = await prisma.user.findMany({
    where: { isActive: true, inquiryNotifyEnabled: true },
    select: { id: true, email: true, role: true, inquiryNotifyEmail: true },
    orderBy: { id: "asc" },
  });
  const out: Recipient[] = [];
  for (const u of users) {
    const r = await resolveOneRecipient(u, scope, config);
    if (r) out.push(r);
  }
  return out;
}

// P1修正(Finding1): 送信「直前」に、この宛先1人だけ現在の適格性を再チェックする。宛先1件
// あたりの SMTP 送信は最長~35秒かかり得るため、宛先が多いラウンドでは後方の宛先の番が来る
// までに在籍/通知設定/権限/現場担当範囲が変わり得る。ラウンド先頭の一括解決(toSend)は
// あくまで「そのラウンド開始時点」のスナップショットでしかないので、ここでもう一段新鮮な
// 判定を挟む。在籍/通知ONは利用者行を個別に読み直して確認し、現場担当範囲は物件を個別に
// 読み直した(loadPropertyScope)スコープで判定する。適格性/詳しさの計算そのものは
// resolveOneRecipient を再利用し、一括解決とここでの判定基準がズレないようにする。
// ⚠field_staff でない利用者にはスコープの読み直しは不要(判定に使わない)ので省く。
async function recheckRecipientBeforeSend(
  userId: string,
  propertyId: string,
  config: MailSendConfig,
): Promise<Recipient | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, inquiryNotifyEmail: true, isActive: true, inquiryNotifyEnabled: true },
  });
  if (!u || !u.isActive || !u.inquiryNotifyEnabled) return null;
  let scope: { createdBy: string | null; assignedTo: string | null } = { createdBy: null, assignedTo: null };
  if (u.role === "field_staff") {
    const freshScope = await loadPropertyScope(propertyId);
    if (!freshScope) return null;
    scope = freshScope;
  }
  return resolveOneRecipient(u, scope, config);
}

// 取り合いキー(notifyClaimedAt)を自分が最後に書いた値(claimedAt)で保有確認しながら
// 更新する。他ワーカーが既に取り直していれば(=期限切れで再取り合いされた)0件更新になり、
// false を返す。⚠終端書き込みも同じ保有チェックを通す(Important 2):古いワーカーの
// finish が新しいワーカーの状態を上書きして行を再び claimable に戻す事故を防ぐ。
// ⚠書き込み自体は成功したのに、その応答(Promise)だけが通信断で失敗することもあり得る。
// その場合このワーカーが持つ claimedAt は実際の DB の値より古くなり、以後の refreshClaim/
// finish はすべて 0 件更新(保有喪失)として扱われる。行は "sending" のまま残るが、
// 15分の保有期限が来れば他ワーカーが取り直せる=自己修復するので、ここでは何もしない。
async function refreshClaim(inquiryId: string, claimedAt: Date, nextClaimedAt: Date): Promise<boolean> {
  const r = await prisma.dmInquiry.updateMany({
    where: { id: inquiryId, notifyStatus: "sending", notifyClaimedAt: claimedAt },
    data: { notifyClaimedAt: nextClaimedAt },
  });
  return r.count > 0;
}

// 終端状態を書く。自分がまだ claim を保有しているとき(notifyClaimedAt が一致するとき)だけ
// 書き込み、監査も残す。0件更新(=保有が移った)なら何も書かず false を返す。
async function finish(
  inquiryId: string,
  claimedAt: Date,
  attempts: number,
  result: { status: "sent" } | { status: "failed"; code: string },
  recipientUserIds: string[],
): Promise<boolean> {
  const updated = await prisma.dmInquiry.updateMany({
    where: { id: inquiryId, notifyStatus: "sending", notifyClaimedAt: claimedAt },
    data:
      result.status === "sent"
        ? { notifyStatus: "sent", notifyLastError: null, notifyAttempts: { increment: attempts } }
        : { notifyStatus: "failed", notifyLastError: result.code, notifyAttempts: { increment: attempts } },
  });
  if (updated.count === 0) return false;
  await writeAuditLog(
    result.status === "sent"
      ? { action: "inquiry_notify_sent", targetTable: "dm_inquiries", targetId: inquiryId, detail: { attempt: attempts, recipientUserIds } }
      : { action: "inquiry_notify_failed", targetTable: "dm_inquiries", targetId: inquiryId, detail: { attempt: attempts, code: result.code } },
  );
  return true;
}

// 通知の本体(設計 §2.6)。申込の記録が終わってから呼ぶ。1回目+再試行(30秒→2分→10分)。
// ⚠宛先アドレス・申込者の入力・SMTP の応答をログ/監査/notify_last_error に出さない。
// ⚠想定外の例外で行が "sending" のまま残らないよう、本体を try/catch で包み、終端状態
//   (failed / send_failed)を記録してから投げ直す(呼び出し元 startInquiryNotify は投げない)。
export async function notifyInquiry(inquiryId: string, opts: { now?: () => Date } = {}): Promise<NotifyOutcome> {
  const now = opts.now ?? (() => new Date());
  // ⚠claimedAt = 「今このワーカーが保有している notifyClaimedAt の値」。ラウンド間・宛先ループの
  // 途中で更新するたびに書き換える(refreshClaim/finish の where 節はこの値でしか保有確認できない)。
  let claimedAt = now();
  const claim = await prisma.dmInquiry.updateMany({
    where: {
      id: inquiryId,
      OR: [
        { notifyStatus: { in: ["pending", "failed"] } },
        { notifyStatus: "sending", notifyClaimedAt: { lt: new Date(claimedAt.getTime() - NOTIFY_STALE_CLAIM_MS) } },
      ],
    },
    data: { notifyStatus: "sending", notifyClaimedAt: claimedAt },
  });
  if (claim.count === 0) return "skipped";

  // 想定外の例外で "sending" のまま行を残さないため、進捗(attempts/succeeded)を try の外で
  // 保持し catch でも使う(Minor 2: catch を attempt:1 固定にしない)。
  let attempts = 0;
  const succeeded = new Set<string>();
  try {
    const row = await loadFacts(inquiryId);
    if (!row) return "skipped";

    const facts: InquiryNotifyFacts = {
      inquiryId: row.id,
      submittedAt: row.submittedAt,
      campaignName: row.draft.campaign.name,
      dmVariantLabel: row.draft.variant.label,
      lpVariantLabel: row.draft.lpVariant?.label ?? null,
      location: coarsePropertyLocation(row.draft.property.address),
      propertyTypeLabel: propertyTypeLabel(row.draft.property.propertyType),
      name: row.name,
      phone: row.phone,
      email: row.email,
      contactPref: row.contactPref,
      contactTime: row.contactTime,
      message: row.message,
    };

    // ⚠宛先1件あたり SMTP タイムアウトまで長くて~35秒かかり得る。宛先が多いと、ラウンド間の
    // sleep 後の更新だけでは 15分の保有期限(NOTIFY_STALE_CLAIM_MS)内に収まらないことがある
    // (Important 1)。そこで宛先ループの中でも、最後に更新してから期限の1/3を超えたら
    // 更新する。更新できなかった(=他ワーカーに保有が移った)ら、その場で送信を止めて
    // 終端状態を一切書かずに返す(まだ書いていない宛先は二重送信にならない)。
    const REFRESH_INTERVAL_MS = NOTIFY_STALE_CLAIM_MS / 3;
    let lastRefreshMs = claimedAt.getTime();

    for (let i = 0; i <= NOTIFY_RETRY_DELAYS_MS.length; i += 1) {
      if (i > 0) {
        // ⚠sleep に入る直前にも保有チェック付きで更新する(寝る前の refresh)。宛先ループ内の
        // 更新は「前回更新から1/3経過」でしか起きないため、直前の更新が最大5分前・そこから
        // 最後の送信(~35秒)を挟んで最長10分の sleep に入ると、寝ている間に合計で15分の保有
        // 期限を超えて他ワーカーに奪われ得る(寝た後の更新だけでは検知が遅すぎる)。寝る直前に
        // 一度フレッシュな時刻で更新しておけば、次に危険なのは「sleep の長さ+送信1件分」で
        // 収まり、最長10分の sleep でも15分の期限内に収まる。
        const preSleep = now();
        if (!(await refreshClaim(inquiryId, claimedAt, preSleep))) return "skipped";
        claimedAt = preSleep;
        lastRefreshMs = preSleep.getTime();

        await sleep(NOTIFY_RETRY_DELAYS_MS[i - 1]);

        const postSleep = now();
        if (!(await refreshClaim(inquiryId, claimedAt, postSleep))) return "skipped";
        claimedAt = postSleep;
        lastRefreshMs = postSleep.getTime();
      }
      attempts += 1;

      // P1修正(Finding2): 送信設定(inquiryMailDetail 込み)は試行のたびに読み直す。1回目の
      // 前に読んで使い回すと、待ち時間(最長10分)の間に管理者が full→minimal に切り替えても
      // 古い詳しさのまま本文を組み立ててしまう。設定が壊れた/消えた(null)場合は、この試行
      // 時点の実際の attempts で既存の mail_not_configured 終端処理に合流させる(古い設定の
      // まま送るくらいなら、ここで止める)。
      const config = await loadMailSendConfig();
      if (!config) {
        const wrote = await finish(inquiryId, claimedAt, attempts, { status: "failed", code: "mail_not_configured" }, []);
        return wrote ? "failed" : "skipped";
      }

      // P1修正(Finding1系): 宛先の適格性(在籍/通知ON/売却DM閲覧可/field_staffの担当範囲)と
      // 詳しさ(full/minimal)は、試行のたびに再解決する。1回目の前に確定させて使い回すと、
      // 待ち時間(最長10分)の間に設定が変わっても古い許可のまま個人情報を送ってしまう。
      // field_staff の担当範囲(createdBy/assignedTo)も同じ理由で試行のたびに物件から
      // 読み直す(loadPropertyScope)。物件が読めなければ(削除済み等)この試行は誰も適格で
      // ないものとして扱う(例外にしない・追加クエリはこの1回だけ)。
      // ⚠succeeded(userId基準)はラウンドをまたいで保持するので、既に成功した宛先は
      // 再解決後の一覧に再び現れても二度と送らない。
      const scope = await loadPropertyScope(row.draft.propertyId);
      const recipients = scope ? await resolveRecipients(scope, config) : [];
      const toSend = recipients.filter((r) => !succeeded.has(r.userId));

      if (toSend.length === 0) {
        if (succeeded.size > 0) {
          // このラウンドの時点で適格な宛先は全員すでに送信済み(=適格性を失った人は単に
          // 除外されるだけで、送信済みの結果を覆さない)。監査には実際に送った宛先だけを残す。
          const wrote = await finish(inquiryId, claimedAt, attempts, { status: "sent" }, [...succeeded]);
          return wrote ? "sent" : "skipped";
        }
        // 誰にも送れたことが一度もない(最初から0人、または再解決の結果みな適格性を失った)。
        // ループを続けず、既存の no_recipients と同じ扱いで終える。
        const wrote = await finish(inquiryId, claimedAt, attempts, { status: "failed", code: "no_recipients" }, []);
        return wrote ? "failed" : "skipped";
      }

      for (const r of toSend) {
        const t = now();
        if (t.getTime() - lastRefreshMs >= REFRESH_INTERVAL_MS) {
          if (!(await refreshClaim(inquiryId, claimedAt, t))) return "skipped";
          claimedAt = t;
          lastRefreshMs = t.getTime();
        }

        // P1修正(Finding1): sendPlainMail を呼ぶ直前に、この宛先だけもう一段新鮮な適格性
        // チェックを挟む(recheckRecipientBeforeSend)。ラウンド先頭の toSend は「ラウンド
        // 開始時点」のスナップショットでしかなく、直前の宛先への送信(~35秒)を挟む間に在籍/
        // 通知設定/権限/現場担当範囲が変わり得る。ここで求まった宛先(アドレス/詳しさ)だけを
        // 使う(toSend の r はもう使わない)。DB例外もこの宛先だけ諦めて次へ進む(1人の失敗で
        // 他の宛先まで巻き込まない=既存の1人ずつのfault isolationをここでも踏襲)。
        let fresh: Recipient | null;
        try {
          fresh = await recheckRecipientBeforeSend(r.userId, row.draft.propertyId, config);
        } catch {
          fresh = null;
        }
        if (!fresh) continue;

        const mail = buildInquiryNotifyMail(facts, { detail: fresh.detail, appBaseUrl: config.appBaseUrl });
        const res = await sendPlainMail(config, { to: fresh.address, subject: mail.subject, text: mail.text });
        if (res.ok) succeeded.add(fresh.userId);
      }
      const stillPending = recipients.some((r) => !succeeded.has(r.userId));
      if (!stillPending) {
        const wrote = await finish(inquiryId, claimedAt, attempts, { status: "sent" }, [...succeeded]);
        return wrote ? "sent" : "skipped";
      }
    }
    const code = succeeded.size > 0 ? "partial" : "send_failed";
    const wrote = await finish(inquiryId, claimedAt, attempts, { status: "failed", code }, []);
    return wrote ? "failed" : "skipped";
  } catch (err) {
    // ここに来るのは resolveRecipients/loadFacts/sendPlainMail 等が想定外に投げた場合(すべて
    // throw しない設計だが、DB 接続断など予期しない失敗まで飲み込まない)。"sending" のまま
    // 行を残さないよう、実際の進捗(attempts/succeeded)から終端状態を記録してから投げ直す
    // (記録自体が失敗しても、行は保有期限切れで再送に回る)。
    try {
      const code = succeeded.size > 0 ? "partial" : "send_failed";
      await finish(inquiryId, claimedAt, attempts === 0 ? 1 : attempts, { status: "failed", code }, []);
    } catch {
      // 記録できなくても、行は 15 分後に notifyClaimedAt の期限切れで取り直せる。
    }
    throw err;
  }
}

// 受け口 route 用。待たない・throw しない。
export function startInquiryNotify(inquiryId: string): void {
  void notifyInquiry(inquiryId).catch((err: unknown) => {
    console.error("[sale_dm_inquiry_notify] failed", {
      name: err instanceof Error ? err.name : "Unknown",
      code: safeErrorCode(err),
    });
  });
}
