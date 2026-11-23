using System.Globalization;

namespace Jejak.Shell;

/// <summary>
/// Teks cangkang dua bahasa. Kunci + teks bawaan Indonesia di kode; tabel
/// bahasa Inggris di sini. Bahasa mengikuti UI sistem (id → Indonesia, lainnya → Inggris
/// bila ada terjemahan, selain itu teks bawaan).
/// </summary>
public static class Localization
{
    /// <summary>Menimpa bahasa (mis. "en"/"id") untuk uji; null = ikuti sistem.</summary>
    public static string? OverrideLanguage { get; set; }

    private static string Language =>
        (OverrideLanguage ?? CultureInfo.CurrentUICulture.TwoLetterISOLanguageName).ToLowerInvariant();

    public static string L(string key, string fallback, params object[] args)
    {
        var text = fallback;
        if (Language != "id" && English.TryGetValue(key, out var en)) text = en;
        if (args.Length == 0) return text;
        // Pengganti %@ berurutan, sama dengan cangkang macOS.
        var parts = text.Split("%@");
        var sb = new System.Text.StringBuilder(parts[0]);
        for (var i = 1; i < parts.Length; i++)
        {
            sb.Append(i - 1 < args.Length ? Convert.ToString(args[i - 1], CultureInfo.InvariantCulture) : "");
            sb.Append(parts[i]);
        }
        return sb.ToString();
    }

    public static readonly IReadOnlyDictionary<string, string> English = new Dictionary<string, string>
    {
        ["ready.no_payload"] = "JEJAK_READY line has no JSON payload",
        ["ready.bad_json"] = "JEJAK_READY payload is not valid JSON",
        ["ready.no_port"] = "JEJAK_READY payload has no port",
        ["ready.port_range"] = "JEJAK_READY port out of range: %@",
        ["locator.env_missing"] = "JEJAK_SIDECAR points to a file that does not exist: %@",
        ["locator.not_found"] = "sidecar binary not found. Tried: %@",
        ["sidecar.spawn"] = "failed to launch sidecar %@: %@",
        ["sidecar.start_failed_generic"] = "The Jejak server could not start",
        ["sidecar.exited_before_ready"] = "The Jejak server stopped before it was ready",
        ["sidecar.timeout"] = "The Jejak server was not ready within %@ seconds",
        ["splash.starting"] = "Starting Jejak…",
        ["error.start_failed"] = "Jejak couldn't start",
        ["error.server_exited"] = "The Jejak server stopped unexpectedly (code %@)",
        ["error.no_output"] = "(no output from the server)",
        ["button.retry"] = "Try again",
        ["button.copy"] = "Copy",
        ["bridge.updater_unavailable"] = "automatic updates are not yet available in the Windows shell",
        ["bridge.unknown_command"] = "unknown command: %@",
        ["bridge.rejected"] = "bridge message rejected: unknown origin",
        ["app.already_running"] = "Jejak is already running.",
        ["webview.missing"] = "Microsoft Edge WebView2 Runtime is required. Install it, then open Jejak again.",
    };
}
