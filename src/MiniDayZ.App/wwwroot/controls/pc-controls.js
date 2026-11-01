/**
 * MiniDayZ PC Port — Módulo Isolado de Controles (Teclado + Aba Visual de Controles)
 * Localização: wwwroot/controls/pc-controls.js
 *
 * Centraliza todos os atalhos de teclado, resolução de coordenadas reais no Construct 2
 * e a Aba Isolada de Controles ([F1]) com visualização exata de onde cada controle atua na tela.
 */
(function () {
    'use strict';

    // =========================================================================
    // 1. TABELA CENTRAL DE CONTROLES PC (Fácil leitura e manutenção)
    // =========================================================================
    const HUD_BUTTONS = {
        inventory: {
            keys: ['e', 'tab'],
            badge: 'E / TAB',
            label: 'Inventário / Mochila',
            c2Type: 't497', // images/gui_btn_inventory-sheet0.png (100x100, canto inferior esquerdo)
            hitX: 0.55,
            hitY: 0.45,
            targetName: 't497(gui_btn_inventory)',
            fallbackName: 'hud_inventory_anchor',
            fallback: function (rect) {
                return { x: rect.left + 55, y: rect.bottom - 55 };
            }
        },
        interact: {
            keys: ['f'],
            badge: 'F',
            label: 'Coletar Itens / Interagir',
            c2Type: 't512', // images/gui_btn_interact-sheet0.png (100x100, borda direita central)
            hitX: 0.50,
            hitY: 0.50,
            targetName: 't512(gui_btn_interact)',
            fallbackName: 'hud_interact_anchor',
            fallback: function (rect) {
                return { x: rect.right - 52, y: rect.top + rect.height * 0.48 };
            }
        },
        switchWeapon: {
            keys: ['q'],
            badge: 'Q',
            label: 'Trocar Arma (Branca ↔ Fogo)',
            c2Type: 't509', // images/gui_btn_switch-sheet0..2.png (100x100, canto inferior direito)
            hitX: 0.50,
            hitY: 0.60, // Polígono de colisão ocupa os 80% inferiores do sprite
            targetName: 't509(gui_btn_switch)',
            fallbackName: 'hud_switch_weapon_anchor',
            fallback: function (rect) {
                return { x: rect.right - 50, y: rect.bottom - 40 };
            }
        },
        reload: {
            keys: ['r'],
            badge: 'R',
            label: 'Recarregar Arma de Fogo',
            c2Type: 't522', // images/gui_btn_reload-sheet0.png (100x100, direita inferior-média)
            hitX: 0.50,
            hitY: 0.50,
            targetName: 't522(gui_btn_reload)',
            fallbackName: 'hud_reload_anchor',
            fallback: function (rect) {
                return { x: rect.right - 50, y: rect.top + rect.height * 0.72 };
            }
        }
    };

    const HOTBAR_PCT_X = { '1': 0.30, '2': 0.40, '3': 0.50, '4': 0.60, '5': 0.70 };

    // Mapa rápido tecla -> ação de HUD
    const KEY_TO_HUD = {};
    Object.keys(HUD_BUTTONS).forEach(function (actionId) {
        HUD_BUTTONS[actionId].keys.forEach(function (k) {
            KEY_TO_HUD[k] = HUD_BUTTONS[actionId];
        });
    });

    // =========================================================================
    // 2. RESOLUÇÃO DE COORDENADAS NO RUNTIME DO CONSTRUCT 2
    // =========================================================================
    function getCanvasRect() {
        const canvas = document.getElementById('c2canvas') || document.querySelector('canvas');
        if (canvas) return canvas.getBoundingClientRect();
        return {
            left: 0,
            top: 0,
            right: window.innerWidth,
            bottom: window.innerHeight,
            width: window.innerWidth,
            height: window.innerHeight
        };
    }

    function getRuntime() {
        return typeof window.cr_getC2Runtime === 'function' ? window.cr_getC2Runtime() : null;
    }

    function resolveHudAction(def, rect, rt) {
        if (rt && rt.types && rt.types[def.c2Type] && rt.types[def.c2Type].q && rt.types[def.c2Type].q.length > 0) {
            const instances = rt.types[def.c2Type].q;
            for (let i = 0; i < instances.length; i++) {
                const inst = instances[i];
                if (!inst || !inst.C || typeof inst.la !== 'function' || typeof inst.C.Ra !== 'function') continue;
                inst.la();
                const b = inst.ka;
                const lx = b.left + (b.right - b.left) * def.hitX;
                const ly = b.top + (b.bottom - b.top) * def.hitY;
                const cx = rect.left + inst.C.Ra(lx, ly, true, false);
                const cy = rect.top + inst.C.Ra(lx, ly, false, false);

                if (cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight) {
                    return {
                        x: Math.round(cx),
                        y: Math.round(cy),
                        target: def.targetName,
                        live: true
                    };
                }
            }
        }

        const fb = def.fallback(rect);
        return {
            x: Math.round(fb.x),
            y: Math.round(fb.y),
            target: def.fallbackName,
            live: false
        };
    }

    function resolveHotbarSlot(slotKey, rect, rt) {
        const idx = parseInt(slotKey, 10) - 1;
        if (rt && rt.types && rt.types['t6'] && rt.types['t6'].q && rt.types['t6'].q.length > 0) {
            const visibleSlots = [];
            let maxRowY = -Infinity;
            const arr = rt.types['t6'].q;

            for (let i = 0; i < arr.length; i++) {
                const s = arr[i];
                if (!s || !s.C || typeof s.la !== 'function' || typeof s.C.Ra !== 'function') continue;
                s.la();
                const mx = (s.ka.left + s.ka.right) * 0.5;
                const my = (s.ka.top + s.ka.bottom) * 0.5;
                const sx = rect.left + s.C.Ra(mx, my, true, false);
                const sy = rect.top + s.C.Ra(mx, my, false, false);
                if (sx > 0 && sx < window.innerWidth && sy > window.innerHeight * 0.55 && sy < window.innerHeight) {
                    visibleSlots.push({ x: sx, y: sy });
                    if (sy > maxRowY) maxRowY = sy;
                }
            }

            const bottomRow = visibleSlots.filter(function (p) { return Math.abs(p.y - maxRowY) <= 30; });
            if (bottomRow.length > idx) {
                bottomRow.sort(function (a, b) { return a.x - b.x; });
                return {
                    x: Math.round(bottomRow[idx].x),
                    y: Math.round(bottomRow[idx].y),
                    target: 't6(slot_' + slotKey + ')',
                    live: true
                };
            }
        }

        return {
            x: Math.round(rect.left + rect.width * HOTBAR_PCT_X[slotKey]),
            y: Math.round(rect.top + rect.height * 0.90),
            target: 'hotbar_' + slotKey,
            live: false
        };
    }

    function resolveTargetPoint(key) {
        const rect = getCanvasRect();
        const rt = getRuntime();

        if (KEY_TO_HUD[key]) {
            return resolveHudAction(KEY_TO_HUD[key], rect, rt);
        }
        if (HOTBAR_PCT_X[key]) {
            return resolveHotbarSlot(key, rect, rt);
        }
        return null;
    }

    // =========================================================================
    // 3. ENVIO IPC PARA O HOST C# (PcControlsManager.cs)
    // =========================================================================
    function triggerKey(rawKey) {
        const key = String(rawKey || '').toLowerCase();
        if (key === 'f1') {
            toggleControlsPanel();
            return true;
        }

        const pt = resolveTargetPoint(key);
        if (!pt) return false;

        if (window.chrome && window.chrome.webview) {
            window.chrome.webview.postMessage(JSON.stringify({
                action: 'native_click',
                key: key,
                mode: 'px',
                x: pt.x,
                y: pt.y,
                target: pt.target
            }));
        }
        return true;
    }

    // =========================================================================
    // 4. ABA ISOLADA DE CONTROLES E MARCADORES VISUAIS NO HUD
    // =========================================================================
    let panelOpen = false;
    let keepPinsVisible = false;
    let pinRefreshTimer = null;
    let panelEl = null;
    let tabBtnEl = null;
    let pinsLayerEl = null;
    let keepPinsCheckEl = null;

    function stopCanvasLeak(el) {
        ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'dblclick'].forEach(function (ev) {
            el.addEventListener(ev, function (e) { e.stopPropagation(); }, false);
        });
    }

    function renderControlPins() {
        if (!pinsLayerEl) return;
        const shouldShow = panelOpen || keepPinsVisible;
        if (!shouldShow) {
            pinsLayerEl.style.display = 'none';
            pinsLayerEl.innerHTML = '';
            return;
        }

        pinsLayerEl.style.display = 'block';
        const rect = getCanvasRect();
        const rt = getRuntime();
        const items = [];

        Object.keys(HUD_BUTTONS).forEach(function (id) {
            const def = HUD_BUTTONS[id];
            const pt = resolveHudAction(def, rect, rt);
            items.push({ badge: def.badge, label: def.label, x: pt.x, y: pt.y, live: pt.live });
        });

        ['1', '2', '3', '4', '5'].forEach(function (slotKey) {
            const pt = resolveHotbarSlot(slotKey, rect, rt);
            items.push({ badge: slotKey, label: 'Slot ' + slotKey, x: pt.x, y: pt.y, live: pt.live, compact: true });
        });

        pinsLayerEl.innerHTML = items.map(function (it) {
            const cls = 'mdz-hud-pin' + (it.live ? ' is-live' : '') + (it.compact ? ' is-compact' : '');
            const title = panelOpen ? ('<span class="mdz-pin-lbl">' + it.label + '</span>') : '';
            return '<div class="' + cls + '" style="left:' + it.x + 'px;top:' + it.y + 'px;">' +
                   '<span class="mdz-pin-key">[' + it.badge + ']</span>' + title +
                   '</div>';
        }).join('');
    }

    function syncPinTimer() {
        const shouldShow = panelOpen || keepPinsVisible;
        if (shouldShow && !pinRefreshTimer) {
            renderControlPins();
            pinRefreshTimer = window.setInterval(renderControlPins, 300);
        } else if (!shouldShow && pinRefreshTimer) {
            window.clearInterval(pinRefreshTimer);
            pinRefreshTimer = null;
            renderControlPins();
        } else {
            renderControlPins();
        }
    }

    function toggleControlsPanel(forceState) {
        panelOpen = typeof forceState === 'boolean' ? forceState : !panelOpen;
        if (panelEl) {
            panelEl.style.display = panelOpen ? 'block' : 'none';
        }
        if (tabBtnEl) {
            tabBtnEl.classList.toggle('is-active', panelOpen);
        }
        syncPinTimer();
    }

    function buildControlsTabUI() {
        if (document.getElementById('mdz-controls-root')) return;

        const style = document.createElement('style');
        style.id = 'mdz-controls-style';
        style.textContent = [
            '#mdz-controls-root { position: fixed; inset: 0; pointer-events: none; z-index: 99999; font-family: Consolas, "Segoe UI", monospace; }',
            '#mdz-controls-tab { position: fixed; top: 4px; left: 150px; pointer-events: auto; cursor: pointer; background: rgba(18, 22, 18, 0.78); color: #d8e2c8; border: 1px solid rgba(168, 196, 122, 0.55); border-radius: 4px; padding: 3px 9px; font-size: 11px; font-weight: 700; letter-spacing: 0.4px; opacity: 0.65; transition: opacity 0.15s ease, background 0.15s ease; }',
            '#mdz-controls-tab:hover, #mdz-controls-tab.is-active { opacity: 1; background: rgba(32, 42, 28, 0.96); border-color: #a8c47a; }',
            '#mdz-controls-panel { position: fixed; top: 30px; left: 150px; width: 310px; pointer-events: auto; display: none; background: rgba(14, 17, 14, 0.95); color: #e6ecd8; border: 1px solid #8ca864; border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.75); padding: 10px 12px; font-size: 12px; }',
            '.mdz-cp-head { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(140, 168, 100, 0.35); padding-bottom: 6px; margin-bottom: 8px; font-weight: 700; color: #b8d888; font-size: 12px; }',
            '.mdz-cp-close { cursor: pointer; background: none; border: none; color: #b8d888; font-size: 14px; font-weight: 700; padding: 0 4px; }',
            '.mdz-cp-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px dashed rgba(255, 255, 255, 0.08); }',
            '.mdz-cp-key { background: #263121; color: #d4f0a0; border: 1px solid #6b8848; border-radius: 3px; padding: 1px 6px; font-weight: 700; font-size: 11px; min-width: 58px; text-align: center; }',
            '.mdz-cp-desc { color: #d8dfd0; font-size: 11.5px; text-align: right; }',
            '.mdz-cp-foot { margin-top: 8px; padding-top: 6px; display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #b4c2a4; }',
            '.mdz-cp-foot label { display: flex; align-items: center; gap: 6px; cursor: pointer; }',
            '#mdz-controls-pins { position: fixed; inset: 0; pointer-events: none; display: none; }',
            '.mdz-hud-pin { position: fixed; transform: translate(-50%, -50%); pointer-events: none; display: flex; flex-direction: column; align-items: center; gap: 2px; }',
            '.mdz-pin-key { background: rgba(16, 22, 14, 0.86); color: #ffe082; border: 1px solid rgba(255, 213, 79, 0.85); border-radius: 3px; padding: 1px 5px; font-size: 10px; font-weight: 700; text-shadow: 0 1px 2px #000; }',
            '.mdz-hud-pin.is-live .mdz-pin-key { color: #c5f88a; border-color: #9ccc65; }',
            '.mdz-pin-lbl { background: rgba(0, 0, 0, 0.78); color: #e8eee0; border-radius: 2px; padding: 1px 4px; font-size: 9.5px; white-space: nowrap; }'
        ].join('\n');
        document.head.appendChild(style);

        const root = document.createElement('div');
        root.id = 'mdz-controls-root';
        root.innerHTML = [
            '<div id="mdz-controls-pins"></div>',
            '<button id="mdz-controls-tab" type="button" title="Abrir/Fechar Aba de Controles (F1)">Controles [F1]</button>',
            '<div id="mdz-controls-panel">',
            '  <div class="mdz-cp-head">',
            '    <span>CONTROLES DO PC</span>',
            '    <button class="mdz-cp-close" type="button" title="Fechar">✕</button>',
            '  </div>',
            '  <div class="mdz-cp-row"><span class="mdz-cp-key">W A S D</span><span class="mdz-cp-desc">Movimentação</span></div>',
            '  <div class="mdz-cp-row"><span class="mdz-cp-key">E / TAB</span><span class="mdz-cp-desc">Abrir / Fechar Inventário</span></div>',
            '  <div class="mdz-cp-row"><span class="mdz-cp-key">F</span><span class="mdz-cp-desc">Coletar Itens / Interagir</span></div>',
            '  <div class="mdz-cp-row"><span class="mdz-cp-key">Q</span><span class="mdz-cp-desc">Trocar Arma (Branca ↔ Fogo)</span></div>',
            '  <div class="mdz-cp-row"><span class="mdz-cp-key">R</span><span class="mdz-cp-desc">Recarregar Arma de Fogo</span></div>',
            '  <div class="mdz-cp-row"><span class="mdz-cp-key">1 – 5</span><span class="mdz-cp-desc">Slots Rápidos / Hotbar</span></div>',
            '  <div class="mdz-cp-row"><span class="mdz-cp-key">F1</span><span class="mdz-cp-desc">Mostrar / Ocultar esta Aba</span></div>',
            '  <div class="mdz-cp-foot">',
            '    <label><input type="checkbox" id="mdz-keep-pins" /> Fixar indicadores de tecla no HUD</label>',
            '  </div>',
            '</div>'
        ].join('');

        document.body.appendChild(root);

        tabBtnEl = document.getElementById('mdz-controls-tab');
        panelEl = document.getElementById('mdz-controls-panel');
        pinsLayerEl = document.getElementById('mdz-controls-pins');
        keepPinsCheckEl = document.getElementById('mdz-keep-pins');

        stopCanvasLeak(tabBtnEl);
        stopCanvasLeak(panelEl);

        tabBtnEl.addEventListener('click', function () {
            toggleControlsPanel();
        });

        panelEl.querySelector('.mdz-cp-close').addEventListener('click', function () {
            toggleControlsPanel(false);
        });

        keepPinsCheckEl.addEventListener('change', function () {
            keepPinsVisible = !!keepPinsCheckEl.checked;
            syncPinTimer();
        });

        window.addEventListener('resize', function () {
            if (panelOpen || keepPinsVisible) renderControlPins();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildControlsTabUI);
    } else {
        buildControlsTabUI();
    }

    // =========================================================================
    // 5. LISTENER DE TECLADO EM CAPTURE PHASE
    // =========================================================================
    window.addEventListener('keydown', function (e) {
        if (e.repeat || (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))) return;

        const key = e.key.toLowerCase();
        if (triggerKey(key)) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);

    // API global exposta para o host WPF (PcControlsManager.cs)
    window.MDZControls = {
        triggerKey: triggerKey,
        togglePanel: toggleControlsPanel,
        definitions: HUD_BUTTONS
    };
    window.__mdzTriggerKey = triggerKey;
})();

