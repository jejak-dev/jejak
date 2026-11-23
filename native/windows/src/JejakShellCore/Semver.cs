namespace Jejak.Shell;

/// <summary>Versi semver dengan pra-rilis (mis. <c>0.1.0-beta.19</c>).</summary>
public sealed class Semver : IComparable<Semver>, IEquatable<Semver>
{
    public int Major { get; }
    public int Minor { get; }
    public int Patch { get; }
    public IReadOnlyList<string> Pre { get; }

    private Semver(int major, int minor, int patch, IReadOnlyList<string> pre)
    {
        Major = major; Minor = minor; Patch = patch; Pre = pre;
    }

    public static Semver? TryParse(string? text)
    {
        if (text == null) return null;
        var s = text.Trim();
        if (s.StartsWith('v')) s = s[1..];
        var plus = s.IndexOf('+');
        if (plus >= 0) s = s[..plus]; // metadata build diabaikan
        var pre = new List<string>();
        var dash = s.IndexOf('-');
        if (dash >= 0)
        {
            pre.AddRange(s[(dash + 1)..].Split('.'));
            s = s[..dash];
            if (pre.Any(p => p.Length == 0)) return null;
        }
        var parts = s.Split('.');
        if (parts.Length != 3) return null;
        if (!TryNum(parts[0], out var a) || !TryNum(parts[1], out var b) || !TryNum(parts[2], out var c)) return null;
        return new Semver(a, b, c, pre);
    }

    private static bool TryNum(string s, out int n) =>
        int.TryParse(s, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out n);

    public bool IsPrerelease => Pre.Count > 0;

    public override string ToString() =>
        $"{Major}.{Minor}.{Patch}" + (Pre.Count == 0 ? "" : "-" + string.Join('.', Pre));

    public int CompareTo(Semver? other)
    {
        if (other is null) return 1;
        var c = (Major, Minor, Patch).CompareTo((other.Major, other.Minor, other.Patch));
        if (c != 0) return c;
        // Rilis penuh lebih baru daripada pra-rilis dengan angka sama.
        if (Pre.Count == 0 != (other.Pre.Count == 0)) return Pre.Count == 0 ? 1 : -1;
        for (var i = 0; i < Math.Min(Pre.Count, other.Pre.Count); i++)
        {
            if (Pre[i] == other.Pre[i]) continue;
            var xn = int.TryParse(Pre[i], out var xi);
            var yn = int.TryParse(other.Pre[i], out var yi);
            if (xn && yn) return xi.CompareTo(yi);
            if (xn) return -1; // angka < teks
            if (yn) return 1;
            return string.CompareOrdinal(Pre[i], other.Pre[i]);
        }
        return Pre.Count.CompareTo(other.Pre.Count);
    }

    public bool Equals(Semver? other) => other is not null && CompareTo(other) == 0;
    public override bool Equals(object? obj) => obj is Semver s && Equals(s);
    public override int GetHashCode() => ToString().GetHashCode();
    public static bool operator >(Semver a, Semver b) => a.CompareTo(b) > 0;
    public static bool operator <(Semver a, Semver b) => a.CompareTo(b) < 0;
}
