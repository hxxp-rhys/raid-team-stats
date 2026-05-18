// MSI custom actions for the Raid Team Stats Uploader installer.
// JScript (WSH) — `Session` is the global MSI session object.
//
//   verifyInputs   immediate: validate WoW folder + API token (live HTTP)
//   writeConfig    deferred:  write config.json from the user's inputs
//   installAddon   deferred:  copy the addon into <WoW>\_retail_\Interface\AddOns
//   stopAgent      deferred:  kill the running exe + delete any LEGACY
//                             scheduled task (pre-1.0.6) on uninstall/upgrade
//   uninstallClean deferred:  remove the addon folder + the install dir
//
// Autostart is NO LONGER a scheduled task — it's a declarative HKLM Run
// component in Package.wxs (a normal Windows startup app). No startup CA.

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

// Autostart is NOT a custom action anymore. It's a declarative HKLM Run
// registry component (AutostartRun in Package.wxs), i.e. a normal Windows
// startup app: it runs in the signed-in user's session at logon, shows in
// Task Manager > Startup, and is created/removed by the MSI itself — no
// scheduled task, no SYSTEM/session-0, no JScript. stopAgent() below still
// deletes any LEGACY scheduled task from pre-1.0.6 installs so an upgrade
// cleans up the old mechanism.

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
