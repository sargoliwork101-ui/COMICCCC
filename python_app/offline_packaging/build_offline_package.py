"""Build standalone Windows `.exe` (`ComicOCRStudio.exe`) and 1-click offline Setup `.exe`.

Supports two bundle modes (matching user preference):
  1. Default (`--base`): Standalone app + bundled base RapidOCR models (100% offline OCR, compact size).
  2. Full (`--with-nmt`): Standalone app + base RapidOCR + 600M INT8 NLLB-200 offline translator
     (100% offline OCR + Persian/English translation with zero internet access).

Produces:
  - `dist/ComicOCRStudio/ComicOCRStudio.exe` (PyInstaller `onedir` fast-start GUI executable)
  - `dist/ComicOCRStudio-Offline-Setup-<version>.exe` (via Inno Setup `ISCC.exe` if present,
    falling back automatically to Windows built-in `.NET` `csc.exe` self-extracting GUI installer)
  - Optional `wheelhouse/` download (`--download-wheelhouse`) for portable `.bat` offline installs.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tomllib
import zipfile

from PIL import Image

REPO_PY_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_PY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_PY_ROOT))

from comic_studio import APP_VERSION  # noqa: E402
from comic_studio.paths import models_dir  # noqa: E402

SFX_MAGIC = b"COS405PK"


class BuildError(RuntimeError):
    """A build failure that already carries an actionable message for the user.

    v4.33: every expected failure of the offline builder is reported through this
    exception so the builder prints a clear Persian/English explanation instead of a
    raw Python traceback (which is what the user saw: «اصلاً کار نمی‌کنه، همه‌اش پایتونی»).
    """


def _reconfigure_console() -> None:
    """Make sure Persian messages are not garbled when the output is redirected."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass


def say(message: str = "") -> None:
    """Print a builder message and flush immediately.

    Without the flush the builder's own lines appeared *after* the output of
    PyInstaller (which writes straight to the console), so the log looked scrambled.

    v4.36: every line is also appended to ``python_app/build_offline.log`` so the
    seller can paste one file if a build ever fails again (the old `.bat` menu died
    silently at the first question and left nothing behind to look at).
    """
    print(message, flush=True)
    _append_log(message)


def _log_file() -> Path:
    return REPO_PY_ROOT / "build_offline.log"


def _append_log(message: str) -> None:
    try:
        with _log_file().open("a", encoding="utf-8", errors="replace") as handle:
            handle.write(message + "\n")
    except Exception:
        pass


def start_log(title: str) -> None:
    """Start a fresh log file for this run."""
    try:
        path = _log_file()
        path.write_text(f"=== {title} ===\n", encoding="utf-8")
    except Exception:
        pass


def _describe_cmd(cmd: list[str] | str) -> str:
    if isinstance(cmd, str):
        return cmd
    parts = [str(part) for part in cmd]
    for marker in ("PyInstaller", "pip", "ISCC", "csc.exe"):
        if any(marker in part for part in parts):
            return marker
    return parts[0] if parts else "the build step"

PYINSTALLER_SPEC = "pyinstaller>=6.10,<7"
# Official public PyPI mirrors used when `pypi.org` is slow or blocked.
PYPI_FALLBACK_MIRRORS: tuple[tuple[str, str], ...] = (
    ("Aliyun PyPI", "https://mirrors.aliyun.com/pypi/simple/"),
    ("Tsinghua TUNA", "https://pypi.tuna.tsinghua.edu.cn/simple"),
)
PIP_TIMEOUT_SECONDS = 120
PIP_RETRIES = 10


CSHARP_SFX_INSTALLER = r"""
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Comic OCR Studio Offline Setup")]
[assembly: System.Reflection.AssemblyProduct("Comic OCR Studio")]
[assembly: System.Reflection.AssemblyVersion("4.3.6.0")]

namespace ComicStudioInstaller {
    static class Program {
        private static readonly byte[] Magic = Encoding.ASCII.GetBytes("COS405PK");

        [STAThread]
        static int Main(string[] args) {
            bool silent = false;
            string customDir = null;
            for (int i = 0; i < args.Length; i++) {
                string a = args[i] ?? "";
                if (a.Equals("/S", StringComparison.OrdinalIgnoreCase) || a.Equals("--silent", StringComparison.OrdinalIgnoreCase))
                    silent = true;
                else if (a.StartsWith("/D=", StringComparison.OrdinalIgnoreCase))
                    customDir = a.Substring(3).Trim('"');
            }
            string defaultDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "ComicOCRStudio"
            );
            string targetDir = string.IsNullOrWhiteSpace(customDir) ? defaultDir : customDir;
            if (silent) {
                ExtractPayload(Application.ExecutablePath, targetDir, null);
                CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Comic OCR Studio.lnk"), Path.Combine(targetDir, "ComicOCRStudio.exe"), targetDir);
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var form = new SetupForm(targetDir)) {
                Application.Run(form);
                return form.ExitCode;
            }
        }

        public static void ExtractPayload(string exePath, string destDir, Action<int, string> onProgress) {
            using (var fs = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                if (fs.Length < 24) throw new InvalidOperationException("فایل نصاب ناقص است.");
                fs.Seek(-16, SeekOrigin.End);
                byte[] trailer = new byte[16];
                fs.Read(trailer, 0, 16);
                for (int i = 0; i < 8; i++) {
                    if (trailer[8 + i] != Magic[i])
                        throw new InvalidOperationException("امضای بستهٔ آفلاین معتبر نیست.");
                }
                long zipOffset = BitConverter.ToInt64(trailer, 0);
                long zipLength = (fs.Length - 16) - zipOffset;
                if (zipOffset <= 0 || zipLength <= 0)
                    throw new InvalidOperationException("محدودهٔ آرشیو نصاب نامعتبر است.");

                Directory.CreateDirectory(destDir);
                string tempZip = Path.Combine(Path.GetTempPath(), "ComicOCRStudio-Setup-" + Guid.NewGuid().ToString("N") + ".zip");
                try {
                    fs.Seek(zipOffset, SeekOrigin.Begin);
                    using (var outZip = new FileStream(tempZip, FileMode.Create, FileAccess.Write, FileShare.None)) {
                        byte[] buffer = new byte[1024 * 1024];
                        long remaining = zipLength;
                        while (remaining > 0) {
                            int read = fs.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                            if (read <= 0) break;
                            outZip.Write(buffer, 0, read);
                            remaining -= read;
                        }
                    }
                    using (var archive = ZipFile.OpenRead(tempZip)) {
                        int total = Math.Max(1, archive.Entries.Count);
                        int index = 0;
                        string fullRoot = Path.GetFullPath(destDir);
                        if (!fullRoot.EndsWith(Path.DirectorySeparatorChar.ToString()))
                            fullRoot += Path.DirectorySeparatorChar;
                        foreach (var entry in archive.Entries) {
                            index++;
                            string rel = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                            string outPath = Path.GetFullPath(Path.Combine(destDir, rel));
                            if (!outPath.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
                                continue;
                            if (string.IsNullOrEmpty(entry.Name)) {
                                Directory.CreateDirectory(outPath);
                            } else {
                                Directory.CreateDirectory(Path.GetDirectoryName(outPath));
                                entry.ExtractToFile(outPath, true);
                            }
                            if (onProgress != null && (index % 5 == 0 || index == total)) {
                                int pct = (int)Math.Round(index * 100.0 / total);
                                onProgress(pct, entry.Name);
                            }
                        }
                    }
                } finally {
                    try { if (File.Exists(tempZip)) File.Delete(tempZip); } catch { }
                }
            }
        }

        public static void CreateShortcut(string lnkPath, string targetExe, string workDir) {
            try {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null) return;
                dynamic shell = Activator.CreateInstance(shellType);
                dynamic shortcut = shell.CreateShortcut(lnkPath);
                shortcut.TargetPath = targetExe;
                shortcut.WorkingDirectory = workDir;
                shortcut.IconLocation = targetExe + ",0";
                shortcut.Description = "Comic OCR Studio - Offline OCR & Translation";
                shortcut.Save();
            } catch { }
        }
    }

    sealed class SetupForm : Form {
        public int ExitCode = 0;
        private readonly TextBox dirBox;
        private readonly CheckBox desktopChk;
        private readonly CheckBox launchChk;
        private readonly ProgressBar bar;
        private readonly Label statusLbl;
        private readonly Button installBtn;
        private readonly Button browseBtn;

        public SetupForm(string initialDir) {
            Text = "نصب آفلاین Comic OCR Studio " + "__APP_VERSION__";
            Size = new Size(560, 340);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            RightToLeft = RightToLeft.Yes;
            RightToLeftLayout = true;
            Font = new Font("Tahoma", 9.2f);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            var title = new Label {
                Text = "نصاب آفلاین و یک‌کلیکی Comic OCR Studio نسخهٔ __APP_VERSION__",
                Font = new Font("Tahoma", 11f, FontStyle.Bold),
                AutoSize = false,
                Bounds = new Rectangle(20, 16, 505, 28)
            };
            var sub = new Label {
                Text = "نصب کامل بدون نیاز به اینترنت و بدون نیاز به نصب پایتون جداگانه.",
                AutoSize = false,
                Bounds = new Rectangle(20, 46, 505, 22)
            };
            var dirLbl = new Label {
                Text = "پوشهٔ نصب برنامه (هر درایو دلخواه):",
                AutoSize = false,
                Bounds = new Rectangle(20, 78, 505, 20)
            };
            dirBox = new TextBox {
                Text = initialDir,
                RightToLeft = RightToLeft.No,
                Bounds = new Rectangle(125, 102, 400, 26)
            };
            browseBtn = new Button {
                Text = "انتخاب پوشه…",
                Bounds = new Rectangle(20, 100, 98, 28)
            };
            browseBtn.Click += (s, e) => {
                using (var dlg = new FolderBrowserDialog { SelectedPath = dirBox.Text, Description = "پوشهٔ نصب Comic OCR Studio را انتخاب کنید" }) {
                    if (dlg.ShowDialog(this) == DialogResult.OK && !string.IsNullOrWhiteSpace(dlg.SelectedPath))
                        dirBox.Text = Path.Combine(dlg.SelectedPath, "ComicOCRStudio");
                }
            };
            desktopChk = new CheckBox {
                Text = "ساخت آیکون میانبر روی دسکتاپ و منوی Start",
                Checked = true,
                Bounds = new Rectangle(20, 140, 505, 24)
            };
            launchChk = new CheckBox {
                Text = "اجرای فوری Comic OCR Studio بلافاصله پس از پایان نصب",
                Checked = true,
                Bounds = new Rectangle(20, 168, 505, 24)
            };
            bar = new ProgressBar {
                Minimum = 0, Maximum = 100, Value = 0,
                Bounds = new Rectangle(20, 204, 505, 22)
            };
            statusLbl = new Label {
                Text = "آمادهٔ نصب آفلاین.",
                AutoSize = false,
                Bounds = new Rectangle(20, 232, 505, 22)
            };
            installBtn = new Button {
                Text = "نصب آفلاین برنامه",
                Font = new Font("Tahoma", 9.5f, FontStyle.Bold),
                Bounds = new Rectangle(20, 260, 170, 34)
            };
            var cancelBtn = new Button {
                Text = "انصراف",
                Bounds = new Rectangle(200, 260, 95, 34)
            };
            cancelBtn.Click += (s, e) => { ExitCode = 1; Close(); };
            installBtn.Click += (s, e) => StartInstall();

            Controls.AddRange(new Control[] { title, sub, dirLbl, dirBox, browseBtn, desktopChk, launchChk, bar, statusLbl, installBtn, cancelBtn });
        }

        private void StartInstall() {
            string dest = dirBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(dest)) {
                MessageBox.Show(this, "لطفاً مسیر نصب را مشخص کنید.", "خطا", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            installBtn.Enabled = false;
            browseBtn.Enabled = false;
            dirBox.ReadOnly = true;
            statusLbl.Text = "در حال استخراج فایل‌های آفلاین برنامه…";

            Thread worker = new Thread(() => {
                try {
                    Program.ExtractPayload(Application.ExecutablePath, dest, (pct, name) => {
                        try {
                            BeginInvoke((Action)(() => {
                                bar.Value = Math.Max(0, Math.Min(100, pct));
                                statusLbl.Text = "در حال نصب (" + pct + "%) — " + name;
                            }));
                        } catch { }
                    });
                    string exeTarget = Path.Combine(dest, "ComicOCRStudio.exe");
                    if (desktopChk.Checked) {
                        Program.CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Comic OCR Studio.lnk"), exeTarget, dest);
                        string startPrograms = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Comic OCR Studio");
                        Directory.CreateDirectory(startPrograms);
                        Program.CreateShortcut(Path.Combine(startPrograms, "Comic OCR Studio.lnk"), exeTarget, dest);
                    }
                    BeginInvoke((Action)(() => {
                        bar.Value = 100;
                        statusLbl.Text = "نصب با موفقیت کامل شد!";
                        if (launchChk.Checked && File.Exists(exeTarget)) {
                            try { Process.Start(new ProcessStartInfo(exeTarget) { WorkingDirectory = dest }); } catch { }
                        } else {
                            MessageBox.Show(this, "نصب آفلاین Comic OCR Studio با موفقیت انجام شد.", "پایان نصب", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        }
                        ExitCode = 0;
                        Close();
                    }));
                } catch (Exception ex) {
                    BeginInvoke((Action)(() => {
                        installBtn.Enabled = true;
                        browseBtn.Enabled = true;
                        dirBox.ReadOnly = false;
                        statusLbl.Text = "خطا در نصب: " + ex.Message;
                        MessageBox.Show(this, ex.Message, "خطا در نصب", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }));
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }
    }
}
"""


def generate_windows_ico(png_path: Path, ico_path: Path) -> Path:
    """Create a multi-resolution `.ico` from `static/assets/icon128.png` using Pillow."""
    ico_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(png_path) as opened:
        rgba = opened.convert("RGBA")
        upscaled = rgba.resize((256, 256), Image.Resampling.LANCZOS)
        upscaled.save(
            ico_path,
            format="ICO",
            sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
        )
    return ico_path


def project_requirements(pyproject_path: Path) -> list[str]:
    data = tomllib.loads(pyproject_path.read_text("utf-8"))
    project = data["project"]
    return list(project.get("dependencies", [])) + list(project.get("optional-dependencies", {}).get("ocr", []))


def download_wheelhouse(pyproject_path: Path, wheelhouse_dir: Path) -> Path:
    """Download all Windows wheels for `pyproject.toml` + `pyinstaller` into `wheelhouse/`."""
    wheelhouse_dir.mkdir(parents=True, exist_ok=True)
    reqs = project_requirements(pyproject_path) + ["pyinstaller>=6.10,<7"]
    cmd = [
        sys.executable,
        "-m",
        "pip",
        "download",
        "--dest",
        str(wheelhouse_dir),
        *reqs,
    ]
    subprocess.check_call(cmd, cwd=str(REPO_PY_ROOT))
    return wheelhouse_dir


def _pyinstaller_installed(python_exe: str) -> bool:
    try:
        completed = subprocess.run(
            [python_exe, "-c", "import PyInstaller"],
            capture_output=True,
            timeout=120,
            check=False,
        )
    except Exception:
        return False
    return completed.returncode == 0


def _local_wheelhouse_dirs() -> list[Path]:
    """Every local folder that may already hold the PyInstaller wheel."""
    dirs: list[Path] = []
    try:
        dirs.append(REPO_PY_ROOT / "wheelhouse")
    except OSError:
        pass
    try:
        from comic_studio.ocr_managed import sync_local_wheelhouse

        dirs.append(Path(sync_local_wheelhouse()))
    except Exception:
        pass
    return [d for d in dirs if d.is_dir() and any(d.glob("*.whl"))]


def ensure_pyinstaller(python_exe: str | None = None) -> bool:
    """Install PyInstaller without dying on a slow or blocked `pypi.org`.

    Root cause of the old failure: the builder ran a plain `pip install pyinstaller`
    with the default 15 second read timeout, so a slow `pypi.org` produced
    ``ReadTimeoutError`` -> ``(from versions: none)`` and the build stopped.
    Now the install is retried with a long timeout, first from the local
    wheelhouse, then from `pypi.org` and finally from the official public
    mirrors (Aliyun / Tsinghua).
    """
    exe = python_exe or sys.executable
    if _pyinstaller_installed(exe):
        print("[ok] PyInstaller is already installed in the build environment.")
        return True

    base_cmd = [
        exe, "-m", "pip", "install",
        "--disable-pip-version-check",
        "--timeout", str(PIP_TIMEOUT_SECONDS),
        "--retries", str(PIP_RETRIES),
        "--prefer-binary",
    ]
    cache_dir: Path | None = None
    try:
        from comic_studio.ocr_managed import pip_cache_dir

        cache_dir = Path(pip_cache_dir())
    except Exception:
        cache_dir = None

    attempts: list[tuple[str, Path | None, str | None]] = []
    for wheelhouse in _local_wheelhouse_dirs():
        attempts.append((f"local wheelhouse ({wheelhouse})", wheelhouse, None))
    attempts.append(("pypi.org", None, None))
    for name, url in PYPI_FALLBACK_MIRRORS:
        attempts.append((name, None, url))

    for label, wheelhouse, index_url in attempts:
        cmd = list(base_cmd)
        if cache_dir is not None:
            cmd.extend(["--cache-dir", str(cache_dir)])
        if wheelhouse is not None:
            cmd.extend(["--find-links", str(wheelhouse)])
        if index_url:
            cmd.extend(["--index-url", index_url])
        cmd.append(PYINSTALLER_SPEC)
        print(f"[pyinstaller] Installing from {label} ...")
        try:
            completed = subprocess.run(cmd, check=False)
        except Exception as exc:
            print(f"[warn] pip could not be started for {label}: {exc}")
            continue
        if completed.returncode == 0:
            print(f"[ok] PyInstaller installed from {label}.")
            return True
        print(f"[warn] PyInstaller install from {label} failed (exit {completed.returncode}).")
    print(
        "[ERROR] Could not install PyInstaller. Internet access to pypi.org (or one of the public\n"
        "        mirrors) is required, or place the PyInstaller .whl file inside the folder\n"
        "        'python_app\\wheelhouse' and run the build again."
    )
    return False


def verify_bundled_language_models(tess_dir: Path, *, allow_missing: bool = False) -> None:
    """Fail the build when the bundled app could not read Persian or English.

    Root cause of the runtime error `Tesseract language fas is not ready`: the
    offline bundle was built without the Persian language file (the download
    had failed silently), so every Persian OCR run inside the built app died
    with HTTP 503.  The build now stops with an actionable message instead of
    shipping an app that cannot read Persian.
    """
    from comic_studio.ocr import _is_legacy_fast_persian_traineddata

    problems: list[str] = []
    for lang in ("eng", "fas"):
        target = tess_dir / f"{lang}.traineddata"
        if not target.is_file() or target.stat().st_size < 1000:
            problems.append(f"{lang}.traineddata is missing")
    fas_file = tess_dir / "fas.traineddata"
    if fas_file.is_file() and _is_legacy_fast_persian_traineddata(fas_file):
        problems.append(
            "fas.traineddata is the old 431 KB int8 file (tessdata_fast); "
            "the full float32 tessdata_best file (~3.33 MB) is required for correct Persian"
        )
    if not problems:
        print("[ok] Bundled Tesseract language files (eng + fas) are present and up to date.")
        return
    message = (
        "The offline bundle would ship without usable Tesseract language files:\n"
        + "\n".join(f"  - {item}" for item in problems)
        + "\nConnect to the internet and build again (the builder downloads them automatically),\n"
        f"or copy them manually into '{models_dir() / 'tesseract'}' before building."
    )
    if allow_missing:
        say("[warn] " + message.replace("\n", "\n       "))
        say("[warn] The built app cannot read Persian until these files are added.")
        return
    raise BuildError(message)


def verify_bundled_ocr_models(staging_dir: Path, *, allow_missing: bool = False) -> None:
    """Fail the build when the bundled OCR models are missing.

    Root cause of «the offline app does not work»: the builder only checked the
    Tesseract language files and happily shipped a bundle **without the RapidOCR
    models**, so the installed app started but could not read a single line of text.
    Now the OCR models are verified exactly like the language files.
    """
    problems: list[str] = []
    rapid_dir = staging_dir / "rapidocr"
    expected = [
        "ch_PP-OCRv5_det_mobile.onnx",
        "latin_PP-OCRv5_rec_mobile.onnx",
        "arabic_PP-OCRv5_rec_mobile.onnx",
    ]
    present = [name for name in expected if (rapid_dir / name).is_file()]
    if not present:
        problems.append("the RapidOCR models are missing (no .onnx model file was bundled)")
    else:
        for language, rec_name in (("English", "latin_PP-OCRv5_rec_mobile.onnx"), ("Persian", "arabic_PP-OCRv5_rec_mobile.onnx")):
            if rec_name not in present:
                problems.append(f"the {language} OCR model ({rec_name}) is missing")
    if problems:
        message = (
            "The offline bundle would ship without usable OCR models:\n"
            + "\n".join(f"  - {item}" for item in problems)
            + "\nConnect to the internet and build again (the builder downloads them automatically),\n"
            + f"or copy them manually into '{models_dir() / 'rapidocr'}' before building."
        )
        if allow_missing:
            say("[warn] " + message.replace("\n", "\n       "))
            say("[warn] The built app cannot read text until these files are added.")
            return
        raise BuildError(message)
    say("[ok] Bundled RapidOCR models (detector + English + Persian) are present.")


def stage_bundled_models(
    staging_dir: Path,
    *,
    include_nmt: bool = False,
    skip_download: bool = False,
    allow_missing_language_models: bool = False,
) -> Path:
    """Copy or prepare base RapidOCR models (and optionally NLLB-200 600M) into `staging_dir`."""
    if staging_dir.exists():
        shutil.rmtree(staging_dir)
    staging_dir.mkdir(parents=True, exist_ok=True)

    user_models = models_dir()
    rapid_src = user_models / "rapidocr"
    rapid_dst = staging_dir / "rapidocr"
    tess_src = user_models / "tesseract"
    tess_dst = staging_dir / "tesseract"
    if not skip_download:
        from comic_studio.ocr import RapidEngine, TesseractEngine

        engine = RapidEngine("rapidocr-v5", "v5")
        for lang in ("eng", "fas"):
            try:
                engine.download(lang)
            except Exception as exc:
                print(f"[warn] RapidOCR model download for {lang} skipped/failed: {exc}")
        tess_engine = TesseractEngine()
        for lang in ("eng", "fas"):
            try:
                tess_engine._download_language_file(lang)
            except Exception as exc:
                print(f"[warn] Tesseract traineddata download for {lang} skipped/failed: {exc}")
    if rapid_src.is_dir():
        shutil.copytree(rapid_src, rapid_dst, dirs_exist_ok=True)
    if tess_src.is_dir():
        shutil.copytree(tess_src, tess_dst, dirs_exist_ok=True)

    verify_bundled_ocr_models(staging_dir, allow_missing=allow_missing_language_models)
    verify_bundled_language_models(tess_dst, allow_missing=allow_missing_language_models)

    if include_nmt:
        nmt_src = user_models / "local-nmt" / "nllb-600m"
        nmt_dst = staging_dir / "local-nmt" / "nllb-600m"
        if not skip_download:
            from comic_studio.local_nmt import LocalNmtManager

            mgr = LocalNmtManager()
            try:
                mgr.prepare("nllb-600m")
            except Exception as exc:
                message = (
                    "The offline translator model (NLLB-200 600M) could not be prepared:\n"
                    f"  {exc}\n"
                    "Check the internet connection and try again, or build the standard package (without --with-nmt)."
                )
                if allow_missing_language_models:
                    say("[warn] " + message.replace("\n", "\n       "))
                else:
                    raise BuildError(message) from exc
            nmt_src = mgr.model_dir("nllb-600m")
        if nmt_src.is_dir():
            nmt_dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(nmt_src, nmt_dst, dirs_exist_ok=True)
        if not any(nmt_dst.glob("*")):
            message = (
                "The offline bundle would ship without the offline translator model.\n"
                "Connect to the internet and build again, or build the standard package (without --with-nmt)."
            )
            if allow_missing_language_models:
                say("[warn] " + message.replace("\n", "\n       "))
            else:
                raise BuildError(message)

    return staging_dir


def pyinstaller_command(
    *,
    entry_script: Path,
    dist_dir: Path,
    work_dir: Path,
    spec_dir: Path,
    icon_path: Path,
    static_dir: Path,
    staged_models_dir: Path,
) -> list[str]:
    sep = ";" if os.name == "nt" else ":"
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--windowed",
        "--optimize",
        "1",
        "--name",
        "ComicOCRStudio",
        "--distpath",
        str(dist_dir),
        "--workpath",
        str(work_dir),
        "--specpath",
        str(spec_dir),
        "--icon",
        str(icon_path),
        "--add-data",
        f"{static_dir}{sep}comic_studio/static",
    ]
    assets_dir = static_dir.parent / "assets"
    if assets_dir.is_dir():
        cmd.extend(["--add-data", f"{assets_dir}{sep}comic_studio/assets"])
    if any(staged_models_dir.rglob("*")):
        cmd.extend(["--add-data", f"{staged_models_dir}{sep}bundled_models"])

    # v4.33: only ask PyInstaller to collect packages that are really installed.
    # `--collect-all <missing package>` makes PyInstaller abort the whole build, which used
    # to kill the offline build on a machine where one optional runtime was absent.
    import importlib.util

    for pkg in ("rapidocr", "onnxruntime", "ctranslate2", "sentencepiece", "pymupdf", "bidi"):
        try:
            if importlib.util.find_spec(pkg) is None:
                print(f"[warn] Optional package '{pkg}' is not installed - it will not be bundled.")
                continue
        except Exception:
            continue
        cmd.extend(["--collect-all", pkg])

    for hidden in (
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "multipart",
        "python_multipart",
        "cv2",
        "tkinter",
        "tkinter.filedialog",
    ):
        cmd.extend(["--hidden-import", hidden])

    for excluded in (
        "torch",
        "torchvision",
        "torchaudio",
        "transformers",
        "tensorflow",
        "paddle",
        "pytest",
        "license_manager",
    ):
        cmd.extend(["--exclude-module", excluded])

    cmd.append(str(entry_script))
    return cmd


def write_offline_readme(target_dir: Path, *, include_nmt: bool) -> None:
    nmt_line = (
        "- مدل مترجم آفلاین NLLB-200 (600M) نیز داخل بسته قرار دارد و بدون اینترنت ترجمه می‌کند."
        if include_nmt
        else "- موتور پایهٔ OCR آفلاین داخل بسته قرار دارد؛ مدل مترجم آفلاین را نیز هر زمان بخواهید از داخل برنامه می‌توانید اضافه کنید."
    )
    text = (
        f"Comic OCR Studio v{APP_VERSION} — نسخهٔ اجرایی آفلاین ویندوز\r\n"
        "=============================================================\r\n\r\n"
        "روش اجرا (فقط یک کلیک):\r\n"
        "  روی فایل ComicOCRStudio.exe دوبار کلیک کنید.\r\n"
        "  برنامه بلافاصله سرور محلی را بالا آورده و در مرورگر شما باز می‌شود.\r\n\r\n"
        "ویژگی‌های بسته:\r\n"
        "  - بدون نیاز به نصب پایتون و بدون نیاز به اتصال اینترنت.\r\n"
        f"  {nmt_line}\r\n"
        "  - با بستن تب مرورگر، برنامه به‌صورت خودکار و تمیز بسته می‌شود.\r\n"
    )
    (target_dir / "README-OFFLINE-FA.txt").write_text(text, encoding="utf-8")


def find_iscc() -> Path | None:
    env_iscc = shutil.which("ISCC") or shutil.which("iscc")
    if env_iscc:
        return Path(env_iscc)
    if os.name == "nt":
        for root in (
            os.environ.get("ProgramFiles(x86)"),
            os.environ.get("ProgramFiles"),
            os.environ.get("LOCALAPPDATA"),
        ):
            if not root:
                continue
            for rel in ("Inno Setup 6/ISCC.exe", "Programs/Inno Setup 6/ISCC.exe"):
                candidate = Path(root) / rel
                if candidate.is_file():
                    return candidate
    return None


def find_dotnet_csc() -> Path | None:
    if os.name != "nt":
        return None
    windir = Path(os.environ.get("SystemRoot") or r"C:\Windows")
    for sub in (
        r"Microsoft.NET\Framework64\v4.0.30319\csc.exe",
        r"Microsoft.NET\Framework\v4.0.30319\csc.exe",
    ):
        candidate = windir / sub
        if candidate.is_file():
            return candidate
    return None


def append_sfx_zip_payload(stub_exe: Path, payload_zip: Path, output_setup_exe: Path) -> Path:
    """Combine a compiled stub `.exe` + `.zip` archive + 16-byte `(offset, magic)` trailer."""
    output_setup_exe.parent.mkdir(parents=True, exist_ok=True)
    stub_bytes = stub_exe.read_bytes()
    zip_offset = len(stub_bytes)
    with output_setup_exe.open("wb") as out_f:
        out_f.write(stub_bytes)
        with payload_zip.open("rb") as zip_f:
            shutil.copyfileobj(zip_f, out_f, length=1024 * 1024)
        out_f.write(struct.pack("<Q8s", zip_offset, SFX_MAGIC))
    return output_setup_exe


def read_sfx_trailer(setup_exe: Path) -> tuple[int, int]:
    """Validate and return `(zip_offset, zip_size)` from a SFX installer `.exe`."""
    size = setup_exe.stat().st_size
    if size < 24:
        raise ValueError("File too small to contain SFX trailer")
    with setup_exe.open("rb") as f:
        f.seek(-16, os.SEEK_END)
        raw = f.read(16)
    zip_offset, magic = struct.unpack("<Q8s", raw)
    if magic != SFX_MAGIC:
        raise ValueError(f"Invalid SFX magic: {magic!r}")
    zip_size = (size - 16) - zip_offset
    if zip_offset <= 0 or zip_size <= 0:
        raise ValueError("Invalid SFX zip bounds")
    return zip_offset, zip_size


def zip_directory(source_dir: Path, zip_path: Path) -> Path:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for item in sorted(source_dir.rglob("*")):
            rel = item.relative_to(source_dir).as_posix()
            if item.is_dir():
                continue
            zf.write(item, arcname=rel)
    return zip_path


def build_windows_installer(
    *,
    app_dist_dir: Path,
    dist_root: Path,
    build_root: Path,
    icon_path: Path,
    suffix: str = "",
) -> Path:
    base_name = f"ComicOCRStudio-Offline-Setup-{APP_VERSION}{suffix}"
    output_exe = dist_root / f"{base_name}.exe"

    iscc = find_iscc()
    iss_script = Path(__file__).resolve().parent / "ComicOCRStudio.iss"
    if iscc and iss_script.is_file():
        print(f"[installer] Building Inno Setup installer with {iscc} ...")
        subprocess.check_call([
            str(iscc),
            f"/DAppVersion={APP_VERSION}",
            f"/DSourceDistDir={app_dist_dir}",
            f"/DIconPath={icon_path}",
            f"/DOutputDirPath={dist_root}",
            f"/DOutputBaseName={base_name}",
            str(iss_script),
        ])
        if output_exe.is_file():
            return output_exe

    payload_zip = dist_root / f"{base_name}.zip"
    print(f"[installer] Compressing offline bundle archive {payload_zip.name} ...")
    zip_directory(app_dist_dir, payload_zip)

    csc = find_dotnet_csc()
    if csc:
        print(f"[installer] Building native Windows GUI Setup .exe via {csc} ...")
        cs_source = build_root / "SetupStub.cs"
        stub_exe = build_root / "SetupStub.exe"
        cs_code = CSHARP_SFX_INSTALLER.replace("__APP_VERSION__", APP_VERSION)
        cs_source.write_text(cs_code, encoding="utf-8-sig")
        subprocess.check_call([
            str(csc),
            "/nologo",
            "/target:winexe",
            "/optimize+",
            f"/out:{stub_exe}",
            f"/win32icon:{icon_path}",
            "/r:System.dll",
            "/r:System.Drawing.dll",
            "/r:System.Windows.Forms.dll",
            "/r:System.IO.Compression.dll",
            "/r:System.IO.Compression.FileSystem.dll",
            "/r:Microsoft.CSharp.dll",
            str(cs_source),
        ])
        append_sfx_zip_payload(stub_exe, payload_zip, output_exe)
        return output_exe

    return payload_zip


def build_native_license_guard(app_dist_dir: Path, build_root: Path, public_key_hex: str) -> Path | None:
    """Compile a native Windows guard (`ComicLicenseGuard.exe`) embedding the public key SHA-256."""
    csc = find_dotnet_csc()
    if csc is None:
        return None
    pub_sha = hashlib.sha256(bytes.fromhex(public_key_hex.strip())).hexdigest().lower()
    guard_cs = build_root / "ComicLicenseGuard.cs"
    internal_dir = app_dist_dir / "_internal"
    target_dir = internal_dir if internal_dir.is_dir() else app_dist_dir
    guard_exe = target_dir / "ComicLicenseGuard.exe"
    guard_src = f"""using System;
using System.Security.Cryptography;
using System.Text;

internal static class ComicLicenseGuard {{
    private const string PubSha = "{pub_sha}";
    private static int Main(string[] args) {{
        if (args == null || args.Length < 1 || string.IsNullOrWhiteSpace(args[0])) return 2;
        byte[] key = Encoding.ASCII.GetBytes(PubSha);
        byte[] msg = Encoding.ASCII.GetBytes("CS4-GUARD:" + args[0].Trim());
        using (var h = new HMACSHA256(key)) {{
            byte[] mac = h.ComputeHash(msg);
            var sb = new StringBuilder(mac.Length * 2);
            foreach (byte b in mac) sb.Append(b.ToString("x2"));
            Console.Out.Write(sb.ToString());
        }}
        return 0;
    }}
}}
"""
    guard_cs.write_text(guard_src, encoding="utf-8-sig")
    subprocess.check_call(
        [
            str(csc),
            "/nologo",
            "/optimize+",
            "/target:exe",
            f"/out:{guard_exe}",
            str(guard_cs),
        ]
    )
    return guard_exe


def verify_no_seller_secrets_in_dist(app_dist_dir: Path) -> None:
    """Fail the build immediately if any seller-only script, customer DB, or private key leaked into dist."""
    forbidden_markers = (
        "seller_master_key",
        ".seller-key.json",
        "seller_customers",
        "issued_licenses",
        "license_manager.py",
        "start_license_manager.bat",
    )
    for item in app_dist_dir.rglob("*"):
        low = item.name.lower()
        if any(marker in low for marker in forbidden_markers):
            raise RuntimeError(f"SECURITY ABORT: Seller-only file detected in customer bundle: {item}")


def verify_built_app(app_dist_dir: Path, *, expect_models: bool = True) -> None:
    """Check the built app folder before it is packaged into an installer.

    Root cause of «the offline app does not work»: the build could finish while the
    executable or the bundled models were missing, and the broken result was handed
    to the customer as if it were fine.
    """
    problems: list[str] = []
    if not app_dist_dir.is_dir():
        problems.append(f"the output folder '{app_dist_dir}' was not created")
    else:
        exe = app_dist_dir / "ComicOCRStudio.exe"
        if not exe.is_file():
            linux_exe = app_dist_dir / "ComicOCRStudio"
            if not linux_exe.is_file():
                problems.append("the ComicOCRStudio executable is missing from the output folder")
        internal = app_dist_dir / "_internal"
        base = internal if internal.is_dir() else app_dist_dir
        if not (base / "comic_studio" / "static" / "index.html").is_file():
            problems.append("the program files (static folder) are missing from the built app")
        if expect_models:
            models_root = base / "bundled_models"
            rapid_bundle = models_root / "rapidocr"
            if not models_root.is_dir():
                problems.append("the offline OCR models were not bundled into the app")
            elif not rapid_bundle.is_dir() or not any(rapid_bundle.glob("*.onnx")):
                problems.append("the RapidOCR models are not inside the bundled_models folder")
    if not problems:
        say("[ok] The built app contains the executable, the program files and the offline models.")
        return
    raise BuildError(
        "The build finished but the result is not usable:\n"
        + "\n".join(f"  - {item}" for item in problems)
        + "\nNothing was installed; please report this message."
    )


def run_preflight(*, include_nmt: bool = False) -> int:
    """Check the build environment in seconds and print a clear checklist.

    v4.33: the seller could not tell *why* the offline build failed, so the builder
    now offers a self-test that answers every question before the long build starts.
    v4.34: the checklist wording was misleading - a missing item was printed with the
    sentence "X is installed" behind a [warn] mark, so a perfectly ready machine
    looked broken. Every line now has a neutral name plus the real state, and items
    that the builder solves on its own are shown as a note, not as a problem.
    """
    say("=" * 72)
    say(f"  Comic OCR Studio v{APP_VERSION} - بررسی آمادگی ساخت بستهٔ آفلاین")
    say("=" * 72)
    problems: list[str] = []
    notes: list[str] = []

    def check(name: str, ok: bool, detail: str = "", *, severity: str = "blocking") -> bool:
        """Print one checklist line. `name` is a neutral label, `detail` states the state.

        `severity` decides how a missing item is reported:
          - "blocking": the build cannot succeed -> counted as a problem,
          - "warn": a heads-up that does not stop the build,
          - "note": informational only (the builder solves it on its own).
        """
        if severity == "blocking":
            mark = "[ok]  " if ok else "[warn]"
            if not ok:
                problems.append(f"{name}: {detail}" if detail else name)
        elif severity == "warn":
            mark = "[ok]  " if ok else "[warn]"
            if not ok:
                notes.append(f"{name}: {detail}" if detail else name)
        else:
            mark = "[ok]  " if ok else "[note]"
            if not ok:
                notes.append(f"{name}: {detail}" if detail else name)
        say(f"  {mark} {name}" + (f" - {detail}" if detail else ""))
        return ok

    def note(text: str) -> None:
        say(f"  [note] {text}")
        notes.append(text)

    py_ok = sys.version_info >= (3, 11)
    check(
        "Python 3.11 or newer",
        py_ok,
        f"Python {sys.version.split()[0]}" if py_ok else f"Python {sys.version.split()[0]} is too old",
    )
    try:
        import comic_studio  # noqa: F401

        check("Program package (comic_studio)", True, "imported successfully")
    except Exception as exc:
        check("Program package (comic_studio)", False, f"cannot be imported: {exc}")
    pyi_ok = _pyinstaller_installed(sys.executable)
    check(
        "PyInstaller (the packer that makes the .exe)",
        pyi_ok,
        "installed" if pyi_ok else "not installed - it will be installed automatically during the build",
        severity="note",
    )
    icon_png = REPO_PY_ROOT / "comic_studio" / "static" / "assets" / "icon128.png"
    check(
        "Program icon",
        icon_png.is_file(),
        str(icon_png) if icon_png.is_file() else f"missing: {icon_png}",
    )

    rapid_dir = models_dir() / "rapidocr"
    rapid_ok = rapid_dir.is_dir() and any(rapid_dir.glob("*.onnx"))
    check(
        "OCR models (RapidOCR)",
        rapid_ok,
        f"found in {rapid_dir}" if rapid_ok else f"not found in {rapid_dir} - connect to the internet and build again",
    )
    tess_dir = models_dir() / "tesseract"
    tess_ok = all((tess_dir / f"{lang}.traineddata").is_file() for lang in ("eng", "fas"))
    check(
        "Language files (eng + fas)",
        tess_ok,
        f"found in {tess_dir}" if tess_ok else f"not found in {tess_dir} - connect to the internet and build again",
    )
    if include_nmt:
        nmt_dir = models_dir() / "local-nmt" / "nllb-600m"
        check(
            "Offline translator model (NLLB-200 600M)",
            nmt_dir.is_dir(),
            f"found in {nmt_dir}" if nmt_dir.is_dir() else f"not found in {nmt_dir} - connect to the internet and build again",
        )

    try:
        from license_manager import SellerVault

        vault = SellerVault()
        status = vault.key_status()
        if status.get("vaultPublicKey"):
            check("Seller master key", True, f"found in {status.get('masterKeyPath', '')}")
            backup_ok = bool(status.get("backupExists"))
            check(
                "Backup copy of the seller master key",
                backup_ok,
                f"found in {status.get('backupPath', '')}" if backup_ok else f"missing in {status.get('backupPath', '')} - it is created automatically",
                severity="warn",
            )
        elif int(status.get("issuedCount") or 0) > 0:
            check(
                "Seller master key",
                False,
                "the private seller folder has no master key, but licenses were already issued - restore it "
                "(or import your backup) before building, otherwise every license your customers have stops working",
            )
        else:
            check("Seller master key", True, "a new master key will be created on the first build")
    except Exception as exc:
        check("Seller master key", False, str(exc))

    iscc = find_iscc()
    csc = find_dotnet_csc()
    if iscc:
        check("Inno Setup (makes the real .exe installer)", True, str(iscc), severity="note")
    elif csc:
        check(
            "Inno Setup (makes the real .exe installer)",
            True,
            "not installed - a self-extracting .exe installer will be built instead",
            severity="note",
        )
    else:
        check(
            "Inno Setup (makes the real .exe installer)",
            True,
            "not installed - only a .zip archive can be produced",
            severity="note",
        )
        note("برای ساخت فایل نصاب واقعی .exe، نرم‌افزار «Inno Setup 6» را نصب کنید.")

    try:
        usage = shutil.disk_usage(str(REPO_PY_ROOT))
        free_gb = usage.free / (1024 ** 3)
        check(
            "Free disk space",
            free_gb >= 3.0,
            f"{free_gb:.1f} GB free" if free_gb >= 3.0 else f"only {free_gb:.1f} GB free - the build needs about 3 GB",
        )
    except Exception:
        pass

    say("-" * 72)
    if problems:
        say(f"  {len(problems)} مورد آماده نیست و باید درست شود:")
        for item in problems:
            say(f"    - {item}")
        if any(("OCR models" in p) or ("Language files" in p) or ("translator" in p) for p in problems):
            say("  راه‌حل مدل‌ها: یک‌بار اینترنت را وصل کنید و دوباره اجرا کنید (مدل‌ها خودکار دانلود می‌شوند).")
        if any("Seller master key" in p for p in problems):
            say("  راه‌حل کلید مادر: پنل فروشنده (start_license_manager.bat) را باز کنید یا فایل پشتیبان کلید را برگردانید.")
        say("  تا آن زمان ساخت بستهٔ آفلاین انجام نمی‌شود.")
    else:
        say("  همه‌چیز آماده است — ساخت بستهٔ آفلاین باید با موفقیت انجام شود.")
    if notes:
        say("")
        for item in notes:
            say(f"  یادآوری: {item}")
    say("=" * 72)
    return 0 if not problems else 1


def _ask(question: str, default: str = "") -> str:
    """Ask one question. An empty answer means "use the default".

    v4.36: the questions are asked by Python instead of the `.bat` file. The old
    `set /p` based menu died silently on the seller's machine right after the
    output-folder question, so the menu now lives where it can be tested.
    """
    try:
        raw = input(question)
    except (EOFError, KeyboardInterrupt):
        raw = ""
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
        raw = raw[1:-1].strip()
    return raw or default


def interactive_menu() -> tuple[str, str]:
    """Ask the seller what to build. Returns ``(mode, output_dir)``.

    ``mode`` is one of ``"1"``, ``"2"``, ``"3"`` or ``"4"`` (self-test only).
    """
    say("=" * 72)
    say(f"  Comic OCR Studio v{APP_VERSION} - Offline Windows EXE & Setup Builder")
    say("=" * 72)
    say("")
    say("Select offline package variant to build:")
    say("  [1] Standard Offline Setup (App + Base RapidOCR models - compact & fast)")
    say("  [2] Full Offline Setup     (App + Base RapidOCR + 600M Offline NLLB Translator)")
    say("  [3] Full Offline Setup + Download wheelhouse\\ for portable .bat installs")
    say("  [4] Self-test only         (check this computer, build nothing)")
    say("")
    choice = _ask("Enter choice [1/2/3/4] (default 1): ", "1")
    if choice not in {"1", "2", "3", "4"}:
        say(f"[note] '{choice}' is not one of 1/2/3/4 - continuing with 1.")
        choice = "1"
    say(f"   Selected: {choice}")
    if choice == "4":
        return "4", ""

    default_out = str(REPO_PY_ROOT / "dist")
    say("")
    say("Folder that receives the built EXE files:")
    say(r"  Standalone app : <output folder>\ComicOCRStudio\ComicOCRStudio.exe")
    say(rf"  Offline Setup  : <output folder>\ComicOCRStudio-Offline-Setup-{APP_VERSION}.exe")
    say("")
    out_dir = _ask(f"Output folder (press Enter for {default_out}): ", default_out)
    out_path = Path(out_dir).expanduser()
    say(f"   Output folder: {out_path}")
    say("")
    return choice, str(out_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=f"Build Comic OCR Studio v{APP_VERSION} Offline .exe & Setup")
    parser.add_argument("--with-nmt", action="store_true", help="Bundle 600M offline NLLB-200 translator inside the offline installer")
    parser.add_argument("--skip-model-download", action="store_true", help="Only bundle models already present in local models directory")
    parser.add_argument("--download-wheelhouse", action="store_true", help="Populate python_app/wheelhouse with offline pip wheels")
    parser.add_argument(
        "--output-dir",
        default="",
        help="Folder that receives the standalone EXE folder and the offline Setup .exe (default: python_app/dist)",
    )
    parser.add_argument(
        "--build-dir",
        default="",
        help="Temporary folder used by PyInstaller while building (default: python_app/build/offline_pkg)",
    )
    parser.add_argument(
        "--ensure-pyinstaller",
        action="store_true",
        help="Only install PyInstaller (with mirror fallback) and exit",
    )
    parser.add_argument(
        "--allow-missing-language-models",
        action="store_true",
        help="Do not stop the build when the bundled OCR models / language files are missing",
    )
    parser.add_argument(
        "--preflight",
        action="store_true",
        help="Only check whether this computer can build the offline package (fast self-test) and exit",
    )
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Ask which package to build and where to put it, then build (used by the .bat launcher)",
    )
    args = parser.parse_args(argv)

    _reconfigure_console()
    start_log(f"Comic OCR Studio v{APP_VERSION} offline builder - {' '.join(sys.argv[1:]) or 'no arguments'}")

    if args.interactive:
        mode, out_dir = interactive_menu()
        if mode == "4":
            return run_preflight(include_nmt=args.with_nmt)
        args.output_dir = out_dir
        if mode in {"2", "3"}:
            args.with_nmt = True
        if mode == "3":
            args.download_wheelhouse = True

    if args.preflight:
        return run_preflight(include_nmt=args.with_nmt)

    try:
        return _run_build(args)
    except BuildError as exc:
        say("")
        say("=" * 72)
        say(f"[ERROR] ساخت بستهٔ آفلاین انجام نشد: {exc}")
        say(f"       گزارش کامل: {_log_file()}")
        say("=" * 72)
        return 1
    except subprocess.CalledProcessError as exc:
        say("")
        say("=" * 72)
        say(f"[ERROR] مرحلهٔ «{_describe_cmd(exc.cmd)}» با خطا متوقف شد (کد خروجی {exc.returncode}).")
        say("       پیام‌های بالای صفحه دلیل خطا را نشان می‌دهند.")
        say("       اگر مدل‌ها یا فایل‌های زبان دانلود نشده‌اند، یک‌بار اینترنت را وصل کنید و دوباره تلاش کنید.")
        say("=" * 72)
        return 1
    except KeyboardInterrupt:
        say("")
        say("[ERROR] ساخت بستهٔ آفلاین توسط کاربر لغو شد.")
        return 130
    except Exception as exc:  # last resort - the user never sees a raw Python traceback
        say("")
        say("=" * 72)
        say(f"[ERROR] ساخت بستهٔ آفلاین با یک خطای غیرمنتظره متوقف شد: {exc}")
        say(f"       ({type(exc).__name__}) - اگر این خطا تکرار شد، متن کامل بالا را نگه دارید.")
        say(f"       گزارش کامل: {_log_file()}")
        say("=" * 72)
        return 1


def _run_build(args: argparse.Namespace) -> int:
    build_root = Path(args.build_dir).expanduser().resolve() if args.build_dir else REPO_PY_ROOT / "build" / "offline_pkg"
    dist_root = Path(args.output_dir).expanduser().resolve() if args.output_dir else REPO_PY_ROOT / "dist"
    build_root.mkdir(parents=True, exist_ok=True)
    dist_root.mkdir(parents=True, exist_ok=True)

    if args.ensure_pyinstaller:
        if ensure_pyinstaller():
            return 0
        raise BuildError(
            "PyInstaller could not be installed. Internet access to pypi.org (or one of the public\n"
            "       mirrors) is required, or copy the PyInstaller .whl file into the folder\n"
            "       'python_app\\wheelhouse' and run the build again."
        )

    if not ensure_pyinstaller():
        raise BuildError(
            "PyInstaller could not be installed. Internet access to pypi.org (or one of the public\n"
            "       mirrors) is required, or copy the PyInstaller .whl file into the folder\n"
            "       'python_app\\wheelhouse' and run the build again."
        )

    from license_manager import SellerKeyLostError, SellerVault

    vault = SellerVault()
    key_state_before = vault.key_status()
    try:
        synced_bundle = vault.sync_all_before_exe_build()
    except SellerKeyLostError as exc:
        raise BuildError(str(exc)) from exc
    seller_info = synced_bundle["key"]
    vc_info = synced_bundle["vendorContact"]
    key_status = synced_bundle.get("keyStatus") or {}
    if not key_state_before.get("vaultPublicKey"):
        # The private seller folder was empty: a brand new keypair was created and the key
        # inside the app was replaced. Licenses issued with the old key stop working.
        issued = int(key_state_before.get("issuedCount") or 0)
        if issued:
            raise BuildError(
                f"The private seller folder has no master key, but {issued} license(s) were already issued.\n"
                "       A new key was created, which would break every license your customers have.\n"
                "       Restore your master key (the backup file inside the seller folder) and build again."
            )
        say("[warn] The private seller folder was empty, so a NEW master key was created for this build.")
        say("[warn] If you issued licenses on another computer, restore your master key backup first -")
        say("[warn] otherwise those licenses will not be accepted by the new build.")
    say(f"[ok] Synced seller Ed25519 public key into build (fingerprint: {seller_info['fingerprint']})")
    say(f"[ok] Synced customer-facing contact info into build (phone: {vc_info['supportPhone']})")
    # v4.32: never ship an EXE with a key that differs from the seller's vault, and warn loudly
    # when the seller key was (re)created - that invalidates every license issued before.
    for warning in key_status.get("warnings") or []:
        say(f"[warn] {warning}")
    embedded_now = SellerVault().embedded_public_key_hex()
    if embedded_now and embedded_now != str(seller_info["public_key_hex"]).lower():
        raise BuildError(
            "The key embedded in the app does NOT match the seller's master key.\n"
            "       Restore the seller key (or run start_license_manager.bat once) and build again -\n"
            "       shipping this build would break every license your customers already have."
        )
    if not key_status.get("backupExists"):
        say("[warn] No backup copy of the seller master key exists yet (see <seller dir>/backup/).")

    if args.download_wheelhouse:
        wh = download_wheelhouse(REPO_PY_ROOT / "pyproject.toml", REPO_PY_ROOT / "wheelhouse")
        say(f"[ok] Offline wheelhouse ready at: {wh}")

    icon_png = REPO_PY_ROOT / "comic_studio" / "static" / "assets" / "icon128.png"
    if not icon_png.is_file():
        raise BuildError(f"The program icon is missing: {icon_png}")
    icon_ico = generate_windows_ico(icon_png, build_root / "ComicOCRStudio.ico")
    say(f"[ok] Generated multi-size Windows icon: {icon_ico}")

    staged_models = stage_bundled_models(
        build_root / "bundled_models",
        include_nmt=args.with_nmt,
        skip_download=args.skip_model_download,
        allow_missing_language_models=args.allow_missing_language_models,
    )
    say(f"[ok] Staged bundled offline models (with_nmt={args.with_nmt}): {staged_models}")

    cmd = pyinstaller_command(
        entry_script=REPO_PY_ROOT / "run.py",
        dist_dir=dist_root,
        work_dir=build_root / "pyi_work",
        spec_dir=build_root,
        icon_path=icon_ico,
        static_dir=REPO_PY_ROOT / "comic_studio" / "static",
        staged_models_dir=staged_models,
    )
    say("[pyinstaller] Running: " + " ".join(cmd))
    subprocess.check_call(cmd, cwd=str(REPO_PY_ROOT))

    app_dist_dir = dist_root / "ComicOCRStudio"
    verify_built_app(app_dist_dir, expect_models=not args.allow_missing_language_models)
    guard_bin = build_native_license_guard(app_dist_dir, build_root, seller_info["public_key_hex"])
    if guard_bin is not None:
        say(f"[ok] Compiled native public-key integrity guard: {guard_bin}")
    verify_no_seller_secrets_in_dist(app_dist_dir)
    write_offline_readme(app_dist_dir, include_nmt=args.with_nmt)

    suffix = "-Full-NMT" if args.with_nmt else ""
    installer_artifact = build_windows_installer(
        app_dist_dir=app_dist_dir,
        dist_root=dist_root,
        build_root=build_root,
        icon_path=icon_ico,
        suffix=suffix,
    )
    say("")
    say("=" * 72)
    say("  BUILD COMPLETE - ساخت بستهٔ آفلاین با موفقیت انجام شد")
    say("=" * 72)
    say(f"  برنامهٔ مستقل (پوشه) : {app_dist_dir}")
    say(f"  فایل نصاب آفلاین    : {installer_artifact}")
    if installer_artifact.suffix.lower() != ".exe":
        say("")
        say("  [warn] Inno Setup روی این رایانه نصب نیست، بنابراین به‌جای فایل نصاب .exe یک")
        say("         آرشیو .zip ساخته شد. برای ساخت فایل نصاب واقعی، «Inno Setup 6» را نصب کنید")
        say("         و دوباره همین سازنده را اجرا کنید.")
    say("=" * 72)
    say(f"  گزارش کامل این ساخت: {_log_file()}")
    say("=" * 72)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
