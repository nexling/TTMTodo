from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "web" / "public"
PUBLIC.mkdir(parents=True, exist_ok=True)

BG = (20, 18, 15, 255)
INK = (232, 165, 75, 255)
PAPER = (243, 234, 216, 255)


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin = size * 0.08
    radius = size * 0.22
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=radius,
        fill=BG,
    )
    # three list lines
    x0, x1 = size * 0.28, size * 0.72
    for i, y_frac in enumerate((0.34, 0.50, 0.66)):
        y = size * y_frac
        thickness = max(2, int(size * 0.045))
        if i == 1:
            # checkmark instead of middle line
            cx, cy = size * 0.30, size * 0.52
            draw.line(
                [(cx, cy), (cx + size * 0.08, cy + size * 0.08), (cx + size * 0.22, cy - size * 0.12)],
                fill=INK,
                width=thickness + 1,
                joint="curve",
            )
            draw.line(
                [(size * 0.52, y), (x1, y)],
                fill=PAPER,
                width=thickness,
            )
        else:
            draw.line([(x0, y), (x1, y)], fill=PAPER, width=thickness)
    return img


def main() -> None:
    for size, name in ((192, "pwa-192.png"), (512, "pwa-512.png"), (180, "apple-touch-icon.png")):
        draw_icon(size).save(PUBLIC / name, "PNG")
    print("wrote icons to", PUBLIC)


if __name__ == "__main__":
    main()
