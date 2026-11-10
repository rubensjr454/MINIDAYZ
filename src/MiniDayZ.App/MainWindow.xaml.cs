using System.ComponentModel;
using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using MiniDayZ.App.Companion;
using MiniDayZ.App.Controls;

namespace MiniDayZ.App;

public partial class MainWindow : Window
{
    private bool _isSafeToClose = false;
    private bool _isClosing = false;
    private bool _loggedFirstMapInit = false;
    private bool _loggedFirstTick = false;
    private readonly PcControlsManager _controls;
    private readonly CompanionServer _companion = new();

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
        _controls = new PcControlsManager(WebView);
        _companion.WaypointReceived += OnCompanionWaypointReceived;
        this.Closing += MainWindow_Closing;
        this.Closed += (_, _) => _companion.Dispose();
        this.Activated += (_, _) => WebView.Focus();
        this.PreviewKeyDown += (_, e) => _controls.TryHandlePreviewKeyDown(e);
        Loaded += async (_, _) => await InitializeAsync();
    }

    private async void MainWindow_Closing(object? sender, CancelEventArgs e)
    {
        if (_isSafeToClose) return;

        if (_isClosing)
        {
            e.Cancel = true;
            return;
        }

        _isClosing = true;

        if (WebView?.CoreWebView2 is null)
        {
            FinishClose();
            return;
        }

        e.Cancel = true;
        _ = ForceCloseAfterAsync(TimeSpan.FromSeconds(3));

        try
        {
            await WebView.CoreWebView2.ExecuteScriptAsync(
                "window.chrome.webview.postMessage(JSON.stringify({ action: 'save_on_close', data: JSON.stringify(localStorage) }));");
        }
        catch (Exception ex)
        {
            Logger.Error("Falha pedindo save_on_close", ex);
            FinishClose();
        }
    }

    private async Task ForceCloseAfterAsync(TimeSpan delay)
    {
        await Task.Delay(delay);
        if (_isSafeToClose) return;
        Logger.Warn("save_on_close sem resposta; forçando fechamento.");
        FinishClose();
    }

    private void FinishClose()
    {
        if (_isSafeToClose) return;
        _isSafeToClose = true;
        SaveSystem.Flush(TimeSpan.FromSeconds(2));
        Application.Current.Shutdown();
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
            core.NavigationCompleted += (_, _) => WebView.Focus();
            ConfigureNavigationGuards(core);

            // Hidrata os saves do disco e metadados do Companion ANTES de qualquer script da página.
            var saves = SaveSystem.LoadAll();
            string savesJson = JsonSerializer.Serialize(saves);
            string companionJson = CompanionStateJson();
            string firstBoot = saves.Count == 0 ? "true" : "false";
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                $"window.__MDZ_SAVES__ = {savesJson}; window.__MDZ_FIRST_BOOT__ = {firstBoot}; window.__MDZ_COMPANION__ = {companionJson};");

#if DEBUG
            await AttachConsoleLoggingAsync(core);
#endif

            string indexPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wwwroot", "index.html");
            Logger.Info($"Arquivo físico: {indexPath}");

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
        catch (Exception ex)
        {
            Logger.Error("Falha na inicialização", ex);
            MessageBox.Show(
                "Não foi possível iniciar o jogo.\n" +
                "Detalhes em %LOCALAPPDATA%\\MiniDayZ\\logs\\app.log",
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
                string strMsg = root.GetString() ?? string.Empty;
                if (strMsg.StartsWith('{'))
                {
                    using var innerDoc = JsonDocument.Parse(strMsg);
                    HandleMessageObject(innerDoc.RootElement);
                    return;
                }

                Logger.Info($"[IPC] {strMsg}");
                return;
            }

            if (root.ValueKind == JsonValueKind.Object)
            {
                HandleMessageObject(root);
                return;
            }

            Logger.Warn($"[IPC] Mensagem ignorada: {json}");
        }
        catch (Exception ex)
        {
            Logger.Error("[IPC] Erro", ex);
        }
    }

    private void HandleMessageObject(JsonElement root)
    {
        if (!root.TryGetProperty("action", out JsonElement actionEl) ||
            actionEl.ValueKind != JsonValueKind.String)
        {
            return;
        }

        string action = actionEl.GetString() ?? string.Empty;

        if (_controls.TryHandleWebMessage(root, action))
        {
            return;
        }

        if (action == "companion_start" || action == "companion_stop")
        {
            _ = SetCompanionRunningAsync(action == "companion_start");
            return;
        }

        if (action == "companion_map_init")
        {
            if (root.TryGetProperty("payload", out JsonElement mapEl))
            {
                string rawMap = mapEl.GetRawText();
                _companion.UpdateMapInit(rawMap);

                if (!_loggedFirstMapInit)
                {
                    _loggedFirstMapInit = true;
                    Logger.Info($"[Companion IPC] Primeiro companion_map_init recebido no C# ({rawMap.Length} chars).");
                }
            }
            return;
        }

        if (action == "companion_map_delta")
        {
            if (root.TryGetProperty("payload", out JsonElement deltaEl))
            {
                _companion.UpdateMapDelta(deltaEl.GetRawText());
            }
            return;
        }

        if (action == "companion_tick")
        {
            if (root.TryGetProperty("payload", out JsonElement tickEl))
            {
                string rawTick = tickEl.GetRawText();
                _companion.UpdateTick(rawTick);

                if (!_loggedFirstTick)
                {
                    _loggedFirstTick = true;
                    Logger.Info($"[Companion IPC] Primeiro companion_tick recebido no C# ({rawTick.Length} chars).");
                }
            }
            return;
        }

        if (action == "save_on_close")
        {
            try
            {
                if (root.TryGetProperty("data", out JsonElement closeDataEl))
                {
                    if (closeDataEl.ValueKind == JsonValueKind.String)
                    {
                        string rawStorage = closeDataEl.GetString() ?? string.Empty;
                        if (!string.IsNullOrEmpty(rawStorage))
                        {
                            using var storageDoc = JsonDocument.Parse(rawStorage);
                            SaveAllProps(storageDoc.RootElement);
                        }
                    }
                    else
                    {
                        SaveAllProps(closeDataEl);
                    }
                }
            }
            catch (Exception ex)
            {
                Logger.Error("save_on_close", ex);
            }
            finally
            {
                Logger.Info("save_on_close concluído.");
                FinishClose();
            }
            return;
        }

        if (!root.TryGetProperty("key", out JsonElement keyEl) ||
            keyEl.ValueKind != JsonValueKind.String)
        {
            return;
        }

        string key = keyEl.GetString()!;
        if (key.Length == 0) return;

        switch (action)
        {
            case "save":
                string data = root.TryGetProperty("data", out JsonElement dataEl) &&
                              dataEl.ValueKind == JsonValueKind.String
                    ? dataEl.GetString()!
                    : string.Empty;
                SaveSystem.Save(key, data);
                break;

            case "load":
                _ = SendSaveLoadedAsync(key, SaveSystem.Load(key));
                break;

            case "delete":
                SaveSystem.Delete(key);
                break;

            default:
                Logger.Warn($"[IPC] Ação desconhecida: {action}");
                break;
        }
    }

    private string CompanionStateJson() => JsonSerializer.Serialize(new
    {
        url = _companion.Url,
        ip = _companion.HostIp,
        port = _companion.Port,
        isRunning = _companion.IsRunning,
        isLocalhostFallback = _companion.IsLocalhostFallback
    });

    private async Task SetCompanionRunningAsync(bool run)
    {
        try
        {
            await Task.Run(() => { if (run) _companion.Start(); else _companion.Stop(); });
            if (WebView?.CoreWebView2 is null) return;
            await WebView.CoreWebView2.ExecuteScriptAsync(
                $"window.__MDZ_COMPANION__ = {CompanionStateJson()}; window.dispatchEvent(new CustomEvent('CompanionState', {{ detail: window.__MDZ_COMPANION__ }}));");
        }
        catch (Exception ex)
        {
            Logger.Error("Falha alternando Companion", ex);
        }
    }

    private static readonly string[] OpenExternalHosts =
        { "minidayz.com", "www.minidayz.com", "store.bistudio.com" };

    private static bool IsAllowedExternalUrl(Uri uri)
    {
        if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) return false;

        string host = uri.Host.ToLowerInvariant();
        if (OpenExternalHosts.Contains(host)) return true;

        if (host is "facebook.com" or "www.facebook.com")
            return uri.AbsolutePath.StartsWith("/MINIDAYZGAME", StringComparison.OrdinalIgnoreCase);

        if (host is "vk.com" or "www.vk.com")
            return uri.AbsolutePath.StartsWith("/mini_dayz", StringComparison.OrdinalIgnoreCase);

        return false;
    }

    private static void ConfigureNavigationGuards(CoreWebView2 core)
    {
        string origin = $"https://{VirtualHost}/";

        core.NavigationStarting += (_, e) =>
        {
            if (!e.Uri.StartsWith(origin, StringComparison.OrdinalIgnoreCase) &&
                !e.Uri.StartsWith("about:blank", StringComparison.OrdinalIgnoreCase))
            {
                e.Cancel = true;
            }
        };

        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out Uri? uri) && IsAllowedExternalUrl(uri))
            {
                try
                {
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
                }
                catch (Exception ex)
                {
                    Logger.Warn($"Falha abrindo link externo: {ex.Message}");
                }
            }
        };

        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, e) =>
        {
            if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out Uri? uri)) return;
            if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) return;

            string host = uri.Host.ToLowerInvariant();
            if (host == VirtualHost || host == "account.bistudio.com") return;

            e.Response = core.Environment.CreateWebResourceResponse(null, 403, "Blocked", string.Empty);
        };
    }

    private static void SaveAllProps(JsonElement obj)
    {
        if (obj.ValueKind != JsonValueKind.Object) return;

        foreach (JsonProperty prop in obj.EnumerateObject())
        {
            try
            {
                string val = prop.Value.ValueKind == JsonValueKind.String
                    ? prop.Value.GetString()!
                    : prop.Value.GetRawText();
                SaveSystem.Save(prop.Name, val);
            }
            catch (Exception ex)
            {
                Logger.Error($"save_on_close: falha na chave '{prop.Name}'", ex);
            }
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

    private void OnCompanionWaypointReceived(string normalizedWaypointJson)
    {
        _ = Dispatcher.InvokeAsync(async () =>
        {
            if (WebView?.CoreWebView2 is null) return;
            try
            {
                await WebView.CoreWebView2.ExecuteScriptAsync(
                    $"window.dispatchEvent(new CustomEvent('CompanionWaypoint', {{ detail: {normalizedWaypointJson} }}));");
            }
            catch (Exception ex)
            {
                Logger.Warn($"[Companion] Erro ao injetar Waypoint no WebView2: {ex.Message}");
            }
        });
    }

#if DEBUG
    /// <summary>
    /// (Somente DEBUG) Espelha console.* , erros de rede e exceções JS no Output do Visual Studio via CDP.
    /// </summary>
    private static async Task AttachConsoleLoggingAsync(CoreWebView2 core)
    {
        core.GetDevToolsProtocolEventReceiver("Log.entryAdded").DevToolsProtocolEventReceived +=
            (_, e) => Logger.Info($"[JS log] {e.ParameterObjectAsJson}");
        core.GetDevToolsProtocolEventReceiver("Runtime.consoleAPICalled").DevToolsProtocolEventReceived +=
            (_, e) => Logger.Info($"[JS console] {e.ParameterObjectAsJson}");
        core.GetDevToolsProtocolEventReceiver("Runtime.exceptionThrown").DevToolsProtocolEventReceived +=
            (_, e) => Logger.Error($"[JS exception] {e.ParameterObjectAsJson}");

        await core.CallDevToolsProtocolMethodAsync("Log.enable", "{}");
        await core.CallDevToolsProtocolMethodAsync("Runtime.enable", "{}");
    }
#endif
}
