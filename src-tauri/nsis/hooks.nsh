!macro NSIS_HOOK_POSTINSTALL
  ; Notify the shell of icon/association changes after installation
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0x00001000, p 0, p 0)'
!macroend
