/**
 * 広告用の公開ページ(GET /lp/<公開名>)の読み込み(設計 2026-10-20 §1)。
 *  - 公開ゲート(SALE_DM_LP_PUBLIC_ENABLED)・公開名の規則・削除済みでない・「使う」・文章あり、をすべて満たすときだけページ。
 *  - 物件を差し込まない(所在・種別は null=一般形)。宛先が無いので配信停止・電話タップの計測も無い。
 *  - 設定は loadSaleDmPublicPageConfig(描画に要る列だけ・課金APIキーは読まない)。
 */
import { loadSaleDmPublicPageConfig } from "./config-store";
import { buildLpRenderInput, hasRenderableLpVariant, type LpSourceRows } from "./lp-render-input";
import { renderLpPage } from "./lp-page";
import { DEFAULT_PRIVACY_TEXT } from "./privacy-text";
import { normalizePublicSlug, readAdParams, buildPublicLpHeaders, publicLpPath } from "./lp-public";

export interface PublicLpScenarioRow {
  id: string;
  name: string;
  lpHeadline: string | null;
  lpLead: string | null;
  lpBodyText: string | null;
  lpFaqJson: unknown;
  media: LpSourceRows["media"];
}

export interface PublicLpClientLike {
  dmScenario: {
    findFirst: (args: {
      where: { publicSlug: string; deletedAt: null; active: true };
      select: {
        id: true; name: true; lpHeadline: true; lpLead: true; lpBodyText: true; lpFaqJson: true;
        media: { select: { slot: true; heading: true; figureKind: true; asset: { select: { publicId: true; width: true; height: true; deletedAt: true } } }; orderBy: { sortOrder: "asc" } };
      };
    }) => Promise<PublicLpScenarioRow | null>;
  };
}

export type PublicLpPage =
  | { kind: "none" }
  | { kind: "page"; html: string; headers: Record<string, string>; scenarioId: string; scenarioName: string };

export async function loadPublicLpPage(
  client: PublicLpClientLike,
  rawSlug: string,
  query: (key: string) => string | null,
): Promise<PublicLpPage> {
  const cfg = await loadSaleDmPublicPageConfig();
  if (!cfg.lpPublicEnabled) return { kind: "none" };
  const slug = normalizePublicSlug(rawSlug);
  if (slug === null || slug === "invalid") return { kind: "none" };

  const s = await client.dmScenario.findFirst({
    where: { publicSlug: slug, deletedAt: null, active: true },
    select: {
      id: true, name: true, lpHeadline: true, lpLead: true, lpBodyText: true, lpFaqJson: true,
      media: {
        select: { slot: true, heading: true, figureKind: true, asset: { select: { publicId: true, width: true, height: true, deletedAt: true } } },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  if (!s) return { kind: "none" };
  // フォームを出す条件は DM 用と同じ関数(hasRenderableLpVariant)=見出しと本文の両方が空白以外。
  if (!hasRenderableLpVariant({ headline: s.lpHeadline, bodyText: s.lpBodyText })) return { kind: "none" };
  const variant = { headline: s.lpHeadline ?? "", bodyText: s.lpBodyText ?? "" };

  const base = (cfg.trackingBaseUrl ?? "").replace(/\/+$/, "");
  const path = publicLpPath(slug);
  const hero = s.media.find((m) => m.slot === "hero")?.asset;
  const heroImage = hero && !hero.deletedAt ? hero : null;
  const input = buildLpRenderInput(
    {
      variant: { headline: variant.headline, lead: s.lpLead, bodyText: variant.bodyText, faqJson: s.lpFaqJson },
      media: s.media,
      property: { address: null, propertyType: null },
      company: { senderName: cfg.senderName, senderContact: cfg.senderContact },
    },
    {
      mode: "public",
      unsubscribeUrl: null,
      phoneTapToken: null,
      form: { action: `${path}/inquiry`, privacyText: cfg.privacyText ?? DEFAULT_PRIVACY_TEXT, disabled: false },
      public: {
        adParams: readAdParams(query),
        google: cfg.google,
        og: { url: `${base}${path}`, imageUrl: heroImage ? `${base}/lp-assets/${heroImage.publicId}` : null },
      },
    },
  );
  return { kind: "page", html: renderLpPage(input), headers: buildPublicLpHeaders(cfg.google), scenarioId: s.id, scenarioName: s.name };
}
