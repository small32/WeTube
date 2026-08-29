#!/usr/bin/env python3
"""把 PNG 转为 icons/source.ico（含 Windows 嵌入所需多尺寸）。

用法：
    python scripts/png-to-source-ico.py 路径/到/图标.png

然后跑 python scripts/make-icons.py 生成 app.ico 与 macOS iconset。
依赖：Pillow（pip install Pillow）。
"""
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"
SOURCE = ICON_DIR / "source.ico"

# Windows 嵌入 + tao::Icon 需要的尺寸。make-icons.py 会基于 source.ico
# 的最大尺寸插值生成 iconset 里更大的 PNG（512/1024）。
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main():
    if len(sys.argv) < 2:
        print("用法: python scripts/png-to-source-ico.py 路径/到/图标.png", file=sys.stderr)
        sys.exit(1)
    src = pathlib.Path(sys.argv[1])
    if not src.exists():
        print(f"找不到 {src}", file=sys.stderr)
        sys.exit(1)

    im = Image.open(src).convert("RGBA")
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    # Pillow 的 ICO sizes 参数会自动从同一图像生成多尺寸 entry。
    im.save(SOURCE, format="ICO", sizes=ICO_SIZES)
    print(f"已生成 {SOURCE}（{len(ICO_SIZES)} 个尺寸，最大 {ICO_SIZES[-1][0]}px）")


if __name__ == "__main__":
    main()
