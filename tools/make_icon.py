"""生成插件图标 icon.png（无外部素材，纯 Pillow 绘制）。运行：python tools/make_icon.py"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SIZE = 256
SS = 4  # 超采样倍数，边缘更干净

canvas = Image.new("RGBA", (SIZE * SS, SIZE * SS), (0, 0, 0, 0))
w = SIZE * SS

# 圆角矩形渐变底
grad = Image.new("RGBA", (w, w), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
top, bottom = (124, 102, 255), (96, 74, 240)
for y in range(w):
    t = y / (w - 1)
    gd.line(
        [(0, y), (w, y)],
        fill=(int(top[0] + (bottom[0] - top[0]) * t),
              int(top[1] + (bottom[1] - top[1]) * t),
              int(top[2] + (bottom[2] - top[2]) * t),
              255),
    )

mask = Image.new("L", (w, w), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, w - 1], radius=int(w * 0.26), fill=255)
canvas.paste(grad, (0, 0), mask)


def sparkle(draw, cx, cy, r, fill):
    """四角星：主轴长 r，斜轴 0.22r"""
    s = r * 0.22
    pts = [
        (cx, cy - r), (cx + s, cy - s), (cx + r, cy), (cx + s, cy + s),
        (cx, cy + r), (cx - s, cy + s), (cx - r, cy), (cx - s, cy - s),
    ]
    draw.polygon(pts, fill=fill)


# 柔光层
glow = Image.new("RGBA", (w, w), (0, 0, 0, 0))
sparkle(ImageDraw.Draw(glow), int(w * 0.5), int(w * 0.5), int(w * 0.34), (255, 255, 255, 110))
glow = glow.filter(ImageFilter.GaussianBlur(int(w * 0.035)))
canvas = Image.alpha_composite(canvas, glow)

# 主体星星
fg = ImageDraw.Draw(canvas)
sparkle(fg, int(w * 0.5), int(w * 0.5), int(w * 0.30), (255, 255, 255, 255))

# 右上角小星点
sparkle(fg, int(w * 0.745), int(w * 0.255), int(w * 0.085), (255, 255, 255, 235))

canvas = canvas.resize((SIZE, SIZE), Image.LANCZOS)
out = ROOT / "icon.png"
canvas.save(out)
print("wrote", out, canvas.size)
