using System.Collections.Concurrent;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MiniDayZ.App;

public static class SaveSystem
{
    private static readonly string SaveDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MiniDayZ", "Saves");

    private const int DebounceMs = 300;

    private static readonly object Sync = new();
    private static readonly UTF8Encoding Utf8NoBom = new(false);

    // valor null = delete pendente
    private static readonly ConcurrentDictionary<string, string?> Pending = new(StringComparer.Ordinal);
    private static readonly SemaphoreSlim Signal = new(0);
    private static readonly object FlushSync = new();
    private static TaskCompletionSource? _flushTcs;
    private static long _lastEnqueueTicks;
    private static volatile bool _flushNow;
    private static int _started;

    public static void Initialize()
    {
        try
        {
            Directory.CreateDirectory(SaveDirectory);
            foreach (string tmp in Directory.EnumerateFiles(SaveDirectory, "*.tmp"))
                File.Delete(tmp);
        }
        catch (Exception ex)
        {
            Logger.Warn($"Falha preparando pasta de saves: {ex.Message}");
        }
        EnsureWorker();
    }

    public static void Save(string key, string data) => Enqueue(key, data);

    public static void Delete(string key) => Enqueue(key, null);

    public static string? Load(string key)
    {
        if (Pending.TryGetValue(key, out string? pending))
            return pending;

        lock (Sync)
        {
            return TryReadFile(GetPath(key), out string? k, out string? d) && k == key ? d : null;
        }
    }

    public static Dictionary<string, string> LoadAll()
    {
        var saves = new Dictionary<string, string>(StringComparer.Ordinal);

        lock (Sync)
        {
            if (Directory.Exists(SaveDirectory))
            {
                foreach (string file in Directory.EnumerateFiles(SaveDirectory, "*.json"))
                {
                    try
                    {
                        string name = Path.GetFileNameWithoutExtension(file);
                        if (IsHash(name))
                        {
                            if (TryReadFile(file, out string? k, out string? d) && k is not null && d is not null)
                                saves[k] = d;
                            continue;
                        }

                        // Formato antigo: nome = chave escapada, conteúdo = dado cru. Migra.
                        string legacyKey = Uri.UnescapeDataString(name);
                        string legacyData = File.ReadAllText(file, Utf8NoBom);
                        saves[legacyKey] = legacyData;
                        WriteFile(legacyKey, legacyData);
                        File.Delete(file);
                    }
                    catch (Exception ex)
                    {
                        Logger.Error($"Falha lendo save '{Path.GetFileName(file)}'", ex);
                    }
                }
            }
        }

        foreach (var kv in Pending)
        {
            if (kv.Value is null) saves.Remove(kv.Key);
            else saves[kv.Key] = kv.Value;
        }

        return saves;
    }

    /// <summary>Grava tudo que está pendente. Retorna false se estourar o timeout.</summary>
    public static bool Flush(TimeSpan timeout)
    {
        if (Pending.IsEmpty) return true;

        TaskCompletionSource tcs;
        lock (FlushSync)
        {
            tcs = _flushTcs ??= new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            _flushNow = true;
        }

        EnsureWorker();
        Signal.Release();

        bool ok = tcs.Task.Wait(timeout);
        if (!ok) Logger.Warn("SaveSystem.Flush estourou timeout.");
        return ok;
    }

    private static void Enqueue(string key, string? data)
    {
        if (string.IsNullOrEmpty(key))
            throw new ArgumentException("Save key vazia.", nameof(key));

        Pending[key] = data;
        Interlocked.Exchange(ref _lastEnqueueTicks, Environment.TickCount64);
        EnsureWorker();
        Signal.Release();
    }

    private static void EnsureWorker()
    {
        if (Interlocked.Exchange(ref _started, 1) == 0)
            _ = Task.Factory.StartNew(WorkerLoop, TaskCreationOptions.LongRunning);
    }

    private static void WorkerLoop()
    {
        while (true)
        {
            Signal.Wait();

            // debounce: espera silêncio de DebounceMs desde o último enqueue (Flush pula a espera)
            while (!_flushNow)
            {
                long wait = DebounceMs - (Environment.TickCount64 - Interlocked.Read(ref _lastEnqueueTicks));
                if (wait <= 0) break;
                Thread.Sleep((int)wait);
            }

            while (Signal.Wait(0)) { }

            TaskCompletionSource? tcs;
            lock (FlushSync)
            {
                tcs = _flushTcs;
                _flushTcs = null;
                _flushNow = false;
            }

            foreach (string key in Pending.Keys.ToArray())
            {
                if (!Pending.TryGetValue(key, out string? data)) continue;
                try
                {
                    lock (Sync)
                    {
                        if (data is null) DeleteFile(key);
                        else WriteFile(key, data);
                    }
                }
                catch (Exception ex)
                {
                    Logger.Error($"Falha gravando save '{key}'", ex);
                }
                // só remove se não foi sobrescrito durante a gravação
                Pending.TryRemove(new KeyValuePair<string, string?>(key, data));
            }

            tcs?.TrySetResult();
        }
    }

    private static void WriteFile(string key, string data)
    {
        Directory.CreateDirectory(SaveDirectory);
        string path = GetPath(key);
        string temp = path + ".tmp";
        string json = JsonSerializer.Serialize(new SaveEnvelope { Key = key, Data = data });

        File.WriteAllText(temp, json, Utf8NoBom);
        if (File.Exists(path))
            File.Replace(temp, path, path + ".bak");
        else
            File.Move(temp, path);
    }

    private static void DeleteFile(string key)
    {
        string path = GetPath(key);
        if (File.Exists(path)) File.Delete(path);
        if (File.Exists(path + ".bak")) File.Delete(path + ".bak");
    }

    private static bool TryReadFile(string path, out string? key, out string? data)
    {
        foreach (string candidate in new[] { path, path + ".bak" })
        {
            if (!File.Exists(candidate)) continue;
            try
            {
                var env = JsonSerializer.Deserialize<SaveEnvelope>(File.ReadAllText(candidate, Utf8NoBom));
                if (env?.Key is not null && env.Data is not null)
                {
                    key = env.Key;
                    data = env.Data;
                    return true;
                }
            }
            catch (JsonException ex)
            {
                Logger.Warn($"Save corrompido '{Path.GetFileName(candidate)}': {ex.Message}");
            }
        }

        key = data = null;
        return false;
    }

    private static bool IsHash(string name) =>
        name.Length == 64 && name.All(Uri.IsHexDigit);

    private static string GetPath(string key)
    {
        string hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant();
        return Path.Combine(SaveDirectory, hash + ".json");
    }

    private sealed class SaveEnvelope
    {
        [JsonPropertyName("key")] public string? Key { get; set; }
        [JsonPropertyName("data")] public string? Data { get; set; }
    }
}
