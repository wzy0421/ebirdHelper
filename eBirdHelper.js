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

    console.log(`[eBird Species Tracker] Total species in list: ${updatedList.length}`);
}

function getRelevantElements() {
    const url = location.href;
    console.log('[eBird] 当前页面 URL:', url);

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

    console.log('[eBird] 未匹配到特定页面类型，返回空数组');
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
    console.log(`[eBird] 当前已见鸟种数量: ${seenBirds.size}`);

    let targets = [];
    if (ENABLE_PARTIAL_MATCH) {
        targets = getRelevantElements();
    }
    /*if (ENABLE_FULL_MATCH || targets.length === 0) {
        targets = document.querySelectorAll('.Heading-main');
        console.log(`[eBird] fallback 使用 .Heading-main 匹配元素数量: ${targets.length}`);
    }*/

    console.log(`[eBird] 最终处理元素数量: ${targets.length}`);

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
                console.log('[eBird] DOM 变化触发重新标记');
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

    // URL 守卫（不影响其它页面中已存在的代码）
    if (!/^https:\/\/ebird\.org\/submit\/checklist/.test(location.href) && !/^https:\/\/ebird\.org\/edit\/checklist/.test(location.href)) return;

    const log = (...a) => console.log('[eBird PinyinTypeahead]', ...a);
    const debounce = (fn, ms = 120) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
    const txt = el => (el ? (el.textContent || '').trim() : '');
    const makeInitials = (p) => (p || '').replace(/[^a-zA-Z]/g, ' ').trim().split(/\s+/).map(w => w[0] || '').join('').toLowerCase();

    const INPUT_SEL = '#jumpToSpp';
    const RAW_URL = 'https://raw.githubusercontent.com/wzy0421/ebirdHelper/dev/pinyin_mapping.json';
    const CACHE_KEY = 'pinyin_mapping_cache_v2_kvshape';
    const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

    function gmFetchJSON(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    headers: { 'Accept': 'application/json' },
                    onload: (res) => {
                        try {
                            if (res.status >= 200 && res.status < 300) resolve(JSON.parse(res.responseText));
                            else reject(new Error(`HTTP ${res.status}`));
                        } catch (e) { reject(e); }
                    },
                    onerror: (e) => reject(e),
                    timeout: 15000,
                    ontimeout: () => reject(new Error('timeout')),
                });
            } else {
                fetch(url, { credentials: 'omit' })
                    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
                    .then(resolve, reject);
            }
        });
    }

    async function loadMappingJSON() {
        try {
            const cached = 'null'; // JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
            if (cached && cached.shape === 'kv' && cached.data && (Date.now() - cached.ts < CACHE_TTL)) {
                log('使用缓存 pinyin_mapping（kv 结构）');
                return cached.data;
            }
        } catch { }

        const data = await gmFetchJSON(RAW_URL); // 期望是 { "Emu": {pinyin, initials}, ... }
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), shape: 'kv', data })); } catch { }
        return data;
    }

    // 将 { "Name": {pinyin, initials, latinName?} } 转为：
    //   MAPPING: [{commonName, latinName, pinyin, initials}, ...]
    //   NAME2ITEM: Map(lower(commonName) -> item)
    function buildFromKeyedObject(rawObj) {
        const arr = [];
        const map = new Map();
        if (rawObj && typeof rawObj === 'object' && !Array.isArray(rawObj)) {
            for (const [commonName, v] of Object.entries(rawObj)) {
                if (!commonName) continue;
                const pinyin = (v && v.pinyin ? String(v.pinyin) : '').toLowerCase();
                const initials = (v && v.initials ? String(v.initials) : makeInitials(pinyin)).toLowerCase();
                // 允许可选的拉丁名字段（若你将来想加）：
                const latinName = (v && (v.latinName || v.scientific)) ? String(v.latinName || v.scientific) : '';
                if (!pinyin && !initials) continue; // 至少要有一个可匹配字段
                const item = { commonName, latinName, pinyin, initials };
                arr.push(item);
                map.set(commonName.toLowerCase(), item);
            }
        }
        return { arr, map };
    }

    let visibleSet = new Set();
    const collectVisible = () => {
        const found = new Set();

        // 1) 首选：eBird 提交页的标准结构
        document.querySelectorAll('.SubmitChecklist-species-name span').forEach(span => {
            let common = '';

            // 先尝试精确取纯英文名：只拼接文本节点（忽略 <em class="sci">…</em>）
            span.childNodes.forEach(node => {
                if (node.nodeType === Node.TEXT_NODE) {
                    common += node.nodeValue || '';
                }
            });

            common = (common || '').trim();

            // 兜底：如果上面没拿到（极少数结构不同），再从 .Heading-main / .ChecklistRow-name 补一次
            if (!common) {
                const row = span.closest('[data-observation-id]') || span.closest('.Observation') || span.closest('.ChecklistRow');
                const main =
                    row?.querySelector('.Heading-main') ||
                    row?.querySelector('.ChecklistRow-name');
                if (main) {
                    common = (main.textContent || '').trim();
                }
            }

            if (common) {
                // 去尾部括注/星号（若英文名后面还有备注）
                common = common.replace(/\s*\([^)]*\)\s*$/, '').replace(/\*+$/, '').trim();
                // 去可能的中文括注（保险处理）
                common = common.replace(/（.*?）|\(.*?[\u4e00-\u9fa5].*?\)/g, '').trim();
                if (common) found.add(common.toLowerCase());
            }
        });

        // 2) 若上面路径没有匹配到（某些布局），再尝试其它常见容器
        if (found.size === 0) {
            document.querySelectorAll('[data-observation-id] .Heading-main, .ChecklistRow .ChecklistRow-name').forEach(el => {
                // 只取纯文本节点（避免子元素带学名/附注）
                let common = '';
                el.childNodes.forEach(node => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        common += node.nodeValue || '';
                    }
                });
                common = (common || '').trim()
                    .replace(/\s*\([^)]*\)\s*$/, '')
                    .replace(/\*+$/, '')
                    .replace(/（.*?）|\(.*?[\u4e00-\u9fa5].*?\)/g, '')
                    .trim();
                if (common) found.add(common.toLowerCase());
            });
        }

        visibleSet = found;
        console.log('[eBird PinyinTypeahead] 可见物种数:', visibleSet.size);
    };


    function getDom() {
        const input = document.querySelector(INPUT_SEL);
        if (!input) return { input: null, dropdown: null, list: null };
        const dropdownId = input.getAttribute('aria-controls') || 'Suggest-dropdown-jumpToSpp';
        const dropdown = document.getElementById(dropdownId) || document.querySelector('#Suggest-dropdown-jumpToSpp') || null;
        const list = dropdown ? dropdown.querySelector('.Suggest-suggestions') : null;
        return { input, dropdown, list };
    }
    function ensureOpen(dropdown) {
        if (!dropdown) return;
        dropdown.style.display = '';
        dropdown.parentElement?.setAttribute('aria-expanded', 'true');
    }
    function ensureClosed(dropdown) {
        if (!dropdown) return;
        dropdown.style.display = 'none';
        dropdown.parentElement?.setAttribute('aria-expanded', 'false');
    }

    function makeItemNode(item, onPick) {
        const wrap = document.createElement('div');
        wrap.className = 'Suggest-suggestion';
        wrap.setAttribute('role', 'option');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'Button Button--link u-text-left u-block';
        btn.innerHTML = `
      <div class="u-text-3">${item.commonName}</div>
      ${item.latinName ? `<div class="u-text-4 u-muted">${item.latinName}</div>` : ''}
    `;
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => onPick(item.commonName));
        wrap.appendChild(btn);
        return wrap;
    }

    function renderList(listEl, dropdown, items, onPick) {
        if (!listEl || !dropdown) return;
        listEl.innerHTML = '';
        if (!items.length) {
            const empty = dropdown.querySelector('.Suggest-empty');
            listEl.appendChild(empty ? empty.cloneNode(true) : document.createElement('div'));
        } else {
            items.forEach(it => listEl.appendChild(makeItemNode(it, onPick)));
        }
        ensureOpen(dropdown);
    }

    function pickCommonName(commonName) {
        const { input, dropdown } = getDom();
        if (!input) return;
        input.value = commonName;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
        ensureClosed(dropdown);
    }

    let MAPPING = [];          // Array<{commonName, latinName, pinyin, initials}>
    let NAME2ITEM = new Map(); // Map<lowerName, item>

    function byTerm(arr, term) {
        const t = (term || '').toLowerCase().trim();
        if (!t) {
            // 空输入时不展示庞大列表：按需返回空数组
            return [];
        }

        const exact = [];
        const starts = [];
        const contains = [];

        for (const it of arr) {
            const p = (it.pinyin || '').toLowerCase();
            const ini = (it.initials || '').toLowerCase();

            const isExact = (p === t) || (ini === t);
            if (isExact) {
                exact.push(it);
                continue;
            }

            const isStart = p.startsWith(t) || ini.startsWith(t);
            if (isStart) {
                starts.push(it);
                continue;
            }

            const isContains = p.includes(t) || ini.includes(t);
            if (isContains) {
                contains.push(it);
            }
        }

        // 规则 1：短输入（<=2）且匹配总数 > 5，仅显示精确匹配
        if (t.length <= 2) {
            const total = exact.length + starts.length + contains.length;
            if (total > 5) {
                // 只显示精确匹配（即使为空也按规则为空）
                return exact.slice(0, 50);
            }
        }

        // 规则 2：长输入（>2）或短输入但总数<=5：显示全部（精确优先，其次前缀、包含）
        return [...exact, ...starts, ...contains].slice(0, 50);
    }

    function matchLocal(term) {
        const cands = [];
        for (const lowerName of visibleSet) {
            const mapped = NAME2ITEM.get(lowerName);
            if (mapped) cands.push(mapped);
        }
        return byTerm(cands, term);
    }
    function matchGlobal(term) {
        return byTerm(MAPPING, term);
    }

    let overrideOn = false;

    function onInputCapture(e) {
        const { input, dropdown, list } = getDom();
        if (!input || !dropdown || !list) return;

        const v = input.value || '';
        if (v.startsWith('@@')) {
            overrideOn = true;
            e.stopImmediatePropagation();
            const term = v.slice(2).trim();
            renderList(list, dropdown, matchGlobal(term), pickCommonName);
        } else if (v.startsWith('@')) {
            overrideOn = true;
            e.stopImmediatePropagation();
            const term = v.slice(1).trim();
            renderList(list, dropdown, matchLocal(term), pickCommonName);
        } else {
            if (overrideOn) {
                overrideOn = false;
                list.innerHTML = '';
            }
            // 交还原生
        }
    }

    function onKeydownCapture(e) {
        if (!overrideOn) return;
        const { list } = getDom();
        if (!list) return;
        const items = [...list.querySelectorAll('.Suggest-suggestion button')];
        if (!items.length) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            items[0].click();
        }
    }

    function bindInput() {
        const { input } = getDom();
        if (!input || input.__pinyinBound) return;
        input.__pinyinBound = true;
        input.addEventListener('input', onInputCapture, true);
        input.addEventListener('keydown', onKeydownCapture, true);
        log('已绑定 species 输入');
    }

    (async () => {
        try {
            const rawKV = await loadMappingJSON();                // 期望是对象而非数组
            const { arr, map } = buildFromKeyedObject(rawKV);     // 转换为数组与索引
            MAPPING = arr;
            NAME2ITEM = map;
            log('pinyin mapping (kv) 条数：', MAPPING.length);

            collectVisible();
            bindInput();

            const mo = new MutationObserver(debounce(() => {
                collectVisible();
                bindInput();
            }, 150));
            mo.observe(document.body, { childList: true, subtree: true });
        } catch (e) {
            console.error('[eBird PinyinTypeahead] 加载/初始化失败：', e);
        }
    })();

})();
