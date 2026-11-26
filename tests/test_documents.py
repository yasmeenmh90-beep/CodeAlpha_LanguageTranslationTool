import pytest
from app.documents import extract, MAX_BYTES

def test_text_extraction():
    assert extract(" Bonjour ".encode(), "txt") == "Bonjour"

@pytest.mark.parametrize("data,kind", [(b"", "txt"), (b"x"*(MAX_BYTES+1), "txt"), (b"x"*5001, "txt"), (b"hi", "exe")])
def test_invalid_extraction(data, kind):
    with pytest.raises(ValueError):
        extract(data, kind)
