using System.IO;
using System.Text;

namespace MiniDayZ.App;

public static class SaveSystem
{
    private static readonly string SaveDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MiniDayZ", "Saves");

    private static readonly object Sync = new();
    private static readonly UTF8Encoding Utf8NoBom = new(false);

    public static void Save(string key, string data)
    {
        string path = GetPath(key);
        string temp = path + ".tmp";

        lock (Sync)
        {
            Directory.CreateDirectory(SaveDirectory);
            File.WriteAllText(temp, data, Utf8NoBom);
            File.Move(temp, path, overwrite: true);
        }
    }

    public static string? Load(string key)
    {
        string path = GetPath(key);

        lock (Sync)
        {
            return File.Exists(path) ? File.ReadAllText(path, Utf8NoBom) : null;
        }
    }

    public static void Delete(string key)
    {
        string path = GetPath(key);

        lock (Sync)
        {
            if (File.Exists(path))
                File.Delete(path);
        }
    }

    public static Dictionary<string, string> LoadAll()
    {
        var saves = new Dictionary<string, string>(StringComparer.Ordinal);

        lock (Sync)
        {
            if (!Directory.Exists(SaveDirectory))
                return saves;

            foreach (string file in Directory.EnumerateFiles(SaveDirectory, "*.json"))
            {
                string key = Uri.UnescapeDataString(Path.GetFileNameWithoutExtension(file));
                saves[key] = File.ReadAllText(file, Utf8NoBom);
            }
        }

        return saves;
    }

    private static string GetPath(string key)
    {
        if (string.IsNullOrEmpty(key))
            throw new ArgumentException("Save key vazia.", nameof(key));

        // Escapa tudo exceto [A-Za-z0-9-_.~]: impede path traversal e caracteres inválidos no Windows.
        return Path.Combine(SaveDirectory, Uri.EscapeDataString(key) + ".json");
    }
}

