/**
 * ピン作成モーダルの写真の要否 (SSR 検証)。
 *
 * 発注者要望 2026-08-17「写真なしでも物件化候補を立てたい」で、写真の扱いは
 * **入口で決まる**ようになった:
 * - 撮影経由 (写真が付いて開く) = 従来どおり必須のまま。外す導線も置かない
 *   (@codex #336 P2 の懸念=「勝手に写真なしピンが作れてしまう」をそのまま維持)。
 * - 写真なし導線 (写真を持たずに開く) = 任意。あとから添付もできる。
 *
 * vitest は node 環境のため renderToStaticMarkup で静的描画を検証する。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import PinCreateModal from "@/components/field-survey/pin-create-modal";

const noop = () => {};

function renderModal(withPhoto: boolean): string {
  return renderToStaticMarkup(
    createElement(PinCreateModal, {
      initialLat: 35.0,
      initialLng: 139.0,
      sessionId: "session-1",
      saving: false,
      serverError: null,
      photoUploading: false,
      photoUploadFailed: false,
      onCancel: noop,
      onSubmit: noop,
      onRetryPhoto: noop,
      onFinishWithoutPhoto: noop,
      onReplaceLocation: noop,
      ...(withPhoto
        ? {
            initialPhotoFile: new File(["x"], "p.jpg", { type: "image/jpeg" }),
            initialPhotoPreviewUrl: "blob:preview",
          }
        : {}),
    }),
  );
}

function submitTag(html: string): string {
  const m = html.match(/<button[^>]*data-testid="pin-create-submit"[^>]*>/);
  expect(m, "保存ボタンが見つからない").not.toBeNull();
  return m?.[0] ?? "";
}

describe("PinCreateModal の写真の要否 (入口で決まる)", () => {
  it("写真なしで開いた場合: ラベルは「写真（任意）」で、写真なしのまま保存できる", () => {
    const html = renderModal(false);
    expect(html).toContain("写真（任意）");
    expect(html).not.toContain("写真（必須）");
    expect(submitTag(html)).not.toContain('disabled=""');
  });

  it("写真付きで開いた場合 (撮影経由): 従来どおり「写真（必須）」のまま", () => {
    const html = renderModal(true);
    expect(html).toContain("写真（必須）");
    expect(html).not.toContain("写真（任意）");
    expect(submitTag(html)).not.toContain('disabled=""');
  });
});
