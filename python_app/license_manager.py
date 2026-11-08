#!/usr/bin/env python3
"""Seller-Only 256-Byte Master Vault, Customer CRM & Offline Modular License Generator.

SECURITY ARCHITECTURE (v4.17):
- Keep this tool ONLY on the seller's computer. It is intentionally excluded from
  customer `.exe` builds by `offline_packaging/build_offline_package.py`.
- Your 256-byte (2048-bit) Master Root Secret + derived Ed25519 private signing seed,
  customer directory (`seller_customers.json`), and issued history (`issued_licenses.json`)
  are stored OUTSIDE this Git repository in:
  `~/.comic-ocr-studio-seller/`
- Only the 32-byte PUBLIC verification key is synced into `comic_studio/_public_key.py`
  (and compiled into `ComicLicenseGuard.exe`), so even full reverse-engineering of a
  customer `.exe` can NEVER forge a license key for any PC.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import datetime as dt
import hashlib
import hmac
import io
import json
import math
import os
import re
import secrets
import socket
import sys
import tempfile
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

APP_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from comic_studio.license_guard import (  # noqa: E402
    LICENSE_MODULES,
    MODULE_LABELS_FA,
    SUPPORT_PHONE,
    VENDOR_CONTACT_KEYS,
    LicenseError,
    SECURITY_GATE,
    compute_hardware_id,
    ed25519_public_key,
    get_support_phone,
    get_vendor_contact_info,
    issue_license_token,
    normalize_hardware_id,
    normalize_vendor_contact_dict,
    plan_label_fa,
    verify_license_token,
)

PUBLIC_KEY_MODULE_PATH = APP_DIR / "comic_studio" / "_public_key.py"
VENDOR_CONFIG_PY_PATH = APP_DIR / "comic_studio" / "_vendor_config.py"
VENDOR_CONTACT_JSON_PATH = APP_DIR / "vendor_contact.json"
MASTER_SECRET_BYTES = 256  # 256 bytes = 2048 bits (512 hex chars)
CUSTOM_MASTER_PBKDF2_ITERS = 600_000

_DIGIT_TRANS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")


def default_seller_dir() -> Path:
    raw = os.environ.get("COMIC_STUDIO_SELLER_DIR", "").strip()
    if raw:
        return Path(raw)
    return Path(os.path.expanduser("~")) / ".comic-ocr-studio-seller"


def derive_ed25519_seed_from_master_256b(master_256b: bytes) -> bytes:
    """Derive a deterministic 32-byte Ed25519 signing seed from a 256-byte Master Root Secret."""
    if len(master_256b) != MASTER_SECRET_BYTES:
        raise ValueError(f"کلید مادر ریشه باید دقیقاً {MASTER_SECRET_BYTES} بایت (۲۰۴۸ بیت) باشد.")
    return hmac.new(b"CS4-Ed25519-MasterRoot-256B-v1", master_256b, hashlib.sha512).digest()[:32]


def derive_master_256b_from_user_input(raw_secret: str) -> tuple[bytes, str]:
    """Convert seller's custom secret (512-char hex OR custom passphrase >=16 chars) into 256 bytes."""
    cleaned = str(raw_secret or "").strip()
    if len(cleaned) < 16:
        raise ValueError(
            "کلید یا عبارت مادر دلخواه شما برای امنیت کامل باید حداقل ۱۶ کاراکتر باشد "
            "(یا ۵۱۲ کاراکتر هگز برای کلید خام ۲۵۶ بایتی)."
        )
    compact_hex = re.sub(r"\s+", "", cleaned)
    if len(compact_hex) == MASTER_SECRET_BYTES * 2 and re.fullmatch(r"[0-9a-fA-F]+", compact_hex):
        return bytes.fromhex(compact_hex), "hex256b"
    derived = hashlib.pbkdf2_hmac(
        "sha512",
        cleaned.encode("utf-8"),
        b"CS4-SellerMasterKey-256B-Salt-v1",
        CUSTOM_MASTER_PBKDF2_ITERS,
        dklen=MASTER_SECRET_BYTES,
    )
    return derived, "passphrase_pbkdf2_256b"


def normalize_customer_phone(raw_phone: str, *, required: bool = True) -> str:
    """Normalize Iranian/international mobile numbers (supports Persian/Arabic digits)."""
    cleaned = str(raw_phone or "").translate(_DIGIT_TRANS).strip()
    if not cleaned:
        if required:
            raise ValueError("شماره موبایل مشتری الزامی است.")
        return ""
    cleaned = re.sub(r"[\s\-\(\)\.]+", "", cleaned)
    if cleaned.startswith("+98"):
        cleaned = "0" + cleaned[3:]
    elif cleaned.startswith("0098"):
        cleaned = "0" + cleaned[4:]
    elif cleaned.startswith("98") and len(cleaned) == 12:
        cleaned = "0" + cleaned[2:]
    elif len(cleaned) == 10 and cleaned.startswith("9") and cleaned.isdigit():
        cleaned = "0" + cleaned

    if cleaned.startswith("+"):
        digits_part = cleaned[1:]
        if not digits_part.isdigit() or not (7 <= len(digits_part) <= 15):
            raise ValueError("شماره موبایل مشتری معتبر نیست (نمونهٔ صحیح: 09123456789).")
        return "+" + digits_part

    if not cleaned.isdigit():
        raise ValueError("شماره موبایل فقط باید شامل ارقام باشد (نمونه: 09123456789).")
    if cleaned.startswith("09") and len(cleaned) != 11:
        raise ValueError("شماره موبایل ایران باید ۱۱ رقم و با 09 شروع شود (مثلاً 09123456789).")
    if not (7 <= len(cleaned) <= 15):
        raise ValueError("تعداد ارقام شماره موبایل معتبر نیست (نمونه: 09123456789).")
    return cleaned


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp_path = Path(tmp_name)
    try:
        if os.name != "nt":
            with contextlib.suppress(OSError):
                os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            with contextlib.suppress(OSError):
                os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    finally:
        if tmp_path.exists():
            with contextlib.suppress(OSError):
                tmp_path.unlink()


def parse_modules_cli_spec(spec: str) -> dict[str, dict[str, Any]]:
    """Parse CLI `--modules-spec` like `ocr=lifetime,translation=30,editing=off`."""
    out: dict[str, dict[str, Any]] = {}
    for chunk in str(spec or "").split(","):
        part = chunk.strip()
        if not part:
            continue
        if "=" not in part:
            raise ValueError(f"فرمت نامعتبر در تعریف ماژول: {part!r} (نمونه: ocr=lifetime,translation=30)")
        mod_raw, val_raw = part.split("=", 1)
        mod_id = mod_raw.strip().lower()
        val = val_raw.strip().lower()
        if mod_id not in LICENSE_MODULES:
            raise ValueError(f"نام ماژول نامعتبر است: {mod_id!r} (مجاز: ocr, translation, editing)")
        if val in {"off", "none", "0", "false", "disabled"}:
            continue
        if val in {"lifetime", "perm", "permanent", "forever"}:
            out[mod_id] = {"plan": "lifetime"}
        elif val.startswith("trial:"):
            days = int(val.split(":", 1)[1])
            out[mod_id] = {"plan": "trial", "days": days}
        else:
            cleaned_days = val.removesuffix("d").strip()
            days = int(cleaned_days)
            out[mod_id] = {"plan": "subscription", "days": days}
    if not out:
        raise ValueError("حداقل یکی از سه ماژول باید در کلید لایسنس فعال باشد.")
    return out


def _safe_csv_cell(value: Any) -> Any:
    """Prevent Excel/LibreOffice formula evaluation & `+` phone truncation in exported CSV cells."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    text = str(value if value is not None else "")
    stripped = text.lstrip(" \t\r\n")
    if stripped.startswith(("=", "+", "-", "@")) or text.startswith(("\t", "\r")):
        return "'" + text
    return text


class SellerVault:
    """Manages 256-byte Master Key + Ed25519 signing, Vendor Contact Config, and Customer CRM."""

    def __init__(
        self,
        seller_dir: Path | None = None,
        public_key_py: Path | None = None,
        vendor_json_path: Path | None = None,
        vendor_py_path: Path | None = None,
    ) -> None:
        self._lock = threading.RLock()
        self.seller_dir = Path(seller_dir) if seller_dir is not None else default_seller_dir()
        self.public_key_py = Path(public_key_py) if public_key_py is not None else PUBLIC_KEY_MODULE_PATH
        self.vendor_json_path = Path(vendor_json_path) if vendor_json_path is not None else VENDOR_CONTACT_JSON_PATH
        self.vendor_py_path = Path(vendor_py_path) if vendor_py_path is not None else VENDOR_CONFIG_PY_PATH

    @property
    def master_key_path(self) -> Path:
        return self.seller_dir / "seller_master_key.json"

    @property
    def history_path(self) -> Path:
        return self.seller_dir / "issued_licenses.json"

    @property
    def customers_path(self) -> Path:
        return self.seller_dir / "seller_customers.json"

    def ensure_master_key(self, *, sync_source: bool = True) -> dict[str, Any]:
        with self._lock:
            return self._ensure_master_key_unlocked(sync_source=sync_source)

    def _ensure_master_key_unlocked(self, *, sync_source: bool = True) -> dict[str, Any]:
        record: dict[str, Any] | None = None
        needs_upgrade_save = False
        if self.master_key_path.is_file():
            try:
                loaded = json.loads(self.master_key_path.read_text(encoding="utf-8"))
                raw_master_hex = str(loaded.get("master_secret_256b_hex") or "").strip()
                raw_seed_hex = str(loaded.get("private_seed_hex") or "").strip()
                master_bytes: bytes | None = None
                if raw_master_hex:
                    candidate = bytes.fromhex(raw_master_hex)
                    if len(candidate) == MASTER_SECRET_BYTES:
                        master_bytes = candidate
                if raw_seed_hex:
                    seed = bytes.fromhex(raw_seed_hex)
                    if len(seed) != 32:
                        raise ValueError("طول کلید امضا معتبر نیست.")
                elif master_bytes is not None:
                    seed = derive_ed25519_seed_from_master_256b(master_bytes)
                else:
                    raise ValueError("کلید خصوصی در فایل یافت نشد.")

                if master_bytes is None:
                    # Seamless upgrade of existing v1 vault: preserve exact Ed25519 signing seed
                    # so zero previously issued customer keys break, while attaching a 256-byte vault secret.
                    master_bytes = secrets.token_bytes(MASTER_SECRET_BYTES)
                    needs_upgrade_save = True

                pub = ed25519_public_key(seed)
                record = {
                    "v": 2,
                    "key_scheme": "Ed25519+MasterRoot256B",
                    "master_secret_bytes": MASTER_SECRET_BYTES,
                    "created_at": str(loaded.get("created_at") or dt.datetime.now(dt.timezone.utc).isoformat()),
                    "master_secret_256b_hex": master_bytes.hex(),
                    "private_seed_hex": seed.hex(),
                    "public_key_hex": pub.hex(),
                    "fingerprint": hashlib.sha256(pub).hexdigest()[:16].upper(),
                }
            except Exception as exc:
                raise RuntimeError(f"فایل کلید مادر فروشنده آسیب دیده است: {exc}") from exc

        if record is None:
            master_bytes = secrets.token_bytes(MASTER_SECRET_BYTES)
            seed = derive_ed25519_seed_from_master_256b(master_bytes)
            pub = ed25519_public_key(seed)
            record = {
                "v": 2,
                "key_scheme": "Ed25519+MasterRoot256B",
                "master_secret_bytes": MASTER_SECRET_BYTES,
                "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "master_secret_256b_hex": master_bytes.hex(),
                "private_seed_hex": seed.hex(),
                "public_key_hex": pub.hex(),
                "fingerprint": hashlib.sha256(pub).hexdigest()[:16].upper(),
            }
            needs_upgrade_save = True

        if needs_upgrade_save:
            _atomic_write_json(self.master_key_path, record)
        if sync_source:
            self.sync_public_key_to_source(record["public_key_hex"])
        return record

    @staticmethod
    def generate_random_master_key_hex() -> str:
        """Return a fresh random 256-byte (512 hex chars) Master Key candidate without saving yet."""
        return secrets.token_bytes(MASTER_SECRET_BYTES).hex()

    def set_custom_master_key(self, raw_secret: str, *, sync_source: bool = True) -> dict[str, Any]:
        """Set seller's own custom Master Key (512-char hex or custom passphrase >= 16 chars) and sync."""
        master_bytes, input_mode = derive_master_256b_from_user_input(raw_secret)
        seed = derive_ed25519_seed_from_master_256b(master_bytes)
        pub = ed25519_public_key(seed)
        record = {
            "v": 2,
            "key_scheme": "Ed25519+MasterRoot256B",
            "input_mode": input_mode,
            "master_secret_bytes": MASTER_SECRET_BYTES,
            "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "master_secret_256b_hex": master_bytes.hex(),
            "private_seed_hex": seed.hex(),
            "public_key_hex": pub.hex(),
            "fingerprint": hashlib.sha256(pub).hexdigest()[:16].upper(),
        }
        with self._lock:
            _atomic_write_json(self.master_key_path, record)
            if sync_source:
                self.sync_public_key_to_source(record["public_key_hex"])
        return record

    def get_vendor_contact(self) -> dict[str, str]:
        """Read current vendor contact settings from `vendor_contact.json` / `_vendor_config.py`."""
        merged: dict[str, Any] = dict(get_vendor_contact_info())
        if self.vendor_json_path.is_file():
            with contextlib.suppress(Exception):
                loaded = json.loads(self.vendor_json_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    merged.update(loaded)
        return normalize_vendor_contact_dict(merged)

    def sync_vendor_contact_to_source(self, info: dict[str, str]) -> None:
        """Write customer-facing contact channels into `comic_studio/_vendor_config.py` for `.exe` bundling."""
        norm = normalize_vendor_contact_dict(info)
        lines = [
            '"""Embedded customer-facing vendor contact & support channels for Comic OCR Studio.',
            "",
            "HOW TO CUSTOMIZE BEFORE BUILDING `.exe`:",
            "1. Visual method (recommended): Run `start_license_manager.bat` and open the tab",
            "   «⚙️ کلید مادر و اطلاعات داخل EXE», edit your phone/Telegram/WhatsApp/Eitaa/hours/website,",
            "   and click «ذخیره و همگام‌سازی برای ساخت EXE».",
            "2. Direct file method: Edit `python_app/vendor_contact.json` with Notepad; running",
            "   `build_windows_offline.bat` automatically syncs `vendor_contact.json` into this module",
            "   before compiling `ComicOCRStudio.exe`.",
            '"""',
            "",
            "from __future__ import annotations",
            "",
            "VENDOR_CONTACT_INFO: dict[str, str] = {",
        ]
        for k in VENDOR_CONTACT_KEYS:
            val_json = json.dumps(norm[k], ensure_ascii=False)
            lines.append(f'    "{k}": {val_json},')
        lines.append("}")
        lines.append("")
        self.vendor_py_path.parent.mkdir(parents=True, exist_ok=True)
        self.vendor_py_path.write_text("\n".join(lines), encoding="utf-8")
        import comic_studio._vendor_config as vc_mod

        vc_mod.VENDOR_CONTACT_INFO = dict(norm)

    def save_vendor_contact(self, payload: dict[str, Any], *, sync_source: bool = True) -> dict[str, str]:
        """Validate, save to `vendor_contact.json`, and sync to `_vendor_config.py` for `.exe` builds."""
        raw_phone = str((payload or {}).get("supportPhone") or "").strip()
        if not raw_phone:
            raise ValueError("شماره تماس پشتیبانی نمی‌تواند خالی باشد.")
        norm = normalize_vendor_contact_dict({**(payload or {}), "supportPhone": raw_phone})
        with self._lock:
            _atomic_write_json(self.vendor_json_path, norm)
            if sync_source:
                self.sync_vendor_contact_to_source(norm)
        return norm

    def sync_all_before_exe_build(self) -> dict[str, Any]:
        """Ensure both `_public_key.py` and `_vendor_config.py` reflect latest seller settings before `.exe` build."""
        with self._lock:
            key_rec = self.ensure_master_key(sync_source=True)
            vendor = self.get_vendor_contact()
            self.sync_vendor_contact_to_source(vendor)
            return {"key": key_rec, "vendorContact": vendor}

    def import_master_key(self, payload: dict[str, Any], *, sync_source: bool = True) -> dict[str, Any]:
        with self._lock:
            return self._import_master_key_unlocked(payload, sync_source=sync_source)

    def _import_master_key_unlocked(self, payload: dict[str, Any], *, sync_source: bool = True) -> dict[str, Any]:
        # Accept either full bundle `{"backup": {...}, "customers": [...], "history": [...]}` or raw key dict
        key_obj = payload.get("backup") if isinstance(payload.get("backup"), dict) else payload
        if not isinstance(key_obj, dict):
            raise ValueError("فرمت فایل پشتیبان کلید مادر معتبر نیست.")

        raw_master_hex = str(key_obj.get("master_secret_256b_hex") or "").strip()
        raw_seed_hex = str(key_obj.get("private_seed_hex") or "").strip()
        master_bytes: bytes | None = None
        if raw_master_hex:
            try:
                mb = bytes.fromhex(raw_master_hex)
            except ValueError as exc:
                raise ValueError("فرمت هگز کلید مادر ۲۵۶ بایتی نامعتبر است.") from exc
            if len(mb) != MASTER_SECRET_BYTES:
                raise ValueError("کلید مادر ۲۵۶ بایتی باید دقیقاً ۲۵۶ بایت (۵۱۲ کاراکتر هگز) باشد.")
            master_bytes = mb

        if raw_seed_hex:
            try:
                seed = bytes.fromhex(raw_seed_hex)
            except ValueError as exc:
                raise ValueError("فرمت فایل پشتیبان کلید مادر معتبر نیست.") from exc
            if len(seed) != 32:
                raise ValueError("کلید امضای Ed25519 باید دقیقاً ۳۲ بایت باشد.")
        elif master_bytes is not None:
            seed = derive_ed25519_seed_from_master_256b(master_bytes)
        else:
            raise ValueError("فایل پشتیبان فاقد کلید مادر معتبر است.")

        if master_bytes is None:
            master_bytes = secrets.token_bytes(MASTER_SECRET_BYTES)

        pub = ed25519_public_key(seed)
        record = {
            "v": 2,
            "key_scheme": "Ed25519+MasterRoot256B",
            "master_secret_bytes": MASTER_SECRET_BYTES,
            "created_at": str(key_obj.get("created_at") or dt.datetime.now(dt.timezone.utc).isoformat()),
            "master_secret_256b_hex": master_bytes.hex(),
            "private_seed_hex": seed.hex(),
            "public_key_hex": pub.hex(),
            "fingerprint": hashlib.sha256(pub).hexdigest()[:16].upper(),
        }
        _atomic_write_json(self.master_key_path, record)

        # If the backup bundle also carries customer directory or history, merge them safely!
        if isinstance(payload.get("customers"), list) and payload["customers"]:
            existing_custs = {str(c.get("customerId") or ""): c for c in self._load_raw_customers()}
            for cust in payload["customers"]:
                if isinstance(cust, dict) and cust.get("customerId"):
                    existing_custs[str(cust["customerId"])] = cust
            _atomic_write_json(self.customers_path, list(existing_custs.values()))

        if isinstance(payload.get("history"), list) and payload["history"]:
            existing_hist = self.list_history()
            seen_ids = {str(h.get("licenseId") or "") for h in existing_hist}
            for item in payload["history"]:
                if isinstance(item, dict) and str(item.get("licenseId") or "") not in seen_ids:
                    existing_hist.append(item)
            _atomic_write_json(self.history_path, existing_hist[:2000])

        if sync_source:
            self.sync_public_key_to_source(record["public_key_hex"])
        return record

    def sync_public_key_to_source(self, public_key_hex: str) -> bool:
        if not self.public_key_py.is_file():
            return False
        current_text = self.public_key_py.read_text(encoding="utf-8")
        pattern = r'(PUBLIC_VERIFY_KEY_HEX:\s*str\s*=\s*\(\s*")([0-9a-fA-F]{64})("\s*\))'
        updated_text, count = re.subn(
            pattern,
            rf"\g<1>{public_key_hex.lower()}\g<3>",
            current_text,
            count=1,
        )
        if count == 0:
            pattern_flat = r'(PUBLIC_VERIFY_KEY_HEX(?:\s*:\s*str)?\s*=\s*")([0-9a-fA-F]{64})(")'
            updated_text, count = re.subn(
                pattern_flat,
                rf"\g<1>{public_key_hex.lower()}\g<3>",
                current_text,
                count=1,
            )
        if count > 0 and updated_text != current_text:
            self.public_key_py.write_text(updated_text, encoding="utf-8")
        import comic_studio._public_key as pub_mod

        pub_mod.PUBLIC_VERIFY_KEY_HEX = public_key_hex.lower()
        return count > 0

    def list_history(self) -> list[dict[str, Any]]:
        if not self.history_path.is_file():
            return []
        try:
            items = json.loads(self.history_path.read_text(encoding="utf-8"))
            return items if isinstance(items, list) else []
        except Exception:
            return []

    def _load_raw_customers(self) -> list[dict[str, Any]]:
        if not self.customers_path.is_file():
            return []
        try:
            items = json.loads(self.customers_path.read_text(encoding="utf-8"))
            return [c for c in items if isinstance(c, dict)] if isinstance(items, list) else []
        except Exception:
            return []

    def upsert_customer(
        self,
        *,
        first_name: str,
        last_name: str,
        phone: str,
        hardware_id: str = "",
        note: str = "",
        customer_id: str = "",
        allow_clear_note: bool = False,
    ) -> dict[str, Any]:
        fn = str(first_name or "").strip()[:80]
        ln = str(last_name or "").strip()[:80]
        if not fn:
            raise ValueError("وارد کردن «نام» مشتری الزامی است.")
        if not ln:
            raise ValueError("وارد کردن «نام خانوادگی» مشتری الزامی است.")
        norm_phone = normalize_customer_phone(phone, required=True)
        norm_hwid = normalize_hardware_id(hardware_id) if str(hardware_id or "").strip() else ""
        clean_note = str(note or "").strip()[:400]
        now_iso = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

        with self._lock:
            customers = self._load_raw_customers()
            target: dict[str, Any] | None = None
            cid_clean = str(customer_id or "").strip()
            if cid_clean:
                for cust in customers:
                    if str(cust.get("customerId") or "") == cid_clean:
                        target = cust
                        break
            if target is None:
                for cust in customers:
                    if str(cust.get("phone") or "") == norm_phone:
                        target = cust
                        break
            if target is None and norm_hwid:
                for cust in customers:
                    hw_list = cust.get("hardwareIds") or []
                    if isinstance(hw_list, list) and norm_hwid in hw_list:
                        target = cust
                        break

            if target is None:
                target = {
                    "customerId": "CUST-" + secrets.token_hex(5).upper(),
                    "firstName": fn,
                    "lastName": ln,
                    "fullName": f"{fn} {ln}".strip(),
                    "phone": norm_phone,
                    "hardwareIds": [norm_hwid] if norm_hwid else [],
                    "note": clean_note,
                    "createdIso": now_iso,
                    "updatedIso": now_iso,
                }
                customers.insert(0, target)
            else:
                target["firstName"] = fn
                target["lastName"] = ln
                target["fullName"] = f"{fn} {ln}".strip()
                target["phone"] = norm_phone
                hw_list = [str(x) for x in (target.get("hardwareIds") or []) if str(x).strip()]
                if norm_hwid and norm_hwid not in hw_list:
                    hw_list.insert(0, norm_hwid)
                target["hardwareIds"] = hw_list
                if clean_note or allow_clear_note or "note" not in target:
                    target["note"] = clean_note
                target["updatedIso"] = now_iso

            _atomic_write_json(self.customers_path, customers[:5000])
            return dict(target)

    def delete_customer(self, customer_id: str) -> bool:
        cid = str(customer_id or "").strip()
        if not cid:
            raise ValueError("شناسهٔ مشتری مشخص نشده است.")
        with self._lock:
            customers = self._load_raw_customers()
            filtered = [c for c in customers if str(c.get("customerId") or "") != cid]
            if len(filtered) == len(customers):
                return False
            _atomic_write_json(self.customers_path, filtered)
            return True

    def list_customers(self, *, now_ts: float | None = None) -> list[dict[str, Any]]:
        """Return all customers enriched with live per-module status computed from issued history."""
        now_int = int(now_ts if now_ts is not None else time.time())
        raw_customers = self._load_raw_customers()
        history = self.list_history()

        enriched: list[dict[str, Any]] = []
        for cust in raw_customers:
            cid = str(cust.get("customerId") or "")
            c_phone = str(cust.get("phone") or "")
            c_hwids = set(str(x) for x in (cust.get("hardwareIds") or []) if x)

            # Match history items belonging to this customer (history is newest-first)
            matched_hist = [
                h
                for h in history
                if (cid and str(h.get("customerId") or "") == cid)
                or (c_phone and str(h.get("phone") or "") == c_phone)
                or (str(h.get("hardwareId") or "") in c_hwids)
            ]

            # Best grant per module across additive keys issued to this customer
            mod_live: dict[str, dict[str, Any]] = {}
            for m in LICENSE_MODULES:
                best: dict[str, Any] | None = None
                best_rank: tuple[int, int] = (-1, -1)
                for h in matched_hist:
                    h_mods = h.get("modules")
                    if isinstance(h_mods, dict) and m in h_mods:
                        cand = h_mods[m]
                        cand_exp = cand.get("expiresAt")
                        cand_rank = (2, 0) if (cand_exp is None or cand.get("plan") == "lifetime") else (1, int(cand_exp))
                        if cand_rank > best_rank:
                            best = cand
                            best_rank = cand_rank
                            if cand_rank[0] == 2:
                                break
                if best is None:
                    mod_live[m] = {"state": "none", "label": MODULE_LABELS_FA[m], "text": "صادرنشده", "daysRemaining": None}
                    continue
                exp = best.get("expiresAt")
                if exp is None or best.get("plan") == "lifetime":
                    mod_live[m] = {
                        "state": "lifetime",
                        "label": MODULE_LABELS_FA[m],
                        "text": "دائمی",
                        "daysRemaining": None,
                        "expiresAt": None,
                    }
                else:
                    rem_sec = int(exp) - now_int
                    if rem_sec <= 0:
                        mod_live[m] = {
                            "state": "expired",
                            "label": MODULE_LABELS_FA[m],
                            "text": "منقضی‌شده",
                            "daysRemaining": 0,
                            "expiresAt": int(exp),
                        }
                    else:
                        rem_days = max(1, math.ceil(rem_sec / 86400))
                        rem_hrs = max(0, rem_sec // 3600)
                        txt = f"{rem_days} روز مانده" if rem_sec >= 86400 else f"{max(1, rem_hrs)} ساعت مانده"
                        mod_live[m] = {
                            "state": "expiring" if rem_days <= 7 else "active",
                            "label": MODULE_LABELS_FA[m],
                            "text": txt,
                            "daysRemaining": rem_days,
                            "remainingSeconds": rem_sec,
                            "expiresAt": int(exp),
                        }

            states = [mod_live[m]["state"] for m in LICENSE_MODULES]
            if any(s == "expiring" for s in states):
                overall = "expiring"
            elif any(s in {"lifetime", "active"} for s in states):
                overall = "active"
            elif any(s == "expired" for s in states):
                overall = "expired"
            else:
                overall = "no_license"

            enriched.append(
                {
                    **cust,
                    "issuedCount": len(matched_hist),
                    "lastIssuedIso": matched_hist[0].get("issuedIso", "") if matched_hist else "",
                    "overallStatus": overall,
                    "modulesLive": mod_live,
                }
            )
        return enriched

    def export_customers_csv(self, *, now_ts: float | None = None) -> bytes:
        """Export UTF-8 with BOM CSV of all customers & live module statuses (Excel-friendly)."""
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(
            [
                "شناسه مشتری",
                "نام",
                "نام خانوادگی",
                "شماره موبایل",
                "کدهای سیستم",
                "وضعیت کلی",
                "وضعیت OCR",
                "وضعیت ترجمه",
                "وضعیت ویرایش",
                "تعداد کلید صادرشده",
                "آخرین صدور",
                "یادداشت",
            ]
        )
        status_map = {
            "active": "فعال",
            "expiring": "نزدیک به انقضا",
            "expired": "منقضی‌شده",
            "no_license": "بدون لایسنس",
        }
        for c in self.list_customers(now_ts=now_ts):
            ml = c.get("modulesLive") or {}
            writer.writerow(
                [
                    _safe_csv_cell(c.get("customerId", "")),
                    _safe_csv_cell(c.get("firstName", "")),
                    _safe_csv_cell(c.get("lastName", "")),
                    _safe_csv_cell(c.get("phone", "")),
                    _safe_csv_cell(" | ".join(c.get("hardwareIds") or [])),
                    _safe_csv_cell(status_map.get(str(c.get("overallStatus") or ""), "")),
                    _safe_csv_cell((ml.get("ocr") or {}).get("text", "")),
                    _safe_csv_cell((ml.get("translation") or {}).get("text", "")),
                    _safe_csv_cell((ml.get("editing") or {}).get("text", "")),
                    c.get("issuedCount", 0),
                    _safe_csv_cell(c.get("lastIssuedIso", "")),
                    _safe_csv_cell(c.get("note", "")),
                ]
            )
        return ("\ufeff" + buf.getvalue()).encode("utf-8")

    def issue(
        self,
        *,
        hardware_id: str,
        holder: str = "",
        first_name: str = "",
        last_name: str = "",
        phone: str = "",
        note: str = "",
        customer_id: str = "",
        require_contact: bool = False,
        plan: str = "lifetime",
        days: int | None = None,
        modules: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            key_rec = self.ensure_master_key(sync_source=True)
            norm_hwid = normalize_hardware_id(hardware_id)

            fn = str(first_name or "").strip()[:80]
            ln = str(last_name or "").strip()[:80]
            raw_phone = str(phone or "").strip()

            customer_rec: dict[str, Any] | None = None
            if require_contact or (fn and ln and raw_phone):
                customer_rec = self.upsert_customer(
                    first_name=fn,
                    last_name=ln,
                    phone=raw_phone,
                    hardware_id=norm_hwid,
                    note=note,
                    customer_id=customer_id,
                    allow_clear_note=False,
                )

            derived_holder = f"{fn} {ln}".strip()
            clean_holder = str(holder or "").strip()[:120] or derived_holder or "کاربر رسمی"

            token = issue_license_token(
                private_seed_hex=key_rec["private_seed_hex"],
                hardware_id=norm_hwid,
                holder=clean_holder,
                plan=plan,
                days=days,
                modules=modules,
            )
            verified = verify_license_token(
                token,
                expected_hardware_id=norm_hwid,
                public_key_bytes=bytes.fromhex(key_rec["public_key_hex"]),
                check_expiry=False,
            )
            mod_summary = {
                m: {
                    "label": MODULE_LABELS_FA[m],
                    "plan": verified["modules"][m]["plan"],
                    "planLabel": verified["modules"][m]["planLabel"],
                    "daysTotal": verified["modules"][m]["daysTotal"],
                    "expiresAt": verified["modules"][m]["expiresAt"],
                }
                for m in LICENSE_MODULES
                if m in verified["modules"]
            }
            entry = {
                "licenseId": verified["licenseId"],
                "issuedIso": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                "customerId": customer_rec["customerId"] if customer_rec else "",
                "firstName": customer_rec["firstName"] if customer_rec else fn,
                "lastName": customer_rec["lastName"] if customer_rec else ln,
                "phone": customer_rec["phone"] if customer_rec else (normalize_customer_phone(raw_phone, required=False) if raw_phone else ""),
                "note": str(note or "").strip()[:400],
                "holder": verified["holder"],
                "hardwareId": verified["hardwareId"],
                "plan": verified["plan"],
                "planLabel": verified["planLabel"],
                "daysTotal": verified["daysTotal"],
                "expiresAt": verified["expiresAt"],
                "modules": mod_summary,
                "supportPhone": self.get_vendor_contact()["supportPhone"],
                "token": token,
            }
            history = self.list_history()
            history.insert(0, entry)
            _atomic_write_json(self.history_path, history[:2000])
            return entry

    def self_activate_this_pc(self, holder: str = "نسخهٔ اصلی فروشنده (مالک برنامه)") -> dict[str, Any]:
        hwid = compute_hardware_id()
        issued = self.issue(hardware_id=hwid, holder=holder, plan="lifetime", require_contact=False)
        SECURITY_GATE.reset_memory_state()
        status, _ = SECURITY_GATE.activate_token(issued["token"], replace_all_modules=True)
        return {"issued": issued, "status": status}


_STATIC_ASSETS_DIR = APP_DIR / "comic_studio" / "static" / "assets"


_PANEL_HTML = """<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Comic OCR Studio — پنل مدیریت مشتریان و صدور لایسنس</title>
  <link rel="icon" type="image/png" href="/assets/icon128.png">
  <style>
    @font-face{font-family:Vazirmatn;src:url('/assets/Vazirmatn.woff2') format('woff2');font-weight:100 900;font-display:swap}
    :root{
      --bg:#0b0d12;--surface:#10131a;--surface-2:#171b25;--panel:#13161e;
      --line:#252b38;--line-2:#333b4d;--text:#e8eaf2;--muted:#8a92a6;--faint:#5b6375;
      --a1:#8b7bff;--a2:#5e9dff;
      --grad:linear-gradient(135deg,#8b7bff,#5e9dff);
      --grad-ok:linear-gradient(135deg,#10b981,#34d399);
      --danger:#fb7185;--warning:#fbbf24;
      --shadow:0 18px 50px #0009;
    }
    body.light{
      --bg:#f3f4f8;--surface:#fff;--surface-2:#f0f1f6;--panel:#fff;
      --line:#dfe2eb;--line-2:#c9cfdd;--text:#202536;--muted:#667085;--faint:#98a2b3;
      --shadow:0 18px 50px #24304a22;
    }
    *{box-sizing:border-box}
    html,body{margin:0;min-height:100vh;background:radial-gradient(circle at 85% -20%,#29214c66,transparent 38%),var(--bg);color:var(--text);font:13px/1.8 Vazirmatn,Tahoma,sans-serif}
    body.light{background:radial-gradient(circle at 85% -20%,#8b7bff20,transparent 42%),var(--bg)}
    button,input,select,textarea{font:inherit;color:inherit}
    input,textarea{user-select:text;-webkit-user-select:text}
    code{font:700 11.5px/1.5 Consolas,"Courier New",monospace;padding:1px 6px;border-radius:6px;background:color-mix(in srgb,var(--a2) 13%,var(--bg));border:1px solid color-mix(in srgb,var(--a2) 34%,var(--line));color:var(--a2)}

    /* Sticky Topbar — exact match with Comic OCR Studio main window */
    .topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--surface) 88%,transparent);backdrop-filter:blur(14px);flex-wrap:wrap}
    .topbar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .brand{display:flex;align-items:center;gap:10px}
    .logo{width:34px;height:34px;border-radius:9px;box-shadow:0 6px 18px #8b7bff38}
    .brand h1{margin:0;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .brand-sub{display:block;font-size:11px;color:var(--muted)}
    .ver{font-size:11px;padding:1px 8px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line-2);color:var(--a1);font-weight:700}

    /* Buttons & Icons — exact match with Comic OCR Studio (.bt / .btn-ico) */
    .btn-ico{width:15px;height:15px;flex:0 0 auto;stroke:currentColor;fill:none;stroke-width:1.85;stroke-linecap:round;stroke-linejoin:round}
    button,.bt{border:1px solid var(--line-2);background:var(--surface-2);color:var(--text);border-radius:9px;padding:7px 12px;cursor:pointer;transition:.16s;display:inline-flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;font-weight:600;font-size:12.5px}
    button:hover:not(:disabled),.bt:hover:not(:disabled){border-color:var(--a1);transform:translateY(-1px)}
    button:disabled,.bt:disabled{opacity:.46;cursor:not-allowed;transform:none}
    button.primary,.bt.primary{background:var(--grad);border-color:transparent;color:#fff;font-weight:700;box-shadow:0 8px 22px #8b7bff30}
    button.ok,button.success,.bt.success{background:var(--grad-ok);border-color:transparent;color:#05261c;font-weight:800}
    body.light button.ok,body.light button.success,body.light .bt.success{color:#fff}
    button.danger-ghost,button.danger,.bt.danger{color:var(--danger);border-color:#fb718548;background:color-mix(in srgb,var(--danger) 8%,var(--surface-2))}
    button.danger-solid{background:linear-gradient(135deg,#e11d48,#fb7185);border-color:transparent;color:#fff;font-weight:700}
    button.sm,.bt.sm{padding:4px 10px;font-size:11.5px;border-radius:8px}
    .icon-close{width:30px;height:30px;padding:0;border-radius:8px;font-size:16px}
    .setup-top-btn{background:color-mix(in srgb,var(--a1) 14%,var(--surface-2));border-color:color-mix(in srgb,var(--a1) 48%,var(--line-2));font-weight:700}

    /* Main Shell & Panels */
    .shell{max-width:1260px;margin:0 auto;padding:16px 18px 68px;display:flex;flex-direction:column;gap:14px}
    .panel,.card{background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:13px;padding:18px 20px;box-shadow:0 10px 28px #00000018}
    .status-strip{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:13px 18px}
    .status-strip-pills{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .status-strip-note{margin:6px 0 0;font-size:11.8px;color:var(--muted)}

    /* Pills & Badges — exact match with Studio .summary-pill / .lic-pill */
    .pill{display:inline-flex;align-items:center;gap:6px;padding:3.5px 11px;border-radius:999px;font-size:11.5px;font-weight:700;border:1px solid var(--line-2);background:var(--surface-2);color:var(--text);white-space:nowrap}
    .pill-dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}
    .pill-ok{border-color:#10b98166;background:color-mix(in srgb,#10b981 12%,var(--surface-2));color:#34d399}
    .pill-ok .pill-dot{background:#10b981;box-shadow:0 0 8px #10b98199}
    body.light .pill-ok{color:#047857}
    .pill-warn{border-color:#fbbf2466;background:color-mix(in srgb,#fbbf24 13%,var(--surface-2));color:#fbbf24}
    body.light .pill-warn{color:#b45309}
    .pill-danger{border-color:#fb718566;background:color-mix(in srgb,#fb7185 12%,var(--surface-2));color:#fb7185}
    body.light .pill-danger{color:#be123c}
    .pill-info{border-color:color-mix(in srgb,var(--a1) 50%,var(--line-2));background:color-mix(in srgb,var(--a1) 12%,var(--surface-2));color:var(--a2)}
    body.light .pill-info{color:#4f46e5}

    /* KPI Summary Grid */
    .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
    .kpi-card{background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:13px;padding:14px 16px;display:flex;flex-direction:column;gap:3px}
    .kpi-label{font-size:11.8px;color:var(--muted);font-weight:600}
    .kpi-val{font-size:24px;font-weight:800;letter-spacing:-.4px;line-height:1.3}
    .kpi-ok .kpi-val{color:#34d399}
    .kpi-warn .kpi-val{color:var(--warning)}
    .kpi-danger .kpi-val{color:var(--danger)}
    .kpi-info .kpi-val{color:var(--a1)}
    body.light .kpi-ok .kpi-val{color:#059669}
    body.light .kpi-warn .kpi-val{color:#b45309}
    body.light .kpi-danger .kpi-val{color:#e11d48}

    /* Navigation Tabs — Studio .action-group capsule bar */
    .tabs-bar{display:inline-flex;gap:6px;padding:5px;border-radius:12px;border:1px solid var(--line-2);background:color-mix(in srgb,var(--surface) 80%,var(--surface-2));width:fit-content;max-width:100%;flex-wrap:wrap}
    .tab-btn{background:transparent;color:var(--muted);border:1px solid transparent;padding:7px 15px;border-radius:9px;font-size:12.5px;font-weight:700;cursor:pointer;transition:.16s}
    .tab-btn:hover{color:var(--text);background:var(--surface-2);border-color:var(--line-2);transform:none}
    .tab-btn.active{background:var(--grad);color:#fff;border-color:transparent;box-shadow:0 6px 18px #8b7bff35}
    .tab-count{font-size:10.5px;padding:1px 7px;border-radius:999px;background:#ffffff28;color:inherit;font-weight:800}
    body.light .tab-btn:not(.active) .tab-count{background:var(--line);color:var(--text)}
    .tab-pane{display:none}
    .tab-pane.active{display:block}

    /* Forms & Inputs — exact match with Studio inputs */
    .sec-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
    .sec-head h2{margin:0;font-size:15.5px;font-weight:800;color:var(--text)}
    .form-grid-4{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
    .form-grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:12px}
    label.field{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted);font-weight:600}
    .req{color:var(--danger);margin-right:3px}
    input:not([type=checkbox]):not([type=file]),select,textarea{width:100%;border:1px solid var(--line-2);background:var(--bg);color:var(--text);border-radius:9px;padding:8px 11px;font-size:12.8px;outline:none;transition:border-color .15s,box-shadow .15s}
    input:focus,select:focus,textarea:focus{border-color:var(--a1);box-shadow:0 0 0 3px color-mix(in srgb,var(--a1) 20%,transparent)}
    .ltr{direction:ltr;text-align:left;font-family:Consolas,"Courier New",monospace;letter-spacing:.35px}

    /* Module Cards */
    .mod-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(285px,1fr));gap:12px;margin-top:12px}
    .mod-card{background:var(--surface-2);border:1px solid var(--line-2);border-radius:12px;padding:13px 15px;display:flex;flex-direction:column;gap:9px;transition:border-color .15s}
    .mod-card:hover{border-color:color-mix(in srgb,var(--a1) 55%,var(--line-2))}
    .mod-card-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
    .mod-card-title{font-weight:800;font-size:13.2px;color:var(--text)}
    .mod-card-desc{font-size:11.5px;color:var(--muted);margin-top:-4px}
    .quick-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}

    /* Issued Token Result Box */
    .result-box{margin-top:16px;padding:15px 17px;border-radius:12px;background:color-mix(in srgb,#10b981 9%,var(--surface));border:1.5px solid #10b98166}
    .preview-callout{margin-top:16px;padding:13px 15px;border-radius:11px;background:color-mix(in srgb,var(--a1) 8%,var(--surface));border:1px dashed color-mix(in srgb,var(--a1) 48%,var(--line-2))}

    /* Filters & Tables */
    .filter-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
    .filter-chip{padding:5px 12px;border-radius:999px;font-size:11.8px;background:var(--surface-2);border:1px solid var(--line-2);color:var(--muted);cursor:pointer;font-weight:600}
    .filter-chip.active{background:color-mix(in srgb,var(--a1) 18%,var(--surface-2));color:var(--a1);border-color:var(--a1);font-weight:800}
    .table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
    table{width:100%;border-collapse:collapse;font-size:12.5px}
    th,td{border-bottom:1px solid var(--line);padding:10px 12px;text-align:right;vertical-align:middle}
    th{color:var(--muted);font-weight:800;font-size:11.8px;background:var(--surface-2);white-space:nowrap}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:color-mix(in srgb,var(--a1) 4%,transparent)}
    .mod-mini-list{display:flex;gap:5px;flex-wrap:wrap}
    .mod-mini{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;border:1px solid var(--line-2);white-space:nowrap}
    .mod-mini.st-lifetime,.mod-mini.st-active{background:color-mix(in srgb,#10b981 13%,var(--surface-2));color:#34d399;border-color:#10b98155}
    body.light .mod-mini.st-lifetime,body.light .mod-mini.st-active{color:#047857}
    .mod-mini.st-expiring{background:color-mix(in srgb,#fbbf24 14%,var(--surface-2));color:#fbbf24;border-color:#fbbf2466}
    body.light .mod-mini.st-expiring{color:#b45309}
    .mod-mini.st-expired{background:color-mix(in srgb,#fb7185 13%,var(--surface-2));color:#fb7185;border-color:#fb718555}
    body.light .mod-mini.st-expired{color:#be123c}
    .mod-mini.st-none{color:var(--muted);background:var(--surface-2)}

    /* Dialogs (.dlg) & Confirmation Modal — exact match with Studio #appModalDialog */
    dialog.dlg{width:min(540px,calc(100vw - 24px));border:1px solid var(--line-2);border-radius:16px;background:var(--surface);color:var(--text);padding:18px;box-shadow:var(--shadow)}
    dialog.dlg::backdrop{background:#05070cb5;backdrop-filter:blur(5px)}
    .dialog-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
    .dialog-head h3{margin:0;font-size:15.5px;font-weight:800}
    .app-modal-title-wrap{display:flex;align-items:center;gap:10px}
    .app-modal-badge{width:28px;height:28px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;background:color-mix(in srgb,var(--warning) 18%,var(--surface-2));color:var(--warning);border:1px solid color-mix(in srgb,var(--warning) 45%,var(--line-2))}
    .app-modal-message{margin:4px 0 16px;font-size:13px;line-height:1.9;color:var(--text);white-space:pre-line}
    .dialog-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:16px}

    /* Bottom-Centered Toast — exact match with Studio #toast */
    .toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);z-index:999;padding:9px 18px;border-radius:999px;background:var(--surface-2);border:1px solid var(--a1);box-shadow:var(--shadow);font-size:12.5px;font-weight:700;color:var(--text);display:none;max-width:min(92vw,680px);text-align:center}
    .toast.err{border-color:var(--danger);background:color-mix(in srgb,var(--danger) 16%,var(--surface-2));color:var(--danger)}
    ::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:99px}
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <img class="logo" src="/assets/icon128.png" alt="">
      <div>
        <h1>Comic OCR Studio <span class="ver">۴.۲۰ · پنل فروشنده</span></h1>
        <span class="brand-sub">مدیریت کلید مادر ۲۵۶ بایتی، بانک مشتریان و صدور لایسنس ماژولار آفلاین</span>
      </div>
    </div>
    <div class="topbar-actions">
      <button type="button" id="openSetupTabHeroBtn" class="bt setup-top-btn" title="تعریف کلید مادر اختصاصی و اطلاعات تماس داخل فایل EXE">
        <svg class="btn-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2"/></svg>
        <span>تنظیم کلید مادر و اطلاعات EXE</span>
      </button>
      <button class="bt success" id="selfActivateBtn" type="button" title="فعال‌سازی دائمی هر ۳ ماژول روی همین کامپیوتر شما">
        <svg class="btn-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 4.3 6.5 11 2.8 7.3"/></svg>
        <span>فعال‌سازی دائمی سیستم خودم</span>
      </button>
      <button class="bt" id="backupKeyBtn" type="button" title="دانلود فایل پشتیبان کلید مادر ۲۵۶ بایتی و لیست مشتریان">
        <svg class="btn-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2v7.6M5.2 7l2.8 2.8L10.8 7M2.6 12.2v1.3h10.8v-1.3"/></svg>
        <span>پشتیبان کلید و مشتریان</span>
      </button>
      <label class="bt" style="margin:0;cursor:pointer" title="بازیابی فایل پشتیبان قبلی (.seller-key.json)">
        <svg class="btn-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10.2V2.6M5.2 5.4 8 2.6l2.8 2.8M2.6 12.2v1.3h10.8v-1.3"/></svg>
        <span>بازیابی پشتیبان</span>
        <input id="restoreKeyInput" type="file" accept=".json,application/json" hidden>
      </label>
      <button class="bt" id="sellerThemeBtn" type="button" title="تغییر تم روشن / تیره هماهنگ با برنامهٔ اصلی">
        <svg class="btn-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M12.8 9.8A5.4 5.4 0 0 1 6.2 3.2a5.5 5.5 0 1 0 6.6 6.6Z"/></svg>
        <span id="sellerThemeLabel">تم روشن / تیره</span>
      </button>
    </div>
  </header>

  <div class="shell">
    <section class="panel status-strip">
      <div>
        <div class="status-strip-pills">
          <span class="pill pill-ok"><span class="pill-dot" aria-hidden="true"></span><span id="keyBadge">در حال بررسی کلید مادر…</span></span>
          <span class="pill pill-info" id="schemeBadge">کلید مادر ۲۵۶ بایتی + Ed25519</span>
          <span class="pill pill-warn" id="thisPcBadge">کد سیستم شما: …</span>
        </div>
        <p class="status-strip-note">
          کلید مادر ۲۵۶ بایتی (۲۰۴۸ بیت) و کلید خصوصی امضای دیجیتال فقط روی سیستم خودتان نگهداری می‌شود و هرگز وارد پوشهٔ <code>dist</code> یا فایل نصاب <code>.exe</code> مشتری نمی‌شود.
        </p>
      </div>
    </section>

    <section class="kpi-grid">
      <div class="kpi-card kpi-info">
        <span class="kpi-label">کل مشتریان ثبت‌شده</span>
        <span class="kpi-val" id="kpiTotalCust">۰</span>
      </div>
      <div class="kpi-card kpi-ok">
        <span class="kpi-label">مشتریان دارای لایسنس فعال</span>
        <span class="kpi-val" id="kpiActiveCust">۰</span>
      </div>
      <div class="kpi-card kpi-warn">
        <span class="kpi-label">نزدیک به انقضا (کمتر از ۷ روز)</span>
        <span class="kpi-val" id="kpiExpiringCust">۰</span>
      </div>
      <div class="kpi-card kpi-danger">
        <span class="kpi-label">منقضی‌شده (آمادهٔ تماس و تمدید)</span>
        <span class="kpi-val" id="kpiExpiredCust">۰</span>
      </div>
    </section>

    <nav class="tabs-bar" role="tablist" aria-label="بخش‌های پنل فروشنده">
      <button class="tab-btn active" type="button" data-tab="issue">
        <svg class="btn-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="5.5" cy="8.5" r="2.8"/><path d="M8 7.5h6M11.5 7.5v2.3M13.5 7.5v1.8"/></svg>
        <span>صدور لایسنس جدید</span>
      </button>
      <button class="tab-btn" type="button" data-tab="customers">
        <svg class="btn-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.2" cy="5.5" r="2.3"/><path d="M2.2 13a4 4 0 0 1 8 0M11 4.2a2 2 0 0 1 0 3.8M13.8 13a3.3 3.3 0 0 0-2.5-3.1"/></svg>
        <span>لیست کاربران و مشتریان</span>
        <span class="tab-count" id="tabCustCount">۰</span>
      </button>
      <button class="tab-btn" type="button" data-tab="history">
        <svg class="btn-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M8 4.8v3.5l2.4 1.5"/></svg>
        <span>تاریخچهٔ کلیدهای صادرشده</span>
        <span class="tab-count" id="tabHistCount">۰</span>
      </button>
      <button class="tab-btn" type="button" data-tab="setup">
        <svg class="btn-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.9 13 4v3.8c0 3.2-2.1 5.4-5 6.3-2.9-.9-5-3.1-5-6.3V4l5-2.1Z"/></svg>
        <span>کلید مادر و اطلاعات داخل EXE</span>
      </button>
    </nav>

    <!-- TAB 1: ISSUE LICENSE -->
    <section id="pane-issue" class="tab-pane active">
      <div class="panel">
        <div class="sec-head">
          <h2>مشخصات خریدار و صدور کلید لایسنس ماژولار</h2>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select id="quickFillCustomer" style="width:auto;min-width:255px">
              <option value="">انتخاب سریع از مشتریان قبلی (تمدید)…</option>
            </select>
            <button type="button" class="bt sm" id="clearIssueFormBtn">پاک‌کردن فرم</button>
          </div>
        </div>

        <input type="hidden" id="custIdHidden" value="">
        <div class="form-grid-4">
          <label class="field">
            <span>نام مشتری <span class="req">*</span></span>
            <input id="custFirstName" placeholder="مثلاً: علی" autocomplete="off" required>
          </label>
          <label class="field">
            <span>نام خانوادگی مشتری <span class="req">*</span></span>
            <input id="custLastName" placeholder="مثلاً: محمدی" autocomplete="off" required>
          </label>
          <label class="field">
            <span>شماره موبایل <span class="req">*</span></span>
            <input id="custPhone" class="ltr" placeholder="09123456789" autocomplete="off" required>
          </label>
          <label class="field">
            <span>کد سیستم مشتری (System Code) <span class="req">*</span></span>
            <input id="custHwid" class="ltr" placeholder="CS4-XXXX-XXXX-XXXX-XXXX" autocomplete="off" required>
          </label>
        </div>

        <div class="form-grid-2">
          <label class="field">
            <span>یادداشت فروشنده (اختیاری — آیدی تلگرام، شماره سفارش، مبلغ و…)</span>
            <input id="custNote" placeholder="مثلاً: تلگرام @ali_m — پرداخت کارت‌به‌کارت" autocomplete="off">
          </label>
        </div>

        <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line)">
          <div class="sec-head" style="margin-bottom:10px">
            <strong style="font-size:13.5px;color:var(--a2)">تعیین وضعیت و مدت اعتبار هر یک از ۳ بخش نرم‌افزار:</strong>
            <div class="quick-bar">
              <button type="button" class="bt sm" data-quick="all:lifetime">هر ۳ بخش دائمی</button>
              <button type="button" class="bt sm" data-quick="all:sub:30">هر ۳ بخش ۱ ماهه (۳۰ روز)</button>
              <button type="button" class="bt sm" data-quick="all:sub:365">هر ۳ بخش ۱ ساله</button>
              <button type="button" class="bt sm" data-quick="only:ocr">فقط OCR (۳۰ روز)</button>
              <button type="button" class="bt sm" data-quick="only:translation">فقط ترجمه (۳۰ روز)</button>
              <button type="button" class="bt sm" data-quick="only:editing">فقط ویرایش (۳۰ روز)</button>
            </div>
          </div>

          <div class="mod-cards">
            <div class="mod-card">
              <div class="mod-card-head"><span class="mod-card-title">۱. استخراج متن (OCR آفلاین)</span></div>
              <span class="mod-card-desc">اجرای موتورهای OCR و مدیریت مدل‌های تشخیص متن</span>
              <select id="plan_ocr" class="mod-select" data-mod="ocr">
                <option value="lifetime" selected>فعال — دائمی (مادام‌العمر)</option>
                <option value="sub:30">فعال — ۱ ماهه (۳۰ روز)</option>
                <option value="sub:90">فعال — ۳ ماهه (۹۰ روز)</option>
                <option value="sub:180">فعال — ۶ ماهه (۱۸۰ روز)</option>
                <option value="sub:365">فعال — ۱ ساله (۳۶۵ روز)</option>
                <option value="trial:3">فعال — آزمایشی ۳ روزه</option>
                <option value="custom">فعال — تعداد روز دلخواه…</option>
                <option value="none">غیرفعال در این کلید</option>
              </select>
              <input id="days_ocr" type="number" min="1" max="3650" value="30" placeholder="تعداد روز دلخواه" style="display:none">
            </div>

            <div class="mod-card">
              <div class="mod-card-head"><span class="mod-card-title">۲. ترجمه (آنلاین و آفلاین)</span></div>
              <span class="mod-card-desc">مترجم رایگان، مترجم عصبی آفلاین و کلیدهای هوش مصنوعی</span>
              <select id="plan_translation" class="mod-select" data-mod="translation">
                <option value="lifetime" selected>فعال — دائمی (مادام‌العمر)</option>
                <option value="sub:30">فعال — ۱ ماهه (۳۰ روز)</option>
                <option value="sub:90">فعال — ۳ ماهه (۹۰ روز)</option>
                <option value="sub:180">فعال — ۶ ماهه (۱۸۰ روز)</option>
                <option value="sub:365">فعال — ۱ ساله (۳۶۵ روز)</option>
                <option value="trial:3">فعال — آزمایشی ۳ روزه</option>
                <option value="custom">فعال — تعداد روز دلخواه…</option>
                <option value="none">غیرفعال در این کلید</option>
              </select>
              <input id="days_translation" type="number" min="1" max="3650" value="30" placeholder="تعداد روز دلخواه" style="display:none">
            </div>

            <div class="mod-card">
              <div class="mod-card-head"><span class="mod-card-title">۳. ویرایش (ویرایشگر، برش، واترمارک)</span></div>
              <span class="mod-card-desc">ویرایش متن روی تصویر، حباب‌گذاری، کراپ و واترمارک</span>
              <select id="plan_editing" class="mod-select" data-mod="editing">
                <option value="lifetime" selected>فعال — دائمی (مادام‌العمر)</option>
                <option value="sub:30">فعال — ۱ ماهه (۳۰ روز)</option>
                <option value="sub:90">فعال — ۳ ماهه (۹۰ روز)</option>
                <option value="sub:180">فعال — ۶ ماهه (۱۸۰ روز)</option>
                <option value="sub:365">فعال — ۱ ساله (۳۶۵ روز)</option>
                <option value="trial:3">فعال — آزمایشی ۳ روزه</option>
                <option value="custom">فعال — تعداد روز دلخواه…</option>
                <option value="none">غیرفعال در این کلید</option>
              </select>
              <input id="days_editing" type="number" min="1" max="3650" value="30" placeholder="تعداد روز دلخواه" style="display:none">
            </div>
          </div>
        </div>

        <div style="margin-top:18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <button class="bt primary" id="issueBtn" type="button" style="padding:9px 20px;font-size:13.2px">
            <svg class="btn-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 4.3 6.5 11 2.8 7.3"/></svg>
            <span>ثبت مشتری و صدور کلید لایسنس امضاشده</span>
          </button>
          <span style="font-size:12px;color:var(--muted)">پس از صدور، نام، نام خانوادگی و موبایل مشتری خودکار در «لیست کاربران» ذخیره می‌شود.</span>
        </div>

        <div id="issuedResult" class="result-box" style="display:none">
          <div style="font-size:13px;color:#34d399;font-weight:800;margin-bottom:8px" id="issuedMeta"></div>
          <textarea id="issuedToken" class="ltr" rows="3" readonly style="width:100%"></textarea>
          <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
            <button class="bt primary" id="copyTokenBtn" type="button">کپی کلید لایسنس</button>
            <button class="bt success" id="copyReadyMsgBtn" type="button">کپی پیام آمادهٔ ارسال برای مشتری (تلگرام / واتساپ / پیامک)</button>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 2: CUSTOMERS CRM -->
    <section id="pane-customers" class="tab-pane">
      <div class="panel">
        <div class="sec-head">
          <h2>بانک اطلاعات کاربران و مشتریان</h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="bt" id="addCustomerManualBtn">+ ثبت مشتری جدید بدون صدور آنی</button>
            <button type="button" class="bt primary" id="exportCsvBtn">خروجی اکسل (CSV)</button>
          </div>
        </div>

        <div class="filter-bar">
          <input id="custSearchBox" placeholder="جستجوی نام، نام خانوادگی، شماره موبایل، کد سیستم یا یادداشت…" style="min-width:280px;flex:1">
          <button type="button" class="filter-chip active" data-cfilter="all">همه</button>
          <button type="button" class="filter-chip" data-cfilter="active">دارای لایسنس فعال</button>
          <button type="button" class="filter-chip" data-cfilter="expiring">نزدیک به انقضا</button>
          <button type="button" class="filter-chip" data-cfilter="expired">منقضی‌شده</button>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>نام و نام خانوادگی</th>
                <th>شماره موبایل</th>
                <th>کد(های) سیستم</th>
                <th>وضعیت لحظه‌ای ماژول‌ها</th>
                <th>کلیدها</th>
                <th>عملیات سریع</th>
              </tr>
            </thead>
            <tbody id="customersBody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 3: ISSUED KEYS HISTORY -->
    <section id="pane-history" class="tab-pane">
      <div class="panel">
        <div class="sec-head">
          <h2>تاریخچهٔ کامل کلیدهای صادرشده</h2>
          <input id="searchBox" placeholder="جستجوی نام، موبایل یا کد سیستم…" style="width:auto;min-width:280px">
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>تاریخ صدور</th>
                <th>مشتری</th>
                <th>شماره موبایل</th>
                <th>ماژول‌ها و اعتبار</th>
                <th>کد سیستم</th>
                <th>عملیات</th>
              </tr>
            </thead>
            <tbody id="historyBody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 4: MASTER KEY & PRE-EXE VENDOR CONTACT SETUP -->
    <section id="pane-setup" class="tab-pane">
      <div class="panel" style="margin-bottom:14px">
        <div class="sec-head">
          <h2>۱. تعریف یا تغییر کلید مادر ۲۵۶ بایتی شما (قبل از ساخت فایل EXE)</h2>
          <span class="pill pill-ok" id="setupFpPill">شناسهٔ فعلی: …</span>
        </div>
        <p style="font-size:12.5px;color:var(--muted);margin:0 0 14px">
          شما می‌توانید <strong>خودتان هر کلید یا عبارت رمزی دلخواه</strong> (حداقل ۱۶ کاراکتر — مثلاً یک جمله یا رمز طولانی شخصی، و یا ۵۱۲ کاراکتر هگز ۲۵۶ بایتی) به برنامه بدهید، یا با دکمهٔ زیر یک کلید تصادفی ۲۵۶ بایتی بسازید. به محض زدن «ثبت کلید مادر»، کلید خصوصی فقط روی سیستم خودتان ذخیره می‌شود و کلید عمومی تأیید خودکار در کدهای برنامه قرار می‌گیرد تا هنگام اجرای <code>build_windows_offline.bat</code> داخل فایل <code>.exe</code> پخته شود.
        </p>

        <div class="form-grid-2" style="margin-top:0;margin-bottom:12px">
          <label class="field">
            <span>کلید عمومی فعلی داخل برنامه (PUBLIC_VERIFY_KEY — بی‌خطر برای قرارگیری در EXE):</span>
            <input id="currentPublicKeyBox" class="ltr" readonly>
          </label>
          <label class="field">
            <span>کلید مادر ۲۵۶ بایتی فعلی شما (محرمانه — فقط روی سیستم شما):</span>
            <div style="display:flex;gap:6px">
              <input id="currentMasterHexBox" class="ltr" value="••••••••••••••••••••••••••••••••" readonly style="flex:1">
              <button type="button" id="revealCurrentMasterBtn" class="bt sm">نمایش و کپی</button>
            </div>
          </label>
        </div>

        <label class="field">
          <span>ورود دستی کلید مادر دلخواه خودتان (عبارت رمزی اختصاصی حداقل ۱۶ کاراکتری، یا ۵۱۲ کاراکتر هگز ۲۵۶ بایتی):</span>
          <textarea id="customMasterInput" class="ltr" rows="3" placeholder="اینجا کلید مادر یا رمز طولانی اختصاصی خودتان را بنویسید، یا دکمهٔ «ساخت پیشنهادی کلید ۲۵۶ بایتی تصادفی» را بزنید…"></textarea>
        </label>

        <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <button type="button" class="bt" id="genRandomMasterBtn">ساخت پیشنهادی کلید ۲۵۶ بایتی تصادفی در کادر بالا</button>
          <button type="button" class="bt primary" id="saveCustomMasterBtn">ثبت این کلید مادر و همگام‌سازی برای ساخت EXE</button>
        </div>
      </div>

      <div class="panel">
        <div class="sec-head">
          <h2>۲. ویرایش اطلاعات تماس، پیام‌رسان‌ها و سایت داخل نرم‌افزار مشتری (قبل از ساخت EXE)</h2>
          <span class="pill pill-info">ذخیره در vendor_contact.json و هستهٔ EXE</span>
        </div>
        <p style="font-size:12.5px;color:var(--muted);margin:0 0 14px">
          هر اطلاعاتی که در کادرهای زیر وارد و ذخیره کنید، مستقیماً در صفحهٔ قفل و پنجرهٔ لایسنس برنامهٔ مشتری نمایش داده می‌شود (هر کادری را هم که خالی بگذارید، به صورت خودکار در برنامهٔ مشتری مخفی می‌ماند). پس از ذخیره، کافی است <code>build_windows_offline.bat</code> را اجرا کنید تا فایل نصاب <code>.exe</code> دقیقاً با همین مشخصات ساخته شود.
        </p>

        <div class="form-grid-4">
          <label class="field">
            <span>شماره تماس فروش و پشتیبانی <span class="req">*</span></span>
            <input id="vcSupportPhone" class="ltr" placeholder="09361111111">
          </label>
          <label class="field">
            <span>شماره یا آیدی واتساپ (اختیاری)</span>
            <input id="vcWhatsapp" class="ltr" placeholder="09361111111">
          </label>
          <label class="field">
            <span>آیدی یا لینک تلگرام (اختیاری)</span>
            <input id="vcTelegram" class="ltr" placeholder="@YourTelegramID">
          </label>
          <label class="field">
            <span>پیام‌رسان داخلی — ایتا / بله / روبیکا (اختیاری)</span>
            <input id="vcDomestic" placeholder="مثلاً: ایتا @YourID">
          </label>
        </div>

        <div class="form-grid-2">
          <label class="field">
            <span>ساعات پاسخ‌گویی پشتیبانی (اختیاری)</span>
            <input id="vcHours" placeholder="مثلاً: پاسخ‌گویی همه‌روزه از ساعت ۹ صبح تا ۱۰ شب">
          </label>
          <label class="field">
            <span>آدرس وب‌سایت، کانال یا صفحهٔ تعرفه و خرید (اختیاری)</span>
            <input id="vcWebsite" class="ltr" placeholder="https://your-site.ir">
          </label>
        </div>

        <div style="margin-top:12px">
          <label class="field">
            <span>توضیح کوتاه تکمیلی برای خریدار در صفحهٔ لایسنس (اختیاری)</span>
            <input id="vcNote" placeholder="مثلاً: برای دریافت آنی لایسنس، «متن آمادهٔ سفارش» را کپی کرده و در تلگرام یا واتساپ بفرستید.">
          </label>
        </div>

        <div class="preview-callout">
          <strong style="font-size:12px;color:var(--a2);display:block;margin-bottom:6px">پیش‌نمایش زنده در نرم‌افزار مشتری:</strong>
          <div id="vcLivePreview" style="font-size:12.5px;color:var(--text);display:flex;flex-direction:column;gap:4px"></div>
        </div>

        <div style="margin-top:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <button type="button" class="bt success" id="saveVendorContactBtn" style="padding:9px 20px;font-size:13.2px">ذخیرهٔ اطلاعات تماس در برنامه (آماده برای ساخت EXE)</button>
        </div>
      </div>
    </section>
  </div>

  <!-- Edit / Add Customer Modal -->
  <dialog id="custEditModal" class="dlg">
    <div class="dialog-head">
      <h3 id="custModalTitle">ویرایش مشخصات مشتری</h3>
      <button id="modalCloseXBtn" class="bt icon-close" type="button" aria-label="بستن">×</button>
    </div>
    <input type="hidden" id="modalCustId">
    <div style="display:flex;flex-direction:column;gap:10px">
      <label class="field"><span>نام <span class="req">*</span></span><input id="modalFirstName"></label>
      <label class="field"><span>نام خانوادگی <span class="req">*</span></span><input id="modalLastName"></label>
      <label class="field"><span>شماره موبایل <span class="req">*</span></span><input id="modalPhone" class="ltr" placeholder="09123456789"></label>
      <label class="field"><span>کد سیستم (اختیاری)</span><input id="modalHwid" class="ltr" placeholder="CS4-XXXX-XXXX-XXXX-XXXX"></label>
      <label class="field"><span>یادداشت فروشنده</span><input id="modalNote"></label>
    </div>
    <div class="dialog-actions">
      <button type="button" class="bt" id="modalCancelBtn">انصراف</button>
      <button type="button" class="bt primary" id="modalSaveBtn">ذخیرهٔ اطلاعات مشتری</button>
    </div>
  </dialog>

  <!-- Themed Confirmation Modal (matches Studio #appModalDialog — zero native confirm) -->
  <dialog id="sellerConfirmDialog" class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="sellerConfirmTitle" aria-describedby="sellerConfirmMessage">
    <div class="dialog-head">
      <div class="app-modal-title-wrap">
        <span class="app-modal-badge" aria-hidden="true">؟</span>
        <h3 id="sellerConfirmTitle">تأیید عملیات</h3>
      </div>
      <button id="sellerConfirmClose" class="bt icon-close" type="button" aria-label="بستن">×</button>
    </div>
    <p id="sellerConfirmMessage" class="app-modal-message" dir="rtl"></p>
    <div class="dialog-actions">
      <button id="sellerConfirmCancel" class="bt" type="button">انصراف</button>
      <button id="sellerConfirmAccept" class="bt primary" type="button">تأیید</button>
    </div>
  </dialog>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <script>
    const SECRET = new URLSearchParams(location.search).get('secret') || '';
    const THEME_STORAGE_KEY = 'comic-studio-theme';
    let SUPPORT_PHONE = '09361111111';
    let vendorContact = {};
    const MODS = ['ocr', 'translation', 'editing'];
    const SHORT_MOD = { ocr: 'OCR', translation: 'ترجمه', editing: 'ویرایش' };
    let historyItems = [];
    let customerItems = [];
    let custFilter = 'all';
    let lastIssued = null;
    let confirmResolver = null;
    const $ = (id) => document.getElementById(id);

    function applyTheme(mode) {
      const isLight = mode === 'light';
      document.body.classList.toggle('light', isLight);
      $('sellerThemeLabel').textContent = isLight ? 'تم تیره' : 'تم روشن';
    }
    try {
      applyTheme(localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark');
    } catch { applyTheme('dark'); }
    $('sellerThemeBtn').addEventListener('click', () => {
      const next = document.body.classList.contains('light') ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch {}
    });

    function sellerConfirm(message, { title = 'تأیید عملیات', confirmText = 'تأیید', danger = false } = {}) {
      const dlg = $('sellerConfirmDialog');
      $('sellerConfirmTitle').textContent = title;
      $('sellerConfirmMessage').textContent = message;
      const okBtn = $('sellerConfirmAccept');
      okBtn.textContent = confirmText;
      okBtn.className = danger ? 'bt danger-solid' : 'bt primary';
      return new Promise((resolve) => {
        confirmResolver = resolve;
        if (!dlg.open) dlg.showModal();
        okBtn.focus();
      });
    }
    function closeSellerConfirm(accepted) {
      const dlg = $('sellerConfirmDialog');
      if (dlg.open) dlg.close();
      if (confirmResolver) {
        const fn = confirmResolver;
        confirmResolver = null;
        fn(Boolean(accepted));
      }
    }
    $('sellerConfirmAccept').onclick = () => closeSellerConfirm(true);
    $('sellerConfirmCancel').onclick = () => closeSellerConfirm(false);
    $('sellerConfirmClose').onclick = () => closeSellerConfirm(false);
    $('sellerConfirmDialog').addEventListener('cancel', (ev) => { ev.preventDefault(); closeSellerConfirm(false); });

    function toFaNum(n) {
      return Number(n || 0).toLocaleString('fa-IR');
    }

    function notify(msg, err = false) {
      const el = $('toast'); el.textContent = msg;
      el.className = err ? 'toast err' : 'toast'; el.style.display = 'block';
      clearTimeout(notify._t); notify._t = setTimeout(() => { el.style.display = 'none'; }, 3600);
    }

    async function callApi(path, method = 'GET', body = null) {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Seller-Secret': SECRET },
        body: body ? JSON.stringify(body) : null,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'خطا در عملیات');
      return data;
    }

    function switchTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + tabId));
    }
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    $('openSetupTabHeroBtn').onclick = () => switchTab('setup');

    function syncCustomDaysVisibility() {
      for (const m of MODS) {
        $('days_' + m).style.display = $('plan_' + m).value === 'custom' ? 'block' : 'none';
      }
    }
    document.querySelectorAll('.mod-select').forEach((sel) => sel.addEventListener('change', syncCustomDaysVisibility));
    document.querySelectorAll('[data-quick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const q = btn.getAttribute('data-quick') || '';
        if (q.startsWith('all:')) {
          const val = q.slice(4);
          MODS.forEach((m) => { $('plan_' + m).value = val; });
        } else if (q.startsWith('only:')) {
          const target = q.slice(5);
          MODS.forEach((m) => { $('plan_' + m).value = (m === target ? 'sub:30' : 'none'); });
        }
        syncCustomDaysVisibility();
      });
    });

    function collectModulesSpec() {
      const out = {};
      for (const m of MODS) {
        const preset = $('plan_' + m).value;
        if (preset === 'none') continue;
        if (preset === 'lifetime') out[m] = { plan: 'lifetime' };
        else if (preset.startsWith('sub:')) out[m] = { plan: 'subscription', days: Number(preset.split(':')[1]) };
        else if (preset.startsWith('trial:')) out[m] = { plan: 'trial', days: Number(preset.split(':')[1]) };
        else if (preset === 'custom') out[m] = { plan: 'subscription', days: Number($('days_' + m).value || 30) };
      }
      return out;
    }

    function buildReadyMessage(item) {
      const modLines = [];
      if (item.modules) {
        for (const m of MODS) {
          if (item.modules[m]) modLines.push(`  • ${item.modules[m].label}: ${item.modules[m].planLabel}`);
        }
      }
      const contactTail = [`📞 تماس و پشتیبانی: ${SUPPORT_PHONE}`];
      if (vendorContact.telegram) contactTail.push(`✈️ تلگرام: ${vendorContact.telegram}`);
      if (vendorContact.whatsapp) contactTail.push(`💬 واتساپ: ${vendorContact.whatsapp}`);
      if (vendorContact.domesticMessenger) contactTail.push(`📱 پیام‌رسان داخلی: ${vendorContact.domesticMessenger}`);
      if (vendorContact.website) contactTail.push(`🌐 وب‌سایت: ${vendorContact.website}`);
      return [
        `سلام ${item.holder || ''} عزیز، وقت بخیر 🌸`,
        `لایسنس رسمی برنامهٔ Comic OCR Studio برای سیستم شما صادر شد:`,
        `👤 نام خریدار: ${item.holder}`,
        item.phone ? `📱 شماره تماس ثبت‌شده: ${item.phone}` : null,
        `🖥 کد سیستم: ${item.hardwareId}`,
        `🧩 بخش‌های فعال‌شده و مدت اعتبار:`,
        ...(modLines.length ? modLines : [`  • ${item.planLabel}`]),
        ``,
        `🔑 کلید فعال‌سازی شما:`,
        item.token,
        ``,
        `در برنامه وارد بخش «لایسنس و رمز ورود» شوید، کلید بالا را جای‌گذاری کرده و دکمهٔ «فعال‌سازی لایسنس» را بزنید.`,
        ...contactTail,
      ].filter((x) => x !== null).join('\\n');
    }

    function prefillIssueFromCustomer(c) {
      $('custIdHidden').value = c.customerId || '';
      $('custFirstName').value = c.firstName || '';
      $('custLastName').value = c.lastName || '';
      $('custPhone').value = c.phone || '';
      $('custHwid').value = (c.hardwareIds && c.hardwareIds[0]) ? c.hardwareIds[0] : '';
      $('custNote').value = c.note || '';
      switchTab('issue');
      $('custFirstName').focus();
      notify(`مشخصات «${c.fullName}» برای صدور یا تمدید لایسنس بارگذاری شد.`);
    }

    $('clearIssueFormBtn').onclick = () => {
      $('custIdHidden').value = '';
      $('custFirstName').value = '';
      $('custLastName').value = '';
      $('custPhone').value = '';
      $('custHwid').value = '';
      $('custNote').value = '';
      $('quickFillCustomer').value = '';
    };

    $('quickFillCustomer').onchange = () => {
      const cid = $('quickFillCustomer').value;
      const found = customerItems.find((c) => c.customerId === cid);
      if (found) prefillIssueFromCustomer(found);
    };

    function renderQuickSelect() {
      const sel = $('quickFillCustomer');
      const prev = sel.value;
      sel.innerHTML = '<option value="">انتخاب سریع از مشتریان قبلی (تمدید)…</option>';
      for (const c of customerItems) {
        const opt = document.createElement('option');
        opt.value = c.customerId;
        opt.textContent = `${c.fullName} — ${c.phone}`;
        sel.appendChild(opt);
      }
      sel.value = prev;
    }

    function renderCustomers() {
      const q = ($('custSearchBox').value || '').trim().toLowerCase();
      const rows = customerItems.filter((c) => {
        if (custFilter !== 'all' && c.overallStatus !== custFilter) return false;
        if (!q) return true;
        const hay = [c.fullName, c.firstName, c.lastName, c.phone, c.note, ...(c.hardwareIds || [])].join(' ').toLowerCase();
        return hay.includes(q);
      });
      const tbody = $('customersBody');
      tbody.innerHTML = '';
      if (!rows.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="6" style="text-align:center;color:var(--muted);padding:24px">مشتری با این مشخصات یافت نشد.</td>';
        tbody.appendChild(tr);
        return;
      }
      for (const c of rows) {
        const tr = document.createElement('tr');

        const tdName = document.createElement('td');
        const strong = document.createElement('strong');
        strong.textContent = c.fullName || `${c.firstName} ${c.lastName}`;
        tdName.appendChild(strong);
        if (c.note) {
          const noteDiv = document.createElement('div');
          noteDiv.style.cssText = 'font-size:11.5px;color:var(--muted);margin-top:2px';
          noteDiv.textContent = c.note;
          tdName.appendChild(noteDiv);
        }

        const tdPhone = document.createElement('td');
        tdPhone.className = 'ltr';
        tdPhone.textContent = c.phone || '—';

        const tdHw = document.createElement('td');
        tdHw.className = 'ltr';
        tdHw.style.fontSize = '12px';
        tdHw.textContent = (c.hardwareIds && c.hardwareIds.length) ? c.hardwareIds.join(' , ') : '—';

        const tdMods = document.createElement('td');
        const wrap = document.createElement('div');
        wrap.className = 'mod-mini-list';
        for (const m of MODS) {
          const info = (c.modulesLive && c.modulesLive[m]) || { state: 'none', text: '—' };
          const sp = document.createElement('span');
          sp.className = 'mod-mini st-' + info.state;
          sp.textContent = `${SHORT_MOD[m]}: ${info.text}`;
          wrap.appendChild(sp);
        }
        tdMods.appendChild(wrap);

        const tdCount = document.createElement('td');
        tdCount.textContent = toFaNum(c.issuedCount || 0);

        const tdAct = document.createElement('td');
        const actWrap = document.createElement('div');
        actWrap.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';

        const renewBtn = document.createElement('button');
        renewBtn.className = 'bt sm success';
        renewBtn.textContent = 'تمدید / صدور کلید';
        renewBtn.onclick = () => prefillIssueFromCustomer(c);

        const editBtn = document.createElement('button');
        editBtn.className = 'bt sm';
        editBtn.textContent = 'ویرایش';
        editBtn.onclick = () => openCustomerModal(c);

        const delBtn = document.createElement('button');
        delBtn.className = 'bt sm danger';
        delBtn.textContent = 'حذف';
        delBtn.onclick = async () => {
          const confirmed = await sellerConfirm(
            `آیا از حذف «${c.fullName}» از بانک مشتریان مطمئن هستید؟`,
            { title: 'حذف مشتری از لیست', confirmText: 'بله، حذف شود', danger: true }
          );
          if (!confirmed) return;
          try {
            await callApi('/api/customer/delete', 'POST', { customer_id: c.customerId });
            await refreshInfo();
            notify('مشتری از لیست حذف شد.');
          } catch (e) { notify(e.message, true); }
        };

        actWrap.append(renewBtn, editBtn, delBtn);
        tdAct.appendChild(actWrap);
        tr.append(tdName, tdPhone, tdHw, tdMods, tdCount, tdAct);
        tbody.appendChild(tr);
      }
    }

    document.querySelectorAll('[data-cfilter]').forEach((chip) => {
      chip.addEventListener('click', () => {
        custFilter = chip.getAttribute('data-cfilter') || 'all';
        document.querySelectorAll('[data-cfilter]').forEach((c) => c.classList.toggle('active', c === chip));
        renderCustomers();
      });
    });
    $('custSearchBox').oninput = renderCustomers;

    function openCustomerModal(cust = null) {
      $('custModalTitle').textContent = cust ? 'ویرایش مشخصات مشتری' : 'ثبت مشتری جدید';
      $('modalCustId').value = cust?.customerId || '';
      $('modalFirstName').value = cust?.firstName || '';
      $('modalLastName').value = cust?.lastName || '';
      $('modalPhone').value = cust?.phone || '';
      $('modalHwid').value = (cust?.hardwareIds && cust.hardwareIds[0]) ? cust.hardwareIds[0] : '';
      $('modalNote').value = cust?.note || '';
      $('custEditModal').showModal();
    }
    $('addCustomerManualBtn').onclick = () => openCustomerModal(null);
    $('modalCancelBtn').onclick = () => $('custEditModal').close();
    $('modalCloseXBtn').onclick = () => $('custEditModal').close();
    $('modalSaveBtn').onclick = async () => {
      try {
        await callApi('/api/customer/save', 'POST', {
          customer_id: $('modalCustId').value,
          first_name: $('modalFirstName').value,
          last_name: $('modalLastName').value,
          phone: $('modalPhone').value,
          hardware_id: $('modalHwid').value,
          note: $('modalNote').value,
        });
        $('custEditModal').close();
        await refreshInfo();
        notify('مشخصات مشتری ذخیره شد.');
      } catch (e) { notify(e.message, true); }
    };

    $('exportCsvBtn').onclick = async () => {
      try {
        const res = await fetch('/api/customers.csv', { headers: { 'X-Seller-Secret': SECRET } });
        if (!res.ok) throw new Error('خطا در دریافت خروجی اکسل');
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `ComicOCRStudio-Customers-${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        notify('فایل اکسل (CSV) لیست مشتریان دانلود شد.');
      } catch (e) { notify(e.message, true); }
    };

    function renderHistory() {
      const q = ($('searchBox').value || '').trim().toLowerCase();
      const rows = historyItems.filter((it) => {
        if (!q) return true;
        return [it.holder, it.firstName, it.lastName, it.phone, it.hardwareId, it.planLabel].join(' ').toLowerCase().includes(q);
      });
      const tbody = $('historyBody'); tbody.innerHTML = '';
      if (!rows.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="6" style="text-align:center;color:var(--muted);padding:24px">هنوز کلید لایسنسی صادر نشده است.</td>';
        tbody.appendChild(tr); return;
      }
      for (const item of rows) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td'); td1.textContent = item.issuedIso || ''; td1.className = 'ltr'; td1.style.fontSize = '12px';
        const td2 = document.createElement('td'); td2.textContent = item.holder || '';
        const td3 = document.createElement('td'); td3.textContent = item.phone || '—'; td3.className = 'ltr';
        const td4 = document.createElement('td'); td4.textContent = item.planLabel || '';
        const td5 = document.createElement('td'); td5.textContent = item.hardwareId || ''; td5.className = 'ltr'; td5.style.fontSize = '12px';
        const td6 = document.createElement('td');
        const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
        const btnKey = document.createElement('button'); btnKey.className = 'bt sm'; btnKey.textContent = 'کپی کلید';
        btnKey.onclick = async () => { await navigator.clipboard.writeText(item.token); notify('کلید لایسنس کپی شد.'); };
        const btnMsg = document.createElement('button'); btnMsg.className = 'bt sm success'; btnMsg.textContent = 'پیام آماده';
        btnMsg.onclick = async () => { await navigator.clipboard.writeText(buildReadyMessage(item)); notify('پیام آمادهٔ ارسال کپی شد.'); };
        wrap.append(btnKey, btnMsg);
        td6.appendChild(wrap);
        tr.append(td1, td2, td3, td4, td5, td6);
        tbody.appendChild(tr);
      }
    }

    function collectVendorForm() {
      return {
        supportPhone: ($('vcSupportPhone').value || '').trim(),
        whatsapp: ($('vcWhatsapp').value || '').trim(),
        telegram: ($('vcTelegram').value || '').trim(),
        domesticMessenger: ($('vcDomestic').value || '').trim(),
        supportHours: ($('vcHours').value || '').trim(),
        website: ($('vcWebsite').value || '').trim(),
        customNote: ($('vcNote').value || '').trim(),
      };
    }

    function updateVendorLivePreview() {
      const vc = collectVendorForm();
      const box = $('vcLivePreview');
      box.innerHTML = '';
      const addLine = (txt) => {
        const d = document.createElement('div');
        d.textContent = txt;
        box.appendChild(d);
      };
      addLine(`📞 تلفن دریافت و تمدید لایسنس: ${vc.supportPhone || '09361111111'}`);
      if (vc.whatsapp) addLine(`💬 واتساپ / پیامک: ${vc.whatsapp}`);
      if (vc.telegram) addLine(`✈️ تلگرام: ${vc.telegram}`);
      if (vc.domesticMessenger) addLine(`📱 پیام‌رسان داخلی: ${vc.domesticMessenger}`);
      if (vc.supportHours) addLine(`🕒 ساعات پاسخ‌گویی: ${vc.supportHours}`);
      if (vc.website) addLine(`🌐 وب‌سایت / خرید: ${vc.website}`);
      if (vc.customNote) addLine(`📌 راهنما: ${vc.customNote}`);
    }
    ['vcSupportPhone', 'vcWhatsapp', 'vcTelegram', 'vcDomestic', 'vcHours', 'vcWebsite', 'vcNote'].forEach((id) => {
      $(id).addEventListener('input', updateVendorLivePreview);
    });

    function populateSetupTab(info) {
      $('setupFpPill').textContent = `شناسهٔ فعلی: ${info.fingerprint}`;
      $('currentPublicKeyBox').value = info.publicKeyHex || '';
      const vc = info.vendorContact || {};
      vendorContact = vc;
      if (document.activeElement?.id?.startsWith('vc')) return;
      $('vcSupportPhone').value = vc.supportPhone || info.supportPhone || '09361111111';
      $('vcWhatsapp').value = vc.whatsapp || '';
      $('vcTelegram').value = vc.telegram || '';
      $('vcDomestic').value = vc.domesticMessenger || '';
      $('vcHours').value = vc.supportHours || '';
      $('vcWebsite').value = vc.website || '';
      $('vcNote').value = vc.customNote || '';
      updateVendorLivePreview();
    }

    $('revealCurrentMasterBtn').onclick = async () => {
      try {
        const data = await callApi('/api/master-secret');
        $('currentMasterHexBox').value = data.masterSecret256bHex;
        await navigator.clipboard.writeText(data.masterSecret256bHex);
        notify('کلید مادر ۲۵۶ بایتی فعلی نمایش داده شد و در کلیپ‌بورد کپی گردید.');
      } catch (e) { notify(e.message, true); }
    };

    $('genRandomMasterBtn').onclick = async () => {
      try {
        const data = await callApi('/api/random-master-key');
        $('customMasterInput').value = data.candidateHex;
        notify('یک کلید تصادفی ۲۵۶ بایتی در کادر قرار گرفت؛ برای اعمال نهایی، دکمهٔ «ثبت این کلید مادر» را بزنید.');
      } catch (e) { notify(e.message, true); }
    };

    $('saveCustomMasterBtn').onclick = async () => {
      const raw = ($('customMasterInput').value || '').trim();
      if (!raw) {
        notify('لطفاً کلید یا عبارت مادر دلخواه خودتان را وارد کنید (یا دکمهٔ ساخت تصادفی را بزنید).', true);
        $('customMasterInput').focus();
        return;
      }
      const confirmed = await sellerConfirm(
        'آیا مطمئن هستید که این کلید به عنوان کلید مادر اصلی شما ثبت و داخل کدهای برنامه (برای ساخت EXE) همگام‌سازی شود؟\\n\\nتوجه: اگر قبلاً با کلید دیگری لایسنس صادر کرده باشید، فایل EXE جدید فقط کلیدهای امضاشده با این کلید مادر جدید را می‌پذیرد.',
        { title: 'ثبت کلید مادر جدید و همگام‌سازی با EXE', confirmText: 'بله، ثبت و همگام‌سازی شود', danger: false }
      );
      if (!confirmed) return;
      try {
        const res = await callApi('/api/set-master-key', 'POST', { raw_secret: raw });
        $('currentMasterHexBox').value = '••••••••••••••••••••••••••••••••';
        await refreshInfo();
        notify(`کلید مادر اختصاصی شما با موفقیت ثبت و همگام شد (شناسه جدید: ${res.fingerprint}).`);
      } catch (e) { notify(e.message, true); }
    };

    $('saveVendorContactBtn').onclick = async () => {
      try {
        await callApi('/api/vendor-contact', 'POST', collectVendorForm());
        await refreshInfo();
        notify('اطلاعات تماس با موفقیت در برنامه ذخیره شد و آمادهٔ ساخت فایل EXE است.');
      } catch (e) { notify(e.message, true); }
    };

    async function refreshInfo() {
      const info = await callApi('/api/info');
      SUPPORT_PHONE = info.supportPhone || SUPPORT_PHONE;
      $('keyBadge').textContent = `کلید مادر فعال (شناسه: ${info.fingerprint})`;
      $('schemeBadge').textContent = `کلید مادر ${toFaNum(info.masterSecretBytes || 256)} بایتی + Ed25519`;
      $('thisPcBadge').textContent = `کد سیستم شما: ${info.thisHardwareId}`;
      historyItems = info.history || [];
      customerItems = info.customers || [];
      const st = info.stats || {};
      $('kpiTotalCust').textContent = toFaNum(st.totalCustomers || 0);
      $('kpiActiveCust').textContent = toFaNum(st.activeCustomers || 0);
      $('kpiExpiringCust').textContent = toFaNum(st.expiringCustomers || 0);
      $('kpiExpiredCust').textContent = toFaNum(st.expiredCustomers || 0);
      $('tabCustCount').textContent = toFaNum(customerItems.length);
      $('tabHistCount').textContent = toFaNum(historyItems.length);
      populateSetupTab(info);
      renderQuickSelect();
      renderCustomers();
      renderHistory();
    }

    $('searchBox').oninput = renderHistory;
    $('issueBtn').onclick = async () => {
      try {
        const fn = ($('custFirstName').value || '').trim();
        const ln = ($('custLastName').value || '').trim();
        const ph = ($('custPhone').value || '').trim();
        const hw = ($('custHwid').value || '').trim();
        if (!fn) { notify('لطفاً «نام» مشتری را وارد کنید.', true); $('custFirstName').focus(); return; }
        if (!ln) { notify('لطفاً «نام خانوادگی» مشتری را وارد کنید.', true); $('custLastName').focus(); return; }
        if (!ph) { notify('لطفاً «شماره موبایل» مشتری را وارد کنید.', true); $('custPhone').focus(); return; }
        if (!hw) { notify('لطفاً «کد سیستم مشتری» را وارد کنید.', true); $('custHwid').focus(); return; }

        const modules = collectModulesSpec();
        if (!Object.keys(modules).length) {
          notify('حداقل یکی از سه ماژول (OCR، ترجمه، ویرایش) باید در کلید فعال باشد.', true);
          return;
        }
        const res = await callApi('/api/issue', 'POST', {
          customer_id: $('custIdHidden').value,
          first_name: fn,
          last_name: ln,
          phone: ph,
          note: $('custNote').value,
          hardware_id: hw,
          modules,
        });
        lastIssued = res.issued;
        $('issuedResult').style.display = 'block';
        $('issuedMeta').textContent = `✓ صادر و در لیست کاربران ذخیره شد: «${lastIssued.holder}» (${lastIssued.phone}) — ${lastIssued.planLabel}`;
        $('issuedToken').value = lastIssued.token;
        await refreshInfo();
        notify('کلید لایسنس صادر شد و مشخصات مشتری در بانک مشتریان ثبت گردید.');
      } catch (e) { notify(e.message, true); }
    };

    $('copyTokenBtn').onclick = async () => {
      if (!lastIssued) return;
      await navigator.clipboard.writeText(lastIssued.token);
      notify('کلید لایسنس در کلیپ‌بورد کپی شد.');
    };
    $('copyReadyMsgBtn').onclick = async () => {
      if (!lastIssued) return;
      await navigator.clipboard.writeText(buildReadyMessage(lastIssued));
      notify('پیام آمادهٔ ارسال برای مشتری کپی شد.');
    };
    $('selfActivateBtn').onclick = async () => {
      try {
        const res = await callApi('/api/self-activate', 'POST', {});
        await refreshInfo();
        notify(`برنامه روی سیستم خودتان با موفقیت فعال شد (${res.status.license.planLabel}).`);
      } catch (e) { notify(e.message, true); }
    };
    $('backupKeyBtn').onclick = async () => {
      try {
        const data = await callApi('/api/backup-key');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `ComicOCRStudio-SellerVault-${data.backup.fingerprint}.seller-key.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        notify('پشتیبان کامل کلید مادر ۲۵۶ بایتی + لیست مشتریان دانلود شد.');
      } catch (e) { notify(e.message, true); }
    };
    $('restoreKeyInput').onchange = async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        await callApi('/api/restore-key', 'POST', parsed);
        await refreshInfo();
        notify('کلید مادر و اطلاعات مشتریان با موفقیت بازیابی شد.');
      } catch (e) { notify(e.message, true); }
      ev.target.value = '';
    };

    refreshInfo().catch((e) => notify(e.message, true));
  </script>
</body>
</html>
"""


def build_seller_panel_handler(vault: SellerVault, panel_secret: str) -> type[BaseHTTPRequestHandler]:
    """Create the HTTP handler class for the Seller Panel (reusable in unit tests)."""
    allowed_static: dict[str, tuple[Path, str]] = {
        "/assets/Vazirmatn.woff2": (_STATIC_ASSETS_DIR / "Vazirmatn.woff2", "font/woff2"),
        "/assets/icon128.png": (_STATIC_ASSETS_DIR / "icon128.png", "image/png"),
    }

    max_post_bytes = 16 * 1024 * 1024
    loopback_hosts = {"127.0.0.1", "localhost", "[::1]", "::1"}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            return

        def _send_security_headers(self) -> None:
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")

        def _is_loopback_request(self) -> bool:
            raw_host = (self.headers.get("Host") or "").strip().lower()
            if raw_host:
                host_only = raw_host.split("]")[0] + "]" if raw_host.startswith("[") else raw_host.split(":")[0]
                if host_only not in loopback_hosts:
                    return False
            origin = (self.headers.get("Origin") or "").strip()
            if origin:
                origin_host = (urlsplit(origin).hostname or "").lower()
                if origin_host not in loopback_hosts:
                    return False
            return True

        def _send_json(self, payload: Any, status: int = 200) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self._send_security_headers()
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _authorized(self) -> bool:
            given = self.headers.get("X-Seller-Secret", "")
            return bool(given) and hmac.compare_digest(given, panel_secret)

        def do_GET(self) -> None:  # noqa: N802
            if not self._is_loopback_request():
                self._send_json({"detail": "دسترسی فقط از آدرس محلی مجاز است."}, HTTPStatus.FORBIDDEN)
                return
            parsed = urlsplit(self.path)
            if parsed.path in allowed_static:
                asset_path, mime_type = allowed_static[parsed.path]
                if not asset_path.is_file():
                    self._send_json({"detail": "فایل ثابت یافت نشد."}, HTTPStatus.NOT_FOUND)
                    return
                asset_bytes = asset_path.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", mime_type)
                self.send_header("Cache-Control", "public, max-age=86400")
                self._send_security_headers()
                self.send_header("Content-Length", str(len(asset_bytes)))
                self.end_headers()
                self.wfile.write(asset_bytes)
                return

            if parsed.path == "/":
                qs = parse_qs(parsed.query)
                given_q = (qs.get("secret") or [""])[0]
                if not given_q or not hmac.compare_digest(given_q, panel_secret):
                    self._send_json({"detail": "دسترسی غیرمجاز به پنل فروشنده."}, HTTPStatus.FORBIDDEN)
                    return
                body = _PANEL_HTML.encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self._send_security_headers()
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            if not self._authorized():
                self._send_json({"detail": "توکن امنیتی پنل فروشنده نامعتبر است."}, HTTPStatus.FORBIDDEN)
                return

            if parsed.path == "/api/info":
                rec = vault.ensure_master_key(sync_source=True)
                vc = vault.get_vendor_contact()
                customers = vault.list_customers()
                stats = {
                    "totalCustomers": len(customers),
                    "activeCustomers": sum(1 for c in customers if c.get("overallStatus") in {"active", "expiring"}),
                    "expiringCustomers": sum(1 for c in customers if c.get("overallStatus") == "expiring"),
                    "expiredCustomers": sum(1 for c in customers if c.get("overallStatus") == "expired"),
                }
                self._send_json(
                    {
                        "fingerprint": rec["fingerprint"],
                        "keyScheme": rec.get("key_scheme", "Ed25519+MasterRoot256B"),
                        "masterSecretBytes": rec.get("master_secret_bytes", MASTER_SECRET_BYTES),
                        "publicKeyHex": rec["public_key_hex"],
                        "sellerDir": str(vault.seller_dir),
                        "thisHardwareId": compute_hardware_id(),
                        "supportPhone": vc["supportPhone"],
                        "vendorContact": vc,
                        "stats": stats,
                        "customers": customers,
                        "history": vault.list_history()[:300],
                    }
                )
                return

            if parsed.path == "/api/master-secret":
                rec = vault.ensure_master_key(sync_source=False)
                self._send_json(
                    {
                        "fingerprint": rec["fingerprint"],
                        "masterSecret256bHex": rec["master_secret_256b_hex"],
                        "publicKeyHex": rec["public_key_hex"],
                    }
                )
                return

            if parsed.path == "/api/random-master-key":
                self._send_json({"candidateHex": vault.generate_random_master_key_hex()})
                return

            if parsed.path == "/api/customers.csv":
                csv_bytes = vault.export_customers_csv()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self._send_security_headers()
                self.send_header("Content-Disposition", 'attachment; filename="customers.csv"')
                self.send_header("Content-Length", str(len(csv_bytes)))
                self.end_headers()
                self.wfile.write(csv_bytes)
                return

            if parsed.path == "/api/backup-key":
                rec = vault.ensure_master_key(sync_source=False)
                self._send_json(
                    {
                        "backup": rec,
                        "customers": vault._load_raw_customers(),
                        "history": vault.list_history(),
                    }
                )
                return

            self._send_json({"detail": "مسیر پیدا نشد."}, HTTPStatus.NOT_FOUND)

        def do_POST(self) -> None:  # noqa: N802
            if not self._is_loopback_request():
                self._send_json({"detail": "دسترسی فقط از آدرس محلی مجاز است."}, HTTPStatus.FORBIDDEN)
                return
            if not self._authorized():
                self._send_json({"detail": "توکن امنیتی پنل فروشنده نامعتبر است."}, HTTPStatus.FORBIDDEN)
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                self._send_json({"detail": "هدر Content-Length نامعتبر است."}, HTTPStatus.BAD_REQUEST)
                return
            if length < 0 or length > max_post_bytes:
                self._send_json({"detail": "حجم درخواست بیش از حد مجاز است."}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
                return
            raw_body = self.rfile.read(length) if length > 0 else b"{}"
            try:
                data = json.loads(raw_body.decode("utf-8"))
                if not isinstance(data, dict):
                    data = {}
            except Exception:
                self._send_json({"detail": "فرمت JSON نامعتبر است."}, HTTPStatus.BAD_REQUEST)
                return
            parsed = urlsplit(self.path)
            try:
                if parsed.path == "/api/issue":
                    raw_mods = data.get("modules")
                    issued = vault.issue(
                        hardware_id=str(data.get("hardware_id") or ""),
                        holder=str(data.get("holder") or ""),
                        first_name=str(data.get("first_name") or ""),
                        last_name=str(data.get("last_name") or ""),
                        phone=str(data.get("phone") or ""),
                        note=str(data.get("note") or ""),
                        customer_id=str(data.get("customer_id") or ""),
                        require_contact=True,
                        plan=str(data.get("plan") or "lifetime"),
                        days=int(data["days"]) if data.get("days") is not None else None,
                        modules=raw_mods if isinstance(raw_mods, dict) else None,
                    )
                    self._send_json({"issued": issued})
                    return

                if parsed.path == "/api/customer/save":
                    saved = vault.upsert_customer(
                        first_name=str(data.get("first_name") or ""),
                        last_name=str(data.get("last_name") or ""),
                        phone=str(data.get("phone") or ""),
                        hardware_id=str(data.get("hardware_id") or ""),
                        note=str(data.get("note") or ""),
                        customer_id=str(data.get("customer_id") or ""),
                        allow_clear_note=True,
                    )
                    self._send_json({"customer": saved})
                    return

                if parsed.path == "/api/customer/delete":
                    deleted = vault.delete_customer(str(data.get("customer_id") or ""))
                    self._send_json({"deleted": deleted})
                    return

                if parsed.path == "/api/self-activate":
                    res = vault.self_activate_this_pc()
                    self._send_json(res)
                    return

                if parsed.path == "/api/restore-key":
                    rec = vault.import_master_key(data, sync_source=True)
                    self._send_json({"fingerprint": rec["fingerprint"], "publicKeyHex": rec["public_key_hex"]})
                    return

                if parsed.path == "/api/set-master-key":
                    rec = vault.set_custom_master_key(str(data.get("raw_secret") or ""), sync_source=True)
                    self._send_json(
                        {
                            "fingerprint": rec["fingerprint"],
                            "publicKeyHex": rec["public_key_hex"],
                            "inputMode": rec["input_mode"],
                        }
                    )
                    return

                if parsed.path == "/api/vendor-contact":
                    saved_vc = vault.save_vendor_contact(data, sync_source=True)
                    self._send_json({"vendorContact": saved_vc})
                    return

                self._send_json({"detail": "مسیر پیدا نشد."}, HTTPStatus.NOT_FOUND)
            except (LicenseError, ValueError, RuntimeError) as exc:
                self._send_json({"detail": str(exc)}, HTTPStatus.BAD_REQUEST)

    return Handler


def run_seller_panel(vault: SellerVault, *, open_browser: bool = True) -> None:
    key_info = vault.ensure_master_key(sync_source=True)
    panel_secret = secrets.token_urlsafe(24)
    handler_cls = build_seller_panel_handler(vault, panel_secret)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    port = int(server.server_address[1])
    url = f"http://127.0.0.1:{port}/?secret={panel_secret}"
    print("=" * 72)
    print("  Comic OCR Studio — پنل مدرن مدیریت مشتریان و صدور لایسنس (فروشنده)")
    print(f"  شناسهٔ کلید مادر ۲۵۶ بایتی + Ed25519 شما: {key_info['fingerprint']}")
    print(f"  مسیر خصوصی گاوصندوق فروشنده: {vault.seller_dir}")
    print(f"  آدرس پنل محلی: {url}")
    print("  برای بستن پنل، کلیدهای Ctrl+C را بزنید یا این پنجره را ببندید.")
    print("=" * 72)
    if open_browser:
        with contextlib.suppress(Exception):
            webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nپنل فروشنده بسته شد.")
    finally:
        server.server_close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Comic OCR Studio Seller Modular License Generator & CRM")
    parser.add_argument("--seller-dir", default="", help="Optional custom seller key vault directory")
    parser.add_argument("--init-seller", action="store_true", help="Create/sync seller master key and exit")
    parser.add_argument("--set-master-key", default="", help="Set your own custom Master Key (passphrase or 512-char hex)")
    parser.add_argument("--sync-before-build", action="store_true", help="Sync public key & vendor_contact.json into source before EXE build")
    parser.add_argument("--self-activate", action="store_true", help="Issue & activate lifetime license on this PC")
    parser.add_argument("--issue", action="store_true", help="Issue a customer license key via CLI")
    parser.add_argument("--hwid", default="", help="Customer System Code (CS4-XXXX-XXXX-XXXX-XXXX)")
    parser.add_argument("--first-name", default="", help="Customer first name")
    parser.add_argument("--last-name", default="", help="Customer last name")
    parser.add_argument("--phone", default="", help="Customer mobile phone")
    parser.add_argument("--note", default="", help="Optional seller note")
    parser.add_argument("--holder", default="", help="Customer full name or order reference")
    parser.add_argument("--plan", choices=["lifetime", "subscription", "trial"], default="lifetime")
    parser.add_argument("--days", type=int, default=None, help="Validity in days for uniform subscription/trial")
    parser.add_argument(
        "--modules-spec",
        default="",
        help="Per-module spec, e.g. ocr=lifetime,translation=30,editing=off",
    )
    parser.add_argument("--json", action="store_true", help="Print CLI output as JSON")
    parser.add_argument("--no-browser", action="store_true", help="Start panel without auto-opening browser")
    args = parser.parse_args(argv)

    vault = SellerVault(seller_dir=Path(args.seller_dir) if args.seller_dir else None)

    if args.set_master_key.strip():
        rec = vault.set_custom_master_key(args.set_master_key, sync_source=True)
        if args.json:
            print(json.dumps({"fingerprint": rec["fingerprint"], "publicKeyHex": rec["public_key_hex"], "inputMode": rec["input_mode"]}))
        else:
            print(f"[Seller Vault] Custom 256B Master Key saved & synced ({rec['fingerprint']}).")
        return 0

    if args.sync_before_build:
        synced = vault.sync_all_before_exe_build()
        if args.json:
            print(json.dumps({"fingerprint": synced["key"]["fingerprint"], "vendorContact": synced["vendorContact"]}, ensure_ascii=False))
        else:
            print(f"[Synced] Master Key ({synced['key']['fingerprint']}) + Vendor Contact ({synced['vendorContact']['supportPhone']})")
        return 0

    if args.init_seller:
        info = vault.ensure_master_key(sync_source=True)
        if args.json:
            print(
                json.dumps(
                    {
                        "fingerprint": info["fingerprint"],
                        "publicKeyHex": info["public_key_hex"],
                        "masterSecretBytes": info["master_secret_bytes"],
                    }
                )
            )
        else:
            print(f"[Seller Vault] 256B Master key ready ({info['fingerprint']}); public key synced.")
        return 0

    if args.self_activate:
        result = vault.self_activate_this_pc(holder=args.holder or "نسخهٔ اصلی فروشنده")
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(f"[Activated] Hardware ID: {result['issued']['hardwareId']}")
            print(f"[Activated] Plan: {plan_label_fa('lifetime')}")
        return 0

    if args.issue:
        if not args.hwid:
            parser.error("--issue requires --hwid CS4-XXXX-XXXX-XXXX-XXXX")
        mods = parse_modules_cli_spec(args.modules_spec) if args.modules_spec.strip() else None
        has_contact = bool(args.first_name.strip() or args.last_name.strip() or args.phone.strip())
        issued = vault.issue(
            hardware_id=args.hwid,
            holder=args.holder or "کاربر رسمی",
            first_name=args.first_name,
            last_name=args.last_name,
            phone=args.phone,
            note=args.note,
            require_contact=has_contact,
            plan=args.plan,
            days=args.days,
            modules=mods,
        )
        if args.json:
            print(json.dumps(issued, ensure_ascii=False))
        else:
            print(issued["token"])
        return 0

    run_seller_panel(vault, open_browser=not args.no_browser)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
