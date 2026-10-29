"""Reference results from spylls (the old app's Hunspell engine) for the
spelling parity test: crates/ww-core/tests/fixtures/spylls_reference.json.

    pip install spylls==0.1.7
    python3 tools/spylls_reference.py check   # needs ../word-work next to this repo
    python3 tools/spylls_reference.py stems
    python3 tools/spylls_reference.py sugg
"""
import re, sys, json, glob, time, random
words=set()
for f in glob.glob("../word-work/data/*.md")+glob.glob("../word-work/*.md"):
    for w in re.findall(r"\w+(?:[-'’]\w+)*", open(f,encoding="utf-8").read()):
        if not any(c.isdigit() for c in w) and len(w)<60: words.add(w)
extra="""kulturjournalist kulturjournalisterna sommarstugeägare järnvägsstationen fotbollsmatchens
regeringsförklaringen ordbehandlare ordbehandlaren skrivmaskinsläge Stockholm stockholmare Göteborg
husen hus husets bilarna sprang springer gick gått skrivit skrev skriva barnen barnens
hej hejsan sjukhusvistelse kvällstidningsjournalist tidningsartikel tidningsartiklarna
recensionen recensent krönikan krönikörer stavningskontroll stavningskontrollen
felstavat fellstavat ordbehnadlare kulturjornalist sommmar tyvär nogon nåogn stockhlom
allergi allergier eksem eksemet barnallergi mjölkallergi ålgång ålgången
Ålgång Matallergier ÅLGÅNG Huvudstaden NATO EU-kommissionen e-post""".split()
words=sorted(words|set(extra))
from spylls.hunspell import Dictionary
d=Dictionary.from_files("resources/sv/sv_SE")
stage=sys.argv[1]
out=json.load(open("crates/ww-core/tests/fixtures/spylls_reference.json")) if stage!="check" else {"words":{},"stems":{}}
if stage=="check":
    for w in words: out["words"][w]={"ok":bool(d.lookup(w))}
elif stage=="sugg":
    bad=[w for w in words if not out["words"][w]["ok"]]
    pick=[w for w in extra if w in bad]+random.Random(1).sample([w for w in bad if w not in extra],15)
    for w in pick:
        t=time.time(); s=[]
        for x in d.suggest(w):
            s.append(x)
            if len(s)>=6 or time.time()-t>2.5: break
        out["words"][w]["sugg"]=s; out["words"][w]["t"]=round(time.time()-t,2)
        print(w,s,out["words"][w]["t"],flush=True)
elif stage=="stems":
    ok=[w for w in words if out["words"][w]["ok"] and w.isalpha()]
    pick=random.Random(2).sample(ok,250)+[w for w in extra if out["words"][w]["ok"]]
    t0=time.time()
    for w in pick:
        st=[]
        for form in d.lookuper.good_forms(w):
            e=getattr(form,"in_dictionary",None); s=e.stem if e is not None else getattr(form,"stem",None)
            if s and s not in st: st.append(s)
        out["stems"][w]=st
    print("stems",len(pick),time.time()-t0)
json.dump(out,open("crates/ww-core/tests/fixtures/spylls_reference.json","w"),ensure_ascii=False,indent=0)
