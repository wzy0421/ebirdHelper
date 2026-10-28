/**
 * 在 jsdom 里模拟 Tampermonkey 运行用户脚本，供 tests/*.test.js 使用。
 * - GM：只暴露 @grant 声明过的 API（与 Tampermonkey 一致），存储在内存 Map 里
 * - GM.xmlHttpRequest：只放行 @connect 声明过的域名；raw.githubusercontent.com/wzy0421/ebirdHelper/<分支>/
 *   映射到本地工作区文件，支持 ETag/304
 * - fetch 连 raw.githubusercontent.com 一律失败，和真实 eBird 页面一致（页面 CSP 拦截，Failed to fetch）
 * - 定时器按 speed 倍加速，避免测试等真实的 2s/4s
 * 测不到的：Tampermonkey 的执行环境本身，需要在浏览器里确认。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_PREFIX = /^https:\/\/raw\.githubusercontent\.com\/wzy0421\/ebirdHelper\/(?:main|dev)\//;

/** EBH_SOURCE 可以指向别的版本（例如 git show 出来的旧版本）来对比测试 */
export function readSource(name) {
    const file = name ? path.join(ROOT, name) : (process.env.EBH_SOURCE || path.join(ROOT, 'eBirdHelper.js'));
    return readFileSync(file, 'utf8');
}

export function readJSON(name) {
    return JSON.parse(readFileSync(path.join(ROOT, name), 'utf8'));
}

export function fixture(name) {
    return readFileSync(path.join(ROOT, 'tests', 'fixtures', name), 'utf8');
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseMeta(source, key) {
    return [...source.matchAll(new RegExp(`^\\/\\/\\s*@${key}\\s+(\\S+)`, 'gm'))].map(m => m[1]);
}

/** 按 raw.githubusercontent 的行为返回本地文件：{ status, statusText, body, etag } */
function serveRaw(url, headers) {
    const m = RAW_PREFIX.exec(url);
    const file = m && path.join(ROOT, url.slice(m[0].length));
    if (!file || !existsSync(file)) return { status: 404, statusText: 'Not Found', body: '404: Not Found', etag: null };
    const body = readFileSync(file, 'utf8');
    const etag = '"' + createHash('sha1').update(body).digest('hex') + '"';
    if (headers['If-None-Match'] === etag) return { status: 304, statusText: 'Not Modified', body: '', etag };
    return { status: 200, statusText: 'OK', body, etag };
}

function makeXmlHttpRequest(connects, requests) {
    return details => {
        const headers = { ...(details.headers || {}) };
        const entry = { via: 'GM.xmlHttpRequest', url: String(details.url), headers, status: 0 };
        requests.push(entry);
        setTimeout(() => {
            // Tampermonkey 拒绝 @connect 没声明的域名
            if (!connects.includes(new URL(entry.url).hostname)) {
                entry.status = -1;
                details.onerror?.({ error: 'not @connect-ed' });
                return;
            }
            const r = serveRaw(entry.url, headers);
            entry.status = r.status;
            details.onload?.({
                status: r.status,
                statusText: r.statusText,
                responseText: r.body,
                responseHeaders: (r.etag ? `etag: ${r.etag}\r\n` : '') + 'content-type: text/plain; charset=utf-8\r\n',
            });
        }, 0);
    };
}

function makeGM(source, store, requests) {
    const grants = parseMeta(source, 'grant');
    const all = {
        getValue: async (key, defaultValue) => (store.has(key) ? structuredClone(store.get(key)) : defaultValue),
        setValue: async (key, value) => { store.set(key, structuredClone(value)); },
        deleteValue: async key => { store.delete(key); },
        xmlHttpRequest: makeXmlHttpRequest(parseMeta(source, 'connect'), requests),
    };
    const gm = {};
    for (const [name, fn] of Object.entries(all)) {
        if (grants.includes('GM.' + name)) gm[name] = fn;
    }
    return gm;
}

/** eBird 页面的 CSP 不允许连接 raw.githubusercontent.com，fetch 直接失败 */
function makeFetch(requests) {
    return async url => {
        requests.push({ via: 'fetch', url: String(url), status: -1 });
        throw new TypeError('Failed to fetch');
    };
}

/**
 * 打开一个页面并注入脚本。
 * @param {object} o
 * @param {string} o.url           页面地址（脚本按 location.href 判断页面类型）
 * @param {string} o.html          页面 HTML
 * @param {string} [o.source]      脚本源码，默认 eBirdHelper.js
 * @param {Map}    [o.gmStore]     GM 存储，跨次加载传同一个 Map 可模拟“第二次打开”
 * @param {object} [o.localStorage] 预置 localStorage（值会 JSON.stringify）
 * @param {boolean}[o.afterLoad]   true：等 load 事件之后才注入（模拟脚本启动慢）
 * @param {function}[o.confirm]    confirm() 的返回值
 * @param {number} [o.speed]       定时器加速倍数
 */
export async function openPage(o) {
    const source = o.source ?? readSource();
    const gmStore = o.gmStore ?? new Map();
    const requests = [];
    const dialogs = [];
    const logs = [];
    const errors = [];
    const speed = o.speed ?? 40;

    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', e => errors.push(e));
    for (const level of ['log', 'warn', 'error', 'debug']) {
        virtualConsole.on(level, (...a) => logs.push([level, ...a]));
    }

    const dom = new JSDOM(o.html, { url: o.url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
    const w = dom.window;

    const rawSetTimeout = w.setTimeout.bind(w);
    const rawSetInterval = w.setInterval.bind(w);
    w.setTimeout = (fn, ms = 0, ...a) => rawSetTimeout(fn, ms / speed, ...a);
    w.setInterval = (fn, ms = 0, ...a) => rawSetInterval(fn, ms / speed, ...a);

    w.GM = makeGM(source, gmStore, requests);
    w.fetch = makeFetch(requests);
    w.alert = msg => dialogs.push(['alert', msg]);
    w.confirm = msg => { dialogs.push(['confirm', msg]); return o.confirm ? o.confirm(msg) : true; };
    w.Element.prototype.scrollIntoView = function () { };
    for (const [k, v] of Object.entries(o.localStorage || {})) {
        w.localStorage.setItem(k, JSON.stringify(v));
    }

    if (o.afterLoad && w.document.readyState !== 'complete') {
        await new Promise(r => w.addEventListener('load', r));
    }

    // Tampermonkey 支持顶层 await：包一层 async 函数执行
    let scriptError = null;
    try {
        await w.eval('(async () => {\n' + source + '\n})()');
    } catch (e) {
        scriptError = e;
    }

    return {
        window: w,
        document: w.document,
        gmStore,
        requests,
        dialogs,
        logs,
        errors,
        scriptError,
        savedSpecies: () => JSON.parse(w.localStorage.getItem('ebirdSpeciesList') || 'null'),
        close: () => w.close(),
    };
}
