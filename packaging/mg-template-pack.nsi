Unicode True
!include "MUI2.nsh"

!ifndef PAYLOAD_DIR
  !error "PAYLOAD_DIR is required"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif
!ifndef PACK_VERSION
  !define PACK_VERSION "0.0.0"
!endif

Name "Story Claw MG Template Pack"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\StoryClaw\mg-templates"
InstallDirRegKey HKCU "Software\StoryClaw\MGTemplatePack" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "MG Template Pack" SEC_MAIN
  SetShellVarContext current
  RMDir /r "$INSTDIR\src"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\public"
  RMDir /r "$INSTDIR\tools"
  Delete "$INSTDIR\manifest.json"
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD_DIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\StoryClaw\MGTemplatePack" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StoryClawMGTemplatePack" "DisplayName" "Story Claw MG Template Pack"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StoryClawMGTemplatePack" "DisplayVersion" "${PACK_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StoryClawMGTemplatePack" "Publisher" "Story Claw"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StoryClawMGTemplatePack" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StoryClawMGTemplatePack" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StoryClawMGTemplatePack" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StoryClawMGTemplatePack"
  DeleteRegKey HKCU "Software\StoryClaw\MGTemplatePack"
  RMDir /r "$INSTDIR"
SectionEnd
