using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace MiniDayZ.App.Companion;

/// <summary>
/// Servidor LAN ultraleve (.NET 8 TcpListener HTTP/1.1 + Server-Sent Events) para o Radar Tático Mobile / 2º Monitor.
/// Não exige privilégios de Administrador (sem URLACL do HTTP.sys), roda 100% fora da UI Thread
/// e transmite telemetria 1Hz + sincronização reversa de Waypoint com custo mínimo de CPU/RAM.
/// </summary>
public sealed class CompanionServer : IDisposable
{
    private const int PreferredPort = 8080;
    private const int MaxPortAttempts = 10;

    private readonly CancellationTokenSource _cts = new();
    private readonly ConcurrentDictionary<int, SseClient> _sseClients = new();
    private readonly ConcurrentDictionary<string, byte[]> _imageCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly string _imagesDir;
    private readonly byte[] _radarHtmlBytes;

    private TcpListener? _listener;
    private PeriodicTimer? _keepAliveTimer;
    private int _nextClientId;

    private volatile string _latestMapInitJson = "null";
    private volatile string _latestTickJson = "null";
    private volatile string _latestWaypointJson = "null";
    private readonly List<string> _mapDeltas = new();
    private readonly object _deltaLock = new();

    public string HostIp { get; private set; } = "127.0.0.1";
    public int Port { get; private set; } = PreferredPort;
    public bool IsRunning { get; private set; }
    public bool IsLocalhostFallback { get; private set; }
    public string Url => $"http://{HostIp}:{Port}";

    /// <summary>
    /// Disparado quando o usuário marca ou limpa um Waypoint tocando na tela do celular.
    /// Recebe JSON compacto: {"x":1234,"y":5678} ou {"clear":true}.
    /// </summary>
    public event Action<string>? WaypointReceived;

    public CompanionServer()
    {
        _imagesDir = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wwwroot", "images"));
        string htmlPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wwwroot", "companion", "mobile-radar.html");
        if (File.Exists(htmlPath))
        {
            _radarHtmlBytes = File.ReadAllBytes(htmlPath);
        }
        else
        {
            _radarHtmlBytes = Encoding.UTF8.GetBytes("<!DOCTYPE html><html><body style='background:#111;color:#eee;font-family:monospace'>Radar Mobile nao encontrado em wwwroot/companion/mobile-radar.html</body></html>");
        }
    }

    public void Start()
    {
        if (IsRunning) return;

        string detectedLanIp = DiscoverLanIp();

        // Tenta escutar em todas as interfaces (LAN Wi-Fi + localhost) nas portas 8080..8089
        if (TryBindListener(IPAddress.Any, out int boundPort))
        {
            HostIp = detectedLanIp;
            Port = boundPort;
            IsLocalhostFallback = detectedLanIp == "127.0.0.1";
            IsRunning = true;
        }
        else if (TryBindListener(IPAddress.Loopback, out boundPort))
        {
            HostIp = "127.0.0.1";
            Port = boundPort;
            IsLocalhostFallback = true;
            IsRunning = true;
        }
        else
        {
            Debug.WriteLine("[MiniDayZ Companion] Falha ao iniciar servidor LAN/localhost.");
            return;
        }

        Debug.WriteLine($"[MiniDayZ Companion] Radar Tático LAN ativo em {Url} (FallbackLocalhost={IsLocalhostFallback})");

        _ = Task.Run(() => AcceptLoopAsync(_cts.Token));
        _ = Task.Run(() => KeepAliveLoopAsync(_cts.Token));
    }

    public void UpdateMapInit(string rawPayloadJson)
    {
        if (string.IsNullOrWhiteSpace(rawPayloadJson)) return;
        lock (_deltaLock)
        {
            _mapDeltas.Clear();
        }
        _latestMapInitJson = rawPayloadJson;
        BroadcastSse("map_init", rawPayloadJson);
    }

    public void UpdateMapDelta(string rawDeltaJson)
    {
        if (string.IsNullOrWhiteSpace(rawDeltaJson)) return;
        lock (_deltaLock)
        {
            if (_mapDeltas.Count < 512)
            {
                _mapDeltas.Add(rawDeltaJson);
            }
        }
        BroadcastSse("map_delta", rawDeltaJson);
    }

    public void UpdateTick(string rawPayloadJson)
    {
        if (string.IsNullOrWhiteSpace(rawPayloadJson)) return;
        if (rawPayloadJson.Contains("\"resetMap\":true", StringComparison.OrdinalIgnoreCase))
        {
            lock (_deltaLock)
            {
                _mapDeltas.Clear();
            }
        }
        _latestTickJson = rawPayloadJson;
        BroadcastSse("tick", rawPayloadJson);
    }

    private bool TryBindListener(IPAddress bindAddress, out int boundPort)
    {
        for (int offset = 0; offset < MaxPortAttempts; offset++)
        {
            int candidatePort = PreferredPort + offset;
            TcpListener? candidate = null;
            try
            {
                candidate = new TcpListener(bindAddress, candidatePort);
                candidate.Server.ExclusiveAddressUse = false;
                candidate.Start(backlog: 16);
                _listener = candidate;
                boundPort = candidatePort;
                return true;
            }
            catch (SocketException)
            {
                try { candidate?.Stop(); } catch { }
            }
        }

        boundPort = PreferredPort;
        return false;
    }

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && _listener is not null)
        {
            try
            {
                TcpClient client = await _listener.AcceptTcpClientAsync(ct).ConfigureAwait(false);
                client.NoDelay = true;
                _ = Task.Run(() => HandleClientAsync(client, ct), CancellationToken.None);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[MiniDayZ Companion] Accept erro: {ex.Message}");
            }
        }
    }

    private async Task HandleClientAsync(TcpClient client, CancellationToken ct)
    {
        bool keepOpenForSse = false;
        NetworkStream? stream = null;

        try
        {
            stream = client.GetStream();
            using var ctsTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            ctsTimeout.CancelAfter(TimeSpan.FromSeconds(5));

            (string method, string path, int contentLength, string bodyPreview) =
                await ReadHttpRequestAsync(stream, ctsTimeout.Token).ConfigureAwait(false);

            if (string.IsNullOrEmpty(method))
            {
                return;
            }

            if (method == "GET" && (path == "/" || path.StartsWith("/?", StringComparison.Ordinal) || path == "/index.html"))
            {
                byte[] htmlBytes = GetPatchedRadarHtml();
                await WriteHttpResponseAsync(stream, "200 OK", "text/html; charset=utf-8", htmlBytes, ct).ConfigureAwait(false);
                return;
            }

            if (method == "GET" && path.StartsWith("/state", StringComparison.Ordinal))
            {
                string deltasJson;
                lock (_deltaLock)
                {
                    deltasJson = _mapDeltas.Count > 0 ? "[" + string.Join(",", _mapDeltas) + "]" : "[]";
                }
                string stateJson = $"{{\"map\":{_latestMapInitJson},\"deltas\":{deltasJson},\"tick\":{_latestTickJson},\"waypoint\":{_latestWaypointJson}}}";
                byte[] stateBytes = Encoding.UTF8.GetBytes(stateJson);
                await WriteHttpResponseAsync(stream, "200 OK", "application/json; charset=utf-8", stateBytes, ct).ConfigureAwait(false);
                return;
            }

            if (method == "GET" && path.StartsWith("/events", StringComparison.Ordinal))
            {
                keepOpenForSse = true;
                await HandleSseStreamAsync(client, stream, ct).ConfigureAwait(false);
                return;
            }

            if (method == "OPTIONS" && path.StartsWith("/waypoint", StringComparison.Ordinal))
            {
                await WriteHttpResponseAsync(stream, "204 No Content", "text/plain", Array.Empty<byte>(), ct).ConfigureAwait(false);
                return;
            }

            if (method == "POST" && path.StartsWith("/waypoint", StringComparison.Ordinal))
            {
                string wpResponse = HandleWaypointPost(bodyPreview);
                byte[] respBytes = Encoding.UTF8.GetBytes(wpResponse);
                await WriteHttpResponseAsync(stream, "200 OK", "application/json; charset=utf-8", respBytes, ct).ConfigureAwait(false);
                return;
            }

            if (method == "GET" && path.StartsWith("/images/", StringComparison.OrdinalIgnoreCase))
            {
                await HandleStaticImageRequestAsync(stream, path, ct).ConfigureAwait(false);
                return;
            }

            if (method == "GET" && path == "/favicon.ico")
            {
                await WriteHttpResponseAsync(stream, "204 No Content", "image/x-icon", Array.Empty<byte>(), ct).ConfigureAwait(false);
                return;
            }

            byte[] notFound = Encoding.UTF8.GetBytes("Not Found");
            await WriteHttpResponseAsync(stream, "404 Not Found", "text/plain; charset=utf-8", notFound, ct).ConfigureAwait(false);
        }
        catch
        {
            // Conexões móveis abortadas são silenciosamente recicladas
        }
        finally
        {
            if (!keepOpenForSse)
            {
                try { stream?.Dispose(); } catch { }
                try { client.Dispose(); } catch { }
            }
        }
    }

    private static async Task<(string Method, string Path, int ContentLength, string Body)> ReadHttpRequestAsync(
        NetworkStream stream, CancellationToken ct)
    {
        byte[] buffer = new byte[4096];
        int totalRead = 0;
        int headerEnd = -1;

        while (totalRead < buffer.Length)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(totalRead, buffer.Length - totalRead), ct).ConfigureAwait(false);
            if (read <= 0) break;
            totalRead += read;

            headerEnd = FindHeaderEnd(buffer, totalRead);
            if (headerEnd >= 0) break;
        }

        if (headerEnd < 0 || totalRead == 0)
        {
            return (string.Empty, string.Empty, 0, string.Empty);
        }

        string headerText = Encoding.ASCII.GetString(buffer, 0, headerEnd);
        string[] lines = headerText.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length == 0)
        {
            return (string.Empty, string.Empty, 0, string.Empty);
        }

        string[] firstLine = lines[0].Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (firstLine.Length < 2)
        {
            return (string.Empty, string.Empty, 0, string.Empty);
        }

        string method = firstLine[0].ToUpperInvariant();
        string path = firstLine[1];
        int contentLength = 0;

        for (int i = 1; i < lines.Length; i++)
        {
            if (lines[i].StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
            {
                _ = int.TryParse(lines[i].AsSpan("Content-Length:".Length).Trim(), out contentLength);
                break;
            }
        }

        contentLength = Math.Clamp(contentLength, 0, 2048);
        int bodyStart = headerEnd + 4;
        int alreadyHave = Math.Max(0, totalRead - bodyStart);

        byte[] bodyBytes = new byte[contentLength];
        if (alreadyHave > 0 && contentLength > 0)
        {
            Array.Copy(buffer, bodyStart, bodyBytes, 0, Math.Min(alreadyHave, contentLength));
        }

        int bodyPos = Math.Min(alreadyHave, contentLength);
        while (bodyPos < contentLength)
        {
            int r = await stream.ReadAsync(bodyBytes.AsMemory(bodyPos, contentLength - bodyPos), ct).ConfigureAwait(false);
            if (r <= 0) break;
            bodyPos += r;
        }

        string body = contentLength > 0 ? Encoding.UTF8.GetString(bodyBytes, 0, bodyPos) : string.Empty;
        return (method, path, contentLength, body);
    }

    private static int FindHeaderEnd(byte[] buf, int len)
    {
        for (int i = 0; i <= len - 4; i++)
        {
            if (buf[i] == '\r' && buf[i + 1] == '\n' && buf[i + 2] == '\r' && buf[i + 3] == '\n')
            {
                return i;
            }
        }
        return -1;
    }

    private async Task HandleStaticImageRequestAsync(NetworkStream stream, string rawPath, CancellationToken ct)
    {
        int qIdx = rawPath.IndexOf('?');
        string cleanPath = qIdx >= 0 ? rawPath[..qIdx] : rawPath;
        string rawName = Uri.UnescapeDataString(cleanPath["/images/".Length..]);
        string safeFile = Path.GetFileName(rawName);

        if (string.IsNullOrWhiteSpace(safeFile) || !string.Equals(safeFile, rawName, StringComparison.Ordinal))
        {
            await WriteHttpResponseAsync(stream, "400 Bad Request", "text/plain; charset=utf-8", Array.Empty<byte>(), ct).ConfigureAwait(false);
            return;
        }

        string ext = Path.GetExtension(safeFile).ToLowerInvariant();
        string? mime = ext switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            _ => null
        };

        if (mime is null)
        {
            await WriteHttpResponseAsync(stream, "404 Not Found", "text/plain; charset=utf-8", Array.Empty<byte>(), ct).ConfigureAwait(false);
            return;
        }

        if (!_imageCache.TryGetValue(safeFile, out byte[]? imgBytes))
        {
            string fullPath = Path.GetFullPath(Path.Combine(_imagesDir, safeFile));
            if (!fullPath.StartsWith(_imagesDir, StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))
            {
                await WriteHttpResponseAsync(stream, "404 Not Found", "text/plain; charset=utf-8", Array.Empty<byte>(), ct).ConfigureAwait(false);
                return;
            }

            imgBytes = await File.ReadAllBytesAsync(fullPath, ct).ConfigureAwait(false);
            _imageCache.TryAdd(safeFile, imgBytes);
        }

        await WriteHttpResponseAsync(
            stream, "200 OK", mime, imgBytes, ct,
            cacheControl: "public, max-age=86400, immutable").ConfigureAwait(false);
    }

    private static async Task WriteHttpResponseAsync(
        NetworkStream stream, string status, string contentType, byte[] body, CancellationToken ct,
        string cacheControl = "no-store, no-cache")
    {
        string header =
            $"HTTP/1.1 {status}\r\n" +
            $"Content-Type: {contentType}\r\n" +
            $"Content-Length: {body.Length}\r\n" +
            $"Cache-Control: {cacheControl}\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: Content-Type\r\n" +
            "Connection: close\r\n\r\n";

        byte[] headerBytes = Encoding.ASCII.GetBytes(header);
        await stream.WriteAsync(headerBytes, ct).ConfigureAwait(false);
        if (body.Length > 0)
        {
            await stream.WriteAsync(body, ct).ConfigureAwait(false);
        }
        await stream.FlushAsync(ct).ConfigureAwait(false);
    }

    private byte[] GetPatchedRadarHtml()
    {
        string? html = null;
        string primaryPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wwwroot", "companion", "mobile-radar.html");
        string altPath = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "src", "MiniDayZ.App", "wwwroot", "companion", "mobile-radar.html"));

        if (File.Exists(primaryPath))
        {
            try { html = File.ReadAllText(primaryPath, Encoding.UTF8); } catch { }
        }
        else if (File.Exists(altPath))
        {
            try { html = File.ReadAllText(altPath, Encoding.UTF8); } catch { }
        }

        if (string.IsNullOrEmpty(html) && _radarHtmlBytes.Length > 0)
        {
            html = Encoding.UTF8.GetString(_radarHtmlBytes);
        }

        if (string.IsNullOrEmpty(html))
        {
            return _radarHtmlBytes;
        }

        // Normaliza line endings para garantir match determinístico
        html = html.Replace("\r\n", "\n");

        // PASSO 1: Cabeçalho superior com islandLevel dinâmico (ILHA 2, ILHA 3, etc.)
        html = html.Replace(
            "var isl = mapData ? (mapData.island === 0 ? 'TUTORIAL' : ('ILHA ' + mapData.island)) : 'EM JOGO';",
            "var islNum = (tickData && (tickData.islandLevel || tickData.island)) || (mapData && (mapData.islandLevel || mapData.island)) || 1;\n    var isl = islNum === 0 ? 'TUTORIAL' : ('ILHA ' + islNum);",
            StringComparison.Ordinal);

        // PASSO 1: Fim da sobreposição na troca de ilha - Limpa offscreen canvas e landmarks anteriores
        html = html.Replace(
            "tileSliceCache = {};\n    buildLandmarksIndex(data);\n    ensureMapTextures(data);\n    bakeStaticMap();",
            "if (typeof staticCtx !== 'undefined' && staticCtx && typeof staticLayer !== 'undefined' && staticLayer) {\n      staticCtx.clearRect(0, 0, staticLayer.width, staticLayer.height);\n    }\n    landmarks = [];\n    tileSliceCache = {};\n    buildLandmarksIndex(data);\n    ensureMapTextures(data);\n    bakeStaticMap();",
            StringComparison.Ordinal);

        // PASSO 1: Garante clearRect dentro de bakeStaticMap()
        html = html.Replace(
            "resizeSurface(staticLayer, sw, sh);\n\n    staticCtx.save();",
            "resizeSurface(staticLayer, sw, sh);\n    staticCtx.clearRect(0, 0, staticLayer.width, staticLayer.height);\n\n    staticCtx.save();",
            StringComparison.Ordinal);

        // PASSO 3: Rastreamento de Alvo da Missão (quest_target) no topo das camadas
        if (!html.Contains("quest_target", StringComparison.OrdinalIgnoreCase))
        {
            string targetMarkerCode = @"
      // C) Alvo Fixo da Missão (Bandidos, Maleta, Crate, Boss)
      var qTgt = (typeof tickData !== 'undefined' && tickData && tickData.quest && tickData.quest.target) || (typeof tickData !== 'undefined' && tickData && tickData.quest_target);
      if (qTgt && typeof qTgt.x === 'number' && typeof qTgt.y === 'number') {
        var tgts = worldToScreen(qTgt.x, qTgt.y);
        ctx.beginPath();
        ctx.arc(tgts.x, tgts.y, 14 + pulse * 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 82, 82, 0.95)';
        ctx.lineWidth = 2.4;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(tgts.x, tgts.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#ff5252';
        ctx.fill();
        ctx.strokeStyle = '#ffd54f';
        ctx.lineWidth = 2;
        ctx.stroke();

        if (typeof tickData !== 'undefined' && tickData && tickData.player) {
          var pScr = worldToScreen(tickData.player.x, tickData.player.y);
          ctx.beginPath();
          ctx.moveTo(pScr.x, pScr.y);
          ctx.lineTo(tgts.x, tgts.y);
          ctx.strokeStyle = 'rgba(255, 82, 82, 0.85)';
          ctx.setLineDash([8, 6]);
          ctx.lineWidth = 2.2;
          ctx.stroke();
          ctx.setLineDash([]);
        }

        var tgtLabel = '🎯 ' + (qTgt.label || 'Alvo da Missão');
        registerInteractive(qTgt.x, qTgt.y, tgts.x, tgts.y, tgtLabel, '#ff5252', '🎯', 0);
        labelQueue.push({ sx: tgts.x, sy: tgts.y, text: tgtLabel, color: '#ff5252', prio: 0, force: true });
      }";

            html = html.Replace(
                "// 6. Waypoint Tático Sincronizado com o PC",
                targetMarkerCode + "\n\n    // 6. Waypoint Tático Sincronizado com o PC",
                StringComparison.Ordinal);
        }

        return Encoding.UTF8.GetBytes(html);
    }

    private async Task HandleSseStreamAsync(TcpClient client, NetworkStream stream, CancellationToken ct)
    {
        int id = Interlocked.Increment(ref _nextClientId);
        var sseClient = new SseClient(id, client, stream);

        try
        {
            byte[] sseHeaders = Encoding.ASCII.GetBytes(
                "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/event-stream; charset=utf-8\r\n" +
                "Cache-Control: no-cache, no-transform\r\n" +
                "Connection: keep-alive\r\n" +
                "X-Accel-Buffering: no\r\n" +
                "Access-Control-Allow-Origin: *\r\n\r\n" +
                "retry: 1500\n\n");

            await sseClient.SendRawAsync(sseHeaders, ct).ConfigureAwait(false);

            if (_latestMapInitJson != "null")
            {
                await sseClient.SendRawAsync(FormatSseFrame("map_init", _latestMapInitJson), ct).ConfigureAwait(false);
            }
            if (_latestTickJson != "null")
            {
                await sseClient.SendRawAsync(FormatSseFrame("tick", _latestTickJson), ct).ConfigureAwait(false);
            }
            if (_latestWaypointJson != "null")
            {
                await sseClient.SendRawAsync(FormatSseFrame("waypoint", _latestWaypointJson), ct).ConfigureAwait(false);
            }

            _sseClients[id] = sseClient;

            // Aguarda encerramento pelo navegador cliente ou shutdown do servidor
            byte[] probe = new byte[16];
            while (!ct.IsCancellationRequested)
            {
                int read = await stream.ReadAsync(probe, ct).ConfigureAwait(false);
                if (read <= 0) break;
            }
        }
        catch
        {
            // Cliente desconectou normalmente
        }
        finally
        {
            _sseClients.TryRemove(id, out _);
            sseClient.Dispose();
        }
    }

    private string HandleWaypointPost(string rawBody)
    {
        if (string.IsNullOrWhiteSpace(rawBody))
        {
            return "{\"ok\":false}";
        }

        using var doc = JsonDocument.Parse(rawBody);
        JsonElement root = doc.RootElement;

        string normalized;
        if (root.TryGetProperty("clear", out JsonElement clearEl) && clearEl.ValueKind == JsonValueKind.True)
        {
            normalized = "{\"clear\":true}";
            _latestWaypointJson = "null";
        }
        else if (root.TryGetProperty("x", out JsonElement xEl) && xEl.TryGetDouble(out double wx) &&
                 root.TryGetProperty("y", out JsonElement yEl) && yEl.TryGetDouble(out double wy))
        {
            int rx = (int)Math.Round(wx);
            int ry = (int)Math.Round(wy);
            normalized = $"{{\"x\":{rx},\"y\":{ry}}}";
            _latestWaypointJson = normalized;
        }
        else
        {
            return "{\"ok\":false}";
        }

        BroadcastSse("waypoint", normalized);
        WaypointReceived?.Invoke(normalized);
        Debug.WriteLine($"[MiniDayZ Companion] Waypoint sincronizado do celular: {normalized}");
        return "{\"ok\":true}";
    }

    private void BroadcastSse(string eventName, string rawJson)
    {
        if (_sseClients.IsEmpty) return;

        byte[] frame = FormatSseFrame(eventName, rawJson);
        foreach (KeyValuePair<int, SseClient> kv in _sseClients)
        {
            _ = PushToClientAsync(kv.Key, kv.Value, frame);
        }
    }

    private async Task PushToClientAsync(int id, SseClient client, byte[] frame)
    {
        if (!await client.SendRawAsync(frame, _cts.Token).ConfigureAwait(false))
        {
            if (_sseClients.TryRemove(id, out SseClient? removed))
            {
                removed.Dispose();
            }
        }
    }

    private async Task KeepAliveLoopAsync(CancellationToken ct)
    {
        byte[] pingBytes = Encoding.ASCII.GetBytes(": ping\n\n");
        _keepAliveTimer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        try
        {
            while (await _keepAliveTimer.WaitForNextTickAsync(ct).ConfigureAwait(false))
            {
                if (_sseClients.IsEmpty) continue;
                foreach (KeyValuePair<int, SseClient> kv in _sseClients)
                {
                    _ = PushToClientAsync(kv.Key, kv.Value, pingBytes);
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    private static byte[] FormatSseFrame(string eventName, string rawJson)
    {
        string singleLine = rawJson.Contains('\n') || rawJson.Contains('\r')
            ? rawJson.Replace("\r", string.Empty).Replace("\n", string.Empty)
            : rawJson;
        return Encoding.UTF8.GetBytes($"event: {eventName}\ndata: {singleLine}\n\n");
    }

    private static string DiscoverLanIp()
    {
        string? bestIp = null;
        int bestScore = -1;

        try
        {
            foreach (NetworkInterface nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up) continue;
                if (nic.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel) continue;

                string desc = $"{nic.Name} {nic.Description}".ToLowerInvariant();
                bool isVirtual = desc.Contains("virtual") || desc.Contains("hyper-v") ||
                                 desc.Contains("vethernet") || desc.Contains("wsl") ||
                                 desc.Contains("vmware") || desc.Contains("vbox") ||
                                 desc.Contains("docker");

                IPInterfaceProperties props = nic.GetIPProperties();
                bool hasGateway = props.GatewayAddresses.Any(g =>
                    g.Address.AddressFamily == AddressFamily.InterNetwork &&
                    !g.Address.Equals(IPAddress.Any));

                foreach (UnicastIPAddressInformation uni in props.UnicastAddresses)
                {
                    if (uni.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    byte[] b = uni.Address.GetAddressBytes();
                    if (b[0] == 127 || (b[0] == 169 && b[1] == 254)) continue;

                    int score = 10;
                    if (hasGateway) score += 50;
                    if (!isVirtual) score += 30;
                    if (nic.NetworkInterfaceType == NetworkInterfaceType.Wireless80211) score += 15;
                    else if (nic.NetworkInterfaceType == NetworkInterfaceType.Ethernet) score += 10;

                    if (b[0] == 192 && b[1] == 168) score += 20;
                    else if (b[0] == 10) score += 12;
                    else if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) score += 8;

                    if (score > bestScore)
                    {
                        bestScore = score;
                        bestIp = uni.Address.ToString();
                    }
                }
            }
        }
        catch
        {
            // Fallback seguro para localhost
        }

        return bestIp ?? "127.0.0.1";
    }

    public void Dispose()
    {
        if (!IsRunning && _listener is null) return;
        IsRunning = false;

        try { _cts.Cancel(); } catch { }
        try { _keepAliveTimer?.Dispose(); } catch { }
        try { _listener?.Stop(); } catch { }

        foreach (KeyValuePair<int, SseClient> kv in _sseClients)
        {
            kv.Value.Dispose();
        }
        _sseClients.Clear();
        _cts.Dispose();
    }

    private sealed class SseClient : IDisposable
    {
        private readonly TcpClient _tcp;
        private readonly NetworkStream _stream;
        private readonly SemaphoreSlim _writeLock = new(1, 1);
        private int _disposed;

        public int Id { get; }

        public SseClient(int id, TcpClient tcp, NetworkStream stream)
        {
            Id = id;
            _tcp = tcp;
            _stream = stream;
        }

        public async Task<bool> SendRawAsync(byte[] data, CancellationToken ct)
        {
            if (Volatile.Read(ref _disposed) != 0) return false;

            bool entered = false;
            try
            {
                entered = await _writeLock.WaitAsync(TimeSpan.FromMilliseconds(800), ct).ConfigureAwait(false);
                if (!entered || Volatile.Read(ref _disposed) != 0) return false;

                await _stream.WriteAsync(data, ct).ConfigureAwait(false);
                await _stream.FlushAsync(ct).ConfigureAwait(false);
                return true;
            }
            catch
            {
                return false;
            }
            finally
            {
                if (entered)
                {
                    try { _writeLock.Release(); } catch { }
                }
            }
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
            try { _stream.Dispose(); } catch { }
            try { _tcp.Dispose(); } catch { }
            try { _writeLock.Dispose(); } catch { }
        }
    }
}

