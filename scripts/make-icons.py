"""Renders the house logo from public/index.html into PNG app icons.

No dependencies (writes PNGs with zlib). Run from the repo root:
    python scripts/make-icons.py
"""
import struct
import zlib

BG = (0xFB, 0xF6, 0xEE)
ACCENT = (0xC8, 0x64, 0x3B)
LEAF = (0x5F, 0x8A, 0x5A)
EDGE = (0xEA, 0xDF, 0xCE)
MUTED = (0x6F, 0x66, 0x5A)

# Same shapes as the SVG (viewBox 0 0 120 110), painted in order.
SHAPES = [
    ("rect", MUTED, (78, 30, 12, 22)),
    ("tri", ACCENT, ((14, 58), (60, 20), (106, 58))),
    ("rect", EDGE, (24, 56, 72, 46)),
    ("rect", ACCENT, (52, 72, 16, 30)),
    ("rect", LEAF, (32, 66, 13, 13)),
    ("rect", LEAF, (75, 66, 13, 13)),
]


def inside(shape, x, y):
    kind, _, g = shape
    if kind == "rect":
        rx, ry, w, h = g
        return rx <= x <= rx + w and ry <= y <= ry + h
    (ax, ay), (bx, by), (cx, cy) = g
    d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
    d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
    d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
    return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))


def render(size, logo_frac):
    # Fit the 120x110 logo into logo_frac of the square, centered.
    scale = size * logo_frac / 120
    ox = (size - 120 * scale) / 2
    oy = (size - 110 * scale) / 2 + 4 * scale
    sub = [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)]
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0]
            for sx, sy in sub:
                x = (px + sx - ox) / scale
                y = (py + sy - oy) / scale
                color = BG
                for s in SHAPES:
                    if inside(s, x, y):
                        color = s[1]
                for i in range(3):
                    acc[i] += color[i]
            row += bytes(c // 4 for c in acc)
        rows.append(bytes(row))
    return png(size, b"".join(rows))


def png(size, raw):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


# Logo at ~62% leaves the safe zone that Android masks and iOS rounds.
for name, size in [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)]:
    with open(f"public/{name}", "wb") as f:
        f.write(render(size, 0.62))
    print("wrote public/" + name)
