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
  });
});

describe("S1b-4: /uploads route の header / 監査", () => {
  it("?download=1 を downloadIntent として読み、authorize に渡す", () => {
    expect(routeSrc).toMatch(
      /searchParams\.get\("download"\)\s*===\s*"1"/,
    );
    expect(routeSrc).toMatch(/authorizeUploadAccess\(\{[\s\S]*downloadIntent[\s\S]*\}\)/);
  });

  it("serve 時に resolveRegistryServeMeta を引く", () => {
    expect(routeSrc).toMatch(/resolveRegistryServeMeta\(key\)/);
  });

  it("registry のみ Cache-Control: no-store", () => {
    expect(routeSrc).toMatch(/no-store/);
  });

  it("registry の Content-Disposition は download=attachment;filename=registry.pdf / preview=inline", () => {
    expect(routeSrc).toMatch(/attachment; filename="registry\.pdf"/);
    expect(routeSrc).toMatch(/"inline"/);
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
    expect(attachSrc).toMatch(/REGISTRY_DOWNLOAD_NAME\s*=\s*"registry\.pdf"/);
  });

  it("preview iframe は無 param のまま（src は safeUrl）", () => {
    expect(attachSrc).toMatch(/<iframe[\s\S]*src=\{safeUrl\}/);
  });
});

describe("S1b-registry-preview: client 表示名の PII 限定（17-A Phase 1）", () => {
  it("registry は表示名・保存名を generic に統一（displayName = isRegistry ? REGISTRY_DOWNLOAD_NAME : att.fileName）", () => {
    expect(attachSrc).toMatch(
      /const displayName = isRegistry \? REGISTRY_DOWNLOAD_NAME : att\.fileName/,
    );
    // registry 以外は従来どおり att.fileName（ternary の else 分岐）。
    expect(attachSrc).toMatch(/REGISTRY_DOWNLOAD_NAME : att\.fileName/);
    // generic 名は registry.pdf 固定。
    expect(attachSrc).toMatch(/REGISTRY_DOWNLOAD_NAME\s*=\s*"registry\.pdf"/);
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
