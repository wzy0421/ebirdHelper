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

/* === [APPEND ONLY] eBirdHelper: @ pinyin → jump to existing species input (v6) === */
(() => {
    'use strict';

    const LOG_PREFIX = '[eBird @Pinyin]';
    const log = (...a) => console.log(LOG_PREFIX, ...a);

    const RAW_URL = 'https://raw.githubusercontent.com/wzy0421/ebirdHelper/dev/pinyin_mapping.json';
    const CACHE_KEY = 'pinyin_mapping_cache_v6';
    const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

    // lower(commonName) -> { commonName, code?, pinyinLower, initialsLower }
    let NAME2ENTRY = new Map();
    // 当前页面可用的物种列表（只包含当前 checklist 上已经有的物种）
    let VISIBLE_ITEMS = [];
    // 当前 input 是否处于“由我们接管”的 @ 模式
    let overrideOn = false;

    /* ---------- 工具 ---------- */
    function gmFetchJSON(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    headers: { 'Accept': 'application/json' },
                    onload: res => {
                        try {
                            if (res.status >= 200 && res.status < 300) resolve(JSON.parse(res.responseText));
                            else reject(new Error('HTTP ' + res.status));
                        } catch (e) { reject(e); }
                    },
                    onerror: e => reject(e),
                    timeout: 15000,
                    ontimeout: () => reject(new Error('timeout')),
                });
            } else if (typeof fetch === 'function') {
                fetch(url, { credentials: 'omit' })
                    .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
                    .then(resolve, reject);
            } else {
                reject(new Error('No fetch / GM_xmlhttpRequest'));
            }
        });
    }

    function loadMappingJSON() {
        return new Promise((resolve, reject) => {
            try {
                const cachedRaw = localStorage.getItem(CACHE_KEY);
                if (cachedRaw) {
                    const cached = JSON.parse(cachedRaw);
                    if (cached && cached.data && (Date.now() - cached.ts < CACHE_TTL)) {
                        // log('使用缓存 pinyin_mapping');
                        resolve(cached.data);
                        return;
                    }
                }
            } catch (e) {
                console.warn(LOG_PREFIX, '缓存读取失败:', e);
            }
            gmFetchJSON(RAW_URL)
                .then(data => {
                    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch { }
                    resolve(data);
                })
                .catch(reject);
        });
    }

    function makeInitials(p) {
        return (p || '')
            .replace(/[^a-zA-Z]/g, ' ')
            .trim()
            .split(/\s+/)
            .map(w => (w ? w[0] : ''))
            .join('')
            .toLowerCase();
    }

    function buildNameMap(rawObj) {
        const map = new Map();
        if (rawObj && typeof rawObj === 'object' && !Array.isArray(rawObj)) {
            for (const key in rawObj) {
                if (!Object.prototype.hasOwnProperty.call(rawObj, key)) continue;
                const commonName = key || '';
                if (!commonName) continue;
                const v = rawObj[key] || {};
                const pinyin = (v.pinyin ? String(v.pinyin) : '').toLowerCase();
                const initials = (v.initials ? String(v.initials) : makeInitials(pinyin)).toLowerCase();
                const code = v.code ? String(v.code).trim() : '';
                if (!pinyin && !initials) continue;
                map.set(commonName.toLowerCase(), {
                    commonName,
                    code,
                    pinyinLower: pinyin,
                    initialsLower: initials,
                });
            }
        }
        NAME2ENTRY = map;
    }

    /* ---------- DOM 辅助 ---------- */
    function findSpeciesInput() {
        return (
            document.querySelector('#jumpToSpp') ||
            document.querySelector('input.Suggest-input')
        );
    }

    function getDom() {
        const input = findSpeciesInput();
        if (!input) return { input: null, dropdown: null, list: null, emptyTpl: null };
        const dropdownId = input.getAttribute('aria-controls') || 'Suggest-dropdown-jumpToSpp';
        const dropdown =
            document.getElementById(dropdownId) ||
            document.querySelector('#Suggest-dropdown-jumpToSpp') ||
            null;
        const list = dropdown ? dropdown.querySelector('.Suggest-suggestions') : null;
        const emptyTpl = dropdown ? dropdown.querySelector('.Suggest-empty') : null;
        return { input, dropdown, list, emptyTpl };
    }

    function ensureOpen(dropdown) {
        if (!dropdown) return;
        dropdown.style.display = 'block';
        if (dropdown.parentElement) dropdown.parentElement.setAttribute('aria-expanded', 'true');
    }

    function ensureClosed(dropdown) {
        if (!dropdown) return;
        dropdown.style.removeProperty('display');
        if (dropdown.parentElement) dropdown.parentElement.removeAttribute('aria-expanded');
    }

    /* ---------- 提取英文名 & 高亮跳转 ---------- */
    function extractCommonNameFromSpan(span) {
        let raw = '';
        span.childNodes.forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) raw += node.textContent || '';
        });
        raw = raw.trim();
        // Southern Cassowary(双垂鹤鸵) → Southern Cassowary
        return raw.replace(/\(.*$/, '').trim();
    }

    // 高亮样式
    (function injectHighlightCSS() {
        const css =
            '.__pinyin_jump_flash{' +
            'outline:3px solid rgba(255,200,0,.9);' +
            'outline-offset:2px;' +
            'animation:__pinyin_flash 1.0s ease-out 1;' +
            'border-radius:6px;' +
            '}' +
            '@keyframes __pinyin_flash{' +
            '0%{outline-color:rgba(255,200,0,1);}' +
            '100%{outline-color:rgba(255,200,0,0);}' +
            '}';
        const s = document.createElement('style');
        s.textContent = css;
        document.documentElement.appendChild(s);
    })();

    function findCountInputByCode(code) {
        if (!code) return null;
        let el = document.getElementById(code);
        if (el) return el;
        el = document.querySelector('input.sc[name^="sp[\'' + code + '\']"]');
        if (el) return el;
        el = document.querySelector('input.sc[name*="' + code + '"]');
        return el;
    }

    function jumpToItem(item) {
        let input = null;
        let rowEl = null;

        if (item.code) {
            input = findCountInputByCode(item.code);
            if (input) {
                rowEl =
                    input.closest('[data-observation-id]') ||
                    input.closest('.SubmitChecklist-species-name') ||
                    input.closest('tr') ||
                    input;
            }
        }

        if (!rowEl) {
            const nodes = document.querySelectorAll('.SubmitChecklist-species-name[id^="name_"] span');
            const target = item.commonName.toLowerCase();
            nodes.forEach(span => {
                if (rowEl) return;
                const cn = extractCommonNameFromSpan(span).toLowerCase();
                if (cn === target) {
                    rowEl = span.closest('.SubmitChecklist-species-name') || span;
                    const row = rowEl.closest('tr, .SubmitChecklist-row, .ChecklistRow') || rowEl;
                    input = row.querySelector('input.sc') || row.querySelector('input, textarea, [contenteditable="true"]');
                }
            });
        }

        if (!rowEl || !input) return false;

        rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        rowEl.classList.add('__pinyin_jump_flash');
        setTimeout(() => rowEl.classList.remove('__pinyin_jump_flash'), 1000);

        input.focus();
        try { if (typeof input.select === 'function') input.select(); } catch { }
        return true;
    }

    /* ---------- 构建本页可用物种列表（通过 name_xxx DOM） ---------- */
    function collectVisibleItems() {
        const items = [];
        const seen = new Set();
        const nodes = document.querySelectorAll('.SubmitChecklist-species-name[id^="name_"]');

        nodes.forEach(div => {
            const id = div.id || '';
            const code = id.replace(/^name_/, '').trim();
            if (!code) return;

            const span = div.querySelector('span');
            if (!span) return;

            const commonName = extractCommonNameFromSpan(span);
            const lower = commonName.toLowerCase();
            const base = NAME2ENTRY.get(lower);
            if (!base) return;
            if (seen.has(lower)) return;
            seen.add(lower);

            items.push({
                commonName: base.commonName,
                code,
                pinyinLower: base.pinyinLower,
                initialsLower: base.initialsLower,
            });
        });

        VISIBLE_ITEMS = items;
        // log('可用于 @ 匹配的物种数:', VISIBLE_ITEMS.length);
    }

    const debouncedCollect = (() => {
        let t = null;
        return () => {
            if (t) clearTimeout(t);
            t = setTimeout(collectVisibleItems, 150);
        };
    })();

    /* ---------- term 过滤 ---------- */
    function filterByTerm(arr, term) {
        const t = (term || '').toLowerCase().trim();
        if (!t) return [];

        const exact = [];
        const starts = [];
        const contains = [];

        for (let i = 0; i < arr.length; i++) {
            const it = arr[i];
            const p = it.pinyinLower || '';
            const ini = it.initialsLower || '';

            const isExact = (p === t) || (ini === t);
            if (isExact) { exact.push(it); continue; }

            const isStart = p.indexOf(t) === 0 || ini.indexOf(t) === 0;
            if (isStart) { starts.push(it); continue; }

            const isContains = p.indexOf(t) !== -1 || ini.indexOf(t) !== -1;
            if (isContains) contains.push(it);
        }

        if (t.length <= 2) {
            const total = exact.length + starts.length + contains.length;
            if (total > 5) return exact.slice(0, 50);
        }
        return exact.concat(starts, contains).slice(0, 50);
    }

    /* ---------- dropdown 渲染 ---------- */
    function makeItemNode(item, onPick) {
        const { dropdown } = getDom();
        const proto = dropdown && dropdown.querySelector('.Suggest-suggestion');
        let wrap, btn;

        if (proto) {
            wrap = proto.cloneNode(true);
            wrap.classList.remove('is-active');
            btn = wrap.querySelector('button, .Button');
            if (btn) {
                btn.innerHTML = '';
                const main = document.createElement('div');
                main.className = 'u-text-3';
                main.textContent = item.commonName;
                btn.appendChild(main);
                if (item.code) {
                    const sub = document.createElement('div');
                    sub.className = 'u-text-4 u-muted';
                    sub.textContent = item.code;
                    btn.appendChild(sub);
                }
            }
        }

        if (!wrap) {
            wrap = document.createElement('div');
            wrap.className = 'Suggest-suggestion';
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'Button Button--link u-text-left u-block';
            btn.innerHTML =
                '<div class="u-text-3">' + item.commonName + '</div>' +
                (item.code ? '<div class="u-text-4 u-muted">' + item.code + '</div>' : '');
            wrap.appendChild(btn);
        }
        wrap.classList.add('__pinyin-item');
        btn.addEventListener('mousedown', e => e.preventDefault());
        btn.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            onPick(item);
        });

        return wrap;
    }

    function clearPinyinSuggestions(list) {
        if (!list) return;
        list.querySelectorAll('.__pinyin-item').forEach(n => n.remove());

    }

    function renderResults(term, results) {
        const { dropdown, list, emptyTpl } = getDom();
        if (!dropdown || !list) return;

        // list.innerHTML = '';
        clearPinyinSuggestions(list);
        if (!results.length) {
            if (emptyTpl) {
                list.appendChild(emptyTpl.cloneNode(true));
            } else {
                const div = document.createElement('div');
                div.textContent = 'No matches for @' + term + '. Remove "@" to use Add species.';
                list.appendChild(div);
            }
            ensureOpen(dropdown);
            return;
        }

        results.forEach(it => list.appendChild(makeItemNode(it, pickItem)));
        ensureOpen(dropdown);
    }

    /* ---------- 点击候选 ---------- */
    function pickItem(item) {
        const { input, dropdown, list } = getDom();
        if (!input) return;

        overrideOn = false;
        // if (list) list.innerHTML = '';
        if (list) clearPinyinSuggestions(list);
        ensureClosed(dropdown);

        const jumped = jumpToItem(item);

        // 清空搜索框，这次 input（不以 @ 开头）交给原生
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        if (!jumped) {
            input.value = item.commonName;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    /* ---------- 事件：用 input(capture) 拦截 @，其它全部放行 ---------- */
    function onInputCapture(e) {
        const { input, dropdown, list } = getDom();
        if (!input) return;
        const v = input.value || '';

        // @@：完全交给原生
        if (v.indexOf('@@') === 0) {
            if (overrideOn) {
                overrideOn = false;
                clearPinyinSuggestions(list);      // 只清掉我们自己的 @ 结果
                // 不再关闭 dropdown，让原生自己处理
            }
            return; // 不拦截
        }

        // 2) 非 @：退出我们接管，原生负责 dropdown
        if (v.indexOf('@') !== 0) {
            if (overrideOn) {
                overrideOn = false;
                clearPinyinSuggestions(list);      // 同样，只删我们自己的
            }
            return; // 不拦截
        }

        console.log(3);

        // 走到这里 = 真正的 @ 模式：拦截原生 typeahead 处理这次输入
        e.stopImmediatePropagation();
        e.stopPropagation();

        const term = v.slice(1).trim();
        if (!dropdown || !list) return;

        if (!term) {
            overrideOn = false;
            console.log(list.innerHTML);
            // list.innerHTML = '';
            clearPinyinSuggestions(list);
            ensureClosed(dropdown);
            return;
        }

        const results = filterByTerm(VISIBLE_ITEMS, term);
        overrideOn = true;
        renderResults(term, results);
    }

    function onKeydownCapture(e) {
        if (!overrideOn) return;
        if (e.key !== 'Enter') return;
        const { list } = getDom();
        if (!list) return;
        const btns = list.querySelectorAll('.Suggest-suggestion button, .Suggest-suggestion .Button');
        if (!btns.length) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        btns[0].click();
    }

    function bindInput() {
        const { input } = getDom();
        if (!input) {
            log('未找到 species 输入框，放弃绑定');
            return;
        }
        if (input.__pinyinAtBound) return;
        input.__pinyinAtBound = true;
        // ⚠ 用 capture 阶段：我们优先看到 input，然后视情况阻止原生
        input.addEventListener('input', onInputCapture, true);
        input.addEventListener('keydown', onKeydownCapture, true);
        log('已绑定 @ pinyin 输入监听');
    }

    /* ---------- 初始化 ---------- */
    function init() {
        log('init start');
        const input = findSpeciesInput();
        if (!input) {
            log('找不到 species 输入框，终止');
            return;
        }
        log('找到 species 输入框:', input.id || input.name || '(no id)');

        loadMappingJSON()
            .then(raw => {
                log('pinyin_mapping 已加载，开始构建 Name→Entry 映射');
                buildNameMap(raw);
                log('加载 pinyin_mapping 项数:', NAME2ENTRY.size);

                collectVisibleItems();
                bindInput();

                const mo = new MutationObserver(() => debouncedCollect());
                mo.observe(document.body, { childList: true, subtree: true });
            })
            .catch(e => console.error(LOG_PREFIX, '初始化失败:', e));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

