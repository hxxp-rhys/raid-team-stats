' Launches the companion uploader in --watch mode with NO visible window.
' Used by the optional "run at Windows startup" logon task.
Dim fso, dir, sh
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run """" & dir & "\rts-companion.exe"" --watch", 0, False
