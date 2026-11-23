using System.Text.Json;
using static Jejak.Shell.Localization;

namespace Jejak.Shell;

public sealed record ReadyInfo(int Port, string Host, string Version);

public sealed class ShellException(string message) : Exception(message);

public static class ReadyLine
{
    public const string Prefix = "JEJAK_READY";

    /// <summary>null = bukan pengumuman; throw = pengumuman tapi payload rusak.</summary>
    public static ReadyInfo? Parse(string line)
    {
        var clean = line.Trim('\r', '\n');
        if (!clean.StartsWith(Prefix, StringComparison.Ordinal)) return null;
        var rest = clean[Prefix.Length..];
        if (rest.Length == 0) throw new ShellException(L("ready.no_payload", "baris JEJAK_READY tanpa payload JSON"));
        if (!char.IsWhiteSpace(rest[0])) return null;
        var body = rest.Trim();
        if (body.Length == 0) throw new ShellException(L("ready.no_payload", "baris JEJAK_READY tanpa payload JSON"));
        JsonElement root;
        try { root = JsonDocument.Parse(body).RootElement; }
        catch (JsonException) { throw new ShellException(L("ready.bad_json", "payload JEJAK_READY bukan JSON yang sah")); }
        if (root.ValueKind != JsonValueKind.Object) throw new ShellException(L("ready.bad_json", "payload JEJAK_READY bukan JSON yang sah"));
        if (!root.TryGetProperty("port", out var p) || p.ValueKind != JsonValueKind.Number || !p.TryGetInt64(out var port))
            throw new ShellException(L("ready.no_port", "payload JEJAK_READY tanpa port"));
        if (port < 1 || port > 65535)
            throw new ShellException(L("ready.port_range", "port JEJAK_READY di luar rentang: %@", port));
        var host = root.TryGetProperty("host", out var h) && h.ValueKind == JsonValueKind.String ? h.GetString()! : "127.0.0.1";
        var version = root.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
        return new ReadyInfo((int)port, host, version);
    }
}
