; Inno Setup Script for Comic OCR Studio (100% Offline Windows Installer)
; Automatically invoked by offline_packaging/build_offline_package.py when ISCC.exe is installed.

#ifndef AppVersion
  #define AppVersion "4.12"
#endif
#ifndef SourceDistDir
  #define SourceDistDir "..\dist\ComicOCRStudio"
#endif
#ifndef IconPath
  #define IconPath "..\build\ComicOCRStudio.ico"
#endif
#ifndef OutputDirPath
  #define OutputDirPath "..\dist"
#endif
#ifndef OutputBaseName
  #define OutputBaseName "ComicOCRStudio-Offline-Setup-4.12"
#endif

[Setup]
AppId={{D9C48341-7C9E-4982-9F88-405C0B1C57A0}
AppName=Comic OCR Studio
AppVersion={#AppVersion}
AppVerName=Comic OCR Studio {#AppVersion}
AppPublisher=Comic OCR Studio
DefaultDirName={autopf}\ComicOCRStudio
DefaultGroupName=Comic OCR Studio
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir={#OutputDirPath}
OutputBaseFilename={#OutputBaseName}
SetupIconFile={#IconPath}
UninstallDisplayIcon={app}\ComicOCRStudio.exe
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &Desktop shortcut (ساخت میانبر روی دسکتاپ)"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#SourceDistDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Comic OCR Studio"; Filename: "{app}\ComicOCRStudio.exe"; WorkingDir: "{app}"
Name: "{group}\Uninstall Comic OCR Studio"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Comic OCR Studio"; Filename: "{app}\ComicOCRStudio.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\ComicOCRStudio.exe"; Description: "Launch Comic OCR Studio (اجرای فوری برنامه)"; Flags: nowait postinstall skipifsilent
