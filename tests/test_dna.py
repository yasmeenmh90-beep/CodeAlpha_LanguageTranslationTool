from app.dna import evaluate, numbers

def test_unicode_digits():
    assert numbers("١٢ items") == ["12"]

def test_missing_and_added_numbers():
    check = evaluate("Pay 12", "Payer 15")["checks"][0]
    assert check["status"] == "review"
    assert check["missing"] == ["12"]
    assert check["added"] == ["15"]

def test_preserved_placeholder_and_url():
    checks = evaluate("Hi {name} https://example.com", "Salut {name} https://example.com")["checks"]
    assert checks[1]["status"] == checks[2]["status"] == "match"

def test_required_terms_and_unchanged():
    checks = evaluate("Hello", "Hello", ["bonjour"])["checks"]
    assert checks[3]["status"] == checks[4]["status"] == "review"

def test_no_numbers():
    assert evaluate("Hello", "Bonjour")["checks"][0]["status"] == "not_applicable"
