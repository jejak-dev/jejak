using System.IO;
using System.Net.Http;
using System.Reflection;
using Jejak.Shell;
using static Jejak.Shell.Localization;

namespace Jejak.Desktop;

/// <summary>
/// Menghubungkan pembaru inti dengan aplikasi: pengaturan tersimpan, jadwal otomatis, dan
/// mulai ulang. Aktif hanya bila kunci publik tertanam (atau override debug) dan versi sah.
/// </summary>
public sealed class UpdateController
{
    private static readonly TimeSpan InitialDelay = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan Interval = TimeSpan.FromHours(6);

    private readonly Updater? _updater;
    private readonly UpdaterSettingsStore _store;
    private readonly string _workDir;
    private readonly CancellationTokenSource _cts = new();
    private UpdaterSettings _settings;

    public UpdateController(string version)
    {
        var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Jejak");
        _workDir = Path.Combine(data, "update");
        _store = new UpdaterSettingsStore(Path.Combine(data, "updater.json"), version);
        _settings = _store.Load();

        // Override endpoint/kunci hanya untuk debug (sama seperti cangkang macOS dan build debug Tauri).
        var debug = Environment.GetEnvironmentVariable("JEJAK_DEBUG") == "1";
        var key = (debug ? Environment.GetEnvironmentVariable("JEJAK_UPDATE_PUBKEY") : null) ?? EmbeddedPubKey();
        var current = Semver.TryParse(version);
        if (string.IsNullOrEmpty(key) || current == null) return;
        var over = debug ? Environment.GetEnvironmentVariable("JEJAK_UPDATE_ENDPOINT") : null;
        if (string.IsNullOrEmpty(over)) over = null;
        _updater = new Updater(new UpdaterConfig
        {
            CurrentVersion = current,
            InstallDir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar),
            WorkDir = _workDir,
            PubKey = key,
            Endpoint = ch => over != null ? new Uri(over) : UpdaterSettings.Endpoint(ch) is { } e ? new Uri(e) : null,
            AllowInsecure = over != null,
            Http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) },
        });
    }

    private static string? EmbeddedPubKey() =>
        Assembly.GetEntryAssembly()?.GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "JejakUpdatePubKey")?.Value;

    public UpdaterSettings Settings => _settings;

    public void Apply(UpdaterSettings next)
    {
        if (!UpdaterSettings.IsValid(next.Channel))
            throw new ShellException(L("update.bad_channel", "kanal pembaruan tak dikenal"));
        var changed = next.Channel != _settings.Channel;
        _store.Save(next);
        _settings = next;
        if (changed) _updater?.DiscardPending();
    }

    public Dictionary<string, object> StatusJson => (_updater?.Status ?? new UpdateStatus()).ToJson();

    public async Task<Dictionary<string, object>> CheckAsync() =>
        _updater == null ? new UpdateStatus().ToJson() : (await _updater.CheckAsync(_settings.Channel, _cts.Token)).ToJson();

    public Dictionary<string, object> Install() =>
        (_updater ?? throw new ShellException(L("update.unavailable", "pembaruan otomatis tak tersedia pada build ini"))).Install().ToJson();

    /// <summary>Memulai helper penyalin lalu mengembalikan true; pemanggil harus segera menutup aplikasi.</summary>
    public bool PrepareRestart()
    {
        if (_updater is not { IsReady: true, StagedDir: { } staged })
            throw new ShellException(L("update.not_ready", "belum ada pembaruan siap dijalankan"));
        var exe = Environment.ProcessPath ?? throw new ShellException(L("update.unavailable", "pembaruan otomatis tak tersedia pada build ini"));
        RelaunchHelper.Start(staged, AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar), exe, _workDir);
        return true;
    }

    /// <summary>Sekali setelah mulai (15 dtk), lalu tiap enam jam; menghormati <c>AutoCheck</c>.</summary>
    public void StartAutoCheck()
    {
        if (_updater == null) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(InitialDelay, _cts.Token);
                while (!_cts.IsCancellationRequested)
                {
                    if (_settings.AutoCheck) await CheckAsync();
                    await Task.Delay(Interval, _cts.Token);
                }
            }
            catch (OperationCanceledException) { }
        });
    }

    public void Stop() => _cts.Cancel();
}
