using System.Runtime.InteropServices;
using System.Text.Json;
using static Jejak.Shell.Localization;

namespace Jejak.Shell;

public sealed record UpdatePlatform(Uri Url, string Signature);

/// <summary>Manifest pembaruan (<c>latest.json</c>, format statis Tauri v2).</summary>
public sealed record UpdateManifest(
    Semver Version, string? Notes, string? Date, IReadOnlyDictionary<string, UpdatePlatform> Platforms)
{
    /// <summary>
    /// Kunci platform cangkang native Windows. Sengaja berbeda dari kunci Tauri
    /// (<c>windows-x86_64</c>) supaya cangkang native tak memasang artefak Tauri dan sebaliknya.
    /// </summary>
    public static string NativePlatformKey() =>
        RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? "windows-aarch64-native" : "windows-x86_64-native";

    public static UpdateManifest Parse(byte[] data)
    {
        var bad = new ShellException(L("manifest.bad", "manifest pembaruan rusak"));
        try
        {
            using var doc = JsonDocument.Parse(data);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw bad;
            if (!root.TryGetProperty("version", out var v) || v.ValueKind != JsonValueKind.String) throw bad;
            var version = Semver.TryParse(v.GetString()) ?? throw bad;
            var platforms = new Dictionary<string, UpdatePlatform>();
            if (root.TryGetProperty("platforms", out var raw) && raw.ValueKind == JsonValueKind.Object)
            {
                foreach (var p in raw.EnumerateObject())
                {
                    if (p.Value.ValueKind != JsonValueKind.Object) continue;
                    if (!p.Value.TryGetProperty("url", out var u) || u.ValueKind != JsonValueKind.String) continue;
                    if (!p.Value.TryGetProperty("signature", out var s) || s.ValueKind != JsonValueKind.String) continue;
                    if (string.IsNullOrEmpty(s.GetString()) || !Uri.TryCreate(u.GetString(), UriKind.Absolute, out var url)) continue;
                    platforms[p.Name] = new UpdatePlatform(url, s.GetString()!);
                }
            }
            string? Str(string k) => root.TryGetProperty(k, out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
            return new UpdateManifest(version, Str("notes"), Str("pub_date"), platforms);
        }
        catch (JsonException) { throw bad; }
    }
}

/// <summary>Pengaturan pembaruan dan endpoint per kanal.</summary>
public sealed record UpdaterSettings(bool AutoCheck, string Channel)
{
    public const string Stable = "stable";
    public const string Beta = "beta";
    public const string EndpointStable = "https://github.com/jejak-dev/jejak/releases/latest/download/latest.json";
    public const string EndpointBeta = "https://github.com/jejak-dev/jejak/releases/download/beta/latest.json";

    /// <summary>Versi pra-rilis memakai kanal beta, rilis penuh kanal stabil.</summary>
    public static string DefaultChannel(string version) => version.Contains('-') ? Beta : Stable;
    public static bool IsValid(string? channel) => channel is Stable or Beta;
    public static string? Endpoint(string channel) => channel switch
    {
        Stable => EndpointStable,
        Beta => EndpointBeta,
        _ => null,
    };
}

/// <summary>Penyimpanan pengaturan pembaruan sebagai JSON kecil (tahan berkas rusak).</summary>
public sealed class UpdaterSettingsStore
{
    private readonly string _path;
    private readonly string _version;

    public UpdaterSettingsStore(string path, string version) { _path = path; _version = version; }

    public UpdaterSettings Load()
    {
        var fallback = new UpdaterSettings(true, UpdaterSettings.DefaultChannel(_version));
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(_path));
            var r = doc.RootElement;
            var auto = r.TryGetProperty("autoCheck", out var a) && a.ValueKind is JsonValueKind.True or JsonValueKind.False
                ? a.GetBoolean() : true;
            var ch = r.TryGetProperty("channel", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
            return new UpdaterSettings(auto, UpdaterSettings.IsValid(ch) ? ch! : fallback.Channel);
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException or InvalidOperationException)
        {
            return fallback;
        }
    }

    public void Save(UpdaterSettings s)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(new { autoCheck = s.AutoCheck, channel = s.Channel }));
        File.Move(tmp, _path, overwrite: true);
    }
}
