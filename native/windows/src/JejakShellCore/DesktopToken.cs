using System.Security.Cryptography;

namespace Jejak.Shell;

/// <summary>Token masuk sekali pakai antara cangkang dan server; hanya di memori.</summary>
public static class DesktopToken
{
    public const int MinimumLength = 32;

    /// <summary>32 byte acak, base64url tanpa padding (43 karakter).</summary>
    public static string Generate() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).Replace('+', '-').Replace('/', '_').TrimEnd('=');

    public static bool IsValid(string token) =>
        token.Length >= MinimumLength && token.All(c =>
            (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '-' || c == '_');
}
