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
        if (!pt || !pt.live) return false;

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

    // =========================================================================
    // 4.1 GERADOR DE QR CODE PURO (ISO/IEC 18004 BYTE MODE V1-V4 ECC LEVEL L)
    //     Zero dependências externas — renderiza direto em Canvas/SVG nativo.
    // =========================================================================
    function createQrMatrix(text) {
        // ECC L. blocks: [quantidade, codewords de dados por bloco]; ecCw = codewords de correção POR bloco.
        const VERSIONS = [
            null,
            { size: 21, blocks: [[1, 19]], ecCw: 7, align: [] },
            { size: 25, blocks: [[1, 34]], ecCw: 10, align: [6, 18] },
            { size: 29, blocks: [[1, 55]], ecCw: 15, align: [6, 22] },
            { size: 33, blocks: [[1, 80]], ecCw: 20, align: [6, 26] },
            { size: 37, blocks: [[1, 108]], ecCw: 26, align: [6, 30] },
            { size: 41, blocks: [[2, 68]], ecCw: 18, align: [6, 34] },
            { size: 45, blocks: [[2, 78]], ecCw: 20, align: [6, 22, 38] },
            { size: 49, blocks: [[2, 97]], ecCw: 24, align: [6, 24, 42] },
            { size: 53, blocks: [[2, 116]], ecCw: 30, align: [6, 26, 46] },
            { size: 57, blocks: [[2, 68], [2, 69]], ecCw: 18, align: [6, 28, 50] }
        ];

        const bytes = new TextEncoder().encode(String(text || ''));
        let ver = 0;
        for (let v = 1; v <= 10; v++) {
            const total = VERSIONS[v].blocks.reduce(function (s, b) { return s + b[0] * b[1]; }, 0);
            const ccBits = v <= 9 ? 8 : 16;
            if (4 + ccBits + bytes.length * 8 <= total * 8) {
                ver = v;
                break;
            }
        }
        if (!ver) return null;

        const cfg = VERSIONS[ver];
        cfg.dataCw = cfg.blocks.reduce(function (s, b) { return s + b[0] * b[1]; }, 0);
        const bits = [];
        function pushBits(val, len) {
            for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
        }

        pushBits(0x4, 4); // Byte mode (0100)
        pushBits(bytes.length, ver <= 9 ? 8 : 16);
        for (let i = 0; i < bytes.length; i++) pushBits(bytes[i], 8);

        const maxBits = cfg.dataCw * 8;
        const term = Math.min(4, maxBits - bits.length);
        for (let i = 0; i < term; i++) bits.push(0);
        while (bits.length % 8 !== 0) bits.push(0);

        const data = [];
        for (let i = 0; i < bits.length; i += 8) {
            let b = 0;
            for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
            data.push(b);
        }
        let padToggle = 0;
        while (data.length < cfg.dataCw) {
            data.push(padToggle === 0 ? 0xEC : 0x11);
            padToggle ^= 1;
        }

        // Tabelas GF(256) (polinômio primitivo 0x11D)
        const exp = new Uint8Array(512);
        const log = new Uint8Array(256);
        let x = 1;
        for (let i = 0; i < 255; i++) {
            exp[i] = x;
            log[x] = i;
            x = (x << 1) ^ ((x & 0x80) ? 0x11D : 0);
        }
        for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
        const gfMul = function (a, b) {
            return (a === 0 || b === 0) ? 0 : exp[log[a] + log[b]];
        };

        // Polinômio gerador Reed-Solomon de grau ecCw
        let gen = [1];
        for (let i = 0; i < cfg.ecCw; i++) {
            const next = new Array(gen.length + 1).fill(0);
            for (let j = 0; j < gen.length; j++) {
                next[j] ^= gen[j];
                next[j + 1] ^= gfMul(gen[j], exp[i]);
            }
            gen = next;
        }

        function rsRemainder(blockData) {
            const rem = new Uint8Array(cfg.ecCw);
            for (let i = 0; i < blockData.length; i++) {
                const factor = blockData[i] ^ rem[0];
                for (let j = 0; j < cfg.ecCw - 1; j++) rem[j] = rem[j + 1];
                rem[cfg.ecCw - 1] = 0;
                for (let j = 0; j < cfg.ecCw; j++) {
                    rem[j] ^= gfMul(gen[j + 1], factor);
                }
            }
            return rem;
        }

        const dataBlocks = [];
        const ecBlocks = [];
        let offset = 0;
        cfg.blocks.forEach(function (grp) {
            for (let n = 0; n < grp[0]; n++) {
                const blk = data.slice(offset, offset + grp[1]);
                offset += grp[1];
                dataBlocks.push(blk);
                ecBlocks.push(rsRemainder(blk));
            }
        });

        // Intercala: dados bloco a bloco, depois ECC bloco a bloco
        const codewords = [];
        const maxData = Math.max.apply(null, dataBlocks.map(function (b) { return b.length; }));
        for (let i = 0; i < maxData; i++) {
            dataBlocks.forEach(function (b) { if (i < b.length) codewords.push(b[i]); });
        }
        for (let i = 0; i < cfg.ecCw; i++) {
            ecBlocks.forEach(function (b) { codewords.push(b[i]); });
        }
        const size = cfg.size;
        const modules = Array.from({ length: size }, function () { return new Uint8Array(size); });
        const isFunc = Array.from({ length: size }, function () { return new Uint8Array(size); });

        function setFunc(r, c, dark) {
            if (r < 0 || c < 0 || r >= size || c >= size) return;
            modules[r][c] = dark ? 1 : 0;
            isFunc[r][c] = 1;
        }

        function drawFinder(topR, leftC) {
            for (let dr = -1; dr <= 7; dr++) {
                for (let dc = -1; dc <= 7; dc++) {
                    const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
                    const dark = (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) && (dist !== 2);
                    setFunc(topR + dr, leftC + dc, dark);
                }
            }
        }

        drawFinder(0, 0);
        drawFinder(0, size - 7);
        drawFinder(size - 7, 0);

        // Alignment patterns
        for (let i = 0; i < cfg.align.length; i++) {
            for (let j = 0; j < cfg.align.length; j++) {
                const ar = cfg.align[i];
                const ac = cfg.align[j];
                if ((ar < 9 && ac < 9) || (ar < 9 && ac >= size - 8) || (ar >= size - 8 && ac < 9)) continue;
                for (let dr = -2; dr <= 2; dr++) {
                    for (let dc = -2; dc <= 2; dc++) {
                        setFunc(ar + dr, ac + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
                    }
                }
            }
        }

        // Timing patterns
        for (let i = 8; i < size - 8; i++) {
            if (!isFunc[6][i]) setFunc(6, i, (i % 2) === 0);
            if (!isFunc[i][6]) setFunc(i, 6, (i % 2) === 0);
        }

        // Reserva área de Format Info + Dark Module
        for (let i = 0; i <= 8; i++) {
            if (i !== 6) {
                isFunc[8][i] = 1;
                isFunc[i][8] = 1;
            }
        }
        for (let i = 0; i < 8; i++) {
            isFunc[8][size - 1 - i] = 1;
            if (i < 7) isFunc[size - 1 - i][8] = 1;
        }
        setFunc(size - 8, 8, true);

        // Version Info (v7+): BCH(18,6)
        if (ver >= 7) {
            let vr = ver << 12;
            for (let i = 17; i >= 12; i--) {
                if ((vr >>> i) & 1) vr ^= (0x1F25 << (i - 12));
            }
            const vinfo = (ver << 12) | vr;
            for (let i = 0; i < 18; i++) {
                const bit = (vinfo >>> i) & 1;
                const a = Math.floor(i / 3);
                const b = (i % 3) + size - 11;
                setFunc(a, b, bit);
                setFunc(b, a, bit);
            }
        }

        // Zigzag de bits de dados + ECC
        let bitIdx = 0;
        const totalDataBits = codewords.length * 8;
        let upward = true;
        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let vert = 0; vert < size; vert++) {
                const r = upward ? (size - 1 - vert) : vert;
                for (let j = 0; j < 2; j++) {
                    const c = right - j;
                    if (!isFunc[r][c]) {
                        let dark = 0;
                        if (bitIdx < totalDataBits) {
                            dark = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
                            bitIdx++;
                        }
                        modules[r][c] = dark;
                    }
                }
            }
            upward = !upward;
        }

        function writeFormatBits(mat, mask) {
            const data5 = (0x01 << 3) | mask; // ECC Level L = 01
            let remBch = data5 << 10;
            for (let i = 14; i >= 10; i--) {
                if ((remBch >>> i) & 1) remBch ^= (0x537 << (i - 10));
            }
            const fmt = ((data5 << 10) | remBch) ^ 0x5412;

            for (let i = 0; i <= 5; i++) mat[i][8] = (fmt >>> i) & 1;
            mat[7][8] = (fmt >>> 6) & 1;
            mat[8][8] = (fmt >>> 7) & 1;
            mat[8][7] = (fmt >>> 8) & 1;
            for (let i = 9; i < 15; i++) mat[8][14 - i] = (fmt >>> i) & 1;

            for (let i = 0; i < 8; i++) mat[8][size - 1 - i] = (fmt >>> i) & 1;
            for (let i = 8; i < 15; i++) mat[size - 15 + i][8] = (fmt >>> i) & 1;
            mat[size - 8][8] = 1;
        }

        const maskFns = [
            function (r, c) { return ((r + c) % 2) === 0; },
            function (r) { return (r % 2) === 0; },
            function (_, c) { return (c % 3) === 0; },
            function (r, c) { return ((r + c) % 3) === 0; },
            function (r, c) { return ((Math.floor(r / 2) + Math.floor(c / 3)) % 2) === 0; },
            function (r, c) { return ((r * c) % 2 + (r * c) % 3) === 0; },
            function (r, c) { return ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0; },
            function (r, c) { return ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0; }
        ];

        let bestMat = null;
        let bestPenalty = Infinity;
        for (let m = 0; m < 8; m++) {
            const cand = modules.map(function (row) { return Uint8Array.from(row); });
            for (let r = 0; r < size; r++) {
                for (let c = 0; c < size; c++) {
                    if (!isFunc[r][c] && maskFns[m](r, c)) cand[r][c] ^= 1;
                }
            }
            writeFormatBits(cand, m);

            let pen = 0;
            for (let r = 0; r < size; r++) {
                let runH = 1, runV = 1;
                for (let c = 1; c < size; c++) {
                    if (cand[r][c] === cand[r][c - 1]) { runH++; if (runH === 5) pen += 3; else if (runH > 5) pen++; } else runH = 1;
                    if (cand[c][r] === cand[c - 1][r]) { runV++; if (runV === 5) pen += 3; else if (runV > 5) pen++; } else runV = 1;
                }
            }
            if (pen < bestPenalty) {
                bestPenalty = pen;
                bestMat = cand;
            }
        }

        return bestMat;
    }

    function renderQrCanvas(canvasEl, text) {
        if (!canvasEl || !text) return false;
        const mat = createQrMatrix(text);
        if (!mat) return false;
        const quiet = 3;
        const total = mat.length + quiet * 2;
        const scale = 4;
        canvasEl.width = total * scale;
        canvasEl.height = total * scale;
        const ctx = canvasEl.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
        ctx.fillStyle = '#0c110c';
        for (let r = 0; r < mat.length; r++) {
            for (let c = 0; c < mat.length; c++) {
                if (mat[r][c]) {
                    ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
                }
            }
        }
        return true;
    }

    function buildControlsTabUI() {
        if (document.getElementById('mdz-controls-root')) return;

        let companionUrl = (window.__MDZ_COMPANION__ && window.__MDZ_COMPANION__.url) || "";

        const style = document.createElement('style');
        style.id = 'mdz-controls-style';
        style.textContent = [
            '#mdz-controls-root { position: fixed; inset: 0; pointer-events: none; z-index: 99999; font-family: Consolas, "Segoe UI", monospace; }',
            '#mdz-controls-tab { position: fixed; top: 4px; left: 150px; pointer-events: auto; cursor: pointer; background: rgba(18, 22, 18, 0.78); color: #d8e2c8; border: 1px solid rgba(168, 196, 122, 0.55); border-radius: 4px; padding: 3px 9px; font-size: 11px; font-weight: 700; letter-spacing: 0.4px; opacity: 0.65; transition: opacity 0.15s ease, background 0.15s ease; }',
            '#mdz-controls-tab:hover, #mdz-controls-tab.is-active { opacity: 1; background: rgba(32, 42, 28, 0.96); border-color: #a8c47a; }',
            '#mdz-controls-panel { position: fixed; top: 30px; left: 150px; width: 326px; max-height: calc(100vh - 40px); overflow-y: auto; pointer-events: auto; display: none; background: rgba(14, 17, 14, 0.96); color: #e6ecd8; border: 1px solid #8ca864; border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.78); padding: 10px 12px; font-size: 12px; }',
            '.mdz-cp-head { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(140, 168, 100, 0.35); padding-bottom: 6px; margin-bottom: 8px; font-weight: 700; color: #b8d888; font-size: 12px; }',
            '.mdz-cp-close { cursor: pointer; background: none; border: none; color: #b8d888; font-size: 14px; font-weight: 700; padding: 0 4px; }',
            '.mdz-cp-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px dashed rgba(255, 255, 255, 0.08); }',
            '.mdz-cp-key { background: #263121; color: #d4f0a0; border: 1px solid #6b8848; border-radius: 3px; padding: 1px 6px; font-weight: 700; font-size: 11px; min-width: 58px; text-align: center; }',
            '.mdz-cp-desc { color: #d8dfd0; font-size: 11.5px; text-align: right; }',
            '.mdz-cp-foot { margin-top: 8px; padding-top: 6px; display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #b4c2a4; }',
            '.mdz-cp-foot label { display: flex; align-items: center; gap: 6px; cursor: pointer; }',
            '.mdz-companion-box { margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(140, 168, 100, 0.35); }',
            '.mdz-comp-title { font-weight: 700; color: #ffd54f; font-size: 11.5px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }',
            '.mdz-comp-body { display: flex; align-items: center; gap: 10px; }',
            '#mdz-qr-canvas { width: 104px; height: 104px; border-radius: 4px; image-rendering: pixelated; flex-shrink: 0; border: 1px solid rgba(255, 213, 79, 0.55); background: #fff; }',
            '.mdz-comp-info { display: flex; flex-direction: column; gap: 5px; min-width: 0; flex: 1; }',
            '.mdz-comp-url { background: #1d261a; color: #80deea; border: 1px solid rgba(128, 222, 234, 0.45); border-radius: 4px; padding: 4px 6px; font-size: 11px; font-weight: 700; word-break: break-all; user-select: text; }',
            '.mdz-comp-hint { font-size: 10.5px; color: #a9b89b; line-height: 1.35; }',
            '.mdz-comp-copy { align-self: flex-start; cursor: pointer; background: #263121; color: #d4f0a0; border: 1px solid #6b8848; border-radius: 3px; padding: 2px 8px; font-size: 10.5px; font-weight: 700; font-family: inherit; }',
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
            '  <div class="mdz-companion-box">',
            '    <div class="mdz-comp-title">',
            '      <span>📡 RADAR TÁTICO MOBILE (LAN)</span>',
            '      <span style="font-size:10px;color:#9ccc65;">1Hz SSE</span>',
            '    </div>',
            '    <label class="mdz-cp-foot" style="margin:0 0 6px;padding:0;"><input type="checkbox" id="mdz-comp-toggle" /> Ativar Radar Mobile</label>',
            '    <div class="mdz-comp-body" id="mdz-comp-body" style="display:none;">',
            '      <canvas id="mdz-qr-canvas" title="Escaneie com a câmera do celular"></canvas>',
            '      <div class="mdz-comp-info">',
            '        <div class="mdz-comp-url" id="mdz-comp-url"></div>',
            '        <div class="mdz-comp-hint">Escaneie o QR Code no celular (mesmo Wi-Fi) ou abra no 2º monitor.</div>',
            '        <button type="button" class="mdz-comp-copy" id="mdz-comp-copy">Copiar Link</button>',
            '      </div>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('');

        document.body.appendChild(root);

        tabBtnEl = document.getElementById('mdz-controls-tab');
        panelEl = document.getElementById('mdz-controls-panel');
        pinsLayerEl = document.getElementById('mdz-controls-pins');
        keepPinsCheckEl = document.getElementById('mdz-keep-pins');
        const qrCanvasEl = document.getElementById('mdz-qr-canvas');
        const copyBtnEl = document.getElementById('mdz-comp-copy');

        const toggleEl = document.getElementById('mdz-comp-toggle');
        const compBodyEl = document.getElementById('mdz-comp-body');
        const compUrlEl = document.getElementById('mdz-comp-url');

        function applyCompanionState(st) {
            companionUrl = (st && st.isRunning && st.url) || '';
            toggleEl.checked = !!companionUrl;
            toggleEl.disabled = false;
            compBodyEl.style.display = companionUrl ? 'flex' : 'none';
            compUrlEl.textContent = companionUrl;
            qrCanvasEl.style.display = (companionUrl && renderQrCanvas(qrCanvasEl, companionUrl)) ? "" : "none";
        }

        applyCompanionState(window.__MDZ_COMPANION__);

        toggleEl.addEventListener('change', function () {
            toggleEl.disabled = true;
            window.chrome.webview.postMessage({ action: toggleEl.checked ? 'companion_start' : 'companion_stop' });
        });

        window.addEventListener('CompanionState', function (e) {
            applyCompanionState(e.detail);
        });

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

        if (copyBtnEl) {
            copyBtnEl.addEventListener('click', function () {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(companionUrl).then(function () {
                        copyBtnEl.textContent = 'Copiado!';
                        window.setTimeout(function () { copyBtnEl.textContent = 'Copiar Link'; }, 1500);
                    }).catch(function () {});
                }
            });
        }

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
    // Teclas que o plugin Keyboard do jogo usa (data.js: IsKeyDown W/A/S/D, OnKey Enter) nunca são engolidas.
    const GAME_KEYS = { w: 1, a: 1, s: 1, d: 1, enter: 1 };
    const swallowedCodes = {};

    window.addEventListener('keydown', function (e) {
        const code = e.code || e.key;
        if (swallowedCodes[code]) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (e.repeat || (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))) return;

        const key = e.key.toLowerCase();
        if (GAME_KEYS[key]) return;
        if (triggerKey(key)) {
            swallowedCodes[code] = true;
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);

    window.addEventListener('keyup', function (e) {
        const code = e.code || e.key;
        if (!swallowedCodes[code]) return;
        delete swallowedCodes[code];
        e.preventDefault();
        e.stopPropagation();
    }, true);

    // API global exposta para o host WPF (PcControlsManager.cs)
    window.MDZControls = {
        triggerKey: triggerKey,
        togglePanel: toggleControlsPanel,
        definitions: HUD_BUTTONS
    };
    window.__mdzTriggerKey = triggerKey;
})();

