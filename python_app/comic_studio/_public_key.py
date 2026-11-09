"""Embedded Ed25519 public verification key for Comic OCR Studio licenses.

IMPORTANT SECURITY NOTE:
- Only the 32-byte PUBLIC verification key lives in the client application.
- The corresponding 32-byte PRIVATE signing key NEVER ships with the app or repository;
  it stays exclusively inside the seller's private folder (`~/.comic-ocr-studio-seller/`).
- Running `python_app/license_manager.py` (or `start_license_manager.bat`) on the seller's
  computer automatically creates the seller's private master key (if absent) and syncs
  its public verification key into `PUBLIC_VERIFY_KEY_HEX` below before building `.exe`.
"""

from __future__ import annotations

# 32-byte (64-hex) RFC 8032 Ed25519 public verification key.
PUBLIC_VERIFY_KEY_HEX: str = (
    "3b951708d00abcee2e8f405664964c0c158976f336c2039ba0c81a84e6fd31b7"
)
