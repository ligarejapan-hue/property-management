import { describe, expect, it } from "vitest";

import {
  GRAY_STOPS,
  buildExportCss,
  buildGrayScale,
  buildRadiusScale,
  DEFAULT_TUNER_STATE,
  type TunerState,
} from "@/components/dev/theme-tuner/theme-tokens";

describe("buildGrayScale", () => {
  it("returns the app's exact stone baseline at defaults (shift 0, scale 1)", () => {
    const scale = buildGrayScale(0, 1);
    expect(scale).toHaveLength(11);
    // 値は globals.css の @theme と完全一致でなければならない
    expect(scale[0]).toBe("oklch(98.5% 0.001 106.423)");
    expect(scale[1]).toBe("oklch(97% 0.001 106.424)");
    expect(scale[10]).toBe("oklch(14.7% 0.004 49.25)");
  });

  it("adds the hue shift to every stop's hue", () => {
    const scale = buildGrayScale(10, 1);
    expect(scale[0]).toBe("oklch(98.5% 0.001 116.423)");
  });

  it("multiplies each stop's chroma by the chroma scale", () => {
    const scale = buildGrayScale(0, 2);
    expect(scale[0]).toBe("oklch(98.5% 0.002 106.423)");
  });

  it("clamps chroma at zero (never negative)", () => {
    const scale = buildGrayScale(0, 0);
    expect(scale[0]).toBe("oklch(98.5% 0 106.423)");
  });

  it("wraps hue into [0,360)", () => {
    const scale = buildGrayScale(360, 1);
    expect(scale[0]).toBe("oklch(98.5% 0.001 106.423)");
  });
});

describe("GRAY_STOPS", () => {
  it("lists the 11 Tailwind gray stops", () => {
    expect(GRAY_STOPS).toEqual([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]);
  });
});

describe("buildRadiusScale", () => {
  it("returns the Tailwind v4 radius defaults at multiplier 1", () => {
    const r = buildRadiusScale(1);
    expect(r.md).toBe(0.375);
    expect(r.xs).toBe(0.125);
    expect(r["3xl"]).toBe(1.5);
  });

  it("scales every radius token by the multiplier", () => {
    const r = buildRadiusScale(2);
    expect(r.md).toBe(0.75);
    expect(r.lg).toBe(1);
  });
});

describe("buildExportCss", () => {
  const state: TunerState = {
    ...DEFAULT_TUNER_STATE,
    light: { bg: "#fafafa", fg: "#101010" },
  };

  it("emits the light :root colors", () => {
    const css = buildExportCss(state);
    expect(css).toContain("--background: #fafafa;");
    expect(css).toContain("--foreground: #101010;");
  });

  it("emits the @theme gray scale", () => {
    const css = buildExportCss(state);
    expect(css).toContain("@theme");
    expect(css).toContain("--color-gray-50: oklch(98.5% 0.001 106.423);");
    expect(css).toContain("--color-gray-950:");
  });

  it("emits the dark-mode media block", () => {
    const css = buildExportCss(state);
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(`--background: ${DEFAULT_TUNER_STATE.dark.bg};`);
  });

  it("emits spacing and radius tokens", () => {
    const css = buildExportCss(state);
    expect(css).toContain("--spacing: 0.25rem;");
    expect(css).toContain("--radius-md: 0.375rem;");
  });
});
