using System.Windows;
using System.Windows.Threading;

namespace MiniDayZ.App;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            Logger.Error("AppDomain.UnhandledException", args.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            Logger.Error("UnobservedTaskException", args.Exception);
            args.SetObserved();
        };

        SaveSystem.Initialize();
        base.OnStartup(e);
    }

    private static void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        Logger.Error("DispatcherUnhandledException", e.Exception);
        e.Handled = true;
        MessageBox.Show(
            "Ocorreu um erro inesperado. Detalhes em %LOCALAPPDATA%\\MiniDayZ\\logs\\app.log",
            "Mini DayZ", MessageBoxButton.OK, MessageBoxImage.Warning);
    }
}
