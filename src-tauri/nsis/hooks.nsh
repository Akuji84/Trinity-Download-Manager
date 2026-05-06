!macro NSIS_HOOK_POSTINSTALL
  ; Kill Explorer so its icon cache database files are not locked
  ExecWait '"$SYSDIR\taskkill.exe" /f /im explorer.exe'
  Sleep 1500

  ; Delete Windows 10/11 icon cache DB files so the new app icon is read fresh
  System::Call 'kernel32::GetEnvironmentVariable(t "LOCALAPPDATA", t .r1, i 1024) i'
  FindFirst $2 $3 "$R1\Microsoft\Windows\Explorer\iconcache_*.db"
  trinity_icon_loop:
    StrCmp $3 "" trinity_icon_done
    Delete "$R1\Microsoft\Windows\Explorer\$3"
    FindNext $2 $3
    Goto trinity_icon_loop
  trinity_icon_done:
  FindClose $2

  ; Restart Explorer
  Exec '"$WINDIR\explorer.exe"'
  Sleep 1000
!macroend
