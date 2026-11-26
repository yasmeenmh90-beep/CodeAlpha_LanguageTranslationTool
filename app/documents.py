import io
import zipfile

MAX_BYTES = 5 * 1024 * 1024
MAX_TEXT = 5000


def extract(data: bytes, kind: str) -> str:
    if not data or len(data) > MAX_BYTES:
        raise ValueError("File must be between 1 byte and 5 MB.")
    if kind == "txt":
        text = data.decode("utf-8-sig")
    elif kind == "pdf":
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted or len(reader.pages) > 20:
            raise ValueError("Use an unencrypted PDF of up to 20 pages.")
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    elif kind == "docx":
        from defusedxml.ElementTree import fromstring
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 1000 or sum(e.file_size for e in entries) > 20 * MAX_BYTES:
                raise ValueError("Document archive is too large.")
            info = archive.getinfo("word/document.xml")
            if info.file_size > MAX_BYTES:
                raise ValueError("Document XML is too large.")
            root = fromstring(archive.read(info))
        ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        text = "\n".join("".join(t.text or "" for t in p.iter(ns+"t")) for p in root.iter(ns+"p"))
    elif kind in {"png", "jpg", "jpeg"}:
        from PIL import Image
        import pytesseract
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {"PNG", "JPEG"} or image.width * image.height > 12000000:
                raise ValueError("Use a PNG or JPEG up to 12 megapixels.")
            image.load()
            text = pytesseract.image_to_string(image, lang="eng", timeout=15)
    else:
        raise ValueError("Unsupported file type.")
    if not text.strip():
        raise ValueError("No readable text found. Scanned PDFs are not supported.")
    if len(text) > MAX_TEXT:
        raise ValueError("Extracted text exceeds 5000 characters. Split the document.")
    return text.strip()
