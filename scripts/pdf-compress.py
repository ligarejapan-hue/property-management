#!/usr/bin/env python3
"""pdf-compress — 大きすぎる PDF を、見た目と文字を保ったまま上限以下へ縮める。

使い方(アプリの src/lib/pdf-compress/run.ts から呼ばれる):
  python3 pdf-compress.py <入力PDF> <出力PDF> --max-bytes <上限>

標準出力に JSON を1行だけ出す(個人情報・ファイル名は出さない):
  {"ok": true,  "level": "lossless"|"jpeg85"|"jpeg75", "inBytes": N, "outBytes": M, "pages": P}
  {"ok": false, "reason": "too_large"|"encrypted"|"invalid_pdf", "inBytes": N, "bestBytes": M|null}

段階(小さくなったところで止める):
  1. lossless … まったく同じ図版を1つにまとめ、使われていない資源を外し、内部を詰め直す。
  2. jpeg85   … 1 に加え、地図・写真のような色の細かい図版だけを JPEG(画質85)にする。
  3. jpeg75   … 同じく画質75。
  ⚠文字・線・表(ページの描画命令)には手を触れない。透過のある図版・その「型紙」(SMask)・
    小さな図版・色の扱いが特殊な図版は劣化なしのまま残す。
  ⚠入力ファイルには書き込まない。出力は毎回、元の入力から作り直す(段階を重ねて劣化させない)。

実測(2026-10-09・SRE AI査定の報告書 46ページ): 18.8MB → lossless 13.3MB → jpeg85 7.9MB。
全ページの文字が一致・描画の差は最悪ページでも PSNR 43.6dB(目で区別できない)。

⚠ライセンス: pikepdf(MPL-2.0)・Pillow(HPND)。AGPL の MuPDF は使わない。
"""
import argparse
import hashlib
import io
import json
import os
import sys

# 壊れた/悪意ある PDF でメモリを食い尽くさないよう、このプロセスの上限を決める(Linux)。
try:
    import resource

    _LIMIT = 1536 * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (_LIMIT, _LIMIT))
except Exception:  # Windows 等では無い。呼び出し側の時間制限が最後の守り。
    pass

import pikepdf  # noqa: E402
from PIL import Image  # noqa: E402,F401  (pikepdf の画像変換が使う)

LEVELS = (("lossless", None), ("jpeg85", 85), ("jpeg75", 75))
MIN_SIDE = 64          # これより小さい図版は縮めても得が無い(アイコン等)
JPEG_GAIN = 0.9        # JPEG にして 1 割以上小さくならないなら元のまま


def _image_key(obj):
    """同じ図版かどうかの鍵。中身(生のバイト)と、長さ以外の辞書の値の両方で決める。"""
    meta = sorted((str(k), repr(v)) for k, v in obj.items() if k != "/Length")
    return hashlib.sha256(obj.read_raw_bytes() + repr(meta).encode()).hexdigest()


def _dedupe_images(pdf):
    seen = {}
    visited = set()

    def walk(resources):
        xobjects = resources.get("/XObject")
        if not xobjects:
            return
        for name in list(xobjects.keys()):
            o = xobjects[name]
            if not isinstance(o, pikepdf.Stream):
                continue
            sub = o.get("/Subtype")
            if sub == "/Image":
                key = _image_key(o)
                first = seen.setdefault(key, o)
                if first.objgen != o.objgen:
                    xobjects[name] = first
            elif sub == "/Form" and o.get("/Resources") is not None:
                if o.objgen in visited:
                    continue
                visited.add(o.objgen)
                walk(o.Resources)

    for page in pdf.pages:
        if page.get("/Resources") is not None:
            walk(page.Resources)


def _to_jpeg(pdf, quality):
    masks = {
        o.SMask.objgen
        for o in pdf.objects
        if isinstance(o, pikepdf.Stream) and o.get("/SMask") is not None
    }
    for obj in pdf.objects:
        if not (isinstance(obj, pikepdf.Stream) and obj.get("/Subtype") == "/Image"):
            continue
        if obj.objgen in masks:
            continue  # 透過の型紙は劣化させない(縁がにじむ)
        if obj.get("/SMask") is not None or obj.get("/Mask") is not None or obj.get("/ImageMask"):
            continue
        if obj.get("/Decode") is not None:
            continue
        if str(obj.get("/Filter")) != "/FlateDecode":
            continue
        if int(obj.get("/BitsPerComponent", 8)) != 8:
            continue
        if obj.get("/ColorSpace") not in ("/DeviceRGB", "/DeviceGray"):
            continue
        if min(int(obj.get("/Width", 0)), int(obj.get("/Height", 0))) < MIN_SIDE:
            continue
        try:
            im = pikepdf.PdfImage(obj).as_pil_image()
        except Exception:
            continue
        if im.mode not in ("RGB", "L"):
            continue
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=quality, optimize=True)
        if buf.tell() < len(obj.read_raw_bytes()) * JPEG_GAIN:
            obj.write(buf.getvalue(), filter=pikepdf.Name.DCTDecode)
            if "/DecodeParms" in obj:
                del obj["/DecodeParms"]


def _build(src, dst, quality):
    with pikepdf.open(src) as pdf:
        pages = len(pdf.pages)
        _dedupe_images(pdf)
        pdf.remove_unreferenced_resources()
        if quality is not None:
            _to_jpeg(pdf, quality)
        pdf.save(
            dst,
            compress_streams=True,
            recompress_flate=quality is None,
            object_stream_mode=pikepdf.ObjectStreamMode.generate,
        )
    # 作り直した PDF が開けて、ページ数が変わっていないこと。
    with pikepdf.open(dst) as check:
        if len(check.pages) != pages:
            raise RuntimeError("page count changed")
    return pages


def _self_test():
    """反映のときの確認(docs/deploy.md): 試験用の PDF を作り、実際に JPEG 段階まで縮めてみる。

    写真のような図版(600x600・Flate)を4ページに貼った PDF を一時フォルダに作り、
    大きさの 1/3 を上限にして縮める。縮んでページ数が保たれていれば ok。
    """
    import random
    import tempfile
    import zlib

    with tempfile.TemporaryDirectory(prefix="pdfc-selftest-") as d:
        src = os.path.join(d, "in.pdf")
        dst = os.path.join(d, "out.pdf")
        pdf = pikepdf.new()
        images = []
        for seed in (1, 2):
            random.seed(seed)
            rows = bytearray()
            for y in range(600):
                for x in range(600):
                    rows += bytes(((x + seed * 40) % 256, (y * 2) % 256, random.randint(0, 40)))
            s = pikepdf.Stream(pdf, zlib.compress(bytes(rows)))
            s.Type = pikepdf.Name.XObject
            s.Subtype = pikepdf.Name.Image
            s.Width = 600
            s.Height = 600
            s.ColorSpace = pikepdf.Name.DeviceRGB
            s.BitsPerComponent = 8
            s.Filter = pikepdf.Name.FlateDecode
            images.append(s)
        for i in range(4):
            page = pdf.add_blank_page(page_size=(600, 600))
            page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=images[i % 2]))
            page.Contents = pdf.make_stream(b"q 600 0 0 600 0 0 cm /Im0 Do Q")
        pdf.save(src)
        limit = os.path.getsize(src) // 3
        for level, quality in LEVELS:
            pages = _build(src, dst, quality)
            if os.path.getsize(dst) <= limit:
                ok = pages == 4 and level != "lossless"
                print(json.dumps({"selfTest": "ok" if ok else "ng", "level": level,
                                  "pikepdf": pikepdf.__version__}))
                return 0 if ok else 1
        print(json.dumps({"selfTest": "ng", "reason": "too_large", "pikepdf": pikepdf.__version__}))
        return 1


def main():
    if sys.argv[1:] == ["--self-test"]:
        return _self_test()
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--max-bytes", type=int, required=True)
    a = ap.parse_args()

    in_bytes = os.path.getsize(a.src)
    try:
        with pikepdf.open(a.src):
            pass
    except pikepdf.PasswordError:
        print(json.dumps({"ok": False, "reason": "encrypted", "inBytes": in_bytes, "bestBytes": None}))
        return 0
    except pikepdf.PdfError:
        print(json.dumps({"ok": False, "reason": "invalid_pdf", "inBytes": in_bytes, "bestBytes": None}))
        return 0

    best = None
    tmp = a.dst + ".try"
    for level, quality in LEVELS:
        pages = _build(a.src, tmp, quality)
        size = os.path.getsize(tmp)
        best = size if best is None else min(best, size)
        if size <= a.max_bytes:
            os.replace(tmp, a.dst)
            print(json.dumps({"ok": True, "level": level, "inBytes": in_bytes, "outBytes": size, "pages": pages}))
            return 0
    os.remove(tmp)
    print(json.dumps({"ok": False, "reason": "too_large", "inBytes": in_bytes, "bestBytes": best}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # 中身(パス等)は出さず、種類だけ
        print("error=%s" % type(e).__name__, file=sys.stderr)
        sys.exit(1)
