// ==UserScript==
// @name         eBird 添加中文鸟名
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  在 eBird 网站上将鸟名改为“英文名(中文名)”格式
// @match        https://ebird.org/*
// @grant        GM.getValue
// ==/UserScript==

const STORAGE_KEY = 'ebirdSpeciesList';
const HIGHLIGHT_COLOR = '#A35F00';
const ENDEMIC_HIGHLIGHT_COLOR = '#C0262E'; // one-country endemic
const NONENDEMIC_HIGHLIGHT_COLOR = HIGHLIGHT_COLOR; // 复用你原来的 '#A35F00'

const HIGHLIGHT_ENDEMIC = true;
const ENABLE_FULL_MATCH = false; // 控制是否在整页匹配所有鸟种
const ENABLE_PARTIAL_MATCH = true; // 控制是否仅在特定区域匹配

const RAW_BASE = 'https://raw.githubusercontent.com/wzy0421/ebirdHelper/main/';
const FILES = {
    CN_MAP: 'birdMap.json',
    ENDEMIC_MAP: 'endemicMap.json',
};

/** 缓存配置 */
const CACHE_KEYS = {
    CN_MAP: 'ebh_cn_map_cache_v1',
    ENDEMIC_MAP: 'ebh_endemic_map_cache_v1',
};
const DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 7 天

/**
 * 读取 JSON + ETag 条件刷新 + 本地缓存（Tampermonkey Storage）
 * - 命中缓存且未过期：立即返回旧数据，同时后台尝试条件刷新
 * - 缓存缺失或过期：前台拉取并写回
 */
async function loadJSONWithCache(cacheKey, filePath, ttlMs = DEFAULT_TTL_MS) {
    const url = RAW_BASE + filePath;
    const cached = await GM.getValue(cacheKey, null);
    const now = Date.now();

    // 若有缓存且没过期，先返回旧数据，并后台尝试条件刷新
    if (cached && now - cached.fetchedAt < ttlMs) {
        // 后台条件刷新（不阻塞页面）
        conditionalRefresh(cacheKey, url, cached.etag).catch(() => { });
        return cached.data;
    }

    // 缓存缺失或过期：前台取一次
    return fetchAndStore(cacheKey, url, cached?.etag ?? null);
}

/** 后台条件刷新：If-None-Match 304 则复用旧数据，否则更新 */
async function conditionalRefresh(cacheKey, url, etag) {
    try {
        // 发送条件请求（如服务器支持 ETag，会返回 304）
        const res = await fetch(url, {
            headers: etag ? { 'If-None-Match': etag } : {},
            // raw.githubusercontent.com 允许 CORS；默认即可
        });
        if (res.status === 304) return; // 内容未变
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const newEtag = res.headers.get('etag') || null;
        await GM.setValue(cacheKey, { data, etag: newEtag, fetchedAt: Date.now() });
    } catch (e) {
        // 静默失败，不打扰用户
        console.debug('[ebh] conditional refresh failed:', e);
    }
}

/** 前台拉取并写回缓存（用于过期或首次加载） */
async function fetchAndStore(cacheKey, url, etag) {
    const res = await fetch(url, { headers: etag ? { 'If-None-Match': etag } : {} });
    if (res.status === 304) {
        const cached = await GM.getValue(cacheKey, null);
        if (cached) return cached.data;
    }
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const newEtag = res.headers.get('etag') || null;
    await GM.setValue(cacheKey, { data, etag: newEtag, fetchedAt: Date.now() });
    return data;
}

/** 对外暴露的获取函数 */
const dataStore = {
    /** 获取英文名 -> 中文名（IOC）Map（对象或 Map 均可用） */
    async getBirdNameMap() {
        // 约定 json 结构是 { "Common Name": "中文名", ... }
        const obj = await loadJSONWithCache(CACHE_KEYS.CN_MAP, FILES.CN_MAP);
        // 你如果更喜欢 Map：
        // return new Map(Object.entries(obj));
        return obj;
    },
    /** 获取 Endemic Map（物种 -> 国家/区域） */
    async getEndemicMap() {
        // 约定 json 结构是 { "Species or Common Name": "COUNTRY/REGION or Array", ... }
        const obj = await loadJSONWithCache(CACHE_KEYS.ENDEMIC_MAP, FILES.ENDEMIC_MAP);
        return obj;
    },
    /** 手动清空缓存（可挂到菜单里） */
    async clearCache() {
        await GM.deleteValue(CACHE_KEYS.CN_MAP);
        await GM.deleteValue(CACHE_KEYS.ENDEMIC_MAP);
        alert('eBird Helper：已清空本地缓存，下次将从 GitHub 重新拉取。');
    }
};


const birdMap = await dataStore.getBirdNameMap();

const endemicMap = await dataStore.getEndemicMap();
const markedSet = new WeakSet(); // ✅ 缓存机制：已处理元素集合

const style = document.createElement('style');

style.textContent = `
  .unseen-bird,
  .unseen-bird * {
    color: #A35F00 !important;
    text-decoration: none !important;
  }
`;
document.head.appendChild(style);

function saveSpeciesList(speciesList) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(speciesList));
}

function loadSpeciesList() {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
}

function updateSpeciesFromLifelistPage() {
    const existing = loadSpeciesList(); // [{ commonName, latinName }, ...]
    const existingSet = new Set(existing.map(s => s.commonName));

    // 仅在 #nativeNatProv 作用域内匹配
    const scope = document.querySelector('section#nativeNatProv');
    if (!scope) {
        console.warn('[eBird Species Tracker] 未找到 <section id="nativeNatProv">，已跳过更新。');
        return;
    }

    // 1) 从当前 section 收集物种（去重）
    const pageMap = new Map(); // commonName -> latinName
    scope.querySelectorAll('.Observation').forEach(obs => {
        const commonNameEl = obs.querySelector('.Heading-main');
        const latinNameEl = obs.querySelector('.Heading-sub--sci');
        if (!commonNameEl) return;

        const commonNameRaw = commonNameEl.textContent.trim();
        const commonName = commonNameRaw.replace(/\(.*?\)\*?$/, '').trim();
        const latinName = (latinNameEl?.textContent.trim() || '');

        if (!pageMap.has(commonName)) {
            pageMap.set(commonName, latinName);
        }
    });

    // 2) 计算新增与删除
    const pageSet = new Set(pageMap.keys());
    let added = 0, removed = 0;

    for (const name of pageSet) {
        if (!existingSet.has(name)) added++;
    }
    for (const name of existingSet) {
        if (!pageSet.has(name)) removed++;
    }

    // 3) 以页面为准重建并保存
    const updatedList = Array.from(pageMap, ([commonName, latinName]) => ({ commonName, latinName }))
        .sort((a, b) => a.commonName.localeCompare(b.commonName));

    saveSpeciesList(updatedList);

    // 4) 反馈
    if (added > 0 || removed > 0) {
        const parts = [];
        if (added) parts.push(`新增 ${added}`);
        if (removed) parts.push(`删除 ${removed}`);
        alert(`已与当前生涯清单对齐：${parts.join('，')} 个物种。`);
    }

    // console.log(`[eBird Species Tracker] Total species in list: ${updatedList.length}`);
}

function getRelevantElements() {
    const url = location.href;
    // console.log('[eBird] 当前页面 URL:', url);

    if (url.includes('/checklist/')) {
        const nodes = document.querySelectorAll('.Observation-species .Heading-main');
        //console.log(`[eBird] checklist 页面 .ChecklistObservation 匹配元素数量: ${nodes.length}!!!!`);
        return nodes;
    } else if (url.includes('/tripreport/')) {
        const nodes = document.querySelectorAll('.Species-common');
        //console.log(`[eBird] tripreport 页面匹配元素数量: ${nodes.length}`);
        return nodes;
    } else if (url.includes('/hotspot/') || url.includes('/region/')) {
        const nodes = document.querySelectorAll('.Species-common');
        //console.log(`[eBird] hotspot 页面 .Species-common 匹配元素数量: ${nodes.length}!!!!`);
        return nodes;
    } else if (url.includes('/targets')) {
        const nodes = document.querySelectorAll('.SpecimenHeader-joined');
        //console.log(`[eBird] hotspot 页面 .Species-common 匹配元素数量: ${nodes.length}!!!!`);
        return nodes;
    } else if (url.includes('/printableList')) {
        const nodes = document.querySelectorAll('.subitem');
        return nodes;
    } else if (url.includes('/barchart')) {
        const nodes = document.querySelectorAll('.SpeciesName');
        return nodes;
    } else if (url.includes('/alert')) {
        const nodes = document.querySelectorAll('.Observation-species .Heading-main');
        return nodes;
    }

    // console.log('[eBird] 未匹配到特定页面类型，返回空数组');
    return [];
}

function extractCleanName(text) {
    // return text.replace(/\(.*?\)\*?$/, '').replace(/\*/g, '').trim();
    // return text.replace(/\s*\(.*?\).*$/, '').replace(/\*/g, '').trim();
    return text
        .replace(/\s*\([^)]*\)/g, '') // 去掉所有(...)块（中文名/拉丁名都覆盖）
        .replace(/\*/g, '') // 去掉星号
        .replace(/\s+[A-Z][a-z]+(?:\s+[a-z\-]+){1,2}\s*$/, '') // 去掉末尾拉丁名（属+种(+亚种)）
        .trim();
}

function ensureHighlightCSS() {
    if (document.getElementById('ebird-highlights')) return;

    const style = document.createElement('style');
    style.id = 'ebird-highlights';
    style.textContent = `
/* 祖先打标，所有后代全部强制变色 */
[data-ebird-unseen],
[data-ebird-unseen] *,
[data-ebird-unseen] a,
[data-ebird-unseen] a:link,
[data-ebird-unseen] a:visited {
  color: var(--ebird-highlight, #ff2d55) !important;
  -webkit-text-fill-color: var(--ebird-highlight, #ff2d55) !important; /* WebKit 有时用这个覆盖文字颜色 */
}

/* 如果页面是 SVG 文本 */
[data-ebird-unseen] svg text,
[data-ebird-unseen] svg tspan {
  fill: var(--ebird-highlight, #ff2d55) !important;
}
`;
    // 把样式插到 <head> 最后，尽量压过站点后插入的全局样式
    (document.head || document.documentElement).appendChild(style);
}

function highlightUnseenSpecies() {
    const seenBirds = new Set(loadSpeciesList().map(s => s.commonName));
    // console.log(`[eBird] 当前已见鸟种数量: ${seenBirds.size}`);

    let targets = [];
    if (ENABLE_PARTIAL_MATCH) {
        targets = getRelevantElements();
    }
    /*if (ENABLE_FULL_MATCH || targets.length === 0) {
        targets = document.querySelectorAll('.Heading-main');
        console.log(`[eBird] fallback 使用 .Heading-main 匹配元素数量: ${targets.length}`);
    }*/

    // console.log(`[eBird] 最终处理元素数量: ${targets.length}`);

    targets.forEach(el => {
        if (markedSet.has(el)) return; // ✅ 避免重复处理

        const rawText = el.textContent.trim();
        const cleanName = extractCleanName(rawText);

        // 去除 spuh/hybrid/slash
        if (cleanName.endsWith(' sp.') || cleanName.includes(' x ') || cleanName.includes(' X ') || cleanName.includes('/')) {
            markedSet.add(el);
            return;
        }

        if (!seenBirds.has(cleanName)) {
            ensureHighlightCSS(); // 保证样式注入

            // ——新增：根据 endemicMap 区分颜色——
            const countryCode = endemicMap?.[cleanName]; // e.g. 'ID', 'MG', 'PH'...
            const isEndemic = !!countryCode;

            el.setAttribute('data-ebird-unseen', '1');
            el.setAttribute('data-ebird-endemic', isEndemic ? '1' : '0');
            if (isEndemic && HIGHLIGHT_ENDEMIC) {
                // 赋 endemic 色，并加个简短说明
                el.style.setProperty('--ebird-highlight', ENDEMIC_HIGHLIGHT_COLOR);
                if (!el.title) el.title = `Endemic (${countryCode})`;
                else if (!/Endemic \([A-Z]{2}\)/.test(el.title)) el.title += ` | Endemic (${countryCode})`;
            } else {
                // 非特有：用原来的高亮色
                el.style.setProperty('--ebird-highlight', NONENDEMIC_HIGHLIGHT_COLOR);
            }

            // 在末尾补一个星标（保留你原逻辑）
            if (!rawText.includes('*')) {
                el.appendChild(document.createTextNode('*'));
            }
        }

        markedSet.add(el);
    });
}

if (location.href.startsWith('https://ebird.org/lifelist?time=life&r=world')) {
    window.addEventListener('load', () => {
        setTimeout(updateSpeciesFromLifelistPage, 2000);
    });
} else {
    window.addEventListener('load', () => {
        setTimeout(() => {
            highlightUnseenSpecies();

            // ✅ 启用 DOM 监听，处理异步内容加载
            const observer = new MutationObserver(() => {
                // console.log('[eBird] DOM 变化触发重新标记');
                highlightUnseenSpecies();
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }, 4000);
    });
}


const highlightUnknown = true;

const seenBirds = new Set(loadSpeciesList().map(s => s.commonName));






(function () {
    'use strict';

    const names = Object.keys(birdMap).sort((a, b) => b.length - a.length);
    const pattern = new RegExp(`\\b(${names.map(n => n.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b`, 'g');

    function walkAndReplace(node) {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);

        // 关键修改：按名称长度从长到短排序，保证更长的复合名（如 Magpie-Robin）优先匹配
        const birdNames = Object.keys(birdMap)
            .filter(name => name && name.length > 0)
            .sort((a, b) => b.length - a.length);

        if (birdNames.length === 0) return;

        // 构建正则：\b(Oriental Magpie-Robin|Oriental Magpie|...)\b
        // 由于上面已按长度降序，存在重叠时会优先匹配更长的条目
        const pattern = new RegExp(
            `\\b(${birdNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
            'g'
        );

        let n;
        while ((n = walker.nextNode())) {
            const parent = n.parentNode;
            if (!parent || parent.dataset.replaced === '1') continue;

            const oldText = n.nodeValue;

            const newText = oldText.replace(pattern, match => {
                if (!birdMap[match]) return match;
                const seen = seenBirds.has(match);
                // return `${birdMap[match]}${!seen ? '*' : ''}`;
                return `${birdMap[match]}`;
            });

            if (newText !== oldText) {
                n.nodeValue = newText;
                parent.dataset.replaced = '1'; // 防止重复替换
            }
        }
    }

    walkAndReplace(document.body);
    highlightUnseenSpecies();

    const observer = new MutationObserver((mutations) => {
        for (let m of mutations) {
            for (let node of m.addedNodes) {
                if (node.nodeType === 1) {
                    walkAndReplace(node);
                }
            }
        }
        highlightUnseenSpecies();
    });

    observer.observe(document.body, { childList: true, subtree: true });
})();

(() => {
    'use strict';

    const LOG_PREFIX = '[eBird@Pinyin]';
    const log = (...a) => console.log(LOG_PREFIX, ...a);

    const URL_MAPPING = 'https://raw.githubusercontent.com/wzy0421/ebirdHelper/dev/pinyin_mapping.json';
    const CACHE_KEY = 'pinyin_mapping_cache_v9';
    const CACHE_TTL = 86400 * 1000; // 24h

    // lowerName → { commonName, code?, pinyinLower, initialsLower }
    let NAME2ENTRY = new Map();
    // 当前页面已存在的可跳转物种
    let VISIBLE_ITEMS = [];
    // 当前输入框是否处于 @ 模式
    let overrideOn = false;

    /* ---------------------------------------
       样式：@ 模式隐藏原生 .Suggest-empty
       --------------------------------------- */
    (function injectPinyinCSS() {
        const css = `
    .Suggest-dropdown.__pinyin-active .Suggest-empty {
      display: none !important;
    }`;
        const s = document.createElement('style');
        s.textContent = css;
        document.documentElement.appendChild(s);
    })();

    /* ---------------------------------------
       工具函数：拉取 & 缓存 pinyin mapping
       --------------------------------------- */

    function gmFetchJSON(url) {
        return new Promise(function (resolve, reject) {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    headers: { 'Accept': 'application/json' },
                    onload: function (res) {
                        try {
                            if (res.status >= 200 && res.status < 300) {
                                resolve(JSON.parse(res.responseText));
                            } else {
                                reject(new Error('HTTP ' + res.status));
                            }
                        } catch (e) {
                            reject(e);
                        }
                    },
                    onerror: function (e) { reject(e); },
                    timeout: 15000,
                    ontimeout: function () { reject(new Error('timeout')); }
                });
            } else if (typeof fetch === 'function') {
                fetch(url)
                    .then(function (r) {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        return r.json();
                    })
                    .then(resolve)
                    .catch(reject);
            } else {
                reject(new Error('no fetch / GM_xmlhttpRequest'));
            }
        });
    }

    function loadPinyinMapping() {
        return new Promise(function (resolve, reject) {
            try {
                var raw = localStorage.getItem(CACHE_KEY);
                if (raw) {
                    var obj = JSON.parse(raw);
                    if (obj && obj.data && (Date.now() - obj.ts < CACHE_TTL)) {
                        log('使用缓存 pinyin_mapping');
                        resolve(obj.data);
                        return;
                    }
                }
            } catch (e) {
                console.warn(LOG_PREFIX, '缓存读取失败:', e);
            }

            gmFetchJSON(URL_MAPPING).then(function (data) {
                try {
                    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data }));
                } catch (e2) {
                    console.warn(LOG_PREFIX, '缓存写入失败:', e2);
                }
                resolve(data);
            }, reject);
        });
    }

    function makeInitials(pinyin) {
        return String(pinyin || '')
            .replace(/[^a-zA-Z]/g, ' ')
            .trim()
            .split(/\s+/)
            .map(function (w) { return w ? w[0] : ''; })
            .join('')
            .toLowerCase();
    }

    function buildNameMap(rawObj) {
        var map = new Map();
        if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) return;
        for (var key in rawObj) {
            if (!Object.prototype.hasOwnProperty.call(rawObj, key)) continue;
            var v = rawObj[key] || {};
            var p = String(v.pinyin || '').toLowerCase();
            var i = String(v.initials || makeInitials(p)).toLowerCase();
            var code = v.code ? String(v.code).trim() : '';

            // 这里假设 pinyin_map 里有 name（纯英文名）和 latin（拉丁名）两个字段
            var engName = v.name ? String(v.name).trim() : key;
            var latin = v.latin ? String(v.latin).trim() : (v.latin_name ? String(v.latin_name).trim() : '');

            if (!p && !i) continue;
            map.set(String(key).toLowerCase(), {
                commonName: key,       // e.g. "Emu"
                code: code,            // emu1
                pinyinLower: p,
                initialsLower: i,
                engName: engName,      // 纯英文名
                latinName: latin      // 拉丁名
            });
        }
        NAME2ENTRY = map;
    }

    /* ---------------------------------------
       DOM 辅助
       --------------------------------------- */

    function findSpeciesInput() {
        return (
            document.querySelector('#jumpToSpp') ||
            document.querySelector('input.Suggest-input')
        );
    }

    // ⭐ 关键改动：必要时“造”出 dropdown + .Suggest-suggestions
    function getDom() {
        var input = findSpeciesInput();
        if (!input) return { input: null, dropdown: null, list: null, emptyTpl: null };

        var dropdownId = input.getAttribute('aria-controls') || 'Suggest-dropdown-jumpToSpp';
        var dropdown = document.getElementById(dropdownId);

        if (!dropdown) {
            // 创建一个基础 dropdown，让 @ 模式第一次就有壳可用
            dropdown = document.createElement('div');
            dropdown.id = dropdownId;
            dropdown.className = 'Suggest-dropdown';
            dropdown.setAttribute('role', 'listbox');
            dropdown.style.display = 'none';

            // 尝试插在 input 后面
            if (input.parentNode) {
                input.parentNode.appendChild(dropdown);
            } else {
                document.body.appendChild(dropdown);
            }
        }

        var list = dropdown.querySelector('.Suggest-suggestions');
        if (!list) {
            list = document.createElement('div');
            list.className = 'Suggest-suggestions';
            dropdown.appendChild(list);
        }

        var emptyTpl = dropdown.querySelector('.Suggest-empty');

        return { input: input, dropdown: dropdown, list: list, emptyTpl: emptyTpl };
    }

    function extractCommonName(span) {
        if (!span) return '';
        var txt = '';
        span.childNodes.forEach(function (n) {
            if (n.nodeType === Node.TEXT_NODE) txt += n.textContent || '';
        });
        txt = txt.trim();
        return txt.replace(/\(.*$/, '').trim();
    }

    function findCountInputByCode(code) {
        if (!code) return null;
        var el = document.getElementById(code);
        if (el) return el;
        el = document.querySelector('input.sc[name^="sp[\'' + code + '\']"]');
        if (el) return el;
        el = document.querySelector('input.sc[name*="' + code + '"]');
        return el;
    }

    function jumpToItem(item) {
        var input = null;
        var row = null;

        if (item.code) {
            input = findCountInputByCode(item.code);
            if (input) {
                row =
                    input.closest('[data-observation-id]') ||
                    input.closest('.SubmitChecklist-species-name') ||
                    input.closest('tr') ||
                    input;
            }
        }

        if (!row) {
            var spans = document.querySelectorAll('.SubmitChecklist-species-name[id^="name_"] span');
            var target = item.commonName.toLowerCase();
            for (var i = 0; i < spans.length; i++) {
                var s = spans[i];
                var cn = extractCommonName(s).toLowerCase();
                if (cn === target) {
                    row = s.closest('.SubmitChecklist-species-name');
                    if (row) {
                        var tr = row.closest('tr') || row;
                        input = tr.querySelector('input.sc') || tr.querySelector('input');
                    }
                    break;
                }
            }
        }

        if (!row || !input) return false;

        try {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (e) {
            row.scrollIntoView();
        }
        input.focus();
        try { if (typeof input.select === 'function') input.select(); } catch (e2) { }
        return true;
    }

    /* ---------------------------------------
       提取页面已有物种
       --------------------------------------- */

    function collectVisibleItems() {
        var arr = [];
        var seen = new Set();
        var divs = document.querySelectorAll('.SubmitChecklist-species-name[id^="name_"]');

        for (var i = 0; i < divs.length; i++) {
            var div = divs[i];
            var span = div.querySelector('span');
            if (!span) continue;

            var cn = extractCommonName(span);
            var lower = cn.toLowerCase();
            if (seen.has(lower)) continue;
            var entry = NAME2ENTRY.get(lower);
            if (!entry) continue;

            var code = (div.id || '').replace(/^name_/, '').trim();
            seen.add(lower);
            arr.push({
                commonName: entry.commonName,
                code: code,
                pinyinLower: entry.pinyinLower,
                initialsLower: entry.initialsLower,
                engName: entry.engName || entry.commonName,
                latinName: entry.latinName || ''
            });
        }

        VISIBLE_ITEMS = arr;
        log('可用于 @ 匹配的物种数：', arr.length);
    }

    var debouncedCollect = (function () {
        var t = null;
        return function () {
            if (t) clearTimeout(t);
            t = setTimeout(collectVisibleItems, 150);
        };
    })();

    /* ---------------------------------------
       匹配逻辑
       --------------------------------------- */

    function filterByTerm(arr, term) {
        var t = (term || '').toLowerCase().trim();
        if (!t) return [];

        var exact = [];
        var starts = [];
        var contains = [];

        for (var i = 0; i < arr.length; i++) {
            var it = arr[i];
            var p = it.pinyinLower || '';
            var ini = it.initialsLower || '';

            if (p === t || ini === t) {
                exact.push(it);
            } else if (p.indexOf(t) === 0 || ini.indexOf(t) === 0) {
                starts.push(it);
            } /*else if (p.indexOf(t) !== -1 || ini.indexOf(t) !== -1) {
                contains.push(it);
            } */
        }

        if (t.length <= 2) {
            var total = exact.length + starts.length + contains.length;
            if (total > 5) return exact;
        }
        return exact.concat(starts, contains);
    }

    /* ---------------------------------------
       清除我们自己的 suggestion
       --------------------------------------- */

    function clearPinyinSuggestions(list) {
        if (!list) return;
        var nodes = list.querySelectorAll('.__pinyin-item');
        for (var i = 0; i < nodes.length; i++) {
            nodes[i].remove();
        }
    }

    /* ---------------------------------------
       构造 suggestion 节点（复用原生样式）
       --------------------------------------- */

    function makeItemNode(item, onPick) {
        var ctx = getDom();
        var dropdown = ctx.dropdown;
        var proto = dropdown ? dropdown.querySelector('.Suggest-suggestion') : null;
        var wrap;

        if (proto) {
            // 克隆一个现有的 suggestion，保留 role 等属性
            wrap = proto.cloneNode(true);
            wrap.classList.remove('is-active');

            // 清空子节点，避免保留原内容
            while (wrap.firstChild) {
                wrap.removeChild(wrap.firstChild);
            }

            // 避免重复 id
            wrap.removeAttribute('id');
        } else {
            // 没有原生节点就自己建一个
            wrap = document.createElement('div');
            wrap.className = 'Suggest-suggestion';
            wrap.setAttribute('role', 'option');
        }

        // 标记一下这是拼音插入的
        wrap.classList.add('__pinyin-item');

        // === 和原生一致的结构 ===
        // <span class="Suggestion-text">
        //   <em data-replaced="1">Emu(鸸鹋)</em>
        //   <span class="SciName">Dromaius novaehollandiae</span>
        // </span>

        var container = document.createElement('span');
        container.className = 'Suggestion-text';

        var em = document.createElement('em');
        em.setAttribute('data-replaced', '1');

        // 这里的 label 可以是你已经拼好的 "Emu(鸸鹋)"
        // 如果你在别处已经算好了，就挂在 item.label 上；
        // 没有的话就用 commonName 或 name 自己拼
        var engName = item.name || item.commonName || '';
        var cnName = item.cnName || ''; // 如果你有中文名字段，就用它
        em.textContent = cnName ? (engName + '(' + cnName + ')') : engName;

        container.appendChild(em);

        // SciName：如果你已经在 pinyin_map 里有 latin name，就提前塞到 item.latinName
        if (item.latinName) {
            container.appendChild(document.createTextNode(' '));
            var sci = document.createElement('span');
            sci.className = 'SciName';
            sci.textContent = item.latinName;
            container.appendChild(sci);
        }

        wrap.appendChild(container);

        // 用 mousedown 可以避免点击时输入框先 blur
        wrap.addEventListener('mousedown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            onPick(item);
        });

        return wrap;
    }

    /* ---------------------------------------
       渲染结果（不再 innerHTML = ''）
       --------------------------------------- */

    function renderResults(term, results) {
        var ctx = getDom();
        var dropdown = ctx.dropdown;
        var list = ctx.list;
        if (!dropdown || !list) return;

        clearPinyinSuggestions(list);

        if (!results.length) {
            dropdown.classList.remove('__pinyin-active');
            dropdown.style.display = ''; // 交给原生决定
            return;
        }

        dropdown.classList.add('__pinyin-active');
        dropdown.style.display = 'block';
        for (var i = 0; i < results.length; i++) {
            list.appendChild(makeItemNode(results[i], pickItem));
        }
    }

    /* ---------------------------------------
       点击选择
       --------------------------------------- */

    function pickItem(item) {
        var ctx = getDom();
        var input = ctx.input;
        var dropdown = ctx.dropdown;
        var list = ctx.list;
        if (!input) return;

        overrideOn = false;
        clearPinyinSuggestions(list);
        if (dropdown) {
            dropdown.classList.remove('__pinyin-active');
            dropdown.style.display = '';
        }

        var jumped = jumpToItem(item);
        if (!jumped) {
            input.value = item.commonName;
        } else {
            input.value = '';
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /* ---------------------------------------
       监听 input（只在 @ 前缀时介入）
       --------------------------------------- */

    function onInputCapture(e) {
        var ctx = getDom();
        var input = ctx.input;
        var dropdown = ctx.dropdown;
        var list = ctx.list;
        if (!input) return;

        var v = input.value || '';

        // @@ → 原生逻辑
        if (v.indexOf('@@') === 0) {
            if (overrideOn) {
                overrideOn = false;
                clearPinyinSuggestions(list);
                if (dropdown) {
                    dropdown.classList.remove('__pinyin-active');
                    dropdown.style.display = '';
                }
            }
            return;
        }

        // 非 @ → 原生逻辑
        if (v.indexOf('@') !== 0) {
            if (overrideOn) {
                overrideOn = false;
                clearPinyinSuggestions(list);
                if (dropdown) {
                    dropdown.classList.remove('__pinyin-active');
                    dropdown.style.display = '';
                }
            }
            return;
        }

        // 到这里 = @ 模式
        overrideOn = true;

        var term = v.slice(1).trim();
        if (!dropdown || !list) return;

        if (!term) {
            clearPinyinSuggestions(list);
            dropdown.classList.remove('__pinyin-active');
            dropdown.style.display = '';
            return;
        }

        var results = filterByTerm(VISIBLE_ITEMS, term);
        renderResults(term, results);
        // 不阻止原生，只是用我们的 __pinyin-item + CSS 覆盖显示
    }

    function onKeydownCapture(e) {
        if (!overrideOn) return;
        if (e.key !== 'Enter') return;

        var ctx = getDom();
        var list = ctx.list;
        if (!list) return;

        var btn = list.querySelector('.__pinyin-item button');
        if (!btn) return;

        e.preventDefault();
        e.stopPropagation();
        btn.click();
    }

    /* ---------------------------------------
       初始化 & 绑定
       --------------------------------------- */

    function bindInput() {
        var input = findSpeciesInput();
        if (!input) {
            log('未找到 species 输入框');
            return;
        }
        if (input.__pinyinBound) return;
        input.__pinyinBound = true;

        // capture 阶段先观察 input，再决定是否接管
        input.addEventListener('input', onInputCapture, true);
        input.addEventListener('keydown', onKeydownCapture, true);

        log('已绑定 @pinyin 监听');
    }

    function init() {
        log('初始化 @pinyin 功能...');
        loadPinyinMapping()
            .then(function (raw) {
                buildNameMap(raw);
                log('pinyin mapping 条目：', NAME2ENTRY.size);

                collectVisibleItems();
                bindInput();

                var mo = new MutationObserver(function () {
                    debouncedCollect();
                });
                mo.observe(document.body, { childList: true, subtree: true });
            })
            .catch(function (e) {
                console.error(LOG_PREFIX, '初始化失败:', e);
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

