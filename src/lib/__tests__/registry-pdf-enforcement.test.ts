/**
 * S1b-4: registry PDF preview/download server-side enforcement の配線を
 * source-assertion で検証する（route handler / client は jsdom 無しでは render 不可のため）。
 * enforcement の判定本体は uploads-authorization.test.ts の unit test で担保する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

const routeSrc = read("src/app/uploads/[...path]/route.ts");
const authSrc = read("src/lib/uploads-authorization.ts");
const attachSrc = read("src/components/properties/attachment-tab.tsx");

describe("S1b-4: uploads-authorization の registry gating", () => {
  it("AuthorizeUploadAccessArgs に downloadIntent を追加", () => {
    expect(authSrc).toMatch(/downloadIntent\??:\s*boolean/);
  });

  it("attachment select に type を追加", () => {
    expect(authSrc).toMatch(/type:\s*true/);
  });

  it("registry のとき registry_pdf:preview / download を gate する", () => {
    expect(authSrc).toMatch(/a\.type === "registry"/);
    expect(authSrc).toMatch(/"registry_pdf",\s*"preview"/);
    expect(authSrc).toMatch(/"registry_pdf",\s*"download"/);
  });

  it("UploadAuthDecision の戻り値型は変えない（string enum のまま）", () => {
    expect(authSrc).toMatch(
      /UploadAuthDecision = "ok" \| "forbidden" \| "not_found"/,
    );
  });

  it("serve 用 resolveRegistryServeMeta を export する", () => {
    expect(authSrc).toMatch(/export async function resolveRegistryServeMeta/);
    // 24巡目: 実体は resolveProtectedServeMeta（registry / referral を1回で判定）。
    expect(authSrc).toMatch(/export async function resolveProtectedServeMeta/);
  });
});

describe("S1b-4: /uploads route の header / 監査", () => {
  it("?download=1 を downloadIntent として読み、authorize に渡す", () => {
    expect(routeSrc).toMatch(
      /searchParams\.get\("download"\)\s*===\s*"1"/,
    );
    expect(routeSrc).toMatch(/authorizeUploadAccess\(\{[\s\S]*downloadIntent[\s\S]*\}\)/);
  });

  it("serve 時に保護対象(registry / referral)のメタを引く", () => {
    // ⚠24巡目: registry と referral を**1回の問い合わせ**で判定する
    //   resolveProtectedServeMeta に一本化した（referral も no-store の対象）。
    expect(routeSrc).toMatch(/resolveProtectedServeMeta\(key\)/);
    // registry の扱いはメタの kind から導出する（判定の二重化をしない）。
    expect(routeSrc).toMatch(/serveMeta\?\.kind === "registry"/);
  });

  it("保護対象(registry / referral)に Cache-Control: no-store", () => {
    expect(routeSrc).toMatch(/no-store/);
    // ⚠no-store と ETag/304 は両立しない。保護対象は 304 の対象外であること。
    expect(routeSrc).toMatch(/const etag = serveMeta \? null : buildUploadsEtag\(key\)/);
  });

  it("registry の Content-Disposition は共通関数が組み立てる（route で手書きしない）", () => {
    // 保存名の中身は registry-display-name.test.ts が総当たりで固定する。
    // ここでは「route が自前で名前を書いていない」ことだけを見る。
    expect(routeSrc).toMatch(/registryContentDisposition\(\{/);
    expect(routeSrc).toMatch(/downloadIntent,/);
    expect(routeSrc).not.toMatch(/attachment; filename=/);
  });

  it("X-Content-Type-Options: nosniff を付与", () => {
    expect(routeSrc).toMatch(/X-Content-Type-Options/);
    expect(routeSrc).toMatch(/nosniff/);
  });

  it("Content-Disposition filename に att.fileName を使わない（route は att.fileName を参照しない）", () => {
    expect(routeSrc).not.toMatch(/att\.fileName/);
    expect(routeSrc).not.toMatch(/\.fileName/);
  });

  it("registry preview / download を server-side で監査する（非PII）", () => {
    expect(routeSrc).toMatch(/registry_pdf_preview/);
    expect(routeSrc).toMatch(/registry_pdf_download/);
    expect(routeSrc).toMatch(/targetTable:\s*"attachments"/);
    expect(routeSrc).toMatch(/writeAuditLog/);
    // detail は propertyId 程度に留め、fileName / 所有者情報は入れない
    expect(routeSrc).not.toMatch(/detail:\s*\{[^}]*fileName/);
  });

  it("未認証 401 / not_found 404 / denied 403 の既存方針は維持", () => {
    expect(routeSrc).toMatch(/status:\s*401/);
    expect(routeSrc).toMatch(/status:\s*404/);
    expect(routeSrc).toMatch(/status:\s*403/);
  });
});

describe("S1b-4: attachment-tab の download intent", () => {
  it("registry の download のみ download intent param を付ける", () => {
    expect(attachSrc).toMatch(/function withDownloadIntent/);
    expect(attachSrc).toMatch(/download=1/);
    expect(attachSrc).toMatch(/att\.type === "registry"/);
    expect(attachSrc).toMatch(/isRegistry \? withDownloadIntent/);
  });

  it("registry の保存名は generic（att.fileName を使わない）", () => {
    // 名前は共通モジュールが作る。attachment-tab は自前の定数を持たない。
    expect(attachSrc).toMatch(
      /import \{[\s\S]*registryDisplayName[\s\S]*\} from "@\/lib\/attachments\/registry-display-name"/,
    );
    expect(attachSrc).not.toMatch(/REGISTRY_DOWNLOAD_NAME/);
  });

  it("preview iframe は無 param のまま（src は safeUrl）", () => {
    expect(attachSrc).toMatch(/<iframe[\s\S]*src=\{safeUrl\}/);
  });
});

describe("S1b-registry-preview: client 表示名の PII 限定（17-A Phase 1）", () => {
  it("registry は表示名を種別＋登録日(非PII)から作り、registry以外は att.fileName", () => {
    // registry の表示名は生ファイル名を使わず、非PIIの材料だけから組み立てる。
    expect(attachSrc).toMatch(
      /const displayName = isRegistry\s*\?\s*registryDisplayName\(\s*att\.registryCertificateType,\s*att\.createdAt,?\s*\)\s*:\s*att\.fileName/,
    );
    // ラベルの文字列そのものは共通モジュールにしか無い（画面側で手書きしない）。
    expect(attachSrc).not.toMatch(/謄本\(/);
  });

  it("preview modal / row の表示テキスト・title・alt・iframe title・download に att.fileName を直接バインドしない", () => {
    // JSX 表示/属性に {att.fileName} を一切残さない（registry の原ファイル名 PII を client に出さない）。
    expect(attachSrc).not.toMatch(/\{att\.fileName\}/);
    // 表示は displayName を使う。
    expect(attachSrc).toMatch(/title=\{displayName\}/);
    expect(attachSrc).toMatch(/alt=\{displayName\}/);
    expect(attachSrc).toMatch(/download=\{displayName\}/);
  });

  it("getPreviewKind の拡張子判定は実 att.fileName を維持（表示と分離してロジックは壊さない）", () => {
    expect(attachSrc).toMatch(/att\.fileName\.toLowerCase\(\)/);
  });

  it("iframe preview 自体は維持（src={safeUrl}・viewer は置換しない）", () => {
    expect(attachSrc).toMatch(/<iframe[\s\S]*src=\{safeUrl\}/);
  });

  it("iframe 内操作の限界を honest に明記（親 document で捕捉できない・主防御は server gate・prevention とは書かない）", () => {
    expect(attachSrc).toMatch(/ScreenProtectionGuard では捕捉できない/);
    expect(attachSrc).toMatch(/server-side permission gate/);
    // 「完全（に）防止」と読める過剰文言を入れない（prevention ではなく抑止＋事後追跡）。
    expect(attachSrc).not.toMatch(/完全に防止|完全防止/);
  });
});
