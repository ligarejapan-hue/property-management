/**
 * 踏破の「線」（過去に歩いた道筋）を地図に重ねるための、量の抑え方。
 *
 * 【背景】ユーザー指摘 2026-07-29「以前のシステムは線で表示されていた」。
 * 面（マス）の色だけでは、①マスが道より広いので通っていない裏路地まで
 * 塗られる ②点と点の間をつながないので車移動などで虫食いになる、の2つが
 * 起きる。実際に歩いた筋は線でしか出せない。
 *
 * 【問題】線は生の点をそのまま描くので、面の集計と違って点数がそのまま
 * 効く。全期間を引きで開くと数万点になり、屋外のスマホで地図が固まる。
 *
 * 【方針】まず**間引き**（何点かに1点だけ描く）で全体の形を保ったまま減らし、
 * それでも収まらない分だけ**古い巡回から落とす**。線を途中でぶつ切りにする
 * 案は採らない（途切れた線は「そこで引き返した」ように見えて誤読を生む）。
 */

import { describe, expect, it } from "vitest";
import {
  COVERAGE_TRACK_MAX_THIN_STEP,
  COVERAGE_TRACK_POINT_BUDGET,
  COVERAGE_TRACK_SESSION_LIMIT,
  planTrackFetch,
  type TrackSessionCandidate,
} from "@/lib/field-survey-tracks";

const trip = (id: string, pointCount: number): TrackSessionCandidate => ({
  id,
  pointCount,
});

describe("planTrackFetch — 描く線の量を決める", () => {
  it("少なければ間引かず全部そのまま描く", () => {
    const plan = planTrackFetch([trip("a", 100), trip("b", 200)]);
    expect(plan.thinStep).toBe(1);
    expect(plan.sessionIds).toEqual(["a", "b"]);
    expect(plan.droppedTrips).toBe(0);
    expect(plan.truncated).toBe(false);
  });

  it("空でも落ちない", () => {
    const plan = planTrackFetch([]);
    expect(plan.sessionIds).toEqual([]);
    expect(plan.thinStep).toBe(1);
    expect(plan.truncated).toBe(false);
  });

  it("多いときはまず間引く（巡回は落とさない）", () => {
    // 予算のちょうど3倍 → 3点に1点
    const total = COVERAGE_TRACK_POINT_BUDGET * 3;
    const plan = planTrackFetch([trip("a", total)]);
    expect(plan.thinStep).toBe(3);
    expect(plan.sessionIds).toEqual(["a"]);
    expect(plan.droppedTrips).toBe(0);
  });

  it("間引きすぎない（線が道から外れるため上限を持つ）", () => {
    const total = COVERAGE_TRACK_POINT_BUDGET * 1000;
    const plan = planTrackFetch([trip("a", total)]);
    expect(plan.thinStep).toBe(COVERAGE_TRACK_MAX_THIN_STEP);
  });

  it("間引きの上限でも収まらない分は古い巡回から落とす", () => {
    // 呼び出し側は**新しい順**で渡す。落とすのは末尾（古い方）。
    const cap = COVERAGE_TRACK_POINT_BUDGET * COVERAGE_TRACK_MAX_THIN_STEP;
    const each = Math.ceil(cap / 2);
    const plan = planTrackFetch([
      trip("new", each),
      trip("mid", each),
      trip("old", each),
    ]);
    expect(plan.sessionIds[0]).toBe("new");
    expect(plan.sessionIds).not.toContain("old");
    expect(plan.droppedTrips).toBeGreaterThan(0);
    expect(plan.truncated).toBe(true);
  });

  it("一番新しい1本だけは必ず描く（0本にしない）", () => {
    // 1本だけで上限を超えていても、線が1本も出ないよりは間引いて出す。
    const huge = COVERAGE_TRACK_POINT_BUDGET * COVERAGE_TRACK_MAX_THIN_STEP * 10;
    const plan = planTrackFetch([trip("only", huge)]);
    expect(plan.sessionIds).toEqual(["only"]);
    expect(plan.thinStep).toBe(COVERAGE_TRACK_MAX_THIN_STEP);
  });

  it("候補が多すぎる時も本数の上限で頭打ちにする", () => {
    const many = Array.from({ length: COVERAGE_TRACK_SESSION_LIMIT + 25 }, (_, i) =>
      trip(`t${i}`, 1),
    );
    const plan = planTrackFetch(many);
    expect(plan.sessionIds.length).toBeLessThanOrEqual(
      COVERAGE_TRACK_SESSION_LIMIT,
    );
    expect(plan.truncated).toBe(true);
    expect(plan.droppedTrips).toBe(25);
  });

  it("点数が 0 の巡回は数に入れても壊れない", () => {
    const plan = planTrackFetch([trip("a", 0), trip("b", 0)]);
    expect(plan.thinStep).toBe(1);
    expect(plan.sessionIds).toEqual(["a", "b"]);
  });

  it("間引きの歩幅は必ず 1 以上の整数", () => {
    for (const n of [0, 1, 7, 12345, 999999]) {
      const plan = planTrackFetch([trip("a", n)]);
      expect(Number.isInteger(plan.thinStep)).toBe(true);
      expect(plan.thinStep).toBeGreaterThanOrEqual(1);
    }
  });

  it("落とした本数は必ず 0 以上（負の本数を出さない）", () => {
    const plan = planTrackFetch([trip("a", 1)]);
    expect(plan.droppedTrips).toBeGreaterThanOrEqual(0);
  });
});
