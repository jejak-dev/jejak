using System.Diagnostics;
using static Jejak.Shell.Localization;

namespace Jejak.Shell;

/// <summary>
/// Pengelola proses sidecar `jejak serve --desktop`. Stdin dibiarkan terbuka
/// (menutupnya = sinyal berhenti yang sopan); token hanya lewat lingkungan anak.
/// </summary>
public sealed class SidecarProcess : IDisposable
{
    public static readonly TimeSpan ReadyTimeout = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan ExitGrace = TimeSpan.FromSeconds(3);

    private readonly object _lock = new();
    private readonly TaskCompletionSource<ReadyInfo> _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Process? _process;
    private JobObject? _job;
    private bool _stopped;
    private bool _exited;

    public LineRingBuffer Stderr { get; } = new(200);

    /// <summary>Dipanggil sekali bila proses berhenti SETELAH siap dan bukan karena Stop().</summary>
    public event Action<int>? UnexpectedExit;

    public bool IsRunning { get { lock (_lock) return _process != null && !_exited; } }

    public void Start(string binary, string token, IDictionary<string, string>? extraEnv = null)
    {
        var psi = new ProcessStartInfo(binary)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
        };
        psi.ArgumentList.Add("serve");
        psi.ArgumentList.Add("--desktop");
        if (extraEnv != null) foreach (var (k, v) in extraEnv) psi.Environment[k] = v;
        psi.Environment["JEJAK_DESKTOP_TOKEN"] = token;
        psi.Environment["PORT"] = "0";

        Process process;
        try { process = Process.Start(psi) ?? throw new ShellException("Process.Start returned null"); }
        catch (Exception e) when (e is not ShellException)
        {
            throw new ShellException(L("sidecar.spawn", "gagal menjalankan sidecar %@: %@", binary, e.Message));
        }
        _job = JobObject.TryCreate();
        _job?.Assign(process);
        lock (_lock) _process = process;

        var outTask = Task.Run(() => ReadLines(process.StandardOutput, OnStdoutLine));
        var errTask = Task.Run(() => ReadLines(process.StandardError, Stderr.Append));
        Task.Run(async () =>
        {
            await process.WaitForExitAsync();
            // Kuras pembaca dulu supaya baris siap dan stderr terakhir tak hilang.
            await Task.WhenAll(outTask, errTask).WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
            await Task.CompletedTask;
            OnExit(process.ExitCode);
        }).ContinueWith(_ => { }, TaskContinuationOptions.OnlyOnFaulted);
    }

    private static void ReadLines(StreamReader reader, Action<string> each)
    {
        try { string? line; while ((line = reader.ReadLine()) != null) each(line); }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
    }

    private void OnStdoutLine(string line)
    {
        if (_ready.Task.IsCompleted) return; // terus kuras pipa, abaikan isinya
        try
        {
            var info = ReadyLine.Parse(line);
            if (info != null) _ready.TrySetResult(info);
        }
        catch (ShellException e) { _ready.TrySetException(e); }
    }

    private void OnExit(int code)
    {
        bool intentional, wasReady;
        lock (_lock) { _exited = true; intentional = _stopped; }
        wasReady = _ready.Task.IsCompletedSuccessfully;
        _ready.TrySetException(new ShellException(L("sidecar.exited_before_ready", "Server Jejak berhenti sebelum siap")));
        if (wasReady && !intentional) UnexpectedExit?.Invoke(code);
    }

    /// <summary>Menunggu baris JEJAK_READY. Galat memuat ringkasan stderr.</summary>
    public async Task<ReadyInfo> WaitReadyAsync(TimeSpan? timeout = null)
    {
        var limit = timeout ?? ReadyTimeout;
        var done = await Task.WhenAny(_ready.Task, Task.Delay(limit));
        if (done == _ready.Task)
        {
            try { return await _ready.Task; }
            catch (ShellException e) { throw Wrap(e.Message); }
        }
        throw Wrap(L("sidecar.timeout", "Server Jejak tak siap dalam %@ detik", (int)limit.TotalSeconds));
    }

    private ShellException Wrap(string message)
    {
        var tail = Stderr.Summary();
        return new ShellException(tail.Length == 0 ? message : message + "\n" + tail);
    }

    /// <summary>Menutup stdin, menunggu, lalu mematikan seluruh pohon proses. Idempoten.</summary>
    public void Stop()
    {
        Process? p;
        lock (_lock)
        {
            if (_stopped) return;
            _stopped = true;
            p = _process;
        }
        if (p == null) return;
        try { p.StandardInput.Close(); } catch { }
        if (!WaitExit(p, ExitGrace))
        {
            try { p.Kill(entireProcessTree: true); } catch { }
            WaitExit(p, TimeSpan.FromSeconds(2));
        }
        // Anak langsung selesai: pastikan sisa pohon (cucu) juga mati.
        try { p.Kill(entireProcessTree: true); } catch { }
        _job?.Dispose();
        _job = null;
    }

    private static bool WaitExit(Process p, TimeSpan span)
    {
        try { return p.WaitForExit((int)span.TotalMilliseconds); }
        catch (InvalidOperationException) { return true; }
    }

    public void Dispose() => Stop();
}
