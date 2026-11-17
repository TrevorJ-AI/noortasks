#!/usr/bin/env python3
"""Generate NoorTasks adaptive icons, legacy launcher icons, and splash assets."""

from pathlib import Path
from PIL import Image, ImageDraw

RES_DIR = Path(__file__).resolve().parent.parent / "android" / "app" / "src" / "main" / "res"

BG = (0xE9, 0xB2, 0x2E, 255)       # #e9b22e bright amber
FG = (0x12, 0x12, 0x10, 255)       # #121210 house near-black
WHITE = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def draw_n_mark(draw: ImageDraw.ImageDraw, cx: float, cy: float, size: float, color: tuple[int, int, int, int]) -> None:
    """Draw a clean geometric 'N' mark centered at (cx, cy) inside a box of side `size`."""
    half = size / 2.0
    left = cx - half * 0.78
    right = cx + half * 0.78
    top = cy - half * 0.88
    bottom = cy + half * 0.88
    stroke = max(2.0, size * 0.19)

    # Left vertical bar
    draw.rounded_rectangle([left, top, left + stroke, bottom], radius=stroke * 0.28, fill=color)
    # Right vertical bar
    draw.rounded_rectangle([right - stroke, top, right, bottom], radius=stroke * 0.28, fill=color)
    # Diagonal bar connecting top-left inner corner to bottom-right inner corner
    x1, y1 = left + stroke * 0.55, top + stroke * 0.15
    x2, y2 = right - stroke * 0.55, bottom - stroke * 0.15
    dx = x2 - x1
    dy = y2 - y1
    length = (dx * dx + dy * dy) ** 0.5
    nx, ny = -dy / length * (stroke * 0.48), dx / length * (stroke * 0.48)
    poly = [
        (left, top + stroke * 0.08),
        (left + stroke * 0.95, top + stroke * 0.08),
        (right, bottom - stroke * 0.08),
        (right - stroke * 0.95, bottom - stroke * 0.08),
    ]
    # Use crisp thick diagonal aligned between stem centers
    poly = [
        (x1 - nx * 0.95, y1),
        (x1 + nx * 0.95, y1),
        (x2 + nx * 0.95, y2),
        (x2 - nx * 0.95, y2),
    ]
    draw.polygon(poly, fill=color)


def render_supersampled(w: int, h: int, fn) -> Image.Image:
    scale = 4
    img = Image.new("RGBA", (w * scale, h * scale), TRANSPARENT)
    draw = ImageDraw.Draw(img)
    fn(draw, w * scale, h * scale)
    return img.resize((w, h), Image.Resampling.LANCZOS)


def make_adaptive_foreground(size: int, color: tuple[int, int, int, int]) -> Image.Image:
    def paint(draw: ImageDraw.ImageDraw, w: int, h: int) -> None:
        # Adaptive icon safe zone is ~66/108; keep mark inside ~48/108 of canvas
        draw_n_mark(draw, w / 2.0, h / 2.0, w * 0.50, color)
    return render_supersampled(size, size, paint)


def make_square_icon(size: int) -> Image.Image:
    def paint(draw: ImageDraw.ImageDraw, w: int, h: int) -> None:
        pad = w * 0.06
        draw.rounded_rectangle([pad, pad, w - pad, h - pad], radius=w * 0.22, fill=BG)
        draw_n_mark(draw, w / 2.0, h / 2.0, w * 0.62, FG)
    return render_supersampled(size, size, paint)


def make_round_icon(size: int) -> Image.Image:
    def paint(draw: ImageDraw.ImageDraw, w: int, h: int) -> None:
        pad = w * 0.04
        draw.ellipse([pad, pad, w - pad, h - pad], fill=BG)
        draw_n_mark(draw, w / 2.0, h / 2.0, w * 0.60, FG)
    return render_supersampled(size, size, paint)


def make_splash(w: int, h: int) -> Image.Image:
    img = Image.new("RGBA", (w, h), BG)
    mark_size = int(min(w, h) * 0.22)
    mark = render_supersampled(mark_size, mark_size, lambda d, mw, mh: draw_n_mark(d, mw / 2.0, mh / 2.0, mw * 0.85, FG))
    img.alpha_composite(mark, ((w - mark_size) // 2, (h - mark_size) // 2))
    return img


def main() -> None:
    densities = {
        "mdpi": (48, 108),
        "hdpi": (72, 162),
        "xhdpi": (96, 216),
        "xxhdpi": (144, 324),
        "xxxhdpi": (192, 432),
    }
    for name, (legacy_sz, fg_sz) in densities.items():
        d = RES_DIR / f"mipmap-{name}"
        d.mkdir(parents=True, exist_ok=True)
        make_square_icon(legacy_sz).save(d / "ic_launcher.png")
        make_round_icon(legacy_sz).save(d / "ic_launcher_round.png")
        make_adaptive_foreground(fg_sz, FG).save(d / "ic_launcher_foreground.png")
        make_adaptive_foreground(fg_sz, WHITE).save(d / "ic_launcher_monochrome.png")

    splash_sizes = {
        "drawable": (480, 480),
        "drawable-port-mdpi": (320, 480),
        "drawable-port-hdpi": (480, 800),
        "drawable-port-xhdpi": (720, 1280),
        "drawable-port-xxhdpi": (960, 1600),
        "drawable-port-xxxhdpi": (1280, 1920),
        "drawable-land-mdpi": (480, 320),
        "drawable-land-hdpi": (800, 480),
        "drawable-land-xhdpi": (1280, 720),
        "drawable-land-xxhdpi": (1600, 960),
        "drawable-land-xxxhdpi": (1920, 1280),
    }
    for folder, (w, h) in splash_sizes.items():
        d = RES_DIR / folder
        d.mkdir(parents=True, exist_ok=True)
        make_splash(w, h).save(d / "splash.png")

    print("Generated NoorTasks icons and splash images.")


if __name__ == "__main__":
    main()
