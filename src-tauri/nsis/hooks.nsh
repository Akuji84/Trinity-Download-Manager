!macro NSIS_HOOK_POSTINSTALL
  ; Flush the Windows icon cache so desktop shortcut shows the Trinity icon immediately
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0x00001000, p 0, p 0)'
!macroend
