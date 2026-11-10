# MiniDayZ PC Port - Wrapper WPF + WebView2 (`v0.3.0`)

Port nativo para Windows do jogo HTML5 **MiniDayZ (Plus v1.2)**, empacotado em **WPF (.NET 8)** com motor web **Microsoft Edge WebView2** estritamente otimizado para rodar com baixo consumo de CPU e RAM em hardwares modestos (Intel Lakefield, Core i3 com 8 GB de RAM).

---

## 📁 Estrutura do Projeto

```
MINI_DAYA_Z/
├── MiniDayZ.App.sln            # Solução Visual Studio (.NET 8)
├── README.md                   # Documentação da arquitetura e explicação detalhada do código
├── EVOLUCAO.md                 # Histórico cronológico de marcos e versões (v0.1.0 -> v0.3.0)
├── docs/screenshots/           # Capturas de tela de validação e diagnóstico
└── src/MiniDayZ.App/
    ├── MiniDayZ.App.csproj     # Configuração do compilador, GC enxuto e deploy de assets
    ├── App.xaml / App.xaml.cs  # Ponto de entrada WPF: instância única (Mutex) e handlers globais de exceção
    ├── Logger.cs               # Log em arquivo (%LOCALAPPDATA%\MiniDayZ\logs\app.log, rotação 1 MB x 3)
    ├── AssemblyInfo.cs         # Definições de tema e metadados do assembly
    ├── SaveSystem.cs           # Persistência em disco (%LOCALAPPDATA%): fila em background, backup .bak, sha256
    ├── Companion/CompanionServer.cs # Radar LAN opt-in (token, bind LAN+loopback, limites)
    ├── Controls/PcControlsManager.cs # Cliques nativos via CDP (serializados)
    ├── MainWindow.xaml         # Layout da janela principal (Grid zerado + WebView2)
    ├── MainWindow.xaml.cs      # Inicialização do Chromium, ponte IPC e Save on Close
    └── wwwroot/                # Motor HTML5 Construct 2 + injeções de código PC
        ├── index.html          # Página raiz com Monkey Patch de saves, CSS anti-browser e Keybinds
        ├── c2runtime.js        # Engine Construct 2 do jogo
        ├── data.js             # Dados de objetos, mapas, sprites e lógica do jogo
        ├── images/             # Texturas e spritesheets
        └── media/              # Efeitos sonoros e músicas (.ogg / .m4a)
```

---

## 🧠 Explicação Detalhada do Código (Arquivo por Arquivo)

### 1. [`src/MiniDayZ.App/MiniDayZ.App.csproj`](src/MiniDayZ.App/MiniDayZ.App.csproj)

Define como o binário .NET 8 é compilado e otimizado para consumir o mínimo de memória:

- **`ServerGarbageCollector = false` e `ConcurrentGarbageCollection = false`:** Usa o Garbage Collector em modo _Workstation_ não-concorrente, evitando criar threads extras em segundo plano que disputariam núcleos em CPUs fracas.
- **`TieredPGO = true`:** Ativa _Profile-Guided Optimization_ dinâmico no JIT para acelerar os caminhos quentes de código.
- **`InvariantGlobalization = true` e `SatelliteResourceLanguages = en`:** Descarta pacotes pesados de localização do .NET.
- **`<Content Include="wwwroot\**\*" CopyToOutputDirectory="PreserveNewest" />`:** Garante que todos os 1.876 arquivos do jogo sejam copiados automaticamente para a pasta `bin/.../wwwroot/` ao compilar, apenas quando forem novos ou modificados.

---

### 2. [`src/MiniDayZ.App/MainWindow.xaml`](src/MiniDayZ.App/MainWindow.xaml)

Define a camada visual nativa que hospeda o jogo:

- **`Grid Margin="0"` e `Background="Black"`:** Remove bordas internas e evita flashes brancos durante o carregamento inicial.
- **`<wv2:WebView2 x:Name="WebView" DefaultBackgroundColor="Black" />`:** Ocupa 100% da janela (`Stretch`). **Nota crítica:** A propriedade `Source` não é declarada no XAML porque isso forçaria o WebView2 a iniciar com configurações padrão antes das nossas flags de otimização entrarem em vigor.

---

### 3. [`src/MiniDayZ.App/MainWindow.xaml.cs`](src/MiniDayZ.App/MainWindow.xaml.cs)

Coração da integração entre o Windows (.NET) e o motor HTML5:

- **`BrowserArguments` (Flags do Chromium):**
  | Flag | O que faz no código |
  |---|---|
  | `--disable-features=Translate,OptimizationHints,MediaRouter` | Corta serviços de tradução, telemetria e busca de dispositivos de mídia na rede. |
  | `--disable-background-networking` | Bloqueia requisições automáticas do Chromium em segundo plano. |
  | `--disable-extensions` | Desativa o subsistema de extensões. |
  | `--force-gpu-rasterization` | Obriga a GPU a desenhar os quadros do canvas, aliviando o processador. |
  | `--enable-zero-copy` | Transfere texturas para a GPU sem cópias intermediárias na RAM. |

- **`InitializeAsync()`:**
  1. Cria o ambiente customizado (`CoreWebView2Environment.CreateAsync`) apontando a pasta de perfil para `%LOCALAPPDATA%\MiniDayZ\WebView2` (garante permissão de escrita mesmo se instalado em `Program Files`).
  2. Chama `ConfigureSettings()` para desligar comportamentos de navegador: menu de botão direito nativo, barra de status, zoom/pinch, preenchimento automático, atalhos de navegador e página de erro padrão.
  3. **Hidratação Pré-Boot de Saves:** Lê todos os saves do disco (`SaveSystem.LoadAll()`) e injeta no navegador via `AddScriptToExecuteOnDocumentCreatedAsync("window.__MDZ_SAVES__ = ...")` antes de qualquer script da página existir.
  4. **Mapeamento de Host Virtual (`SetVirtualHostNameToFolderMapping`):** Mapeia a pasta física `wwwroot` para `https://minidayz.example/`. Isso resolve o bloqueio de CORS do Chromium sobre requisições `XMLHttpRequest` (`data.js` e áudios) em protocolo `file://`, mantendo tudo 100% offline.

- **`MainWindow_Closing()` e `_isSafeToClose` (Save on Close):**
  - Intercepta o clique no botão de fechar a janela (`e.Cancel = true`).
  - Executa um script no WebView2 (`ExecuteScriptAsync`) ordenando que o JavaScript envie um dump completo de todo o `localStorage` via IPC com a ação `save_on_close`.
  - Caso o WebView2 ainda não tenha inicializado ou falhe, fecha imediatamente com segurança.

- **`OnWebMessageReceived()` e `HandleMessageObject()` (Ponte IPC):**
  - Valida se a mensagem veio estritamente de `https://minidayz.example/`.
  - Processa as ações enviadas pelo JavaScript:
    - **`save`:** Grava imediatamente uma chave/valor no disco via `SaveSystem.Save(key, data)`.
    - **`load`:** Lê a chave do disco via `SaveSystem.Load(key)` e dispara `SendSaveLoadedAsync()`, emitindo o evento `CustomEvent('SaveLoaded')` de volta para o JavaScript.
    - **`delete`:** Remove o arquivo `.json` correspondente do disco via `SaveSystem.Delete(key)`.
    - **`save_on_close`:** Percorre todas as propriedades do `localStorage` enviadas no fechamento, salva cada uma em disco, marca `_isSafeToClose = true` e encerra o processo com `Application.Current.Shutdown()`.

- **`AttachConsoleLoggingAsync()` (Somente em `DEBUG`):**
  - Conecta-se ao protocolo CDP (_Chrome DevTools Protocol_) para espelhar `console.log`, erros de rede e exceções JavaScript diretamente na janela _Output_ do Visual Studio.

---

### 4. [`src/MiniDayZ.App/SaveSystem.cs`](src/MiniDayZ.App/SaveSystem.cs)

Camada de persistência nativa no sistema de arquivos do Windows:

- **`SaveDirectory`:** Aponta para `%LOCALAPPDATA%\MiniDayZ\Saves`.
- **`Save(string key, string data)`:** Faz escrita atômica — primeiro grava em `[key].json.tmp` em UTF-8 sem BOM e depois executa `File.Move(..., overwrite: true)`. Isso impede que o save corrompa se o PC desligar ou o processo cair no meio da gravação.
- **`Load(string key)`:** Lê e retorna o conteúdo de `[key].json` (ou `null` se não existir).
- **`Delete(string key)`:** Exclui o arquivo `.json` do disco quando o jogo limpa uma chave.
- **`LoadAll()`:** Carrega todos os arquivos `.json` da pasta em um dicionário para hidratar o jogo na inicialização.
- **`GetPath(string key)`:** Sanitiza o nome da chave usando `Uri.EscapeDataString(key)`, bloqueando ataques de _Path Traversal_ (`../`) e caracteres proibidos pelo NTFS.

---

### 5. [`src/MiniDayZ.App/wwwroot/index.html`](src/MiniDayZ.App/wwwroot/index.html)

Ponto de entrada HTML5 com três injeções customizadas para transformar o jogo web em jogo de PC:

0. **Interceptação do `localforage` (script logo após `c2runtime.js`):** o jogo salva via `localforage` (IndexedDB), não `localStorage`. Como a API de drivers está minificada no `c2runtime`, os métodos públicos (`getItem`, `setItem`, `removeItem`, `clear`, `keys`, `length`, `key`, `iterate`) são sobrescritos com `Object.defineProperty` e passam a usar o cache `window.__MDZ_LF__` + IPC (`save`/`delete` com chave `lf:<nome>`). No 1º boot sem saves em disco (`window.__MDZ_FIRST_BOOT__`), o IndexedDB antigo é lido e migrado para o C# (sem ser apagado).

1. **Monkey Patch de `localStorage` (no topo do `<head>`, mantido como fallback dos `__c2save_*`):**
   - Intercepta `Storage.prototype.setItem`, `getItem`, `removeItem` e `clear` antes do motor Construct 2 carregar.
   - Usa o cache `window.__MDZ_SAVES__` injetado pelo C# para responder chamadas síncronas de `getItem` em tempo zero e restaura saves automaticamente se o cache do navegador for limpo.
   - Toda chamada a `setItem` ou `removeItem` dispara mensagens IPC assíncronas (`save` / `delete`) para o C#.
   - Expõe `window.MDZSaves.load(key)` retornando uma `Promise` resolvida quando o evento `SaveLoaded` chega do C#.

2. **Blindagem de Interface Anti-Browser (no `<head>`):**
   - **CSS:** `overflow: hidden; user-select: none; -webkit-user-drag: none; touch-action: none;` e `img { pointer-events: none; }` — impede barras de rolagem, seleção acidental de texto e arrasto de imagens.
   - **JS:** Bloqueia o evento `contextmenu` (clique direito não abre menu de navegador) e envia `"TestIPC_Success"` no `load` para confirmar que a ponte IPC está ativa.

3. **Controles PC:** a lógica de teclado fica isolada em `wwwroot/controls/pc-controls.js` (ver [CONTROLES.md](CONTROLES.md)). O Radar Tático LAN está descrito em [COMPANION.md](COMPANION.md).

---

## 🚀 Como Compilar e Rodar

Pré-requisitos: **.NET 8 SDK** (ou superior) e **Microsoft Edge WebView2 Runtime** (incluso por padrão no Windows 10/11).

```powershell
# Compilar em modo Release
dotnet build MiniDayZ.App.sln -c Release

# Executar a aplicação
dotnet run --project src/MiniDayZ.App
```

---

## Créditos e Agradecimentos

Este projeto é um wrapper nativo que utiliza como base os arquivos e modificações desenvolvidos pela comunidade e pelos criadores originais:

- **[Bohemia Interactive](https://www.bohemia.net/):** Desenvolvedora e criadora original do jogo **Mini DAYZ** (versão mobile e browser original 1.4.1).
- **[NextDev65](https://github.com/NextDev65/MiniDayZ):** Repositório base utilizado para extração dos arquivos do jogo e preservação da versão web jogável no PC.
- **Altero:** Criador do mod **Mini DayZ+ (MDZ+ v1.2)**, versão incorporada em `wwwroot` com melhorias de jogabilidade, suporte aprimorado a mouse/PC e rebalanceamento.
- **Kev3232:** Criador do mod **Mini DayZ Reloaded 1.1**.
- **meterpreter:** Pelo trabalho de engenharia reversa e exportação dos pacotes.
