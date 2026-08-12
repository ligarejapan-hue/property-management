import { createHash } from "node:crypto";
/**
 * PR-2b-3 (@codex P1): 所在検索の候補（candidateRef → 不動産番号）を「認可済みユーザーの検索」から
 * 取得側へ橋渡しする短命 in-memory マップ。
 *
 * 目的: 取得時に provider を再検索しない（cond③ の「server 再解決」を、認可済み検索が残した
 * server 側マッピングの参照で満たす）。これにより search→obtain で provider throttle を
 * 二重に消費しない（obtain 側の再検索予約を無くす）。
 *
 * 前提: 本アプリは単一プロセス（systemd 1サービス）運用ゆえプロセス内 Map で十分。restart で
 * 消えるが、その場合は再検索で回復する（取得前に必ず「検索」を通る導線のため実害は小）。
 *
 * cond②/cond③: 不動産番号は server 内部の取得キーとしてのみ保持し、log/応答には出さない。
 * キーは (userId, propertyId, candidateRef) で、他ユーザー/他物件の候補は解決できない。
 */
/**
 * 覚える候補は2種類（段階②・2026-07-31 拡張）:
 *  - number:   不動産番号を持つ候補（従来の番号取得キー）。
 *  - location: 地番/家屋番号の候補（所在検索が返す実サイトの形）。有料の請求→PDF取得
 *              (段階②)の取得キーになる。値は秘匿情報＝log/応答に出さない。
 */
export type ResolvedCandidate =
  | { kind: "number"; realEstateNumber: string }
  | {
      kind: "location";
      lotNumber: string | null;
      buildingNumber: string | null;
    };

interface CachedCandidate {
  resolved: ResolvedCandidate;
  /** 検索時点の物件スナップショット指紋。取得時に一致しなければ無効（物件が編集された）。 */
  fingerprint: string;
  expiresAt: number;
}

const store = new Map<string, CachedCandidate>();
const TTL_MS = 10 * 60 * 1000; // 検索→選択→取得の一連操作に十分な短命。

// キー区切り文字。userId/propertyId は UUID ゆえ '/' を含まず、prefix 一致（user+property の
// 一括削除）が曖昧にならない（candidateRef は末尾のため '/' を含んでも可）。
// @codex P2: 制御文字リテラルをソースに埋め込まない（ファイルをテキストのまま保つ）。
const KEY_SEP = "/";
function key(userId: string, propertyId: string, candidateRef: string): string {
  return `${userId}${KEY_SEP}${propertyId}${KEY_SEP}${candidateRef}`;
}

/** 指紋の材料（検索キーに使う物件フィールド）。これらが変われば候補は陳腐化する。 */
export interface PropertyFingerprintSource {
  address: string | null;
  lotNumber: string | null;
  buildingNumber: string | null;
  realEstateNumber: string | null;
}

const normalize = (v: string | null | undefined): string => v?.trim() ?? "";

/**
 * 検索キーに使う物件フィールド（所在/地番/家屋番号/不動産番号）の指紋。@codex P1: 検索と取得の間に
 * 物件が編集（所在変更・不動産番号追加 等）されると古い候補で別物件の謄本を取得・紐付けしてしまうため、
 * 指紋一致を取得の前提にする。
 */
export function fingerprintProperty(p: PropertyFingerprintSource): string {
  return JSON.stringify([
    normalize(p.address),
    normalize(p.lotNumber),
    normalize(p.buildingNumber),
    normalize(p.realEstateNumber),
  ]);
}

/**
 * 指紋を保存用のハッシュにする（一括ジョブの各行に控える）。
 *
 * ⚠**地番は秘匿情報**なので値そのものを DB に残さない（sha256 の先頭32桁だけ）。
 * ⚠指紋そのもの（JSON 配列）と混同しない。候補キャッシュの照合は指紋、
 *   一括の行に控えるのはこのハッシュ。
 */
export function hashPropertyFingerprint(p: PropertyFingerprintSource): string {
  return createHash("sha256")
    .update(fingerprintProperty(p))
    .digest("hex")
    .slice(0, 32);
}

/**
 * 認可済み検索が返した候補を覚える（candidateRef → 取得キー）。fingerprint は検索時点の
 * 物件指紋。now はテスト注入用。
 *
 * 段階②(2026-07-31): 不動産番号を持たない候補（実サイトの所在検索が返す地番候補）も、
 * **地番/家屋番号を取得キーとして**覚える（有料の請求→PDF取得に使う）。
 * 番号も地番も無い候補は取得キーにできないため従来どおり覚えない。
 */
export function rememberSearchCandidates(
  userId: string,
  propertyId: string,
  fingerprint: string,
  candidates: ReadonlyArray<{
    candidateRef?: string | null;
    realEstateNumber?: string | null;
    lotNumber?: string | null;
    buildingNumber?: string | null;
  }>,
  now: number = Date.now(),
): void {
  // @codex P2 ×2: 追加前に掃除する。(a) 期限切れエントリを全体から削除して Map の際限ない増大と
  // TTL 超過後の秘匿キー滞留を防ぐ。(b) 同一ユーザー×同一物件の旧候補を消して、前回検索の
  // candidateRef（今回の結果に無い候補）で取得されるのを防ぐ（古いタブ/細工要求対策）。
  const prefix = `${userId}${KEY_SEP}${propertyId}${KEY_SEP}`;
  for (const [k, e] of store) {
    if (e.expiresAt <= now || k.startsWith(prefix)) {
      store.delete(k);
    }
  }
  for (const c of candidates) {
    const ref = c.candidateRef?.trim();
    if (!ref) continue;
    const ren = c.realEstateNumber?.trim();
    const lot = c.lotNumber?.trim();
    const bld = c.buildingNumber?.trim();
    let resolved: ResolvedCandidate | null = null;
    if (ren) {
      resolved = { kind: "number", realEstateNumber: ren };
    } else if (lot || bld) {
      resolved = {
        kind: "location",
        lotNumber: lot || null,
        buildingNumber: bld || null,
      };
    }
    if (resolved) {
      store.set(key(userId, propertyId, ref), {
        resolved,
        fingerprint,
        expiresAt: now + TTL_MS,
      });
    }
  }
}

/**
 * 取得時に candidateRef から取得キー（不動産番号 or 地番/家屋番号）を解決する。
 * 未検索/改ざん/TTL 超過は null（route 側で 409）。
 * client の candidateRef は「一致するか」だけに使い、キーは server が覚えた値のみ返す（cond③）。
 */
export function resolveCachedCandidate(
  userId: string,
  propertyId: string,
  candidateRef: string,
  fingerprint: string,
  now: number = Date.now(),
): ResolvedCandidate | null {
  const k = key(userId, propertyId, candidateRef);
  const entry = store.get(k);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    store.delete(k);
    return null;
  }
  // @codex P1: 検索後に物件が編集されていたら（指紋不一致）、古い候補は使わせない。
  if (entry.fingerprint !== fingerprint) {
    store.delete(k);
    return null;
  }
  return entry.resolved;
}

/** テスト用: プロセス内キャッシュを空にする。 */
export function __clearCandidateCacheForTests(): void {
  store.clear();
}

/** テスト用: プロセス内キャッシュの現在のエントリ数（prune 検証用）。 */
export function __candidateCacheSizeForTests(): number {
  return store.size;
}
