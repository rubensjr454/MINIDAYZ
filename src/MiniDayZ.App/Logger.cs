using System.Diagnostics;
using System.IO;

namespace MiniDayZ.App;

public static class Logger
{
    private const long MaxBytes = 1024 * 1024;
    private const int MaxFiles = 3;

    private static readonly string Dir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MiniDayZ", "logs");

    private static readonly string FilePath = Path.Combine(Dir, "app.log");
    private static readonly object Sync = new();

    public static void Info(string msg) => Write("INFO", msg);
    public static void Warn(string msg) => Write("WARN", msg);
    public static void Error(string msg, Exception? ex = null) => Write("ERROR", ex is null ? msg : $"{msg}: {ex}");

    private static void Write(string level, string msg)
    {
        string line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{level}] {msg}";
        Debug.WriteLine(line);

        try
        {
            lock (Sync)
            {
                Directory.CreateDirectory(Dir);
                Rotate();
                File.AppendAllText(FilePath, line + Environment.NewLine);
            }
        }
        catch
        {
        }
    }

    private static void Rotate()
    {
        var fi = new FileInfo(FilePath);
        if (!fi.Exists || fi.Length < MaxBytes) return;

        string Name(int i) => Path.Combine(Dir, $"app.{i}.log");
        File.Delete(Name(MaxFiles - 1));
        for (int i = MaxFiles - 2; i >= 1; i--)
            if (File.Exists(Name(i))) File.Move(Name(i), Name(i + 1));
        File.Move(FilePath, Name(1));
    }
}
