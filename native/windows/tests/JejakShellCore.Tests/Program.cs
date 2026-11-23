using System.Diagnostics;
using Jejak.Shell;

// Harness uji mini: tiap tes dijalankan, kegagalan dicatat, exit code != 0 bila ada.
var failures = 0;
var total = 0;

void Test(string name, Action body)
{
    total++;
    try { body(); Console.WriteLine($"ok   {name}"); }
    catch (Exception e) { failures++; Console.WriteLine($"GAGAL {name}: {e.Message}"); }
}
async Task TestAsync(string name, Func<Task> body)
{
    total++;
    try { await body(); Console.WriteLine($"ok   {name}"); }
    catch (Exception e) { failures++; Console.WriteLine($"GAGAL {name}: {e.Message}"); }
}
void Expect(bool cond, string what = "kondisi salah") { if (!cond) throw new Exception(what); }
void ExpectThrows(Action a) { try { a(); } catch (ShellException) { return; } throw new Exception("tidak melempar"); }

// ReadyLine
Test("ready: baris sah", () =>
{
    var i = ReadyLine.Parse("JEJAK_READY {\"port\":51234,\"host\":\"127.0.0.1\",\"version\":\"0.0.1\"}");
    Expect(i == new ReadyInfo(51234, "127.0.0.1", "0.0.1"));
});
Test("ready: baris biasa diabaikan", () =>
{
    Expect(ReadyLine.Parse("server mendengarkan") == null);
    Expect(ReadyLine.Parse("JEJAK_READYX {\"port\":1}") == null);
});
Test("ready: tanpa payload galat", () =>
{
    ExpectThrows(() => ReadyLine.Parse("JEJAK_READY"));
    ExpectThrows(() => ReadyLine.Parse("JEJAK_READY   "));
});
Test("ready: json rusak / tanpa port / di luar rentang", () =>
{
    ExpectThrows(() => ReadyLine.Parse("JEJAK_READY {rusak"));
    ExpectThrows(() => ReadyLine.Parse("JEJAK_READY {\"host\":\"x\"}"));
    ExpectThrows(() => ReadyLine.Parse("JEJAK_READY {\"port\":0}"));
    ExpectThrows(() => ReadyLine.Parse("JEJAK_READY {\"port\":70000}"));
    ExpectThrows(() => ReadyLine.Parse("JEJAK_READY {\"port\":true}"));
});
Test("ready: bawaan host dan versi", () =>
{
    var i = ReadyLine.Parse("JEJAK_READY {\"port\":8}")!;
    Expect(i.Host == "127.0.0.1" && i.Version == "");
});

// Token
Test("token: dibuat sah 43 karakter dan unik", () =>
{
    var t = DesktopToken.Generate();
    Expect(DesktopToken.IsValid(t) && t.Length == 43);
    Expect(DesktopToken.Generate() != t);
});
Test("token: tak sah", () =>
{
    Expect(!DesktopToken.IsValid("pendek"));
    Expect(!DesktopToken.IsValid(new string('a', 31)));
    Expect(!DesktopToken.IsValid(new string('a', 31) + "+"));
    Expect(DesktopToken.IsValid(new string('a', 32)));
});

// Navigasi
Test("navigasi: enterUrl dan daftar putih", () =>
{
    Expect(NavigationPolicy.EnterUrl(5, "abc") == "http://127.0.0.1:5/__desktop/enter?t=abc");
    Expect(NavigationPolicy.IsAllowedNavigation("http://127.0.0.1:5000/x", 5000));
    Expect(NavigationPolicy.IsAllowedNavigation("about:blank", 5000));
    Expect(!NavigationPolicy.IsAllowedNavigation("http://127.0.0.1:5001/", 5000));
    Expect(!NavigationPolicy.IsAllowedNavigation("http://localhost:5000/", 5000));
    Expect(!NavigationPolicy.IsAllowedNavigation("https://127.0.0.1:5000/", 5000));
    Expect(!NavigationPolicy.IsAllowedNavigation("https://example.com", 5000));
    Expect(!NavigationPolicy.IsAllowedNavigation("file:///etc/passwd", 5000));
    Expect(!NavigationPolicy.IsAllowedNavigation("http://127.0.0.1:5000/", 0));
});
Test("navigasi: tujuan eksternal", () =>
{
    Expect(NavigationPolicy.ExternalOpenTarget("https://example.com/a", 5000) == "https://example.com/a");
    Expect(NavigationPolicy.ExternalOpenTarget("http://127.0.0.1:5000/a", 5000) == null);
    Expect(NavigationPolicy.ExternalOpenTarget("javascript:alert(1)", 5000) == null);
    Expect(NavigationPolicy.ExternalOpenTarget("file:///c:/x", 5000) == null);
    Expect(NavigationPolicy.ExternalOpenTarget("data:text/html,x", 5000) == null);
});

// Ring buffer
Test("ringbuffer: kapasitas dan ringkasan", () =>
{
    var b = new LineRingBuffer(3);
    for (var i = 1; i <= 5; i++) b.Append($"b{i}");
    Expect(string.Join(",", b.Snapshot()) == "b3,b4,b5");
    Expect(b.Summary(2) == "b4\nb5");
});

// Lokalisasi
Test("lokalisasi: id bawaan, en terjemahan, argumen", () =>
{
    Localization.OverrideLanguage = "id";
    Expect(Localization.L("button.retry", "Coba lagi") == "Coba lagi");
    Localization.OverrideLanguage = "en";
    Expect(Localization.L("button.retry", "Coba lagi") == "Try again");
    Expect(Localization.L("ready.port_range", "x %@", 7) == "JEJAK_READY port out of range: 7");
    Expect(Localization.L("kunci.tak.ada", "teks %@ dan %@", "a", "b") == "teks a dan b");
    Localization.OverrideLanguage = null;
});

// Locator
Test("locator: env menang, env hilang galat, tak ditemukan galat", () =>
{
    var dir = Directory.CreateTempSubdirectory().FullName;
    try
    {
        var f = Path.Combine(dir, "custom");
        File.WriteAllText(f, "x");
        Expect(BinaryLocator.Locate(dir, k => k == "JEJAK_SIDECAR" ? f : null) == f);
        ExpectThrows(() => BinaryLocator.Locate(dir, k => k == "JEJAK_SIDECAR" ? Path.Combine(dir, "nope") : null));
        ExpectThrows(() => BinaryLocator.Locate(dir, _ => null));
        var exe = OperatingSystem.IsWindows() ? "jejak-server.exe" : "jejak-server";
        File.WriteAllText(Path.Combine(dir, exe), "x");
        Expect(BinaryLocator.Locate(dir, _ => null) == Path.Combine(dir, exe));
    }
    finally { Directory.Delete(dir, true); }
});

// Sidecar (skrip POSIX palsu; dilewati di Windows)
string FakeSidecar(string body)
{
    var dir = Directory.CreateTempSubdirectory().FullName;
    var path = Path.Combine(dir, "jejak");
    File.WriteAllText(path, "#!/bin/sh\n" + body + "\n");
    File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    return path;
}

if (!OperatingSystem.IsWindows())
{
    await TestAsync("sidecar: siap lalu berhenti saat stdin ditutup", async () =>
    {
        var bin = FakeSidecar("""
            echo "JEJAK_READY {\"port\":4321,\"host\":\"127.0.0.1\",\"version\":\"9\"}"
            [ -n "$JEJAK_DESKTOP_TOKEN" ] || exit 7
            [ "$PORT" = "0" ] || exit 8
            cat > /dev/null
            """);
        using var s = new SidecarProcess();
        s.Start(bin, DesktopToken.Generate());
        var info = await s.WaitReadyAsync(TimeSpan.FromSeconds(10));
        Expect(info.Port == 4321 && info.Version == "9");
        var sw = Stopwatch.StartNew();
        s.Stop();
        Expect(sw.Elapsed < TimeSpan.FromSeconds(2.5), $"stop lambat: {sw.Elapsed}");
        Expect(!s.IsRunning);
        s.Stop(); // idempoten
    });
    await TestAsync("sidecar: berhenti sebelum siap → galat memuat stderr", async () =>
    {
        var bin = FakeSidecar("echo 'kaboom' >&2\nexit 3");
        using var s = new SidecarProcess();
        s.Start(bin, DesktopToken.Generate());
        try { await s.WaitReadyAsync(TimeSpan.FromSeconds(10)); throw new Exception("tak melempar"); }
        catch (ShellException e) { Expect(e.Message.Contains("kaboom"), e.Message); }
    });
    await TestAsync("sidecar: timeout", async () =>
    {
        var bin = FakeSidecar("cat > /dev/null");
        using var s = new SidecarProcess();
        s.Start(bin, DesktopToken.Generate());
        try { await s.WaitReadyAsync(TimeSpan.FromMilliseconds(300)); throw new Exception("tak melempar"); }
        catch (ShellException) { }
    });
    await TestAsync("sidecar: keluar tak terduga setelah siap memanggil handler", async () =>
    {
        var bin = FakeSidecar("echo 'JEJAK_READY {\"port\":9}'\nsleep 0.3\nexit 5");
        using var s = new SidecarProcess();
        var tcs = new TaskCompletionSource<int>();
        s.UnexpectedExit += c => tcs.TrySetResult(c);
        s.Start(bin, DesktopToken.Generate());
        await s.WaitReadyAsync(TimeSpan.FromSeconds(10));
        var done = await Task.WhenAny(tcs.Task, Task.Delay(5000));
        Expect(done == tcs.Task && tcs.Task.Result == 5, "handler tak terpanggil dengan kode 5");
    });
    await TestAsync("sidecar: Stop() tidak memicu handler tak terduga dan mematikan cucu", async () =>
    {
        var marker = Path.Combine(Path.GetTempPath(), "jejak-grandchild-" + Guid.NewGuid().ToString("N"));
        var bin = FakeSidecar($"echo 'JEJAK_READY {{\"port\":9}}'\n(sleep 60; : > {marker}) &\nwait");
        using var s = new SidecarProcess();
        var fired = false;
        s.UnexpectedExit += _ => fired = true;
        s.Start(bin, DesktopToken.Generate());
        await s.WaitReadyAsync(TimeSpan.FromSeconds(10));
        s.Stop();
        await Task.Delay(300);
        Expect(!fired, "handler terpanggil");
        Expect(!File.Exists(marker));
    });
    var real = Environment.GetEnvironmentVariable("JEJAK_REAL_SIDECAR");
    if (!string.IsNullOrEmpty(real) && File.Exists(real))
    {
        await TestAsync("sidecar asli: siap dan berhenti bersih", async () =>
        {
            using var s = new SidecarProcess();
            s.Start(real, DesktopToken.Generate());
            var info = await s.WaitReadyAsync(TimeSpan.FromSeconds(30));
            Expect(info.Port is > 0 and <= 65535);
            s.Stop();
            Expect(!s.IsRunning);
        });
    }
}

// ---- Pembaru ----
const string KunciUji = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDhCQTI4NEEwRjgwNDAyRkIKUldUN0FnVDRvSVNpaXdtZFZUckcxU0NvT05LeVorbERaVEF6YlFXWCtIWVJkVDh1YjVTMGlxanQK";
const string SigUji = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUN0FnVDRvSVNpaXdZeG53K1VpTlB2aCtSM3JMT3pYejdnL2w4VHNwR3haYlR0c0s2K0tVbzlDd0RmcmN4OHJzdmx6Skl4STA2YlpVNUpsRk5zUmJibjRkZ0N0d1lWZkFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1NDE0MzYzCWZpbGU6YS5iaW4Kc0c0cFZUU0F5ZHBGM0M1Sm1STnhHZXZJWmh5dzBLa0sxN24zZUFkdVFWRitiVmJnYVYxVmpDRDVnMy9tMXF2MG1qU1BMNTMvTUpOUEtEZEdoUm1UQ3c9PQo=";
var Hello = System.Text.Encoding.UTF8.GetBytes("hello-update\n");

Test("semver: urutan dan pra-rilis", () =>
{
    Semver V(string s) => Semver.TryParse(s) ?? throw new Exception("gagal parse " + s);
    Expect(V("0.1.0-beta.20") > V("0.1.0-beta.19"));
    Expect(V("0.1.0-beta.9") < V("0.1.0-beta.10"));
    Expect(V("0.1.0") > V("0.1.0-beta.99"));
    Expect(V("0.2.0-beta.1") > V("0.1.9"));
    Expect(V("v1.2.3+abc").Equals(V("1.2.3")));
    Expect(V("1.0.0-alpha") < V("1.0.0-alpha.1"));
    Expect(V("1.0.0-1") < V("1.0.0-alpha"));
    Expect(V("0.1.0-beta.19").ToString() == "0.1.0-beta.19");
});
Test("semver: masukan tak sah", () =>
{
    foreach (var s in new[] { "", "1.2", "1.2.x", "1.2.3-", "1.2.3-a..b", "-1.2.3", "1.2.3.4" })
        Expect(Semver.TryParse(s) == null, "harusnya ditolak: " + s);
});
Test("minisign: fixture tauri sah lolos", () =>
{
    var f = Path.Combine(Path.GetTempPath(), "jejak-sig-" + Guid.NewGuid().ToString("N"));
    File.WriteAllBytes(f, Hello);
    try { new MinisignPublicKey(KunciUji).VerifyFile(f, SigUji); } finally { File.Delete(f); }
    new MinisignPublicKey(KunciUji).VerifyData(Hello, SigUji);
});
Test("minisign: data diubah ditolak", () =>
{
    ExpectThrows(() => new MinisignPublicKey(KunciUji).VerifyData(System.Text.Encoding.UTF8.GetBytes("hello-update!\n"), SigUji));
});
Test("minisign: kunci lain ditolak", () =>
{
    var other = TestSigner.New();
    ExpectThrows(() => new MinisignPublicKey(other.PubKey).VerifyData(Hello, SigUji));
});
Test("minisign: trusted comment diubah ditolak", () =>
{
    var txt = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(SigUji)).Replace("file:a.bin", "file:b.bin");
    ExpectThrows(() => new MinisignPublicKey(KunciUji).VerifyData(Hello, Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(txt))));
});
Test("minisign: masukan rusak ditolak", () =>
{
    ExpectThrows(() => new MinisignPublicKey("bukan-base64!"));
    ExpectThrows(() => new MinisignPublicKey(Convert.ToBase64String("a\nb"u8.ToArray())));
    ExpectThrows(() => new MinisignPublicKey(KunciUji).VerifyData(Hello, ""));
    ExpectThrows(() => new MinisignPublicKey(KunciUji).VerifyData(Hello, Convert.ToBase64String("a\nb\nc\nd"u8.ToArray())));
});
Test("minisign: penanda tangan uji sendiri konsisten", () =>
{
    var t = TestSigner.New();
    new MinisignPublicKey(t.PubKey).VerifyData(Hello, t.Sign(Hello));
});
Test("manifest: parse, kunci platform, entri rusak dilewati", () =>
{
    var json = """
    {"version":"0.1.0-beta.20","notes":"n","pub_date":"2026-01-01T00:00:00Z","platforms":{
      "windows-x86_64-native":{"url":"https://x/y.zip","signature":"abc"},
      "windows-aarch64-native":{"url":"https://x/z.zip","signature":""},
      "linux":{"url":"bukan url","signature":"s"},
      "darwin":"rusak"}}
    """;
    var m = UpdateManifest.Parse(System.Text.Encoding.UTF8.GetBytes(json));
    Expect(m.Version.ToString() == "0.1.0-beta.20" && m.Notes == "n");
    Expect(m.Platforms.Count == 1 && m.Platforms.ContainsKey("windows-x86_64-native"));
    ExpectThrows(() => UpdateManifest.Parse("{}"u8.ToArray()));
    ExpectThrows(() => UpdateManifest.Parse("rusak"u8.ToArray()));
    Expect(UpdateManifest.NativePlatformKey().StartsWith("windows-") && UpdateManifest.NativePlatformKey().EndsWith("-native"));
});
Test("pengaturan: kanal bawaan, simpan, muat, berkas rusak", () =>
{
    Expect(UpdaterSettings.DefaultChannel("0.1.0-beta.19") == "beta" && UpdaterSettings.DefaultChannel("1.0.0") == "stable");
    Expect(UpdaterSettings.Endpoint("x") == null && UpdaterSettings.Endpoint("beta")!.Contains("/beta/"));
    var dir = Path.Combine(Path.GetTempPath(), "jejak-set-" + Guid.NewGuid().ToString("N"));
    var store = new UpdaterSettingsStore(Path.Combine(dir, "u.json"), "0.1.0-beta.1");
    Expect(store.Load() == new UpdaterSettings(true, "beta"));
    store.Save(new UpdaterSettings(false, "stable"));
    Expect(store.Load() == new UpdaterSettings(false, "stable"));
    File.WriteAllText(Path.Combine(dir, "u.json"), "{rusak");
    Expect(store.Load() == new UpdaterSettings(true, "beta"));
    File.WriteAllText(Path.Combine(dir, "u.json"), "{\"channel\":\"aneh\"}");
    Expect(store.Load().Channel == "beta");
    Directory.Delete(dir, true);
});
Test("status: transisi sah dan tak sah", () =>
{
    var s = new UpdateStatus();
    Expect(!s.StartDownload() && !s.FinishInstall());
    Expect(s.StartCheck(1) && !s.StartCheck(2));
    Expect(s.FinishCheck(3, "1.0.0", "n", null) && s.State == UpdatePhase.Available);
    Expect(s.StartDownload() && s.Progress(5, 10) && s.Downloaded == 5);
    Expect(s.FinishDownload() && s.FinishInstall() && s.State == UpdatePhase.Ready);
    var j = s.ToJson();
    Expect((string)j["state"] == "ready" && (string)j["version"] == "1.0.0");
    s.Fail(9, "x");
    Expect(s.State == UpdatePhase.Error && s.StartCheck(10));
});

// Lingkungan uji pembaru: manifest dan zip disajikan oleh handler palsu.
string MakeZip(string version, bool withSidecar = true, string? evilEntry = null, bool nested = true, string exeName = "Jejak.exe")
{
    var path = Path.Combine(Path.GetTempPath(), "jejak-zip-" + Guid.NewGuid().ToString("N") + ".zip");
    using (var z = System.IO.Compression.ZipFile.Open(path, System.IO.Compression.ZipArchiveMode.Create))
    {
        var pre = nested ? "Jejak/" : "";
        void Add(string name, string content)
        {
            using var w = new StreamWriter(z.CreateEntry(name).Open());
            w.Write(content);
        }
        Add(pre + exeName, "versi:" + version);
        if (withSidecar) Add(pre + "jejak-server.exe", "sidecar");
        Add(pre + "lib/data.txt", "x");
        if (evilEntry != null) Add(evilEntry, "jahat");
    }
    return path;
}

(Updater u, string install, string work, Func<string, Uri?> ep) Rig(
    string current, string manifestJson, byte[] zip, string pubkey, Func<string, string?>? readVersion = null, bool zipStatus404 = false, int manifestStatus = 200)
{
    var root = Path.Combine(Path.GetTempPath(), "jejak-rig-" + Guid.NewGuid().ToString("N"));
    var install = Path.Combine(root, "app");
    var work = Path.Combine(root, "work");
    Directory.CreateDirectory(install);
    var handler = new StubHandler(req =>
    {
        var url = req.RequestUri!.ToString();
        if (url.EndsWith("latest.json")) return (manifestStatus, System.Text.Encoding.UTF8.GetBytes(manifestJson));
        if (url.EndsWith("update.zip")) return zipStatus404 ? (404, Array.Empty<byte>()) : (200, zip);
        return (404, Array.Empty<byte>());
    });
    Func<string, Uri?> ep = ch => ch is "stable" or "beta" ? new Uri("https://example.test/" + ch + "/latest.json") : null;
    var u = new Updater(new UpdaterConfig
    {
        CurrentVersion = Semver.TryParse(current)!,
        InstallDir = install,
        WorkDir = work,
        PubKey = pubkey,
        PlatformKey = "windows-x86_64-native",
        Endpoint = ep,
        Http = new HttpClient(handler),
        ReadExeVersion = readVersion ?? (exe => File.ReadAllText(exe).Replace("versi:", "")),
    });
    return (u, install, work, ep);
}

string Manifest(string version, string url, string sig) =>
    "{\"version\":\"" + version + "\",\"notes\":\"catatan\",\"pub_date\":\"2026-01-01T00:00:00Z\",\"platforms\":{\"windows-x86_64-native\":{\"url\":\"" + url + "\",\"signature\":\"" + sig + "\"}}}";

async Task<UpdateStatus> WaitFor(Updater u, params UpdatePhase[] phases)
{
    for (var i = 0; i < 300; i++)
    {
        var s = u.Status;
        if (phases.Contains(s.State)) return s;
        await Task.Delay(20);
    }
    throw new Exception("menunggu status habis waktu: " + u.Status.State);
}

await TestAsync("pembaru: periksa → tersedia → pasang → siap", async () =>
{
    var signer = TestSigner.New();
    var zip = MakeZip("0.1.0-beta.20");
    var bytes = File.ReadAllBytes(zip);
    var (u, install, work, _) = Rig("0.1.0-beta.19", Manifest("0.1.0-beta.20", "https://example.test/update.zip", signer.Sign(bytes)), bytes, signer.PubKey);
    var s = await u.CheckAsync("beta");
    Expect(s.State == UpdatePhase.Available && s.Version == "0.1.0-beta.20" && s.Notes == "catatan", "periksa: " + s.State + " " + s.Error);
    u.Install();
    s = await WaitFor(u, UpdatePhase.Ready, UpdatePhase.Error);
    Expect(s.State == UpdatePhase.Ready, "pasang: " + s.Error);
    Expect(u.StagedDir != null && File.Exists(Path.Combine(u.StagedDir, "Jejak.exe")) && File.Exists(Path.Combine(u.StagedDir, "lib", "data.txt")));
    Expect(Directory.GetFiles(install).Length == 0, "folder aplikasi tak boleh disentuh sebelum mulai ulang");
    Expect(RelaunchHelper.FindStageRoot(u.StagedDir!, work) != "" && RelaunchHelper.FindStageRoot(u.StagedDir!, work).StartsWith(work));
    Directory.Delete(Path.GetDirectoryName(install)!, true);
});
await TestAsync("pembaru: zip tanpa folder pembungkus juga diterima", async () =>
{
    var signer = TestSigner.New();
    var bytes = File.ReadAllBytes(MakeZip("0.2.0", nested: false));
    var (u, install, _, _) = Rig("0.1.0", Manifest("0.2.0", "https://example.test/update.zip", signer.Sign(bytes)), bytes, signer.PubKey);
    await u.CheckAsync("stable");
    u.Install();
    var s = await WaitFor(u, UpdatePhase.Ready, UpdatePhase.Error);
    Expect(s.State == UpdatePhase.Ready, s.Error ?? "");
    Directory.Delete(Path.GetDirectoryName(install)!, true);
});
await TestAsync("pembaru: sudah terbaru atau tanpa artefak platform → idle", async () =>
{
    var signer = TestSigner.New();
    var bytes = File.ReadAllBytes(MakeZip("0.1.0"));
    var (u, install, _, _) = Rig("0.1.0", Manifest("0.1.0", "https://example.test/update.zip", signer.Sign(bytes)), bytes, signer.PubKey);
    Expect((await u.CheckAsync("stable")).State == UpdatePhase.Idle);
    var json = "{\"version\":\"9.0.0\",\"platforms\":{\"darwin-aarch64-native\":{\"url\":\"https://x/a\",\"signature\":\"s\"}}}";
    var (u2, install2, _, _) = Rig("0.1.0", json, bytes, signer.PubKey);
    Expect((await u2.CheckAsync("stable")).State == UpdatePhase.Idle);
    ExpectThrowsAsyncInstall(u2);
    Directory.Delete(Path.GetDirectoryName(install)!, true);
    Directory.Delete(Path.GetDirectoryName(install2)!, true);
});
void ExpectThrowsAsyncInstall(Updater u) => ExpectThrows(() => u.Install());

await TestAsync("pembaru: tanda tangan salah ditolak dan tak meninggalkan sisa", async () =>
{
    var signer = TestSigner.New();
    var bytes = File.ReadAllBytes(MakeZip("0.2.0"));
    var (u, install, work, _) = Rig("0.1.0", Manifest("0.2.0", "https://example.test/update.zip", signer.Sign(System.Text.Encoding.UTF8.GetBytes("lain"))), bytes, signer.PubKey);
    await u.CheckAsync("stable");
    u.Install();
    var s = await WaitFor(u, UpdatePhase.Ready, UpdatePhase.Error);
    Expect(s.State == UpdatePhase.Error && s.Error!.Contains("tanda tangan") || s.Error!.Contains("signature"), s.Error ?? "");
    Expect(u.StagedDir == null);
    Expect(!Directory.Exists(work) || Directory.GetDirectories(work).Length == 0);
    Directory.Delete(Path.GetDirectoryName(install)!, true);
});
await TestAsync("pembaru: versi di exe tak sesuai manifest ditolak", async () =>
{
    var signer = TestSigner.New();
    var bytes = File.ReadAllBytes(MakeZip("0.9.9"));
    var (u, install, _, _) = Rig("0.1.0", Manifest("0.2.0", "https://example.test/update.zip", signer.Sign(bytes)), bytes, signer.PubKey);
    await u.CheckAsync("stable");
    u.Install();
    var s = await WaitFor(u, UpdatePhase.Ready, UpdatePhase.Error);
    Expect(s.State == UpdatePhase.Error);
    Directory.Delete(Path.GetDirectoryName(install)!, true);
});
await TestAsync("pembaru: zip tanpa sidecar, tanpa exe, dan zip-slip ditolak", async () =>
{
    var signer = TestSigner.New();
    foreach (var (zipPath, label) in new[]
    {
        (MakeZip("0.2.0", withSidecar: false), "tanpa sidecar"),
        (MakeZip("0.2.0", exeName: "Lain.exe"), "tanpa exe"),
        (MakeZip("0.2.0", evilEntry: "../../evil.txt"), "zip-slip"),
    })
    {
        var bytes = File.ReadAllBytes(zipPath);
        var (u, install, work, _) = Rig("0.1.0", Manifest("0.2.0", "https://example.test/update.zip", signer.Sign(bytes)), bytes, signer.PubKey);
        await u.CheckAsync("stable");
        u.Install();
        var s = await WaitFor(u, UpdatePhase.Ready, UpdatePhase.Error);
        Expect(s.State == UpdatePhase.Error, label);
        var root = Path.GetDirectoryName(install)!;
        Expect(!File.Exists(Path.Combine(Path.GetDirectoryName(root)!, "evil.txt")) && !File.Exists(Path.Combine(root, "evil.txt")), label);
        Directory.Delete(root, true);
    }
});
await TestAsync("pembaru: http ditolak kecuali override; kanal asing; 404 stabil", async () =>
{
    var signer = TestSigner.New();
    var bytes = File.ReadAllBytes(MakeZip("0.2.0"));
    var (u, install, _, _) = Rig("0.1.0", Manifest("0.2.0", "http://example.test/update.zip", signer.Sign(bytes)), bytes, signer.PubKey);
    await u.CheckAsync("stable");
    u.Install();
    var s = await WaitFor(u, UpdatePhase.Ready, UpdatePhase.Error);
    Expect(s.State == UpdatePhase.Error && s.Error!.Contains("https"), s.Error ?? "");
    var s2 = await u.CheckAsync("aneh");
    Expect(s2.State == UpdatePhase.Error);
    var (u3, install3, _, _) = Rig("0.1.0", "", bytes, signer.PubKey, manifestStatus: 404);
    var s3 = await u3.CheckAsync("stable");
    Expect(s3.State == UpdatePhase.Error && s3.Error!.ToLowerInvariant().Contains("stabil") || s3.Error!.ToLowerInvariant().Contains("stable"), s3.Error ?? "");
    Directory.Delete(Path.GetDirectoryName(install)!, true);
    Directory.Delete(Path.GetDirectoryName(install3)!, true);
});
Test("pembaru: folder aplikasi tak bisa ditulis → galat jelas", () =>
{
    ExpectThrows(() => Updater.EnsureWritable(Path.Combine(Path.GetTempPath(), "jejak-tidak-ada-" + Guid.NewGuid().ToString("N"))));
});
Test("pembaru: skrip bantu mengirim jalur sebagai argumen utuh", () =>
{
    var psi = RelaunchHelper.BuildStartInfo(@"C:\u\apply.ps1", 42, @"C:\Users\A B\Jejak x", @"C:\Program Files\Jejak", @"C:\Program Files\Jejak\Jejak.exe", @"C:\w\g");
    var a = psi.ArgumentList.ToList();
    Expect(a.Contains("-File") && a[a.IndexOf("-Source") + 1] == @"C:\Users\A B\Jejak x");
    Expect(a[a.IndexOf("-ProcId") + 1] == "42" && a[a.IndexOf("-Target") + 1] == @"C:\Program Files\Jejak");
    Expect(psi.FileName == "powershell.exe" && !psi.UseShellExecute);
    Expect(RelaunchHelper.Script.Contains("robocopy") && RelaunchHelper.Script.Contains("Start-Process"));
});

Console.WriteLine($"\n{total - failures}/{total} tes lulus");
return failures == 0 ? 0 : 1;

sealed class StubHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, (int status, byte[] body)> _f;
    public StubHandler(Func<HttpRequestMessage, (int, byte[])> f) { _f = f; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var (status, body) = _f(request);
        return Task.FromResult(new HttpResponseMessage((System.Net.HttpStatusCode)status) { Content = new ByteArrayContent(body) });
    }
}

/// <summary>Penandatangan uji: menghasilkan format minisign varian ED seperti <c>tauri signer</c>.</summary>
sealed class TestSigner
{
    private readonly byte[] _seed = new byte[32];
    private readonly byte[] _pub = new byte[32];
    private readonly byte[] _keyId = new byte[8];

    public static TestSigner New()
    {
        var t = new TestSigner();
        System.Security.Cryptography.RandomNumberGenerator.Fill(t._seed);
        System.Security.Cryptography.RandomNumberGenerator.Fill(t._keyId);
        Org.BouncyCastle.Math.EC.Rfc8032.Ed25519.GeneratePublicKey(t._seed, 0, t._pub, 0);
        return t;
    }

    public string PubKey
    {
        get
        {
            var raw = new byte[] { 0x45, 0x64 }.Concat(_keyId).Concat(_pub).ToArray();
            var text = "untrusted comment: minisign public key: TEST\n" + Convert.ToBase64String(raw) + "\n";
            return Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(text));
        }
    }

    private byte[] SignRaw(byte[] msg)
    {
        var sig = new byte[64];
        Org.BouncyCastle.Math.EC.Rfc8032.Ed25519.Sign(_seed, 0, msg, 0, msg.Length, sig, 0);
        return sig;
    }

    public string Sign(byte[] file)
    {
        var d = new Org.BouncyCastle.Crypto.Digests.Blake2bDigest(512);
        d.BlockUpdate(file, 0, file.Length);
        var hash = new byte[64];
        d.DoFinal(hash, 0);
        var sig = SignRaw(hash);
        var comment = "timestamp:1\tfile:test.zip";
        var global = SignRaw(sig.Concat(System.Text.Encoding.UTF8.GetBytes(comment)).ToArray());
        var raw = new byte[] { 0x45, 0x44 }.Concat(_keyId).Concat(sig).ToArray();
        var text = "untrusted comment: signature from test key\n" + Convert.ToBase64String(raw) + "\ntrusted comment: " + comment + "\n" + Convert.ToBase64String(global) + "\n";
        return Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(text));
    }
}
