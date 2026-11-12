/**
 * MiniDayZ PC Port — Extrator de Satélite Global Instantâneo & Deltas 1Hz (Prioridade 09)
 * Localização: wwwroot/companion/radar-telemetry.js
 *
 * - No boot da partida (companion_map_init), inspeciona as instâncias do plugin Array (t518, t525, t703 — via .rd / .arr),
 *   o gerador de setores (t514) e os Tilemaps para extrair 100% da ilha (todos os 16x16 setores, malha viária completa,
 *   todas as construções, bombas d'água, florestas e o verdadeiro Secret Location/Bunkers/Heli/Veículos mesmo fora do FOV).
 * - Conforme o jogador caminha e o Construct 2 instancia novos chunks (Tilemaps/Sprites), acumula e transmite deltas
 *   incrementais (companion_map_delta) sem reenviar o mapa inteiro.
 */
(function () {
    'use strict';

    var POLL_INTERVAL_MS = 1000;
    var THREAT_RADIUS_PX = 2600;
    var NORMAL_ZED_RADIUS_PX = 1050;
    var MAX_NORMAL_ZEDS = 24;
    var TERRAIN_CELL_PX = 120;
    var MAX_GLOBAL_TREES = 2200;
    var PX_PER_METER = 22;

    var MATCH_LAYOUTS = { 'Map': true, 'Tutorial': true, 'Polygon': true };
    var NON_MATCH_LAYOUTS = { 'Menu': true, 'Login': true, 'Loading': true, 'GUI_layout': true };

    var ROAD_TILE_INDICES = {
        0: 1, 1: 1, 2: 1, 4: 1, 5: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1, 12: 1, 15: 1, 16: 1, 20: 1
    };

    // Setores da matriz t518/t514 que possuem estradas ou conexões viárias
    var ROAD_SECTOR_CODES = {
        4: 1, 5: 1, 6: 1, 7: 1, 9: 1, 11: 1, 12: 1, 13: 1, 14: 1,
        15: 1, 16: 1, 17: 1, 21: 1, 22: 1, 30: 1, 31: 1, 70: 1
    };

    // Tabela global de edifícios codificados no Array t525 (cat=7, sub=1..41) -> [roofImg, w, h, kind, label]
    var T525_BUILDING_DEFS = {
        1:  ['b_deer_stand-sheet0.png', 61, 83, 'deer', 'Torre de Caça'],
        2:  ['b_dot-sheet0.png', 87, 111, 'mil', 'Casamata (Bunker DOT)'],
        3:  ['b_garage_blue-sheet0.png', 123, 110, 'gar', 'Garagem'],
        4:  ['b_garage_brown-sheet0.png', 123, 110, 'gar', 'Garagem'],
        5:  ['b_garage_green-sheet0.png', 123, 110, 'gar', 'Garagem'],
        6:  ['b_garage_brown-sheet0.png', 123, 110, 'gar', 'Garagem'],
        7:  ['b_small_shed-sheet0.png', 130, 185, 'barn', 'Galpão'],
        8:  ['b_shed-sheet0.png', 247, 134, 'barn', 'Celeiro'],
        9:  ['b_village_brown-sheet0.png', 172, 156, 'civ', ''],
        10: ['b_village_red-sheet0.png', 175, 155, 'civ', ''],
        11: ['b_village_green-sheet0.png', 137, 134, 'civ', ''],
        12: ['b_village_yellow-sheet0.png', 187, 120, 'civ', ''],
        13: ['b_hostel-sheet0.png', 170, 155, 'civ', 'Albergue'],
        14: ['b_village_yard-sheet0.png', 214, 143, 'civ', ''],
        15: ['b_piano_house-sheet0.png', 248, 236, 'civ', 'Casa do Piano'],
        16: ['b_church-sheet0.png', 296, 532, 'ch', 'Igreja'],
        17: ['b_supermarket-sheet0.png', 275, 161, 'shop', 'Supermercado'],
        18: ['b_school-sheet0.png', 576, 330, 'school', 'Escola'],
        19: ['b_police_station-sheet0.png', 238, 235, 'pol', 'Delegacia'],
        20: ['b_fire_station-sheet0.png', 545, 287, 'fire', 'Corpo de Bombeiros'],
        21: ['b_hospital-sheet0.png', 512, 404, 'med', 'Hospital'],
        22: ['b_hospital-sheet0.png', 512, 404, 'med', 'Hospital'],
        23: ['b_militay_tent-sheet0.png', 138, 91, 'mil', 'Tenda Militar'],
        24: ['b_militay_tent-sheet0.png', 138, 91, 'mil', 'Tenda Militar'],
        25: ['b_military_barrack-sheet0.png', 282, 143, 'mil', 'Quartel Militar'],
        26: ['b_military_shtab-sheet0.png', 353, 197, 'mil', 'QG Militar'],
        27: ['b_city_house_1-sheet0.png', 229, 290, 'civ', ''],
        28: ['b_city_house_2-sheet0.png', 229, 290, 'civ', ''],
        29: ['b_city_house_3-sheet0.png', 386, 288, 'civ', ''],
        30: ['b_city_house_4-sheet0.png', 229, 290, 'civ', ''],
        31: ['b_car_bus-sheet0.png', 206, 95, 'civ', 'Ônibus'],
        32: ['b_village_red2-sheet0.png', 245, 180, 'civ', ''],
        33: ['b_red_brick-sheet0.png', 336, 234, 'civ', 'Prédio de Tijolos'],
        34: ['b_military_barrack2-sheet0.png', 147, 168, 'mil', 'Quartel Militar'],
        35: ['b_hunter_shelter-sheet0.png', 76, 68, 'barn', 'Cabana de Caça'],
        36: ['b_gas_station-sheet0.png', 107, 107, 'gas', 'Posto de Gasolina'],
        37: ['b_gas_station_fueling-sheet0.png', 284, 130, 'gas', 'Posto de Combustível'],
        38: ['b_castle-sheet0.png', 392, 284, 'castle', 'Castelo'],
        39: ['b_gunshop-sheet0.png', 243, 127, 'gun', 'Loja de Armas'],
        40: ['b_militay_tent_east-sheet0.png', 151, 106, 'mil', 'Tenda Militar'],
        41: ['b_bar-sheet0.png', 350, 221, 'bar', 'Bar / Pub']
    };

    // Locais Secretos codificados no Array t525 (cat=4, sub=6..32) — fora do campo de visão!
    var T525_SECRET_SUBTYPES = {
        6:  'Acampamento Secreto',
        7:  'Comboio Destruído',
        8:  'Círculo de Pedras',
        9:  'Estação de Radar',
        10: 'Tanque Blindado KV-2',
        12: 'Torre de Rádio',
        14: 'Veículo Abandonado',
        15: 'Submarino Typhoon',
        16: 'Torre do Castelo',
        17: 'Drone Militar (VANT)',
        18: 'Carro da Bohemia',
        19: 'Árvore Anômala',
        20: 'Suprimento PUBG',
        22: 'Acampamento Stalker',
        23: 'Acampamento Stalker',
        24: 'Acampamento Stalker',
        26: 'Ruínas Antigas',
        27: 'Árvore do Predador',
        28: 'Comboio Emboscado',
        29: 'Comboio Emboscado',
        30: 'Paraquedista Caído',
        31: 'Torre de Caça Secreta',
        32: 'Baú Vermelho Secreto'
    };

    var BUILDING_META = {
        t320: ['mil', 'Quartel Militar'],
        t655: ['mil', 'Quartel Militar'],
        t334: ['mil', 'QG Militar'],
        t341: ['mil', 'Tenda Militar'],
        t890: ['mil', 'Tenda Militar'],
        t430: ['mil', 'Casamata (Bunker DOT)'],
        t335: ['med', 'Hospital'],
        t337: ['pol', 'Delegacia'],
        t338: ['fire', 'Corpo de Bombeiros'],
        t778: ['gas', 'Posto de Gasolina'],
        t779: ['gas', 'Posto de Combustível'],
        t855: ['gun', 'Loja de Armas'],
        t387: ['ch', 'Igreja'],
        t789: ['castle', 'Castelo'],
        t329: ['shop', 'Supermercado'],
        t336: ['school', 'Escola'],
        t959: ['bar', 'Bar / Pub'],
        t333: ['civ', 'Casa do Piano'],
        t328: ['civ', 'Albergue'],
        t651: ['civ', 'Prédio de Tijolos'],
        t327: ['barn', 'Celeiro'],
        t431: ['barn', 'Galpão'],
        t325: ['gar', 'Garagem'],
        t326: ['gar', 'Garagem'],
        t515: ['gar', 'Garagem'],
        t694: ['barn', 'Cabana de Caça'],
        t575: ['civ', 'Ônibus'],
        t307: ['deer', 'Torre de Caça'],
        t442: ['pump', 'Bomba d\'Água'],
        t977: ['bridge', 'Ponte']
    };

    var questItemWarned = {};
    var EE_SECRET_DEFS = [
        { t: 't355', label: 'Estação de Radar' },
        { t: 't695', label: 'Tanque Blindado KV-2' },
        { t: 't697', label: 'Acampamento Secreto' },
        { t: 't698', label: 'Comboio Destruído' },
        { t: 't699', label: 'Árvore Anômala' },
        { t: 't700', label: 'Círculo de Pedras' },
        { t: 't701', label: 'Torre de Rádio' },
        { t: 't708', label: 'Veículo Abandonado' },
        { t: 't781', label: 'Submarino Typhoon' },
        { t: 't790', label: 'Drone Militar (VANT)' },
        { t: 't791', label: 'Torre do Castelo' },
        { t: 't792', label: 'Carro da Bohemia' },
        { t: 't800', label: 'Suprimento PUBG' },
        { t: 't865', label: 'Acampamento Stalker' },
        { t: 't863', label: 'Acampamento Stalker' },
        { t: 't864', label: 'Acampamento Stalker' },
        { t: 't892', label: 'Ruínas Antigas' },
        { t: 't972', label: 'Árvore do Predador' },
        { t: 't985', label: 'Comboio Emboscado' },
        { t: 't986', label: 'Comboio Emboscado' },
        { t: 't993', label: 'Paraquedista Caído' },
        { t: 't1028', label: 'Torre de Caça Secreta' },
        { t: 't1029', label: 'Baú Vermelho Secreto' }
    ];

    var PROP_TYPES = [
        't257', 't258', 't319', 't888', 't889', 't862', 't318', 't567',
        't190', 't484', 't260', 't272', 't237', 't238', 't239',
        't212', 't213', 't214', 't483', 't485', 't486', 't487', 't859', 't860', 't861'
    ];

    var SINGLE_TREE_TYPES = ['t184', 't207', 't209', 't576', 't577', 't581'];
    var GROUND_TILEMAP_TYPES = ['t482', 't687', 't688', 't776', 't980'];
    var ALL_TILEMAP_TYPES = ['t482', 't687', 't688', 't776', 't980', 't418', 't208', 't211', 't784'];

    var THREAT_TYPES = [
        { type: 't850', kind: 'hulk', label: 'Hulk (Tank)', radius: THREAT_RADIUS_PX },
        { type: 't829', kind: 'bandit', label: 'Bandido', radius: THREAT_RADIUS_PX },
        { type: 't252', kind: 'bandit', label: 'Saqueador Armado', radius: THREAT_RADIUS_PX },
        { type: 't547', kind: 'bandit', label: 'Saqueador', radius: THREAT_RADIUS_PX },
        { type: 't556', kind: 'bandit', label: 'Esquadrão Hostil', radius: THREAT_RADIUS_PX },
        { type: 't935', kind: 'special', label: 'Zumbi Saltador', radius: THREAT_RADIUS_PX },
        { type: 't715', kind: 'special', label: 'Screamer', radius: THREAT_RADIUS_PX },
        { type: 't719', kind: 'special', label: 'Zumbi Atirador', radius: THREAT_RADIUS_PX },
        { type: 't720', kind: 'special', label: 'Zumbi Enterrado', radius: THREAT_RADIUS_PX },
        { type: 't279', kind: 'special', label: 'Zumbi Militar', radius: THREAT_RADIUS_PX },
        { type: 't400', kind: 'special', label: 'Zumbi Corredor', radius: THREAT_RADIUS_PX },
        { type: 't475', kind: 'wolf', label: 'Lobo', radius: THREAT_RADIUS_PX },
        { type: 't529', kind: 'ally', label: 'Sobrevivente Neutro/Aliado', radius: THREAT_RADIUS_PX }
    ];

    var ISLAND_NAMES = { 1: 'Ilha 1', 2: 'Ilha 2', 3: 'Ilha 3', 4: 'Ilha 4', 5: 'Ilha 5 (Inverno)' };

    var lastMapKey = '';
    var lastMapHash = '';
    var lastIslandLevel = 1;
    var seenTilemapUids = {};
    var seenBuildingUids = {};
    var gvCacheRt = null;
    var gvByName = {};

    var activeWaypoint = null;
    var wpRafId = 0;
    var companionClients = 0;
    var wpRootEl = null;
    var wpBadgeEl = null;
    var wpArrowEl = null;
    var wpDistEl = null;

    function getRuntime() {
        return typeof window.cr_getC2Runtime === 'function' ? window.cr_getC2Runtime() : null;
    }

    function postIpc(action, payload) {
        if (!(window.chrome && window.chrome.webview)) return;
        try {
            window.chrome.webview.postMessage({ action: action, payload: payload });
        } catch (e) { }
    }

    // Lê uma célula (x, y, z) de qualquer instância do plugin Array do Construct 2 (.rd minificado ou .arr padrão)
    function readC2ArrayCell(arrInst, x, y, z) {
        if (!arrInst) return 0;
        var data = arrInst.rd || arrInst.arr;
        if (!data || !data[x] || !data[x][y]) return 0;
        var v = data[x][y][z || 0];
        return typeof v === 'number' ? v : (parseFloat(v) || 0);
    }

    // Valor cru da célula (string ou número), sem coerção; undefined se não existir
    function readC2ArrayCellRaw(arrInst, x, y, z) {
        if (!arrInst) return undefined;
        var data = arrInst.rd || arrInst.arr;
        if (!data || !data[x] || !data[x][y]) return undefined;
        return data[x][y][z || 0];
    }

    function getC2ArrayWidth(arrInst) {
        if (!arrInst) return 0;
        if (typeof arrInst.hb === 'number') return arrInst.hb;
        if (typeof arrInst.cx === 'number') return arrInst.cx;
        var data = arrInst.rd || arrInst.arr;
        return data ? data.length : 0;
    }

    function getC2ArrayHeight(arrInst) {
        if (!arrInst) return 0;
        if (typeof arrInst.rb === 'number') return arrInst.rb;
        if (typeof arrInst.cy === 'number') return arrInst.cy;
        var data = arrInst.rd || arrInst.arr;
        return (data && data[0]) ? data[0].length : 0;
    }

    function getGlobalVars(rt) {
        if (rt !== gvCacheRt || !gvByName.__ready) {
            gvCacheRt = rt;
            gvByName = { __ready: false };
            var arr = rt && rt.tD;
            if (arr && arr.length) {
                for (var i = 0; i < arr.length; i++) {
                    var gv = arr[i];
                    if (gv && gv.name) gvByName[gv.name] = gv;
                }
                gvByName.__ready = true;
            }
        }
        return gvByName;
    }

    function readGv(gvs, name, fallback) {
        var v = gvs[name];
        return v !== undefined && v !== null && v.data !== undefined ? v.data : fallback;
    }

    function isOnMap(inst, mapW, mapH) {
        if (!inst || typeof inst.x !== 'number' || typeof inst.y !== 'number') return false;
        return inst.x >= 0 && inst.y >= 0 && inst.x <= mapW && inst.y <= mapH;
    }

    function isCoordOnIsland(x, y, mapW, mapH) {
        return typeof x === 'number' && typeof y === 'number' &&
               x >= 20 && y >= 20 && x <= mapW - 20 && y <= mapH - 20;
    }

    function isPoiOnIsland(inst, mapW, mapH) {
        return inst && isCoordOnIsland(inst.x, inst.y, mapW, mapH);
    }

    function normalizeImgFile(rawPath) {
        if (!rawPath || typeof rawPath !== 'string') return '';
        var clean = rawPath.replace(/\\/g, '/');
        var slash = clean.lastIndexOf('/');
        return slash >= 0 ? clean.substring(slash + 1) : clean;
    }

    function isHudInventoryLive(rt) {
        if (!rt || !rt.types || !rt.types['t497'] || !rt.types['t497'].q) return false;
        var arr = rt.types['t497'].q;
        var vw = window.innerWidth || 1024;
        var vh = window.innerHeight || 768;
        var canvas = document.getElementById('c2canvas');
        var rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };

        for (var i = 0; i < arr.length; i++) {
            var inst = arr[i];
            if (!inst || !inst.C || typeof inst.la !== 'function' || typeof inst.C.Ra !== 'function') continue;
            if (inst.C.name === 'stick_controls') continue;
            inst.la();
            var b = inst.ka;
            var lx = (b.left + b.right) * 0.5;
            var ly = (b.top + b.bottom) * 0.5;
            var cx = rect.left + inst.C.Ra(lx, ly, true, false);
            var cy = rect.top + inst.C.Ra(lx, ly, false, false);
            if (cx >= -20 && cx <= vw + 20 && cy >= -20 && cy <= vh + 20) return true;
        }
        return false;
    }

    function isMatchActive(rt, layout) {
        if (!rt || !layout) return false;
        var lname = String(layout.name || '');
        if (NON_MATCH_LAYOUTS[lname]) return false;
        if (MATCH_LAYOUTS[lname]) return true;
        if (isHudInventoryLive(rt)) return true;
        var t181 = rt.types && rt.types['t181'];
        return !!(t181 && t181.q && t181.q.length > 0);
    }

    function findActivePlayer(rt, layout, mapW, mapH) {
        var types = rt && rt.types;
        if (!types) return null;

        var camX = typeof layout.scrollX === 'number' ? layout.scrollX : mapW * 0.5;
        var camY = typeof layout.scrollY === 'number' ? layout.scrollY : mapH * 0.5;

        var candidates = ['t181', 't193'];
        for (var c = 0; c < candidates.length; c++) {
            var t = types[candidates[c]];
            if (!t || !t.q || t.q.length === 0) continue;

            var bestOnMap = null;
            var bestOnMapDist = Infinity;
            var bestAny = null;
            var bestAnyDist = Infinity;

            for (var i = 0; i < t.q.length; i++) {
                var inst = t.q[i];
                if (!inst || typeof inst.x !== 'number' || typeof inst.y !== 'number') continue;
                var dx = inst.x - camX;
                var dy = inst.y - camY;
                var d2 = dx * dx + dy * dy;

                if (d2 < bestAnyDist) {
                    bestAnyDist = d2;
                    bestAny = inst;
                }
                if (isOnMap(inst, mapW, mapH) && d2 < bestOnMapDist) {
                    bestOnMapDist = d2;
                    bestOnMap = inst;
                }
            }

            if (bestOnMap) return bestOnMap;
            if (bestAny) return bestAny;
        }
        return null;
    }

    // Extrai a matriz global 16x16 da ilha combinando o Array t518, o Array auxiliar de estradas t703 e os 256 setores t514 (mapgen)
    function extractGlobalIslandMatrix(rt) {
        var types = rt.types || {};
        var t518 = types['t518'];
        var arr518 = (t518 && t518.q && t518.q.length) ? t518.q[0] : null;

        // t518 é [linha][coluna] no jogo (minimapa compara t518 em (cc[2], cc[1])); matrix aqui é [coluna][linha]
        var cols = getC2ArrayHeight(arr518) || 16;
        var rows = getC2ArrayWidth(arr518) || 16;
        var matrix = [];

        for (var x = 0; x < cols; x++) {
            var col = [];
            for (var y = 0; y < rows; y++) {
                col.push(arr518 ? Math.round(readC2ArrayCell(arr518, y, x, 0)) : 0);
            }
            matrix.push(col);
        }

        // Enriquecimento com t514 (mapgen): cada setor (x, y) possui cc[0] com o código final (ex.: 70 = Bunker, 32/43..49 = Costa)
        var t514 = types['t514'];
        var originX = 190;
        var originY = -190;
        var blockPx = 1020;

        if (t514 && t514.q && t514.q.length) {
            for (var i = 0; i < t514.q.length; i++) {
                var mg = t514.q[i];
                if (!mg || !mg.cc) continue;
                var code = Math.round(Number(mg.cc[0]) || 0);
                var gx = Math.round(Number(mg.cc[1]) || 0);
                var gy = Math.round(Number(mg.cc[2]) || 0);
                if (gx >= 0 && gx < cols && gy >= 0 && gy < rows && code > 0) {
                    if (matrix[gx][gy] === 0 || code === 70 || code === 2 || ROAD_SECTOR_CODES[code]) {
                        matrix[gx][gy] = code;
                    }
                }
            }
        }

        // Extrai trilhas de estradas procedurais conectando os setores da matriz t518 + t703
        var roadSegments = [];
        for (var sx = 0; sx < cols; sx++) {
            for (var sy = 0; sy < rows; sy++) {
                var sc = matrix[sx][sy];
                if (!ROAD_SECTOR_CODES[sc]) continue;

                var cx0 = originX + sx * blockPx + 500;
                var cy0 = originY + sy * blockPx + 500;

                // Conexão Leste
                if (sx + 1 < cols && ROAD_SECTOR_CODES[matrix[sx + 1][sy]]) {
                    if (sc !== 12 && matrix[sx + 1][sy] !== 12) {
                        roadSegments.push([cx0, cy0, cx0 + blockPx, cy0]);
                    }
                }
                // Conexão Sul
                if (sy + 1 < rows && ROAD_SECTOR_CODES[matrix[sx][sy + 1]]) {
                    if (sc !== 13 && matrix[sx][sy + 1] !== 13) {
                        roadSegments.push([cx0, cy0, cx0, cy0 + blockPx]);
                    }
                }
                // Estrada reta horizontal (13 / 31) ou vertical (12 / 30) atravessa o próprio bloco
                if (sc === 13 || sc === 31) {
                    roadSegments.push([originX + sx * blockPx, cy0, originX + (sx + 1) * blockPx, cy0]);
                } else if (sc === 12 || sc === 30) {
                    roadSegments.push([cx0, originY + sy * blockPx, cx0, originY + (sy + 1) * blockPx]);
                }
            }
        }

        // Inspeciona t703 (Array 255x20x1 de conexões auxiliares de estradas)
        var t703 = types['t703'];
        var roadAuxCount = 0;
        if (t703 && t703.q && t703.q.length) {
            var arr703 = t703.q[0];
            var w703 = Math.min(getC2ArrayWidth(arr703), 64);
            var h703 = Math.min(getC2ArrayHeight(arr703), 20);
            for (var ax = 0; ax < w703; ax++) {
                for (var ay = 0; ay < h703; ay++) {
                    if (readC2ArrayCell(arr703, ax, ay, 0) !== 0) roadAuxCount++;
                }
            }
        }

        return {
            cols: cols,
            rows: rows,
            originX: originX,
            originY: originY,
            blockPx: blockPx,
            matrix: matrix,
            roads: roadSegments,
            auxRoads: roadAuxCount
        };
    }

    function stampTilemapCells(rt, typeName, grid, cols, rows, mapW, mapH, code, tileFilter) {
        var t = rt.types && rt.types[typeName];
        if (!t || !t.q) return;

        for (var i = 0; i < t.q.length; i++) {
            var tm = t.q[i];
            if (!tm || tm.width <= 0 || tm.height <= 0) continue;
            if (tm.x + tm.width < 0 || tm.y + tm.height < 0 || tm.x > mapW || tm.y > mapH) continue;

            var tw = tm.jc || 0;
            var th = tm.ic || 0;
            var chunks = tm.Yc;
            if (!chunks || tw <= 0 || th <= 0 || !tm.Xb || !tm.lc) continue;

            for (var cy = 0; cy < chunks.length; cy++) {
                var rowChunks = chunks[cy];
                if (!rowChunks) continue;
                for (var cx = 0; cx < rowChunks.length; cx++) {
                    var ch = rowChunks[cx];
                    if (!ch || !ch.Ff) continue;
                    var ff = ch.Ff;
                    for (var ly = 0; ly < ff.length; ly++) {
                        var tileRow = ff[ly];
                        if (!tileRow) continue;
                        var wy0 = tm.y + (cy * tm.lc + ly) * th;
                        var wy1 = wy0 + th;
                        if (wy1 < 0 || wy0 > mapH) continue;

                        for (var lx = 0; lx < tileRow.length; lx++) {
                            var rawTile = tileRow[lx];
                            if (rawTile === -1 || rawTile === undefined) continue;
                            var tileId = rawTile & 536870911;
                            if (tileFilter && !tileFilter[tileId]) continue;

                            var wx0 = tm.x + (cx * tm.Xb + lx) * tw;
                            var wx1 = wx0 + tw;
                            if (wx1 < 0 || wx0 > mapW) continue;

                            var gx0 = Math.max(0, Math.floor(wx0 / TERRAIN_CELL_PX));
                            var gx1 = Math.min(cols - 1, Math.floor((wx1 - 1) / TERRAIN_CELL_PX));
                            var gy0 = Math.max(0, Math.floor(wy0 / TERRAIN_CELL_PX));
                            var gy1 = Math.min(rows - 1, Math.floor((wy1 - 1) / TERRAIN_CELL_PX));

                            for (var gy = gy0; gy <= gy1; gy++) {
                                var base = gy * cols;
                                for (var gx = gx0; gx <= gx1; gx++) {
                                    grid[base + gx] = code;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    function stampRectObjects(rt, typeName, grid, cols, rows, mapW, mapH, code) {
        var t = rt.types && rt.types[typeName];
        if (!t || !t.q) return;

        for (var i = 0; i < t.q.length; i++) {
            var inst = t.q[i];
            if (!inst || inst.width <= 0 || inst.height <= 0) continue;
            var x0 = inst.x - inst.width * (inst.Mc || 0);
            var y0 = inst.y - inst.height * (inst.Nc || 0);
            var x1 = x0 + inst.width;
            var y1 = y0 + inst.height;
            if (x1 < 0 || y1 < 0 || x0 > mapW || y0 > mapH) continue;

            var gx0 = Math.max(0, Math.floor(x0 / TERRAIN_CELL_PX));
            var gx1 = Math.min(cols - 1, Math.floor((x1 - 1) / TERRAIN_CELL_PX));
            var gy0 = Math.max(0, Math.floor(y0 / TERRAIN_CELL_PX));
            var gy1 = Math.min(rows - 1, Math.floor((y1 - 1) / TERRAIN_CELL_PX));

            for (var gy = gy0; gy <= gy1; gy++) {
                var base = gy * cols;
                for (var gx = gx0; gx <= gx1; gx++) {
                    grid[base + gx] = code;
                }
            }
        }
    }

    function stampLineCells(grid, cols, rows, x0, y0, x1, y1, code) {
        var steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (TERRAIN_CELL_PX * 0.5)));
        for (var s = 0; s <= steps; s++) {
            var t = s / steps;
            var wx = x0 + (x1 - x0) * t;
            var wy = y0 + (y1 - y0) * t;
            var gx = Math.floor(wx / TERRAIN_CELL_PX);
            var gy = Math.floor(wy / TERRAIN_CELL_PX);
            if (gx >= 0 && gx < cols && gy >= 0 && gy < rows) {
                grid[gy * cols + gx] = code;
            }
        }
    }

    function buildTerrainRle(rt, mapW, mapH, blocksInfo) {
        try {
            var cols = Math.max(1, Math.ceil(mapW / TERRAIN_CELL_PX));
            var rows = Math.max(1, Math.ceil(mapH / TERRAIN_CELL_PX));
            var grid = new Uint8Array(cols * rows);

            // 1. Florestas e lagos da matriz global t518 (cobre 100% da ilha no boot)
            if (blocksInfo && blocksInfo.matrix) {
                var bp = blocksInfo.blockPx || 1020;
                for (var bx = 0; bx < blocksInfo.cols; bx++) {
                    for (var by = 0; by < blocksInfo.rows; by++) {
                        var sc = blocksInfo.matrix[bx][by];
                        if (sc === 1 || sc === 8 || sc === 10 || sc === 3) {
                            var fillCode = sc === 3 ? 3 : 1;
                            var wx0 = Math.max(0, blocksInfo.originX + bx * bp);
                            var wy0 = Math.max(0, blocksInfo.originY + by * bp);
                            var gx0 = Math.max(0, Math.floor(wx0 / TERRAIN_CELL_PX));
                            var gx1 = Math.min(cols - 1, Math.floor((wx0 + bp - 1) / TERRAIN_CELL_PX));
                            var gy0 = Math.max(0, Math.floor(wy0 / TERRAIN_CELL_PX));
                            var gy1 = Math.min(rows - 1, Math.floor((wy0 + bp - 1) / TERRAIN_CELL_PX));
                            for (var gy = gy0; gy <= gy1; gy++) {
                                for (var gx = gx0; gx <= gx1; gx++) {
                                    grid[gy * cols + gx] = fillCode;
                                }
                            }
                        }
                    }
                }
            }

            // 2. Tilemaps globais (Florestas t211, Praias t418, Água t208, Bunker t784)
            stampTilemapCells(rt, 't211', grid, cols, rows, mapW, mapH, 1, null);
            stampTilemapCells(rt, 't418', grid, cols, rows, mapW, mapH, 2, null);
            stampTilemapCells(rt, 't208', grid, cols, rows, mapW, mapH, 3, null);
            stampRectObjects(rt, 't976', grid, cols, rows, mapW, mapH, 3);
            stampTilemapCells(rt, 't784', grid, cols, rows, mapW, mapH, 5, null);

            // 3. Rede viária global extraída da matriz t518/t703 + Tilemaps de solo já instanciados
            if (blocksInfo && blocksInfo.roads) {
                for (var r = 0; r < blocksInfo.roads.length; r++) {
                    var seg = blocksInfo.roads[r];
                    stampLineCells(grid, cols, rows, seg[0], seg[1], seg[2], seg[3], 4);
                }
            }
            for (var g = 0; g < GROUND_TILEMAP_TYPES.length; g++) {
                stampTilemapCells(rt, GROUND_TILEMAP_TYPES[g], grid, cols, rows, mapW, mapH, 4, ROAD_TILE_INDICES);
            }
            stampRectObjects(rt, 't974', grid, cols, rows, mapW, mapH, 4);

            var parts = [];
            var cur = grid[0];
            var count = 1;
            for (var i = 1; i < grid.length; i++) {
                if (grid[i] === cur) {
                    count++;
                } else {
                    parts.push(count + ':' + cur);
                    cur = grid[i];
                    count = 1;
                }
            }
            parts.push(count + ':' + cur);

            return { cols: cols, rows: rows, cellPx: TERRAIN_CELL_PX, rle: parts.join(',') };
        } catch (e) {
            return null;
        }
    }

    function pushClusteredPoi(list, x, y, kind, label, minDist) {
        var rx = Math.round(x);
        var ry = Math.round(y);
        var d2Max = minDist * minDist;
        for (var i = 0; i < list.length; i++) {
            var dx = list[i].x - rx;
            var dy = list[i].y - ry;
            if (dx * dx + dy * dy <= d2Max) {
                if (list[i].label === 'Local Secreto' && label !== 'Local Secreto') {
                    list[i].label = label;
                }
                return;
            }
        }
        list.push({ x: rx, y: ry, kind: kind, label: label });
    }

    function islandFromTilemap(rt) {
        if (!rt || !rt.types) return 0;
        for (var ti = 0; ti < GROUND_TILEMAP_TYPES.length; ti++) {
            var tmType = rt.types[GROUND_TILEMAP_TYPES[ti]];
            if (!tmType || !tmType.q || !tmType.q.length) continue;
            var fn = tmType.Ni || (tmType.N && tmType.N.ID) || '';
            var m = /ground_lvl(\d+)/.exec(fn);
            if (m) {
                var det = parseInt(m[1], 10);
                if (det >= 1 && det <= 5) return det;
            }
        }
        return 0;
    }

    var islandMismatchWarned = false;

    function resolveIslandNumber(layout, gvs, rt) {
        try {
            if (layout && layout.name === 'Tutorial') return 0;
            var lvl = Number(readGv(gvs, 'CurrentLevel', -1));
            var byTm = islandFromTilemap(rt);
            if (lvl >= 0 && lvl <= 4) {
                var isl = lvl + 1;
                if (byTm && byTm !== isl && !islandMismatchWarned) {
                    islandMismatchWarned = true;
                    console.warn('[MDZ Island] CurrentLevel=' + lvl + ' mas tilemap=ground_lvl' + byTm);
                }
                return isl;
            }
            return byTm || 1;
        } catch (err) {
            console.warn('[MDZ Island Error]', err);
            return 1;
        }
    }

    function islandName(isl) {
        if (isl === 0) return 'Tutorial';
        return ISLAND_NAMES[isl] || ('Ilha ' + isl);
    }

    function computeMapHash(rt, isl, gvs) {
        try {
            var seed = String(readGv(gvs, 'seedid', ''));
            var arr518 = (rt && rt.types && rt.types['t518'] && rt.types['t518'].q && rt.types['t518'].q[0]) ? rt.types['t518'].q[0] : null;
            var sampleCells = '';
            if (arr518) {
                for (var i = 0; i < 6; i++) {
                    sampleCells += ':' + Math.round(readC2ArrayCell(arr518, i, i, 0));
                }
            }
            var t525Count = (rt && rt.types && rt.types['t525'] && rt.types['t525'].q) ? rt.types['t525'].q.length : 0;
            return 'isl' + isl + ':seed_' + seed + ':arr' + t525Count + sampleCells;
        } catch (err) {
            console.warn('[MDZ MapHash Error]', err);
            return 'isl' + isl + ':fallback';
        }
    }

    // Constrói o pacote inicial COMPLETO da ilha (100% dos setores via Arrays t518, t525, t703 + Tilemaps globais)
    function buildMapInitPayload(rt, layout, gvs, isReset, mapHash, islandNum) {
        var mapW = layout.width || 17850;
        var mapH = layout.height || 20000;
        var types = rt.types || {};

        seenTilemapUids = {};
        seenBuildingUids = {};

        var images = [];
        var imageMap = {};
        var sprites = [];
        var spriteMap = {};

        function regImage(rawPath) {
            var fn = normalizeImgFile(rawPath);
            if (!fn) return -1;
            if (imageMap[fn] !== undefined) return imageMap[fn];
            var idx = images.length;
            images.push(fn);
            imageMap[fn] = idx;
            return idx;
        }

        function regSpriteSheetFull(fn, w, h, ox, oy) {
            var imgIdx = regImage(fn);
            if (imgIdx < 0) return -1;
            var key = imgIdx + ':0:0:' + w + ':' + h + ':' + ox + ':' + oy;
            if (spriteMap[key] !== undefined) return spriteMap[key];
            var sIdx = sprites.length;
            sprites.push([imgIdx, 0, 0, w, h, ox, oy]);
            spriteMap[key] = sIdx;
            return sIdx;
        }

        function regSprite(inst) {
            if (!inst || !inst.mc || !inst.mc.Ni) return -1;
            var mc = inst.mc;
            var imgIdx = regImage(mc.Ni);
            if (imgIdx < 0) return -1;

            var sx = mc.Wj || 0;
            var sy = mc.Xj || 0;
            var sw = mc.width || Math.abs(Math.round(inst.width || 0));
            var sh = mc.height || Math.abs(Math.round(inst.height || 0));
            var ox = Number((typeof inst.Mc === 'number' ? inst.Mc : (mc.Mc || 0.5)).toFixed(3));
            var oy = Number((typeof inst.Nc === 'number' ? inst.Nc : (mc.Nc || 0.5)).toFixed(3));

            var key = imgIdx + ':' + sx + ':' + sy + ':' + sw + ':' + sh + ':' + ox + ':' + oy;
            if (spriteMap[key] !== undefined) return spriteMap[key];
            var sIdx = sprites.length;
            sprites.push([imgIdx, sx, sy, sw, sh, ox, oy]);
            spriteMap[key] = sIdx;
            return sIdx;
        }

        // 1. Matriz Global de Setores e Estradas (t518 + t514 + t703)
        var blocksInfo = extractGlobalIslandMatrix(rt);

        // 2. Tilemaps reais (globais + setores já instanciados)
        var tilemaps = [];
        var baseTileImg = '';
        for (var ti = 0; ti < ALL_TILEMAP_TYPES.length; ti++) {
            var tmName = ALL_TILEMAP_TYPES[ti];
            var tmType = types[tmName];
            if (!tmType || !tmType.q || !tmType.q.length) continue;

            var tmImgFile = normalizeImgFile(tmType.Ni || (tmType.N && tmType.N.ID) || '');
            var tmImgIdx = regImage(tmImgFile);
            if (tmImgIdx < 0) continue;

            for (var qi = 0; qi < tmType.q.length; qi++) {
                var tm = tmType.q[qi];
                if (!tm || tm.width <= 0 || tm.height <= 0 || tm.visible === false) continue;
                if (tm.x + tm.width <= 0 || tm.y + tm.height <= 0 || tm.x >= mapW || tm.y >= mapH) continue;
                if (typeof tm.oF !== 'function') continue;

                var rle = tm.oF();
                if (!rle || rle === '-1' || /^\d+x-1$/.test(rle)) continue;

                if (tm.uid !== undefined) seenTilemapUids[tm.uid] = true;
                if (!baseTileImg && tmImgFile.indexOf('ground_lvl') === 0) {
                    baseTileImg = tmImgFile;
                }

                var tw = tm.jc || 60;
                var th = tm.ic || 60;
                var tmCols = Math.floor(tm.width / tw);
                var tmRows = Math.floor(tm.height / th);
                if (tmCols <= 0 || tmRows <= 0) continue;

                var layerOrder = (tm.C && typeof tm.C.index === 'number') ? tm.C.index : ti;
                tilemaps.push([
                    tmImgIdx, Math.round(tm.x), Math.round(tm.y),
                    tmCols, tmRows, tw, th, rle, layerOrder,
                    tm.Kt || 0, tm.Mt || 0, tm.Lt || 0, tm.Nt || 0
                ]);
            }
        }
        tilemaps.sort(function (a, b) { return a[8] - b[8]; });

        // 3. Tiled Backgrounds geográficos (Pontes, Costa/Água, Heliponto)
        var tiledBgs = [];
        var tbgList = ['t976', 't974', 't1002'];
        for (var bi = 0; bi < tbgList.length; bi++) {
            var tbType = types[tbgList[bi]];
            if (!tbType || !tbType.q) continue;
            var tbImgIdx = regImage(tbType.Ni || (tbType.N && tbType.N.ID) || '');
            if (tbImgIdx < 0) continue;

            for (var bq = 0; bq < tbType.q.length; bq++) {
                var tb = tbType.q[bq];
                if (!tb || tb.width <= 0 || tb.height <= 0) continue;
                var tx0 = tb.x - tb.width * (tb.Mc || 0);
                var ty0 = tb.y - tb.height * (tb.Nc || 0);
                if (tx0 + tb.width <= 0 || ty0 + tb.height <= 0 || tx0 >= mapW || ty0 >= mapH) continue;
                tiledBgs.push([
                    tbImgIdx, Math.round(tb.x), Math.round(tb.y),
                    Math.round(tb.width), Math.round(tb.height),
                    Number((tb.u || 0).toFixed(3)),
                    Number((tb.Mc || 0).toFixed(3)),
                    Number((tb.Nc || 0).toFixed(3))
                ]);
            }
        }

        var buildings = [];
        var buildingCoordKeys = {};
        var props = [];
        var trees = [];
        var secrets = [];
        var crashes = [];
        var bunkers = [];

        function pushBuildingUnique(x, y, w, h, angle, kind, sIdx, label) {
            var rx = Math.round(x);
            var ry = Math.round(y);
            var cellKey = Math.round(rx / 24) + ':' + Math.round(ry / 24) + ':' + kind;
            if (buildingCoordKeys[cellKey] !== undefined) {
                var existingIdx = buildingCoordKeys[cellKey];
                if (sIdx >= 0 && buildings[existingIdx][6] < 0) {
                    buildings[existingIdx][6] = sIdx;
                }
                return;
            }
            buildingCoordKeys[cellKey] = buildings.length;
            buildings.push([rx, ry, Math.round(w), Math.round(h), Number((angle || 0).toFixed(3)), kind, sIdx, label || '']);
        }

        // 4. Construções já instanciadas em cena (t1049 + Torres + Bombas + Pontes)
        function addLiveBuildingInst(inst, fallbackKind) {
            if (!isPoiOnIsland(inst, mapW, mapH)) return;
            if (inst.uid !== undefined) seenBuildingUids[inst.uid] = true;
            var tName = inst.type && inst.type.name ? inst.type.name : '';
            var meta = BUILDING_META[tName];
            var kind = meta ? meta[0] : (fallbackKind || 'civ');
            var label = meta ? meta[1] : '';
            var sIdx = regSprite(inst);
            pushBuildingUnique(inst.x, inst.y, inst.width || 80, inst.height || 80, inst.u || 0, kind, sIdx, label);
        }

        var famBuildings = types['t1049'];
        if (famBuildings && famBuildings.q) {
            for (var fb = 0; fb < famBuildings.q.length; fb++) {
                addLiveBuildingInst(famBuildings.q[fb], 'civ');
            }
        }
        var extraLandmarks = ['t307', 't442', 't977'];
        for (var el = 0; el < extraLandmarks.length; el++) {
            var extT = types[extraLandmarks[el]];
            if (!extT || !extT.q) continue;
            for (var eq = 0; eq < extT.q.length; eq++) {
                addLiveBuildingInst(extT.q[eq], 'civ');
            }
        }

        // 5. INSPEÇÃO GLOBAL DO ARRAY t525 (Todos os 256 setores da ilha, inclusive FORA DO CAMPO DE VISÃO!)
        var t525 = types['t525'];
        var rawGlobalTrees = [];
        if (t525 && t525.q && t525.q.length) {
            var pumpSprIdx = -1;
            var treeBlockSprIdx = -1;

            for (var aIdx = 0; aIdx < t525.q.length; aIdx++) {
                var arr525 = t525.q[aIdx];
                var len525 = getC2ArrayWidth(arr525);
                if (len525 <= 0) continue;

                for (var rIdx = 0; rIdx < len525; rIdx++) {
                    var cat = Math.round(readC2ArrayCell(arr525, rIdx, 0, 0));
                    if (cat <= 0) continue;
                    var sub = Math.round(readC2ArrayCell(arr525, rIdx, 1, 0));
                    var wx = readC2ArrayCell(arr525, rIdx, 2, 0);
                    var wy = readC2ArrayCell(arr525, rIdx, 3, 0);
                    if (!isCoordOnIsland(wx, wy, mapW, mapH)) continue;

                    if (cat === 7) {
                        // Construção em qualquer ponto da ilha (mesmo a 15km do jogador!)
                        var bDef = T525_BUILDING_DEFS[sub];
                        if (bDef) {
                            var roofSIdx = regSpriteSheetFull(bDef[0], bDef[1], bDef[2], 0.5, 0.5);
                            pushBuildingUnique(wx, wy, bDef[1], bDef[2], 0, bDef[3], roofSIdx, bDef[4]);
                        }
                    } else if (cat === 4) {
                        // Local Secreto verdadeiro (1 por ilha) codificado em t525 fora do FOV!
                        var secTitle = T525_SECRET_SUBTYPES[sub];
                        if (secTitle) {
                            pushClusteredPoi(secrets, wx, wy, 'secret', secTitle, 800);
                        } else if (sub === 1 || sub === 2 || sub === 5 || sub === 21 || sub === 25) {
                            props.push([-1, Math.round(wx), Math.round(wy), 46, 18, 0]);
                        }
                    } else if (cat === 3 && sub === 2) {
                        // Bomba d'Água em qualquer vila/cidade da ilha
                        if (pumpSprIdx < 0) pumpSprIdx = regSpriteSheetFull('water_pump-sheet0.png', 40, 47, 0.5, 0.5);
                        pushBuildingUnique(wx, wy, 44, 48, 0, 'pump', pumpSprIdx, 'Bomba d\'Água');
                    } else if (cat === 6) {
                        // Carros estáticos nas ruas de todas as cidades da ilha
                        props.push([-1, Math.round(wx), Math.round(wy), 64, 34, 0]);
                    } else if (cat === 1) {
                        // Florestas (sub 7..10 = tree_block) e árvores (sub 1..6) em toda a ilha
                        if (sub >= 7 && sub <= 10) {
                            if (treeBlockSprIdx < 0) treeBlockSprIdx = regSpriteSheetFull('tree_block-sheet0.png', 146, 166, 0.5, 0.5);
                            trees.push([treeBlockSprIdx, Math.round(wx), Math.round(wy), 146, 166]);
                        } else {
                            rawGlobalTrees.push([Math.round(wx), Math.round(wy)]);
                        }
                    }
                }
            }
        }

        // 6. Props e Árvores já instanciados em cena
        for (var pi = 0; pi < PROP_TYPES.length; pi++) {
            var prType = types[PROP_TYPES[pi]];
            if (!prType || !prType.q) continue;
            for (var pq = 0; pq < prType.q.length; pq++) {
                var pr = prType.q[pq];
                if (!isPoiOnIsland(pr, mapW, mapH)) continue;
                var psIdx = regSprite(pr);
                props.push([psIdx, Math.round(pr.x), Math.round(pr.y), Math.round(pr.width || 48), Math.round(pr.height || 48), Number((pr.u || 0).toFixed(2))]);
            }
        }

        var tBlock = types['t210'];
        if (tBlock && tBlock.q) {
            for (var tbk = 0; tbk < tBlock.q.length; tbk++) {
                var blkInst = tBlock.q[tbk];
                if (!isOnMap(blkInst, mapW, mapH)) continue;
                var bsIdx = regSprite(blkInst);
                trees.push([bsIdx, Math.round(blkInst.x), Math.round(blkInst.y), Math.round(blkInst.width || 146), Math.round(blkInst.height || 166)]);
            }
        }

        if (rawGlobalTrees.length > 0) {
            var gStep = rawGlobalTrees.length > MAX_GLOBAL_TREES ? Math.ceil(rawGlobalTrees.length / MAX_GLOBAL_TREES) : 1;
            var pineSprIdx = regSpriteSheetFull('tree_pine_1-sheet0.png', 66, 98, 0.5, 0.8);
            for (var gt = 0; gt < rawGlobalTrees.length; gt += gStep) {
                trees.push([pineSprIdx, rawGlobalTrees[gt][0], rawGlobalTrees[gt][1], 56, 86]);
            }
        } else {
            var rawTrees = [];
            for (var st = 0; st < SINGLE_TREE_TYPES.length; st++) {
                var stType = types[SINGLE_TREE_TYPES[st]];
                if (!stType || !stType.q) continue;
                for (var sq = 0; sq < stType.q.length; sq++) {
                    var tr = stType.q[sq];
                    if (isPoiOnIsland(tr, mapW, mapH)) rawTrees.push(tr);
                }
            }
            var treeStep = rawTrees.length > MAX_GLOBAL_TREES ? Math.ceil(rawTrees.length / MAX_GLOBAL_TREES) : 1;
            for (var rtIdx = 0; rtIdx < rawTrees.length; rtIdx += treeStep) {
                var trInst = rawTrees[rtIdx];
                var tsIdx = regSprite(trInst);
                trees.push([tsIdx, Math.round(trInst.x), Math.round(trInst.y), Math.round(trInst.width || 52), Math.round(trInst.height || 96)]);
            }
        }

        // 7. Local Secreto instanciado (complementa o que já foi extraído de t525)
        for (var ed = 0; ed < EE_SECRET_DEFS.length; ed++) {
            var eeType = types[EE_SECRET_DEFS[ed].t];
            if (!eeType || !eeType.q) continue;
            for (var ei = 0; ei < eeType.q.length; ei++) {
                var eeInst = eeType.q[ei];
                if (isPoiOnIsland(eeInst, mapW, mapH)) {
                    pushClusteredPoi(secrets, eeInst.x, eeInst.y, 'secret', EE_SECRET_DEFS[ed].label, 800);
                }
            }
        }
        var mt = types['t915'];
        if (mt && mt.q) {
            for (var m = 0; m < mt.q.length; m++) {
                if (isPoiOnIsland(mt.q[m], mapW, mapH)) {
                    pushClusteredPoi(secrets, mt.q[m].x, mt.q[m].y, 'secret', 'Local Secreto', 800);
                }
            }
        }

        // Regra Inegociável de Domínio (MiniDayZ): NO MÁXIMO 1 (UM) Local Secreto verdadeiro por ilha!
        // Se uma condição ou matriz retornar mais de 1 resultado na ilha, é falso positivo (clareiras/destroços comuns).
        if (secrets.length > 1) {
            var namedSecrets = [];
            for (var si = 0; si < secrets.length; si++) {
                if (secrets[si].label && secrets[si].label !== 'Local Secreto') {
                    namedSecrets.push(secrets[si]);
                }
            }
            if (namedSecrets.length >= 1) {
                secrets = [namedSecrets[0]];
            } else {
                secrets = [secrets[0]];
            }
        }

        // 8. Heli Crashes, Humvees Destruídos e Airdrops reais
        var crashDefs = [
            { t: 't246', kind: 'heli', label: 'Queda de Helicóptero' },
            { t: 't441', kind: 'humvee', label: 'Humvee Militar Destruído' },
            { t: 't710', kind: 'airdrop', label: 'Suprimento Aéreo (Airdrop)' }
        ];
        for (var cd = 0; cd < crashDefs.length; cd++) {
            var ct = types[crashDefs[cd].t];
            if (!ct || !ct.q) continue;
            for (var ci = 0; ci < ct.q.length; ci++) {
                var cInst = ct.q[ci];
                if (isPoiOnIsland(cInst, mapW, mapH)) {
                    pushClusteredPoi(crashes, cInst.x, cInst.y, crashDefs[cd].kind, crashDefs[cd].label, 280);
                }
            }
        }

        // 9. Bunkers & Pontos de Evacuação (instâncias t785 + setor código 70 da matriz t518/t514 fora do FOV!)
        var bunkerDefs = [
            { t: 't785', kind: 'bunker', label: 'Entrada do Bunker' },
            { t: 't638', kind: 'evac_boat', label: 'Barco de Evacuação' },
            { t: 't979', kind: 'evac_bridge', label: 'Ponte de Fuga' },
            { t: 't1002', kind: 'evac_heli', label: 'Heliponto de Extração' }
        ];
        for (var bd = 0; bd < bunkerDefs.length; bd++) {
            var bt = types[bunkerDefs[bd].t];
            if (!bt || !bt.q) continue;
            for (var bk = 0; bk < bt.q.length; bk++) {
                var bInst = bt.q[bk];
                if (isPoiOnIsland(bInst, mapW, mapH)) {
                    pushClusteredPoi(bunkers, bInst.x, bInst.y, bunkerDefs[bd].kind, bunkerDefs[bd].label, 260);
                }
            }
        }
        if (blocksInfo && blocksInfo.matrix) {
            for (var bx2 = 0; bx2 < blocksInfo.cols; bx2++) {
                for (var by2 = 0; by2 < blocksInfo.rows; by2++) {
                    if (blocksInfo.matrix[bx2][by2] === 70) {
                        pushClusteredPoi(
                            bunkers,
                            blocksInfo.originX + bx2 * blocksInfo.blockPx + 500,
                            blocksInfo.originY + by2 * blocksInfo.blockPx + 500,
                            'bunker',
                            'Entrada do Bunker',
                            350
                        );
                    }
                }
            }
        }

        var isl = (typeof islandNum === 'number' && islandNum >= 0) ? islandNum : resolveIslandNumber(layout, gvs, rt);
        if (!baseTileImg && isl >= 1 && isl <= 5) {
            baseTileImg = 'ground_lvl' + isl + '_tilemap.png';
            regImage(baseTileImg);
        }

        return {
            layout: String(layout.name || 'Map'),
            width: mapW,
            height: mapH,
            island: isl,
            islandLevel: isl,
            islandName: islandName(isl),
            resetMap: isReset !== false,
            mapHash: mapHash || '',
            difficulty: String(readGv(gvs, 'Difficulty', 'Regular')),
            seed: String(readGv(gvs, 'seedid', '')),
            baseTileImg: baseTileImg,
            images: images,
            sprites: sprites,
            tilemaps: tilemaps,
            tiledBgs: tiledBgs,
            props: props,
            trees: trees,
            blocks: blocksInfo,
            terrain: buildTerrainRle(rt, mapW, mapH, blocksInfo),
            buildings: buildings,
            secrets: secrets,
            crashes: crashes,
            bunkers: bunkers,
            ts: Date.now()
        };
    }

    // Extrai apenas os novos Tilemaps e Sprites de construções que o Construct 2 instanciou conforme o jogador caminhou
    function buildMapDeltaPayload(rt, layout) {
        var mapW = layout.width || 17850;
        var mapH = layout.height || 20000;
        var types = rt.types || {};

        var images = [];
        var imageMap = {};
        var sprites = [];
        var spriteMap = {};
        var newTilemaps = [];
        var newBuildings = [];

        function regImage(rawPath) {
            var fn = normalizeImgFile(rawPath);
            if (!fn) return -1;
            if (imageMap[fn] !== undefined) return imageMap[fn];
            var idx = images.length;
            images.push(fn);
            imageMap[fn] = idx;
            return idx;
        }

        function regSprite(inst) {
            if (!inst || !inst.mc || !inst.mc.Ni) return -1;
            var mc = inst.mc;
            var imgIdx = regImage(mc.Ni);
            if (imgIdx < 0) return -1;
            var sx = mc.Wj || 0;
            var sy = mc.Xj || 0;
            var sw = mc.width || Math.abs(Math.round(inst.width || 0));
            var sh = mc.height || Math.abs(Math.round(inst.height || 0));
            var ox = Number((typeof inst.Mc === 'number' ? inst.Mc : (mc.Mc || 0.5)).toFixed(3));
            var oy = Number((typeof inst.Nc === 'number' ? inst.Nc : (mc.Nc || 0.5)).toFixed(3));
            var key = imgIdx + ':' + sx + ':' + sy + ':' + sw + ':' + sh + ':' + ox + ':' + oy;
            if (spriteMap[key] !== undefined) return spriteMap[key];
            var sIdx = sprites.length;
            sprites.push([imgIdx, sx, sy, sw, sh, ox, oy]);
            spriteMap[key] = sIdx;
            return sIdx;
        }

        for (var ti = 0; ti < GROUND_TILEMAP_TYPES.length; ti++) {
            var tmType = types[GROUND_TILEMAP_TYPES[ti]];
            if (!tmType || !tmType.q) continue;
            var tmImgFile = normalizeImgFile(tmType.Ni || (tmType.N && tmType.N.ID) || '');

            for (var qi = 0; qi < tmType.q.length; qi++) {
                var tm = tmType.q[qi];
                if (!tm || tm.uid === undefined || seenTilemapUids[tm.uid]) continue;
                if (tm.width <= 0 || tm.height <= 0 || tm.visible === false) continue;
                if (tm.x + tm.width <= 0 || tm.y + tm.height <= 0 || tm.x >= mapW || tm.y >= mapH) continue;
                if (typeof tm.oF !== 'function') continue;

                var rle = tm.oF();
                if (!rle || rle === '-1' || /^\d+x-1$/.test(rle)) continue;

                seenTilemapUids[tm.uid] = true;
                var tmImgIdx = regImage(tmImgFile);
                if (tmImgIdx < 0) continue;

                var tw = tm.jc || 60;
                var th = tm.ic || 60;
                var tmCols = Math.floor(tm.width / tw);
                var tmRows = Math.floor(tm.height / th);
                if (tmCols <= 0 || tmRows <= 0) continue;

                var layerOrder = (tm.C && typeof tm.C.index === 'number') ? tm.C.index : ti;
                newTilemaps.push([
                    tmImgIdx, Math.round(tm.x), Math.round(tm.y),
                    tmCols, tmRows, tw, th, rle, layerOrder,
                    tm.Kt || 0, tm.Mt || 0, tm.Lt || 0, tm.Nt || 0
                ]);
            }
        }

        var famBuildings = types['t1049'];
        if (famBuildings && famBuildings.q) {
            for (var fb = 0; fb < famBuildings.q.length; fb++) {
                var inst = famBuildings.q[fb];
                if (!inst || inst.uid === undefined || seenBuildingUids[inst.uid]) continue;
                if (!isPoiOnIsland(inst, mapW, mapH)) continue;
                seenBuildingUids[inst.uid] = true;
                var tName = inst.type && inst.type.name ? inst.type.name : '';
                var meta = BUILDING_META[tName];
                var kind = meta ? meta[0] : 'civ';
                var label = meta ? meta[1] : '';
                var sIdx = regSprite(inst);
                newBuildings.push([
                    Math.round(inst.x), Math.round(inst.y),
                    Math.round(inst.width || 80), Math.round(inst.height || 80),
                    Number((inst.u || 0).toFixed(3)), kind, sIdx, label
                ]);
            }
        }

        if (newTilemaps.length === 0 && newBuildings.length === 0) return null;
        return {
            images: images,
            sprites: sprites,
            tilemaps: newTilemaps,
            buildings: newBuildings,
            ts: Date.now()
        };
    }

    function extractQuestData(rt, layout, gvs, player, mapW, mapH) {
        var defaultQuest = {
            active: false,
            status: 0,
            statusText: 'Inativa',
            taskId: 0,
            targetSid: 0,
            rewardId: 0,
            itemName: '',
            taskTitle: '',
            taskDesc: '',
            npc: null,
            target: null,
            giver: null,
            givers: [],
            items: []
        };

        try {
            var qStatus = Number(readGv(gvs, 'Q_status', 0)) || 0;
            var qTaskId = Number(readGv(gvs, 'Q_task_id', 0)) || 0;
            var qTargetSid = Number(readGv(gvs, 'Q_target_sid', 0)) || 0;
            var qRewardId = Number(readGv(gvs, 'Q_reward_id', 0)) || 0;
            var types = (rt && rt.types) || {};

            var px = (player && typeof player.x === 'number') ? player.x : 0;
            var py = (player && typeof player.y === 'number') ? player.y : 0;

            var questGivers = [];
            var seenGivers = {};
            function addGiver(x, y, uid, name) {
                if (typeof x !== 'number' || typeof y !== 'number') return;
                if (!isPoiOnIsland({ x: x, y: y }, mapW, mapH)) return;
                var rx = Math.round(x);
                var ry = Math.round(y);
                var key = Math.round(rx / 40) + ':' + Math.round(ry / 40);
                if (seenGivers[key]) return;
                seenGivers[key] = true;
                questGivers.push({
                    uid: uid,
                    x: rx,
                    y: ry,
                    name: name || 'Sobrevivente Neutro'
                });
            }

            var nm = types['t634'];
            if (nm && nm.q) {
                for (var nmi = 0; nmi < nm.q.length; nmi++) {
                    var nInst = nm.q[nmi];
                    if (nInst && nInst.visible !== false) {
                        addGiver(nInst.x, nInst.y, nInst.uid, 'Sobrevivente (Missão)');
                    }
                }
            }
            var bf = types['t529'];
            if (bf && bf.q) {
                for (var bfi = 0; bfi < bf.q.length; bfi++) {
                    var fInst = bf.q[bfi];
                    if (fInst && fInst.visible !== false) {
                        addGiver(fInst.x, fInst.y, fInst.uid, 'Sobrevivente Neutro');
                    }
                }
            }

            var primaryGiver = null;
            if (questGivers.length > 0) {
                var minDistGiver = Infinity;
                for (var qgi = 0; qgi < questGivers.length; qgi++) {
                    var gdx = questGivers[qgi].x - px;
                    var gdy = questGivers[qgi].y - py;
                    var gd2 = gdx * gdx + gdy * gdy;
                    if (gd2 < minDistGiver) {
                        minDistGiver = gd2;
                        primaryGiver = questGivers[qgi];
                    }
                }
            }

            var questItemName = '';
            if (qTaskId === 3 || qTargetSid === 88) {
                questItemName = 'Maleta Secreta';
            } else if (qTargetSid > 0) {
                if (types['t540'] && types['t540'].q && types['t540'].q[0]) {
                    try {
                        var c2Name = readC2ArrayCellRaw(types['t540'].q[0], qTargetSid, 0, 0);
                        if (typeof c2Name === 'string' && c2Name.trim().length > 0) {
                            questItemName = c2Name.trim();
                        }
                    } catch (e) { }
                }
                if (!questItemName) {
                    var FALLBACK_ITEMS = {
                        4: 'Bandagem', 10: 'Tetraciclina', 25: 'Comida Enlatada', 35: 'Sinalizador',
                        36: 'Munição', 46: 'Garrafa de Vodka', 53: 'Bolsa Térmica', 59: 'Caixa de Ferramentas',
                        60: 'Fósforos', 71: 'Fita Adesiva', 88: 'Maleta Secreta'
                    };
                    if (!FALLBACK_ITEMS[qTargetSid] && !questItemWarned[qTargetSid]) {
                        questItemWarned[qTargetSid] = true;
                        console.warn('[MDZ Quest] item sem nome no t540 e sem fallback, id ' + qTargetSid);
                    }
                    questItemName = FALLBACK_ITEMS[qTargetSid] || ('Item #' + qTargetSid);
                }
            }

            var taskTitle = '';
            var taskDesc = '';
            if (qTaskId === 1) {
                taskTitle = 'Buscar: ' + questItemName;
                taskDesc = 'Entregue ' + questItemName + ' ao sobrevivente';
            } else if (qTaskId === 2) {
                taskTitle = 'Eliminar Bandidos';
                taskDesc = 'Elimine o acampamento de bandidos';
            } else if (qTaskId === 3) {
                taskTitle = 'Recuperar Maleta Secreta';
                taskDesc = 'Encontre a maleta e leve ao sobrevivente';
            } else if (qStatus > 0) {
                taskTitle = 'Missão de Sobrevivente';
                taskDesc = 'Conclua a tarefa para receber recompensa';
            }

            var qStatusText = 'Inativa';
            if (qStatus === 1) qStatusText = 'Disponível';
            else if (qStatus === 2) qStatusText = 'Em Andamento';
            else if (qStatus === 4) qStatusText = 'Pronto para Entregar!';
            else if (qStatus === 5) qStatusText = 'Concluída';

            var questItems = [];
            var seenItemCoord = {};
            function addQuestItem(x, y, name, uid) {
                if (typeof x !== 'number' || typeof y !== 'number') return;
                if (!isPoiOnIsland({ x: x, y: y }, mapW, mapH)) return;
                var ix = Math.round(x);
                var iy = Math.round(y);
                var key = ix + ':' + iy;
                if (seenItemCoord[key]) return;
                seenItemCoord[key] = true;
                questItems.push({
                    uid: uid,
                    x: ix,
                    y: iy,
                    name: name
                });
            }

            if ((qStatus === 1 || qStatus === 2 || qStatus === 4) && (qTaskId === 1 || qTaskId === 3 || qTargetSid > 0)) {
                if (qTaskId === 3 || qTargetSid === 88) {
                    var qc = types['t838'];
                    if (qc && qc.q) {
                        for (var qci = 0; qci < qc.q.length; qci++) {
                            var qcInst = qc.q[qci];
                            if (qcInst && qcInst.visible !== false) {
                                addQuestItem(qcInst.x, qcInst.y, 'Maleta Secreta', qcInst.uid);
                            }
                        }
                    }
                }

                var famItems = types['t1039'];
                if (famItems && famItems.q) {
                    for (var fmi = 0; fmi < famItems.q.length; fmi++) {
                        var itInst = famItems.q[fmi];
                        if (!itInst || itInst.visible === false) continue;
                        var match = false;
                        if (itInst.cc && Array.isArray(itInst.cc)) {
                            if (itInst.cc[0] === qTargetSid || itInst.cc[1] === qTargetSid || itInst.cc[2] === qTargetSid) {
                                match = true;
                            }
                        }
                        if (!match && (qTaskId === 3 || qTargetSid === 88) && itInst.type && itInst.type.name === 't838') {
                            match = true;
                        }
                        if (match) {
                            addQuestItem(itInst.x, itInst.y, questItemName, itInst.uid);
                        }
                    }
                }

                var ITEM_TYPES_MAP = {
                    4: 't451', 10: 't454', 25: 't459', 35: 't467', 36: 't468',
                    46: 't473', 53: 't476', 59: 't447', 60: 't448', 71: 't619', 88: 't838'
                };
                var directType = ITEM_TYPES_MAP[qTargetSid];
                if (directType && types[directType] && types[directType].q) {
                    for (var dti = 0; dti < types[directType].q.length; dti++) {
                        var dtInst = types[directType].q[dti];
                        if (dtInst && dtInst.visible !== false) {
                            addQuestItem(dtInst.x, dtInst.y, questItemName, dtInst.uid);
                        }
                    }
                }

                var t525Obj = types['t525'];
                if (t525Obj && t525Obj.q && t525Obj.q.length) {
                    for (var aIdx = 0; aIdx < t525Obj.q.length; aIdx++) {
                        var arr525 = t525Obj.q[aIdx];
                        var len525 = getC2ArrayWidth(arr525);
                        if (len525 <= 0) continue;
                        for (var rIdx = 0; rIdx < len525; rIdx++) {
                            var cat = Math.round(readC2ArrayCell(arr525, rIdx, 0, 0));
                            var sub = Math.round(readC2ArrayCell(arr525, rIdx, 1, 0));
                            if ((cat === 5 || cat === 2) && (sub === qTargetSid || (qTaskId === 3 && sub === 88))) {
                                var wx = readC2ArrayCell(arr525, rIdx, 2, 0);
                                var wy = readC2ArrayCell(arr525, rIdx, 3, 0);
                                addQuestItem(wx, wy, questItemName, null);
                            }
                        }
                    }
                }
            }

            var questTarget = null;
            if (qTaskId === 3 || qTargetSid === 88) {
                if (types['t838'] && types['t838'].q && types['t838'].q.length > 0) {
                    var qCase = types['t838'].q[0];
                    questTarget = { x: Math.round(qCase.x), y: Math.round(qCase.y), kind: 'quest_target', label: 'Maleta Secreta' };
                }
            } else if (qTaskId === 2) {
                var banditTypes = ['t829', 't252', 't547', 't556'];
                for (var bti = 0; bti < banditTypes.length; bti++) {
                    var btObj = types[banditTypes[bti]];
                    if (btObj && btObj.q && btObj.q.length > 0) {
                        var bInst = btObj.q[0];
                        questTarget = { x: Math.round(bInst.x), y: Math.round(bInst.y), kind: 'quest_target', label: 'Acampamento de Bandidos' };
                        break;
                    }
                }
            }

            var questNpc = primaryGiver ? { x: primaryGiver.x, y: primaryGiver.y, kind: 'quest_npc', label: primaryGiver.name, status: qStatus } : null;

            return {
                questNpc: questNpc,
                questTarget: questTarget,
                questItem: (questItems.length > 0 ? questItems[0] : null),
                questItems: questItems,
                quest: {
                    active: qStatus > 0,
                    status: qStatus,
                    statusText: qStatusText,
                    taskId: qTaskId,
                    targetSid: qTargetSid,
                    rewardId: qRewardId,
                    itemName: questItemName,
                    taskTitle: taskTitle,
                    taskDesc: taskDesc,
                    npc: questNpc,
                    target: questTarget,
                    giver: questNpc,
                    givers: questGivers,
                    items: questItems
                }
            };
        } catch (err) {
            return {
                questNpc: null,
                questTarget: null,
                questItem: null,
                questItems: [],
                quest: defaultQuest
            };
        }
    }

    function buildTickPayload(rt, layout, gvs, player, isReset, curMapHash, curIslandNum) {
        var mapW = (layout && layout.width) || 17850;
        var mapH = (layout && layout.height) || 20000;
        var types = (rt && rt.types) || {};

        var isResetMap = Boolean(isReset);
        var currentHash = (typeof curMapHash === 'string') ? curMapHash : '';
        var resolvedIsl = (typeof curIslandNum === 'number' && curIslandNum >= 0) ? curIslandNum : resolveIslandNumber(layout, gvs, rt);

        var px = (player && typeof player.x === 'number') ? Math.round(player.x) : 0;
        var py = (player && typeof player.y === 'number') ? Math.round(player.y) : 0;
        var cc = (player && player.cc) || [];

        var hp = typeof cc[15] === 'number' ? Math.max(0, Math.min(100, Math.round(cc[15]))) : 100;
        var water = typeof cc[14] === 'number' ? Math.max(0, Math.min(100, Math.round(cc[14]))) : 100;
        var food = typeof cc[13] === 'number' ? Math.max(0, Math.min(100, Math.round(cc[13]))) : 100;
        var temp = Math.round(Number(readGv(gvs, 'Player_temperature', 0)) || 0);

        var vehicles = [];
        var vehDefs = [
            { t: 't809', kind: 'uaz', label: 'UAZ Militar' },
            { t: 't815', kind: 'volga', label: 'Sedan Volga' },
            { t: 't920', kind: 'humvee', label: 'Humvee Blindado' }
        ];
        for (var vd = 0; vd < vehDefs.length; vd++) {
            var vt = types[vehDefs[vd].t];
            if (!vt || !vt.q) continue;
            for (var vi = 0; vi < vt.q.length; vi++) {
                var vInst = vt.q[vi];
                if (isPoiOnIsland(vInst, mapW, mapH)) {
                    vehicles.push({
                        uid: vInst.uid,
                        x: Math.round(vInst.x),
                        y: Math.round(vInst.y),
                        kind: vehDefs[vd].kind,
                        label: vehDefs[vd].label
                    });
                }
            }
        }

        var tents = [];
        var tentDefs = [
            { t: 't397', label: 'Tenda Civil' },
            { t: 't398', label: 'Tenda Civil' },
            { t: 't995', label: 'Esconderijo (Stash)' }
        ];
        for (var td = 0; td < tentDefs.length; td++) {
            var tt = types[tentDefs[td].t];
            if (!tt || !tt.q) continue;
            for (var ti2 = 0; ti2 < tt.q.length; ti2++) {
                var tInst = tt.q[ti2];
                if (isPoiOnIsland(tInst, mapW, mapH)) {
                    pushClusteredPoi(tents, tInst.x, tInst.y, 'tent', tentDefs[td].label, 48);
                }
            }
        }

        var threats = [];
        for (var k = 0; k < THREAT_TYPES.length; k++) {
            var def = THREAT_TYPES[k];
            var et = types[def.type];
            if (!et || !et.q) continue;
            var r2 = def.radius * def.radius;

            for (var ei = 0; ei < et.q.length; ei++) {
                var ent = et.q[ei];
                if (!ent || typeof ent.x !== 'number' || typeof ent.y !== 'number') continue;
                var dx = ent.x - px;
                var dy = ent.y - py;
                if (dx * dx + dy * dy <= r2) {
                    threats.push({
                        uid: ent.uid,
                        x: Math.round(ent.x),
                        y: Math.round(ent.y),
                        kind: def.kind,
                        label: def.label
                    });
                }
            }
        }

        var zt = types['t256'];
        if (zt && zt.q) {
            var zr2 = NORMAL_ZED_RADIUS_PX * NORMAL_ZED_RADIUS_PX;
            var zCount = 0;
            for (var zi = 0; zi < zt.q.length && zCount < MAX_NORMAL_ZEDS; zi++) {
                var zEnt = zt.q[zi];
                if (!zEnt || typeof zEnt.x !== 'number' || typeof zEnt.y !== 'number') continue;
                var zdx = zEnt.x - px;
                var zdy = zEnt.y - py;
                if (zdx * zdx + zdy * zdy <= zr2) {
                    threats.push({
                        uid: zEnt.uid,
                        x: Math.round(zEnt.x),
                        y: Math.round(zEnt.y),
                        kind: 'zed',
                        label: 'Infectado'
                    });
                    zCount++;
                }
            }
        }

        var hrs = Math.floor(Number(readGv(gvs, 'Timer_Hours', 12)) || 0);
        var mins = Math.floor(Number(readGv(gvs, 'Timer_Minutes', 0)) || 0);
        var padH = hrs < 10 ? '0' + hrs : String(hrs);
        var padM = mins < 10 ? '0' + mins : String(mins);

        var qData = extractQuestData(rt, layout, gvs, player, mapW, mapH);

        return {
            layout: String((layout && layout.name) || 'Map'),
            mapWidth: mapW,
            mapHeight: mapH,
            island: resolvedIsl,
            islandLevel: resolvedIsl,
            islandName: islandName(resolvedIsl),
            resetMap: isResetMap,
            mapHash: currentHash,
            player: {
                x: px,
                y: py,
                angle: Number(((player && player.u) || 0).toFixed(3)),
                hp: hp,
                water: water,
                food: food,
                temp: temp,
                inBunker: Number(readGv(gvs, 'inBunker', 0)) === 1,
                day: Number(readGv(gvs, 'Day_survived', 1)) || 1,
                clock: padH + ':' + padM,
                xp: Math.round(Number(readGv(gvs, 'expierence_points', 0)) || 0),
                xpGoal: Math.round(Number(readGv(gvs, 'perk_cost', 100)) || 100),
                perks: Number(readGv(gvs, 'perks_learnt_count', 0)) || 0,
                karma: Number(readGv(gvs, 'karma_points', -11)),
                zedKills: Number(readGv(gvs, 'Stats_Zeds_killed', 0)) || 0,
                banditKills: Number(readGv(gvs, 'Stats_Bandits_killed', 0)) || 0
            },
            quest_npc: qData.questNpc,
            quest_target: qData.questTarget,
            quest_item: qData.questItem,
            quest_items: qData.questItems,
            quest: qData.quest,
            vehicles: vehicles,
            tents: tents,
            threats: threats,
            ts: Date.now()
        };
    }

    function pollTelemetry() {
        try {
            if (companionClients <= 0) return;
            var rt = getRuntime();
            if (!rt || !rt.wa) return;

            var layout = rt.wa;
            if (!isMatchActive(rt, layout)) {
                lastMapKey = '';
                lastMapHash = '';
                seenTilemapUids = {};
                seenBuildingUids = {};
                if (wpBadgeEl) wpBadgeEl.style.display = 'none';
                return;
            }

            var gvs = getGlobalVars(rt);
            if (Number(readGv(gvs, 'level_loading', 0)) === 1) return;

            var mapW = layout.width || 17850;
            var mapH = layout.height || 20000;
            var player = findActivePlayer(rt, layout, mapW, mapH);
            if (!player) return;

            var isl = resolveIslandNumber(layout, gvs, rt);
            var mapHash = computeMapHash(rt, isl, gvs);
            var isIslandChanged = (lastMapHash !== '' && mapHash !== lastMapHash) ||
                                  (lastIslandLevel > 0 && isl !== lastIslandLevel);

            var mapKey = String(layout.name) + ':' + isl + ':' + mapHash + ':' + mapW + 'x' + mapH;

            if (mapKey !== lastMapKey || isIslandChanged) {
                lastMapKey = mapKey;
                lastMapHash = mapHash;
                lastIslandLevel = isl;
                seenTilemapUids = {};
                seenBuildingUids = {};
                postIpc('companion_map_init', buildMapInitPayload(rt, layout, gvs, isIslandChanged, mapHash, isl));
            } else {
                var delta = buildMapDeltaPayload(rt, layout);
                if (delta) {
                    postIpc('companion_map_delta', delta);
                }
            }

            postIpc('companion_tick', buildTickPayload(rt, layout, gvs, player, isIslandChanged, mapHash, isl));
        } catch (err) {
            console.warn('[MDZ Telemetry Warning]', err);
        }
    }

    // =========================================================================
    // WAYPOINT HUD DIRECIONAL NA TELA DO PC (TWO-WAY SYNC DO CELULAR)
    // =========================================================================
    function ensureWaypointHud() {
        if (wpRootEl) return;

        var style = document.createElement('style');
        style.id = 'mdz-waypoint-style';
        style.textContent = [
            '#mdz-waypoint-root { position: fixed; inset: 0; pointer-events: none; z-index: 99990; font-family: Consolas, "Segoe UI", monospace; }',
            '#mdz-waypoint-badge { position: fixed; left: 0; top: 0; display: none; transform: translate(-50%, -50%); align-items: center; gap: 6px; background: rgba(14, 18, 12, 0.88); color: #ffd54f; border: 1.5px solid #ffd54f; border-radius: 999px; padding: 3px 9px; font-size: 11.5px; font-weight: 700; box-shadow: 0 2px 10px rgba(0,0,0,0.85); white-space: nowrap; }',
            '#mdz-waypoint-badge.is-onscreen { background: rgba(14, 18, 12, 0.72); border-color: #4dd0e1; color: #80deea; }',
            '#mdz-waypoint-arrow { display: inline-block; font-size: 13px; line-height: 1; transform-origin: center; }'
        ].join('\n');
        document.head.appendChild(style);

        wpRootEl = document.createElement('div');
        wpRootEl.id = 'mdz-waypoint-root';
        wpRootEl.innerHTML = '<div id="mdz-waypoint-badge"><span id="mdz-waypoint-arrow">➤</span><span id="mdz-waypoint-dist">WP</span></div>';
        document.body.appendChild(wpRootEl);

        wpBadgeEl = document.getElementById('mdz-waypoint-badge');
        wpArrowEl = document.getElementById('mdz-waypoint-arrow');
        wpDistEl = document.getElementById('mdz-waypoint-dist');
    }

    var WP_MIN_FRAME_MS = 1000 / 12;
    var wpLastFrameTs = 0;
    var wpCanvasRect = null;
    var wpLast = { display: '', cls: null, tx: null, arrow: null, rot: null, dist: null };

    function refreshWpCanvasRect() {
        var canvas = document.getElementById('c2canvas');
        wpCanvasRect = canvas ? canvas.getBoundingClientRect() : null;
    }
    window.addEventListener('resize', refreshWpCanvasRect);

    function wpSetDisplay(v) {
        if (wpLast.display === v) return;
        wpLast.display = v;
        wpBadgeEl.style.display = v;
    }

    function wpSetBadge(x, y, onscreen, arrowText, rot, distText) {
        var tx = 'translate(' + x + 'px,' + y + 'px) translate(-50%,-50%)';
        if (wpLast.tx !== tx) { wpLast.tx = tx; wpBadgeEl.style.transform = tx; }
        if (wpLast.cls !== onscreen) { wpLast.cls = onscreen; wpBadgeEl.classList.toggle('is-onscreen', onscreen); }
        if (wpLast.arrow !== arrowText) { wpLast.arrow = arrowText; wpArrowEl.textContent = arrowText; }
        if (wpLast.rot !== rot) { wpLast.rot = rot; wpArrowEl.style.transform = rot; }
        if (wpLast.dist !== distText) { wpLast.dist = distText; wpDistEl.textContent = distText; }
    }

    function updateWaypointFrame(ts) {
        if (!activeWaypoint) {
            wpRafId = 0;
            if (wpBadgeEl) wpSetDisplay('none');
            return;
        }

        if (ts - wpLastFrameTs < WP_MIN_FRAME_MS) {
            wpRafId = window.requestAnimationFrame(updateWaypointFrame);
            return;
        }
        wpLastFrameTs = ts;

        ensureWaypointHud();

        var rt = getRuntime();
        var layout = rt && rt.wa;
        if (!layout || !isMatchActive(rt, layout)) {
            wpSetDisplay('none');
            wpRafId = window.requestAnimationFrame(updateWaypointFrame);
            return;
        }

        var player = findActivePlayer(rt, layout, layout.width || 17850, layout.height || 20000);
        if (!player) {
            wpSetDisplay('none');
            wpRafId = window.requestAnimationFrame(updateWaypointFrame);
            return;
        }

        var dx = activeWaypoint.x - player.x;
        var dy = activeWaypoint.y - player.y;
        var distPx = Math.sqrt(dx * dx + dy * dy);
        var distText = Math.round(distPx / PX_PER_METER) + 'm';

        var vw = window.innerWidth || 1024;
        var vh = window.innerHeight || 768;
        if (!wpCanvasRect) refreshWpCanvasRect();
        var rect = wpCanvasRect || { left: 0, top: 0, width: vw, height: vh };

        var sx = vw * 0.5;
        var sy = vh * 0.5;
        var hasLayerProj = player.C && typeof player.C.Ra === 'function';
        if (hasLayerProj) {
            sx = rect.left + player.C.Ra(activeWaypoint.x, activeWaypoint.y, true, false);
            sy = rect.top + player.C.Ra(activeWaypoint.x, activeWaypoint.y, false, false);
        }

        var padX = 56;
        var padY = 46;
        var inside = hasLayerProj && sx >= padX && sx <= (vw - padX) && sy >= padY && sy <= (vh - padY);

        wpSetDisplay('inline-flex');
        if (inside) {
            wpSetBadge(Math.round(sx), Math.round(sy - 26), true, '◆', 'none', distText);
        } else {
            var angle = Math.atan2(dy, dx);
            var cos = Math.cos(angle);
            var sin = Math.sin(angle);
            var halfW = (vw * 0.5) - padX;
            var halfH = (vh * 0.5) - padY;
            var tx = Math.abs(cos) > 1e-5 ? halfW / Math.abs(cos) : 1e9;
            var ty = Math.abs(sin) > 1e-5 ? halfH / Math.abs(sin) : 1e9;
            var t = Math.min(tx, ty);

            var edgeX = (vw * 0.5) + cos * t;
            var edgeY = (vh * 0.5) + sin * t;
            var deg = (angle * 180 / Math.PI).toFixed(1);

            wpSetBadge(Math.round(edgeX), Math.round(edgeY), false, '➤', 'rotate(' + deg + 'deg)', distText);
        }

        wpRafId = window.requestAnimationFrame(updateWaypointFrame);
    }

    function setWaypoint(wp) {
        if (!wp || wp.clear || typeof wp.x !== 'number' || typeof wp.y !== 'number') {
            activeWaypoint = null;
            if (wpBadgeEl) wpSetDisplay('none');
            return;
        }
        activeWaypoint = { x: wp.x, y: wp.y };
        if (!wpRafId) {
            wpRafId = window.requestAnimationFrame(updateWaypointFrame);
        }
    }

    window.addEventListener('CompanionClients', function (e) {
        var n = Number(e && e.detail) || 0;
        var was = companionClients;
        companionClients = n;
        if (was <= 0 && n > 0) window.MDZCompanionTelemetry.forceMapResend();
    });

    window.addEventListener('CompanionWaypoint', function (e) {
        setWaypoint(e && e.detail ? e.detail : null);
    });

    window.setInterval(pollTelemetry, POLL_INTERVAL_MS);

    window.MDZCompanionTelemetry = {
        setWaypoint: setWaypoint,
        forceMapResend: function () {
            lastMapKey = '';
            pollTelemetry();
        }
    };
})();
