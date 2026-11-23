using System.Windows.Forms;

namespace Jejak.Desktop;

/// <summary>Notifikasi sistem lewat balon NotifyIcon (tanpa paket MSIX).</summary>
public sealed class Notifier : IDisposable
{
    private readonly NotifyIcon _icon;
    private readonly Action _onClick;
    private CancellationTokenSource? _hide;

    public Notifier(Action onClick)
    {
        _onClick = onClick;
        _icon = new NotifyIcon
        {
            Icon = System.Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath ?? "") ?? System.Drawing.SystemIcons.Application,
            Text = "Jejak",
            Visible = false,
        };
        _icon.BalloonTipClicked += (_, _) => _onClick();
    }

    public void Show(string title, string body)
    {
        _hide?.Cancel();
        _icon.Visible = true;
        _icon.BalloonTipTitle = title.Length > 63 ? title[..63] : title;
        _icon.BalloonTipText = string.IsNullOrEmpty(body) ? " " : (body.Length > 255 ? body[..255] : body);
        _icon.ShowBalloonTip(8000);
        var cts = _hide = new CancellationTokenSource();
        _ = Task.Delay(TimeSpan.FromSeconds(12), cts.Token).ContinueWith(
            t => { if (!t.IsCanceled) System.Windows.Application.Current?.Dispatcher.Invoke(() => _icon.Visible = false); });
    }

    public void Dispose()
    {
        _hide?.Cancel();
        _icon.Visible = false;
        _icon.Dispose();
    }
}
