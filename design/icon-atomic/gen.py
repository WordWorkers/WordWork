"""WW icon proposals: Belgian atomic style (atoomstijl, Expo 58) and Métal Hurlant.
python3 gen.py  → a-atomium.svg … d-orbit.svg (+ *-small.svg for 16–48 px)"""
import math, pathlib
OUT = pathlib.Path(__file__).parent
INK = "#1d1a17"; CREAM = "#f6ecd6"

def star(cx, cy, r1, r2, n, rot=0):
    pts = []
    for i in range(2 * n):
        r = r1 if i % 2 == 0 else r2
        a = math.pi * i / n + math.radians(rot)
        pts.append(f"{cx + r*math.sin(a):.1f},{cy - r*math.cos(a):.1f}")
    return "M" + " L".join(pts) + " Z"

def frame(defs, body, bg):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs><clipPath id="sq"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>{defs}</defs>
<g clip-path="url(#sq)"><rect x="100" y="100" width="824" height="824" fill="{bg}"/>{body}</g>
<rect x="100" y="100" width="824" height="824" rx="185" fill="none" stroke="{INK}" stroke-opacity=".25" stroke-width="4"/>
</svg>'''

# Monoline 50s W (round joins), drawn as stacked strokes: shadow, ink outline, fill.
MW = "M0 0 L62 300 L130 90 L198 300 L260 0"
def mono_w(x, y, rot, fill, w=74, outline=16, shadow=None, sh=(14, 14)):
    t = f'transform="translate({x} {y}) rotate({rot} 130 150)"'
    s = 'fill="none" stroke-linecap="round" stroke-linejoin="round"'
    out = ""
    if shadow:
        out += f'<path d="{MW}" {s} stroke="{shadow}" stroke-width="{w+outline}" transform="translate({x+sh[0]} {y+sh[1]}) rotate({rot} 130 150)"/>'
    out += f'<path d="{MW}" {s} stroke="{INK}" stroke-width="{w+outline}" {t}/>'
    out += f'<path d="{MW}" {s} stroke="{fill}" stroke-width="{w}" {t}/>'
    return out

# Sharp, flared W for the Métal Hurlant variants (wide serifs, pointed vertices).
SW = ("M-20 0 L110 0 L100 22 L132 170 L158 60 L222 60 L248 170 L280 22 L270 0 L400 0 "
      "L376 22 L300 310 L216 310 L190 206 L164 310 L80 310 L4 22 Z")

# ── A: Atomium – teal sky, mustard starburst, orbits, cream monoline WW ─────────
def atomium(small=False):
    TEAL, MUST, CORAL = "#2f8f8a", "#efb53c", "#e0573f"
    body = ""
    if not small:
        body += f'<path d="{star(512,512,560,300,12,7)}" fill="#39a39c"/>'
        body += f'<path d="{star(760,280,150,60,8,0)}" fill="{MUST}" stroke="{INK}" stroke-width="8" stroke-linejoin="round"/>'
        for rot in (-28, 32):
            body += f'<ellipse cx="512" cy="540" rx="400" ry="135" fill="none" stroke="{CREAM}" stroke-width="10" transform="rotate({rot} 512 540)"/>'
        for x, y, r in ((215, 260, 14), (300, 820, 10), (850, 760, 16), (180, 690, 8)):
            body += f'<circle cx="{x}" cy="{y}" r="{r}" fill="{CREAM}"/>'
        body += f'<circle cx="858" cy="512" r="26" fill="{CORAL}" stroke="{INK}" stroke-width="8"/>'
    else:
        body += f'<path d="{star(512,512,560,330,10,0)}" fill="#39a39c"/>'
    sc = 1.08 if small else 0.95
    w, o = (96, 26) if small else (74, 16)
    letters = mono_w(0, 0, -6, CREAM, w, o, None if small else CORAL) + mono_w(268, 18, 5, MUST, w, o, None if small else CORAL)
    body += f'<g transform="translate(512 545) scale({sc}) translate(-264 -165)">{letters}</g>'
    return frame("", body, TEAL)

# ── B: Expo 58 – cream paper, coral boomerang, turquoise/ink WW, sparkles ──────
def expo(small=False):
    CORAL, TURQ, MUST = "#e2604a", "#2f9a94", "#efb53c"
    body = ""
    boomer = "M160 760 C300 380 560 260 900 250 C700 360 560 480 470 640 C400 760 260 860 160 760 Z"
    body += f'<path d="{boomer}" fill="{CORAL}" stroke="{INK}" stroke-width="{18 if small else 10}" stroke-linejoin="round"/>'
    if not small:
        body += f'<path d="M180 330 C260 250 380 220 470 240" fill="none" stroke="{INK}" stroke-width="10" stroke-linecap="round"/>'
        for cx, cy, r in ((790, 700, 70), (250, 250, 44), (840, 470, 34)):
            body += f'<path d="{star(cx,cy,r,r*.22,4,0)}" fill="{MUST}" stroke="{INK}" stroke-width="7" stroke-linejoin="round"/>'
        for cx, cy in ((690, 820), (330, 180), (150, 520)):
            body += f'<circle cx="{cx}" cy="{cy}" r="11" fill="{INK}"/>'
    sc = 1.08 if small else 0.95
    w, o = (96, 26) if small else (74, 16)
    letters = mono_w(0, 0, -6, TURQ, w, o, None if small else INK, (10, 12)) + mono_w(268, 18, 5, CREAM, w, o, None if small else INK, (10, 12))
    body += f'<g transform="translate(512 535) scale({sc}) translate(-264 -165)">{letters}</g>'
    return frame("", body, "#f4e6c8")

# Chrome gradient shared by C and D.
CHROME = '''<linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#eaf6ff"/><stop offset=".38" stop-color="#7fb8e6"/><stop offset=".5" stop-color="#2d4f7a"/>
<stop offset=".53" stop-color="#e9b98a"/><stop offset=".75" stop-color="#9a5a34"/><stop offset="1" stop-color="#f6dcb8"/></linearGradient>'''

def chrome_ww(small):
    sw = 30 if small else 14
    fill = "#dcecf8" if small else "url(#chrome)"  # gradient turns to mud below 48 px
    one = lambda x, y, r: (f'<path d="{SW}" fill="{fill}" stroke="{INK}" stroke-width="{sw}" stroke-linejoin="miter" '
                           f'transform="translate({x} {y}) rotate({r} 190 155)"/>')
    glint = "" if small else (f'<path d="M30 14 L92 14 L84 30 Z" fill="#fff" opacity=".9" transform="rotate(-4 190 155)"/>'
                              f'<path d="{star(306,40,46,7,4,0)}" fill="#fff"/>')
    return one(0, 0, -4) + one(352, 20, 4) + glint

# ── C: Métal Hurlant – Moebius dusk, ringed planet, desert, chrome WW ───────────
def hurlant(small=False):
    defs = CHROME + '''<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b2a6b"/>
<stop offset=".55" stop-color="#c8507a"/><stop offset="1" stop-color="#f5a35a"/></linearGradient>'''
    body = f'<rect x="100" y="100" width="824" height="824" fill="url(#sky)"/>'
    if not small:
        body += f'<circle cx="700" cy="300" r="120" fill="#f6d27a" stroke="{INK}" stroke-width="8"/>'
        body += f'<path d="M600 300 A120 120 0 0 0 820 300" fill="#e9a94e"/>'
        body += f'<ellipse cx="700" cy="300" rx="215" ry="40" fill="none" stroke="{INK}" stroke-width="22" transform="rotate(-16 700 300)"/>'
        body += f'<ellipse cx="700" cy="300" rx="215" ry="40" fill="none" stroke="#fbe7b8" stroke-width="10" transform="rotate(-16 700 300)"/>'
        for x, y in ((220, 230), (330, 170), (180, 400), (520, 190), (880, 520)):
            body += f'<circle cx="{x}" cy="{y}" r="5" fill="#fff"/>'
        body += f'<path d="M100 760 L260 700 L330 735 L470 660 L560 720 L720 690 L924 750 L924 924 L100 924 Z" fill="#7a3550" stroke="{INK}" stroke-width="8"/>'
        body += f'<path d="M100 830 C300 790 600 800 924 820 L924 924 L100 924 Z" fill="#4a2340"/>'
    else:
        body += f'<rect x="100" y="760" width="824" height="200" fill="#5a2a48"/>'
    sc = 1.0 if small else 0.86
    body += f'<g transform="translate(512 {540 if small else 520}) scale({sc}) translate(-371 -170)">{chrome_ww(small)}</g>'
    return frame(defs, body, "#3b2a6b")

# ── D: Orbit – the blend: deep space, atomic orbits + starburst, chrome WW ──────
def orbit(small=False):
    defs = CHROME + '<radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#2f6f86"/><stop offset="1" stop-color="#14203a"/></radialGradient>'
    body = '<rect x="100" y="100" width="824" height="824" fill="url(#glow)"/>'
    if not small:
        body += f'<path d="{star(512,520,470,230,16,0)}" fill="#e2573f" opacity=".9"/>'
        for rot in (-30, 30, 90):
            body += f'<ellipse cx="512" cy="520" rx="390" ry="110" fill="none" stroke="#efb53c" stroke-width="9" transform="rotate({rot} 512 520)"/>'
        for x, y, r in ((200, 220, 6), (840, 230, 9), (230, 820, 7), (820, 820, 5), (500, 160, 5)):
            body += f'<circle cx="{x}" cy="{y}" r="{r}" fill="#f6ecd6"/>'
        body += f'<circle cx="884" cy="430" r="22" fill="#efb53c" stroke="{INK}" stroke-width="7"/>'
    else:
        body += f'<circle cx="512" cy="520" r="330" fill="#e2573f"/>'
    sc = 1.0 if small else 0.86
    body += f'<g transform="translate(512 525) scale({sc}) translate(-371 -170)">{chrome_ww(small)}</g>'
    return frame(defs, body, "#14203a")

for name, fn in (("a-atomium", atomium), ("b-expo58", expo), ("c-hurlant", hurlant), ("d-orbit", orbit)):
    (OUT / f"{name}.svg").write_text(fn())
    (OUT / f"{name}-small.svg").write_text(fn(True))
print("ok")
