; Inno Setup Script for HaSaYa Studio (100% Offline Windows Installer)
; Automatically invoked by offline_packaging/build_offline_package.py when ISCC.exe is installed.

#ifndef AppVersion
  #define AppVersion "4.76"
#endif
#ifndef SourceDistDir
  #define SourceDistDir "..\dist\HaSaYaStudio"
#endif
#ifndef IconPath
  #define IconPath "..\build\HaSaYaStudio.ico"
#endif
#ifndef OutputDirPath
  #define OutputDirPath "..\dist"
#endif
#ifndef OutputBaseName
  #define OutputBaseName "HaSaYaStudio-Offline-Setup-4.76"
#endif

[Setup]
AppId={{D9C48341-7C9E-4982-9F88-405C0B1C57A0}
AppName=HaSaYa Studio
AppVersion={#AppVersion}
AppVerName=HaSaYa Studio {#AppVersion}
AppPublisher=HaSaYa Studio
DefaultDirName={autopf}\HaSaYaStudio
DefaultGroupName=HaSaYa Studio
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir={#OutputDirPath}
OutputBaseFilename={#OutputBaseName}
SetupIconFile={#IconPath}
UninstallDisplayIcon={app}\HaSaYaStudio.exe
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
Name: "{group}\HaSaYa Studio"; Filename: "{app}\HaSaYaStudio.exe"; WorkingDir: "{app}"
Name: "{group}\Uninstall HaSaYa Studio"; Filename: "{uninstallexe}"
Name: "{autodesktop}\HaSaYa Studio"; Filename: "{app}\HaSaYaStudio.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\HaSaYaStudio.exe"; Description: "Launch HaSaYa Studio (اجرای فوری برنامه)"; Flags: nowait postinstall skipifsilent
