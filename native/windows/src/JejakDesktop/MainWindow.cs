using System.IO;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Jejak.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using static Jejak.Shell.Localization;

namespace Jejak.Desktop;

/// <summary>
/// Jendela utama: WebView2 yang memuat server Jejak lokal (sidecar), dengan
/// layar mulai dan layar galat sebagai lapisan di atasnya.
/// </summary>
public sealed class MainWindow : Window
{
    private readonly WebView2 _web = new();
    private readonly Grid _overlay = new();
    private readonly TextBlock _title = new();
    private readonly TextBox _detail = new();
    private readonly StackPanel _buttons = new();
    private readonly SidecarProcess _sidecar = new();
    private readonly Notifier _notifier;
    private readonly Bridge _bridge;
    private int _port;
    private bool _closing;
    private bool _started;

    public MainWindow()
    {
        Title = "Jejak";
        Width = 1280;
        Height = 820;
        MinWidth = 900;
        MinHeight = 600;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;

        var dark = IsDarkTheme();
        var bg = dark ? Color.FromRgb(0x14, 0x14, 0x15) : Color.FromRgb(0xFA, 0xFA, 0xF9);
        var fg = dark ? Color.FromRgb(0xE8, 0xE8, 0xE6) : Color.FromRgb(0x1F, 0x1F, 0x1E);
        Background = new SolidColorBrush(bg);
        _web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(bg.R, bg.G, bg.B);

        _notifier = new Notifier(ActivateWindow);
        _bridge = new Bridge(() => _port, _notifier);

        _title.Foreground = new SolidColorBrush(fg);
        _title.FontSize = 20;
        _title.HorizontalAlignment = HorizontalAlignment.Center;
        _title.Margin = new Thickness(0, 0, 0, 12);
        _detail.IsReadOnly = true;
        _detail.TextWrapping = TextWrapping.Wrap;
        _detail.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        _detail.Background = Brushes.Transparent;
        _detail.Foreground = new SolidColorBrush(fg);
        _detail.BorderThickness = new Thickness(0);
        _detail.MaxHeight = 300;
        _detail.Visibility = Visibility.Collapsed;
        _buttons.Orientation = Orientation.Horizontal;
        _buttons.HorizontalAlignment = HorizontalAlignment.Center;
        _buttons.Margin = new Thickness(0, 16, 0, 0);
        var stack = new StackPanel { VerticalAlignment = VerticalAlignment.Center, MaxWidth = 640, Margin = new Thickness(24) };
        stack.Children.Add(_title);
        stack.Children.Add(_detail);
        stack.Children.Add(_buttons);
        _overlay.Background = new SolidColorBrush(bg);
        _overlay.Children.Add(stack);

        var root = new Grid();
        root.Children.Add(_web);
        root.Children.Add(_overlay);
        Content = root;

        Loaded += async (_, _) => await StartAsync();
        Closing += OnClosing;
        _sidecar.UnexpectedExit += code => Dispatcher.Invoke(() =>
            ShowError(L("error.server_exited", "Server Jejak berhenti tiba-tiba (kode %@)", code), _sidecar.Stderr.Summary()));
    }

    private static bool IsDarkTheme()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int v && v == 0;
        }
        catch { return false; }
    }

    private void ActivateWindow()
    {
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
    }

    private void ShowSplash()
    {
        _title.Text = L("splash.starting", "Memulai Jejak…");
        _detail.Visibility = Visibility.Collapsed;
        _buttons.Children.Clear();
        _overlay.Visibility = Visibility.Visible;
    }

    private void ShowError(string message, string detail)
    {
        _title.Text = L("error.start_failed", "Jejak tidak bisa dimulai");
        _detail.Text = string.IsNullOrWhiteSpace(detail) ? message : message + "\n\n" + detail;
        if (string.IsNullOrWhiteSpace(detail)) _detail.Text = message + "\n\n" + L("error.no_output", "(tak ada keluaran dari server)");
        _detail.Visibility = Visibility.Visible;
        _buttons.Children.Clear();
        var retry = new Button { Content = L("button.retry", "Coba lagi"), Padding = new Thickness(16, 6, 16, 6), Margin = new Thickness(0, 0, 8, 0) };
        retry.Click += async (_, _) => { _started = false; await StartAsync(); };
        var copy = new Button { Content = L("button.copy", "Salin"), Padding = new Thickness(16, 6, 16, 6) };
        copy.Click += (_, _) => { try { Clipboard.SetText(_detail.Text); } catch { } };
        _buttons.Children.Add(retry);
        _buttons.Children.Add(copy);
        _overlay.Visibility = Visibility.Visible;
    }

    private async Task StartAsync()
    {
        if (_started) return;
        _started = true;
        ShowSplash();
        try
        {
            await EnsureWebViewAsync();
            var binary = BinaryLocator.Locate(AppContext.BaseDirectory);
            var token = DesktopToken.Generate();
            _sidecar.Start(binary, token);
            var info = await _sidecar.WaitReadyAsync();
            _port = info.Port;
            _web.CoreWebView2.Navigate(NavigationPolicy.EnterUrl(info.Port, token));
        }
        catch (WebView2RuntimeNotFoundException)
        {
            ShowError(L("webview.missing", "Microsoft Edge WebView2 Runtime diperlukan. Pasang lalu buka Jejak lagi."), "");
        }
        catch (Exception e)
        {
            _sidecar.Stop();
            ShowError(e is ShellException ? e.Message : e.ToString(), "");
        }
    }

    private bool _webReady;

    private async Task EnsureWebViewAsync()
    {
        if (_webReady) return;
        var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Jejak", "WebView2");
        var env = await CoreWebView2Environment.CreateAsync(null, data);
        await _web.EnsureCoreWebView2Async(env);
        var core = _web.CoreWebView2;
        var debug = Environment.GetEnvironmentVariable("JEJAK_DEBUG") == "1";
        core.Settings.AreDevToolsEnabled = debug;
        core.Settings.AreBrowserAcceleratorKeysEnabled = debug;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        await _bridge.InstallAsync(core);

        core.NavigationStarting += (_, e) =>
        {
            if (NavigationPolicy.IsAllowedNavigation(e.Uri, _port)) return;
            e.Cancel = true;
            OpenExternal(e.Uri);
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        };
        core.PermissionRequested += (_, e) =>
        {
            // Hanya mikrofon (dikte) untuk halaman Jejak sendiri; selainnya ditolak.
            var ok = e.PermissionKind == CoreWebView2PermissionKind.Microphone && NavigationPolicy.IsLocalAppUrl(e.Uri, _port);
            e.State = ok ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
        };
        core.ProcessFailed += (_, e) =>
        {
            if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive
                && !_closing)
                Dispatcher.BeginInvoke(() => core.Reload());
        };
        core.NavigationCompleted += (_, e) =>
        {
            if (e.IsSuccess && NavigationPolicy.IsLocalAppUrl(core.Source, _port)) _overlay.Visibility = Visibility.Collapsed;
        };
        _webReady = true;
    }

    private static void OpenExternal(string url)
    {
        var target = NavigationPolicy.ExternalOpenTarget(url, 0);
        if (target == null) return;
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); } catch { }
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_closing) return;
        // Hentikan sidecar di luar thread UI (bisa memakan beberapa detik), lalu tutup.
        e.Cancel = true;
        _closing = true;
        Hide();
        Task.Run(() => _sidecar.Stop()).ContinueWith(_ => Dispatcher.Invoke(() =>
        {
            _notifier.Dispose();
            Close();
        }));
    }
}
