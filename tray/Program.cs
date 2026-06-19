// Raid Team Stats — system-tray helper (Phase 4).
//
// A NotifyIcon that drives the companion (rts-companion.exe, a Node SEA running
// `--watch`) through its loopback HTTP control server. The companion writes
//   %LOCALAPPDATA%\RaidTeamStats\control.json = { port, pid, secret, version }
// and serves http://127.0.0.1:<port>. EVERY request must carry the header
//   x-rts-control: <secret>
// Endpoints used here:
//   GET  /status  -> { ok, version, autoUpdateAddon, lastSyncAt, lastResult }
//   POST /sync    -> run an upload now
//   POST /config  (body { autoUpdateAddon: bool })
//   POST /quit    -> ask the companion to exit
//
// Design rules (load-bearing):
//   * NEVER crash on a failed call. If the companion is down (control.json
//     missing, or its pid is not a live process, or HTTP fails), the menu
//     reflects "Companion not running" and offers to Start it.
//   * Single instance (a named mutex) so only one tray runs.
//   * All HTTP via one HttpClient to 127.0.0.1 with the x-rts-control header
//     and short timeouts.

using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RtsTray;

internal static class Program
{
    // One tray instance per user session.
    private const string MutexName = "RaidTeamStats.Tray.SingleInstance";

    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(initiallyOwned: true, MutexName, out bool isNew);
        if (!isNew)
        {
            // Another tray is already running — quietly exit.
            return;
        }

        ApplicationConfiguration.Initialize();
        using var app = new TrayApp();
        Application.Run();
        GC.KeepAlive(mutex);
    }
}

/// <summary>Shape of %LOCALAPPDATA%\RaidTeamStats\control.json.</summary>
internal sealed class ControlFile
{
    [JsonPropertyName("port")] public int Port { get; set; }
    [JsonPropertyName("pid")] public int Pid { get; set; }
    [JsonPropertyName("secret")] public string? Secret { get; set; }
    [JsonPropertyName("version")] public string? Version { get; set; }
}

/// <summary>Shape of GET /status.</summary>
internal sealed class StatusResponse
{
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("version")] public string? Version { get; set; }
    [JsonPropertyName("autoUpdateAddon")] public bool AutoUpdateAddon { get; set; }
    [JsonPropertyName("lastSyncAt")] public string? LastSyncAt { get; set; }
    [JsonPropertyName("lastResult")] public string? LastResult { get; set; }
}

/// <summary>Shape of config.json (same dir) — only `api` is needed here.</summary>
internal sealed class CompanionConfig
{
    [JsonPropertyName("api")] public string? Api { get; set; }
}

/// <summary>Subset of the website manifest GET {api}/uploader/manifest.</summary>
internal sealed class Manifest
{
    [JsonPropertyName("companion")] public ManifestCompanion? Companion { get; set; }
    [JsonPropertyName("installerUrl")] public string? InstallerUrl { get; set; }
}

internal sealed class ManifestCompanion
{
    [JsonPropertyName("latest")] public string? Latest { get; set; }
}

internal sealed class TrayApp : IDisposable
{
    private static readonly string ConfigDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "RaidTeamStats");

    private static readonly string ControlPath = Path.Combine(ConfigDir, "control.json");
    private static readonly string ConfigPath = Path.Combine(ConfigDir, "config.json");
    private static readonly string LogPath = Path.Combine(ConfigDir, "uploader.log");

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    // Short timeout: a hung companion must never freeze the UI.
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(4) };

    private readonly NotifyIcon _icon;
    private readonly ContextMenuStrip _menu;
    private readonly System.Windows.Forms.Timer _poll;

    private readonly ToolStripMenuItem _miSync;
    private readonly ToolStripMenuItem _miAutoUpdate;
    private readonly ToolStripMenuItem _miUpdateAvailable;
    private readonly ToolStripSeparator _sep1;
    private readonly ToolStripMenuItem _miStart;
    private readonly ToolStripMenuItem _miOpenLog;
    private readonly ToolStripMenuItem _miQuit;

    // Latest observed state (drives menu rendering). Null status == not running.
    private StatusResponse? _status;
    private string? _runningVersion; // from status.version or control.json.version
    private string? _latestVersion;  // manifest.companion.latest, if newer
    private string? _installerUrl;   // manifest.installerUrl, for the update click

    // Throttle the manifest check (it hits the website) to ~once/hour.
    private DateTime _lastManifestCheckUtc = DateTime.MinValue;

    public TrayApp()
    {
        _menu = new ContextMenuStrip();

        _miSync = new ToolStripMenuItem("Sync now", null, async (_, _) => await OnSyncAsync());
        _miAutoUpdate = new ToolStripMenuItem("Auto-update addon", null, async (_, _) => await OnToggleAutoUpdateAsync())
        {
            CheckOnClick = false, // we set Checked ourselves from status
        };
        _miUpdateAvailable = new ToolStripMenuItem("Update available", null, (_, _) => OnUpdateAvailable())
        {
            Visible = false,
        };
        _sep1 = new ToolStripSeparator();
        _miStart = new ToolStripMenuItem("Start", null, (_, _) => OnStartCompanion())
        {
            Visible = false,
        };
        _miOpenLog = new ToolStripMenuItem("Open log", null, (_, _) => OnOpenLog());
        _miQuit = new ToolStripMenuItem("Quit", null, async (_, _) => await OnQuitAsync());

        _menu.Items.AddRange(new ToolStripItem[]
        {
            _miSync,
            _miAutoUpdate,
            _miUpdateAvailable,
            _miStart,
            _sep1,
            _miOpenLog,
            _miQuit,
        });

        _icon = new NotifyIcon
        {
            Icon = LoadAppIcon(),
            Text = "Raid Team Stats",
            Visible = true,
            ContextMenuStrip = _menu,
        };
        // Left double-click = quick sync.
        _icon.MouseDoubleClick += async (_, e) =>
        {
            if (e.Button == MouseButtons.Left) await OnSyncAsync();
        };

        // Poll status every ~30s on the UI thread (System.Windows.Forms.Timer).
        _poll = new System.Windows.Forms.Timer { Interval = 30_000 };
        _poll.Tick += async (_, _) => await RefreshAsync();
        _poll.Start();

        // Refresh once immediately (fire-and-forget; RefreshAsync never throws).
        _ = RefreshAsync();
    }

    // ── icon ────────────────────────────────────────────────────────────────

    private static Icon LoadAppIcon()
    {
        // The .ico is embedded as a managed resource (see csproj). Fall back to
        // the system application icon if anything goes wrong.
        try
        {
            var asm = Assembly.GetExecutingAssembly();
            using var s = asm.GetManifestResourceStream("app.ico");
            if (s != null) return new Icon(s);
        }
        catch
        {
            // fall through
        }
        return SystemIcons.Application;
    }

    // ── status polling ────────────────────────────────────────────────────────

    /// <summary>
    /// Re-read control.json, probe the companion, and re-render the menu. NEVER
    /// throws — a companion that's down just renders as "not running".
    /// </summary>
    private async Task RefreshAsync()
    {
        ControlFile? control = ReadControl();
        bool running = control != null && IsProcessAlive(control.Pid);

        StatusResponse? status = null;
        if (running && control!.Port > 0 && !string.IsNullOrEmpty(control.Secret))
        {
            status = await TryGetStatusAsync(control.Port, control.Secret!);
            // A live pid whose control server doesn't answer = treat as down for
            // the action menu, but we still know it's "starting/unhealthy".
            if (status == null) running = false;
        }

        _status = status;
        _runningVersion = status?.Version ?? control?.Version;

        // Opportunistically refresh the update check (throttled, best-effort).
        await MaybeCheckForUpdateAsync();

        RenderMenu(running);
    }

    private async Task<StatusResponse?> TryGetStatusAsync(int port, string secret)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{port}/status");
            req.Headers.TryAddWithoutValidation("x-rts-control", secret);
            using var res = await _http.SendAsync(req);
            if (!res.IsSuccessStatusCode) return null;
            var body = await res.Content.ReadAsStringAsync();
            return JsonSerializer.Deserialize<StatusResponse>(body, JsonOpts);
        }
        catch
        {
            // Companion down / refused / timed out — not running.
            return null;
        }
    }

    private void RenderMenu(bool running)
    {
        if (running && _status != null)
        {
            string ver = _runningVersion ?? "?";
            string last = !string.IsNullOrEmpty(_status.LastResult)
                ? _status.LastResult!
                : "no sync yet";
            _icon.Text = Trunc($"Raid Team Stats — v{ver}\n{last}");

            _miSync.Enabled = true;
            _miSync.Text = "Sync now";

            _miAutoUpdate.Visible = true;
            _miAutoUpdate.Enabled = true;
            _miAutoUpdate.Checked = _status.AutoUpdateAddon;

            _miStart.Visible = false;
        }
        else
        {
            _icon.Text = "Raid Team Stats — companion not running";

            _miSync.Enabled = false;
            _miSync.Text = "Sync now (companion not running)";

            _miAutoUpdate.Visible = false;
            _miAutoUpdate.Checked = false;

            _miStart.Visible = true;
        }

        // "Update available" is independent of running state: show whenever we
        // know a newer published version exists.
        if (!string.IsNullOrEmpty(_latestVersion))
        {
            _miUpdateAvailable.Visible = true;
            _miUpdateAvailable.Text = $"Update available: v{_latestVersion}";
        }
        else
        {
            _miUpdateAvailable.Visible = false;
        }
    }

    // ── menu actions ──────────────────────────────────────────────────────────

    private async Task OnSyncAsync()
    {
        ControlFile? control = ReadControl();
        if (control == null || !IsProcessAlive(control.Pid) ||
            control.Port <= 0 || string.IsNullOrEmpty(control.Secret))
        {
            ShowBalloon("Sync", "Companion not running.", ToolTipIcon.Warning);
            await RefreshAsync();
            return;
        }

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{control.Port}/sync");
            req.Headers.TryAddWithoutValidation("x-rts-control", control.Secret!);
            req.Content = new StringContent("", Encoding.UTF8, "application/json");
            using var res = await _http.SendAsync(req);
            var body = await res.Content.ReadAsStringAsync();

            if (res.IsSuccessStatusCode)
            {
                string msg = ExtractResultMessage(body) ?? "Sync requested.";
                ShowBalloon("Sync", msg, ToolTipIcon.Info);
            }
            else
            {
                ShowBalloon("Sync failed", $"Companion returned HTTP {(int)res.StatusCode}.", ToolTipIcon.Error);
            }
        }
        catch
        {
            ShowBalloon("Sync failed", "Could not reach the companion.", ToolTipIcon.Error);
        }

        await RefreshAsync();
    }

    private async Task OnToggleAutoUpdateAsync()
    {
        ControlFile? control = ReadControl();
        if (control == null || !IsProcessAlive(control.Pid) ||
            control.Port <= 0 || string.IsNullOrEmpty(control.Secret))
        {
            ShowBalloon("Auto-update addon", "Companion not running.", ToolTipIcon.Warning);
            await RefreshAsync();
            return;
        }

        bool current = _status?.AutoUpdateAddon ?? false;
        bool next = !current;

        try
        {
            string payload = JsonSerializer.Serialize(new { autoUpdateAddon = next });
            using var req = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{control.Port}/config");
            req.Headers.TryAddWithoutValidation("x-rts-control", control.Secret!);
            req.Content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var res = await _http.SendAsync(req);
            if (!res.IsSuccessStatusCode)
            {
                ShowBalloon("Auto-update addon",
                    $"Could not update setting (HTTP {(int)res.StatusCode}).", ToolTipIcon.Error);
            }
        }
        catch
        {
            ShowBalloon("Auto-update addon", "Could not reach the companion.", ToolTipIcon.Error);
        }

        await RefreshAsync();
    }

    private void OnUpdateAvailable()
    {
        // Open the installer URL in the default browser.
        string? url = _installerUrl;
        if (string.IsNullOrEmpty(url)) return;
        OpenInBrowser(url);
    }

    private void OnOpenLog()
    {
        try
        {
            if (File.Exists(LogPath))
            {
                Process.Start(new ProcessStartInfo(LogPath) { UseShellExecute = true });
            }
            else
            {
                ShowBalloon("Open log", "No log file yet.", ToolTipIcon.Info);
            }
        }
        catch
        {
            ShowBalloon("Open log", "Could not open the log.", ToolTipIcon.Error);
        }
    }

    private void OnStartCompanion()
    {
        // Launch the sibling rts-companion.exe --watch from the tray's own folder.
        string exe = Path.Combine(AppContext.BaseDirectory, "rts-companion.exe");
        if (!File.Exists(exe))
        {
            ShowBalloon("Start", "rts-companion.exe not found next to the tray app.", ToolTipIcon.Error);
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo(exe)
            {
                Arguments = "--watch",
                UseShellExecute = false,
                WorkingDirectory = AppContext.BaseDirectory,
            });
            ShowBalloon("Raid Team Stats", "Starting companion…", ToolTipIcon.Info);
            // The companion writes control.json on startup; refresh shortly after.
            ScheduleDelayedRefresh(2500);
        }
        catch
        {
            ShowBalloon("Start", "Could not start the companion.", ToolTipIcon.Error);
        }
    }

    private async Task OnQuitAsync()
    {
        // Ask the companion to quit (best-effort), then exit the tray.
        ControlFile? control = ReadControl();
        if (control != null && IsProcessAlive(control.Pid) &&
            control.Port > 0 && !string.IsNullOrEmpty(control.Secret))
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{control.Port}/quit");
                req.Headers.TryAddWithoutValidation("x-rts-control", control.Secret!);
                req.Content = new StringContent("", Encoding.UTF8, "application/json");
                using var res = await _http.SendAsync(req);
                _ = res; // ignore body/status — we exit regardless
            }
            catch
            {
                // Companion already gone or unreachable — exit anyway.
            }
        }

        _icon.Visible = false;
        Application.Exit();
    }

    // ── update check ──────────────────────────────────────────────────────────

    /// <summary>
    /// Fetch the website manifest (throttled) and decide whether the running
    /// companion is outdated. Sets _latestVersion / _installerUrl when newer;
    /// clears _latestVersion when current. Best-effort: never throws.
    /// </summary>
    private async Task MaybeCheckForUpdateAsync()
    {
        if ((DateTime.UtcNow - _lastManifestCheckUtc) < TimeSpan.FromHours(1) &&
            _lastManifestCheckUtc != DateTime.MinValue)
        {
            return;
        }

        string? api = ReadApiFromConfig();
        if (string.IsNullOrEmpty(api)) return;

        // Only meaningful if we know what version is running.
        string? running = _runningVersion;
        if (string.IsNullOrEmpty(running)) return;

        _lastManifestCheckUtc = DateTime.UtcNow;

        try
        {
            string url = api!.TrimEnd('/') + "/uploader/manifest";
            using var res = await _http.GetAsync(url);
            if (!res.IsSuccessStatusCode) return;
            var body = await res.Content.ReadAsStringAsync();
            var manifest = JsonSerializer.Deserialize<Manifest>(body, JsonOpts);
            string? latest = manifest?.Companion?.Latest;
            if (string.IsNullOrEmpty(latest)) return;

            if (CompareVersions(running!, latest!) < 0)
            {
                _latestVersion = latest;
                _installerUrl = manifest!.InstallerUrl;
            }
            else
            {
                _latestVersion = null;
                _installerUrl = null;
            }
        }
        catch
        {
            // Network/site down — leave the last known state untouched.
        }
    }

    /// <summary>
    /// Numeric dotted-version compare. "1.0.22" > "1.0.9" (22 > 9); shorter is
    /// zero-padded so "1.2.2" == "1.2.2.0". Returns -1 / 0 / 1.
    /// Mirrors src/lib/companion-release.ts compareVersions.
    /// </summary>
    internal static int CompareVersions(string a, string b)
    {
        string[] av = a.Split('.');
        string[] bv = b.Split('.');
        int len = Math.Max(av.Length, bv.Length);
        for (int i = 0; i < len; i++)
        {
            int an = i < av.Length ? ParseSeg(av[i]) : 0;
            int bn = i < bv.Length ? ParseSeg(bv[i]) : 0;
            if (an < bn) return -1;
            if (an > bn) return 1;
        }
        return 0;
    }

    private static int ParseSeg(string s) =>
        int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out int n) ? n : 0;

    // ── helpers ───────────────────────────────────────────────────────────────

    private static ControlFile? ReadControl()
    {
        try
        {
            if (!File.Exists(ControlPath)) return null;
            string json = File.ReadAllText(ControlPath);
            return JsonSerializer.Deserialize<ControlFile>(json, JsonOpts);
        }
        catch
        {
            return null;
        }
    }

    private static string? ReadApiFromConfig()
    {
        try
        {
            if (!File.Exists(ConfigPath)) return null;
            string json = File.ReadAllText(ConfigPath);
            var cfg = JsonSerializer.Deserialize<CompanionConfig>(json, JsonOpts);
            return cfg?.Api;
        }
        catch
        {
            return null;
        }
    }

    private static bool IsProcessAlive(int pid)
    {
        if (pid <= 0) return false;
        try
        {
            using var p = Process.GetProcessById(pid);
            return !p.HasExited;
        }
        catch
        {
            // ArgumentException => no such process.
            return false;
        }
    }

    /// <summary>Pull a friendly "uploaded/skipped/..." line out of a /sync or
    /// /status JSON body; falls back to null.</summary>
    private static string? ExtractResultMessage(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            foreach (var key in new[] { "lastResult", "result", "message" })
            {
                if (root.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String)
                {
                    var s = v.GetString();
                    if (!string.IsNullOrWhiteSpace(s)) return s;
                }
            }
            if (root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True)
            {
                return "Sync complete.";
            }
        }
        catch
        {
            // not JSON / unexpected shape
        }
        return null;
    }

    private static void OpenInBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
            // best-effort
        }
    }

    private void ShowBalloon(string title, string text, ToolTipIcon icon)
    {
        try
        {
            _icon.BalloonTipTitle = title;
            _icon.BalloonTipText = text;
            _icon.BalloonTipIcon = icon;
            _icon.ShowBalloonTip(5000);
        }
        catch
        {
            // best-effort UI
        }
    }

    private void ScheduleDelayedRefresh(int ms)
    {
        var t = new System.Windows.Forms.Timer { Interval = ms };
        t.Tick += async (_, _) =>
        {
            t.Stop();
            t.Dispose();
            await RefreshAsync();
        };
        t.Start();
    }

    // NotifyIcon tooltip is capped at 63 chars; keep it safe.
    private static string Trunc(string s) => s.Length <= 63 ? s : s[..63];

    public void Dispose()
    {
        try { _poll.Dispose(); } catch { /* ignore */ }
        try { _icon.Dispose(); } catch { /* ignore */ }
        try { _menu.Dispose(); } catch { /* ignore */ }
        try { _http.Dispose(); } catch { /* ignore */ }
    }
}
