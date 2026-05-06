!macro NSIS_HOOK_POSTINSTALL
  ; Ship a dedicated shortcut icon into the install directory so the desktop .lnk
  ; does not depend on Explorer's exe icon extraction/cache behavior.
  SetOutPath "$INSTDIR"
  File "/oname=trinity-shortcut.ico" "..\..\..\..\icons\icon.ico"
!macroend

Function .onGUIEnd
  ; If the installer run ended with a desktop shortcut present, rebuild it
  ; against the dedicated installed .ico after the Finish-page checkbox logic.
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 done
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\trinity-shortcut.ico" 0
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  System::Call 'Shell32::SHChangeNotify(i 0x00000008, i 0x1001, t "$DESKTOP\${PRODUCTNAME}.lnk", p 0)'
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
done:
FunctionEnd
