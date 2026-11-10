# Mapa e Arquitetura Isolada de Controles (PC)

Toda a camada de controles de teclado e visualização de atalhos do port PC está isolada em dois arquivos dedicados:

- **Frontend (JavaScript + Aba Visual no HUD):** `src/MiniDayZ.App/wwwroot/controls/pc-controls.js`
- **Backend (C# WPF + Injeção Nativa CDP):** `src/MiniDayZ.App/Controls/PcControlsManager.cs`

---

## Atalhos Mapeados

| Tecla | Ação no Jogo | Objeto Alvo (Construct 2) | Posição no HUD |
|---|---|---|---|
| `W` `A` `S` `D` | Movimentação do personagem | Nativo (`Keyboard`) | — |
| `E` ou `Tab` | Abrir / Fechar Inventário (Mochila) | `t497` (`gui_btn_inventory`) | Canto inferior esquerdo |
| `F` | Coletar Itens no Chão / Interagir | `t512` (`gui_btn_interact`) | Borda direita central |
| `Q` | Trocar entre Arma Branca e Arma de Fogo / Pistola | `t509` (`gui_btn_switch`) | Canto inferior direito |
| `R` | Recarregar Arma de Fogo | `t522` (`gui_btn_reload`) | Direita inferior-média |
| `1` a `5` | Slots Rápidos / Hotbar | `t6` (`gui_slot`) | Fileira inferior central |
| `F1` | Abrir / Fechar a **Aba de Controles** e indicadores visuais na tela | Overlay `#mdz-controls-root` | Topo esquerdo (`Controles [F1]`) |

---

## Regras de Segurança dos Atalhos

- **Só clica em alvo "live":** `native_click` é enviado apenas quando o botão/slot foi localizado de fato no scene graph (`pt.live`). Sem alvo real (ex.: em menus), a tecla não clica; as coordenadas de fallback servem só para desenhar os pinos da F1 e a tecla segue para o jogo.
- **Teclas do jogo nunca são engolidas:** o plugin Keyboard do jogo usa `W A S D` (`IsKeyDown`), `Enter` (`OnKey`) e um `OnAnyKey`. Esses códigos (87, 65, 83, 68, 13) são ignorados pelo listener de captura.
- **keydown/keyup simétricos:** se um `keydown` foi engolido, o `keyup` correspondente também é.
- **Cliques serializados:** `PcControlsManager` usa `SemaphoreSlim(1)`, evitando toques simultâneos com o mesmo `id`.

## Aba Visual de Controles (`Controles [F1]`)

No topo da tela há um botão discreto **`Controles [F1]`** (também acionável pela tecla `F1`):
1. Ao abrir a aba, todos os atalhos são listados em um painel isolado e pinos visuais (`[E / TAB]`, `[F]`, `[Q]`, `[R]`, `[1]`–`[5]`) aparecem exatamente sobre a coordenada real onde cada botão atua na tela.
2. A opção **"Fixar indicadores de tecla no HUD"** permite manter os indicadores `[E]`, `[F]`, `[Q]`, `[R]` visíveis sobre os botões mesmo após fechar a aba.
3. A aba contém o toggle **"Ativar Radar Mobile"**: só ao marcá-lo o servidor LAN sobe e o QR Code/link (com token) aparecem. Veja [COMPANION.md](COMPANION.md).

