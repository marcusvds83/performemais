#!/usr/bin/env python3
"""
Gerador de logo profissional para a Performe+ Fiscal Cloud.

Gera um PNG RGBA de alta resolucao com:
  - Um "P+" dentro de um circulo com gradiente verde -> azul (accent Performe)
  - Wordmark "Performe+" em negrito
  - Subtitulo "FISCAL CLOUD" em texto espaado

Uso:
  python3 scripts/gen-logo.py [output_path] [--width N]

Saida default: assets/logo-performe.png (transparente, ~512x160)
"""

import sys
import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# --- Config ---
OUT_DEFAULT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'logo-performe.png')

# Cores da paleta Performe+
COLOR_BG = (0, 0, 0, 0)                # transparente
COLOR_GREEN = (16, 185, 129, 255)      # #10B981 accent verde
COLOR_GREEN_DK = (5, 150, 105, 255)    # #059669
COLOR_BLUE = (59, 130, 246, 255)       # #3B82F6 info blue
COLOR_WHITE = (241, 245, 249, 255)     # #F1F5F9 text primary
COLOR_MUTED = (148, 163, 184, 255)     # #94A3B8 text secondary


def find_font(bold=True, size_candidates=None):
    """Tenta carregar uma fonte sans-serif decente do sistema."""
    candidates = []
    if bold:
        candidates = [
            '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
            '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
            '/usr/share/fonts/opentype/urw-base35/NimbusSans-Bold.otf',
        ]
    else:
        candidates = [
            '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
            '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
        ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size_candidates or 48)
            except Exception:
                continue
    return ImageFont.load_default()


def lerp_color(c1, c2, t):
    """Interpolacao linear entre duas cores RGBA."""
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(4))


def draw_gradient_circle(draw, cx, cy, r, c_inner, c_outer):
    """Desenha um circulo com gradiente radial (centro -> borda)."""
    # Usamos uma imagem temporaria em alta resolucao para suavizar
    size = int(r * 2) + 4
    tmp = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    tdraw = ImageDraw.Draw(tmp)
    # Desenha circulos concentricos do centro para a borda
    steps = max(60, int(r))
    for i in range(steps, 0, -1):
        t = 1.0 - (i / steps)  # 0 no centro, 1 na borda
        color = lerp_color(c_inner, c_outer, t)
        r_i = (r * i) / steps
        tdraw.ellipse(
            (size / 2 - r_i, size / 2 - r_i, size / 2 + r_i, size / 2 + r_i),
            fill=color,
        )
    return tmp


def make_logo(width=640, height=200, transparent=True):
    """Cria a imagem final da logo."""
    img = Image.new('RGBA', (width, height), COLOR_BG if transparent else (10, 14, 26, 255))
    draw = ImageDraw.Draw(img)

    # --- Marcador "P+" em circulo com gradiente ---
    mark_radius = height * 0.36
    mark_cx = height * 0.55
    mark_cy = height / 2

    # Halo/glow sutil atras do circulo
    glow_img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_img)
    glow_draw.ellipse(
        (mark_cx - mark_radius * 1.25, mark_cy - mark_radius * 1.25,
         mark_cx + mark_radius * 1.25, mark_cy + mark_radius * 1.25),
        fill=(16, 185, 129, 40),
    )
    glow_img = glow_img.filter(ImageFilter.GaussianBlur(radius=12))
    img = Image.alpha_composite(img, glow_img)
    draw = ImageDraw.Draw(img)

    # Circulo com gradiente verde -> azul (do centro para a borda)
    circle_img = draw_gradient_circle(
        None, mark_cx, mark_cy, mark_radius,
        COLOR_GREEN, COLOR_BLUE
    )
    # Cola o circulo na imagem principal
    cx_off = int(mark_cx - circle_img.width / 2)
    cy_off = int(mark_cy - circle_img.height / 2)
    img.paste(circle_img, (cx_off, cy_off), circle_img)
    draw = ImageDraw.Draw(img)

    # Borda sutil ao redor do circulo
    draw.ellipse(
        (mark_cx - mark_radius, mark_cy - mark_radius,
         mark_cx + mark_radius, mark_cy + mark_radius),
        outline=(255, 255, 255, 60),
        width=2,
    )

    # Texto "P+" dentro do circulo
    font_mark = find_font(bold=True, size_candidates=int(mark_radius * 1.05))
    mark_text = 'P+'
    # Centraliza o texto
    try:
        bbox = draw.textbbox((0, 0), mark_text, font=font_mark)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        tx = mark_cx - tw / 2 - bbox[0]
        ty = mark_cy - th / 2 - bbox[1] - th * 0.05
    except Exception:
        tw, th = font_mark.getsize(mark_text)
        tx = mark_cx - tw / 2
        ty = mark_cy - th / 2

    # Sombra do texto (sutil)
    shadow_offset = 1
    draw.text((tx + shadow_offset, ty + shadow_offset), mark_text, font=font_mark, fill=(0, 0, 0, 80))
    # Texto branco
    draw.text((tx, ty), mark_text, font=font_mark, fill=COLOR_WHITE)

    # --- Wordmark "Performe+" ---
    font_word_size = int(height * 0.32)
    font_word = find_font(bold=True, size_candidates=font_word_size)
    word_text = 'Performe'
    plus_text = '+'

    # Mede a largura do wordmark
    try:
        bbox_w = draw.textbbox((0, 0), word_text, font=font_word)
        w_w = bbox_w[2] - bbox_w[0]
        w_h = bbox_w[3] - bbox_w[1]
        w_x = bbox_w[0]
    except Exception:
        w_w, w_h = font_word.getsize(word_text)
        w_x = 0

    try:
        bbox_p = draw.textbbox((0, 0), plus_text, font=font_word)
        p_w = bbox_p[2] - bbox_p[0]
        p_h = bbox_p[3] - bbox_p[1]
        p_x = bbox_p[0]
    except Exception:
        p_w, p_h = font_word.getsize(plus_text)
        p_x = 0

    word_x = mark_cx + mark_radius + 22
    word_y = height / 2 - w_h / 2 - bbox_w[1] - 6

    # Sombra do wordmark
    draw.text((word_x + 1, word_y + 1), word_text, font=font_word, fill=(0, 0, 0, 100))
    # Texto branco
    draw.text((word_x, word_y), word_text, font=font_word, fill=COLOR_WHITE)

    # "+" em verde accent
    plus_x = word_x + w_w - w_x
    draw.text((plus_x + 1, word_y + 1), plus_text, font=font_word, fill=(0, 0, 0, 100))
    draw.text((plus_x, word_y), plus_text, font=font_word, fill=COLOR_GREEN)

    # --- Subtitulo "FISCAL CLOUD" ---
    font_sub_size = int(height * 0.12)
    font_sub = find_font(bold=True, size_candidates=font_sub_size)
    sub_text = 'F I S C A L   C L O U D'
    try:
        bbox_s = draw.textbbox((0, 0), sub_text, font=font_sub)
        s_w = bbox_s[2] - bbox_s[0]
        s_h = bbox_s[3] - bbox_s[1]
        s_x_top = bbox_s[0]
    except Exception:
        s_w, s_h = font_sub.getsize(sub_text)
        s_x_top = 0

    sub_y = word_y + w_h + 6
    # Linha decorativa antes do subtitulo (accent)
    line_y = sub_y + s_h / 2
    line_x1 = word_x
    line_x2 = word_x + 14
    draw.line((line_x1, line_y, line_x2, line_y), fill=COLOR_GREEN, width=2)

    sub_x = line_x2 + 8
    draw.text((sub_x, sub_y), sub_text, font=font_sub, fill=COLOR_MUTED)

    return img


def main():
    out_path = OUT_DEFAULT
    if len(sys.argv) > 1 and not sys.argv[1].startswith('--'):
        out_path = sys.argv[1]
    width = 640
    height = 200
    for i, arg in enumerate(sys.argv):
        if arg == '--width' and i + 1 < len(sys.argv):
            width = int(sys.argv[i + 1])
            height = int(width * 0.3125)

    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    # Gera em alta resolucao e depois redimensiona com antialiasing
    hi_width = width * 2
    hi_height = height * 2
    img = make_logo(hi_width, hi_height, transparent=True)
    img = img.resize((width, height), Image.LANCZOS)

    img.save(out_path, 'PNG', optimize=True)
    print('[gen-logo] Logo salva em: ' + out_path)
    print('[gen-logo] Tamanho: %dx%d, %d bytes' % (
        img.width, img.height, os.path.getsize(out_path)
    ))


if __name__ == '__main__':
    main()
