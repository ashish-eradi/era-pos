!macro customCheckAppRunning
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -Command "if (Get-Process -Name '${PRODUCT_FILENAME}' -ErrorAction SilentlyContinue) { exit 15 } else { exit 0 }"`
  Pop $R0
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close the shift and use Back up and quit for update in the counter, then run Setup again." /SD IDOK
    SetErrorLevel 23
    Quit
  ${EndIf}
!macroend
