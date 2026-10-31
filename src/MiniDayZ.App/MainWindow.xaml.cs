using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace MiniDayZ.App;

public partial class MainWindow : Window
{
    /// <summary>
    /// Flags do Chromium: remove telemetria/tarefas de fundo e empurra rasterização para a GPU.
    /// </summary>
    private const string BrowserArguments =
        "--disable-features=Translate,OptimizationHints,MediaRouter " +
        "--disable-background-networking " +
        "--disable-extensions " +
        "--force-gpu-rasterization " +
        "--enable-zero-copy";

    /// <summary>Host virtual (TLD reservado .example — nunca colide com domínio real).</summary>
    private const string VirtualHost = "minidayz.example";

    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) => await InitializeAsync();
    }

    private async Task InitializeAsync()
    {
        try
        {
            var options = new CoreWebView2EnvironmentOptions
            {
                AdditionalBrowserArguments = BrowserArguments
            };

            // Perfil em %LOCALAPPDATA% (a pasta do executável pode não ser gravável, ex.: Program Files).
            string userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "MiniDayZ", "WebView2");

            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: userDataFolder,
                options: options);

            await WebView.EnsureCoreWebView2Async(environment);

            var core = WebView.CoreWebView2;
            ConfigureSettings(core.Settings);

            // Ponte IPC (JS -> C#)
            core.WebMessageReceived += OnWebMessageReceived;

            // Hidrata os saves do disco ANTES de qualquer script da página (getItem é síncrono no JS).
            string savesJson = JsonSerializer.Serialize(SaveSystem.LoadAll());
            await core.AddScriptToExecuteOnDocumentCreatedAsync($"window.__MDZ_SAVES__ = {savesJson};");

#if DEBUG
            await AttachConsoleLoggingAsync(core);
#endif

            string indexPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wwwroot", "index.html");
            Debug.WriteLine($"[MiniDayZ] Arquivo físico: {indexPath}");

            // O runtime do Construct 2 carrega data.js/áudio via XHR, que o Chromium bloqueia (CORS) em file://.
            // Mapeamos a MESMA pasta física para um host virtual HTTPS (resolvido localmente, sem rede/servidor).
            core.SetVirtualHostNameToFolderMapping(
                VirtualHost,
                Path.GetDirectoryName(indexPath)!,
                CoreWebView2HostResourceAccessKind.DenyCors);

            core.Navigate($"https://{VirtualHost}/{Path.GetFileName(indexPath)}");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(
                "O Microsoft Edge WebView2 Runtime não está instalado.\n" +
                "Baixe em: https://developer.microsoft.com/microsoft-edge/webview2/",
                "Mini DayZ", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
        }
    }

    /// <summary>
    /// Desliga recursos de "navegador" desnecessários para um jogo (menos UI, menos trabalho de fundo).
    /// </summary>
    private static void ConfigureSettings(CoreWebView2Settings s)
    {
        s.AreDefaultContextMenusEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;
        s.IsPinchZoomEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = false;
        s.IsBuiltInErrorPageEnabled = false;
        s.AreHostObjectsAllowed = false;
#if DEBUG
        s.AreDevToolsEnabled = true;
#else
        s.AreDevToolsEnabled = false;
#endif
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // Só aceita IPC vindo do próprio jogo (host virtual).
        if (!e.Source.StartsWith($"https://{VirtualHost}/", StringComparison.OrdinalIgnoreCase))
            return;

        string json = e.WebMessageAsJson;

        try
        {
            using var doc = JsonDocument.Parse(json);
            JsonElement root = doc.RootElement;

            if (root.ValueKind == JsonValueKind.String)
            {
                Debug.WriteLine($"[MiniDayZ IPC] {root.GetString()}");
                return;
            }

            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("action", out JsonElement actionEl) ||
                !root.TryGetProperty("key", out JsonElement keyEl) ||
                keyEl.ValueKind != JsonValueKind.String)
            {
                Debug.WriteLine($"[MiniDayZ IPC] Mensagem ignorada: {json}");
                return;
            }

            string action = actionEl.GetString() ?? string.Empty;
            string key = keyEl.GetString()!;

            switch (action)
            {
                case "save":
                    string data = root.TryGetProperty("data", out JsonElement dataEl) &&
                                  dataEl.ValueKind == JsonValueKind.String
                        ? dataEl.GetString()!
                        : string.Empty;
                    SaveSystem.Save(key, data);
                    Debug.WriteLine($"[MiniDayZ IPC] save '{key}' ({data.Length} chars)");
                    break;

                case "load":
                    string? result = SaveSystem.Load(key);
                    Debug.WriteLine($"[MiniDayZ IPC] load '{key}' ({(result is null ? "null" : $"{result.Length} chars")})");
                    _ = SendSaveLoadedAsync(key, result);
                    break;

                case "delete":
                    SaveSystem.Delete(key);
                    Debug.WriteLine($"[MiniDayZ IPC] delete '{key}'");
                    break;

                default:
                    Debug.WriteLine($"[MiniDayZ IPC] Ação desconhecida: {action}");
                    break;
            }
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or ArgumentException)
        {
            Debug.WriteLine($"[MiniDayZ IPC] Erro: {ex.Message}");
        }
    }

    private Task SendSaveLoadedAsync(string key, string? result)
    {
        // JsonSerializer gera literais JS seguros (escapa aspas, \, <, >, &, ', U+2028/2029).
        string keyJs = JsonSerializer.Serialize(key);
        string dataJs = result is null ? "null" : JsonSerializer.Serialize(result);

        return WebView.CoreWebView2.ExecuteScriptAsync(
            $"window.dispatchEvent(new CustomEvent('SaveLoaded', {{ detail: {{ key: {keyJs}, data: {dataJs} }} }}));");
    }

#if DEBUG
    /// <summary>
    /// (Somente DEBUG) Espelha console.* , erros de rede e exceções JS no Output do Visual Studio via CDP.
    /// </summary>
    private static async Task AttachConsoleLoggingAsync(CoreWebView2 core)
    {
        core.GetDevToolsProtocolEventReceiver("Log.entryAdded").DevToolsProtocolEventReceived +=
            (_, e) => Debug.WriteLine($"[MiniDayZ JS log] {e.ParameterObjectAsJson}");
        core.GetDevToolsProtocolEventReceiver("Runtime.consoleAPICalled").DevToolsProtocolEventReceived +=
            (_, e) => Debug.WriteLine($"[MiniDayZ JS console] {e.ParameterObjectAsJson}");
        core.GetDevToolsProtocolEventReceiver("Runtime.exceptionThrown").DevToolsProtocolEventReceived +=
            (_, e) => Debug.WriteLine($"[MiniDayZ JS exception] {e.ParameterObjectAsJson}");

        await core.CallDevToolsProtocolMethodAsync("Log.enable", "{}");
        await core.CallDevToolsProtocolMethodAsync("Runtime.enable", "{}");
    }
#endif
}
