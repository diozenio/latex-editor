; QuillTex NSIS hooks. Tauri's uninstaller already offers "Delete the application
; data"; this adds a second, separate checkbox for the user's projects and
; cleans up the Claude Code MCP registration.

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var DeleteProjectsCheckbox
Var DeleteProjects

!macro NSIS_HOOK_PREUNINSTALL
  ; Silent uninstalls (updates) never delete projects.
  StrCpy $DeleteProjects 0
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Also delete your projects in $PROFILE\Documents\QuillTex?$\r$\n$\r$\nThis permanently deletes every project folder. Choose No to keep them." \
      IDNO +2
    StrCpy $DeleteProjects 1
  ${EndIf}
  ; Remove the MCP registration from Claude Code (ignore failures).
  nsExec::Exec 'cmd /c claude mcp remove quilltex --scope user'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteProjects == 1
    RMDir /r "$PROFILE\Documents\QuillTex"
  ${EndIf}
!macroend
