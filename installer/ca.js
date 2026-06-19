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

// Fail-open install/uninstall telemetry. POSTs {event, version} to the
// website's /uploader/event (Bearer token), so the roster widget can show
// whether a member has the companion installed. This MUST NEVER throw - a
// telemetry/network failure must not affect an install or block an uninstall
// (callers also wrap it). Same WinHttp shape as verifyInputs. ver may be "".
function postEvent(api, token, ev, ver) {
  try {
    api = trimSlash("" + api);
    token = ("" + token).replace(/^\s+|\s+$/g, "");
    if (!api || !token || token.length < 16) return;
    var body = '{"event":' + jstr(ev);
    if (ver) body += ',"version":' + jstr(ver);
    body += "}";
    var http = new ActiveXObject("WinHttp.WinHttpRequest.5.1");
    http.SetTimeouts(5000, 8000, 8000, 15000);
    http.Open("POST", api + "/uploader/event", false);
    http.SetRequestHeader("Authorization", "Bearer " + token);
    http.SetRequestHeader("Content-Type", "application/json");
    http.Send(body);
  } catch (e) {}
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
    if (!api) {
      Session.Property("RTS_ERR") =
        "Enter your Raid Stats site address (e.g. https://raid.example.com).";
      return;
    }
    if (api.toLowerCase().substr(0, 8) !== "https://") {
      Session.Property("RTS_ERR") = "Site address must start with https:// .";
      return;
    }
    // Self-hostable: the destination is the user-entered site, NOT pinned to
    // one host. Safety: the URL is typed + confirmed in the GUI and must be
    // HTTPS, and the token is verified against THIS host (below) before any
    // data is sent. (Silent installs must pass a trusted APIBASE.)

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

function localAppDataDir(user) {
  // The installing user's per-user, non-world-readable config home.
  return "C:\\Users\\" + user + "\\AppData\\Local\\RaidTeamStats";
}

// ── deferred: write config.json into the user's %LOCALAPPDATA% ──
// SECURITY (H3b): the upload token must NOT sit in the world-readable
// Program Files dir. Write it under the installing user's
// %LOCALAPPDATA%\RaidTeamStats (per-user ACL — other standard users
// can't read it) and delete any legacy Program Files copy.
function writeConfig() {
  var d = caData(); // INSTALLFOLDER | APIKEY | WOWPATH | APIBASE | LOGONUSER | PRODUCTVERSION
  var inst = trimSlash(d[0]);
  var key = d[1];
  var wow = trimSlash(d[2]);
  var api = trimSlash(d[3]);
  var user = ("" + (d[4] || "")).replace(/^\s+|\s+$/g, "");
  var fso = new ActiveXObject("Scripting.FileSystemObject");
  var dir = user ? localAppDataDir(user) : inst; // edge/silent fallback
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
  // Scrub a legacy plaintext config left in Program Files by older
  // installs so the token is no longer readable there.
  try {
    var legacy = inst + "\\config.json";
    if (inst && dir !== inst && fso.FileExists(legacy)) {
      fso.DeleteFile(legacy, true);
    }
  } catch (e) {}
  // Telemetry (fail-open): notify the website this companion was installed.
  // api = d[3], key = d[1]; d[5] = ProductVersion (from SetWriteConfig).
  postEvent(api, key, "install", "" + (d[5] || ""));
}

// ── deferred: install the addon into the chosen WoW folder ──
function installAddon() {
  var d = caData(); // INSTALLFOLDER | WOWPATH
  var dir = trimSlash(d[0]);
  var wow = trimSlash(d[1]);
  var fso = new ActiveXObject("Scripting.FileSystemObject");
  var src = dir + "\\addon";
  // Drop the pre-rebrand addon folder so the old copy can't keep loading
  // and writing a stale SavedVariables the companion no longer reads.
  var legacy = wow + "\\_retail_\\Interface\\AddOns\\RaidTeamStatsUploader";
  if (fso.FolderExists(legacy)) fso.DeleteFolder(legacy, true);
  var dst = wow + "\\_retail_\\Interface\\AddOns\\StatSmith";
  ensureTree(fso, dst);
  // copy each staged addon file (overwrite)
  var folder = fso.GetFolder(src);
  var e = new Enumerator(folder.Files);
  for (; !e.atEnd(); e.moveNext()) {
    var file = e.item();
    fso.CopyFile(file.Path, dst + "\\" + file.Name, true);
  }
  // Scrub the pre-1.0.15 autostart: the old HKLM\...\Run value (it landed
  // in WOW6432Node — a 32-bit reg delete from here targets the same view)
  // and the orphaned StartupApproved\Run32 entry Windows created for it,
  // so Task Manager > Startup has no stale "RaidTeamStatsUploader" row.
  try {
    var sh = new ActiveXObject("WScript.Shell");
    var rmRun = 'cmd /c reg delete "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v RaidTeamStatsUploader /f';
    sh.Run(rmRun, 0, true);
    var rmApproved = 'cmd /c reg delete "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32" /v RaidTeamStatsUploader /f';
    sh.Run(rmApproved, 0, true);
  } catch (regErr) {}
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
    var d = caData(); // WOWPATH | INSTALLFOLDER | LOGONUSER
    var wow = trimSlash(d[0]);
    var dir = trimSlash(d[1]);
    var user = ("" + (d[2] || "")).replace(/^\s+|\s+$/g, "");
    var fso = new ActiveXObject("Scripting.FileSystemObject");
    // Telemetry (fail-open): notify the website BEFORE we delete config.json
    // (the api + token live in it). Read them from disk, post "uninstall".
    try {
      var cfg = user ? (localAppDataDir(user) + "\\config.json") : "";
      if (cfg && fso.FileExists(cfg)) {
        var tf = fso.OpenTextFile(cfg, 1);
        var txt = "" + tf.ReadAll();
        tf.Close();
        var am = txt.match(/"api"\s*:\s*"([^"]*)"/);
        var tm = txt.match(/"token"\s*:\s*"([^"]*)"/);
        if (am && tm) postEvent(am[1], tm[1], "uninstall", "");
      }
    } catch (eU) {}
    // 1. addon copied into the WoW folder (not an MSI component) — remove
    //    the current name AND any pre-rebrand folder left by old installs.
    var addon = wow + "\\_retail_\\Interface\\AddOns\\StatSmith";
    if (fso.FolderExists(addon)) fso.DeleteFolder(addon, true);
    var addonOld = wow + "\\_retail_\\Interface\\AddOns\\RaidTeamStatsUploader";
    if (fso.FolderExists(addonOld)) fso.DeleteFolder(addonOld, true);
    // 2. anything left in the install dir (legacy config.json etc.).
    if (dir && fso.FolderExists(dir)) fso.DeleteFolder(dir, true);
    // 3. the per-user config home (H3b — token lives here now).
    if (user) {
      var udir = localAppDataDir(user);
      if (fso.FolderExists(udir)) fso.DeleteFolder(udir, true);
    }
  } catch (e) {}
}
