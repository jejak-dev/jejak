using System.Runtime.InteropServices;
using static Jejak.Shell.Localization;

namespace Jejak.Shell;

public static class BinaryLocator
{
    public static string Triple => RuntimeInformation.OSArchitecture switch
    {
        Architecture.Arm64 when OperatingSystem.IsWindows() => "aarch64-pc-windows-msvc",
        _ when OperatingSystem.IsWindows() => "x86_64-pc-windows-msvc",
        Architecture.Arm64 when OperatingSystem.IsMacOS() => "aarch64-apple-darwin",
        _ when OperatingSystem.IsMacOS() => "x86_64-apple-darwin",
        _ => "x86_64-unknown-linux-gnu",
    };

    private static string Exe => OperatingSystem.IsWindows() ? ".exe" : "";

    /// <summary>JEJAK_SIDECAR menang; lalu kandidat relatif ke folder executable.</summary>
    public static string Locate(string executableFolder, Func<string, string?>? env = null)
    {
        env ??= Environment.GetEnvironmentVariable;
        var fromEnv = env("JEJAK_SIDECAR");
        if (!string.IsNullOrEmpty(fromEnv))
        {
            if (File.Exists(fromEnv)) return fromEnv;
            throw new ShellException(L("locator.env_missing", "JEJAK_SIDECAR menunjuk berkas yang tak ada: %@", fromEnv));
        }
        var candidates = new[]
        {
            Path.Combine(executableFolder, "jejak" + Exe),
            Path.Combine(executableFolder, $"jejak-{Triple}{Exe}"),
            Path.Combine(executableFolder, "binaries", "jejak" + Exe),
        };
        foreach (var c in candidates) if (File.Exists(c)) return c;
        throw new ShellException(L("locator.not_found", "binary sidecar tak ditemukan. Dicoba: %@", string.Join(", ", candidates)));
    }
}
