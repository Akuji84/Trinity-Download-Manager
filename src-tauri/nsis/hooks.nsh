!macro NSIS_HOOK_POSTINSTALL
  ; Ship a dedicated shortcut icon into the install directory so the desktop .lnk
  ; and Start menu entries do not depend on Explorer's exe icon extraction/cache behavior.
  SetOutPath "$INSTDIR"
  File "/oname=trinity-shortcut.ico" "..\..\..\..\icons\icon.ico"

  ; Recreate the desktop and Start menu shortcuts during install using the dedicated icon source.
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\trinity-shortcut.ico" 0
  CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\trinity-shortcut.ico" 0
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  System::Call 'Shell32::SHChangeNotify(i 0x00000008, i 0x1001, t "$DESKTOP\${PRODUCTNAME}.lnk", p 0)'
  System::Call 'Shell32::SHChangeNotify(i 0x00000008, i 0x1001, t "$SMPROGRAMS\${PRODUCTNAME}.lnk", p 0)'
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'

  ; Prevent the Finish page checkbox flow from replacing the working shortcut.
  StrCpy $NoShortcutMode 1
!macroend
