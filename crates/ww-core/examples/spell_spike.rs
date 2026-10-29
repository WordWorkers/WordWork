//! Phase 0 spike A: compares spellbook (+ our stemmer) with the spylls results in
//! spike/ref.json. Run: cargo run --release -p ww-core --example spell_spike -- resources/sv spike/ref.json
use std::time::Instant;
use ww_core::language::Dictionaries;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let t = Instant::now();
    let d = Dictionaries::load(std::path::Path::new(&args[1])).unwrap();
    println!("load: {:.2?}", t.elapsed());
    let r: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args[2]).unwrap()).unwrap();
    let words = r["words"].as_object().unwrap();
    let (mut agree, mut fp, mut fn_) = (0, vec![], vec![]);
    let t = Instant::now();
    for (w, v) in words {
        let want = v["ok"].as_bool().unwrap();
        let got = d.check(w);
        if want == got {
            agree += 1
        } else if got {
            fp.push(w.clone())
        } else {
            fn_.push(w.clone())
        }
    }
    println!(
        "check {} words in {:.2?}: agree {}, accepted-only-by-spellbook {:?}, rejected-only-by-spellbook {:?}",
        words.len(),
        t.elapsed(),
        agree,
        fp,
        fn_
    );
    let mut same_first = 0;
    let mut n = 0;
    let mut overlap = 0.0;
    let mut slow = 0.0f64;
    for (w, v) in words {
        let Some(s) = v.get("sugg") else { continue };
        let want: Vec<&str> = s.as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        let t = Instant::now();
        let got = d.suggest(w);
        let el = t.elapsed().as_secs_f64();
        slow = slow.max(el);
        n += 1;
        if want.first().copied() == got.first().map(|x| x.as_str()) {
            same_first += 1
        }
        let inter = want.iter().filter(|x| got.iter().any(|g| g == *x)).count();
        if !want.is_empty() {
            overlap += inter as f64 / want.len() as f64
        }
        println!(
            "  {w:<22} spylls {:>5}s {:?}\n  {:<22} rust  {:>5.2}s {:?}",
            v["t"],
            want,
            "",
            el,
            &got[..got.len().min(6)]
        );
    }
    println!(
        "suggest: {n} words, same first {same_first}, mean overlap {:.0}%, slowest {:.2}s",
        100.0 * overlap / n as f64,
        slow
    );
    let stems = r["stems"].as_object().unwrap();
    let (mut eq, mut sub, mut total, mut miss) = (0, 0, 0, vec![]);
    for (w, s) in stems {
        let want: Vec<&str> = s.as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        if want.is_empty() {
            continue;
        }
        total += 1;
        let got = d.stemmer.stems(w);
        if want.iter().all(|x| got.iter().any(|g| g == x)) {
            if got.len() == want.len() {
                eq += 1
            } else {
                sub += 1
            }
        } else if miss.len() < 25 {
            miss.push(format!("{w}: want {want:?} got {got:?}"))
        }
    }
    println!("stems: {total} words, exact {eq}, superset {sub}, missing {}\n  {}", total - eq - sub, miss.join("\n  "));
    if let Ok(p) = std::env::var("SPIKE_PROBE") {
        for w in p.split(',') {
            println!("probe {w}: check {} stems {:?}", d.check(w), d.stemmer.stems(w));
        }
    }
    let syn = |w: &str| d.stemmer.stems(w).into_iter().filter(|s| d.thesaurus.contains_key(s)).collect::<Vec<_>>();
    for w in ["husen", "sprang", "recensionen", "vackraste", "skrev"] {
        println!("synonym heads {w}: {:?}", syn(w));
    }
}
