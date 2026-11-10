# MiniDayZ PC Port — Radar Tático & Companion Mobile (LAN)

Documentação técnica do módulo **Companion LAN (Prioridade 09)**, responsável por transmitir o mapa procedural da ilha e telemetria tática em tempo real (`1Hz`) para um telemóvel (Wi-Fi) ou segundo monitor sem impactar a CPU/RAM da máquina principal.

---

## 1. Arquitetura de Baixo Custo

```
[Construct 2 Runtime (cr_getC2Runtime)]
        │  Polling leve 1Hz (1000ms) — ativo apenas em partida E com ao menos um celular conectado (SSE)
        ▼
[wwwroot/companion/radar-telemetry.js]
        ├── companion_map_init (1x ao carregar ilha: terreno RLE, matriz 16x16, prédios, Secret Locations, Heli Crashes, Bunkers)
        └── companion_tick     (1Hz: X/Y/ângulo do jogador, vitais, veículos, tendas e ameaças num raio de 2600px)
        │  WebView2 IPC (postMessage)
        ▼
[Companion/CompanionServer.cs (.NET 8 TcpListener Assíncrono)]
        ├── GET  /          → SPA Mobile-First HTML5/Canvas cacheada em memória (byte[])
        ├── GET  /images/*  → Spritesheets e Tilemaps originais servidos de wwwroot/images/ com cache em RAM
        ├── GET  /state     → Snapshot JSON imediato ({ map, tick, waypoint })
        ├── GET  /events    → Stream SSE (Server-Sent Events) em tempo real para clientes móveis
        └── POST /waypoint  → Sincronização reversa (Two-Way) Celular → C# → WebView2 (Seta direcional na borda do PC)
```

### Decisões de Performance
1. **Zero Overhead em Menus:** O extrator verifica `rt.wa.name` e `level_loading`; fora de partida ativa, nenhuma mensagem IPC é gerada.
2. **Separação Estático vs. Móvel:** O layout procedural (`17850x20000`), malha de terreno (codificada em RLE `< 3 KB`), matriz `16x16` e estruturas fixas são enviados **uma única vez** (`companion_map_init`). O celular pré-renderiza tudo num `<canvas>` *offscreen* local.
3. **Servidor Socket Nativo sem UAC, opt-in:** `TcpListener` assíncrono do `.NET 8` (portas `8080..8089`), **desligado por padrão** — só sobe pelo toggle na aba F1 (`companion_start`/`companion_stop`). Escuta apenas no IP da LAN detectado + `127.0.0.1` (nunca `0.0.0.0`) e só aceita clientes de IP privado (10/8, 172.16/12, 192.168/16, 127/8). Evita o `Access Denied (URLACL)` do `HttpListener`.
4. **QR Code Nativo Zero-Lib:** a aba `Controles [F1]` ([pc-controls.js](src/MiniDayZ.App/wwwroot/controls/pc-controls.js)) gera o QR ISO/IEC 18004 (Byte Mode, ECC L, versões 1–10 com Reed-Solomon multi-bloco) em `<canvas>`. Se a URL não couber, o QR é ocultado e só o link é exibido.
5. **Telemetria sob demanda:** o C# envia `CompanionClients(n)` quando o número de clientes SSE muda; com `n = 0` o `pollTelemetry` não coleta, e em `0→1` o mapa é reenviado (`forceMapResend`).

---

## 1.1 Segurança do Servidor

| Item | Comportamento |
|---|---|
| **Token por sessão** | 128 bits aleatórios (`RandomNumberGenerator`) gerados a cada `Start`. A URL do QR é `http://<ip>:<porta>/?t=<token>`. Toda rota exige `?t=` ou header `X-MDZ-Token` (comparação `FixedTimeEquals`); senão `401`. O `mobile-radar.html` lê o token da URL e o envia em `/state`, `/events`, `/waypoint` e `/images/*`. |
| **Host / CORS** | Header `Host` precisa ser `<ip>:<porta>`, `127.0.0.1:<porta>` ou `localhost:<porta>`. Não há `Access-Control-*` nem rota `OPTIONS`. |
| **Limites** | Máx. 32 conexões simultâneas, 4 clientes SSE, timeout de escrita 5 s. |
| **SSE** | Cada cliente tem um `Channel<byte[]>` limitado (64) e um único loop de escrita; fila cheia desconecta o cliente (sem frames fora de ordem). |
| **POST /waypoint** | JSON inválido ou não-objeto → `400`; `x`/`y` precisam ser finitos e dentro dos limites do mapa. |
| **Encerramento** | `Dispose`/`Stop` cancelam e aguardam as tasks de accept/keepalive por até 1 s. |
| **HTML do radar** | Os patches antigos foram incorporados ao `mobile-radar.html`; o servidor entrega os bytes carregados uma única vez. |

---

## 2. Mapeamento do Scene Graph (Construct 2)

Inspeção realizada sobre `cr_getC2Runtime()` (`c2runtime.js` + `data.js` do MiniDayZ Plus 1.2):

### Estruturas Internas do Motor
| Símbolo Runtime | Significado no Construct 2 | Uso no Radar |
|---|---|---|
| `rt.wa` | Layout ativo (`name`, `width`, `height`, `scrollX`, `scrollY`) | Detectar `Map` (`17850x20000`), `Tutorial` (`8300x2000`) e `Polygon` (`1500x1500`) |
| `rt.tD` | Lista de variáveis globais (`gv.name`, `gv.data`) | Ler `CurrentLevel`, `Day_survived`, `Player_temperature`, `Timer_Hours`, `inBunker`, `level_loading`, `seedid` |
| `rt.types['tN'].q` | Instâncias vivas do tipo ou família (`x`, `y`, `width`, `height`, `u`, `cc[]`) | Extrair coordenadas reais e variáveis de instância (filtrando templates fora do mapa `x < 0` ou `y < 0`) |
| `inst.C.Ra(wx, wy, ...)` | Projeção Mundo → Tela da camada do jogador | Posicionar o indicador direcional de **Waypoint** na tela/borda do PC |

### Objetos e Famílias Mapeados (`data.js`)
| Categoria | IDs / Famílias Construct 2 | Detalhes Extraídos |
|---|---|---|
| **Jogador & Vitais** | `t181` (`player_collision_base`), `t193` (`player_base`) | `x`, `y`, ângulo `u`, Sangue (`cc[15]`), Água (`cc[14]`), Fome (`cc[13]`) + `Player_temperature` |
| **Matriz Procedural 16x16** | `t518` (`Array 16x16x1`), `t514` (`mapgen`) | Códigos de setor: `2` Secreto, `5` Base Militar, `6` Cidade, `9` Vila, `11` Hospital, `12–14` Estradas, `15` Bombeiros |
| **Terreno & Estradas Reais** | `t482`/`t687`/`t688`/`t776`/`t980` (`ground_lvl1..5_tilemap`), `t418` (`sand`), `t208` (`water`), `t211` (`forest`), `t784` (`bunker`), `t974`/`t976` (Pontes/Água) | RLE nativo `tm.oF()` + flags de rotação/flip (`h`/`v`/`d`) pré-renderizados em `OffscreenCanvas` no cliente com as texturas reais do jogo |
| **Prédios, Muros & Carros** | Família `t1049` (37 telhados `b_*`), `t307` (`deer_stand`), `t442` (`waterpump`), `t977` (`bridge`), muros/HESCO (`t257`, `t258`, `t319`, `t888`, `t889`), carros estáticos e `t210` (`tree_block`) | Posição, rotação `u` e recorte de sprite (`mc.Ni`, `Wj`, `Xj`) para visão aérea estilo satélite |
| **Local Secreto (Ouro — 1/Ilha)** | `t915` (`marker_secret_location`) + Whitelist estrita `EE_SECRET_DEFS` (excluindo a família de obstáculos/árvores `t1035`) | Radar (`t355`), KV-2 (`t695`), Torre de Rádio (`t701`), Submarino Typhoon (`t781`), Drone (`t790`), Castelo (`t791`), Caixa PUBG (`t800`), Camp Stalker (`t863–t865`), Predador (`t972`), Baú Secreto (`t1029`), etc. |
| **Bunkers & Evacuação (Ouro)** | `t785`, `t638`, `t979`, `t1002` | Entrada do Bunker na superfície, Barco de Evacuação, Ponte de Fuga e Heliponto de Extração |
| **Heli Crashes & Airdrops Reais** | `t246` (`heli_crash`), `t441` (`hammer_crash`), `t710` (`airdrop_box`) | Apenas destroços e caixas realmente instanciados na ilha (`x >= 20, y >= 20`), ignorando marcadores candidatos vazios (`t344`, `t434`, `t987`) |
| **Veículos & Tendas** | Família `t1067` (`t809` UAZ, `t815` Volga, `t920` Humvee), `t397`/`t398` (Tendas), `t995` (Stash) | Posição atualizada a cada `1s` (`companion_tick`) |
| **Ameaças Próximas (`2600px`)** | `t850` (Hulk/Tank), `t829`/`t252`/`t547`/`t556` (Bandidos/Saqueadores), `t935`/`t715`/`t719`/`t720`/`t279`/`t400` (Infectados Especiais), `t475` (Lobos), `t529` (Aliados), `t256` (Zumbis comuns em `1050px`) | Usa controladores vivos (`*_eyes` / IA ativa), descartando automaticamente corpos mortos |

---

## 3. Como Usar

1. No jogo no PC, pressione **`F1`** (ou clique em **`Controles [F1]`**) e marque **"Ativar Radar Mobile"** (o servidor fica desligado até isso).
2. Aponte a câmera do telemóvel (conectado ao mesmo Wi-Fi) para o **QR Code** exibido na secção **Radar Tático Mobile (LAN)**, ou abra o link exibido (`http://<IP-LAN>:8080/?t=<token>`) num segundo monitor.
3. Use dois dedos para *pinch-to-zoom*, arraste para inspecionar a ilha, alterne os 4 filtros táticos e toque em qualquer ponto do mapa para projetar um **Waypoint** direcional com distância em metros na borda da tela do PC.

