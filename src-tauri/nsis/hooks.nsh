; lnkX64IconFix: clears the SLDF_HAS_EXP_ICON_SZ flag (0x00040000) from a .lnk file.
; On 64-bit Windows, NSIS sets this flag which causes Explorer to expand environment
; variables in the icon path, resulting in the wrong icon being displayed.
Function lnkX64IconFix
  Exch $R0   ; input: path to .lnk file
  Push $R1   ; file handle
  Push $R2   ; LinkFlags DWORD
  Push $R3   ; bytes read/written

  System::Call 'kernel32::CreateFileW(w R0, i 0xC0000000, i 3, i 0, i 3, i 128, i 0) i .R1'
  ; INVALID_HANDLE_VALUE = -1; skip if open failed
  IntCmp $R1 -1 lnkfix_done lnkfix_done lnkfix_open

  lnkfix_open:
  ; Seek to offset 0x14 (20): LinkFlags field in the Shell Link Header
  System::Call 'kernel32::SetFilePointer(i R1, i 20, i 0, i 0)'
  System::Call 'kernel32::ReadFile(i R1, *i .R2, i 4, *i .R3, i 0)'
  ; Clear SLDF_HAS_EXP_ICON_SZ (bit 18 = 0x00040000)
  IntOp $R2 $R2 & 0xFFFBFFFF
  System::Call 'kernel32::SetFilePointer(i R1, i 20, i 0, i 0)'
  System::Call 'kernel32::WriteFile(i R1, *i R2, i 4, *i .R3, i 0)'
  System::Call 'kernel32::CloseHandle(i R1)'

  lnkfix_done:
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  ; Recreate the desktop shortcut with an explicit IconLocation so Windows creates
  ; a fresh icon cache entry rather than reusing a stale one for the exe path.
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"

  ; Remove the SLDF_HAS_EXP_ICON_SZ flag that causes wrong icons on 64-bit Windows
  Push "$DESKTOP\${PRODUCTNAME}.lnk"
  Call lnkX64IconFix

  ; Notify shell: item updated, then flush all icon notifications
  System::Call 'Shell32::SHChangeNotify(i 0x00000008, i 0x1001, t "$DESKTOP\${PRODUCTNAME}.lnk", p 0)'
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'

  ; Prevent the Finish page checkbox from overwriting our correctly-iconed shortcut
  StrCpy $NoShortcutMode 1
!macroend
