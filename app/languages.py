"""Supported languages: ISO-639-1 code -> display name.

Both Google Translate and Microsoft Translator accept these codes.
"""

LANGUAGES: dict[str, str] = {
    "auto": "Detect language",
    "ar": "Arabic",
    "bn": "Bengali",
    "zh-CN": "Chinese (Simplified)",
    "nl": "Dutch",
    "en": "English",
    "fr": "French",
    "de": "German",
    "el": "Greek",
    "hi": "Hindi",
    "id": "Indonesian",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "fa": "Persian",
    "pl": "Polish",
    "pt": "Portuguese",
    "pa": "Punjabi",
    "ru": "Russian",
    "es": "Spanish",
    "sv": "Swedish",
    "ta": "Tamil",
    "tr": "Turkish",
    "uk": "Ukrainian",
    "ur": "Urdu",
    "vi": "Vietnamese",
}

# Microsoft Translator uses slightly different codes for a few languages.
MICROSOFT_CODE_MAP: dict[str, str] = {"zh-CN": "zh-Hans"}
