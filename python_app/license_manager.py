#!/usr/bin/env python3
"""Seller-Only Master Key & Offline Modular License Generator for Comic OCR Studio.

SECURITY WARNING:
- Keep this tool ONLY on the seller's computer. It is intentionally excluded from
  customer `.exe` builds by `offline_packaging/build_offline_package.py`.
- Your 32-byte Ed25519 private master key is stored OUTSIDE this Git repository in:
  `~/.comic-ocr-studio-seller/seller_master_key.json`
- Only the 32-byte PUBLIC verification key is synced into `comic_studio/_public_key.py`.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import sys
import tempfile
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
    ed25519_generate_keypair,
    ed25519_public_key,
    issue_license_token,
    normalize_hardware_id,
    plan_label_fa,
    verify_license_token,
)

PUBLIC_KEY_MODULE_PATH = APP_DIR / "comic_studio" / "_public_key.py"


def default_seller_dir() -> Path:
    raw = os.environ.get("COMIC_STUDIO_SELLER_DIR", "").strip()
    if raw:
        return Path(raw)
    return Path(os.path.expanduser("~")) / ".comic-ocr-studio-seller"


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
    """Manages seller's private Ed25519 master key, public-key sync, and issued license log."""

    def __init__(self, seller_dir: Path | None = None, public_key_py: Path | None = None) -> None:
        self.seller_dir = Path(seller_dir) if seller_dir is not None else default_seller_dir()
        self.public_key_py = Path(public_key_py) if public_key_py is not None else PUBLIC_KEY_MODULE_PATH

    @property
    def master_key_path(self) -> Path:
        return self.seller_dir / "seller_master_key.json"

    @property
    def history_path(self) -> Path:
        return self.seller_dir / "issued_licenses.json"

    def ensure_master_key(self, *, sync_source: bool = True) -> dict[str, Any]:
        record: dict[str, Any] | None = None
        if self.master_key_path.is_file():
            try:
                loaded = json.loads(self.master_key_path.read_text(encoding="utf-8"))
                seed = bytes.fromhex(str(loaded.get("private_seed_hex") or ""))
                pub = ed25519_public_key(seed)
                record = {
                    "v": 1,
                    "created_at": str(loaded.get("created_at") or ""),
                    "private_seed_hex": seed.hex(),
                    "public_key_hex": pub.hex(),
                    "fingerprint": hashlib.sha256(pub).hexdigest()[:16].upper(),
                }
            except Exception as exc:
                raise RuntimeError(f"فایل کلید مادر فروشنده آسیب دیده است: {exc}") from exc
        if record is None:
            seed, pub = ed25519_generate_keypair()
            record = {
                "v": 1,
                "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "private_seed_hex": seed.hex(),
                "public_key_hex": pub.hex(),
                "fingerprint": hashlib.sha256(pub).hexdigest()[:16].upper(),
            }
            _atomic_write_json(self.master_key_path, record)
        if sync_source:
            self.sync_public_key_to_source(record["public_key_hex"])
        return record

    def import_master_key(self, payload: dict[str, Any], *, sync_source: bool = True) -> dict[str, Any]:
        raw_seed = str(payload.get("private_seed_hex") or "").strip()
        try:
            seed = bytes.fromhex(raw_seed)
        except ValueError as exc:
            raise ValueError("فرمت فایل پشتیبان کلید مادر معتبر نیست.") from exc
        if len(seed) != 32:
            raise ValueError("کلید خصوصی مادر باید دقیقاً ۳۲ بایت باشد.")
        pub = ed25519_public_key(seed)
        record = {
            "v": 1,
            "created_at": str(payload.get("created_at") or dt.datetime.now(dt.timezone.utc).isoformat()),
            "private_seed_hex": seed.hex(),
            "public_key_hex": pub.hex(),
            "fingerprint": hashlib.sha256(pub).hexdigest()[:16].upper(),
        }
        _atomic_write_json(self.master_key_path, record)
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

    def issue(
        self,
        *,
        hardware_id: str,
        holder: str,
        plan: str = "lifetime",
        days: int | None = None,
        modules: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        key_rec = self.ensure_master_key(sync_source=True)
        norm_hwid = normalize_hardware_id(hardware_id)
        clean_holder = str(holder or "").strip()[:120] or "کاربر رسمی"
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
        issued = self.issue(hardware_id=hwid, holder=holder, plan="lifetime")
        SECURITY_GATE.reset_memory_state()
        status, _ = SECURITY_GATE.activate_token(issued["token"], replace_all_modules=True)
        return {"issued": issued, "status": status}


_PANEL_HTML = """<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>پنل مدیریت و صدور لایسنس ماژولار — مخصوص فروشنده</title>
  <style>
    :root {
      --bg: #0f172a; --card: #1e293b; --border: #334155; --text: #f8fafc;
      --muted: #94a3b8; --primary: #3b82f6; --primary-h: #2563eb;
      --ok: #10b981; --danger: #ef4444; --warn: #f59e0b;
    }
    * { box-sizing: border-box; font-family: Tahoma, "Vazirmatn", "Segoe UI", sans-serif; }
    body { margin: 0; background: var(--bg); color: var(--text); padding: 24px 16px 60px; line-height: 1.65; }
    .wrap { max-width: 960px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 20px 22px; box-shadow: 0 12px 30px rgba(0,0,0,.28); }
    h1 { margin: 0 0 6px; font-size: 21px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    h2 { margin: 0 0 12px; font-size: 16.5px; color: #e2e8f0; }
    .badge { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: rgba(16,185,129,.16); color: #34d399; border: 1px solid rgba(16,185,129,.35); }
    .badge-warn { background: rgba(245,158,11,.15); color: #fbbf24; border-color: rgba(245,158,11,.35); }
    .sub { color: var(--muted); font-size: 13.5px; margin: 0; }
    .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    label { display: flex; flex-direction: column; gap: 5px; font-size: 13.5px; color: #cbd5e1; }
    input, select, textarea {
      background: #0b1220; color: var(--text); border: 1px solid var(--border);
      border-radius: 9px; padding: 9px 12px; font-size: 14px; outline: none;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--primary); }
    .ltr { direction: ltr; text-align: left; font-family: Consolas, monospace; letter-spacing: .4px; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
    button, .btn {
      background: #334155; color: #fff; border: 1px solid #475569; border-radius: 9px;
      padding: 8px 14px; font-size: 13px; cursor: pointer; font-weight: 600; text-decoration: none;
    }
    button:hover, .btn:hover { background: #475569; }
    button.primary { background: var(--primary); border-color: var(--primary); font-size: 14px; padding: 10px 18px; }
    button.primary:hover { background: var(--primary-h); }
    button.ok { background: #059669; border-color: #10b981; }
    button.ok:hover { background: #047857; }
    .mod-box { margin-top: 14px; border: 1px solid var(--border); border-radius: 11px; padding: 14px; background: rgba(15,23,42,.55); }
    .mod-row { display: grid; grid-template-columns: minmax(190px, 1.2fr) minmax(210px, 1fr) minmax(130px, .6fr); gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px dashed rgba(148,163,184,.2); }
    .mod-row:last-child { border-bottom: none; }
    .mod-title { font-weight: 700; color: #f1f5f9; font-size: 14px; }
    .mod-sub { font-size: 12px; color: var(--muted); display: block; font-weight: 400; }
    .result-box { margin-top: 14px; padding: 14px; border-radius: 10px; background: #0b1220; border: 1px solid #1e40af; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
    th, td { border-bottom: 1px solid var(--border); padding: 9px 8px; text-align: right; }
    th { color: var(--muted); font-weight: 600; }
    .toast { position: fixed; bottom: 20px; left: 20px; padding: 10px 18px; border-radius: 10px; background: #059669; color: #fff; font-size: 13.5px; display: none; z-index: 99; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
    .toast.err { background: var(--danger); }
    @media (max-width: 680px) { .mod-row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>پنل صدور لایسنس ماژولار Comic OCR Studio <span class="badge">مخصوص فروشنده (آفلاین و امن)</span></h1>
      <p class="sub">کلید خصوصی امضای دیجیتال (Ed25519) فقط در کامپیوتر شخصی شما نگهداری می‌شود. برای هر بخش (OCR، ترجمه، ویرایش) می‌توانید به صورت مستقل اعتبار دائمی یا تعداد روز دلخواه تعیین کنید.</p>
      <div class="row" style="margin-top:14px">
        <span class="badge" id="keyBadge">در حال بررسی کلید مادر…</span>
        <span class="badge badge-warn" id="thisPcBadge">کد سیستم شما: …</span>
        <button class="ok" id="selfActivateBtn" type="button">فعال‌سازی دائمی هر ۳ بخش روی سیستم خودم</button>
        <button id="backupKeyBtn" type="button">دانلود پشتیبان کلید مادر (مهم)</button>
        <label class="btn" style="margin:0;flex-direction:row;align-items:center;cursor:pointer">
          <span>بازیابی کلید مادر</span>
          <input id="restoreKeyInput" type="file" accept=".json,application/json" hidden>
        </label>
      </div>
    </div>

    <div class="card">
      <h2>صدور کلید لایسنس برای مشتری (تعیین جداگانهٔ هر ماژول و مدت اعتبار)</h2>
      <div class="grid2">
        <label>کد شناسایی سیستم مشتری (System Code)
          <input id="custHwid" class="ltr" placeholder="CS4-XXXX-XXXX-XXXX-XXXX" autocomplete="off">
        </label>
        <label>نام خریدار یا شماره سفارش
          <input id="custHolder" placeholder="مثلاً: رضا محمدی - سفارش ۱۰۸" autocomplete="off">
        </label>
      </div>

      <div class="mod-box">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
          <strong style="font-size:14px;color:#93c5fd">وضعیت و مدت اعتبار هر یک از ۳ ماژول در این کلید:</strong>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button type="button" data-quick="all:lifetime">هر ۳ بخش دائمی</button>
            <button type="button" data-quick="all:sub:30">هر ۳ بخش ۳۰ روزه</button>
            <button type="button" data-quick="only:ocr">فقط OCR</button>
            <button type="button" data-quick="only:translation">فقط ترجمه</button>
            <button type="button" data-quick="only:editing">فقط ویرایش</button>
          </div>
        </div>

        <div class="mod-row">
          <div class="mod-title">۱. استخراج متن (OCR)<span class="mod-sub">اجرای موتورهای OCR و مدیریت مدل‌های OCR</span></div>
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
          <input id="days_ocr" type="number" min="1" max="3650" value="30" placeholder="تعداد روز" style="display:none">
        </div>

        <div class="mod-row">
          <div class="mod-title">۲. ترجمه (Translation)<span class="mod-sub">مترجم رایگان، مترجم آفلاین و هوش مصنوعی</span></div>
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
          <input id="days_translation" type="number" min="1" max="3650" value="30" placeholder="تعداد روز" style="display:none">
        </div>

        <div class="mod-row">
          <div class="mod-title">۳. ویرایش (Editing)<span class="mod-sub">ویرایشگر حباب و متن، برش تصویر و واترمارک</span></div>
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
          <input id="days_editing" type="number" min="1" max="3650" value="30" placeholder="تعداد روز" style="display:none">
        </div>
      </div>

      <div class="row">
        <button class="primary" id="issueBtn" type="button">صدور کلید لایسنس امضاشده</button>
      </div>
      <div id="issuedResult" class="result-box" style="display:none">
        <div style="font-size:13px;color:#93c5fd;margin-bottom:6px" id="issuedMeta"></div>
        <textarea id="issuedToken" class="ltr" rows="3" readonly style="width:100%"></textarea>
        <div class="row">
          <button class="primary" id="copyTokenBtn" type="button">کپی کلید لایسنس</button>
          <button class="ok" id="copyReadyMsgBtn" type="button">کپی پیام آمادهٔ ارسال برای مشتری (تلگرام/واتساپ)</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <h2 style="margin:0">تاریخچهٔ لایسنس‌های صادرشده</h2>
        <input id="searchBox" placeholder="جستجوی نام مشتری یا کد سیستم…" style="min-width:240px">
      </div>
      <div style="overflow-x:auto">
        <table>
          <thead><tr><th>تاریخ صدور</th><th>خریدار / سفارش</th><th>ماژول‌ها و اعتبار</th><th>کد سیستم</th><th>عملیات</th></tr></thead>
          <tbody id="historyBody"></tbody>
        </table>
      </div>
    </div>
  </div>
  <div id="toast" class="toast"></div>
  <script>
    const SECRET = new URLSearchParams(location.search).get('secret') || '';
    const SUPPORT_PHONE = '09361111111';
    const MODS = ['ocr', 'translation', 'editing'];
    let historyItems = [];
    let lastIssued = null;
    const $ = (id) => document.getElementById(id);

    function notify(msg, err = false) {
      const el = $('toast'); el.textContent = msg;
      el.className = err ? 'toast err' : 'toast'; el.style.display = 'block';
      clearTimeout(notify._t); notify._t = setTimeout(() => { el.style.display = 'none'; }, 3400);
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
    function syncCustomDaysVisibility() {
      for (const m of MODS) {
        $('days_' + m).style.display = $('plan_' + m).value === 'custom' ? 'block' : 'none';
      }
    }
    document.querySelectorAll('.mod-select').forEach((sel) => {
      sel.addEventListener('change', syncCustomDaysVisibility);
    });
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
          if (item.modules[m]) {
            modLines.push(`  • ${item.modules[m].label}: ${item.modules[m].planLabel}`);
          }
        }
      }
      return [
        `سلام و وقت بخیر 🌸`,
        `لایسنس رسمی برنامهٔ Comic OCR Studio برای سیستم شما صادر شد:`,
        `👤 نام ثبت‌شده: ${item.holder}`,
        `🖥 کد سیستم: ${item.hardwareId}`,
        `🧩 ماژول‌های فعال‌شده:`,
        ...(modLines.length ? modLines : [`  • ${item.planLabel}`]),
        ``,
        `🔑 کلید فعال‌سازی شما:`,
        item.token,
        ``,
        `کافی است در برنامه وارد بخش «لایسنس و رمز ورود» شوید، کلید بالا را بچسبانید و دکمهٔ «فعال‌سازی لایسنس» را بزنید.`,
        `📞 پشتیبانی و تمدید لایسنس: ${SUPPORT_PHONE}`,
      ].join('\\n');
    }

    function renderHistory() {
      const q = ($('searchBox').value || '').trim().toLowerCase();
      const rows = historyItems.filter((it) => !q || (it.holder || '').toLowerCase().includes(q) || (it.hardwareId || '').toLowerCase().includes(q));
      const tbody = $('historyBody'); tbody.innerHTML = '';
      if (!rows.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="5" style="text-align:center;color:#94a3b8">هنوز لایسنسی ثبت نشده است.</td>';
        tbody.appendChild(tr); return;
      }
      for (const item of rows) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td'); td1.textContent = item.issuedIso || ''; td1.dir = 'ltr';
        const td2 = document.createElement('td'); td2.textContent = item.holder || '';
        const td3 = document.createElement('td'); td3.textContent = item.planLabel || '';
        const td4 = document.createElement('td'); td4.textContent = item.hardwareId || ''; td4.className = 'ltr';
        const td5 = document.createElement('td');
        const btn = document.createElement('button'); btn.textContent = 'کپی کلید';
        btn.onclick = async () => { await navigator.clipboard.writeText(item.token); notify('کلید لایسنس کپی شد.'); };
        td5.appendChild(btn);
        tr.append(td1, td2, td3, td4, td5);
        tbody.appendChild(tr);
      }
    }
    async function refreshInfo() {
      const info = await callApi('/api/info');
      $('keyBadge').textContent = `کلید مادر آماده (شناسه: ${info.fingerprint})`;
      $('thisPcBadge').textContent = `کد سیستم شما: ${info.thisHardwareId}`;
      historyItems = info.history || [];
      renderHistory();
    }
    $('searchBox').oninput = renderHistory;
    $('issueBtn').onclick = async () => {
      try {
        const modules = collectModulesSpec();
        if (!Object.keys(modules).length) {
          notify('حداقل یکی از سه ماژول (OCR، ترجمه، ویرایش) باید در کلید فعال باشد.', true);
          return;
        }
        const res = await callApi('/api/issue', 'POST', {
          hardware_id: $('custHwid').value,
          holder: $('custHolder').value,
          modules,
        });
        lastIssued = res.issued;
        $('issuedResult').style.display = 'block';
        $('issuedMeta').textContent = `صادر شد برای «${lastIssued.holder}» — ${lastIssued.planLabel} — کد سیستم: ${lastIssued.hardwareId}`;
        $('issuedToken').value = lastIssued.token;
        await refreshInfo();
        notify('کلید لایسنس ماژولار با موفقیت صادر شد.');
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
        const blob = new Blob([JSON.stringify(data.backup, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ComicOCRStudio-SellerMasterKey-${data.backup.fingerprint}.seller-key.json`;
        a.click();
        notify('فایل پشتیبان کلید مادر دانلود شد. آن را در جای بسیار امن نگه دارید!');
      } catch (e) { notify(e.message, true); }
    };
    $('restoreKeyInput').onchange = async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        await callApi('/api/restore-key', 'POST', parsed);
        await refreshInfo();
        notify('کلید مادر فروشنده بازیابی و با برنامه همگام‌سازی شد.');
      } catch (e) { notify(e.message, true); }
      ev.target.value = '';
    };
    refreshInfo().catch((e) => notify(e.message, true));
  </script>
</body>
</html>
"""


def run_seller_panel(vault: SellerVault, *, open_browser: bool = True) -> None:
    key_info = vault.ensure_master_key(sync_source=True)
    panel_secret = secrets.token_urlsafe(24)

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
                self._send_json(
                    {
                        "fingerprint": rec["fingerprint"],
                        "publicKeyHex": rec["public_key_hex"],
                        "sellerDir": str(vault.seller_dir),
                        "thisHardwareId": compute_hardware_id(),
                        "supportPhone": SUPPORT_PHONE,
                        "history": vault.list_history()[:200],
                    }
                )
                return
            if parsed.path == "/api/backup-key":
                rec = vault.ensure_master_key(sync_source=False)
                self._send_json({"backup": rec})
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
                        plan=str(data.get("plan") or "lifetime"),
                        days=int(data["days"]) if data.get("days") is not None else None,
                        modules=raw_mods if isinstance(raw_mods, dict) else None,
                    )
                    self._send_json({"issued": issued})
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

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/?secret={panel_secret}"
    print("=" * 68)
    print("  Comic OCR Studio — پنل مدیریت و صدور لایسنس ماژولار (مخصوص فروشنده)")
    print(f"  شناسهٔ کلید مادر شما: {key_info['fingerprint']}")
    print(f"  مسیر خصوصی کلید مادر: {vault.master_key_path}")
    print(f"  آدرس پنل محلی: {url}")
    print("  برای بستن پنل، کلیدهای Ctrl+C را بزنید یا این پنجره را ببندید.")
    print("=" * 68)
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
    parser = argparse.ArgumentParser(description="Comic OCR Studio Seller Modular License Generator")
    parser.add_argument("--seller-dir", default="", help="Optional custom seller key vault directory")
    parser.add_argument("--init-seller", action="store_true", help="Create/sync seller master key and exit")
    parser.add_argument("--self-activate", action="store_true", help="Issue & activate lifetime license on this PC")
    parser.add_argument("--issue", action="store_true", help="Issue a customer license key via CLI")
    parser.add_argument("--hwid", default="", help="Customer System Code (CS4-XXXX-XXXX-XXXX-XXXX)")
    parser.add_argument("--holder", default="کاربر رسمی", help="Customer name or order reference")
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
            print(json.dumps({"fingerprint": info["fingerprint"], "publicKeyHex": info["public_key_hex"]}))
        else:
            print(f"[Seller Vault] Master key ready ({info['fingerprint']}); public key synced.")
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
        issued = vault.issue(
            hardware_id=args.hwid,
            holder=args.holder,
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
