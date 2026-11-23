using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Windows;
using Jejak.Shell;
using Microsoft.Web.WebView2.Core;
using static Jejak.Shell.Localization;

namespace Jejak.Desktop;

/// <summary>
/// Jembatan halaman → cangkang. Halaman memanggil
/// <c>window.__TAURI_INTERNALS__.invoke(cmd, args)</c> (kontrak lama Tauri);
/// di sini diterjemahkan ke perintah native tanpa mengubah klien web.
/// </summary>
public sealed class Bridge
{
    private const string Shim = """
    (function () {
      if (window.__TAURI_INTERNALS__) return;
      var pending = new Map();
      var next = 1;
      window.__jejakReply = function (id, ok, payload) {
        var e = pending.get(id);
        if (!e) return;
        pending.delete(id);
        if (ok) e.resolve(payload); else e.reject(typeof payload === 'string' ? payload : 'error');
      };
      window.__TAURI_INTERNALS__ = {
        invoke: function (cmd, args) {
          return new Promise(function (resolve, reject) {
            var id = next++;
            pending.set(id, { resolve: resolve, reject: reject });
            window.chrome.webview.postMessage({ id: id, cmd: cmd, args: args === undefined ? null : args });
          });
        }
      };
    })();
    """;

    private readonly Func<int> _port;
    private readonly Notifier _notifier;
    private readonly UpdateController _updates;
    private readonly Action _restart;
    private CoreWebView2? _web;

    /// <param name="restart">Dipanggil di thread UI setelah helper penyalin dimulai; menutup aplikasi.</param>
    public Bridge(Func<int> port, Notifier notifier, UpdateController updates, Action restart)
    {
        _port = port;
        _notifier = notifier;
        _updates = updates;
        _restart = restart;
    }

    public static string AppVersion =>
        Assembly.GetEntryAssembly()?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            .Split('+')[0] ?? "dev";

    public async Task InstallAsync(CoreWebView2 web)
    {
        _web = web;
        await web.AddScriptToExecuteOnDocumentCreatedAsync(Shim);
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("notification.js");
        if (stream != null)
        {
            using var reader = new StreamReader(stream);
            await web.AddScriptToExecuteOnDocumentCreatedAsync(await reader.ReadToEndAsync());
        }
        web.WebMessageReceived += OnMessage;
    }

    private async void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        int id;
        string cmd;
        JsonElement args = default;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            if (!root.TryGetProperty("id", out var idEl) || !idEl.TryGetInt32(out id)) return;
            // Hanya halaman Jejak sendiri (http://127.0.0.1:<port>) yang boleh memanggil.
            if (!NavigationPolicy.IsLocalAppUrl(e.Source, _port()))
            {
                await ReplyAsync(id, false, L("bridge.rejected", "pesan jembatan ditolak: asal tak dikenal"));
                return;
            }
            cmd = root.TryGetProperty("cmd", out var c) ? c.GetString() ?? "" : "";
            if (root.TryGetProperty("args", out var a)) args = a.Clone();
        }
        catch (JsonException) { return; }

        try { await ReplyAsync(id, true, await HandleAsync(cmd, args)); }
        catch (Exception ex) { await ReplyAsync(id, false, ex.Message); }
    }

    private async Task ReplyAsync(int id, bool ok, object? payload)
    {
        var json = JsonSerializer.Serialize(payload);
        try { await _web!.ExecuteScriptAsync($"window.__jejakReply({id}, {(ok ? "true" : "false")}, {json});"); }
        catch { /* halaman berpindah sebelum balasan tiba */ }
    }

    private async Task<object?> HandleAsync(string cmd, JsonElement args)
    {
        switch (cmd)
        {
            case "desktop_info":
                return new { version = AppVersion, platform = "windows" };
            case "updater_get_settings":
                return new { autoCheck = _updates.Settings.AutoCheck, channel = _updates.Settings.Channel };
            case "updater_set_settings":
            {
                var body = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("settings", out var s) ? s : args;
                if (body.ValueKind != JsonValueKind.Object
                    || !body.TryGetProperty("autoCheck", out var auto) || auto.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
                    || !body.TryGetProperty("channel", out var ch) || ch.ValueKind != JsonValueKind.String)
                    throw new ShellException(L("update.incomplete", "pengaturan pembaruan tak lengkap"));
                _updates.Apply(new UpdaterSettings(auto.GetBoolean(), ch.GetString()!));
                return new { autoCheck = _updates.Settings.AutoCheck, channel = _updates.Settings.Channel };
            }
            case "updater_status":
                return _updates.StatusJson;
            case "updater_check":
                return await _updates.CheckAsync();
            case "updater_install":
                return _updates.Install();
            case "updater_restart":
                _updates.PrepareRestart();
                _ = Application.Current.Dispatcher.BeginInvoke(_restart);
                return null;
            case "plugin:notification|is_permission_granted":
                return true;
            case "plugin:notification|request_permission":
                return "granted";
            case "plugin:notification|notify":
            {
                string title = "Jejak", body = "";
                if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("options", out var o) && o.ValueKind == JsonValueKind.Object)
                {
                    if (o.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String) title = t.GetString()!;
                    if (o.TryGetProperty("body", out var b) && b.ValueKind == JsonValueKind.String) body = b.GetString()!;
                }
                _notifier.Show(title, body);
                return null;
            }
            default:
                throw new ShellException(L("bridge.unknown_command", "perintah tak dikenal: %@", cmd));
        }
    }
}
