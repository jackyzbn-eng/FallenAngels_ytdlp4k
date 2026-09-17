; ytdlp4k 安装包脚本（Inno Setup 6）
; 编译：ISCC.exe ytdlp4k.iss
; 产物：output\ytdlp4k_setup.exe

#define MyAppName "ytdlp4k"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Jacky"
#define MyAppExeName "ytdlp4k.exe"

[Setup]
; AppId 唯一标识本程序，升级安装时复用（勿随意更改）
AppId={{12BD8EFC-BAFB-467C-9057-CA8022EE0502}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; 允许用户选择安装位置（目录页保持显示）
AllowNoIcons=yes
OutputDir=output
OutputBaseFilename=ytdlp4k_setup_v{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; 默认按“为所有人安装”（装到 Program Files，需管理员授权）；
; 安装向导首页可选“仅为我安装”改为用户目录、免 UAC
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
SetupLogging=yes

[Languages]
Name: "chinese"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
; 主程序
Source: "..\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
; 下载内核 + JS 运行时 + 音视频工具（全部内置，装完离线即可用）
Source: "..\tools\yt-dlp.exe"; DestDir: "{app}\tools"; Flags: ignoreversion
Source: "..\tools\deno.exe"; DestDir: "{app}\tools"; Flags: ignoreversion
Source: "..\tools\ffmpeg\bin\ffmpeg.exe"; DestDir: "{app}\tools\ffmpeg\bin"; Flags: ignoreversion
Source: "..\tools\ffmpeg\bin\ffprobe.exe"; DestDir: "{app}\tools\ffmpeg\bin"; Flags: ignoreversion
; 使用说明
Source: "..\README.md"; DestDir: "{app}"; DestName: "使用说明.md"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
