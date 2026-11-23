namespace Jejak.Shell;

/// <summary>Daftar putih navigasi webview utama: hanya http://127.0.0.1:&lt;port&gt;.</summary>
public static class NavigationPolicy
{
    public const string Loopback = "127.0.0.1";
    public const string EnterPath = "/__desktop/enter";

    public static string EnterUrl(int port, string token) => $"http://{Loopback}:{port}{EnterPath}?t={token}";

    public static bool IsLocalAppUrl(string url, int port) =>
        port != 0 && Uri.TryCreate(url, UriKind.Absolute, out var u)
        && u.Scheme == "http" && u.Host == Loopback && u.Port == port;

    public static bool IsAllowedNavigation(string url, int port) => url == "about:blank" || IsLocalAppUrl(url, port);

    /// <summary>Tautan http/https bukan Jejak sendiri → boleh dibuka di browser sistem.</summary>
    public static string? ExternalOpenTarget(string url, int port)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return null;
        if (u.Scheme != "http" && u.Scheme != "https") return null;
        if (string.IsNullOrEmpty(u.Host)) return null;
        return IsLocalAppUrl(url, port) ? null : url;
    }
}
