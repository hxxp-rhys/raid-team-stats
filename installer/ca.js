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

// ── deferred: optional hidden logon task running the uploader --watch ──
function startup() {
  try {
    var d = caData(); // INSTALLFOLDER | RUNATSTARTUP
    var dir = trimSlash(d[0]);
    var on = d[1];
    if (on !== "1") return;
    var sh = new ActiveXObject("WScript.Shell");
    var vbs = dir + "\\run-hidden.vbs";
    var tr = 'wscript.exe //B "' + vbs + '"';
    var cmd =
      'schtasks /Create /F /SC ONLOGON /RL LIMITED ' +
      '/TN "RaidTeamStatsUploader" /TR "' + tr.replace(/"/g, '\\"') + '"';
    sh.Run('cmd /c ' + cmd, 0, true);
  } catch (e) {
    // best-effort: never fail the install over the optional autostart
  }
}

// ── deferred (ignored): uninstall cleanup ──
function uninstallClean() {
  try {
    var wow = trimSlash(caData()[0]);
    var sh = new ActiveXObject("WScript.Shell");
    sh.Run('cmd /c schtasks /Delete /F /TN "RaidTeamStatsUploader"', 0, true);
    var fso = new ActiveXObject("Scripting.FileSystemObject");
    var dst = wow + "\\_retail_\\Interface\\AddOns\\RaidTeamStatsUploader";
    if (fso.FolderExists(dst)) fso.DeleteFolder(dst, true);
  } catch (e) {}
}
