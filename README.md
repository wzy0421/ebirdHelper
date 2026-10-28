# ebirdHelper
TamperMonkey script for enhancing experience of ebird website.

The feature of this script include:
- Append Chinese common name after English common name.
- Highlight unseen species. All species not in your life list will be highlighted. Every time you enter your species list page, your list will be updated.
- Type `@` plus pinyin or its initials in the "Jump to Species" box of a checklist to jump to a species by its Chinese name.

The names come from eBird's Simplified Chinese (zh_SIM_CN) name list, which follows the current
eBird taxonomy, so every species has a Chinese name.

`birdMap.json` and `pinyin_mapping.json` are copies of the name tables kept in the bird_data repo,
which also holds the name list and the scripts that build them; `VENDORED.toml` records which
version each copy is. Change them there and copy them here again.

## 测试

```
npm install
npm test
```

测试在 jsdom 里模拟 Tampermonkey 运行脚本（`tests/harness.js`）：GM 只暴露 `@grant` 声明过的 API，
`GM.xmlHttpRequest` 只放行 `@connect` 声明过的域名，raw.githubusercontent.com 的请求映射到本地工作区文件；
和真实的 eBird 页面一样，用 `fetch` 连 GitHub 会失败（页面 CSP 拦截）。页面用 `tests/fixtures/` 里的 HTML，
其中 hotspot 取自真实页面，需要登录的提交清单页和生涯清单页是按脚本选择器合成的。
标成 `todo` 的测试对应已知、尚未修复的问题。

Tampermonkey 的执行环境本身测不到，仍需在浏览器里确认。
用 `EBH_SOURCE=<文件>` 可以拿别的版本跑同一套测试来对比。
