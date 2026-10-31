# MiniDayZ PC Port - Wrapper WPF + WebView2

Port para PC do jogo HTML5 **MiniDayZ**, empacotado em uma aplicação nativa Windows
(WPF / .NET 8) que hospeda o motor web via **Microsoft Edge WebView2**.

## Objetivo

Rodar de forma extremamente leve em hardware modesto (Intel Lakefield híbrido,
Core i3 com 8 GB de RAM). O WebView2 é instanciado com um ambiente Chromium enxuto:

| Argumento | Finalidade |
|---|---|
| `--disable-features=Translate,OptimizationHints,MediaRouter` | Remove telemetria / tarefas de fundo |
| `--disable-background-networking` | Sem rede em segundo plano |
| `--disable-extensions` | Sem extensões |
| `--force-gpu-rasterization` | Rasterização na GPU (alivia a CPU) |
| `--enable-zero-copy` | Upload de texturas sem cópia extra |

## Estrutura

```
MiniDayZ.App.sln
src/MiniDayZ.App/
├── SaveSystem.cs          # Sistema de persistência em %LOCALAPPDATA%\MiniDayZ\Saves
├── MainWindow.xaml(.cs)   # Host WebView2 + ponte IPC (saves, load, console)
└── wwwroot/               # Jogo HTML5 (origem: github.com/NextDev65/MiniDayZ)
```

## Build

Requisitos: .NET SDK 8+ e WebView2 Runtime (já incluso no Windows 10/11 atualizados).

```powershell
dotnet build MiniDayZ.App.sln -c Release
dotnet run --project src/MiniDayZ.App
```

O conteúdo de `wwwroot/` é copiado automaticamente para a pasta do executável
(`Content` + `PreserveNewest`).

## Carregamento do jogo (host virtual)

O runtime do Construct 2 carrega `data.js` e os áudios via `XMLHttpRequest`, que o Chromium
bloqueia por CORS em `file://` (origin `null`). Por isso a pasta física
`<exe>\wwwroot` é mapeada com `SetVirtualHostNameToFolderMapping` para
`https://minidayz.example/`. A resolução é 100% local: sem servidor HTTP e sem rede.

O perfil do WebView2 (saves em IndexedDB, cache) fica em `%LOCALAPPDATA%\MiniDayZ\WebView2`.

## IPC e Sistema de Saves (JS ↔ C#)

O wrapper intercepta o armazenamento do jogo e comunica-se via IPC com o host .NET:
1. **Hidratação pré-boot:** Antes de executar qualquer script da página, o C# injeta os saves salvos no disco em `window.__MDZ_SAVES__` via `AddScriptToExecuteOnDocumentCreatedAsync`.
2. **Monkey Patch de `localStorage`:** O script em `wwwroot/index.html` sobrescreve `setItem`, `getItem`, `removeItem` e `clear`.
   - `setItem(k, v)`: Atualiza a memória e emite `{ action: 'save', key, data }` para o C#.
   - `getItem(k)`: Responde sincronamente da memória/disco hidratado e emite `{ action: 'load', key }` sob demanda se ausente.
   - `removeItem(k)` / `clear()`: Envia `{ action: 'delete', key }`.
3. **Backend nativo (`SaveSystem`):** Grava arquivos `.json` com escrita atômica (`.tmp` → replace) em `%LOCALAPPDATA%\MiniDayZ\Saves\[key].json`.
4. **Disparo assíncrono:** Ao carregar via `action: 'load'`, o C# dispara `SaveLoaded` com `{ detail: { key, data } }` no JavaScript.
5. **Teste de integridade:** Mensagem `"TestIPC_Success"` emitida no evento `load` da janela.


