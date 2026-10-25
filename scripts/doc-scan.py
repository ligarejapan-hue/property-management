#!/usr/bin/env python3
"""doc-scan — スマホで撮った書類の画像(1枚=1ページ)を1つの PDF にまとめ、先頭のページの文字を読む。

使い方(アプリの src/lib/doc-scan/run.ts から呼ばれる):
  python3 doc-scan.py <作業フォルダ> <ページ数> [--ocr-pages N]
  作業フォルダの page-000.img 〜 page-NNN.img を順に読み、同じフォルダに
  scan.pdf(まとめた PDF)と ocr.txt(先頭 N ページの読み取り文字)を書く。

標準出力に JSON を1行だけ出す(読み取った文字・ファイル名は出さない):
  {"ok": true, "pages": P, "outBytes": M, "ocrChars": C, "ocr": "done"|"unavailable"|"failed"}
  {"ok": false, "reason": "invalid_image"|"too_many_pages"}

⚠画像は端末で紙の形に直して JPEG にしたもの(EXIF なし)。ここでも**必ず描き直して**保存する
  =位置情報などの記録はどの経路でも PDF に残らない。向きの記録があれば先に直す。
⚠文字の読み取りは Tesseract(日本語)をこのサーバーの中だけで動かす。外部には送らない。
⚠ライセンス: Pillow(HPND)・Tesseract(Apache-2.0)。
"""
import argparse
import json
import os
import subprocess
import sys

try:
    import resource

    _LIMIT = 1536 * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (_LIMIT, _LIMIT))
except Exception:  # Windows 等では無い。呼び出し側の時間制限が最後の守り。
    pass

from PIL import Image, ImageOps  # noqa: E402

MAX_PAGES = 30
MAX_EDGE = 2400            # 端末側の上限(2000)より少し大きい=通常は縮めない
A4_LONG_INCH = 11.69       # 長い辺が A4 の長辺に収まる解像度で置く(印刷・表示の大きさが自然になる)
OCR_TIMEOUT_SEC = 45
Image.MAX_IMAGE_PIXELS = 40_000_000  # 巨大な画像で展開爆発しない


def _load(path):
    with Image.open(path) as im:
        if im.format not in ("JPEG", "PNG", "WEBP"):
            raise ValueError("format")
        im = ImageOps.exif_transpose(im)
        im = im.convert("L") if im.mode in ("L", "LA", "1") else im.convert("RGB")
        if max(im.size) > MAX_EDGE:
            ratio = MAX_EDGE / max(im.size)
            im = im.resize((max(1, round(im.width * ratio)), max(1, round(im.height * ratio))), Image.LANCZOS)
        return im.copy()


def _ocr(path):
    out = subprocess.run(
        ["tesseract", path, "stdout", "-l", "jpn", "--psm", "3"],
        capture_output=True,
        timeout=OCR_TIMEOUT_SEC,
        check=True,
    )
    return out.stdout.decode("utf-8", "replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("pages", type=int)
    ap.add_argument("--ocr-pages", type=int, default=2)
    args = ap.parse_args()

    if args.pages < 1 or args.pages > MAX_PAGES:
        print(json.dumps({"ok": False, "reason": "too_many_pages"}))
        return
    paths = [os.path.join(args.workdir, "page-%03d.img" % i) for i in range(args.pages)]
    try:
        images = [_load(p) for p in paths]
    except Exception:
        print(json.dumps({"ok": False, "reason": "invalid_image"}))
        return

    pdf_path = os.path.join(args.workdir, "scan.pdf")
    first, rest = images[0], images[1:]
    dpi = max(72.0, max(first.size) / A4_LONG_INCH)
    # 描き直して保存する=元の画像の記録(EXIF・位置情報)は持ち込まない。
    first.save(pdf_path, "PDF", save_all=True, append_images=rest, resolution=dpi, quality=85)

    # 読み取りは描き直した画像(PNG)から。先頭の数ページだけ(判別には1〜2ページで足りる)。
    ocr_state = "done"
    texts = []
    for i, im in enumerate(images[: max(0, args.ocr_pages)]):
        tmp = os.path.join(args.workdir, "ocr-%03d.png" % i)
        im.save(tmp, "PNG")
        try:
            texts.append(_ocr(tmp))
        except FileNotFoundError:
            ocr_state = "unavailable"
            break
        except Exception:
            ocr_state = "failed"
            break
    text = "\n".join(texts)
    with open(os.path.join(args.workdir, "ocr.txt"), "w", encoding="utf-8") as f:
        f.write(text)

    chars = sum(1 for ch in text if not ch.isspace())
    print(json.dumps({
        "ok": True,
        "pages": len(images),
        "outBytes": os.path.getsize(pdf_path),
        "ocrChars": chars,
        "ocr": ocr_state,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"ok": False, "reason": "invalid_image"}))
        sys.exit(0)
