#!/usr/bin/env python3
"""从源 .ico 生成 Windows 图标和 macOS iconset。

用法：
    python scripts/make-icons.py                     # 用 icons/source.ico
    python scripts/make-icons.py 路径/到/图标.ico     # 指定源文件，顺便存进 icons/source.ico

为什么不用现成工具：不希望这个仓库依赖 ImageMagick / PIL，所以自己实现了一遍
ICO 解析、PNG 解码与编码、以及双三次插值放大。标准库就能跑。

产出：
    icons/app.ico                 Windows 用（原样保留，已含 9 个尺寸）
    icons/AppIcon.iconset/*.png   macOS 用（iconutil 的输入，10 个文件）
"""
import pathlib
import shutil
import struct
import sys
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"
SOURCE = ICON_DIR / "source.ico"

# macOS iconset 里每个文件名对应的逻辑尺寸
ICONSET = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]


# ---------------------------------------------------------------- PNG 解码

def png_decode(data: bytes):
    """解出 (width, height, RGBA 字节串)。支持 8bit 的 RGB / RGBA / 灰度 / 调色板。"""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG")

    pos = 8
    width = height = depth = color_type = 0
    idat = bytearray()
    palette = None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, depth, color_type, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or interlace:
                raise ValueError(f"暂不支持的 PNG：{depth}bit interlace={interlace}")
        elif ctype == b"PLTE":
            palette = body
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break

    raw = zlib.decompress(bytes(idat))
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    stride = width * channels

    out = bytearray(width * height * channels)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        filt = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        pos += stride
        # PNG 的五种行过滤器
        if filt == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif filt == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif filt == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif filt == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        out[y * stride : (y + 1) * stride] = line
        prev = line

    # 统一转成 RGBA
    rgba = bytearray(width * height * 4)
    if color_type == 6:
        rgba = out
    elif color_type == 2:
        for i in range(width * height):
            rgba[i * 4 : i * 4 + 3] = out[i * 3 : i * 3 + 3]
            rgba[i * 4 + 3] = 0xFF
    elif color_type == 0:
        for i in range(width * height):
            v = out[i]
            rgba[i * 4 : i * 4 + 4] = bytes((v, v, v, 0xFF))
    elif color_type == 4:
        for i in range(width * height):
            v = out[i * 2]
            rgba[i * 4 : i * 4 + 4] = bytes((v, v, v, out[i * 2 + 1]))
    elif color_type == 3:
        for i in range(width * height):
            idx = out[i] * 3
            rgba[i * 4 : i * 4 + 3] = palette[idx : idx + 3]
            rgba[i * 4 + 3] = 0xFF
    return width, height, bytes(rgba)


# ---------------------------------------------------------------- PNG 编码

def png_encode(width: int, height: int, rgba: bytes) -> bytes:
    def chunk(tag: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body))
            + tag
            + body
            + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter: None
        raw += rgba[y * stride : (y + 1) * stride]

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


# ---------------------------------------------------------------- ICO 解析

def ico_entries(path: pathlib.Path):
    data = path.read_bytes()
    _, typ, count = struct.unpack("<HHH", data[:6])
    if typ != 1:
        raise ValueError("不是图标文件")
    entries = []
    for i in range(count):
        off = 6 + i * 16
        w, h, _, _, _, bits, size, img_off = struct.unpack("<BBBBHHII", data[off : off + 16])
        entries.append(
            {
                "w": w or 256,
                "h": h or 256,
                "bits": bits,
                "data": data[img_off : img_off + size],
            }
        )
    return entries


def decode_bmp(entry) -> tuple[int, int, bytes]:
    """ICO 里的 BMP 是 BITMAPINFOHEADER + XOR(BGRA) + AND(1bpp 掩码)，行序自底向上。"""
    d = entry["data"]
    _, width, bi_height, _, bits, _, _ = struct.unpack("<IiiHHII", d[:24])
    height = bi_height // 2  # 图标把 AND 掩码也算进了高度
    if bits != 32:
        raise ValueError(f"只支持 32bpp，这份是 {bits}bpp")

    xor_size = width * height * 4
    xor = d[40 : 40 + xor_size]
    row_bytes = ((width + 31) // 32) * 4
    mask = d[40 + xor_size : 40 + xor_size + row_bytes * height]

    rgba = bytearray(width * height * 4)
    for y in range(height):
        src = height - 1 - y
        for x in range(width):
            si = (src * width + x) * 4
            b, g, r, a = xor[si], xor[si + 1], xor[si + 2], xor[si + 3]
            if mask:
                bit = (mask[src * row_bytes + (x // 8)] >> (7 - x % 8)) & 1
                if bit:
                    a = 0
            di = (y * width + x) * 4
            rgba[di : di + 4] = bytes((r, g, b, a))
    return width, height, bytes(rgba)


def load_entries(path: pathlib.Path):
    """返回 [(宽, 高, RGBA)]，按尺寸升序。"""
    images = []
    for entry in ico_entries(path):
        if entry["data"][:8] == b"\x89PNG\r\n\x1a\n":
            images.append(png_decode(entry["data"]))
        else:
            images.append(decode_bmp(entry))
    images.sort(key=lambda img: img[0])
    return images


# ---------------------------------------------------------------- 缩放

def _cubic(x: float) -> float:
    """双三次插值核（Catmull-Rom，a = -0.5）。"""
    x = abs(x)
    if x < 1:
        return 1.5 * x**3 - 2.5 * x**2 + 1
    if x < 2:
        return -0.5 * x**3 + 2.5 * x**2 - 4 * x + 2
    return 0.0


def resize(src: bytes, sw: int, sh: int, dw: int, dh: int) -> bytes:
    """双三次插值放大/缩小，alpha 做预乘避免边缘发黑。"""
    out = bytearray(dw * dh * 4)
    # 预乘 alpha，否则插值时透明像素的 RGB 会把边缘拉黑
    premul = bytearray(sw * sh * 4)
    for i in range(sw * sh):
        a = src[i * 4 + 3]
        premul[i * 4 + 0] = src[i * 4 + 0] * a // 255
        premul[i * 4 + 1] = src[i * 4 + 1] * a // 255
        premul[i * 4 + 2] = src[i * 4 + 2] * a // 255
        premul[i * 4 + 3] = a

    x_ratio = sw / dw
    y_ratio = sh / dh
    for dy in range(dh):
        sy = (dy + 0.5) * y_ratio - 0.5
        y0 = int(sy)
        for dx in range(dw):
            sx = (dx + 0.5) * x_ratio - 0.5
            x0 = int(sx)
            acc = [0.0, 0.0, 0.0, 0.0]
            for ky in range(-1, 3):
                wy = _cubic(sy - (y0 + ky))
                if wy == 0:
                    continue
                py = min(max(y0 + ky, 0), sh - 1)
                for kx in range(-1, 3):
                    w = wy * _cubic(sx - (x0 + kx))
                    if w == 0:
                        continue
                    px = min(max(x0 + kx, 0), sw - 1)
                    i = (py * sw + px) * 4
                    for c in range(4):
                        acc[c] += premul[i + c] * w
            a = min(max(acc[3], 0.0), 255.0)
            o = (dy * dw + dx) * 4
            if a > 0.5:
                # 反预乘。Catmull-Rom 会有过冲（振铃），所以两边都要夹住。
                for c in range(3):
                    out[o + c] = max(0, min(255, int(acc[c] / a * 255 + 0.5)))
            out[o + 3] = int(a + 0.5)
    return bytes(out)


# ---------------------------------------------------------------- 主流程

def main() -> int:
    if len(sys.argv) > 1:
        src = pathlib.Path(sys.argv[1]).expanduser()
        if not src.exists():
            print(f"找不到源文件：{src}", file=sys.stderr)
            return 1
        ICON_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, SOURCE)
        print(f"已保存源图标 → {SOURCE.relative_to(ROOT)}")
    elif SOURCE.exists():
        src = SOURCE
    else:
        print("没有源图标。用法：python scripts/make-icons.py <图标.ico>", file=sys.stderr)
        return 1

    images = load_entries(src)
    print("源图标含尺寸：" + "、".join(f"{w}x{h}" for w, h, _ in images))

    # Windows：原样用，里面的 9 个尺寸比我们生成的更全
    app_ico = ICON_DIR / "app.ico"
    shutil.copy2(src, app_ico)
    print(f"Windows 图标 → {app_ico.relative_to(ROOT)}")

    # macOS：挑一张最清晰的做基准，缺的大尺寸靠放大补
    base_w, base_h, base = images[-1]
    print(f"以 {base_w}x{base_h} 为基准生成 iconset")

    iconset = ICON_DIR / "AppIcon.iconset"
    iconset.mkdir(parents=True, exist_ok=True)
    for name, size in ICONSET:
        if size == base_w:
            pixels = base
        elif size < base_w:
            # 缩小时优先用源里现成的同尺寸图，避免重采样损失
            exact = next((img for img in images if img[0] == size), None)
            pixels = exact[2] if exact else resize(base, base_w, base_h, size, size)
        else:
            pixels = resize(base, base_w, base_h, size, size)
        (iconset / name).write_bytes(png_encode(size, size, pixels))

    print(f"macOS iconset → {iconset.relative_to(ROOT)}/（{len(ICONSET)} 个文件）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
