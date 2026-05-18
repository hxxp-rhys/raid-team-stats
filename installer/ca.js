// MSI custom actions for the Raid Team Stats Uploader installer.
// JScript (WSH) — `Session` is the global MSI session object.
//
//   verifyInputs   immediate: validate WoW folder + API token (live HTTP)
//   writeConfig    deferred:  write config.json from the user's inputs
//   installAddon   deferred:  copy the addon into <WoW>\_retail_\Interface\AddOns
//   startup        deferred:  optional hidden logon task running --watch
//   uninstallClean deferred:  remove the addon folder + the logon task

function trimSlash(p) {
  while (p.length && p.charAt(p.length - 1) === "\\") p = p.substr(0, p.length - 1);
  return p;
}
function jstr(s) {
  s = String(s);
  var o = "", i, c;
  for (i = 0; i < s.length; i++) {
    c = s.charAt(s.length ? i : 0);
    if (c === "\\") o += "\\\\";
    else if (c === '"') o += '\\"';
    else if (c === "\n") o += "\\n";
    else if (c === "\r") o += "\\r";
    else if (c === "\t") o += "\\t";
    else o += c;
  }
  return '"' + o + '"';
}
function caData() {
  return ("" + Session.Property("CustomActionData")).split("|");
}

// ── immediate: validate the two user inputs before the install proceeds ──
function verifyInputs() {
  try {
    Session.Property("RTS_ERR") = "";
    var wow = trimSlash("" + Session.Property("WOWPATH"));
    var key = ("" + Session.Property("APIKEY")).replace(/^\s+|\s+$/g, "");
    var api = trimSlash("" + Session.Property("APIBASE"));

    if (!key) {
      Session.Property("RTS_ERR") =
        "Enter your upload token (Account page on the website).";
      return;
    }
    var fso = new ActiveXObject("Scripting.FileSystemObject");
    if (!wow || !fso.FolderExists(wow + "\\_retail_")) {
      Session.Property("RTS_ERR") =
        "That folder is not a World of Warcraft install (no _retail_ folder inside it).";
      return;
    }
    if (api.toLowerCase().substr(0, 8) !== "https://") {
      Session.Property("RTS_ERR") = "Server URL must be https://.";
      return;
    }

    var http = new ActiveXObject("WinHttp.WinHttpRequest.5.1");
    http.SetTimeouts(5000, 8000, 8000, 15000);
    http.Open("POST", api + "/uploader/verify", false);
    http.SetRequestHeader("Authorization", "Bearer " + key);
    http.SetRequestHeader("Content-Type", "text/plain");
    http.Send("");
    var st = http.Status;
    var body = "" + http.ResponseText;
    if (st === 200 && body.indexOf('"ok":true') !== -1) {
      return; // valid — RTS_ERR stays empty
    }
    if (st === 401) {
      Session.Property("RTS_ERR") =
        "The upload token was rejected. Re-copy it from the Account page.";
    } else {
      Session.Property("RTS_ERR") =
        "Could not verify the token (server said " + st + ").";
    }
  } catch (e) {
    Session.Property("RTS_ERR") =
      "Could not reach the server to verify the token. Check your connection.";
  }
}

function ensureTree(fso, path) {
  if (fso.FolderExists(path)) return;
  var parent = fso.GetParentFolderName(path);
  if (parent && !fso.FolderExists(parent)) ensureTree(fso, parent);
  fso.CreateFolder(path);
}

// ── deferred: write config.json next to the companion exe ──
function writeConfig() {
  var d = caData(); // INSTALLFOLDER | APIKEY | WOWPATH | APIBASE
  var dir = trimSlash(d[0]);
  var key = d[1];
  var wow = trimSlash(d[2]);
  var api = trimSlash(d[3]);
  var fso = new ActiveXObject("Scripting.FileSystemObject");
  ensureTree(fso, dir);
  var json =
    "{\n" +
    '  "api": ' + jstr(api) + ",\n" +
    '  "token": ' + jstr(key) + ",\n" +
    '  "wowPath": ' + jstr(wow) + "\n" +
    "}\n";
  var f = fso.CreateTextFile(dir + "\\config.json", true);
  f.Write(json);
  f.Close();
}

// ── deferred: install the addon into the chosen WoW folder ──
function installAddon() {
  var d = caData(); // INSTALLFOLDER | WOWPATH
  var dir = trimSlash(d[0]);
  var wow = trimSlash(d[1]);
  var fso = new ActiveXObject("Scripting.FileSystemObject");
  var src = dir + "\\addon";
  var dst = wow + "\\_retail_\\Interface\\AddOns\\RaidTeamStatsUploader";
  ensureTree(fso, dst);
  // copy each staged addon file (overwrite)
  var folder = fso.GetFolder(src);
  var e = new Enumerator(folder.Files);
  for (; !e.atEnd(); e.moveNext()) {
    var file = e.item();
    fso.CopyFile(file.Path, dst + "\\" + file.Name, true);
  }
}

function xmlEsc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── deferred: optional hidden logon task + start it NOW ──
//
// This CA runs deferred + non-impersonated, i.e. as LocalSystem in
// session 0. If the task is left to default to that account it never
// runs the uploader in the user's interactive session (the old bug:
// "it was supposed to start after install but nothing uploaded").
// Fix: define the task via Task Scheduler XML bound explicitly to the
// installing user with LogonType=InteractiveToken (runs hidden, in
// THEIR session, no stored password), then /Run it immediately — the
// companion does an upload right away (runOnce) before it starts
// watching.
function startup() {
  try {
    var d = caData(); // INSTALLFOLDER | RUNATSTARTUP | LogonUser | ComputerName
    var dir = trimSlash(d[0]);
    var on = d[1];
    var user = ("" + (d[2] || "")).replace(/^\s+|\s+$/g, "");
    var comp = ("" + (d[3] || "")).replace(/^\s+|\s+$/g, "");
    if (on !== "1") return;

    var sh = new ActiveXObject("WScript.Shell");
    var fso = new ActiveXObject("Scripting.FileSystemObject");
    var vbs = dir + "\\run-hidden.vbs";

    // "COMPUTER\\user" for a local account; pass through if a domain is
    // already present. Task Scheduler resolves this for the principal.
    var principal =
      user && user.indexOf("\\") !== -1
        ? user
        : comp && user
          ? comp + "\\" + user
          : user;

    var created = false;
    if (principal) {
      var pEsc = xmlEsc(principal);
      var argsEsc = xmlEsc('//B "' + vbs + '"');
      var xml =
        '<?xml version="1.0" encoding="UTF-16"?>\r\n' +
        '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\r\n' +
        "  <RegistrationInfo>\r\n" +
        "    <Description>Raid Team Stats Uploader - syncs your WoW data after each /reload or logout.</Description>\r\n" +
        "  </RegistrationInfo>\r\n" +
        "  <Triggers>\r\n" +
        "    <LogonTrigger><Enabled>true</Enabled><UserId>" +
        pEsc +
        "</UserId></LogonTrigger>\r\n" +
        "  </Triggers>\r\n" +
        "  <Principals>\r\n" +
        '    <Principal id="Author">\r\n' +
        "      <UserId>" +
        pEsc +
        "</UserId>\r\n" +
        "      <LogonType>InteractiveToken</LogonType>\r\n" +
        "      <RunLevel>LeastPrivilege</RunLevel>\r\n" +
        "    </Principal>\r\n" +
        "  </Principals>\r\n" +
        "  <Settings>\r\n" +
        "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\r\n" +
        "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\r\n" +
        "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\r\n" +
        "    <AllowHardTerminate>true</AllowHardTerminate>\r\n" +
        "    <StartWhenAvailable>true</StartWhenAvailable>\r\n" +
        "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\r\n" +
        "    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>\r\n" +
        "    <AllowStartOnDemand>true</AllowStartOnDemand>\r\n" +
        "    <Enabled>true</Enabled>\r\n" +
        "    <Hidden>true</Hidden>\r\n" +
        "    <RunOnlyIfIdle>false</RunOnlyIfIdle>\r\n" +
        "    <WakeToRun>false</WakeToRun>\r\n" +
        "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\r\n" +
        "    <Priority>7</Priority>\r\n" +
        "  </Settings>\r\n" +
        '  <Actions Context="Author">\r\n' +
        "    <Exec><Command>wscript.exe</Command><Arguments>" +
        argsEsc +
        "</Arguments></Exec>\r\n" +
        "  </Actions>\r\n" +
        "</Task>\r\n";
      var xmlPath = dir + "\\rts-task.xml";
      var tf = fso.CreateTextFile(xmlPath, true, true); // Unicode (UTF-16LE+BOM)
      tf.Write(xml);
      tf.Close();
      // NOTE: keep sh.Run() calls single-line with no trailing comma —
      // the MSI scripting host is classic (ES3) JScript, which rejects
      // trailing commas in argument lists (compile error → every CA
      // fails → "Setup ended prematurely"). Build the command in a var.
      var createCmd =
        'cmd /c schtasks /Create /F /TN "RaidTeamStatsUploader" /XML "' +
        xmlPath +
        '"';
      var rc = sh.Run(createCmd, 0, true);
      created = rc === 0;
      try {
        fso.DeleteFile(xmlPath);
      } catch (e1) {}
    }

    // Fallback: command-line form, still bound to the real user and
    // interactive (/IT, no password) so it runs in their session.
    if (!created) {
      var tr = 'wscript.exe //B \\"' + vbs + '\\"';
      var ru = principal ? ' /IT /RU "' + principal + '"' : "";
      var fbCmd =
        "cmd /c schtasks /Create /F /SC ONLOGON /RL LIMITED" +
        ru +
        ' /TN "RaidTeamStatsUploader" /TR "' +
        tr +
        '"';
      sh.Run(fbCmd, 0, true);
    }

    // Start it now so the user doesn't have to sign out/in first. With
    // an InteractiveToken principal this lands in their session; the
    // companion uploads immediately, then watches.
    sh.Run('cmd /c schtasks /Run /TN "RaidTeamStatsUploader"', 0, true);
  } catch (e) {
    // best-effort: never fail the install over the optional autostart
  }
}

// ── deferred (ignored): stop the agent BEFORE files are removed ──
function stopAgent() {
  try {
    var sh = new ActiveXObject("WScript.Shell");
    // Stop a running task instance, delete the task, then kill the
    // watcher so RemoveFiles can delete the (otherwise locked) exe and
    // the uploader stops immediately.
    sh.Run('cmd /c schtasks /End /TN "RaidTeamStatsUploader"', 0, true);
    sh.Run('cmd /c schtasks /Delete /F /TN "RaidTeamStatsUploader"', 0, true);
    sh.Run('cmd /c taskkill /F /IM rts-companion.exe', 0, true);
  } catch (e) {}
}

// ── deferred (ignored): deep uninstall cleanup ──
function uninstallClean() {
  try {
    var d = caData(); // WOWPATH | INSTALLFOLDER
    var wow = trimSlash(d[0]);
    var dir = trimSlash(d[1]);
    var fso = new ActiveXObject("Scripting.FileSystemObject");
    // 1. addon copied into the WoW folder (not an MSI component)
    var addon = wow + "\\_retail_\\Interface\\AddOns\\RaidTeamStatsUploader";
    if (fso.FolderExists(addon)) fso.DeleteFolder(addon, true);
    // 2. config.json + anything left in the install dir (config.json is
    //    CA-written so MSI won't remove it; nuke the whole dir — it's all
    //    ours — so nothing is left behind).
    if (dir && fso.FolderExists(dir)) fso.DeleteFolder(dir, true);
  } catch (e) {}
}
