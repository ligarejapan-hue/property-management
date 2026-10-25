"use client";

/**
 * 書類を撮る — 撮った写真の上に紙の四隅を出し、指で角を動かして合わせる。
 * ⚠写真は縦横比のまま(width 100%・height auto)。四隅は写真の画素の座標で持つ(SVG の viewBox を写真の大きさに)。
 */
import { useRef } from "react";
import type { Point, Quad } from "@/lib/doc-scan/geometry";

interface CornerEditorProps {
  imageUrl: string;
  width: number;
  height: number;
  quad: Quad;
  onChange: (quad: Quad) => void;
}

const CORNER_LABELS = ["左上の角", "右上の角", "右下の角", "左下の角"] as const;

export default function CornerEditor({ imageUrl, width, height, quad, onChange }: CornerEditorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragging = useRef<number | null>(null);
  // 指で押さえやすい大きさ(画面で約 22px)を、写真の画素に直した半径。
  const radius = Math.max(width, height) * 0.035;

  const toImagePoint = (clientX: number, clientY: number): Point | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const x = ((clientX - rect.left) / rect.width) * width;
    const y = ((clientY - rect.top) / rect.height) * height;
    return { x: Math.min(width, Math.max(0, x)), y: Math.min(height, Math.max(0, y)) };
  };

  const handleMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const index = dragging.current;
    if (index === null) return;
    const p = toImagePoint(e.clientX, e.clientY);
    if (!p) return;
    const next = [...quad] as Quad;
    next[index] = p;
    onChange(next);
  };

  return (
    <div className="relative w-full">
      {/* eslint-disable-next-line @next/next/no-img-element -- 端末の中だけの blob: の写真 */}
      <img src={imageUrl} alt="撮った写真" className="block h-auto w-full max-w-full select-none rounded-lg" draggable={false} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="absolute inset-0 h-full w-full touch-none"
        onPointerMove={handleMove}
        onPointerUp={() => (dragging.current = null)}
        onPointerCancel={() => (dragging.current = null)}
      >
        <polygon
          points={quad.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="rgba(99,102,241,0.15)"
          stroke="#818cf8"
          strokeWidth={radius * 0.25}
        />
        {quad.map((p, i) => (
          <circle
            key={CORNER_LABELS[i]}
            cx={p.x}
            cy={p.y}
            r={radius}
            fill="#ffffff"
            stroke="#4f46e5"
            strokeWidth={radius * 0.3}
            aria-label={CORNER_LABELS[i]}
            onPointerDown={(e) => {
              dragging.current = i;
              svgRef.current?.setPointerCapture(e.pointerId);
            }}
          />
        ))}
      </svg>
    </div>
  );
}
