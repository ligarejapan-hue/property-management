import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, maskValue } from "@/lib/permissions";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import { writeAuditLog } from "@/lib/audit";
import { encodeCsv, sanitizeCsvCellForExcel } from "@/lib/csv-encode";
import { createTokenBucketLimiter } from "@/lib/token-bucket";
import {
  lookupAddressByPostalCode,
  isAddressLookupConfigured,
  AddressLookupError,
  normalizePostalCode,
  isValidPostalCode,
} from "@/lib/address-lookup";
import {
  comparePostalAddress,
  buildPostalAuditCsvRow,
  buildNotProcessedRow,
  POSTAL_AUDIT_CSV_HEADERS,
  POSTAL_AUDIT_MAX_TARGETS,
  POSTAL_AUDIT_TIME_BUDGET_MS,
  type PostalAuditRow,
  type PostalAuditCandidate,
} from "@/lib/postal-code-audit";
import { normalizeAddress } from "@/lib/address-lookup/normalize";

// ---------- GET /api/admin/postal-code-audit ----------
//
// 所有者(Owner)の保存済み郵便番号(zip)と住所(address)が整合しているかを、
// 郵便番号 → 住所 lookup（日本郵便 API 等）と突き合わせて点検する read-only レポート。
// DB は一切変更しない（自動修正なし）。on-demand 実行（自動バッチなし）。
//
// 権限:
//   - user_management:read（管理者エリア）+ owner:read（PII 閲覧）必須
//   - CSV 出力(?format=csv)はさらに csv_export:read / csv_export_personal:read 必須
//     （所有者名・郵便番号・住所という PII を含む CSV のため、既存 DM/CSV export と同じゲート）
//
// PII egress 最小化:
//   - 外部 API へ送るのは「郵便番号のみ」。保存住所は外部へ送らず、サーバ内で
//     取得済み候補住所（一般地名）と突き合わせるだけ（comparePostalAddress）。
//   - 同一郵便番号は 1 回だけ lookup してキャッシュする（API 呼び出し削減 + egress 削減）。
//
// レート制御・件数上限・時間バジェット（Codex P1: 60s プロキシタイムアウト対策）:
//   - 対象 owner が多いと多数の API 呼び出しになるため token-bucket で throttle。
//   - 対象は POSTAL_AUDIT_MAX_TARGETS 件で打ち切り、超過時は silent に切らず truncated を立てる。
//   - さらに lookup ループ全体に POSTAL_AUDIT_TIME_BUDGET_MS(45s) の経過時間バジェットを設け、
//     超過したら残りの owner を silent に捨てず `not_processed` 行として返し、
//     `timeBudgetExhausted=true`・`processed`(照合済件数) を明示する。これにより 1 リクエストは
//     nginx の proxy_read_timeout(60s) 内に確実に収まる（共有 limiter は 5 lookups/sec のため、
//     上限 200 件 × 全ユニーク ZIP の最悪でも ~40s で、45s バジェット・60s タイムアウトに収まる）。

// 1 秒あたり 5 リクエスト・バースト 5 の控えめなレート。外部 API への礼儀的 throttle。
const LOOKUP_REFILL_PER_SEC = 5;
const LOOKUP_BURST = 5;
// throttle 待機の最大ループ（暴走防止）。1 件あたり最長 ~2 秒待つ。
const MAX_WAIT_MS_PER_LOOKUP = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Codex P2: token-bucket(throttle) はモジュールレベルの単一インスタンスにして
// リクエスト間で共有する。GET 内で都度生成すると、同時リクエスト（複数管理者/タブ）が
// それぞれ fresh burst + 独自 refill を持ち、同一 ZIP を重複で叩いて上流呼び出しが増える。
// 単一 Node プロセス前提（token-bucket.ts と同方針）。
const sharedLimiter = createTokenBucketLimiter({
  capacity: LOOKUP_BURST,
  refillPerSec: LOOKUP_REFILL_PER_SEC,
});

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    // 管理者エリア + PII 閲覧。いずれか欠ければ DB 取得・API 照合・AuditLog 書込を行わず 403。
    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }

    const { searchParams } = new URL(request.url);
    const wantsCsv = searchParams.get("format") === "csv";

    // CSV は PII を含むため、既存 DM/CSV export と同じ csv_export 系ゲートを追加で課す。
    if (wantsCsv) {
      if (!hasPermission(perms, "csv_export", "read")) {
        throw new ApiError(403, "CSV エクスポートの権限がありません", "FORBIDDEN");
      }
      if (!hasPermission(perms, "csv_export_personal", "read")) {
        throw new ApiError(
          403,
          "個人情報を含む CSV エクスポートの権限がありません",
          "FORBIDDEN",
        );
      }
    }

    const displayConfig = await getOwnerDisplayConfig(session.id, perms);

    // 表示権限が「生値を返すレベル」かどうか。
    //  - 保存住所が隠れるレベルでは、API住所と保存住所マスクの差で住所を推測される
    //    懸念があるため API住所を伏せる。
    //  - Codex P1: API住所(matchedAddressLine)は保存 ZIP から API で導出した値であり、
    //    ZIP の地域情報を含む。owner_address が生値でも owner_zip がマスク/非表示なら、
    //    見えてはいけない ZIP 由来の地域情報を露出させてしまう。したがって ZIP も
    //    生値レベルのときに限り API住所を返す（判定/不一致フラグ自体は出してよい）。
    const addressPlain = isPlainOwnerLevel(displayConfig.address);
    const zipPlain = isPlainOwnerLevel(displayConfig.zip);
    // ZIP 由来の照合住所は「住所が生値 かつ ZIP が生値」のときのみ提示する。
    const canShowApiAddress = addressPlain && zipPlain;

    // 1. 対象 owner（非アーカイブ・zip と address の両方あり）を取得。
    //    DB レベルで zip/address 非空に絞り、無駄な API 照合対象を減らす。
    //    take = MAX+1 で「上限超過」を検出（超過分は照合せず truncated を立てる）。
    //
    //    NOTE: Prisma では空文字列 "" は `{ not: null }` を通過してしまう（null ではないため）。
    //    空文字 zip を対象に含めると lookupCandidates が早期 return で [] を返し、無駄な
    //    対象行（必ず invalid_postal_code）になるうえ、将来 lookup 経路が変わった際に空文字 ZIP
    //    の照合不能結果が同一正規化キーのキャッシュを汚染するリスクもある。よって null だけでなく
    //    空文字も DB レベルで除外する（`{ not: null }` と `{ not: "" }` を AND で併記）。
    //    後段ガード（normalizeAddress===""・isValidPostalCode）はフェイルセーフとして維持する。
    const owners = await prisma.owner.findMany({
      where: {
        isArchived: false,
        // null・空文字の両方を除外する。フィールドフィルタ内では同一キー(not)を二重に
        // 書けないため、モデルレベルの AND で `{ not: null }` と `{ not: "" }` を併記する。
        AND: [
          { zip: { not: null } },
          { zip: { not: "" } },
          { address: { not: null } },
          { address: { not: "" } },
        ],
      },
      select: { id: true, name: true, zip: true, address: true },
      orderBy: { createdAt: "asc" },
      take: POSTAL_AUDIT_MAX_TARGETS + 1,
    });

    const truncated = owners.length > POSTAL_AUDIT_MAX_TARGETS;
    const targets = truncated ? owners.slice(0, POSTAL_AUDIT_MAX_TARGETS) : owners;

    // 2. API 未設定なら照合せず安全に返す（クラッシュしない）。
    //    全 owner を indeterminate(lookup_unavailable) として返し、apiConfigured=false を立てる。
    const apiConfigured = isAddressLookupConfigured();

    // 同一郵便番号の lookup 結果キャッシュ（正規化済み 7 桁 zip → 候補 or null[=不能]）。
    // キャッシュはリクエスト単位（最新の DB 値で照合するため）。throttle のみ共有する。
    const lookupCache = new Map<string, PostalAuditCandidate[] | null>();
    const limiter = sharedLimiter;

    // API 設定済みのときだけ実際に lookup する純度の高い helper。
    // 未設定・有効な郵便番号でない場合は null/skip を返し、comparePostalAddress に委ねる。
    async function lookupCandidates(rawZip: string): Promise<PostalAuditCandidate[] | null> {
      if (!apiConfigured) return null;
      const zip7 = normalizePostalCode(rawZip);
      if (!isValidPostalCode(zip7)) {
        // 不正郵便番号は API を叩かない（comparePostalAddress が invalid_postal_code を返す）。
        // candidates は [] を渡しても invalid 判定が優先されるが、PII egress と無駄打ちを避けるため照合しない。
        // ここで返す [] は lookupCache に書かない（早期 return）。書くと、正規化後に同じ zip7 を
        // 生む別レコード（本来は妥当）まで「候補なし([])」を引いて no_candidate に誤判定するキャッシュ汚染になる。
        return [];
      }
      if (lookupCache.has(zip7)) return lookupCache.get(zip7)!;

      // throttle: トークンが取れるまで短時間待つ（暴走防止に上限あり）。
      // Codex P2-②: token-bucket の意味（バックプレッシャ）を保つため、
      // トークンを消費できなければ上流 lookup を呼ばない。以前は待機ループの
      // タイムアウトで break した後、トークン未消費のまま上流を呼んでいたため、
      // 高負荷（同時監査 / ユニーク ZIP がバケット容量超過）下で共有 limiter の
      // レート制御がバイパスされていた。取得できないままタイムアウトしたら、
      // 上流を呼ばずに照合不能(null=lookup_unavailable)へ安全に倒す。
      let acquired = false;
      let waited = 0;
      for (;;) {
        if (limiter.tryConsume("postal-audit", Date.now())) {
          acquired = true;
          break;
        }
        if (waited >= MAX_WAIT_MS_PER_LOOKUP) break;
        await sleep(100);
        waited += 100;
      }
      if (!acquired) {
        // トークン未消費 = 上流を呼ばない。キャッシュには入れない
        //（後続リクエストでトークンが空けば再試行できるようにする）。
        return null;
      }

      let result: PostalAuditCandidate[] | null;
      try {
        // PII egress は郵便番号のみ（住所は送らない）。
        const candidates = await lookupAddressByPostalCode(zip7);
        result = candidates.map((c) => ({ addressLine: c.addressLine }));
      } catch (err) {
        // NOT_CONFIGURED 等は安全側で照合不能(null)に倒す。message に PII は無い。
        if (err instanceof AddressLookupError) {
          result = null;
        } else {
          // 想定外エラーも owner 単位の indeterminate に倒し、レポート全体は壊さない。
          result = null;
        }
      }
      lookupCache.set(zip7, result);
      return result;
    }

    // 3. owner ごとに照合。
    //    Codex P1: lookup ループに経過時間バジェット(POSTAL_AUDIT_TIME_BUDGET_MS=45s)を設ける。
    //    共有 limiter が 5 lookups/sec のため、多数のユニーク ZIP を直列 await すると nginx の
    //    proxy_read_timeout(60s) を超過し、レポート/CSV を一切返せず失敗する。バジェット超過時は
    //    残りの owner を silent に捨てず `not_processed` 行として返し、`timeBudgetExhausted` を立てる。
    //    開始時刻はループ直前に取る（DB 取得時間はバジェットに含めない＝照合に使える時間を最大化）。
    const deadline = Date.now() + POSTAL_AUDIT_TIME_BUDGET_MS;
    const rows: PostalAuditRow[] = [];
    let timeBudgetExhausted = false;
    let processed = 0;
    for (let i = 0; i < targets.length; i += 1) {
      const owner = targets[i];
      // バジェット超過: ここからの owner は照合せず未処理として明示する（silent 切り捨て禁止）。
      // 既に消費したトークンは無駄にしないため「次の lookup を始める前」に判定する。
      if (Date.now() >= deadline) {
        timeBudgetExhausted = true;
        for (let j = i; j < targets.length; j += 1) {
          const rest = targets[j];
          rows.push(
            buildNotProcessedRow({
              ownerId: rest.id,
              nameMasked: maskValue(rest.name, displayConfig.name),
              zipMasked: maskValue(rest.zip, displayConfig.zip),
              addressMasked: maskValue(rest.address, displayConfig.address),
            }),
          );
        }
        break;
      }

      // Codex P2-①: 住所が空 / 空白のみの行は判定が自明（address_empty）であり、
      // ZIP を外部 API へ送る意味がない。lookup を呼ばず（PII egress / 無駄な外部呼び出しを
      // 避ける）、candidates=[] を渡して comparePostalAddress に address_empty を確定させる。
      // （ZIP が不正なら invalid_postal_code が優先される。どちらも API 不要で確定する。）
      const addressEmpty = !owner.address || normalizeAddress(owner.address) === "";
      const candidates = addressEmpty ? [] : await lookupCandidates(owner.zip ?? "");
      const cmp = comparePostalAddress(owner.zip, owner.address, candidates);
      processed += 1;
      rows.push({
        ownerId: owner.id,
        nameMasked: maskValue(owner.name, displayConfig.name),
        zipMasked: maskValue(owner.zip, displayConfig.zip),
        addressMasked: maskValue(owner.address, displayConfig.address),
        // API住所（ZIP 由来の照合住所）は住所・ZIP ともに生値レベルのときだけ提示。
        // ZIP がマスク/非表示なら ZIP 由来の地域情報露出を防ぐため伏せる（Codex P1）。
        apiAddressLine: canShowApiAddress ? cmp.matchedAddressLine : null,
        verdict: cmp.verdict,
        reason: cmp.reason,
      });
    }
    const notProcessed = rows.length - processed;

    const summary = {
      total: rows.length,
      match: rows.filter((r) => r.verdict === "match").length,
      mismatch: rows.filter((r) => r.verdict === "mismatch").length,
      indeterminate: rows.filter((r) => r.verdict === "indeterminate").length,
    };

    // 4. 監査ログ。PII は記録しない（件数・サマリ・フラグのみ）。
    await writeAuditLog({
      userId: session.id,
      action: wantsCsv ? "postal_code_audit_csv_export" : "postal_code_audit_list",
      detail: {
        apiConfigured,
        truncated,
        timeBudgetExhausted,
        processed,
        notProcessed,
        maxTargets: POSTAL_AUDIT_MAX_TARGETS,
        timeBudgetMs: POSTAL_AUDIT_TIME_BUDGET_MS,
        summary,
      },
    });

    if (wantsCsv) {
      // CSV は不一致・判定不能の点検が主目的だが、全件を出す（一致も含め全件突合の証跡）。
      const sanitizedRows = rows.map((r) =>
        Object.fromEntries(
          Object.entries(buildPostalAuditCsvRow(r)).map(([k, v]) => [
            k,
            sanitizeCsvCellForExcel(v),
          ]),
        ),
      );
      const csv = encodeCsv([...POSTAL_AUDIT_CSV_HEADERS], sanitizedRows, { bom: true });
      const fileDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="postal_code_audit_${fileDate}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return apiResponse({
      apiConfigured,
      truncated,
      // Codex P1: 時間バジェット超過で未処理が出た場合に UI へ明示する（silent 切り捨て禁止）。
      timeBudgetExhausted,
      processed,
      notProcessed,
      maxTargets: POSTAL_AUDIT_MAX_TARGETS,
      timeBudgetMs: POSTAL_AUDIT_TIME_BUDGET_MS,
      summary,
      rows,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
