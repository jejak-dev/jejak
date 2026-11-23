using System.Text;
using Org.BouncyCastle.Crypto.Digests;
using Org.BouncyCastle.Math.EC.Rfc8032;
using static Jejak.Shell.Localization;

namespace Jejak.Shell;

/// <summary>
/// Verifikasi tanda tangan format minisign dari <c>tauri signer</c>. Hanya varian "ED"
/// (berkas di-prehash BLAKE2b-512), sama dengan plugin updater Tauri dan cangkang macOS.
/// Kunci publik dan tanda tangan berupa base64 dari isi berkas <c>.pub</c> / <c>.sig</c>.
/// </summary>
public sealed class MinisignPublicKey
{
    private readonly byte[] _keyId;
    private readonly byte[] _key;

    public MinisignPublicKey(string base64Tauri)
    {
        var lines = DecodeText(base64Tauri);
        byte[]? raw = null;
        if (lines.Length >= 2) raw = TryBase64(lines[1]);
        if (raw is not { Length: 42 } || raw[0] != 0x45 || raw[1] != 0x64) // "Ed"
            throw new ShellException(L("sign.bad_pubkey", "kunci publik pembaruan tak sah"));
        _keyId = raw[2..10];
        _key = raw[10..42];
    }

    public void VerifyFile(string path, string signatureBase64)
    {
        var digest = new Blake2bDigest(512);
        try
        {
            using var f = File.OpenRead(path);
            var buf = new byte[1 << 20];
            int n;
            while ((n = f.Read(buf, 0, buf.Length)) > 0) digest.BlockUpdate(buf, 0, n);
        }
        catch (IOException)
        {
            throw new ShellException(L("sign.read", "berkas unduhan tak bisa dibaca"));
        }
        var hash = new byte[64];
        digest.DoFinal(hash, 0);
        Verify(hash, signatureBase64);
    }

    public void VerifyData(byte[] data, string signatureBase64)
    {
        var digest = new Blake2bDigest(512);
        digest.BlockUpdate(data, 0, data.Length);
        var hash = new byte[64];
        digest.DoFinal(hash, 0);
        Verify(hash, signatureBase64);
    }

    private void Verify(byte[] digest, string signatureBase64)
    {
        var invalid = new ShellException(L("sign.invalid", "tanda tangan pembaruan tak cocok"));
        var bad = new ShellException(L("sign.bad_format", "format tanda tangan pembaruan rusak"));
        var lines = DecodeText(signatureBase64);
        // [0] komentar, [1] tanda tangan, [2] "trusted comment: ...", [3] tanda tangan global
        if (lines.Length < 4) throw bad;
        var raw = TryBase64(lines[1]);
        var global = TryBase64(lines[3]);
        if (raw is not { Length: 74 } || global is not { Length: 64 }) throw bad;
        if (raw[0] != 0x45 || raw[1] != 0x44)
            throw new ShellException(L("sign.legacy", "tanda tangan varian lama tak diterima"));
        if (!raw.AsSpan(2, 8).SequenceEqual(_keyId))
            throw new ShellException(L("sign.wrong_key", "tanda tangan dibuat dengan kunci lain"));
        var sig = raw[10..74];
        if (!Ed25519.Verify(sig, 0, _key, 0, digest, 0, digest.Length)) throw invalid;
        // Tanda tangan global melindungi trusted comment: sig || komentar.
        const string prefix = "trusted comment: ";
        if (!lines[2].StartsWith(prefix, StringComparison.Ordinal)) throw bad;
        var comment = Encoding.UTF8.GetBytes(lines[2][prefix.Length..]);
        var msg = new byte[sig.Length + comment.Length];
        sig.CopyTo(msg, 0);
        comment.CopyTo(msg, sig.Length);
        if (!Ed25519.Verify(global, 0, _key, 0, msg, 0, msg.Length)) throw invalid;
    }

    private static byte[]? TryBase64(string s)
    {
        try { return Convert.FromBase64String(s.Trim()); } catch (FormatException) { return null; }
    }

    /// <summary>Base64 luar → teks minisign → baris.</summary>
    private static string[] DecodeText(string base64)
    {
        var clean = new string(base64.Where(c => !char.IsWhiteSpace(c)).ToArray());
        var raw = TryBase64(clean);
        if (raw == null) throw new ShellException(L("sign.bad_format", "format tanda tangan pembaruan rusak"));
        try { return new UTF8Encoding(false, true).GetString(raw).Split('\n'); }
        catch (ArgumentException) { throw new ShellException(L("sign.bad_format", "format tanda tangan pembaruan rusak")); }
    }
}
