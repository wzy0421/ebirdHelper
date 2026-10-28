import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, fixture, readJSON, readSource, sleep } from './harness.js';

const birdMap = readJSON('birdMap.json');
const pinyin = readJSON('pinyin_mapping.json');

const HOTSPOT = { url: 'https://ebird.org/hotspot/L109516', html: fixture('hotspot.html') };
const SUBMIT = { url: 'https://ebird.org/submit/checklist?subID=S1', html: fixture('submit.html') };
const LIFELIST_URL = 'https://ebird.org/lifelist?time=life&r=world';

function observation(commonName, latinName) {
    return `<div class="Observation"><span class="Heading-main">${commonName}</span>` +
        `<span class="Heading-sub--sci">${latinName}</span></div>`;
}

function addToLifelist(document, species) {
    document.querySelector('section#nativeNatProv')
        .insertAdjacentHTML('beforeend', species.map(([c, l]) => observation(c, l)).join(''));
}

const LIFE = [
    ['American Coot', 'Fulica americana'],
    ['Mallard', 'Anas platyrhynchos'],
    ['Northern Shoveler', 'Spatula clypeata'],
    ['Eurasian Tree Sparrow', 'Passer montanus'],
    ['Ring-necked Duck', 'Aythya collaris'],
    ['Common Ostrich', 'Struthio camelus'],
];
const asSaved = list => list.map(([commonName, latinName]) => ({ commonName, latinName }))
    .sort((a, b) => a.commonName.localeCompare(b.commonName));

// ---------- 名称替换 + 高亮 ----------

test('hotspot：英文名后加中文名，未见鸟种加星号高亮，已见的不动', async () => {
    const page = await openPage({
        ...HOTSPOT,
        localStorage: { ebirdSpeciesList: [{ commonName: 'American Coot', latinName: 'Fulica americana' }] },
    });
    try {
        assert.equal(page.scriptError, null);
        const names = [...page.document.querySelectorAll('.Species-common')];
        const [duck, shoveler, coot] = names;

        assert.equal(duck.textContent, birdMap['Ring-necked Duck'] + '*');
        assert.equal(duck.getAttribute('data-ebird-unseen'), '1');
        assert.equal(shoveler.getAttribute('data-ebird-unseen'), '1');
        assert.equal(duck.style.getPropertyValue('--ebird-highlight'), '#A35F00');
        assert.equal(duck.hasAttribute('data-ebird-endemic'), false);

        assert.equal(coot.textContent, birdMap['American Coot']);
        assert.equal(coot.hasAttribute('data-ebird-unseen'), false);
    } finally {
        page.close();
    }
});

test('单文件版本：数据已内联，不再请求 birdMap', async () => {
    const page = await openPage({ ...HOTSPOT, source: readSource('eBirdHelperSingleFile.js') });
    try {
        assert.equal(page.scriptError, null);
        assert.equal(page.document.querySelector('.Species-common').textContent, birdMap['Ring-necked Duck'] + '*');
        assert.deepEqual(page.requests.filter(r => /birdMap\.json$/.test(r.url)), []);
    } finally {
        page.close();
    }
});

// ---------- 问题 2：@grant 与首次加载 ----------

test('首次加载（无缓存）：数据能拉下来并写入 GM 缓存', async () => {
    const page = await openPage(HOTSPOT);
    try {
        assert.equal(page.scriptError, null);
        assert.ok(page.gmStore.has('ebh_cn_map_cache_v1'), 'birdMap 应写入缓存');
        assert.deepEqual(page.requests.filter(r => !/\/(birdMap|pinyin_mapping)\.json$/.test(r.url)), []);
    } finally {
        page.close();
    }
});

test('第二次加载：命中缓存，后台带 If-None-Match 刷新拿到 304', async () => {
    const gmStore = new Map();
    (await openPage({ ...HOTSPOT, gmStore })).close();

    const page = await openPage({ ...HOTSPOT, gmStore });
    try {
        await sleep(50);
        assert.equal(page.scriptError, null);
        const refresh = page.requests.filter(r => r.url.endsWith('birdMap.json'));
        assert.equal(refresh.length, 1);
        assert.ok(refresh[0].headers['If-None-Match']);
        assert.equal(refresh[0].status, 304);
    } finally {
        page.close();
    }
});

// ---------- 网络请求：页面 CSP 拦截 fetch，必须走 GM.xmlHttpRequest ----------

test('所有 GitHub 请求都走 GM.xmlHttpRequest，不用 fetch', async () => {
    for (const where of [HOTSPOT, SUBMIT]) {
        const page = await openPage(where);
        try {
            await sleep(100);
            assert.equal(page.scriptError, null);
            assert.ok(page.requests.length > 0);
            assert.deepEqual(page.requests.filter(r => r.via !== 'GM.xmlHttpRequest'), []);
        } finally {
            page.close();
        }
    }
});

test('没有 @connect raw.githubusercontent.com 时首次加载失败（确认测试框架会拦）', async () => {
    const source = readSource().replace(/^\/\/\s*@connect.*\r?\n/m, '');
    assert.doesNotMatch(source, /^\/\/\s*@connect/m);
    const page = await openPage({ ...HOTSPOT, source });
    try {
        assert.match(String(page.scriptError), /Request failed/);
    } finally {
        page.close();
    }
});

// ---------- 问题 1 / 6：@pinyin ----------

async function typeInJump(page, value) {
    const input = page.document.querySelector('#jumpToSpp');
    input.value = value;
    input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    return input;
}

async function openSubmitWithPinyin() {
    const page = await openPage(SUBMIT);
    // 等 pinyin_mapping 加载 + collectVisibleItems
    for (let i = 0; i < 50 && !page.logs.some(l => String(l[2]).includes('已绑定')); i++) await sleep(10);
    return page;
}

test('@pinyin：从当前分支加载 pinyin_mapping.json，并出现候选', async () => {
    const page = await openSubmitWithPinyin();
    try {
        const req = page.requests.find(r => r.url.endsWith('pinyin_mapping.json'));
        assert.ok(req, '应请求 pinyin_mapping.json');
        assert.match(req.url, /\/ebirdHelper\/main\/pinyin_mapping\.json$/);
        assert.equal(req.status, 200);

        await typeInJump(page, '@' + pinyin['Mallard'].pinyin);
        const items = page.document.querySelectorAll('.__pinyin-item');
        assert.equal(items.length, 1);
        assert.match(items[0].textContent, /^Mallard/);
    } finally {
        page.close();
    }
});

test('@pinyin：点击候选跳到对应的计数输入框', async () => {
    const page = await openSubmitWithPinyin();
    try {
        await typeInJump(page, '@' + pinyin['Eurasian Tree Sparrow'].initials);
        const item = page.document.querySelector('.__pinyin-item');
        item.dispatchEvent(new page.window.MouseEvent('mousedown', { bubbles: true }));
        assert.equal(page.document.activeElement.id, 'eutspa');
    } finally {
        page.close();
    }
});

test('@pinyin：回车选中第一个候选', async () => {
    const page = await openSubmitWithPinyin();
    try {
        const input = await typeInJump(page, '@' + pinyin['Mallard'].pinyin);
        input.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        assert.equal(page.document.activeElement.id, 'mallar3');
    } finally {
        page.close();
    }
});

// ---------- 问题 5：替换范围 ----------

test('不改动 textarea、可编辑区域和脚本里的文字，普通文字照常替换', async () => {
    const page = await openPage(SUBMIT);
    try {
        const doc = page.document;
        assert.equal(doc.querySelector('textarea').value, 'Saw a Mallard near the lake');
        assert.equal(doc.querySelector('[contenteditable="true"]').textContent, 'Mallard notes');
        assert.equal(doc.querySelector('script').textContent, 'var note = "Mallard";');
        assert.equal(doc.querySelector('#name_mallar3 span').textContent, birdMap['Mallard']);

        // 动态插入的 textarea 也不替换
        doc.body.insertAdjacentHTML('beforeend', '<textarea id="late">Mallard again</textarea>');
        await sleep(20);
        assert.equal(doc.querySelector('#late').value, 'Mallard again');
    } finally {
        page.close();
    }
});

// ---------- 问题 3 / 4：生涯清单同步 ----------

test('生涯清单陆续加载：等列表稳定后再同步，不误删', async () => {
    const page = await openPage({
        url: LIFELIST_URL, html: fixture('lifelist.html'), speed: 10,
        localStorage: { ebirdSpeciesList: asSaved(LIFE) },
    });
    try {
        // 10 倍速下每 90ms（相当于 0.9s）来一个，持续到“2 秒”以后，模拟慢速分批渲染
        for (const species of LIFE) {
            addToLifelist(page.document, [species]);
            await sleep(90);
        }
        await sleep(400);
        assert.deepEqual(page.dialogs, []);
        assert.deepEqual(page.savedSpecies(), asSaved(LIFE));
    } finally {
        page.close();
    }
});

test('生涯清单：新增物种会合并进本地列表', async () => {
    const page = await openPage({
        url: LIFELIST_URL, html: fixture('lifelist.html'), speed: 10,
        localStorage: { ebirdSpeciesList: asSaved(LIFE.slice(0, 4)) },
    });
    try {
        addToLifelist(page.document, LIFE);
        await sleep(400);
        assert.deepEqual(page.savedSpecies(), asSaved(LIFE));
        assert.deepEqual(page.dialogs.map(d => d[0]), ['alert']);
    } finally {
        page.close();
    }
});

test('生涯清单为空：不覆盖本地列表', async () => {
    const page = await openPage({
        url: LIFELIST_URL, html: fixture('lifelist.html'), speed: 40,
        localStorage: { ebirdSpeciesList: asSaved(LIFE) },
    });
    try {
        await sleep(700); // 20s 上限 / 40 倍速
        assert.deepEqual(page.savedSpecies(), asSaved(LIFE));
    } finally {
        page.close();
    }
});

for (const [answer, expected] of [[true, LIFE], [false, [...LIFE, ['Dodo', 'Raphus cucullatus']]]]) {
    test(`生涯清单：本地多出的物种，confirm 选${answer ? '确定则删除' : '取消则保留'}`, async () => {
        const page = await openPage({
            url: LIFELIST_URL, html: fixture('lifelist.html'), speed: 10, confirm: () => answer,
            localStorage: { ebirdSpeciesList: asSaved([...LIFE, ['Dodo', 'Raphus cucullatus']]) },
        });
        try {
            addToLifelist(page.document, LIFE);
            await sleep(400);
            assert.equal(page.dialogs.filter(d => d[0] === 'confirm').length, 1);
            assert.deepEqual(page.savedSpecies(), asSaved(expected));
        } finally {
            page.close();
        }
    });
}

test('脚本在 load 之后才启动时，生涯清单仍会同步', async () => {
    const page = await openPage({
        url: LIFELIST_URL, html: fixture('lifelist.html'), speed: 10, afterLoad: true,
        localStorage: { ebirdSpeciesList: asSaved(LIFE.slice(0, 2)) },
    });
    try {
        addToLifelist(page.document, LIFE);
        await sleep(400);
        assert.deepEqual(page.savedSpecies(), asSaved(LIFE));
    } finally {
        page.close();
    }
});
