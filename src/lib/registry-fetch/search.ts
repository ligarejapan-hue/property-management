/**
 * PR-2b-2: 謄本 所在検索オーケストレーション（add-only・検索ルートのみ）。
 *
 * 番号無し物件を所在/地番/家屋番号で謄本候補検索する中核。route から provider を注入して
 * 呼ばれ、戻り値がそのまま API レスポンス body になる。auto-fetch.ts の runRegistryAutoFetch に
 * 倣うが、取得（PDF 取得 / 楽観ロック / processRegistryPdf 接続）は行わず、
 * provider.searchCandidates 呼出に置換する（取得ルート拡張・UI は別スライス）。
 *
 * 秘匿情報（物件の所在地・地番・家屋番号・不動産番号）の扱い:
 *   - error / AuditLog には一切載せない（分類コード・件数・状態のみ／cond②）。
 *   - 応答 candidates から realEstateNumber を除外する（cond③: client から候補参照を信頼せず、
 *     取得時に server 側で当該物件向けに再解決する前提）。
 *   - 所有者PII（名前・住所）は入力にも応答にも含めない。
 *
 * provider は呼び出し側が必ず明示注入する（既定値なし）。本番は getRegistryFetchProvider() が
 * null を返すため route が 501 で安全停止する（実 provider 未実装・本番挙動不変／cond⑦）。
 */
import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import type { RegistryPdfSession } from "@/lib/registry-pdf/process";
import {
  RegistryFetchError,
  type RegistryFetchProvider,
  type RegistryFetchErrorCode,
} from "@/lib/registry-fetch";
import type { RegistryLiveReporter } from "@/lib/registry-fetch/types";
import { buildRegistrySearchRequest } from "@/lib/registry-fetch/search-request";
import {
  rememberSearchCandidates,
  resolveCachedCandidate,
  fingerprintProperty,
  type ResolvedCandidate,
} from "./candidate-cache";

export interface RunRegistrySearchArgs {
  /** 認証済みセッション（route の getApiSession から id/role のみ）。 */
  session: RegistryPdfSession;
  /** 検索対象物件ID（route path の {id}）。 */
  propertyId: string;
  /** 課金を伴う可能性があるため明示確認フラグ。true 以外は実行しない（cond①）。 */
  confirmed: boolean;
  /**
   * 実況パネルのステップ通知先 (任意)。route が実行者本人限定のメモリ内
   * ストアへ橋渡しする。認可・確認フラグを通過した後にのみ provider へ渡す。
   */
  live?: RegistryLiveReporter;
}

// provider 失敗（RegistryFetchError）の分類コード → 安全な HTTP ステータス。
// auto-fetch.ts の PROVIDER_ERROR_STATUS と同方針（外部本文・認証情報・PII は載せない）。
const PROVIDER_ERROR_STATUS: Readonly<Record<RegistryFetchErrorCode, number>> = {
  timeout: 504,
  rate_limited: 429,
  auth_failed: 502,
  not_found: 404,
  // 所在の指定が受け付けられない=**入力の問題**。upstream 障害(502)でも
  // 「存在しない」(404)でもないので 422(内容が処理できない)を返し、
  // 利用者に「住所を直せば通る」と伝わる分類にする。
  location_rejected: 422,
  // 利用者が自分で止めた=クライアント都合の中断。499 は非標準なので 409
  // (現在の状態と衝突)を使い、サーバー障害(5xx)と明確に分ける。
  cancelled: 409,
  provider_error: 502,
  service_hours: 503, // 利用時間外=一時的に利用不可(Service Unavailable)。
  service_unavailable: 503, // 接続不可(時間外の可能性)=同じく一時的利用不可。
  charged_but_failed: 502, // 課金後の失敗(検索経路では発生しないが網羅性のため)。
};

/**
 * 所在検索の中核。route から呼ばれ、戻り値がそのまま API レスポンス body になる。
 * ハードエラーは ApiError を throw し、route 側 catch → handleApiError で HTTP 化する。
 *
 * provider は呼び出し側が必ず明示注入する（既定値なし）。
 */
export async function runRegistrySearch(
  args: RunRegistrySearchArgs,
  provider: RegistryFetchProvider,
): Promise<Record<string, unknown>> {
  const { session, propertyId, confirmed } = args;

  // 1. 確認フラグ必須（true 以外は DB / provider に一切到達しない／cond①）。
  //    route 側でも事前にガードするが、lib は直接呼出（テスト / 将来の別経路）からも
  //    独立して守るため再確認する（defense-in-depth・auto-fetch.ts と同方針）。
  if (confirmed !== true) {
    throw new ApiError(
      400,
      "謄本所在検索には確認（confirmed:true）が必要です",
      "REGISTRY_SEARCH_CONFIRMATION_REQUIRED",
    );
  }

  // 2. 対象物件の取得（検索キーの最小カラムのみ・所有者PIIは取得しない）。
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      createdBy: true,
      assignedTo: true,
      address: true,
      lotNumber: true,
      buildingNumber: true,
      realEstateNumber: true,
    },
  });
  if (!property) {
    throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  }

  // 3. 物件スコープ（field_staff は担当/作成物件のみ）。物件詳細 API と同一方針。
  if (!canAccessPropertyRecord(session, property)) {
    throw new ApiError(
      403,
      "この物件にアクセスする権限がありません",
      "FORBIDDEN",
    );
  }

  // 4. 検索入力の組み立て（純関数）。不動産番号があれば検索不要・所在が無ければ検索不能。
  const built = buildRegistrySearchRequest({
    address: property.address,
    lotNumber: property.lotNumber,
    buildingNumber: property.buildingNumber,
    realEstateNumber: property.realEstateNumber,
    ref: property.id,
  });

  if (!built.searchable) {
    // 検索不能（has_real_estate_number / insufficient_location）。
    // provider には到達せず 200 で reason を返す（非PII 監査のみ）。
    await writeRegistrySearchAudit(session.id, propertyId, {
      status: "skipped",
      reason: built.reason,
    });
    return { searchable: false, reason: built.reason };
  }

  // 5. searchable: provider が所在検索に実際に対応していなければ 501（型安全ガード）。
  //    method 有無だけでなく supportsLocationSearch===true を要求する。official は
  //    searchCandidates を持つが searchByLocation 未実装ゆえ未対応 → ここで 501 にして、
  //    searchCandidates を呼んで throttle/ブラウザを消費し provider_error(502) を返すのを
  //    避ける（cond⑦ fail-closed・@codex P2）。本番は getRegistryFetchProvider() が null ゆえ
  //    route 側で先に 501 になる。
  if (
    typeof provider.searchCandidates !== "function" ||
    provider.supportsLocationSearch !== true
  ) {
    throw new ApiError(
      501,
      "謄本所在検索プロバイダは未設定です",
      "REGISTRY_SEARCH_PROVIDER_NOT_CONFIGURED",
    );
  }

  try {
    // 実況パネル通知先の接続 (認可・確認・searchable 判定を全て通過した後)。
    const candidates = await provider.searchCandidates(
      args.live ? { ...built.request, live: args.live } : built.request,
    );

    // 実サイトの所在検索は不動産番号を返さず、候補は**地番(candidateRef)**
    // （不動産番号は有料の請求まで進まないと得られない=サイト仕様）。
    // candidateRef を持つ候補を表示用に通す。取得(段階②・2026-07-31 配線)は
    // 選んだ候補の地番/家屋番号をキャッシュから解決し、有料の請求→PDF取得へ進む。
    const displayable = candidates.filter((c) => !!c.candidateRef?.trim());

    // 取得側（resolveRegistryCandidate）が provider を再検索せず候補→取得キーを解決できるよう、
    // 認可済み検索の結果を server 内メモリに覚える（@codex P1: throttle 二重消費の回避）。
    // 段階②(2026-07-31): 地番のみの候補も**地番/家屋番号を取得キーとして**覚える
    // （有料の請求→PDF取得の入力になる）。番号候補は従来どおり不動産番号で覚える。
    // 物件指紋も一緒に覚え、取得時に物件が編集されていたら古い候補を無効化する（@codex P1）。
    rememberSearchCandidates(
      session.id,
      propertyId,
      fingerprintProperty(property),
      displayable,
    );

    // cond③: 応答から realEstateNumber を除外する（候補参照は取得時に server 再解決）。
    // 表示用フィールド（所在/地番/家屋番号）は認可ユーザー向け本文として返すが、
    // log / AuditLog には出さない。
    const shaped = displayable.map((c) => ({
      candidateRef: c.candidateRef,
      address: c.address ?? null,
      lotNumber: c.lotNumber ?? null,
      buildingNumber: c.buildingNumber ?? null,
    }));

    // 成功 AuditLog（非PII: 件数・状態のみ。所在/地番/不動産番号は載せない）。件数は返却分。
    await writeRegistrySearchAudit(session.id, propertyId, {
      status: "success",
      candidateCount: displayable.length,
    });

    return { searchable: true, candidates: shaped };
  } catch (err) {
    // provider 失敗は安全な分類のみで応答（外部本文・認証情報・PII は載せない）。
    if (err instanceof RegistryFetchError) {
      // ⚠**利用者が止めたものは「失敗」に数えない** (@codex #357 P2)。
      // provider の障害と混ぜると、失敗率の集計も障害調査も歪む。
      // 中止は課金前にしか起きないので、記録としても性質がまったく違う。
      await writeRegistrySearchAudit(session.id, propertyId, {
        status: err.code === "cancelled" ? "cancelled" : "failed",
        providerErrorCode: err.code,
      });
      // err.message は RegistryFetchError の固定文言のみ（errors.ts 参照・
      // 外部レスポンス本文 / 認証情報 / PII を含まない）。
      throw new ApiError(
        PROVIDER_ERROR_STATUS[err.code],
        err.message,
        "REGISTRY_SEARCH_PROVIDER_ERROR",
      );
    }
    // それ以外（Prisma 例外等）はそのまま route の handleApiError に委ねる。
    throw err;
  }
}

/**
 * registry_search の AuditLog を書く（非PII の allowlist のみ）。
 * 所在/地番/家屋番号/不動産番号/所有者名・住所は載せない（cond②）。
 */
async function writeRegistrySearchAudit(
  userId: string,
  propertyId: string,
  extra: {
    // ⚠"cancelled" を "failed" に含めない (@codex #357 P2)。利用者が自分で止めた
    // 操作を「provider の失敗」として数えると、運用の集計(失敗率・障害調査)が歪む。
    status: "success" | "skipped" | "failed" | "cancelled";
    reason?: string;
    candidateCount?: number;
    providerErrorCode?: RegistryFetchErrorCode;
  },
): Promise<void> {
  await writeAuditLog({
    userId,
    action: "registry_search",
    targetTable: "properties",
    targetId: propertyId,
    detail: {
      propertyId,
      confirmed: true,
      ...extra,
    },
  });
}

export interface ResolveRegistryCandidateArgs {
  /** 認証済みセッション（id/role のみ）。 */
  session: RegistryPdfSession;
  /** 取得対象物件ID（route path の {id}）。 */
  propertyId: string;
  /** 課金を伴う可能性があるため明示確認フラグ（cond①）。 */
  confirmed: boolean;
  /** client が選択した候補参照。信頼せず server で再解決する（cond③）。 */
  candidateRef: string;
}

/**
 * cond③: 取得時に client の candidateRef を信頼せず、取得キー（不動産番号 or 地番/家屋番号）は
 * 「認可済み検索が server に残したマッピング」からのみ解決する（改ざん対策）。取得側で provider を
 * 再検索しない（@codex P1: search と fetch の間で provider throttle を二重に消費して 429 になるのを
 * 避ける）。
 *
 * scope（field_staff 可視範囲）と物件存在・楽観ロックは後続の runRegistryAutoFetch が再確認する。
 * キャッシュ自体も (userId, propertyId, candidateRef) キーゆえ他ユーザー/他物件の候補は解決しない。
 * 解決したキーは取得の内部利用のみ（応答・log・AuditLog に出さない／cond②）。
 */
export async function resolveRegistryCandidate(
  args: ResolveRegistryCandidateArgs,
): Promise<{ candidate: ResolvedCandidate; fingerprint: string }> {
  const { session, propertyId, confirmed, candidateRef } = args;

  // 確認フラグ必須（true 以外は解決しない／cond①）。
  if (confirmed !== true) {
    throw new ApiError(
      400,
      "謄本取得には確認（confirmed:true）が必要です",
      "REGISTRY_AUTO_FETCH_CONFIRMATION_REQUIRED",
    );
  }
  const ref = typeof candidateRef === "string" ? candidateRef.trim() : "";
  if (!ref) {
    throw new ApiError(
      400,
      "取得する候補が指定されていません",
      "REGISTRY_OBTAIN_CANDIDATE_REQUIRED",
    );
  }

  // 現在の物件スナップショット（指紋用・スコープ確認用。所有者PIIは取らない。provider は呼ばない）。
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      createdBy: true,
      assignedTo: true,
      address: true,
      lotNumber: true,
      buildingNumber: true,
      realEstateNumber: true,
    },
  });
  if (!property) {
    throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  }
  if (!canAccessPropertyRecord(session, property)) {
    throw new ApiError(
      403,
      "この物件にアクセスする権限がありません",
      "FORBIDDEN",
    );
  }

  // 認可済み検索が覚えた候補からのみ取得キーを解決する（client の値は一致判定にのみ使う）。
  // @codex P1: 検索時の物件指紋と現在が一致する場合だけ有効（編集後の古い候補は使わせない）。
  const fingerprint = fingerprintProperty(property);
  const candidate = resolveCachedCandidate(session.id, propertyId, ref, fingerprint);
  if (!candidate) {
    // 未検索 / 改ざん / TTL 超過 / 物件編集で指紋不一致 → 409。秘匿情報は載せない。
    throw new ApiError(
      409,
      "選択した候補が見つかりません。物件情報が変わった可能性があります。もう一度検索してから取得してください",
      "REGISTRY_OBTAIN_CANDIDATE_NOT_FOUND",
    );
  }

  // @codex P2: 取得側(runRegistryAutoFetch)が version-lock する行の指紋とこれが一致する時だけ
  // override を使うよう、解決に使った指紋も返す（resolve〜取得の間の編集による TOCTOU 防止）。
  return { candidate, fingerprint };
}
