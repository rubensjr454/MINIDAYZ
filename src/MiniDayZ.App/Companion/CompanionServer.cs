using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace MiniDayZ.App.Companion;

/// <summary>
/// Servidor LAN ultraleve (.NET 8 TcpListener HTTP/1.1 + Server-Sent Events) para o Radar Tático Mobile / 2º Monitor.
/// Só roda quando o usuário liga o toggle na aba F1. Exige token por sessão em toda rota.
/// </summary>
public sealed class CompanionServer : IDisposable
{
    private const int PreferredPort = 8080;
    private const int MaxPortAttempts = 10;
    private const int MaxConnections = 32;
    private const int MaxSseClients = 4;
    private const int SseQueueCapacity = 64;
    private static readonly TimeSpan WriteTimeout = TimeSpan.FromSeconds(5);

    private readonly ConcurrentDictionary<int, SseClient> _sseClients = new();
    private readonly ConcurrentDictionary<string, byte[]> _imageCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly string _imagesDir;
    private readonly byte[] _radarHtmlBytes;
    private readonly SemaphoreSlim _connSlots = new(MaxConnections, MaxConnections);
    private readonly List<TcpListener> _listeners = new();
    private readonly List<Task> _loopTasks = new();
    private readonly object _stateLock = new();

    private CancellationTokenSource? _cts;
    private PeriodicTimer? _keepAliveTimer;
    private byte[] _tokenBytes = Array.Empty<byte>();
    private HashSet<string> _allowedHosts = new(StringComparer.OrdinalIgnoreCase);
    private int _nextClientId;

    private volatile string _latestMapInitJson = "null";
    private volatile string _latestTickJson = "null";
    private volatile string _latestWaypointJson = "null";
    private double _mapWidth;
    private double _mapHeight;
    private readonly List<string> _mapDeltas = new();
    private readonly object _deltaLock = new();

    public string HostIp { get; private set; } = "127.0.0.1";
    public int Port { get; private set; } = PreferredPort;
    public string Token { get; private set; } = string.Empty;
    public bool IsRunning { get; private set; }
    public bool IsLocalhostFallback { get; private set; }
    public string Url => IsRunning ? $"http://{HostIp}:{Port}/?t={Token}" : string.Empty;

    /// <summary>
    /// Disparado quando o usuário marca ou limpa um Waypoint tocando na tela do celular.
    /// Recebe JSON compacto: {"x":1234,"y":5678} ou {"clear":true}.
    /// </summary>
    public event Action<string>? WaypointReceived;

    public CompanionServer()
    {
        _imagesDir = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wwwroot", "images"));
        string htmlPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wwwroot", "companion", "mobile-radar.html");
        _radarHtmlBytes = File.Exists(htmlPath)
            ? File.ReadAllBytes(htmlPath)
            : Encoding.UTF8.GetBytes("<!DOCTYPE html><html><body style='background:#111;color:#eee;font-family:monospace'>Radar Mobile nao encontrado em wwwroot/companion/mobile-radar.html</body></html>");
    }

    public void Start()
    {
        lock (_stateLock)
        {
            if (IsRunning) return;

            string lanIp = DiscoverLanIp();
            bool hasLan = lanIp != "127.0.0.1";

            if (!TryBindListeners(hasLan ? IPAddress.Parse(lanIp) : null, out int boundPort))
            {
                Logger.Warn("[Companion] Falha ao iniciar servidor LAN/localhost.");
                return;
            }

            Port = boundPort;
            HostIp = hasLan ? lanIp : "127.0.0.1";
            IsLocalhostFallback = !hasLan;
            Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            _tokenBytes = Encoding.UTF8.GetBytes(Token);
            _allowedHosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                $"{HostIp}:{Port}", $"127.0.0.1:{Port}", $"localhost:{Port}"
            };

            _cts = new CancellationTokenSource();
            IsRunning = true;
            CancellationToken ct = _cts.Token;

            _loopTasks.Clear();
            foreach (TcpListener l in _listeners)
            {
                TcpListener listener = l;
                _loopTasks.Add(Task.Run(() => AcceptLoopAsync(listener, ct)));
            }
            _loopTasks.Add(Task.Run(() => KeepAliveLoopAsync(ct)));

            Logger.Info($"[Companion] Radar LAN ativo em http://{HostIp}:{Port} (FallbackLocalhost={IsLocalhostFallback})");
        }
    }

    public void Stop()
    {
        CancellationTokenSource? cts;
        List<Task> tasks;

        lock (_stateLock)
        {
            if (!IsRunning && _listeners.Count == 0) return;
            IsRunning = false;
            cts = _cts;
            _cts = null;
            tasks = _loopTasks.ToList();
            _loopTasks.Clear();
        }

        try { cts?.Cancel(); } catch { }
        try { _keepAliveTimer?.Dispose(); } catch { }
        foreach (TcpListener l in _listeners)
        {
            try { l.Stop(); } catch { }
        }
        _listeners.Clear();

        foreach (KeyValuePair<int, SseClient> kv in _sseClients)
            kv.Value.Dispose();
        _sseClients.Clear();
        ClientCountChanged?.Invoke(0);

        try { Task.WaitAll(tasks.ToArray(), TimeSpan.FromSeconds(1)); } catch { }
        cts?.Dispose();

        Token = string.Empty;
        _tokenBytes = Array.Empty<byte>();
        Logger.Info("[Companion] Servidor parado.");
    }

    public void UpdateMapInit(string rawPayloadJson)
    {
        if (string.IsNullOrWhiteSpace(rawPayloadJson)) return;
        lock (_deltaLock)
        {
            _mapDeltas.Clear();
        }
        _latestMapInitJson = rawPayloadJson;
        CacheMapBounds(rawPayloadJson);
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

    private void CacheMapBounds(string rawMapJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(rawMapJson);
            JsonElement r = doc.RootElement;
            if (r.ValueKind == JsonValueKind.Object &&
                r.TryGetProperty("width", out JsonElement w) && w.TryGetDouble(out double mw) &&
                r.TryGetProperty("height", out JsonElement h) && h.TryGetDouble(out double mh))
            {
                _mapWidth = mw;
                _mapHeight = mh;
            }
        }
        catch (JsonException)
        {
        }
    }

    /// <summary>Escuta só no IP da LAN detectado (se houver) + loopback, ambos na mesma porta.</summary>
    private bool TryBindListeners(IPAddress? lanAddress, out int boundPort)
    {
        for (int offset = 0; offset < MaxPortAttempts; offset++)
        {
            int port = PreferredPort + offset;
            var started = new List<TcpListener>();
            try
            {
                var addresses = lanAddress is null
                    ? new[] { IPAddress.Loopback }
                    : new[] { lanAddress, IPAddress.Loopback };

                foreach (IPAddress addr in addresses)
                {
                    var l = new TcpListener(addr, port);
                    l.Server.ExclusiveAddressUse = false;
                    l.Start(backlog: 16);
                    started.Add(l);
                }

                _listeners.AddRange(started);
                boundPort = port;
                return true;
            }
            catch (SocketException)
            {
                foreach (TcpListener l in started)
                {
                    try { l.Stop(); } catch { }
                }
            }
        }

        boundPort = PreferredPort;
        return false;
    }

    private async Task AcceptLoopAsync(TcpListener listener, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                TcpClient client = await listener.AcceptTcpClientAsync(ct).ConfigureAwait(false);

                if (!IsAllowedRemote(client) || !_connSlots.Wait(0))
                {
                    try { client.Dispose(); } catch { }
                    continue;
                }

                client.NoDelay = true;
                _ = Task.Run(async () =>
                {
                    try { await HandleClientAsync(client, ct).ConfigureAwait(false); }
                    finally { _connSlots.Release(); }
                }, CancellationToken.None);
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
                Logger.Warn($"[Companion] Accept erro: {ex.Message}");
            }
        }
    }

    private static bool IsAllowedRemote(TcpClient client)
    {
        if (client.Client.RemoteEndPoint is not IPEndPoint ep) return false;

        IPAddress ip = ep.Address.IsIPv4MappedToIPv6 ? ep.Address.MapToIPv4() : ep.Address;
        if (ip.AddressFamily != AddressFamily.InterNetwork) return false;

        byte[] b = ip.GetAddressBytes();
        return b[0] == 10 ||
               b[0] == 127 ||
               (b[0] == 172 && b[1] >= 16 && b[1] <= 31) ||
               (b[0] == 192 && b[1] == 168);
    }

    private bool IsAuthorized(string query, IReadOnlyDictionary<string, string> headers)
    {
        string? supplied = null;

        foreach (string part in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            int eq = part.IndexOf('=');
            if (eq > 0 && part[..eq] == "t")
            {
                supplied = Uri.UnescapeDataString(part[(eq + 1)..]);
                break;
            }
        }

        if (supplied is null)
            headers.TryGetValue("x-mdz-token", out supplied);

        byte[] expected = _tokenBytes;
        if (supplied is null || expected.Length == 0) return false;

        return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied), expected);
    }

    private async Task HandleClientAsync(TcpClient client, CancellationToken ct)
    {
        bool keepOpenForSse = false;
        NetworkStream? stream = null;

        try
        {
            stream = client.GetStream();
            using var ctsTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            ctsTimeout.CancelAfter(WriteTimeout);

            HttpRequest? req = await ReadHttpRequestAsync(stream, ctsTimeout.Token).ConfigureAwait(false);
            if (req is null) return;

            if (!req.Headers.TryGetValue("host", out string? host) || !_allowedHosts.Contains(host))
            {
                await WriteHttpResponseAsync(stream, "400 Bad Request", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Bad Host"), ctsTimeout.Token).ConfigureAwait(false);
                return;
            }

            int qIdx = req.Target.IndexOf('?');
            string path = qIdx >= 0 ? req.Target[..qIdx] : req.Target;
            string query = qIdx >= 0 ? req.Target[(qIdx + 1)..] : string.Empty;

            if (!IsAuthorized(query, req.Headers))
            {
                await WriteHttpResponseAsync(stream, "401 Unauthorized", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Unauthorized"), ctsTimeout.Token).ConfigureAwait(false);
                return;
            }

            string method = req.Method;

            if (method == "GET" && (path == "/" || path == "/index.html"))
            {
                await WriteHttpResponseAsync(stream, "200 OK", "text/html; charset=utf-8", _radarHtmlBytes, ctsTimeout.Token).ConfigureAwait(false);
                return;
            }

            if (method == "GET" && path == "/state")
            {
                string deltasJson;
                lock (_deltaLock)
                {
                    deltasJson = _mapDeltas.Count > 0 ? "[" + string.Join(",", _mapDeltas) + "]" : "[]";
                }
                string stateJson = $"{{\"map\":{_latestMapInitJson},\"deltas\":{deltasJson},\"tick\":{_latestTickJson},\"waypoint\":{_latestWaypointJson}}}";
                await WriteHttpResponseAsync(stream, "200 OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes(stateJson), ctsTimeout.Token).ConfigureAwait(false);
                return;
            }

            if (method == "GET" && path == "/events")
            {
                if (_sseClients.Count >= MaxSseClients)
                {
                    await WriteHttpResponseAsync(stream, "503 Service Unavailable", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Too many streams"), ctsTimeout.Token).ConfigureAwait(false);
                    return;
                }

                keepOpenForSse = true;
                await HandleSseStreamAsync(client, stream, ct).ConfigureAwait(false);
                return;
            }

            if (method == "POST" && path == "/waypoint")
            {
                (string status, string json) = HandleWaypointPost(req.Body);
                await WriteHttpResponseAsync(stream, status, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(json), ctsTimeout.Token).ConfigureAwait(false);
                return;
            }

            if (method == "GET" && path.StartsWith("/images/", StringComparison.OrdinalIgnoreCase))
            {
                await HandleStaticImageRequestAsync(stream, path, ctsTimeout.Token).ConfigureAwait(false);
                return;
            }

            if (method == "GET" && path == "/favicon.ico")
            {
                await WriteHttpResponseAsync(stream, "204 No Content", "image/x-icon", Array.Empty<byte>(), ctsTimeout.Token).ConfigureAwait(false);
                return;
            }

            await WriteHttpResponseAsync(stream, "404 Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Not Found"), ctsTimeout.Token).ConfigureAwait(false);
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

    private sealed record HttpRequest(string Method, string Target, Dictionary<string, string> Headers, string Body);

    private static async Task<HttpRequest?> ReadHttpRequestAsync(NetworkStream stream, CancellationToken ct)
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

        if (headerEnd < 0 || totalRead == 0) return null;

        string headerText = Encoding.ASCII.GetString(buffer, 0, headerEnd);
        string[] lines = headerText.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length == 0) return null;

        string[] firstLine = lines[0].Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (firstLine.Length < 2) return null;

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < lines.Length; i++)
        {
            int colon = lines[i].IndexOf(':');
            if (colon > 0)
                headers[lines[i][..colon].Trim()] = lines[i][(colon + 1)..].Trim();
        }

        int contentLength = 0;
        if (headers.TryGetValue("content-length", out string? cl))
            _ = int.TryParse(cl, out contentLength);

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
        return new HttpRequest(firstLine[0].ToUpperInvariant(), firstLine[1], headers, body);
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

    private async Task HandleStaticImageRequestAsync(NetworkStream stream, string cleanPath, CancellationToken ct)
    {
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
            cacheControl: "private, max-age=86400").ConfigureAwait(false);
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
            "X-Content-Type-Options: nosniff\r\n" +
            "Connection: close\r\n\r\n";

        byte[] headerBytes = Encoding.ASCII.GetBytes(header);
        await stream.WriteAsync(headerBytes, ct).ConfigureAwait(false);
        if (body.Length > 0)
        {
            await stream.WriteAsync(body, ct).ConfigureAwait(false);
        }
        await stream.FlushAsync(ct).ConfigureAwait(false);
    }

    private async Task HandleSseStreamAsync(TcpClient client, NetworkStream stream, CancellationToken ct)
    {
        int id = Interlocked.Increment(ref _nextClientId);
        var sseClient = new SseClient(client, stream);

        try
        {
            byte[] sseHeaders = Encoding.ASCII.GetBytes(
                "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/event-stream; charset=utf-8\r\n" +
                "Cache-Control: no-cache, no-transform\r\n" +
                "Connection: keep-alive\r\n" +
                "X-Accel-Buffering: no\r\n\r\n" +
                "retry: 1500\n\n");

            sseClient.TryEnqueue(sseHeaders);

            if (_latestMapInitJson != "null")
                sseClient.TryEnqueue(FormatSseFrame("map_init", _latestMapInitJson));
            if (_latestTickJson != "null")
                sseClient.TryEnqueue(FormatSseFrame("tick", _latestTickJson));
            if (_latestWaypointJson != "null")
                sseClient.TryEnqueue(FormatSseFrame("waypoint", _latestWaypointJson));

            _sseClients[id] = sseClient;
            ClientCountChanged?.Invoke(_sseClients.Count);

            Task writer = sseClient.RunWriterAsync(ct);
            Task reader = DrainReadsAsync(stream, ct);
            await Task.WhenAny(writer, reader).ConfigureAwait(false);
        }
        catch
        {
            // Cliente desconectou normalmente
        }
        finally
        {
            if (_sseClients.TryRemove(id, out _))
                ClientCountChanged?.Invoke(_sseClients.Count);
            sseClient.Dispose();
        }
    }

    private static async Task DrainReadsAsync(NetworkStream stream, CancellationToken ct)
    {
        byte[] probe = new byte[16];
        while (!ct.IsCancellationRequested)
        {
            int read = await stream.ReadAsync(probe, ct).ConfigureAwait(false);
            if (read <= 0) break;
        }
    }

    /// <summary>Número de clientes SSE conectados mudou.</summary>
    public event Action<int>? ClientCountChanged;

    private (string Status, string Json) HandleWaypointPost(string rawBody)
    {
        const string bad = "{\"ok\":false}";
        if (string.IsNullOrWhiteSpace(rawBody)) return ("400 Bad Request", bad);

        string normalized;
        try
        {
            using var doc = JsonDocument.Parse(rawBody);
            JsonElement root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return ("400 Bad Request", bad);

            if (root.TryGetProperty("clear", out JsonElement clearEl) && clearEl.ValueKind == JsonValueKind.True)
            {
                normalized = "{\"clear\":true}";
                _latestWaypointJson = "null";
            }
            else if (root.TryGetProperty("x", out JsonElement xEl) && xEl.TryGetDouble(out double wx) &&
                     root.TryGetProperty("y", out JsonElement yEl) && yEl.TryGetDouble(out double wy) &&
                     double.IsFinite(wx) && double.IsFinite(wy) &&
                     _mapWidth > 0 && _mapHeight > 0 &&
                     wx >= 0 && wy >= 0 && wx <= _mapWidth && wy <= _mapHeight)
            {
                normalized = $"{{\"x\":{(int)Math.Round(wx)},\"y\":{(int)Math.Round(wy)}}}";
                _latestWaypointJson = normalized;
            }
            else
            {
                return ("400 Bad Request", bad);
            }
        }
        catch (JsonException)
        {
            return ("400 Bad Request", bad);
        }

        BroadcastSse("waypoint", normalized);
        WaypointReceived?.Invoke(normalized);
        return ("200 OK", "{\"ok\":true}");
    }

    private void BroadcastSse(string eventName, string rawJson)
    {
        if (_sseClients.IsEmpty) return;
        BroadcastFrame(FormatSseFrame(eventName, rawJson));
    }

    private void BroadcastFrame(byte[] frame)
    {
        foreach (KeyValuePair<int, SseClient> kv in _sseClients)
        {
            if (kv.Value.TryEnqueue(frame)) continue;

            // fila cheia = cliente lento: desconecta
            if (_sseClients.TryRemove(kv.Key, out SseClient? removed))
            {
                removed.Dispose();
                ClientCountChanged?.Invoke(_sseClients.Count);
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
                if (!_sseClients.IsEmpty) BroadcastFrame(pingBytes);
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

    public void Dispose() => Stop();

    private sealed class SseClient : IDisposable
    {
        private readonly TcpClient _tcp;
        private readonly NetworkStream _stream;
        private readonly Channel<byte[]> _queue = Channel.CreateBounded<byte[]>(
            new BoundedChannelOptions(SseQueueCapacity)
            {
                SingleReader = true,
                FullMode = BoundedChannelFullMode.Wait
            });
        private int _disposed;

        public SseClient(TcpClient tcp, NetworkStream stream)
        {
            _tcp = tcp;
            _stream = stream;
        }

        public bool TryEnqueue(byte[] data) => _queue.Writer.TryWrite(data);

        public async Task RunWriterAsync(CancellationToken ct)
        {
            await foreach (byte[] frame in _queue.Reader.ReadAllAsync(ct).ConfigureAwait(false))
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(WriteTimeout);
                await _stream.WriteAsync(frame, cts.Token).ConfigureAwait(false);
            }
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
            _queue.Writer.TryComplete();
            try { _stream.Dispose(); } catch { }
            try { _tcp.Dispose(); } catch { }
        }
    }
}
