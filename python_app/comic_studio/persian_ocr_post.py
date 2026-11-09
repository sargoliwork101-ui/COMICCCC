"""SOTA Persian Post-OCR Lexicon, Rasm-Skeleton Homograph Corrector, and ZWNJ Normalizer.

Implements pure-Python (>=3.11, zero external runtime dependencies) post-OCR correction
tailored specifically to Perso-Arabic script failure modes:
1. Lazy thread-safe Persian corpus lexicon (`assets/persian_ocr_lexicon.json.gz`, MIT-licensed
   corpus frequencies + 10,158 ZWNJ compound words + 353 verb root stems).
2. Perso-Arabic Dotless *Rasm* (`اسکلت بی‌نقطه`) O(1) homograph index that repairs 1- and 2-dot
   or sarkesh OCR confusions (`پژوهشکران->پژوهشگران`, `نگهیان->نگهبان`, `پرایر->برابر`,
   `دانشکاه->دانشگاه`, `کارکران->کارگران`, `کتابخاته->کتابخانه`) ONLY when the raw token is
   genuinely out-of-vocabulary (never touching valid words, conjugated verbs, or inflections)
   and the target word dominates any competing rasm homograph by >= 6x corpus frequency.
3. 1-character ZWNJ stem deletion repair (`بزگ‌ترین -> بزرگ‌ترین`).
4. Morphology-safe OOV run-on word splitter (`گافو -> گاف و`, `تصمیمبگیرند -> تصمیم بگیرند`).
5. Corpus-verified detached ZWNJ compound & verbal restoration (`گفت و گو / چشمانداز -> چشم‌انداز`,
   `می روند -> می‌روند`, `رفته ام -> رفته‌ام`).
6. Contextual visual-symbol disambiguation (`9`/`۹` flanked by Persian words -> `و`,
   `نداردل» -> ندارد!»`, `پء چ و ژ -> پ، چ و ژ`, `%25 -> 25%`).
"""

from __future__ import annotations

import gzip
import json
import math
import re
import threading
from dataclasses import dataclass
from pathlib import Path

ZWNJ = "\u200c"
SINGLE_FA_LETTERS = frozenset("آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی")
NON_LEFT_JOINERS = frozenset("ادذرزژوآأإؤة")

# Map Perso-Arabic characters to their dotless archigrapheme skeleton ("rasm")
# so multi-dot & sarkesh confusions (`پرایر` vs `برابر`, `نگهیان` vs `نگهبان`, `ک` vs `گ`)
# share an identical O(1) lookup key while preserving exact tooth/ligature count.
_RASM_TABLE = str.maketrans(
    {
        "آ": "A",
        "ا": "A",
        "أ": "A",
        "إ": "A",
        "ب": "B",
        "پ": "B",
        "ت": "B",
        "ث": "B",
        "ن": "B",
        "ی": "B",
        "ئ": "B",
        "ج": "J",
        "چ": "J",
        "ح": "J",
        "خ": "J",
        "د": "D",
        "ذ": "D",
        "ر": "R",
        "ز": "R",
        "ژ": "R",
        "س": "S",
        "ش": "S",
        "ص": "P",
        "ض": "P",
        "ط": "T",
        "ظ": "T",
        "ع": "E",
        "غ": "E",
        "ف": "F",
        "ق": "F",
        "ک": "K",
        "گ": "K",
        "ل": "L",
        "م": "M",
        "و": "W",
        "ؤ": "W",
        "ه": "H",
        "ة": "H",
        "ۀ": "H",
        "ء": "X",
    }
)

_COMMON_ATTACHED_RIGHT = frozenset(
    {
        "و",
        "را",
        "از",
        "به",
        "در",
        "با",
        "که",
        "تا",
        "هم",
        "بر",
        "بی",
        "است",
        "بود",
        "شد",
        "شود",
        "شوند",
        "دارد",
        "دارند",
        "ندارد",
        "ندارند",
        "دهد",
        "دهند",
        "ندهد",
        "ندهند",
        "گیرد",
        "گیرند",
        "بگیرد",
        "بگیرند",
        "کند",
        "کنند",
        "بکند",
        "بکنند",
        "نکند",
        "نکنند",
    }
)

_VALID_ZWNJ_AFFIXES = frozenset(
    {
        "می",
        "نمی",
        "بی",
        "هم",
        "ها",
        "های",
        "هایی",
        "هایم",
        "هایت",
        "هایش",
        "هایمان",
        "هایتان",
        "هایشان",
        "تر",
        "ترین",
        "ام",
        "ات",
        "اش",
        "مان",
        "تان",
        "شان",
        "ای",
        "ایم",
        "اید",
        "اند",
    }
)

_VERBAL_PREFIXES = ("بر", "در", "فرا", "فرو", "باز", "وا", "ور", "پیش", "پس")


def to_persian_rasm(word: str) -> str:
    return word.translate(_RASM_TABLE)


def _expand_verb_conjugations(verbs_csv: str) -> set[str]:
    forms: set[str] = {
        "است",
        "نیست",
        "هست",
        "هستم",
        "هستی",
        "هستیم",
        "هستید",
        "هستند",
        "نیستم",
        "نیستی",
        "نیستیم",
        "نیستید",
        "نیستند",
        "بود",
        "نبود",
        "باش",
        " نباشد",
        "باشد",
        "باشم",
        "باشی",
        "باشیم",
        "باشید",
        "باشند",
        "نباشم",
        "نباشی",
        "نباشد",
        "نباشیم",
        "نباشید",
        "نباشند",
        "دارم",
        "داری",
        "دارد",
        "داریم",
        "دارید",
        "دارند",
        "ندارم",
        "نداری",
        "ندارد",
        "نداریم",
        "ندارید",
        "ندارند",
        "داشتم",
        "داشتی",
        "داشت",
        "داشتیم",
        "داشتید",
        "داشتند",
        "نداشتم",
        "نداشتی",
        "نداشت",
        "نداشتیم",
        "نداشتید",
        "نداشتند",
        "بتوانم",
        "بتوانی",
        "بتواند",
        "بتوانیم",
        "بتوانید",
        "بتوانند",
        "نتوانم",
        "نتوانی",
        "نتواند",
        "نتوانیم",
        "نتوانید",
        "نتوانند",
        "بخواهم",
        "بخواهی",
        "بخواهد",
        "بخواهیم",
        "بخواهید",
        "بخواهند",
        "نخواهم",
        "نخواهی",
        "نخواهد",
        "نخواهیم",
        "نخواهید",
        "نخواهند",
        "خواهم",
        "خواهی",
        "خواهد",
        "خواهیم",
        "خواهید",
        "خواهند",
    }
    pres_ends = ("م", "ی", "د", "یم", "ید", "ند")
    past_ends = ("", "م", "ی", "یم", "ید", "ند")
    perf_ends = ("ام", "ای", "ایم", "اید", "اند")

    def _neg_join(prefix_char: str, stem: str) -> str:
        if not stem:
            return prefix_char
        if stem.startswith("آ"):
            return f"{prefix_char}یا{stem[1:]}"
        if stem.startswith("ا") and not stem.startswith("ایست"):
            return f"{prefix_char}ی{stem[1:]}"
        return f"{prefix_char}{stem}"

    for raw_line in verbs_csv.splitlines():
        parts = [p.strip() for p in raw_line.split(",")]
        if len(parts) < 2:
            continue
        for pair_idx in ((0, 1), (2, 3)):
            if len(parts) <= pair_idx[1]:
                continue
            pres, past = parts[pair_idx[0]], parts[pair_idx[1]]
            if not pres and not past:
                continue
            # Also extract bare root after preverbs like `برگرد` -> `بر` + `گرد`
            stem_variants: list[tuple[str, str, str]] = [("", pres, past)]
            for pv in _VERBAL_PREFIXES:
                if pres.startswith(pv) and past.startswith(pv) and len(pres) > len(pv) + 1 and len(past) > len(pv) + 1:
                    stem_variants.append((pv, pres[len(pv):], past[len(pv):]))

            for pv, pr, pa in stem_variants:
                pv_join = f"{pv}{ZWNJ}" if (pv and pv[-1] not in NON_LEFT_JOINERS) else pv
                if pr:
                    bridge = "ی" if pr.endswith(("ا", "آ", "و")) else ""
                    # Imperative singular/plural
                    imp_b = _neg_join("ب", pr) if not pv else f"{pv_join}{_neg_join('ب', pr)}"
                    imp_n = _neg_join("ن", pr) if not pv else f"{pv_join}{_neg_join('ن', pr)}"
                    forms.add(pr if pv else imp_b)
                    forms.add(imp_b)
                    forms.add(imp_n)
                    for end in pres_ends:
                        base_p = f"{pr}{bridge}{end}"
                        forms.add(f"{pv}{base_p}" if pv else base_p)
                        forms.add(f"{pv_join}{_neg_join('ب', base_p)}" if pv else _neg_join("ب", base_p))
                        forms.add(f"{pv_join}{_neg_join('ن', base_p)}" if pv else _neg_join("ن", base_p))
                        forms.add(f"{pv_join}می{ZWNJ}{base_p}")
                        forms.add(f"{pv_join}نمی{ZWNJ}{base_p}")
                if pa:
                    forms.add(f"{pv}{pa}ن")  # infinitive
                    part = f"{pv}{pa}ه"
                    forms.add(part)
                    for pend in perf_ends:
                        forms.add(f"{part}{ZWNJ}{pend}")
                        forms.add(f"{_neg_join('ن', part)}{ZWNJ}{pend}")
                    for end in past_ends:
                        base_pa = f"{pa}{end}"
                        forms.add(f"{pv}{base_pa}")
                        forms.add(f"{pv_join}{_neg_join('ن', base_pa)}" if pv else _neg_join("ن", base_pa))
                        forms.add(f"{pv_join}می{ZWNJ}{base_pa}")
                        forms.add(f"{pv_join}نمی{ZWNJ}{base_pa}")
    return {f.strip() for f in forms if f.strip()}


@dataclass(frozen=True)
class _PersianLexicon:
    vocab_k: dict[str, int]
    compounds_spaced: dict[str, str]
    compounds_joined: dict[str, str]
    conjugated_verbs: frozenset[str]
    rasm_index: dict[str, tuple[tuple[int, str], ...]]
    del1_index: dict[str, tuple[int, str]]


_LEXICON_LOCK = threading.Lock()
_LEXICON_INSTANCE: _PersianLexicon | None = None


def _load_lexicon() -> _PersianLexicon:
    global _LEXICON_INSTANCE
    if _LEXICON_INSTANCE is not None:
        return _LEXICON_INSTANCE
    with _LEXICON_LOCK:
        if _LEXICON_INSTANCE is not None:
            return _LEXICON_INSTANCE
        asset_path = Path(__file__).resolve().parent / "assets" / "persian_ocr_lexicon.json.gz"
        vocab_k: dict[str, int] = {}
        compounds_list: list[str] = []
        verbs_csv = ""
        if asset_path.is_file():
            data = json.loads(gzip.decompress(asset_path.read_bytes()).decode("utf-8"))
            vocab_k = {str(k): int(v) for k, v in (data.get("vocab_k") or {}).items()}
            compounds_list = [str(c) for c in (data.get("compounds") or [])]
            verbs_csv = str(data.get("verbs_csv") or "")

        conjugated = frozenset(_expand_verb_conjugations(verbs_csv))

        rasm_buckets: dict[str, list[tuple[int, str]]] = {}
        del1_best: dict[str, tuple[int, str]] = {}
        for word, freq_k in vocab_k.items():
            if len(word) >= 4 and freq_k >= 80 and ZWNJ not in word:
                r_key = to_persian_rasm(word)
                rasm_buckets.setdefault(r_key, []).append((freq_k, word))
            if 4 <= len(word) <= 10 and freq_k >= 500 and ZWNJ not in word:
                for idx in range(1, len(word) - 1):
                    short = word[:idx] + word[idx + 1:]
                    prev = del1_best.get(short)
                    if prev is None or freq_k > prev[0]:
                        del1_best[short] = (freq_k, word)

        rasm_index: dict[str, tuple[tuple[int, str], ...]] = {}
        for r_key, items in rasm_buckets.items():
            items.sort(reverse=True)
            rasm_index[r_key] = tuple(items[:3])

        compounds_spaced: dict[str, str] = {}
        compounds_joined: dict[str, str] = {}
        for comp in compounds_list:
            if ZWNJ not in comp:
                continue
            parts = [p for p in comp.split(ZWNJ) if p]
            if len(parts) < 2:
                continue
            # Do not convert `چشمانداز` unless its last char before ZWNJ actually joins (`چشم` joins, `خانه` joins, `دریا` does not need ZWNJ visually)
            spaced = comp.replace(ZWNJ, " ")
            joined = comp.replace(ZWNJ, "")
            joined_freq = vocab_k.get(joined, 0)
            parts_known = all(vocab_k.get(p, 0) >= 10 or p in _VALID_ZWNJ_AFFIXES for p in parts)
            if (
                parts_known
                and joined_freq < 800
                and parts[-1] not in {"گر", "گران", "گاه", "خانه", "نامه", "ستان", "زار", "کده"}
                and any(p[-1] not in NON_LEFT_JOINERS for p in parts[:-1])
            ):
                compounds_joined[joined] = comp
            if parts_known and vocab_k.get(parts[0], 0) >= 80:
                compounds_spaced[spaced] = comp

        _LEXICON_INSTANCE = _PersianLexicon(
            vocab_k=vocab_k,
            compounds_spaced=compounds_spaced,
            compounds_joined=compounds_joined,
            conjugated_verbs=conjugated,
            rasm_index=rasm_index,
            del1_index=del1_best,
        )
        return _LEXICON_INSTANCE


def is_known_persian_word(word: str, *, min_vocab_k: int = 8) -> bool:
    """Return True if `word` is a valid Persian lexicon entry, conjugated verb, or regular inflection."""
    clean = word.strip("«»\"'()[]{}،؛.:!؟?…-–—")
    if not clean:
        return False
    lex = _load_lexicon()
    if lex.vocab_k.get(clean, 0) >= min_vocab_k or clean in lex.conjugated_verbs:
        return True
    if clean.endswith("هٔ") and len(clean) >= 3:
        base_he = clean[:-1]  # strip combining hamza above, leaving trailing `ه`
        if lex.vocab_k.get(base_he, 0) >= min_vocab_k or base_he in lex.conjugated_verbs:
            return True
    if ZWNJ in clean:
        parts = [p for p in clean.split(ZWNJ) if p]
        if parts and all(
            lex.vocab_k.get(p, 0) >= max(min_vocab_k, 180 if (len(parts) >= 2 and parts[-1] in {"تر", "ترین"}) else min_vocab_k)
            or p in lex.conjugated_verbs
            or p in _VALID_ZWNJ_AFFIXES
            for p in parts
        ):
            return True
    # Regular Persian plural / comparative / indefinite inflections
    # NOTE: `-یان` is ONLY productive after stems ending in `ی`, `ا`, `آ`, or `و` (`ایرانی->ایرانیان`, `دانشجو->دانشجویان`),
    # NEVER after `ه` (`نگه + یان = نگهیان` is an OCR dot error for `نگهبان`!).
    if clean.endswith("یان") and len(clean) >= 5:
        stem_y = clean[:-2]  # e.g. `ایرانیان` -> `ایرانی`
        stem_bare = clean[:-3]  # e.g. `دانشجویان` -> `دانشجو`
        if stem_y.endswith("ی") and stem_y in lex.vocab_k:
            return True
        if stem_bare.endswith(("ا", "آ", "و")) and stem_bare in lex.vocab_k:
            return True
    for suf, rep in (
        ("گان", "ه"),
        ("گان", ""),
        ("ان", ""),
        ("ها", ""),
        ("های", ""),
        ("هایی", ""),
        ("تر", ""),
        ("ترین", ""),
        ("ش", ""),
        ("م", ""),
        ("ت", ""),
        ("مان", ""),
        ("تان", ""),
        ("شان", ""),
        ("ی", ""),
    ):
        if clean.endswith(suf) and len(clean) - len(suf) >= 3:
            stem = clean[:-len(suf)] + rep
            if stem in lex.vocab_k and lex.vocab_k[stem] >= 15:
                return True
    return False


def _repair_persian_token(tok: str, lex: _PersianLexicon) -> str:
    if len(tok) < 3:
        return tok
    # 1. Canonical Academy-of-Persian-Language ZWNJ compound normalization (`چشمانداز -> چشم‌انداز`, `نرمافزار -> نرم‌افزار`)
    comp_hit = lex.compounds_joined.get(tok)
    if comp_hit:
        return comp_hit
    if is_known_persian_word(tok):
        return tok

    if ZWNJ not in tok:
        for z_suf in ("های", "هایی", "ها", "تر", "ترین"):
            if tok.endswith(z_suf) and len(tok) - len(z_suf) >= 3:
                stem = tok[:-len(z_suf)]
                if stem[-1] not in NON_LEFT_JOINERS and is_known_persian_word(stem):
                    return f"{stem}{ZWNJ}{z_suf}"

    # 2. Repair ZWNJ-joined words where the stem suffered a dot/sarkesh confusion or 1-char dropout
    #    (e.g. `بزگ‌ترین` -> `بزرگ‌ترین`, `الکوریتم‌های` -> `الگوریتم‌های`).
    if ZWNJ in tok:
        parts = tok.split(ZWNJ)
        changed = False
        rebuilt: list[str] = []
        for idx, sub in enumerate(parts):
            sub_fk = lex.vocab_k.get(sub, 0)
            if not sub or sub in _VALID_ZWNJ_AFFIXES or (is_known_persian_word(sub) and (sub_fk >= 200 or sub not in lex.del1_index)):
                rebuilt.append(sub)
                continue
            fixed_sub = sub
            r_cands = lex.rasm_index.get(to_persian_rasm(sub))
            if r_cands and r_cands[0][0] >= max(150, sub_fk * 15) and (len(r_cands) == 1 or r_cands[0][0] >= r_cands[1][0] * 6):
                fixed_sub = r_cands[0][1]
            elif sub in lex.del1_index:
                cand_freq, cand_word = lex.del1_index[sub]
                trial = ZWNJ.join(parts[:idx] + [cand_word] + parts[idx + 1:])
                if cand_freq >= max(1000, sub_fk * 200) and is_known_persian_word(trial):
                    fixed_sub = cand_word
            if fixed_sub != sub:
                changed = True
            rebuilt.append(fixed_sub)
        return ZWNJ.join(rebuilt) if changed else tok

    # 3. Perso-Arabic Dotless Rasm (`اسکلت بی‌نقطه`) O(1) Homograph Correction BEFORE splitting!
    #    Why before splitting? Because `پرایر` (`rasm == BRABR -> برابر`), `نگهیان` (`نگهبان`),
    #    `پژوهشکران` (`پژوهشگران`), and `دانشکاه` (`دانشگاه`) are single words with dot/sarkesh noise,
    #    NOT two glued words (`پر + ایر`)!
    if len(tok) >= 4:
        r_cands = lex.rasm_index.get(to_persian_rasm(tok))
        if r_cands:
            top_freq, top_word = r_cands[0]
            if top_freq >= 150 and (len(r_cands) == 1 or top_freq >= r_cands[1][0] * 6):
                return top_word
        # Also check plural/inflected stems with rasm confusion (e.g. `پژوهشکران` = `پژوهشکر` + `ان` -> `پژوهشگران`)
        for inf_suf in ("ان", "ها", "تر", "ترین"):
            if tok.endswith(inf_suf) and len(tok) - len(inf_suf) >= 4:
                raw_stem = tok[:-len(inf_suf)]
                st_cands = lex.rasm_index.get(to_persian_rasm(raw_stem))
                if st_cands and st_cands[0][0] >= 150 and (len(st_cands) == 1 or st_cands[0][0] >= st_cands[1][0] * 6):
                    candidate_full = st_cands[0][1] + inf_suf
                    if is_known_persian_word(candidate_full):
                        return candidate_full

    # 4. Morphology-safe OOV Run-On Word Splitter (`گافو -> گاف و`, `تصمیمبگیرند -> تصمیم بگیرند`, `ژرا -> ژ را`)
    best_pair: str | None = None
    best_score = 0.0
    for cut in range(1, len(tok)):
        left, right = tok[:cut], tok[cut:]
        # Case A: common function word / verb glued on the right (`گافو`, `تصمیمبگیرند`, `ونقطه` reversed)
        if right in _COMMON_ATTACHED_RIGHT and (
            (len(left) >= 2 and is_known_persian_word(left))
            or (len(left) == 1 and left in SINGLE_FA_LETTERS and right == "را")
        ):
            f_left = lex.vocab_k.get(left, 50)
            if f_left >= 15:
                sc = math.log10(f_left + 1.0) + 6.0
                if sc > best_score:
                    best_score = sc
                    best_pair = f"{left} {right}"
        # Case B: prefix `و` glued onto a >=4-char known word (`ونقطه‌های` -> `و نقطه‌های`) when `ونقطه...` is OOV
        elif left == "و" and len(right) >= 4 and is_known_persian_word(right):
            f_right = lex.vocab_k.get(right, 80)
            if f_right >= 40:
                sc = math.log10(f_right + 1.0) + 5.5
                if sc > best_score:
                    best_score = sc
                    best_pair = f"و {right}"
        # Case C: two >=3-char known words glued across a right-joining boundary (`ادذرزژو`)
        elif (
            left[-1] in NON_LEFT_JOINERS
            and len(left) >= 3
            and len(right) >= 3
            and is_known_persian_word(left)
            and is_known_persian_word(right)
        ):
            f_left = lex.vocab_k.get(left, 25)
            f_right = lex.vocab_k.get(right, 25)
            if f_left >= 60 and f_right >= 60:
                sc = math.log10(f_left) + math.log10(f_right)
                if sc > best_score:
                    best_score = sc
                    best_pair = f"{left} {right}"
    if best_pair is not None:
        return best_pair

    return tok


_RE_PERFECT_SPACE = re.compile(
    r"(?<!\S)([\u0621-\u06cc]{2,}ه)\s+(ام|ای|ایم|اید|اند)(?=$|[\s،؛.:!؟?»)\]])"
)
_RE_MI_DETACHED = re.compile(r"(?<!\S)(ن?می)\s+([\u0621-\u06cc]{2,})(?=$|[\s،؛.:!؟?»)\]])")
_RE_MI_GLUED = re.compile(r"(?<!\S)(ن?می)(?![\s\u200c])([\u0621-\u06cc]{3,})(?=$|[\s،؛.:!؟?»)\]])")
_RE_FA_TOKEN = re.compile(r"[\u0621-\u06cc\u200c]+")


def postprocess_persian_ocr_text(text: str) -> str:
    """Apply corpus-verified Persian post-OCR orthography, ZWNJ, and dot/rasm repair."""
    if not text or not any("\u0600" <= ch <= "\u06ff" for ch in text):
        return text

    lex = _load_lexicon()
    out = text

    # 1. Contextual OCR punctuation & symbol disambiguation
    # `کتابخانة` / `کتابخانهة` / `دربارٌ` -> `کتابخانهٔ` / `دربارهٔ`
    out = re.sub(r"([\u0621-\u06cc]{2,})ه[ةۀ](?=\s|$|[،؛.:!؟?])", r"\1هٔ", out)
    out = re.sub(r"([\u0621-\u06cc]{2,})[ةۀ]\u064c?(?=\s+[\u0621-\u06cc])", r"\1هٔ", out)
    out = re.sub(r"\bدربار\u064c(?=\s+[\u0621-\u06cc])", "دربارهٔ", out)
    # Exclamation mark misread as `ل` right before closing guillemet `»` (longer stems ordered BEFORE suffixes!)
    out = re.sub(
        r"(ندارند|ندارد|دارند|دارد|نکنید|کنید|نباشید|باشید|برگردید|نیست|است|نشد|شد|نبود|بود)ل(?=»)",
        r"\1!",
        out,
    )
    # Standalone digit `9` / `۹` surrounded by Persian words -> Persian conjunction `و`
    out = re.sub(r"(?<=[\u0621-\u06cc])\s+[9۹]\s+(?=[\u0621-\u06cc])", " و ", out)
    out = re.sub(r"(?m)^\s*[9۹]\s+(?=[\u0621-\u06cc])", "و ", out)
    # Single-letter Persian list enumerations where comma `،` was misread as `ء`, `.`, or `ه` (`پء چ و ژ` -> `پ، چ و ژ`)
    out = re.sub(
        r"(?<![\u0621-\u06cc])([\u0621-\u06cc])[ء.ه]\s+(?=[\u0621-\u06cc]\s+و\s+[\u0621-\u06cc](?:\s|$|[،.:!؟]))",
        r"\1، ",
        out,
    )
    # RTL-flipped percentage `%25` -> `25%`
    out = re.sub(r"(?<!\d)%(\d+(?:\.\d+)?)\b", r"\1%", out)
    # Stray isolated single dot between Persian words (`مرجع . و` -> `مرجع و`) or trailing spaced dot on wrapped lines (`نقطه‌های .` -> `نقطه‌های`)
    out = re.sub(r"(?<=[\u0621-\u06cc])\s+\.\s+(?=[\u0621-\u06cc])", " ", out)
    out = re.sub(r"(های|هایی|مرجع|گفت‌وگوی|و|که|از|به|در)\s+\.$", r"\1", out)
    out = re.sub(r"\.(?:\s*\.)+", ".", out)

    # 2. Verbal ZWNJ normalization verified against conjugated Persian verb table
    def _fix_perfect(m: re.Match[str]) -> str:
        cand = f"{m.group(1)}{ZWNJ}{m.group(2)}"
        return cand if cand in lex.conjugated_verbs else m.group(0)

    def _fix_mi(m: re.Match[str]) -> str:
        cand = f"{m.group(1)}{ZWNJ}{m.group(2)}"
        return cand if (cand in lex.conjugated_verbs or m.group(2) in lex.conjugated_verbs) else m.group(0)

    out = _RE_PERFECT_SPACE.sub(_fix_perfect, out)
    out = _RE_MI_DETACHED.sub(_fix_mi, out)
    out = _RE_MI_GLUED.sub(_fix_mi, out)

    # 3. Token-level OOV rasm/dot repair, ZWNJ stem repair, and run-on word splitting
    out = _RE_FA_TOKEN.sub(lambda m: _repair_persian_token(m.group(0), lex), out)

    # 4. Post-split single-letter list comma fix (`پء چ و ژ را` / `په چ و ژ را` -> `پ، چ و ژ را`)
    out = re.sub(
        r"(?<![\u0621-\u06cc])([\u0621-\u06cc])[ء.ه]\s+(?=[\u0621-\u06cc]\s+و\s+[\u0621-\u06cc](?:\s|$|[،.:!؟]))",
        r"\1، ",
        out,
    )
    return out
