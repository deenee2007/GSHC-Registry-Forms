' GSHC Registry Forms — silent launcher
' Checks if the server is already up; starts Node only if not.
' Run setup.bat once to register this as a silent startup task.

Dim alreadyUp : alreadyUp = False
On Error Resume Next
Dim http : Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "GET", "http://localhost:3100", False
http.Send
alreadyUp = (Err.Number = 0 And http.Status > 0)
On Error GoTo 0

If Not alreadyUp Then
  Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")
  Dim sh  : Set sh  = CreateObject("WScript.Shell")
  Dim projectDir : projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
  sh.CurrentDirectory = projectDir
  ' 0 = hidden window, False = don't wait
  sh.Run "cmd /c node server.js", 0, False
  WScript.Sleep 2000
End If

' Open the app in the default browser
CreateObject("WScript.Shell").Run "http://localhost:3100", 1, False
