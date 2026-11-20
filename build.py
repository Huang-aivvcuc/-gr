#!/usr/bin/env python3
"""把 src/*.src.html 打成真正自包含的单文件页面：
内联 CSS/JS，并把所有 assets/img 引用转成 base64 data URI（JPEG 压缩到长边 ≤1600）。
原图保持不变，压缩只发生在构建产物里。"""
import base64
import io
import re
from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parent
css = (root / "assets" / "site.css").read_text(encoding="utf-8")
js = (root / "assets" / "site.js").read_text(encoding="utf-8")

pairs = [
    ("src/index.src.html", "index.html"),
    ("src/faq.src.html", "faq.html"),
    ("src/products.src.html", "products.html"),
    ("src/stock.src.html", "stock.html"),
    ("src/cases.src.html", "cases.html"),
    ("src/advantage.src.html", "advantage.html"),
    ("src/about.src.html", "about.html"),
    ("src/contact.src.html", "contact.html"),
]

LINK = '<link rel="stylesheet" href="assets/site.css">'
SCRIPT = '<script src="assets/site.js"></script>'

# 按用途分级：小尺寸展示的花色卡不需要高分辨率，逐档降级可大幅减小单文件体积
TIERS = [
    ("product-", 900, 78),    # 花色卡（网格小图）
    ("case-", 1200, 78),      # 工程案例图
    ("marble-", 900, 78),     # 洞石花色卡
]
MAX_DIM = 1600      # 其余（hero/厂区/物流/现货）长边上限
QUALITY = 80        # JPEG 质量
# hero 轮播复用了这两张花色图作全屏背景，不能降到小图档
KEEP_HIGH = {"product-maya-gray.jpg", "product-cappuccino.jpg"}
_cache: dict[str, str] = {}

# 只内联站内相对引用；(?<!/) 排除 og:image 等绝对 URL（https://domain/assets/img/...）
# 爬虫不读 data URI，绝对 URL 必须原样保留
IMG_RE = re.compile(r'(?<![\w/.-])assets/img/[A-Za-z0-9_\-.]+\.(?:jpg|jpeg|png|svg|webp|gif|ico)')


def data_uri(rel: str) -> str:
    """把 workspace 相对路径的图片转成 data URI（JPEG 会缩放+重编码）。"""
    if rel in _cache:
        return _cache[rel]
    p = root / rel
    if not p.is_file():
        raise FileNotFoundError(f"引用了不存在的素材: {rel}")
    suffix = p.suffix.lower()
    if suffix in (".jpg", ".jpeg"):
        name = p.name.lower()
        max_dim, quality = MAX_DIM, QUALITY
        if name not in KEEP_HIGH:
            for prefix, dim, q in TIERS:
                if name.startswith(prefix):
                    max_dim, quality = dim, q
                    break
        im = Image.open(p)
        im.load()
        if im.mode != "RGB":
            im = im.convert("RGB")
        if max(im.size) > max_dim:
            im.thumbnail((max_dim, max_dim), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
        uri = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    elif suffix == ".png":
        mime = "image/png"
        uri = f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode("ascii")
    elif suffix == ".ico":
        uri = "data:image/x-icon;base64," + base64.b64encode(p.read_bytes()).decode("ascii")
    elif suffix == ".svg":
        svg = p.read_text(encoding="utf-8")
        uri = "data:image/svg+xml," + re.sub(r"\s+", " ", svg).strip()
    else:
        uri = "data:image/webp;base64," + base64.b64encode(p.read_bytes()).decode("ascii")
    _cache[rel] = uri
    return uri


def inline_images(html: str) -> str:
    return IMG_RE.sub(lambda m: data_uri(m.group(0)), html)


total_bytes = 0
for src, out in pairs:
    html = (root / src).read_text(encoding="utf-8")
    assert LINK in html, f"{src} 缺少样式占位"
    assert SCRIPT in html, f"{src} 缺少脚本占位"
    html = html.replace(LINK, "<style>\n" + css + "\n</style>")
    html = html.replace(SCRIPT, "<script>\n" + js + "\n</script>")
    n_img = len(set(IMG_RE.findall(html)))
    html = inline_images(html)
    # 内联后不应再有相对引用；绝对 URL（og:image）允许保留 https://.../assets/img/...
    assert not IMG_RE.search(html), f"{out} 仍有未内联的图片引用"
    dest = root / out
    dest.write_text(html, encoding="utf-8")
    size = dest.stat().st_size
    total_bytes += size
    print(f"{out}: {size/1024:.0f} KB（内联 {n_img} 张图）")

print(f"素材缓存: {len(_cache)} 张 · 产物合计 {total_bytes/1024/1024:.1f} MB")
