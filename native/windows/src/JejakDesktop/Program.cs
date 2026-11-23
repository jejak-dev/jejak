using System.Windows;

namespace Jejak.Desktop;

public static class Program
{
    [STAThread]
    public static int Main()
    {
        // Instans tunggal: dua jendela berarti dua server dan data sesi yang berebut.
        using var mutex = new Mutex(true, @"Local\io.github.jejak-dev.jejak.native", out var first);
        if (!first)
        {
            MessageBox.Show(Jejak.Shell.Localization.L("app.already_running", "Jejak sudah berjalan."), "Jejak");
            return 0;
        }
        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        return app.Run(new MainWindow());
    }
}
