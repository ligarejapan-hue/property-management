import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/vendor/opencv/route";
import { OPENCV_URL, OPENCV_VERSION } from "../opencv-loader";

describe("OpenCV.js の配り方", () => {
  it("読み込む URL の版と、入れてある部品の版が同じ(版を上げたら古いものを使い回さない)", () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.dependencies["@techstark/opencv-js"]).toBe(OPENCV_VERSION);
    expect(OPENCV_URL).toBe(`/api/vendor/opencv?v=${OPENCV_VERSION}`);
  });

  it("部品の中身を JavaScript として、長く使い回せる形で返す", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(1_000_000);
    expect(body).toContain("onRuntimeInitialized");
  });
});
