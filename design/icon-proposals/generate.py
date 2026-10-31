# Five original "ligne claire" portraits of Word Work's author character.
# Each SVG is 1024×1024 with the macOS icon grid (824 px rounded square).
INK = "#1d1a17"
SW = 10  # outline width at 1024 px

def frame(bg, body, bg2=None):
    deco = f'<circle cx="760" cy="270" r="230" fill="{bg2}" opacity=".55"/>' if bg2 else ""
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs><clipPath id="sq"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath></defs>
<g clip-path="url(#sq)">
<rect x="100" y="100" width="824" height="824" fill="{bg}"/>
{deco}
<g stroke="{INK}" stroke-width="{SW}" stroke-linejoin="round" stroke-linecap="round">
{body}
</g></g>
<rect x="100" y="100" width="824" height="824" rx="185" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="2"/>
</svg>'''

def face_front(cx, cy, skin, lips="#c8463a", lashes=True, brows=None, glasses=None, smile=True, wink=False):
    """Oval face, ears, neck drawn by caller. Returns features."""
    ex = 58
    eye_y = cy + 8
    out = []
    # eyes
    if wink:
        out.append(f'<ellipse cx="{cx-ex}" cy="{eye_y}" rx="9" ry="13" fill="{INK}" stroke="none"/>')
        out.append(f'<path d="M{cx+ex-18} {eye_y+2} q18 -12 36 0" fill="none"/>')
    else:
        for s in (-1, 1):
            out.append(f'<ellipse cx="{cx+s*ex}" cy="{eye_y}" rx="9" ry="13" fill="{INK}" stroke="none"/>')
    if lashes:
        for s in (-1, 1):
            x = cx + s*ex
            out.append(f'<path d="M{x-16} {eye_y-14} q16 -12 32 0 M{x+s*16} {eye_y-14} l{s*10} -8" fill="none" stroke-width="7"/>')
    if brows:
        for s in (-1, 1):
            x = cx + s*ex
            out.append(f'<path d="M{x-24} {eye_y-38} q24 -{brows} 48 {-2 if s>0 else 2}" fill="none" stroke-width="8"/>')
    # nose (small hook, typical ligne claire)
    out.append(f'<path d="M{cx+4} {cy+40} q14 22 -6 34" fill="none" stroke-width="8"/>')
    # cheeks
    for s in (-1, 1):
        out.append(f'<ellipse cx="{cx+s*82}" cy="{cy+58}" rx="22" ry="12" fill="#f19a8e" opacity=".55" stroke="none"/>')
    # mouth
    if smile:
        out.append(f'<path d="M{cx-34} {cy+102} q34 26 68 0 q-34 8 -68 0z" fill="{lips}" stroke-width="7"/>')
    else:
        out.append(f'<path d="M{cx-26} {cy+104} q26 -10 52 0 q-26 16 -52 0z" fill="{lips}" stroke-width="7"/>')
    if glasses:
        out.append(glasses)
    return "\n".join(out)

SKIN = "#f6d2b5"

# ---------------------------------------------------------------- 1. Hélène – the bob, cat-eye glasses, pencil
def v1():
    cx, cy = 512, 470
    body = []
    # body: turtleneck sweater
    body.append(f'<path d="M210 940 C230 760 330 700 420 690 L604 690 C694 700 794 760 814 940 Z" fill="#20323f"/>')
    body.append(f'<rect x="452" y="560" width="120" height="150" fill="{SKIN}"/>')
    body.append(f'<path d="M430 640 C430 610 594 610 594 640 L600 712 C560 735 464 735 424 712 Z" fill="#2f4a5c"/>')
    body.append(f'<path d="M440 670 q72 22 144 0 M436 694 q76 24 152 0" fill="none" stroke-width="6"/>')
    # hair back (bob)
    body.append(f'<path d="M318 470 C300 300 400 255 512 255 C624 255 724 300 706 470 C704 540 716 588 742 612 C700 636 650 620 640 590 L384 590 C374 620 324 636 282 612 C308 588 320 540 318 470 Z" fill="#2a211c"/>')
    # ears
    for s in (-1, 1):
        body.append(f'<ellipse cx="{cx+s*152}" cy="{cy+22}" rx="20" ry="30" fill="{SKIN}"/>')
    # pencil tucked behind the right ear (drawn before the face so the ear/face cover its end)
    body.append('<g transform="translate(640 520) rotate(-64)"><rect x="0" y="-13" width="230" height="26" rx="4" fill="#f2c230"/><path d="M230 -13 l34 13 l-34 13 z" fill="#f1d4a8"/><path d="M255 -4 l9 4 l-9 4z" fill="#1d1a17" stroke="none"/></g>')
    body.append(f'<ellipse cx="{cx+152}" cy="{cy+22}" rx="20" ry="30" fill="{SKIN}"/>')
    # face
    body.append(f'<ellipse cx="{cx}" cy="{cy+18}" rx="150" ry="172" fill="{SKIN}"/>')
    # fringe
    body.append(f'<path d="M360 430 C352 330 420 292 512 292 C604 292 672 330 664 430 C600 418 560 400 540 372 C510 404 430 424 360 430 Z" fill="#2a211c"/>')
    body.append(f'<path d="M440 330 q30 -14 70 -10" fill="none" stroke="#5a4a40" stroke-width="7"/>')
    glasses = (f'<path d="M{cx-120} {cy-10} C{cx-110} {cy-30} {cx-30} {cy-30} {cx-18} {cy-6} C{cx-16} {cy+30} {cx-96} {cy+40} {cx-108} {cy+14} L{cx-134} {cy-26} Z" fill="#cfe6ea" fill-opacity=".45"/>'
               f'<path d="M{cx+120} {cy-10} C{cx+110} {cy-30} {cx+30} {cy-30} {cx+18} {cy-6} C{cx+16} {cy+30} {cx+96} {cy+40} {cx+108} {cy+14} L{cx+134} {cy-26} Z" fill="#cfe6ea" fill-opacity=".45"/>'
               f'<path d="M{cx-18} {cy-4} q18 -12 36 0" fill="none"/>')
    body.append(face_front(cx, cy, SKIN, brows=10, glasses=glasses))
    # pencil behind the right ear
    return frame("#2f8f8a", "\n".join(body), "#5fb3a9")

# ---------------------------------------------------------------- 2. Margit – auburn beehive, pearls, fountain pen
def v2():
    cx, cy = 512, 500
    body = []
    body.append(f'<path d="M220 940 C240 790 340 730 430 722 L594 722 C684 730 784 790 804 940 Z" fill="#7a2f3b"/>')
    body.append(f'<path d="M430 722 L512 860 L594 722" fill="#f3ead8"/>')  # blouse collar
    body.append(f'<rect x="458" y="600" width="108" height="130" fill="{SKIN}"/>')
    # pearls
    for i, x in enumerate(range(452, 580, 18)):
        y = 752 - 0.006 * (x - 512) ** 2
        body.append(f'<circle cx="{x}" cy="{y:.0f}" r="9" fill="#fbf6ec" stroke-width="5"/>')
    # beehive: one continuous shape from the crown down past the ears, flipped out at the ends
    body.append('<path d="M392 600 C340 590 330 520 342 440 C330 330 360 180 512 168 C664 180 694 330 682 440 C694 520 684 590 632 600 C660 560 664 500 650 470 L374 470 C360 500 364 560 392 600 Z" fill="#b5502c"/>')
    body.append('<path d="M430 240 q82 -44 164 6 M404 310 q108 -54 216 0" fill="none" stroke="#7d3218" stroke-width="7"/>')
    for s_ in (-1, 1):
        body.append(f'<ellipse cx="{cx+s_*146}" cy="{cy+24}" rx="20" ry="30" fill="{SKIN}"/>')
        body.append(f'<circle cx="{cx+s_*150}" cy="{cy+62}" r="11" fill="#fbf6ec" stroke-width="5"/>')
    body.append(f'<ellipse cx="{cx}" cy="{cy+20}" rx="146" ry="166" fill="{SKIN}"/>')
    # side-swept fringe
    body.append('<path d="M368 470 C366 390 430 352 520 354 C600 356 660 392 656 452 C620 414 560 404 500 418 C450 430 404 452 368 470 Z" fill="#b5502c"/>')
    body.append('<path d="M430 392 q60 -26 130 -14" fill="none" stroke="#7d3218" stroke-width="6"/>')
    body.append(face_front(cx, cy, SKIN, brows=14, lips="#b8323e"))
    return frame("#e3a73a", "\n".join(body), "#f0c565")

# ---------------------------------------------------------------- 3. Simone – beret, curls, striped shirt, notebook
def v3():
    cx, cy = 512, 500
    body = []
    shirt = "M212 940 C232 780 332 722 424 714 L600 714 C692 722 792 780 812 940 Z"
    body.append(f'<clipPath id="shirt"><path d="{shirt}"/></clipPath>')
    body.append(f'<path d="{shirt}" fill="#f4efe4"/>')
    body.append('<g clip-path="url(#shirt)">' + "".join(f'<path d="M200 {y} L824 {y}" stroke="#25446e" stroke-width="16"/>' for y in range(760, 940, 34)) + '</g>')
    body.append(f'<path d="M212 940 C232 780 332 722 424 714 L600 714 C692 722 792 780 812 940" fill="none"/>')
    body.append(f'<rect x="458" y="600" width="108" height="124" fill="{SKIN}"/>')
    # red scarf
    body.append(f'<path d="M424 700 q88 40 176 0 l20 40 q-108 50 -216 0 z" fill="#d23a2e"/>')
    body.append(f'<path d="M560 735 l40 110 l-46 -6 l-20 -96 z" fill="#d23a2e"/>')
    # short curls
    for (x, y, r) in [(372,470,44),(366,540,40),(390,600,34),(652,470,44),(658,540,40),(634,600,34),(400,400,48),(624,400,48)]:
        body.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#4a3123"/>')
    for s in (-1, 1):
        body.append(f'<ellipse cx="{cx+s*146}" cy="{cy+24}" rx="20" ry="30" fill="{SKIN}"/>')
    body.append(f'<ellipse cx="{cx}" cy="{cy+20}" rx="146" ry="166" fill="{SKIN}"/>')
    # curls on forehead
    for (x, y, r) in [(420,380,36),(470,364,34),(520,360,34),(570,368,34),(612,388,32)]:
        body.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#4a3123"/>')
    # beret
    body.append(f'<path d="M352 352 C340 260 470 214 560 226 C660 238 700 300 676 352 C600 330 430 330 352 352 Z" fill="#a81e2c"/>')
    body.append(f'<path d="M520 222 l8 -26 l14 4 z" fill="#a81e2c"/>')
    body.append(face_front(cx, cy, SKIN, brows=12, wink=True))
    return frame("#3a6ea5", "\n".join(body), "#6b9ac9")

# ---------------------------------------------------------------- 4. Ingrid – profile, ponytail and headscarf, typing
def v4():
    body = []
    # typewriter in front
    body.append('<path d="M150 800 L760 800 L800 940 L110 940 Z" fill="#3c6b4b"/>')
    body.append('<rect x="210" y="740" width="500" height="70" rx="18" fill="#4f8a62"/>')
    body.append('<rect x="300" y="610" width="320" height="140" fill="#fbf7ee"/>')
    for y in (650, 680, 710):
        body.append(f'<path d="M330 {y} L{590 if y<710 else 480} {y}" stroke="#9aa3a8" stroke-width="7"/>')
    for x in range(250, 680, 52):
        body.append(f'<circle cx="{x}" cy="860" r="18" fill="#f4efe4" stroke-width="6"/>')
    # shoulder/back (character sits right, facing left)
    body.append(f'<path d="M580 940 C580 820 620 750 690 732 L840 732 C900 760 930 840 940 940 Z" fill="#e8a6a0"/>')
    # neck
    body.append(f'<path d="M626 590 L726 586 L742 744 L640 744 Z" fill="{SKIN}"/>')
    # ponytail
    body.append(f'<path d="M760 420 C860 430 880 560 820 650 C800 600 790 520 740 480 Z" fill="#d9a441"/>')
    # head profile facing left
    body.append(f'''<path d="M690 300 C770 300 800 390 784 470 C774 530 750 580 716 612 L640 624
      C616 626 598 616 596 598 C592 584 600 580 590 572 C580 566 584 558 590 554 C580 548 580 540 588 534
      C572 528 566 514 578 504 L552 486 C546 478 552 470 562 466 L580 432 C582 340 630 300 690 300 Z" fill="{SKIN}"/>''')
    # hair on head (blonde) under scarf
    body.append(f'<path d="M580 410 C580 340 640 300 700 300 C770 302 800 380 778 460 C760 430 740 410 700 404 C660 400 620 410 580 410 Z" fill="#d9a441"/>')
    # headscarf (polka dot) tied at nape
    body.append(f'<path d="M574 400 C590 300 690 270 760 320 C792 344 800 390 790 430 C760 390 690 370 620 384 C600 388 586 394 574 400 Z" fill="#2b5c9e"/>')
    for (x, y) in [(640,330),(700,320),(740,350),(670,365),(610,370),(760,395)]:
        body.append(f'<circle cx="{x}" cy="{y}" r="8" fill="#fbf6ec" stroke="none"/>')
    body.append(f'<path d="M790 430 l46 -10 l-10 40 z M790 430 l40 40 l-46 6 z" fill="#2b5c9e"/>')
    # ear
    body.append(f'<ellipse cx="704" cy="470" rx="18" ry="28" fill="{SKIN}"/>')
    # eye (profile), brow, lashes, lips
    body.append(f'<ellipse cx="616" cy="456" rx="7" ry="11" fill="{INK}" stroke="none"/>')
    body.append(f'<path d="M602 442 q14 -10 30 -2 l10 -8" fill="none" stroke-width="7"/>')
    body.append(f'<path d="M598 420 q18 -10 40 -4" fill="none" stroke-width="8"/>')
    body.append(f'<path d="M584 540 q12 -6 18 4 q-8 10 -18 4" fill="#c8463a" stroke-width="6"/>')
    body.append(f'<ellipse cx="640" cy="520" rx="20" ry="11" fill="#f19a8e" opacity=".55" stroke="none"/>')
    # arm reaching to keys
    body.append(f'<path d="M716 760 C660 780 590 800 540 812 L548 858 C610 846 690 830 742 810 Z" fill="#e8a6a0"/>')
    body.append(f'<path d="M548 812 C520 812 496 822 492 840 C500 856 530 860 552 856 Z" fill="{SKIN}"/>')
    return frame("#efe6d2", "\n".join(body), "#e3d5b5")

# ---------------------------------------------------------------- 5. Agnes – silver chignon, round glasses, quill
def v5():
    cx, cy = 512, 500
    body = []
    body.append(f'<path d="M216 940 C236 784 336 726 428 718 L596 718 C688 726 788 784 808 940 Z" fill="#4d5a3a"/>')
    body.append(f'<path d="M428 718 L470 780 L512 730 L554 780 L596 718" fill="#efe7d4"/>')
    body.append(f'<rect x="458" y="600" width="108" height="126" fill="{SKIN}"/>')
    # chignon (bun) on top
    body.append(f'<ellipse cx="{cx}" cy="292" rx="80" ry="62" fill="#c9c6c0"/>')
    body.append(f'<path d="M470 280 q42 -24 84 0 M466 304 q46 -18 92 0" fill="none" stroke="#8f8b84" stroke-width="7"/>')
    # hair around face, swept back
    body.append(f'<path d="M350 520 C330 380 410 330 512 330 C614 330 694 380 674 520 C650 450 600 420 512 420 C424 420 374 450 350 520 Z" fill="#c9c6c0"/>')
    for s in (-1, 1):
        body.append(f'<ellipse cx="{cx+s*146}" cy="{cy+24}" rx="20" ry="30" fill="{SKIN}"/>')
    body.append(f'<ellipse cx="{cx}" cy="{cy+20}" rx="146" ry="166" fill="{SKIN}"/>')
    body.append(f'<path d="M376 470 C390 400 450 372 512 372 C574 372 634 400 648 470 C600 430 560 420 512 424 C464 420 424 430 376 470 Z" fill="#c9c6c0"/>')
    body.append(f'<path d="M420 420 q40 -26 92 -24 M512 396 q60 -2 100 24" fill="none" stroke="#8f8b84" stroke-width="6"/>')
    glasses = (f'<circle cx="{cx-58}" cy="{cy+8}" r="40" fill="#e9f1f2" fill-opacity=".4"/>'
               f'<circle cx="{cx+58}" cy="{cy+8}" r="40" fill="#e9f1f2" fill-opacity=".4"/>'
               f'<path d="M{cx-18} {cy+2} q18 -12 36 0" fill="none"/>')
    body.append(face_front(cx, cy, SKIN, brows=8, lashes=False, glasses=glasses, lips="#b5544a"))
    # smile lines (older)
    for s in (-1, 1):
        body.append(f'<path d="M{cx+s*58} {cy+86} q{s*12} 14 {s*4} 30" fill="none" stroke-width="5" opacity=".5"/>')
    # quill feather
    body.append(f'<path d="M700 860 C700 760 740 660 820 600 C810 700 770 800 712 862 Z" fill="#f4efe4"/>')
    body.append(f'<path d="M700 870 C730 790 770 700 816 610" fill="none" stroke-width="6"/>')
    return frame("#8a5a9b", "\n".join(body), "#b086bf")

V = {"1-helene": v1, "2-margit": v2, "3-simone": v3, "4-ingrid": v4, "5-agnes": v5}
for k, f in V.items():
    open(f"{k}.svg", "w").write(f())
print("ok")
