/**
 * ピン作成モーダル「種類の引き継ぎ」の SSR 検証。
 *
 * vitest は node 環境のため renderToStaticMarkup で静的描画を検証する。
 * ラジオ操作そのものはソース静的検証 + レビューで担保。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import PinCreateModal from "@/components/field-survey/pin-create-modal";
import type { FieldSurveyPinType } from "@/lib/field-survey-pin-util";

const noop = () => {};

function renderModal(initialPinType?: FieldSurveyPinType): string {
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
      onUseCurrentLocation: noop,
      currentLocationLoading: false,
      currentLocationError: null,
      ...(initialPinType !== undefined ? { initialPinType } : {}),
    }),
  );
}

function radioTag(html: string, value: string): string {
  const m = html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`));
  expect(m, `value="${value}" のラジオが見つからない`).not.toBeNull();
  return m?.[0] ?? "";
}

describe("PinCreateModal の種類初期値", () => {
  it("initialPinType 未指定なら従来どおり candidate が選択済み", () => {
    const html = renderModal();
    expect(radioTag(html, "candidate")).toContain('checked=""');
    expect(radioTag(html, "followup")).not.toContain("checked");
  });

  it("initialPinType=followup なら followup が選択済みで開く (引き継ぎ)", () => {
    const html = renderModal("followup");
    expect(radioTag(html, "followup")).toContain('checked=""');
    expect(radioTag(html, "candidate")).not.toContain("checked");
  });

  it("initialPinType=blocked も同様に反映される", () => {
    const html = renderModal("blocked");
    expect(radioTag(html, "blocked")).toContain('checked=""');
  });
});
