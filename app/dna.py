"""Evidence-based checks, not a calibrated translation accuracy score."""
from collections import Counter
import re
import unicodedata

NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
URL = re.compile(r"https?://[^\s<>]+")
PLACEHOLDER = re.compile(r"\{[A-Za-z_][A-Za-z_0-9]*\}|%[sd]")


def normalize(text):
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def numbers(text):
    return [ "".join(str(unicodedata.decimal(c)) if c.isdecimal() else c for c in token)
             for token in NUMBER.findall(text)]


def evaluate(source, target, terms=()):
    checks = []
    def compare(name, a, b, note):
        left, right = Counter(a), Counter(b)
        checks.append({"name": name, "status": "not_applicable" if not left and not right else "match" if left == right else "review",
                       "missing": list((left-right).elements())[:30], "added": list((right-left).elements())[:30], "note": note})
    compare("Numeric tokens", numbers(source), numbers(target), "Literal numeric comparison; localized separators and written numbers may differ.")
    compare("URLs", [u.rstrip(".,;!?") for u in URL.findall(source)], [u.rstrip(".,;!?") for u in URL.findall(target)], "Literal URL preservation.")
    compare("Placeholders", PLACEHOLDER.findall(source), PLACEHOLDER.findall(target), "Checks common template placeholders only.")
    checks.append({"name":"Unchanged text", "status":"review" if normalize(source)==normalize(target) else "match",
                   "note":"Identical text may be valid for names or same-language translation."})
    missing = [term for term in terms if normalize(term) not in normalize(target)]
    checks.append({"name":"Required target terms", "status":"not_applicable" if not terms else "review" if missing else "match",
                   "missing":missing, "note":"Literal substring check, not terminology correctness."})
    return {"checks":checks, "source_characters":len(source), "target_characters":len(target),
            "limitations":"These checks do not measure semantic accuracy, grammar or cultural appropriateness."}
