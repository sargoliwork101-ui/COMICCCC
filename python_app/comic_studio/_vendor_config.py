"""Embedded customer-facing vendor contact & support channels for Comic OCR Studio.

HOW TO CUSTOMIZE BEFORE BUILDING `.exe`:
1. Visual method (recommended): Run `start_license_manager.bat` and open the tab
   «⚙️ کلید مادر و اطلاعات داخل EXE», edit your phone/Telegram/WhatsApp/Eitaa/hours/website,
   and click «ذخیره و همگام‌سازی برای ساخت EXE».
2. Direct file method: Edit `python_app/vendor_contact.json` with Notepad; running
   `build_windows_offline.bat` automatically syncs `vendor_contact.json` into this module
   before compiling `ComicOCRStudio.exe`.
"""

from __future__ import annotations

VENDOR_CONTACT_INFO: dict[str, str] = {
    "supportPhone": "09361111111",
    "whatsapp": "09361111111",
    "telegram": "",
    "domesticMessenger": "",
    "supportHours": "پاسخ‌گویی همه‌روزه از ساعت ۹ صبح تا ۱۰ شب",
    "website": "",
    "customNote": "",
}
