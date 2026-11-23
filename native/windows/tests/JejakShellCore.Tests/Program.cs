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
        var exe = OperatingSystem.IsWindows() ? "jejak.exe" : "jejak";
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

Console.WriteLine($"\n{total - failures}/{total} tes lulus");
return failures == 0 ? 0 : 1;
