"""Offline language and script detection.

This is a lightweight heuristic, not a statistical model. It is used for:
  * /api/detect,
  * picking a source language for MyMemory (which has no auto-detect),
  * spotting romanized Urdu/Hindi ("kia hal hai") so the UI can offer to treat it as Urdu.

Non-Latin scripts are identified by Unicode block (very reliable); Latin-script text
is scored against small stop-word lists plus language-specific diacritics.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass


@dataclass(frozen=True)
class Detection:
    language: str | None  # code from app.languages, or None when unknown
    confidence: float  # 0.0 – 1.0
    script: str  # "Latin", "Arabic", "Devanagari", … or "Unknown"
    romanized: bool = False  # Latin-script Urdu/Hindi


_SCRIPTS: tuple[tuple[str, tuple[tuple[int, int], ...]], ...] = (
    ("Arabic", ((0x0600, 0x06FF), (0x0750, 0x077F), (0x08A0, 0x08FF), (0xFB50, 0xFDFF), (0xFE70, 0xFEFF))),
    ("Devanagari", ((0x0900, 0x097F),)),
    ("Bengali", ((0x0980, 0x09FF),)),
    ("Gurmukhi", ((0x0A00, 0x0A7F),)),
    ("Tamil", ((0x0B80, 0x0BFF),)),
    ("Greek", ((0x0370, 0x03FF), (0x1F00, 0x1FFF))),
    ("Cyrillic", ((0x0400, 0x052F),)),
    ("Hangul", ((0x1100, 0x11FF), (0x3130, 0x318F), (0xAC00, 0xD7AF))),
    ("Kana", ((0x3040, 0x30FF),)),
    ("Han", ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF))),
    ("Hebrew", ((0x0590, 0x05FF),)),
    ("Latin", ((0x0041, 0x005A), (0x0061, 0x007A), (0x00C0, 0x024F), (0x1E00, 0x1EFF))),
)

# Script -> (language, confidence) when the script alone identifies the language.
_SCRIPT_LANG = {
    "Devanagari": ("hi", 0.85),
    "Bengali": ("bn", 0.9),
    "Gurmukhi": ("pa", 0.95),
    "Tamil": ("ta", 0.95),
    "Greek": ("el", 0.95),
    "Hangul": ("ko", 0.95),
}

_URDU_LETTERS = set("ٹڈڑںےۓہۃھ")
_PERSIAN_LETTERS = set("پچژگکی")  # Persian keheh/yeh; Arabic uses ك / ي instead
_UKRAINIAN_LETTERS = set("іїєґІЇЄҐ")

_STOPWORDS: dict[str, frozenset[str]] = {
    lang: frozenset(words.split())
    for lang, words in {
        "en": "the be to of and a in that have i it for not on with he as you do at this but his by from they we "
        "her she or an will my one all would there their what so up out if about who get which go me is are was "
        "were how hello hi good thank thanks please yes your can has had been am very",
        "es": "el la los las de que y en un una es por para con no se lo como más pero sus le ya este sí porque "
        "esta cuando muy sin sobre también hay donde yo hola gracias buenos días cómo estás está",
        "fr": "le la les de des du un une et est en que qui pas pour sur avec dans ce cette il elle nous vous ils "
        "sont au aux je tu ne mais où bonjour merci comment allez très oui",
        "de": "der die das und ist nicht ein eine ich du er sie es wir ihr sind mit auf für von zu den dem des im "
        "auch wie was guten tag danke bitte ja nein hallo",
        "it": "il lo la gli le di che e è un una per non sono con come mi ti ciao grazie buongiorno anche questo "
        "questa del della sei siamo ho",
        "pt": "o a os as de do da dos das que e é um uma não para com por como mais eu você obrigado obrigada olá "
        "bom dia está são muito também isso",
        "nl": "de het een en is van ik je niet dat die op te met zijn voor er maar ook wat hoe hallo dank "
        "goedemorgen we",
        "sv": "och det att i en är som på för med han hon jag du inte ett av till har var hej tack god morgon vi",
        "pl": "i w nie na to jest się że z do jak co ale tak dzień dobry dziękuję cześć jestem czy",
        "tr": "ve bir bu da de için ne ile mi çok ben sen o var yok değil gibi merhaba teşekkür ederim nasılsın "
        "günaydın evet hayır",
        "id": "dan yang di ini itu dengan untuk tidak dari dalam akan pada juga saya kamu apa ada selamat pagi "
        "terima kasih bagaimana kabar",
        "vi": "và là của có không được những một các cho người này với tôi bạn chào cảm ơn",
    }.items()
}

_DIACRITICS: dict[str, tuple[re.Pattern[str], float]] = {
    "vi": (re.compile(r"[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]"), 3.0),
    "pl": (re.compile(r"[ąęłńśźż]"), 2.0),
    "tr": (re.compile(r"[ğış]"), 2.0),
    "es": (re.compile(r"[ñ¿¡]"), 2.0),
    "pt": (re.compile(r"[ãõ]"), 2.0),
    "sv": (re.compile(r"[å]"), 2.0),
    "de": (re.compile(r"[ßäöü]"), 1.5),
    "fr": (re.compile(r"[èêëàâîïôûœç]"), 1.0),
}

# Common romanized Urdu/Hindi words. Words that are also common in English or
# other languages count for half ("weak") so "main road" isn't flagged.
_ROMAN_URDU_STRONG = frozenset(
    """kya kia hai hain hal haal kaise kaisay kaisa kesay kese kesy mujhe mujhay mujhko tum tumhara tumhari aap
    mera meri mere tera teri tere nahi nahin nhi haan acha accha achha theek thik thek bohat bahut bohot pani
    chahiye chahye chahta chahti karna karo raha rahi rahe gaya gayi hoon kahan kyun kyon jaana aana khana
    shukriya bhai yaar abhi phir sath saath baat kuch bhi toh hum humara aaj kal subah raat kitna kitne apna
    apni wala wali walay dekho suno batao samajh pata""".split()
)
_ROMAN_URDU_WEAK = frozenset("main mein se ko ka ki ke ye yeh wo woh ho han hun hu ap log kar sab ana jana dost".split())

_WORD_RE = re.compile(r"[^\W\d_]+")


def script_of(ch: str) -> str | None:
    cp = ord(ch)
    for name, ranges in _SCRIPTS:
        for lo, hi in ranges:
            if lo <= cp <= hi:
                return name
    return None


def script_counts(text: str) -> Counter[str]:
    counts: Counter[str] = Counter()
    for ch in text:
        if ch.isalpha():
            counts[script_of(ch) or "Other"] += 1
    return counts


def dominant_script(text: str) -> str:
    counts = script_counts(text)
    return counts.most_common(1)[0][0] if counts else "Unknown"


def is_latin(text: str) -> bool:
    """True when at least 60% of the letters are Latin."""
    counts = script_counts(text)
    total = sum(counts.values())
    return total > 0 and counts["Latin"] / total >= 0.6


def roman_urdu_score(tokens: list[str]) -> float:
    return sum(1.0 if t in _ROMAN_URDU_STRONG else 0.5 if t in _ROMAN_URDU_WEAK else 0.0 for t in tokens)


def _confidence(best: float, second: float) -> float:
    """Combine how clearly the winner beat the runner-up with how much evidence there was."""
    if best <= 0:
        return 0.0
    margin = best / (best + second)
    strength = min(1.0, best / 3)
    return round(0.15 + 0.84 * margin * strength, 2)


def _detect_arabic_script(text: str) -> tuple[str, float]:
    chars = set(text)
    if chars & _URDU_LETTERS:
        return "ur", 0.9
    if chars & _PERSIAN_LETTERS:
        return "fa", 0.8
    return "ar", 0.75


def _detect_latin(text: str) -> Detection:
    lowered = text.lower()
    tokens = _WORD_RE.findall(lowered)
    scores: dict[str, float] = {lang: sum(t in words for t in tokens) for lang, words in _STOPWORDS.items()}
    for lang, (pattern, bonus) in _DIACRITICS.items():
        if pattern.search(lowered):
            scores[lang] += bonus

    roman = roman_urdu_score(tokens)
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    (best_lang, best), (_, second) = ranked[0], ranked[1]

    if roman >= 1.5 and roman > scores["en"] and roman >= best:
        return Detection("ur", _confidence(roman, best), "Latin", romanized=True)
    if best <= 0:
        return Detection(None, 0.0, "Latin")
    return Detection(best_lang, _confidence(best, second), "Latin")


def detect_language(text: str) -> Detection:
    counts = script_counts(text)
    total = sum(counts.values())
    if not total:
        return Detection(None, 0.0, "Unknown")
    script, n = counts.most_common(1)[0]
    share = n / total  # mixed-script text gets lower confidence

    if script == "Latin":
        d = _detect_latin(text)
        return Detection(d.language, round(d.confidence * share, 2), d.script, d.romanized)
    if script == "Arabic":
        lang, conf = _detect_arabic_script(text)
    elif script == "Cyrillic":
        lang, conf = ("uk", 0.9) if set(text) & _UKRAINIAN_LETTERS else ("ru", 0.8)
    elif script in ("Han", "Kana"):
        lang, conf = ("ja", 0.9) if counts["Kana"] else ("zh-CN", 0.85)
        script = "Han" if lang == "zh-CN" else "Japanese"
    elif script in _SCRIPT_LANG:
        lang, conf = _SCRIPT_LANG[script]
    else:  # e.g. Hebrew — a script we can name but no supported language uses
        return Detection(None, 0.0, script)
    return Detection(lang, round(conf * share, 2), script)
