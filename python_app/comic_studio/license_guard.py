"""Offline Hardware-Bound Licensing, Anti-Clock-Rollback & Local Password Guard.

Security architecture (Model 1 Offline Asymmetric Licensing):
1. Pure-Python RFC 8032 Ed25519 digital signature verification (zero external wheels).
   Only the 32-byte public verification key is shipped in `_public_key.py`; without the
   seller's 32-byte private seed, forging a license key (`CLIC1....`) for any System Code
   is mathematically infeasible.
2. Composite Hardware System Code (`CS4-XXXX-XXXX-XXXX-XXXX`) derived from stable OS and
   motherboard/CPU identifiers (Windows Registry MachineGuid + SMBIOS/CPU identifiers, or
   Linux/macOS machine-id + architecture), unaffected by USB drives or network changes.
3. Dual-anchored HMAC monotonic timestamp ledger protecting timed/trial licenses against
   Windows system clock rollback, while allowing 10 minutes of normal NTP drift.
4. Optional PBKDF2-HMAC-SHA256 (310,000 iterations) local login password bound into the
   HMAC-protected license state so deleting auxiliary files cannot bypass a local lock.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
import json
import math
import os
import platform
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from . import _public_key

# ---------------------------------------------------------------------------
# RFC 8032 Ed25519 Curve Constants & Pure-Python Arithmetic
# ---------------------------------------------------------------------------
_P = (1 << 255) - 19
_L = (1 << 252) + 27742317777372353535851937790883648493


def _inv(x: int) -> int:
    return pow(x % _P, _P - 2, _P)


_D = (-121665 * _inv(121666)) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _recover_x(y: int, sign: int) -> int | None:
    if y >= _P:
        return None
    y2 = (y * y) % _P
    x2 = ((y2 - 1) * _inv(_D * y2 + 1)) % _P
    if x2 == 0:
        return 0 if sign == 0 else None
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = (x * _SQRT_M1) % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


_BY = (4 * _inv(5)) % _P
_BX = _recover_x(_BY, 0)
assert _BX is not None
# Extended twisted Edwards coordinates: (X, Y, Z, T) where x = X/Z, y = Y/Z, x*y = T/Z
_ExtPoint = tuple[int, int, int, int]
_IDENTITY: _ExtPoint = (0, 1, 1, 0)
_BASE_POINT: _ExtPoint = (_BX % _P, _BY % _P, 1, (_BX * _BY) % _P)
_TWO_D = (2 * _D) % _P


def _point_add(p1: _ExtPoint, p2: _ExtPoint) -> _ExtPoint:
    x1, y1, z1, t1 = p1
    x2, y2, z2, t2 = p2
    a = ((y1 - x1) * (y2 - x2)) % _P
    b = ((y1 + x1) * (y2 + x2)) % _P
    c = (t1 * _TWO_D * t2) % _P
    d = (2 * z1 * z2) % _P
    e = (b - a) % _P
    f = (d - c) % _P
    g = (d + c) % _P
    h = (b + a) % _P
    return ((e * f) % _P, (g * h) % _P, (f * g) % _P, (e * h) % _P)


def _point_double(p1: _ExtPoint) -> _ExtPoint:
    x1, y1, z1, _ = p1
    a = (x1 * x1) % _P
    b = (y1 * y1) % _P
    c = (2 * z1 * z1) % _P
    h = (a + b) % _P
    yx = (x1 + y1) % _P
    e = (h - yx * yx) % _P
    g = (a - b) % _P
    f = (c + g) % _P
    return ((e * f) % _P, (g * h) % _P, (f * g) % _P, (e * h) % _P)


def _scalar_mult(scalar: int, point: _ExtPoint) -> _ExtPoint:
    result = _IDENTITY
    addend = point
    k = scalar
    while k > 0:
        if k & 1:
            result = _point_add(result, addend)
        addend = _point_double(addend)
        k >>= 1
    return result


def _point_equal(p1: _ExtPoint, p2: _ExtPoint) -> bool:
    x1, y1, z1, _ = p1
    x2, y2, z2, _ = p2
    if (x1 * z2 - x2 * z1) % _P != 0:
        return False
    if (y1 * z2 - y2 * z1) % _P != 0:
        return False
    return True


def _encode_point(point: _ExtPoint) -> bytes:
    x, y, z, _ = point
    zi = _inv(z)
    xp = (x * zi) % _P
    yp = (y * zi) % _P
    encoded = bytearray(yp.to_bytes(32, "little"))
    encoded[31] |= (xp & 1) << 7
    return bytes(encoded)


def _decode_point(raw: bytes) -> _ExtPoint | None:
    if len(raw) != 32:
        return None
    sign = (raw[31] >> 7) & 1
    y_bytes = bytearray(raw)
    y_bytes[31] &= 0x7F
    y = int.from_bytes(y_bytes, "little")
    if y >= _P:
        return None
    x = _recover_x(y, sign)
    if x is None:
        return None
    pt: _ExtPoint = (x, y, 1, (x * y) % _P)
    # Reject non-canonical encodings (e.g. negative zero x with sign=1).
    if _encode_point(pt) != raw:
        return None
    return pt


def _is_low_order_point(point: _ExtPoint) -> bool:
    # Cofactor of Ed25519 is 8; [8]A == identity means A is a torsion / identity point.
    p2 = _point_double(point)
    p4 = _point_double(p2)
    p8 = _point_double(p4)
    return _point_equal(p8, _IDENTITY)


def ed25519_public_key(seed32: bytes) -> bytes:
    """Derive the 32-byte RFC 8032 Ed25519 public key from a 32-byte secret seed."""
    if len(seed32) != 32:
        raise ValueError("Ed25519 secret seed must be exactly 32 bytes.")
    digest = hashlib.sha512(seed32).digest()
    a_bytes = bytearray(digest[:32])
    a_bytes[0] &= 248
    a_bytes[31] &= 127
    a_bytes[31] |= 64
    scalar = int.from_bytes(a_bytes, "little")
    return _encode_point(_scalar_mult(scalar, _BASE_POINT))


def ed25519_generate_keypair() -> tuple[bytes, bytes]:
    """Generate a cryptographically random `(private_seed32, public_key32)` pair."""
    seed = secrets.token_bytes(32)
    return seed, ed25519_public_key(seed)


def ed25519_sign(seed32: bytes, message: bytes) -> bytes:
    """Produce a deterministic 64-byte RFC 8032 Ed25519 signature."""
    if len(seed32) != 32:
        raise ValueError("Ed25519 secret seed must be exactly 32 bytes.")
    digest = hashlib.sha512(seed32).digest()
    a_bytes = bytearray(digest[:32])
    a_bytes[0] &= 248
    a_bytes[31] &= 127
    a_bytes[31] |= 64
    secret_scalar = int.from_bytes(a_bytes, "little")
    prefix = digest[32:]
    pub = _encode_point(_scalar_mult(secret_scalar, _BASE_POINT))

    r_scalar = int.from_bytes(hashlib.sha512(prefix + message).digest(), "little") % _L
    r_encoded = _encode_point(_scalar_mult(r_scalar, _BASE_POINT))
    k_scalar = int.from_bytes(hashlib.sha512(r_encoded + pub + message).digest(), "little") % _L
    s_scalar = (r_scalar + k_scalar * secret_scalar) % _L
    return r_encoded + s_scalar.to_bytes(32, "little")


def ed25519_verify(public32: bytes, message: bytes, signature64: bytes) -> bool:
    """Strictly verify a 64-byte RFC 8032 Ed25519 signature."""
    if len(public32) != 32 or len(signature64) != 64:
        return False
    r_encoded = signature64[:32]
    s_scalar = int.from_bytes(signature64[32:], "little")
    if s_scalar >= _L:
        return False
    a_point = _decode_point(public32)
    if a_point is None or _is_low_order_point(a_point):
        return False
    r_point = _decode_point(r_encoded)
    if r_point is None:
        return False
    k_scalar = int.from_bytes(hashlib.sha512(r_encoded + public32 + message).digest(), "little") % _L
    lhs = _scalar_mult(s_scalar, _BASE_POINT)
    rhs = _point_add(r_point, _scalar_mult(k_scalar, a_point))
    return _point_equal(lhs, rhs)


# ---------------------------------------------------------------------------
# Hardware System Code (`CS4-XXXX-XXXX-XXXX-XXXX`)
# ---------------------------------------------------------------------------
_HWID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 32 unambiguous characters (no 0/O/1/I)
_HWID_PREFIX = "CS4"
_HWID_GROUPS = 4
_HWID_GROUP_LEN = 4
_HWID_BODY_LEN = _HWID_GROUPS * _HWID_GROUP_LEN
_TOKEN_PREFIX = "CLIC1"
_SIGNING_DOMAIN = b"ComicOCRStudio-License-v1:"
CLOCK_DRIFT_TOLERANCE_SEC = 600  # 10 minutes tolerance for minor NTP clock adjustments
PBKDF2_ITERATIONS = 310_000
SESSION_COOKIE_NAME = "comic_studio_session"

_HWID_CACHE: str | None = None
_HWID_LOCK = threading.RLock()

# Internal test-only anchor override (never populated from environment variables!).
_LICENSE_DIR_OVERRIDE: Path | None = None
_SECONDARY_ANCHOR_OVERRIDE: Path | None = None


class LicenseError(Exception):
    """Raised when a license key or protected runtime action is unauthorized."""

    def __init__(self, message: str, *, code: str = "LICENSE_REQUIRED", status_code: int = 402) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code


def active_public_key_bytes() -> bytes:
    raw_hex = str(getattr(_public_key, "PUBLIC_VERIFY_KEY_HEX", "") or "").strip()
    try:
        pub = bytes.fromhex(raw_hex)
    except ValueError as exc:
        raise LicenseError("کلید عمومی برنامه معتبر نیست.", code="CORRUPT_PUBLIC_KEY") from exc
    if len(pub) != 32 or _decode_point(pub) is None:
        raise LicenseError("کلید عمومی برنامه آسیب دیده است.", code="CORRUPT_PUBLIC_KEY")
    return pub


def _collect_windows_traits() -> list[str]:
    traits: list[str] = []
    try:
        import winreg  # type: ignore[import-not-found]

        access = winreg.KEY_READ | getattr(winreg, "KEY_WOW64_64KEY", 0)
        with contextlib.suppress(OSError):
            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Cryptography",
                0,
                access,
            ) as key:
                guid, _ = winreg.QueryValueEx(key, "MachineGuid")
                if guid and str(guid).strip():
                    traits.append(f"mguid:{str(guid).strip().lower()}")
        with contextlib.suppress(OSError):
            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"HARDWARE\DESCRIPTION\System\BIOS",
                0,
                access,
            ) as key:
                for field in (
                    "BaseBoardManufacturer",
                    "BaseBoardProduct",
                    "SystemManufacturer",
                    "SystemProductName",
                ):
                    with contextlib.suppress(OSError):
                        val, _ = winreg.QueryValueEx(key, field)
                        cleaned = str(val or "").strip().lower()
                        if cleaned and cleaned not in {"to be filled by o.e.m.", "default string", "none"}:
                            traits.append(f"bios.{field.lower()}:{cleaned}")
        with contextlib.suppress(OSError):
            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
                0,
                access,
            ) as key:
                cpu_name, _ = winreg.QueryValueEx(key, "ProcessorNameString")
                if cpu_name and str(cpu_name).strip():
                    traits.append(f"cpu:{str(cpu_name).strip().lower()}")
    except Exception:
        pass
    return traits


def _collect_unix_traits() -> list[str]:
    traits: list[str] = []
    for mid_path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        with contextlib.suppress(OSError):
            content = Path(mid_path).read_text(encoding="utf-8", errors="ignore").strip().lower()
            if content:
                traits.append(f"machine-id:{content}")
                break
    if sys.platform == "darwin":
        with contextlib.suppress(Exception):
            proc = subprocess.run(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            )
            match = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', proc.stdout or "")
            if match:
                traits.append(f"mac-uuid:{match.group(1).strip().lower()}")
    if not traits:
        traits.append(f"node:{platform.node().strip().lower()}")
        with contextlib.suppress(OSError):
            st = Path(os.path.expanduser("~")).stat()
            traits.append(f"home-dev:{st.st_dev}:{st.st_ino}")
    return traits


def _encode_hwid_digest(digest: bytes) -> str:
    bits = int.from_bytes(digest[:10], "big")  # 80 bits -> 16 x 5-bit symbols
    chars = [_HWID_ALPHABET[(bits >> (5 * (15 - idx))) & 0x1F] for idx in range(_HWID_BODY_LEN)]
    groups = [
        "".join(chars[i : i + _HWID_GROUP_LEN])
        for i in range(0, _HWID_BODY_LEN, _HWID_GROUP_LEN)
    ]
    return f"{_HWID_PREFIX}-" + "-".join(groups)


def compute_hardware_id(*, refresh: bool = False) -> str:
    """Compute this computer's stable 16-symbol Hardware System Code (`CS4-XXXX-XXXX-XXXX-XXXX`)."""
    global _HWID_CACHE
    with _HWID_LOCK:
        if _HWID_CACHE is not None and not refresh:
            return _HWID_CACHE
        traits = _collect_windows_traits() if os.name == "nt" else _collect_unix_traits()
        traits.append(f"arch:{platform.machine().strip().lower()}")
        traits.append(f"sys:{sys.platform.strip().lower()}")
        canonical = "|".join(traits).encode("utf-8")
        digest = hashlib.sha256(b"ComicOCRStudio-HWID-v1:" + canonical).digest()
        _HWID_CACHE = _encode_hwid_digest(digest)
        return _HWID_CACHE


def normalize_hardware_id(raw: str) -> str:
    """Validate and normalize a user-entered Hardware System Code to `CS4-XXXX-XXXX-XXXX-XXXX`."""
    cleaned = re.sub(r"[\s\-_\u200c\u200e\u200f\ufeff]+", "", str(raw or "")).upper()
    if cleaned.startswith(_HWID_PREFIX):
        body = cleaned[len(_HWID_PREFIX) :]
    else:
        body = cleaned
    if len(body) != _HWID_BODY_LEN or any(ch not in _HWID_ALPHABET for ch in body):
        raise LicenseError(
            "فرمت کد شناسایی سیستم معتبر نیست (نمونهٔ درست: CS4-XXXX-XXXX-XXXX-XXXX).",
            code="INVALID_HARDWARE_ID",
            status_code=400,
        )
    groups = [
        body[i : i + _HWID_GROUP_LEN]
        for i in range(0, _HWID_BODY_LEN, _HWID_GROUP_LEN)
    ]
    return f"{_HWID_PREFIX}-" + "-".join(groups)


def _b64u_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64u_decode(text: str) -> bytes:
    pad = "=" * ((4 - (len(text) % 4)) % 4)
    try:
        return base64.urlsafe_b64decode((text + pad).encode("ascii"))
    except Exception as exc:
        raise LicenseError("ساختار کلید لایسنس نامعتبر یا ناقص است.", code="MALFORMED_TOKEN", status_code=400) from exc


def plan_label_fa(plan: str, *, days_total: int | None = None) -> str:
    if plan == "lifetime":
        return "دائمی (مادام‌العمر)"
    if plan == "trial":
        return f"آزمایشی ({days_total} روزه)" if days_total else "آزمایشی (مدت‌دار)"
    return f"اشتراک مدت‌دار ({days_total} روزه)" if days_total else "اشتراک مدت‌دار"


def issue_license_token(
    *,
    private_seed_hex: str,
    hardware_id: str,
    holder: str,
    plan: str = "lifetime",
    days: int | None = None,
    issued_at: int | None = None,
    expires_at: int | None = None,
    license_id: str | None = None,
) -> str:
    """Create a cryptographically signed `CLIC1.<payload>.<signature>` license key."""
    try:
        seed = bytes.fromhex(str(private_seed_hex or "").strip())
    except ValueError as exc:
        raise ValueError("Invalid Ed25519 private seed hex.") from exc
    if len(seed) != 32:
        raise ValueError("Ed25519 private seed must be 32 bytes (64 hex chars).")

    norm_hwid = normalize_hardware_id(hardware_id)
    clean_holder = str(holder or "").strip()[:120] or "کاربر رسمی"
    norm_plan = str(plan or "lifetime").strip().lower()
    if norm_plan not in {"lifetime", "subscription", "trial"}:
        raise ValueError(f"Unsupported license plan: {plan!r}")

    iat = int(issued_at if issued_at is not None else time.time())
    if norm_plan == "lifetime":
        exp: int | None = None
    elif expires_at is not None:
        exp = int(expires_at)
    else:
        if days is None or int(days) <= 0:
            raise ValueError("Timed or trial licenses require a positive `days` duration.")
        exp = iat + int(days) * 86400

    lid = str(license_id or secrets.token_hex(5)).strip()[:24]
    payload: dict[str, Any] = {
        "v": 1,
        "hid": norm_hwid,
        "holder": clean_holder,
        "plan": norm_plan,
        "iat": iat,
        "exp": exp,
        "lid": lid,
    }
    payload_bytes = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    signature = ed25519_sign(seed, _SIGNING_DOMAIN + payload_bytes)
    return f"{_TOKEN_PREFIX}.{_b64u_encode(payload_bytes)}.{_b64u_encode(signature)}"


def clean_token_text(raw: str) -> str:
    """Strip whitespace, newlines, and RTL/LTR directional marks from pasted license keys."""
    return re.sub(r"[\s\u200b\u200c\u200d\u200e\u200f\ufeff]+", "", str(raw or ""))


def verify_license_token(
    token: str,
    *,
    expected_hardware_id: str | None = None,
    public_key_bytes: bytes | None = None,
    now_ts: float | None = None,
    check_expiry: bool = True,
) -> dict[str, Any]:
    """Verify Ed25519 signature, hardware ID binding, and optional expiration of a license key."""
    cleaned = clean_token_text(token)
    if not cleaned:
        raise LicenseError("کلید لایسنس وارد نشده است.", code="EMPTY_TOKEN", status_code=400)
    parts = cleaned.split(".")
    if len(parts) != 3 or parts[0] != _TOKEN_PREFIX:
        raise LicenseError(
            "فرمت کلید لایسنس معتبر نیست. کلید لایسنس باید با CLIC1. شروع شود.",
            code="MALFORMED_TOKEN",
            status_code=400,
        )
    payload_bytes = _b64u_decode(parts[1])
    sig_bytes = _b64u_decode(parts[2])
    pub = public_key_bytes if public_key_bytes is not None else active_public_key_bytes()
    if not ed25519_verify(pub, _SIGNING_DOMAIN + payload_bytes, sig_bytes):
        raise LicenseError(
            "کلید لایسنس معتبر نیست یا دست‌کاری شده است.",
            code="INVALID_SIGNATURE",
            status_code=400,
        )

    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except Exception as exc:
        raise LicenseError("محتوای کلید لایسنس نامعتبر است.", code="MALFORMED_PAYLOAD", status_code=400) from exc
    if not isinstance(payload, dict) or payload.get("v") != 1:
        raise LicenseError("نسخهٔ کلید لایسنس پشتیبانی نمی‌شود.", code="UNSUPPORTED_VERSION", status_code=400)

    token_hwid = normalize_hardware_id(str(payload.get("hid") or ""))
    local_hwid = normalize_hardware_id(expected_hardware_id or compute_hardware_id())
    if not hmac.compare_digest(token_hwid, local_hwid):
        raise LicenseError(
            "این کلید لایسنس برای سیستم دیگری صادر شده و روی این کامپیوتر قابل استفاده نیست.",
            code="HARDWARE_MISMATCH",
            status_code=400,
        )

    plan = str(payload.get("plan") or "lifetime").strip().lower()
    if plan not in {"lifetime", "subscription", "trial"}:
        raise LicenseError("نوع طرح لایسنس نامعتبر است.", code="INVALID_PLAN", status_code=400)

    iat = int(payload.get("iat") or 0)
    raw_exp = payload.get("exp")
    exp = int(raw_exp) if raw_exp is not None else None
    now = float(now_ts if now_ts is not None else time.time())

    if exp is not None and check_expiry and now > float(exp):
        raise LicenseError(
            "مدت اعتبار این لایسنس به پایان رسیده است. لطفاً کلید تمدید جدید را وارد کنید.",
            code="LICENSE_EXPIRED",
            status_code=402,
        )

    days_total: int | None = None
    days_remaining: int | None = None
    if exp is not None:
        days_total = max(1, int(round((exp - iat) / 86400.0))) if iat > 0 else None
        remaining_sec = max(0.0, float(exp) - now)
        days_remaining = int(math.ceil(remaining_sec / 86400.0)) if remaining_sec > 0 else 0

    return {
        "valid": True,
        "token": cleaned,
        "hardwareId": token_hwid,
        "holder": str(payload.get("holder") or "کاربر رسمی"),
        "plan": plan,
        "planLabel": plan_label_fa(plan, days_total=days_total),
        "issuedAt": iat,
        "expiresAt": exp,
        "daysTotal": days_total,
        "daysRemaining": days_remaining,
        "licenseId": str(payload.get("lid") or ""),
    }


# ---------------------------------------------------------------------------
# Persistent License State, Anti-Clock-Rollback & Local Password Manager
# ---------------------------------------------------------------------------
def _default_license_dir() -> Path:
    if _LICENSE_DIR_OVERRIDE is not None:
        return _LICENSE_DIR_OVERRIDE
    if os.name == "nt":
        local_app = os.environ.get("LOCALAPPDATA", "").strip()
        if local_app:
            return Path(local_app) / "ComicOCRStudio" / "License"
    return Path(os.path.expanduser("~")) / ".comic-ocr-studio-license"


def _secondary_anchor_dir() -> Path:
    if _SECONDARY_ANCHOR_OVERRIDE is not None:
        return _SECONDARY_ANCHOR_OVERRIDE
    if _LICENSE_DIR_OVERRIDE is not None:
        return _LICENSE_DIR_OVERRIDE / ".anchor"
    if os.name == "nt":
        roaming = os.environ.get("APPDATA", "").strip()
        if roaming:
            return Path(roaming) / "ComicOCRStudio"
    return Path(os.path.expanduser("~")) / ".config" / "comic-ocr-studio"


def _state_hmac_key() -> bytes:
    return hashlib.sha256(
        b"CS4-StateIntegrity-v1:"
        + compute_hardware_id().encode("utf-8")
        + b":"
        + active_public_key_bytes()
    ).digest()


def _compute_record_mac(record: dict[str, Any]) -> str:
    clean = {k: v for k, v in record.items() if k != "mac"}
    raw = json.dumps(clean, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hmac.new(_state_hmac_key(), raw, hashlib.sha256).hexdigest()


def _atomic_write_private_json(path: Path, payload: dict[str, Any]) -> None:
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


def _read_verified_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    expected_mac = _compute_record_mac(data)
    given_mac = str(data.get("mac") or "")
    if not given_mac or not hmac.compare_digest(expected_mac, given_mac):
        return None
    return data


def _native_guard_verify_frozen() -> bool:
    """In frozen Windows `.exe` builds, optionally cross-verify against compiled `ComicLicenseGuard.exe`."""
    if not getattr(sys, "frozen", False) or os.name != "nt":
        return True
    exe_candidates: list[Path] = []
    with contextlib.suppress(OSError):
        exe_dir = Path(sys.executable).resolve().parent
        exe_candidates.append(exe_dir / "_internal" / "ComicLicenseGuard.exe")
        exe_candidates.append(exe_dir / "ComicLicenseGuard.exe")
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        exe_candidates.append(Path(str(meipass)) / "ComicLicenseGuard.exe")
    guard_exe = next((p for p in exe_candidates if p.is_file()), None)
    if guard_exe is None:
        return True
    nonce = secrets.token_hex(16)
    pub_sha = hashlib.sha256(active_public_key_bytes()).hexdigest()
    expected = hmac.new(
        pub_sha.encode("ascii"),
        f"CS4-GUARD:{nonce}".encode("ascii"),
        hashlib.sha256,
    ).hexdigest()
    try:
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.run(
            [str(guard_exe), nonce],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
            creationflags=creationflags,
        )
        reply = (proc.stdout or "").strip().lower()
        return proc.returncode == 0 and hmac.compare_digest(reply, expected.lower())
    except Exception:
        return False


class _RuntimeSecurityGate:
    """Thread-safe runtime gate managing license verification, anti-rollback & local sessions."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: dict[str, float] = {}  # session_token -> created_at
        self._failed_attempts: list[float] = []
        self._cache_key: tuple[str, int, int] | None = None
        self._cache_at: float = 0.0
        self._cached_record: dict[str, Any] | None = None
        self._native_checked: bool = False
        self._native_ok: bool = True

    def reset_memory_state(self) -> None:
        with self._lock:
            self._sessions.clear()
            self._failed_attempts.clear()
            self._cache_key = None
            self._cache_at = 0.0
            self._cached_record = None
            self._native_checked = False
            self._native_ok = True

    def _state_path(self) -> Path:
        return _default_license_dir() / "license-state.json"

    def _anchor_path(self) -> Path:
        return _secondary_anchor_dir() / ".cs4-clock-anchor.json"

    def _load_state_record(self) -> tuple[dict[str, Any] | None, bool]:
        """Return `(verified_record, corrupted_flag)`."""
        path = self._state_path()
        try:
            st = path.stat()
        except OSError:
            self._cache_key = None
            self._cached_record = None
            return None, False
        key = (str(path), st.st_mtime_ns, st.st_size)
        if self._cache_key == key and self._cached_record is not None:
            return dict(self._cached_record), False
        verified = _read_verified_json(path)
        if verified is None:
            self._cache_key = None
            self._cached_record = None
            return None, True
        self._cache_key = key
        self._cached_record = dict(verified)
        return dict(verified), False

    def _save_state_record(self, record: dict[str, Any]) -> None:
        clean = {k: v for k, v in record.items() if k != "mac"}
        clean["mac"] = _compute_record_mac(clean)
        path = self._state_path()
        _atomic_write_private_json(path, clean)
        with contextlib.suppress(OSError):
            st = path.stat()
            self._cache_key = (str(path), st.st_mtime_ns, st.st_size)
            self._cached_record = dict(clean)

    def _max_observed_clock(self, record: dict[str, Any]) -> int:
        candidates = [int(record.get("max_seen_utc") or 0)]
        anchor = _read_verified_json(self._anchor_path())
        if anchor is not None:
            candidates.append(int(anchor.get("max_seen_utc") or 0))
        return max(candidates)

    def _advance_clock_ledger(self, record: dict[str, Any], now_int: int) -> None:
        prev_max = self._max_observed_clock(record)
        new_max = max(prev_max, now_int)
        if new_max > int(record.get("max_seen_utc") or 0) + 60:
            record["max_seen_utc"] = new_max
            with contextlib.suppress(OSError):
                self._save_state_record(record)
        anchor = _read_verified_json(self._anchor_path())
        anchor_max = int(anchor.get("max_seen_utc") or 0) if anchor else 0
        if new_max > anchor_max + 60:
            anchor_payload: dict[str, Any] = {"v": 1, "max_seen_utc": new_max}
            anchor_payload["mac"] = _compute_record_mac(anchor_payload)
            with contextlib.suppress(OSError):
                _atomic_write_private_json(self._anchor_path(), anchor_payload)

    def _check_native_integrity(self) -> bool:
        if not self._native_checked:
            self._native_ok = _native_guard_verify_frozen()
            self._native_checked = True
        return self._native_ok

    def has_valid_session(self, session_token: str | None) -> bool:
        if not session_token:
            return False
        with self._lock:
            for active_tok in list(self._sessions.keys()):
                if hmac.compare_digest(active_tok, session_token):
                    return True
            return False

    def create_session(self) -> str:
        with self._lock:
            if len(self._sessions) > 32:
                oldest = min(self._sessions, key=self._sessions.get)  # type: ignore[arg-type]
                self._sessions.pop(oldest, None)
            tok = secrets.token_urlsafe(32)
            self._sessions[tok] = time.time()
            return tok

    def revoke_session(self, session_token: str | None = None) -> None:
        with self._lock:
            if session_token is None:
                self._sessions.clear()
                return
            for active_tok in list(self._sessions.keys()):
                if hmac.compare_digest(active_tok, session_token):
                    self._sessions.pop(active_tok, None)

    def inspect_status(
        self,
        *,
        session_token: str | None = None,
        now_ts: float | None = None,
    ) -> dict[str, Any]:
        """Evaluate complete license + clock + local-password status."""
        with self._lock:
            hwid = compute_hardware_id()
            now = float(now_ts if now_ts is not None else time.time())
            now_int = int(now)

            if not self._check_native_integrity():
                return {
                    "licensed": False,
                    "unlocked": False,
                    "reason": "integrity_failed",
                    "message": "یکپارچگی فایل‌های امنیتی برنامه تأیید نشد. لطفاً برنامه را مجدداً نصب کنید.",
                    "hardwareId": hwid,
                    "passwordEnabled": False,
                    "license": None,
                }

            record, corrupted = self._load_state_record()
            if record is None:
                return {
                    "licensed": False,
                    "unlocked": False,
                    "reason": "tampered" if corrupted else "unlicensed",
                    "message": (
                        "فایل وضعیت لایسنس دست‌کاری شده یا آسیب دیده است. لطفاً کلید لایسنس خود را مجدداً وارد کنید."
                        if corrupted
                        else "برنامه هنوز روی این سیستم فعال نشده است. کد سیستم زیر را برای دریافت کلید لایسنس ارسال کنید."
                    ),
                    "hardwareId": hwid,
                    "passwordEnabled": False,
                    "license": None,
                }

            raw_token = str(record.get("token") or "")
            pwd_enabled = bool(record.get("pwd_salt") and record.get("pwd_hash"))
            try:
                lic_info = verify_license_token(
                    raw_token,
                    expected_hardware_id=hwid,
                    now_ts=now,
                    check_expiry=False,
                )
            except LicenseError as exc:
                return {
                    "licensed": False,
                    "unlocked": False,
                    "reason": exc.code.lower(),
                    "message": exc.message,
                    "hardwareId": hwid,
                    "passwordEnabled": pwd_enabled,
                    "license": None,
                }

            # Timed/trial anti-clock-rollback check (lifetime licenses never expire).
            exp = lic_info.get("expiresAt")
            iat = int(lic_info.get("issuedAt") or 0)
            if exp is not None:
                max_seen = max(self._max_observed_clock(record), iat)
                if now_int + CLOCK_DRIFT_TOLERANCE_SEC < max_seen:
                    return {
                        "licensed": False,
                        "unlocked": False,
                        "reason": "clock_tampered",
                        "message": (
                            "تاریخ یا ساعت ویندوز به عقب کشیده شده است. "
                            "لطفاً تاریخ و ساعت سیستم را به زمان واقعی برگردانید تا لایسنس دوباره فعال شود."
                        ),
                        "hardwareId": hwid,
                        "passwordEnabled": pwd_enabled,
                        "license": {
                            "holder": lic_info["holder"],
                            "plan": lic_info["plan"],
                            "planLabel": lic_info["planLabel"],
                            "issuedAt": lic_info["issuedAt"],
                            "expiresAt": exp,
                            "daysRemaining": lic_info["daysRemaining"],
                        },
                    }
                if now > float(exp):
                    self._advance_clock_ledger(record, now_int)
                    return {
                        "licensed": False,
                        "unlocked": False,
                        "reason": "license_expired",
                        "message": "مدت اعتبار لایسنس شما به پایان رسیده است. لطفاً کلید تمدید جدید را وارد کنید.",
                        "hardwareId": hwid,
                        "passwordEnabled": pwd_enabled,
                        "license": {
                            "holder": lic_info["holder"],
                            "plan": lic_info["plan"],
                            "planLabel": lic_info["planLabel"],
                            "issuedAt": lic_info["issuedAt"],
                            "expiresAt": exp,
                            "daysRemaining": 0,
                        },
                    }
                self._advance_clock_ledger(record, now_int)

            unlocked = (not pwd_enabled) or self.has_valid_session(session_token)
            public_lic = {
                "holder": lic_info["holder"],
                "plan": lic_info["plan"],
                "planLabel": lic_info["planLabel"],
                "issuedAt": lic_info["issuedAt"],
                "expiresAt": lic_info["expiresAt"],
                "daysTotal": lic_info["daysTotal"],
                "daysRemaining": lic_info["daysRemaining"],
                "licenseId": lic_info["licenseId"],
            }
            return {
                "licensed": True,
                "unlocked": unlocked,
                "reason": "ok" if unlocked else "login_required",
                "message": "" if unlocked else "برای ورود به محیط کاری، رمز ورود شخصی خود را وارد کنید.",
                "hardwareId": hwid,
                "passwordEnabled": pwd_enabled,
                "license": public_lic,
            }

    def activate_token(
        self,
        token: str,
        *,
        reset_local_password: bool = False,
        now_ts: float | None = None,
    ) -> tuple[dict[str, Any], str]:
        """Verify and persist a new license token, returning `(status_dict, session_token)`."""
        with self._lock:
            now = float(now_ts if now_ts is not None else time.time())
            now_int = int(now)
            hwid = compute_hardware_id()
            lic_info = verify_license_token(token, expected_hardware_id=hwid, now_ts=now, check_expiry=True)

            existing, _ = self._load_state_record()
            prev_max = self._max_observed_clock(existing or {})
            if lic_info.get("expiresAt") is not None and now_int + CLOCK_DRIFT_TOLERANCE_SEC < prev_max:
                raise LicenseError(
                    "تاریخ یا ساعت ویندوز عقب‌تر از زمان ثبت‌شدهٔ سیستم است. ابتدا ساعت ویندوز را تنظیم کنید.",
                    code="CLOCK_TAMPERED",
                    status_code=400,
                )

            new_max = max(prev_max, now_int, int(lic_info.get("issuedAt") or 0))
            record: dict[str, Any] = {
                "v": 1,
                "token": lic_info["token"],
                "activated_at": now_int,
                "max_seen_utc": new_max,
                "pwd_salt": "" if reset_local_password else str((existing or {}).get("pwd_salt") or ""),
                "pwd_hash": "" if reset_local_password else str((existing or {}).get("pwd_hash") or ""),
            }
            self._save_state_record(record)
            anchor_payload: dict[str, Any] = {"v": 1, "max_seen_utc": new_max}
            anchor_payload["mac"] = _compute_record_mac(anchor_payload)
            with contextlib.suppress(OSError):
                _atomic_write_private_json(self._anchor_path(), anchor_payload)

            session_tok = self.create_session()
            return self.inspect_status(session_token=session_tok, now_ts=now), session_tok

    def _check_rate_limit(self, now: float) -> None:
        cutoff = now - 60.0
        self._failed_attempts = [ts for ts in self._failed_attempts if ts >= cutoff]
        if len(self._failed_attempts) >= 5:
            wait_sec = max(1, int(math.ceil(60.0 - (now - self._failed_attempts[0]))))
            raise LicenseError(
                f"تعداد تلاش‌های ناموفق بیش از حد مجاز است. لطفاً {wait_sec} ثانیه صبر کنید.",
                code="TOO_MANY_ATTEMPTS",
                status_code=429,
            )

    @staticmethod
    def _derive_password_hash(password: str, salt_bytes: bytes) -> str:
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt_bytes, PBKDF2_ITERATIONS)
        return dk.hex()

    def login_with_password(self, password: str, *, now_ts: float | None = None) -> tuple[dict[str, Any], str]:
        with self._lock:
            now = float(now_ts if now_ts is not None else time.time())
            self._check_rate_limit(now)
            status = self.inspect_status(session_token=None, now_ts=now)
            if not status["licensed"]:
                raise LicenseError(status["message"], code=status["reason"].upper(), status_code=402)
            record, _ = self._load_state_record()
            if record is None:
                raise LicenseError("وضعیت لایسنس یافت نشد.", code="LICENSE_REQUIRED", status_code=402)
            salt_hex = str(record.get("pwd_salt") or "")
            expected_hash = str(record.get("pwd_hash") or "")
            if not salt_hex or not expected_hash:
                tok = self.create_session()
                return self.inspect_status(session_token=tok, now_ts=now), tok
            candidate = self._derive_password_hash(str(password or ""), bytes.fromhex(salt_hex))
            if not hmac.compare_digest(candidate, expected_hash):
                self._failed_attempts.append(now)
                raise LicenseError("رمز ورود اشتباه است.", code="WRONG_PASSWORD", status_code=401)
            self._failed_attempts.clear()
            tok = self.create_session()
            return self.inspect_status(session_token=tok, now_ts=now), tok

    def configure_local_password(
        self,
        *,
        current_password: str = "",
        new_password: str = "",
        session_token: str | None = None,
    ) -> tuple[dict[str, Any], str]:
        """Set, change, or remove (when `new_password == ""`) the local login password."""
        with self._lock:
            now = time.time()
            self._check_rate_limit(now)
            status = self.inspect_status(session_token=session_token, now_ts=now)
            if not status["licensed"]:
                raise LicenseError(status["message"], code="LICENSE_REQUIRED", status_code=402)
            if not status["unlocked"]:
                raise LicenseError("ابتدا وارد برنامه شوید.", code="LOGIN_REQUIRED", status_code=401)

            record, _ = self._load_state_record()
            if record is None:
                raise LicenseError("وضعیت لایسنس یافت نشد.", code="LICENSE_REQUIRED", status_code=402)
            old_salt_hex = str(record.get("pwd_salt") or "")
            old_hash = str(record.get("pwd_hash") or "")
            if old_salt_hex and old_hash:
                cand = self._derive_password_hash(str(current_password or ""), bytes.fromhex(old_salt_hex))
                if not hmac.compare_digest(cand, old_hash):
                    self._failed_attempts.append(now)
                    raise LicenseError("رمز فعلی نادرست است.", code="WRONG_PASSWORD", status_code=400)

            clean_new = str(new_password or "")
            if clean_new:
                if len(clean_new) < 4:
                    raise LicenseError(
                        "رمز ورود باید حداقل ۴ کاراکتر باشد.",
                        code="WEAK_PASSWORD",
                        status_code=400,
                    )
                if len(clean_new) > 128:
                    raise LicenseError("رمز ورود بیش از حد طولانی است.", code="INVALID_PASSWORD", status_code=400)
                new_salt = secrets.token_bytes(16)
                record["pwd_salt"] = new_salt.hex()
                record["pwd_hash"] = self._derive_password_hash(clean_new, new_salt)
            else:
                record["pwd_salt"] = ""
                record["pwd_hash"] = ""

            self._failed_attempts.clear()
            self._save_state_record(record)
            self.revoke_session(None)
            fresh_session = self.create_session()
            return self.inspect_status(session_token=fresh_session, now_ts=now), fresh_session


SECURITY_GATE = _RuntimeSecurityGate()


def require_active_license() -> dict[str, Any]:
    """Independent deep engine guard called directly inside OCR, Translation & Export pipelines."""
    status = SECURITY_GATE.inspect_status(session_token=None)
    if not status.get("licensed"):
        raise LicenseError(
            status.get("message") or "لایسنس معتبری روی این سیستم فعال نیست.",
            code=str(status.get("reason") or "LICENSE_REQUIRED").upper(),
            status_code=402,
        )
    return status
