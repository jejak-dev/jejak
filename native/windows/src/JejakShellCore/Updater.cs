using System.IO.Compression;
using System.Diagnostics;
using static Jejak.Shell.Localization;

namespace Jejak.Shell;

public sealed class UpdaterConfig
{
    public required Semver CurrentVersion { get; init; }
    /// <summary>Folder aplikasi yang sedang berjalan (tempat Jejak.exe berada).</summary>
    public required string InstallDir { get; init; }
    /// <summary>Folder kerja pembaruan (unduhan dan hasil ekstrak).</summary>
    public required string WorkDir { get; init; }
    public required string PubKey { get; init; }
    public string PlatformKey { get; init; } = UpdateManifest.NativePlatformKey();
    /// <summary>Mengubah kanal menjadi URL manifest; null = kanal tak dikenal.</summary>
    public required Func<string, Uri?> Endpoint { get; init; }
    /// <summary>Izinkan skema non-https (hanya override debug dan tes).</summary>
    public bool AllowInsecure { get; init; }
    public HttpClient Http { get; init; } = new();
    /// <summary>Membaca versi dari Jejak.exe hasil ekstrak; bisa diganti pada tes.</summary>
    public Func<string, string?> ReadExeVersion { get; init; } = DefaultReadExeVersion;
    public string ExeName { get; init; } = "Jejak.exe";
    public string SidecarName { get; init; } = "jejak-server.exe";

    private static string? DefaultReadExeVersion(string exe) =>
        FileVersionInfo.GetVersionInfo(exe).ProductVersion?.Split('+')[0];
}

/// <summary>
/// Pembaru otomatis cangkang Windows: periksa manifest, unduh zip, verifikasi minisign,
/// ekstrak ke folder kerja, validasi. Penggantian berkas aplikasi terjadi saat mulai ulang
/// (Windows mengunci exe yang berjalan) lewat skrip bantu; lihat <see cref="RelaunchHelper"/>.
/// </summary>
public sealed class Updater
{
    private const long MaxDownload = 1L << 30; // 1 GiB, pagar kewarasan

    private readonly UpdaterConfig _c;
    private readonly object _lock = new();
    private readonly UpdateStatus _status = new();
    private (UpdateManifest m, UpdatePlatform p)? _pending;
    private bool _busy;

    public Updater(UpdaterConfig config) { _c = config; }

    /// <summary>Folder hasil ekstrak yang siap disalin; non-null hanya saat status ready.</summary>
    public string? StagedDir { get; private set; }

    public UpdateStatus Status { get { lock (_lock) return _status.Clone(); } }
    public bool IsReady => Status.State == UpdatePhase.Ready;

    private static ulong Now() => (ulong)DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    private void Mutate(Action<UpdateStatus> a) { lock (_lock) a(_status); }

    // ---- Periksa ----

    public async Task<UpdateStatus> CheckAsync(string channel, CancellationToken ct = default)
    {
        lock (_lock)
        {
            if (_busy || !_status.StartCheck(Now())) return _status.Clone();
            _busy = true;
        }
        try
        {
            var found = await FetchManifestAsync(channel, ct).ConfigureAwait(false);
            lock (_lock) _pending = found;
            Mutate(s => s.FinishCheck(Now(), found?.m.Version.ToString(), found?.m.Notes, found?.m.Date));
        }
        catch (Exception e)
        {
            Mutate(s => s.Fail(Now(), Message(e)));
        }
        finally { lock (_lock) _busy = false; }
        return Status;
    }

    private static string Message(Exception e) => e is ShellException or HttpRequestException or IOException or InvalidDataException
        ? e.Message : e.ToString();

    private void CheckScheme(Uri url)
    {
        if (!_c.AllowInsecure && url.Scheme != Uri.UriSchemeHttps)
            throw new ShellException(L("update.insecure", "alamat pembaruan harus https"));
    }

    private async Task<(UpdateManifest m, UpdatePlatform p)?> FetchManifestAsync(string channel, CancellationToken ct)
    {
        var url = _c.Endpoint(channel) ?? throw new ShellException(L("update.bad_channel", "kanal pembaruan tak dikenal"));
        CheckScheme(url);
        using var resp = await _c.Http.GetAsync(url, ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            if ((int)resp.StatusCode == 404 && channel == UpdaterSettings.Stable)
                throw new ShellException(L("update.no_stable", "Belum ada rilis stabil. Pilih kanal Beta di Pengaturan."));
            throw new ShellException(L("update.http", "server pembaruan menjawab %@", (int)resp.StatusCode));
        }
        var manifest = UpdateManifest.Parse(await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false));
        if (!(manifest.Version > _c.CurrentVersion) || !manifest.Platforms.TryGetValue(_c.PlatformKey, out var platform))
            return null; // terbaru, atau belum ada artefak native untuk platform ini
        return (manifest, platform);
    }

    /// <summary>Membuang pembaruan tertahan (mis. saat kanal berganti).</summary>
    public void DiscardPending()
    {
        lock (_lock) { _pending = null; _status.DropPending(); }
    }

    // ---- Pasang ----

    /// <summary>Memulai unduh+siapkan di latar belakang; pantau lewat <see cref="Status"/>.</summary>
    public UpdateStatus Install()
    {
        (UpdateManifest m, UpdatePlatform p) held;
        UpdateStatus snapshot;
        lock (_lock)
        {
            if (_busy) throw new ShellException(L("update.busy", "pemasangan pembaruan sedang berjalan"));
            if (_pending is not { } h || !_status.StartDownload())
                throw new ShellException(L("update.none", "belum ada pembaruan untuk dipasang"));
            held = h;
            _pending = null;
            _busy = true;
            snapshot = _status.Clone();
        }
        _ = Task.Run(async () =>
        {
            try
            {
                var staged = await StageAsync(held.m, held.p).ConfigureAwait(false);
                lock (_lock) StagedDir = staged;
                Mutate(s => s.FinishInstall());
            }
            catch (Exception e)
            {
                Mutate(s => s.Fail(Now(), Message(e)));
            }
            finally { lock (_lock) _busy = false; }
        });
        return snapshot;
    }

    private async Task<string> StageAsync(UpdateManifest manifest, UpdatePlatform platform)
    {
        CheckScheme(platform.Url);
        EnsureWritable(_c.InstallDir);
        CleanWorkDir();
        var work = Path.Combine(_c.WorkDir, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        try
        {
            var zip = Path.Combine(work, "update.zip");
            await DownloadAsync(platform.Url, zip).ConfigureAwait(false);
            Mutate(s => s.FinishDownload());

            // Verifikasi SEBELUM menyentuh isi arsip.
            new MinisignPublicKey(_c.PubKey).VerifyFile(zip, platform.Signature);

            var extracted = Path.Combine(work, "x");
            ExtractSafely(zip, extracted);
            var root = FindAppRoot(extracted);
            Validate(root, manifest.Version);
            File.Delete(zip);
            return root;
        }
        catch
        {
            TryDelete(work);
            throw;
        }
    }

    private void CleanWorkDir()
    {
        if (!Directory.Exists(_c.WorkDir)) return;
        foreach (var d in Directory.GetDirectories(_c.WorkDir)) TryDelete(d);
    }

    private static void TryDelete(string dir)
    {
        try { Directory.Delete(dir, true); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>Gagal lebih awal bila folder aplikasi tak bisa ditulis (mis. Program Files).</summary>
    public static void EnsureWritable(string dir)
    {
        var probe = Path.Combine(dir, $".jejak-write-test-{Guid.NewGuid():N}");
        try
        {
            File.WriteAllBytes(probe, Array.Empty<byte>());
            File.Delete(probe);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new ShellException(L("update.not_writable", "folder aplikasi tak bisa ditulis: %@", dir));
        }
    }

    private async Task DownloadAsync(Uri url, string dest)
    {
        using var resp = await _c.Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
            throw new ShellException(L("update.http", "server pembaruan menjawab %@", (int)resp.StatusCode));
        var total = resp.Content.Headers.ContentLength;
        if (total > MaxDownload) throw new ShellException(L("update.too_large", "unduhan pembaruan terlalu besar"));
        await using var src = await resp.Content.ReadAsStreamAsync().ConfigureAwait(false);
        await using var dst = File.Create(dest);
        var buf = new byte[81920];
        long got = 0;
        int n;
        while ((n = await src.ReadAsync(buf).ConfigureAwait(false)) > 0)
        {
            await dst.WriteAsync(buf.AsMemory(0, n)).ConfigureAwait(false);
            got += n;
            if (got > MaxDownload) throw new ShellException(L("update.too_large", "unduhan pembaruan terlalu besar"));
            var g = (ulong)got;
            Mutate(s => s.Progress(g, total is > 0 ? (ulong)total : null));
        }
    }

    /// <summary>Ekstrak zip dengan penjagaan zip-slip dan batas ukuran.</summary>
    public static void ExtractSafely(string zipPath, string dest)
    {
        Directory.CreateDirectory(dest);
        var full = Path.GetFullPath(dest);
        var prefix = full.EndsWith(Path.DirectorySeparatorChar) ? full : full + Path.DirectorySeparatorChar;
        using var zip = ZipFile.OpenRead(zipPath);
        long sum = 0;
        foreach (var e in zip.Entries)
        {
            var target = Path.GetFullPath(Path.Combine(full, e.FullName));
            if (!target.StartsWith(prefix, StringComparison.Ordinal))
                throw new ShellException(L("update.bad_archive", "arsip pembaruan tak sah"));
            if (e.FullName.EndsWith('/') || e.FullName.EndsWith('\\')) { Directory.CreateDirectory(target); continue; }
            sum += e.Length;
            if (sum > 2 * MaxDownload) throw new ShellException(L("update.too_large", "unduhan pembaruan terlalu besar"));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            e.ExtractToFile(target, true);
        }
    }

    /// <summary>Akar aplikasi: folder hasil ekstrak sendiri, atau satu-satunya subfolder (mis. <c>Jejak/</c>).</summary>
    private string FindAppRoot(string extracted)
    {
        if (File.Exists(Path.Combine(extracted, _c.ExeName))) return extracted;
        var subs = Directory.GetDirectories(extracted);
        if (subs.Length == 1 && File.Exists(Path.Combine(subs[0], _c.ExeName))) return subs[0];
        throw new ShellException(L("update.wrong_app", "arsip pembaruan bukan aplikasi Jejak native"));
    }

    private void Validate(string root, Semver expected)
    {
        if (!File.Exists(Path.Combine(root, _c.SidecarName)))
            throw new ShellException(L("update.bad_app", "aplikasi pembaruan tak sah"));
        var v = Semver.TryParse(_c.ReadExeVersion(Path.Combine(root, _c.ExeName)));
        if (v == null || !v.Equals(expected))
            throw new ShellException(L("update.version_mismatch", "versi aplikasi di arsip tak sesuai manifest"));
    }
}

/// <summary>
/// Penggantian berkas setelah proses keluar. Windows mengunci Jejak.exe yang berjalan, jadi
/// skrip PowerShell tetap menunggu proses ini berhenti, menyalin hasil ekstrak ke folder aplikasi
/// (dengan percobaan ulang), membersihkan folder kerja, lalu menjalankan Jejak lagi.
/// Jalur dikirim sebagai argumen (bukan disisipkan ke teks skrip) agar aman dari injeksi.
/// </summary>
public static class RelaunchHelper
{
    public const string Script = """
        param([int]$ProcId, [string]$Source, [string]$Target, [string]$Exe, [string]$Cleanup)
        $ErrorActionPreference = 'Continue'
        try { Wait-Process -Id $ProcId -Timeout 90 -ErrorAction SilentlyContinue } catch { }
        for ($i = 0; $i -lt 30; $i++) {
          robocopy $Source $Target /E /IS /IT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
          if ($LASTEXITCODE -lt 8) { break }
          Start-Sleep -Milliseconds 500
        }
        if ($Cleanup) { Remove-Item -Recurse -Force -LiteralPath $Cleanup -ErrorAction SilentlyContinue }
        Start-Process -FilePath $Exe
        """;

    public static ProcessStartInfo BuildStartInfo(string scriptPath, int pid, string source, string target, string exe, string cleanup)
    {
        var psi = new ProcessStartInfo("powershell.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        foreach (var a in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
                     "-ProcId", pid.ToString(), "-Source", source, "-Target", target, "-Exe", exe, "-Cleanup", cleanup })
            psi.ArgumentList.Add(a);
        return psi;
    }

    /// <summary>Menulis skrip ke folder kerja lalu memulai helper; pemanggil harus segera keluar.</summary>
    public static void Start(string stagedDir, string installDir, string exePath, string workDir)
    {
        Directory.CreateDirectory(workDir);
        var script = Path.Combine(workDir, "apply-update.ps1");
        File.WriteAllText(script, Script);
        // Folder kerja induk dari staged (…/<guid>/x/Jejak atau …/<guid>/x) dibersihkan setelah salin.
        var cleanup = FindStageRoot(stagedDir, workDir);
        Process.Start(BuildStartInfo(script, Environment.ProcessId, stagedDir, installDir, exePath, cleanup));
    }

    /// <summary>Subfolder GUID langsung di bawah <paramref name="workDir"/> yang memuat <paramref name="staged"/>.</summary>
    public static string FindStageRoot(string staged, string workDir)
    {
        var work = Path.GetFullPath(workDir).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var cur = new DirectoryInfo(Path.GetFullPath(staged));
        while (cur?.Parent != null)
        {
            if (cur.Parent.FullName.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar == work) return cur.FullName;
            cur = cur.Parent;
        }
        return "";
    }
}
