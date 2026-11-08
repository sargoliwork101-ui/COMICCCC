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
    LicenseError,
    SECURITY_GATE,
    compute_hardware_id,
    ed25519_public_key,
    issue_license_token,
    normalize_hardware_id,
    plan_label_fa,
    verify_license_token,
)

PUBLIC_KEY_MODULE_PATH = APP_DIR / "comic_studio" / "_public_key.py"
MASTER_SECRET_BYTES = 256  # 256 bytes = 2048 bits (512 hex chars)

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


class SellerVault:
    """Manages 256-byte Master Key + Ed25519 signing, Customer CRM, and issued license log."""

    def __init__(self, seller_dir: Path | None = None, public_key_py: Path | None = None) -> None:
        self.seller_dir = Path(seller_dir) if seller_dir is not None else default_seller_dir()
        self.public_key_py = Path(public_key_py) if public_key_py is not None else PUBLIC_KEY_MODULE_PATH

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

    def import_master_key(self, payload: dict[str, Any], *, sync_source: bool = True) -> dict[str, Any]:
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
            if clean_note or "note" not in target:
                target["note"] = clean_note
            target["updatedIso"] = now_iso

        _atomic_write_json(self.customers_path, customers[:5000])
        return target

    def delete_customer(self, customer_id: str) -> bool:
        cid = str(customer_id or "").strip()
        if not cid:
            raise ValueError("شناسهٔ مشتری مشخص نشده است.")
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

            # Latest grant per module across additive keys issued to this customer
            mod_live: dict[str, dict[str, Any]] = {}
            for m in LICENSE_MODULES:
                best: dict[str, Any] | None = None
                for h in matched_hist:
                    h_mods = h.get("modules")
                    if isinstance(h_mods, dict) and m in h_mods:
                        best = h_mods[m]
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
                    c.get("customerId", ""),
                    c.get("firstName", ""),
                    c.get("lastName", ""),
                    c.get("phone", ""),
                    " | ".join(c.get("hardwareIds") or []),
                    status_map.get(str(c.get("overallStatus") or ""), ""),
                    (ml.get("ocr") or {}).get("text", ""),
                    (ml.get("translation") or {}).get("text", ""),
                    (ml.get("editing") or {}).get("text", ""),
                    c.get("issuedCount", 0),
                    c.get("lastIssuedIso", ""),
                    c.get("note", ""),
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
            "supportPhone": SUPPORT_PHONE,
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


_PANEL_HTML = """<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>پنل مدرن مدیریت مشتریان و صدور لایسنس — Comic OCR Studio</title>
  <style>
    :root {
      --bg: #070b14;
      --bg-grad: radial-gradient(1100px 520px at 85% -10%, rgba(59,130,246,.18), transparent 60%),
                 radial-gradient(900px 460px at 10% -5%, rgba(16,185,129,.13), transparent 55%);
      --surface: rgba(17, 25, 40, 0.86);
      --surface-2: #0f172a;
      --surface-3: #1e293b;
      --border: rgba(148, 163, 184, 0.18);
      --border-strong: rgba(96, 165, 250, 0.45);
      --text: #f8fafc;
      --muted: #94a3b8;
      --primary: #3b82f6;
      --primary-h: #2563eb;
      --ok: #10b981;
      --ok-bg: rgba(16, 185, 129, 0.14);
      --warn: #f59e0b;
      --warn-bg: rgba(245, 158, 11, 0.15);
      --danger: #ef4444;
      --danger-bg: rgba(239, 68, 68, 0.15);
      --radius: 16px;
    }
    * { box-sizing: border-box; font-family: "Vazirmatn", Tahoma, "Segoe UI", sans-serif; }
    body {
      margin: 0; min-height: 100vh; background-color: var(--bg); background-image: var(--bg-grad);
      color: var(--text); padding: 24px 18px 64px; line-height: 1.65;
    }
    .shell { max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
    .hero {
      background: var(--surface); backdrop-filter: blur(16px); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 20px 24px;
      display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap;
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.35);
    }
    .hero-title { margin: 0; font-size: 21px; font-weight: 800; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .hero-sub { margin: 6px 0 0; font-size: 13px; color: var(--muted); max-width: 720px; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
      padding: 4px 11px; border-radius: 999px; border: 1px solid var(--border); background: rgba(15,23,42,.7);
    }
    .pill-ok { background: var(--ok-bg); color: #34d399; border-color: rgba(16,185,129,.35); }
    .pill-warn { background: var(--warn-bg); color: #fbbf24; border-color: rgba(245,158,11,.35); }
    .pill-danger { background: var(--danger-bg); color: #f87171; border-color: rgba(239,68,68,.35); }
    .pill-info { background: rgba(59,130,246,.15); color: #93c5fd; border-color: rgba(59,130,246,.35); }
    .hero-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
    .kpi-card {
      background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 15px 18px;
      display: flex; flex-direction: column; gap: 4px;
    }
    .kpi-label { font-size: 12.5px; color: var(--muted); }
    .kpi-val { font-size: 26px; font-weight: 800; letter-spacing: -.5px; }
    .kpi-ok .kpi-val { color: #34d399; }
    .kpi-warn .kpi-val { color: #fbbf24; }
    .kpi-danger .kpi-val { color: #f87171; }
    .kpi-info .kpi-val { color: #60a5fa; }

    .tabs-bar {
      display: flex; gap: 8px; background: var(--surface); border: 1px solid var(--border);
      padding: 6px; border-radius: 13px; width: fit-content; max-width: 100%; flex-wrap: wrap;
    }
    .tab-btn {
      background: transparent; color: var(--muted); border: none; padding: 9px 18px;
      border-radius: 9px; font-size: 13.5px; font-weight: 700; cursor: pointer; transition: .15s;
      display: inline-flex; align-items: center; gap: 8px;
    }
    .tab-btn:hover { color: var(--text); background: rgba(255,255,255,.04); }
    .tab-btn.active { background: var(--primary); color: #fff; box-shadow: 0 4px 14px rgba(59,130,246,.35); }
    .tab-count {
      font-size: 11px; padding: 1px 7px; border-radius: 999px;
      background: rgba(255,255,255,.16); color: inherit;
    }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }

    .card {
      background: var(--surface); backdrop-filter: blur(14px); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 22px 24px; box-shadow: 0 14px 34px rgba(0,0,0,.28);
    }
    .sec-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
    .sec-head h2 { margin: 0; font-size: 17px; color: #f1f5f9; }
    .form-grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 13px; }
    .form-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 13px; margin-top: 12px; }
    label.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #cbd5e1; font-weight: 600; }
    .req { color: #f87171; margin-right: 3px; }
    input, select, textarea {
      background: #090f1d; color: var(--text); border: 1px solid var(--border);
      border-radius: 10px; padding: 10px 12px; font-size: 13.5px; outline: none; transition: border-color .15s, box-shadow .15s;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(59,130,246,.18); }
    .ltr { direction: ltr; text-align: left; font-family: Consolas, "Courier New", monospace; letter-spacing: .4px; }

    button, .btn {
      background: var(--surface-3); color: #f1f5f9; border: 1px solid rgba(148,163,184,.28); border-radius: 10px;
      padding: 8px 14px; font-size: 12.8px; cursor: pointer; font-weight: 600; text-decoration: none;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px; transition: .15s;
    }
    button:hover, .btn:hover { background: #334155; border-color: rgba(148,163,184,.45); }
    button.primary { background: linear-gradient(135deg, #3b82f6, #2563eb); border-color: #3b82f6; color: #fff; padding: 11px 22px; font-size: 14px; }
    button.primary:hover { filter: brightness(1.08); }
    button.ok { background: linear-gradient(135deg, #10b981, #059669); border-color: #10b981; color: #fff; }
    button.danger-ghost { background: rgba(239,68,68,.12); color: #fca5a5; border-color: rgba(239,68,68,.3); }
    button.danger-ghost:hover { background: rgba(239,68,68,.24); }
    button.sm { padding: 5px 10px; font-size: 12px; border-radius: 8px; }

    .mod-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 12px; margin-top: 12px; }
    .mod-card {
      background: rgba(9, 15, 29, 0.72); border: 1px solid var(--border); border-radius: 13px;
      padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
    }
    .mod-card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .mod-card-title { font-weight: 700; font-size: 14px; color: #f8fafc; }
    .mod-card-desc { font-size: 12px; color: var(--muted); margin-top: -4px; }
    .quick-bar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

    .result-box {
      margin-top: 18px; padding: 18px; border-radius: 14px;
      background: linear-gradient(180deg, rgba(16,185,129,.1), rgba(9,15,29,.9));
      border: 1px solid rgba(16,185,129,.4);
    }
    .filter-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
    .filter-chip {
      padding: 6px 12px; border-radius: 999px; font-size: 12px; background: #0b1324;
      border: 1px solid var(--border); color: var(--muted); cursor: pointer;
    }
    .filter-chip.active { background: rgba(59,130,246,.2); color: #93c5fd; border-color: rgba(59,130,246,.5); }

    .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: rgba(9,15,29,.55); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid var(--border); padding: 11px 12px; text-align: right; vertical-align: middle; }
    th { color: #cbd5e1; font-weight: 700; background: rgba(15,23,42,.85); white-space: nowrap; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255,255,255,.02); }
    .mod-mini-list { display: flex; gap: 5px; flex-wrap: wrap; }
    .mod-mini { font-size: 11px; padding: 2px 8px; border-radius: 7px; border: 1px solid var(--border); white-space: nowrap; }
    .mod-mini.st-lifetime, .mod-mini.st-active { background: var(--ok-bg); color: #34d399; border-color: rgba(16,185,129,.35); }
    .mod-mini.st-expiring { background: var(--warn-bg); color: #fbbf24; border-color: rgba(245,158,11,.38); }
    .mod-mini.st-expired { background: var(--danger-bg); color: #f87171; border-color: rgba(239,68,68,.35); }
    .mod-mini.st-none { color: var(--muted); background: rgba(148,163,184,.08); }

    dialog.modal {
      background: #111827; color: var(--text); border: 1px solid var(--border-strong);
      border-radius: 16px; padding: 22px; width: min(520px, 94vw); box-shadow: 0 24px 60px rgba(0,0,0,.65);
    }
    dialog.modal::backdrop { background: rgba(3,7,18,.72); backdrop-filter: blur(4px); }
    .toast {
      position: fixed; bottom: 22px; left: 22px; padding: 11px 18px; border-radius: 12px;
      background: #059669; color: #fff; font-size: 13.5px; font-weight: 600;
      display: none; z-index: 999; box-shadow: 0 12px 30px rgba(0,0,0,.45);
    }
    .toast.err { background: var(--danger); }
  </style>
</head>
<body>
  <div class="shell">
    <header class="hero">
      <div>
        <h1 class="hero-title">
          <span>پنل هوشمند مشتریان و صدور لایسنس Comic OCR Studio</span>
          <span class="pill pill-ok" id="keyBadge">در حال بررسی کلید مادر…</span>
          <span class="pill pill-info" id="schemeBadge">کلید مادر ۲۵۶ بایتی + Ed25519</span>
        </h1>
        <p class="hero-sub">
          کلید مادر ۲۵۶ بایتی (۲۰۴۸ بیت) و کلید خصوصی امضای دیجیتال شما فقط روی همین سیستم نگهداری می‌شود و هرگز وارد فایل <code>.exe</code> مشتری نمی‌شود. مشخصات کامل همهٔ خریداران به صورت خودکار در بانک مشتریان ذخیره می‌گردد.
        </p>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <span class="pill pill-warn" id="thisPcBadge">کد سیستم شما: …</span>
        </div>
      </div>
      <div class="hero-actions">
        <button class="ok" id="selfActivateBtn" type="button">فعال‌سازی دائمی روی سیستم خودم</button>
        <button id="backupKeyBtn" type="button">📦 دانلود پشتیبان کامل (کلید مادر + مشتریان)</button>
        <label class="btn" style="margin:0;cursor:pointer">
          <span>♻️ بازیابی پشتیبان</span>
          <input id="restoreKeyInput" type="file" accept=".json,application/json" hidden>
        </label>
      </div>
    </header>

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

    <nav class="tabs-bar" role="tablist">
      <button class="tab-btn active" type="button" data-tab="issue">🔑 صدور لایسنس جدید</button>
      <button class="tab-btn" type="button" data-tab="customers">👥 لیست کاربران و مشتریان <span class="tab-count" id="tabCustCount">۰</span></button>
      <button class="tab-btn" type="button" data-tab="history">📜 تاریخچهٔ کلیدهای صادرشده <span class="tab-count" id="tabHistCount">۰</span></button>
    </nav>

    <!-- TAB 1: ISSUE LICENSE -->
    <section id="pane-issue" class="tab-pane active">
      <div class="card">
        <div class="sec-head">
          <h2>مشخصات خریدار و صدور کلید لایسنس ماژولار</h2>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select id="quickFillCustomer" style="min-width:250px">
              <option value="">⚡ انتخاب سریع از مشتریان قبلی (تمدید)…</option>
            </select>
            <button type="button" class="sm" id="clearIssueFormBtn">پاک‌کردن فرم</button>
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

        <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border)">
          <div class="sec-head" style="margin-bottom:10px">
            <strong style="font-size:14.5px;color:#93c5fd">تعیین وضعیت و مدت اعتبار هر یک از ۳ بخش نرم‌افزار:</strong>
            <div class="quick-bar">
              <button type="button" class="sm" data-quick="all:lifetime">هر ۳ بخش دائمی</button>
              <button type="button" class="sm" data-quick="all:sub:30">هر ۳ بخش ۱ ماهه (۳۰ روز)</button>
              <button type="button" class="sm" data-quick="all:sub:365">هر ۳ بخش ۱ ساله</button>
              <button type="button" class="sm" data-quick="only:ocr">فقط OCR (۳۰ روز)</button>
              <button type="button" class="sm" data-quick="only:translation">فقط ترجمه (۳۰ روز)</button>
              <button type="button" class="sm" data-quick="only:editing">فقط ویرایش (۳۰ روز)</button>
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
          <button class="primary" id="issueBtn" type="button">✨ ثبت مشتری و صدور کلید لایسنس امضاشده</button>
          <span style="font-size:12.5px;color:var(--muted)">پس از صدور، نام، نام خانوادگی و موبایل مشتری خودکار در «لیست کاربران» ذخیره می‌شود.</span>
        </div>

        <div id="issuedResult" class="result-box" style="display:none">
          <div style="font-size:13.5px;color:#6ee7b7;font-weight:700;margin-bottom:8px" id="issuedMeta"></div>
          <textarea id="issuedToken" class="ltr" rows="3" readonly style="width:100%"></textarea>
          <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
            <button class="primary" id="copyTokenBtn" type="button">📋 کپی کلید لایسنس</button>
            <button class="ok" id="copyReadyMsgBtn" type="button">💬 کپی پیام آمادهٔ ارسال برای مشتری (تلگرام / واتساپ / پیامک)</button>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 2: CUSTOMERS CRM -->
    <section id="pane-customers" class="tab-pane">
      <div class="card">
        <div class="sec-head">
          <h2>بانک اطلاعات کاربران و مشتریان</h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" id="addCustomerManualBtn">+ ثبت مشتری جدید بدون صدور آنی</button>
            <button type="button" id="exportCsvBtn">📥 خروجی اکسل (CSV)</button>
          </div>
        </div>

        <div class="filter-bar">
          <input id="custSearchBox" placeholder="جستجوی نام، نام خانوادگی، شماره موبایل، کد سیستم یا یادداشت…" style="min-width:300px;flex:1">
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
      <div class="card">
        <div class="sec-head">
          <h2>تاریخچهٔ کامل کلیدهای صادرشده</h2>
          <input id="searchBox" placeholder="جستجوی نام، موبایل یا کد سیستم…" style="min-width:280px">
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
  </div>

  <!-- Edit / Add Customer Modal -->
  <dialog id="custEditModal" class="modal">
    <h3 id="custModalTitle" style="margin:0 0 14px;font-size:16.5px">ویرایش مشخصات مشتری</h3>
    <input type="hidden" id="modalCustId">
    <div style="display:flex;flex-direction:column;gap:11px">
      <label class="field"><span>نام <span class="req">*</span></span><input id="modalFirstName"></label>
      <label class="field"><span>نام خانوادگی <span class="req">*</span></span><input id="modalLastName"></label>
      <label class="field"><span>شماره موبایل <span class="req">*</span></span><input id="modalPhone" class="ltr" placeholder="09123456789"></label>
      <label class="field"><span>کد سیستم (اختیاری)</span><input id="modalHwid" class="ltr" placeholder="CS4-XXXX-XXXX-XXXX-XXXX"></label>
      <label class="field"><span>یادداشت فروشنده</span><input id="modalNote"></label>
    </div>
    <div style="margin-top:18px;display:flex;justify-content:flex-end;gap:8px">
      <button type="button" id="modalCancelBtn">انصراف</button>
      <button type="button" class="primary" id="modalSaveBtn">ذخیرهٔ اطلاعات مشتری</button>
    </div>
  </dialog>

  <div id="toast" class="toast"></div>

  <script>
    const SECRET = new URLSearchParams(location.search).get('secret') || '';
    let SUPPORT_PHONE = '09361111111';
    const MODS = ['ocr', 'translation', 'editing'];
    const SHORT_MOD = { ocr: 'OCR', translation: 'ترجمه', editing: 'ویرایش' };
    let historyItems = [];
    let customerItems = [];
    let custFilter = 'all';
    let lastIssued = null;
    const $ = (id) => document.getElementById(id);

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
        `📞 پشتیبانی و تمدید: ${SUPPORT_PHONE}`,
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
      sel.innerHTML = '<option value="">⚡ انتخاب سریع از مشتریان قبلی (تمدید)…</option>';
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
        renewBtn.className = 'sm ok';
        renewBtn.textContent = '⚡ تمدید / صدور کلید';
        renewBtn.onclick = () => prefillIssueFromCustomer(c);

        const editBtn = document.createElement('button');
        editBtn.className = 'sm';
        editBtn.textContent = '✏️ ویرایش';
        editBtn.onclick = () => openCustomerModal(c);

        const delBtn = document.createElement('button');
        delBtn.className = 'sm danger-ghost';
        delBtn.textContent = 'حذف';
        delBtn.onclick = async () => {
          if (!confirm(`آیا از حذف «${c.fullName}» از لیست مشتریان مطمئن هستید؟`)) return;
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
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ComicOCRStudio-Customers-${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
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
        const btnKey = document.createElement('button'); btnKey.className = 'sm'; btnKey.textContent = 'کپی کلید';
        btnKey.onclick = async () => { await navigator.clipboard.writeText(item.token); notify('کلید لایسنس کپی شد.'); };
        const btnMsg = document.createElement('button'); btnMsg.className = 'sm ok'; btnMsg.textContent = 'پیام آماده';
        btnMsg.onclick = async () => { await navigator.clipboard.writeText(buildReadyMessage(item)); notify('پیام آمادهٔ ارسال کپی شد.'); };
        wrap.append(btnKey, btnMsg);
        td6.appendChild(wrap);
        tr.append(td1, td2, td3, td4, td5, td6);
        tbody.appendChild(tr);
      }
    }

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
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ComicOCRStudio-SellerVault-${data.backup.fingerprint}.seller-key.json`;
        a.click();
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

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            return

        def _send_json(self, payload: Any, status: int = 200) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _authorized(self) -> bool:
            given = self.headers.get("X-Seller-Secret", "")
            return bool(given) and hmac.compare_digest(given, panel_secret)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlsplit(self.path)
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
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            if not self._authorized():
                self._send_json({"detail": "توکن امنیتی پنل فروشنده نامعتبر است."}, HTTPStatus.FORBIDDEN)
                return

            if parsed.path == "/api/info":
                rec = vault.ensure_master_key(sync_source=True)
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
                        "supportPhone": SUPPORT_PHONE,
                        "stats": stats,
                        "customers": customers,
                        "history": vault.list_history()[:300],
                    }
                )
                return

            if parsed.path == "/api/customers.csv":
                csv_bytes = vault.export_customers_csv()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
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
            if not self._authorized():
                self._send_json({"detail": "توکن امنیتی پنل فروشنده نامعتبر است."}, HTTPStatus.FORBIDDEN)
                return
            length = int(self.headers.get("Content-Length") or 0)
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

                self._send_json({"detail": "مسیر پیدا نشد."}, HTTPStatus.NOT_FOUND)
            except (LicenseError, ValueError, RuntimeError) as exc:
                self._send_json({"detail": str(exc)}, HTTPStatus.BAD_REQUEST)

    return Handler


def run_seller_panel(vault: SellerVault, *, open_browser: bool = True) -> None:
    key_info = vault.ensure_master_key(sync_source=True)
    panel_secret = secrets.token_urlsafe(24)
    handler_cls = build_seller_panel_handler(vault, panel_secret)

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]

    server = ThreadingHTTPServer(("127.0.0.1", port), handler_cls)
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
