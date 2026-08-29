#!/usr/bin/env python3
"""
Generates the Colossal Cave Adventure favicon set: a retro, pixel-art brass
lamp (the game's iconic item) in the site's neon terminal green (#c8f8c8) on
the terminal's dark background (#111512).

The artwork is authored once as a 32x32 pixel grid and then derived, via
nearest-neighbour sampling, into:

  web/favicon.svg          self-contained pixel-grid SVG (crispEdges)
  web/favicon.ico          16/32/64 px multi-resolution ICO (legacy browsers)
  web/favicon-16.png       16x16  PNG
  web/favicon-32.png       32x32  PNG
  web/favicon-64.png       64x64  PNG
  web/apple-touch-icon.png 180x180 PNG

The raster sizes are all integer multiples or divisors of 32 on purpose:
nearest-neighbour sampling at a fractional scale (e.g. 32 -> 48) duplicates
every even row/column, which swells single-pixel spokes into uneven 2px bars.

No third-party libraries are required: PNGs are encoded with the standard
library only (zlib + struct).

Usage: python3 scripts/make-favicon.py
"""

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"

# Palette (matches web/index.html).
BG = (0x11, 0x15, 0x12)  # #111512 - terminal background
GREEN = (0xC8, 0xF8, 0xC8)  # #c8f8c8 - site's neon terminal green

SIZE = 32  # base artwork resolution


def new_grid(size=SIZE):
    """A size x size grid of 0 (background) / 1 (green)."""
    return [[0] * size for _ in range(size)]


def px(g, x, y, v=1):
    n = len(g)
    if 0 <= x < n and 0 <= y < n:
        g[y][x] = v


def hline(g, x1, x2, y, v=1):
    for x in range(x1, x2 + 1):
        px(g, x, y, v)


# Hand-authored 16x16 brass oil lamp (spout rising on the right, round
# handle on the left, knobbed lid, pedestal foot). Upscaled exactly 2x
# onto the 32x32 base grid.
LAMP_16 = [
    "................",
    "................",
    ".......#........",
    ".......#........",
    ".....#####.....#",
    "..#########...##",
    ".#.############.",
    ".##############.",
    ".#############..",
    "..###########...",
    "....########....",
    "......####......",
    ".....######.....",
    "................",
    "................",
    "................",
]


def build_lamp():
    g = new_grid()
    for y, row in enumerate(LAMP_16):
        for x, ch in enumerate(row):
            if ch == "#":
                px(g, x * 2, y * 2, 1)
                px(g, x * 2 + 1, y * 2, 1)
                px(g, x * 2, y * 2 + 1, 1)
                px(g, x * 2 + 1, y * 2 + 1, 1)
    return g


def build_grid():
    return build_lamp()


def scale(grid, new_w, new_h):
    """Nearest-neighbour scale of a 0/1 grid."""
    ow, oh = len(grid[0]), len(grid)
    out = [[0] * new_w for _ in range(new_h)]
    for ny in range(new_h):
        iy = min(int(ny * oh / new_h), oh - 1)
        row_src = grid[iy]
        for nx in range(new_w):
            ix = min(int(nx * ow / new_w), ow - 1)
            out[ny][nx] = row_src[ix]
    return out


def grid_to_png_bytes(grid, w, h):
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type: None
        for x in range(w):
            r, g, b = GREEN if grid[y][x] else BG
            raw += bytes((r, g, b))
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(typ, data):
        return (
            struct.pack(">I", len(data))
            + typ
            + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8-bit, truecolour RGB
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")


def grid_to_ico_bytes(grids):
    """Multi-resolution ICO, one 32-bpp BMP entry per size (full legacy
    compatibility; no PNG compression inside the ICO)."""
    images = []
    for grid, w, h in grids:
        pixels = bytearray()  # BGRA, bottom-up
        for y in range(h - 1, -1, -1):
            for x in range(w):
                r, g, b = GREEN if grid[y][x] else BG
                pixels += bytes((b, g, r, 0xFF))
        mask_row = bytes(((w + 31) // 32) * 4)  # AND mask rows, padded to 32 bit
        and_mask = mask_row * h
        header = struct.pack(
            "<IiiHHIIiiII",
            40,
            w,
            2 * h,
            1,
            32,
            0,
            len(pixels) + len(and_mask),
            0,
            0,
            0,
            0,
        )
        images.append(header + bytes(pixels) + and_mask)

    out = struct.pack("<HHH", 0, 1, len(images))  # ICONDIR: reserved, type, count
    offset = 6 + 16 * len(images)
    for (grid, w, h), image in zip(grids, images):
        out += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(image), offset)
        offset += len(image)
    return out + b"".join(images)


def grid_to_svg(grid, size=SIZE):
    """Self-contained pixel-grid SVG. Each row's run of green pixels becomes a
    single <rect> (run-length), keeping the file small while `crispEdges`
    guarantees the pixels stay sharp at any scale."""
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" '
        'shape-rendering="crispEdges">' % (size, size),
        '  <rect width="%d" height="%d" fill="#%02x%02x%02x"/>' % (size, size, *BG),
    ]
    gx = GREEN
    for y in range(size):
        x = 0
        while x < size:
            if grid[y][x]:
                x0 = x
                while x < size and grid[y][x]:
                    x += 1
                parts.append(
                    '  <rect x="%d" y="%d" width="%d" height="1" '
                    'fill="#%02x%02x%02x"/>' % (x0, y, x - x0, *gx)
                )
            else:
                x += 1
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def print_ascii(grid, size=None):
    size = size or len(grid)
    print("  " + "".join(str(x % 10) for x in range(size)))
    for y in range(size):
        print("%2d" % y, end=" ")
        print("".join("#" if grid[y][x] else "." for x in range(size)))


def main():
    grid = build_grid()
    print("=== base artwork (%dx%d) ===" % (SIZE, SIZE))
    print_ascii(grid)

    # SVG (self-contained, pixel grid, crisp edges).
    (WEB / "favicon.svg").write_text(grid_to_svg(grid), encoding="utf-8")

    # ICO for legacy browsers/tools that cannot deal with SVG favicons.
    ico_grids = [(scale(grid, n, n), n, n) for n in (16, 32, 64)]
    ico = grid_to_ico_bytes(ico_grids)
    (WEB / "favicon.ico").write_bytes(ico)
    print("wrote web/favicon.ico (16/32/64, %d bytes)" % len(ico))

    # PNGs at every size browsers ask for, nearest-neighbour (no blur).
    targets = (
        (16, "favicon-16.png"),
        (32, "favicon-32.png"),
        (64, "favicon-64.png"),
        (180, "apple-touch-icon.png"),
    )
    for n, name in targets:
        scaled = scale(grid, n, n)
        png = grid_to_png_bytes(scaled, n, n)
        (WEB / name).write_bytes(png)
        print("wrote web/%s (%dx%d, %d bytes)" % (name, n, n, len(png)))


if __name__ == "__main__":
    main()
