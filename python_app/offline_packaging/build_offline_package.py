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
[assembly: System.Reflection.AssemblyVersion("4.1.9.0")]

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


def stage_bundled_models(staging_dir: Path, *, include_nmt: bool = False, skip_download: bool = False) -> Path:
    """Copy or prepare base RapidOCR models (and optionally NLLB-200 600M) into `staging_dir`."""
    if staging_dir.exists():
        shutil.rmtree(staging_dir)
    staging_dir.mkdir(parents=True, exist_ok=True)

    user_models = models_dir()
    rapid_src = user_models / "rapidocr"
    rapid_dst = staging_dir / "rapidocr"
    if not skip_download:
        from comic_studio.ocr import RapidEngine

        engine = RapidEngine("rapidocr-v5", "v5")
        for lang in ("eng", "fas"):
            try:
                engine.download(lang)
            except Exception as exc:
                print(f"[warn] RapidOCR model download for {lang} skipped/failed: {exc}")
    if rapid_src.is_dir():
        shutil.copytree(rapid_src, rapid_dst, dirs_exist_ok=True)

    if include_nmt:
        nmt_src = user_models / "local-nmt" / "nllb-600m"
        nmt_dst = staging_dir / "local-nmt" / "nllb-600m"
        if not skip_download:
            from comic_studio.local_nmt import LocalNmtManager

            mgr = LocalNmtManager()
            mgr.prepare("nllb-600m")
            nmt_src = mgr.model_dir("nllb-600m")
        if nmt_src.is_dir():
            nmt_dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(nmt_src, nmt_dst, dirs_exist_ok=True)

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
    if any(staged_models_dir.rglob("*")):
        cmd.extend(["--add-data", f"{staged_models_dir}{sep}bundled_models"])

    for pkg in ("rapidocr", "onnxruntime", "ctranslate2", "sentencepiece", "pymupdf", "bidi"):
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=f"Build Comic OCR Studio v{APP_VERSION} Offline .exe & Setup")
    parser.add_argument("--with-nmt", action="store_true", help="Bundle 600M offline NLLB-200 translator inside the offline installer")
    parser.add_argument("--skip-model-download", action="store_true", help="Only bundle models already present in local models directory")
    parser.add_argument("--download-wheelhouse", action="store_true", help="Populate python_app/wheelhouse with offline pip wheels")
    args = parser.parse_args(argv)

    build_root = REPO_PY_ROOT / "build" / "offline_pkg"
    dist_root = REPO_PY_ROOT / "dist"
    build_root.mkdir(parents=True, exist_ok=True)
    dist_root.mkdir(parents=True, exist_ok=True)

    from license_manager import SellerVault

    synced_bundle = SellerVault().sync_all_before_exe_build()
    seller_info = synced_bundle["key"]
    vc_info = synced_bundle["vendorContact"]
    print(f"[ok] Synced seller Ed25519 public key into build (fingerprint: {seller_info['fingerprint']})")
    print(f"[ok] Synced customer-facing contact info into build (phone: {vc_info['supportPhone']})")

    if args.download_wheelhouse:
        wh = download_wheelhouse(REPO_PY_ROOT / "pyproject.toml", REPO_PY_ROOT / "wheelhouse")
        print(f"[ok] Offline wheelhouse ready at: {wh}")

    icon_png = REPO_PY_ROOT / "comic_studio" / "static" / "assets" / "icon128.png"
    icon_ico = generate_windows_ico(icon_png, build_root / "ComicOCRStudio.ico")
    print(f"[ok] Generated multi-size Windows icon: {icon_ico}")

    staged_models = stage_bundled_models(
        build_root / "bundled_models",
        include_nmt=args.with_nmt,
        skip_download=args.skip_model_download,
    )
    print(f"[ok] Staged bundled offline models (with_nmt={args.with_nmt}): {staged_models}")

    cmd = pyinstaller_command(
        entry_script=REPO_PY_ROOT / "run.py",
        dist_dir=dist_root,
        work_dir=build_root / "pyi_work",
        spec_dir=build_root,
        icon_path=icon_ico,
        static_dir=REPO_PY_ROOT / "comic_studio" / "static",
        staged_models_dir=staged_models,
    )
    print("[pyinstaller] Running:", " ".join(cmd))
    subprocess.check_call(cmd, cwd=str(REPO_PY_ROOT))

    app_dist_dir = dist_root / "ComicOCRStudio"
    guard_bin = build_native_license_guard(app_dist_dir, build_root, seller_info["public_key_hex"])
    if guard_bin is not None:
        print(f"[ok] Compiled native public-key integrity guard: {guard_bin}")
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
    print(f"\n[SUCCESS] Standalone executable folder: {app_dist_dir}")
    print(f"[SUCCESS] Offline installer package : {installer_artifact}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
