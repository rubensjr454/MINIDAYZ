using System.Diagnostics;
using System.Text.Json;
using System.Windows.Input;
using Microsoft.Web.WebView2.Wpf;

namespace MiniDayZ.App.Controls;

/// <summary>
/// Módulo isolado de Controles PC: gerencia foco de atalhos no WPF,
/// logs de coordenadas atingidas e injeção nativa de toque via Chrome DevTools Protocol (CDP).
/// </summary>
public sealed class PcControlsManager
{
    private readonly WebView2 _webView;

    public PcControlsManager(WebView2 webView)
    {
        _webView = webView;
    }

    /// <summary>
    /// Encaminha teclas de atalho caso o foco ainda esteja na janela WPF externa (antes do primeiro clique no canvas).
    /// </summary>
    public bool TryHandlePreviewKeyDown(KeyEventArgs e)
    {
        if (_webView.IsKeyboardFocusWithin || _webView.CoreWebView2 is null)
            return false;

        Key actualKey = e.Key == Key.System ? e.SystemKey : e.Key;

        string? mapped = actualKey switch
        {
            Key.E => "e",
            Key.Tab => "tab",
            Key.F => "f",
            Key.Q => "q",
            Key.R => "r",
            Key.F1 => "f1",
            Key.D1 or Key.NumPad1 => "1",
            Key.D2 or Key.NumPad2 => "2",
            Key.D3 or Key.NumPad3 => "3",
            Key.D4 or Key.NumPad4 => "4",
            Key.D5 or Key.NumPad5 => "5",
            _ => null
        };

        if (mapped is null)
            return false;

        e.Handled = true;
        _webView.Focus();
        _ = _webView.CoreWebView2.ExecuteScriptAsync(
            $"window.MDZControls && window.MDZControls.triggerKey('{mapped}');");
        return true;
    }

    /// <summary>
    /// Processa mensagens IPC de clique nativo vindas de wwwroot/controls/pc-controls.js.
    /// </summary>
    public bool TryHandleWebMessage(JsonElement root, string action)
    {
        if (action != "native_click")
            return false;

        string keyName = root.TryGetProperty("key", out JsonElement kEl) && kEl.ValueKind == JsonValueKind.String
            ? kEl.GetString()!
            : "?";
        string targetName = root.TryGetProperty("target", out JsonElement tEl) && tEl.ValueKind == JsonValueKind.String
            ? tEl.GetString()!
            : "canvas";
        bool isPixelMode = root.TryGetProperty("mode", out JsonElement mEl) &&
                           mEl.ValueKind == JsonValueKind.String &&
                           string.Equals(mEl.GetString(), "px", StringComparison.OrdinalIgnoreCase);

        if (root.TryGetProperty("x", out JsonElement xEl) && xEl.ValueKind == JsonValueKind.Number &&
            root.TryGetProperty("y", out JsonElement yEl) && yEl.ValueKind == JsonValueKind.Number)
        {
            _ = DispatchNativeClickAsync(keyName, targetName, isPixelMode, xEl.GetDouble(), yEl.GetDouble());
        }

        return true;
    }

    private async Task DispatchNativeClickAsync(
        string keyName,
        string targetName,
        bool isPixelMode,
        double rawX,
        double rawY)
    {
        var core = _webView.CoreWebView2;
        if (core is null)
            return;

        double w = Math.Max(1.0, _webView.ActualWidth);
        double h = Math.Max(1.0, _webView.ActualHeight);

        double x = isPixelMode
            ? Math.Clamp(Math.Round(rawX), 0.0, w - 1.0)
            : Math.Round(w * Math.Clamp(rawX, 0.0, 1.0));
        double y = isPixelMode
            ? Math.Clamp(Math.Round(rawY), 0.0, h - 1.0)
            : Math.Round(h * Math.Clamp(rawY, 0.0, 1.0));

        Log($"[MiniDayZ KEYBIND] Tecla='{keyName.ToUpperInvariant()}' | Alvo='{targetName}' | Viewport={w:0}x{h:0} | Coordenada atingida: X={x:0}, Y={y:0}");

        try
        {
            string touchStartPayload = JsonSerializer.Serialize(new
            {
                type = "touchStart",
                touchPoints = new[]
                {
                    new { x, y, radiusX = 2, radiusY = 2, force = 1.0, id = 7 }
                }
            });
            string touchEndPayload = JsonSerializer.Serialize(new
            {
                type = "touchEnd",
                touchPoints = Array.Empty<object>()
            });

            await core.CallDevToolsProtocolMethodAsync("Input.dispatchTouchEvent", touchStartPayload);
            await Task.Delay(50);
            await core.CallDevToolsProtocolMethodAsync("Input.dispatchTouchEvent", touchEndPayload);
        }
        catch (Exception)
        {
            string MousePayload(string type, int buttons) => JsonSerializer.Serialize(new
            {
                type,
                x,
                y,
                button = type == "mouseMoved" ? "none" : "left",
                buttons,
                clickCount = type == "mouseMoved" ? 0 : 1,
                pointerType = "mouse"
            });

            try
            {
                await core.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", MousePayload("mouseMoved", 0));
                await core.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", MousePayload("mousePressed", 1));
                await Task.Delay(50);
                await core.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", MousePayload("mouseReleased", 0));
            }
            catch (Exception ex)
            {
                Log($"[MiniDayZ KEYBIND] Falha no CDP em X={x:0}, Y={y:0}: {ex.Message}");
            }
        }
    }

    private static void Log(string message)
    {
        Debug.WriteLine(message);
        Console.WriteLine(message);
    }
}

