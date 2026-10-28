' Soru Ekleme - pencere acmadan (gizli) baslatici
'   cift tikla        : sunucuyu arka planda baslatir (zaten calisiyorsa bir sey yapmaz)
'   /kur              : Windows ile birlikte otomatik acilmasini ayarlar
'   /kaldir           : otomatik acilmayi kaldirir
Option Explicit

Dim sh, fso, dir, arg, lnkPath
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
lnkPath = sh.SpecialFolders("Startup") & "\Soru Ekleme.lnk"

arg = ""
If WScript.Arguments.Count > 0 Then arg = LCase(WScript.Arguments(0))

If arg = "/kur" Then
  Dim lnk
  Set lnk = sh.CreateShortcut(lnkPath)
  lnk.TargetPath = "wscript.exe"
  lnk.Arguments = """" & WScript.ScriptFullName & """"
  lnk.WorkingDirectory = dir
  lnk.WindowStyle = 7
  lnk.Description = "Soru Ekleme sunucusunu arka planda baslatir"
  lnk.Save
  StartServer
  MsgBox "Tamam! Soru Ekleme artik bilgisayar her acildiginda arka planda kendiliginden baslayacak." & vbCrLf & vbCrLf & _
         "Sunucu su an da baslatildi; masaustundeki Soru Ekleme simgesine tiklayabilirsiniz." & vbCrLf & vbCrLf & _
         "Not: Bu klasoru baska yere tasirsaniz bu islemi tekrar yapin.", 64, "Soru Ekleme"
  WScript.Quit
ElseIf arg = "/kaldir" Then
  If fso.FileExists(lnkPath) Then fso.DeleteFile lnkPath
  MsgBox "Otomatik baslatma kaldirildi.", 64, "Soru Ekleme"
  WScript.Quit
End If

StartServer

' ---------------------------------------------------------------
Sub StartServer()
  If ServerRunning() Then Exit Sub
  sh.CurrentDirectory = dir
  sh.Environment("Process")("SORU_NO_BROWSER") = "1"   ' acilista tarayici sekmesi acilmasin
  Dim rc
  rc = sh.Run("cmd /c where node >nul 2>nul", 0, True)
  If rc = 0 Then
    sh.Run "cmd /c node """ & dir & "\sunucu.js""", 0, False
  Else
    sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\sunucu.ps1""", 0, False
  End If
End Sub

Function ServerRunning()
  Dim ports, p, http
  ServerRunning = False
  ports = Array(5500, 5501, 5502, 5503, 8080)
  On Error Resume Next
  For Each p In ports
    Err.Clear
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 300, 300, 500, 1000
    http.open "GET", "http://127.0.0.1:" & p & "/", False
    http.send
    If Err.Number = 0 Then
      If http.Status = 200 Then
        If InStr(http.responseText, "Soru Ekleme") > 0 Then
          ServerRunning = True
          Exit For
        End If
      End If
    End If
  Next
  On Error GoTo 0
End Function
