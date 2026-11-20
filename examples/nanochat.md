# nanochat 验收

用工作区的 `../nanochat-master` 实测，日期 **2026-11-20**。只读取目标源码，没有修改项目、运行训练、安装 PyTorch 或下载权重。

- 目录扫描：收录全部 **36 个 Python 文件**；检测到 **80 条项目内导入关系**，无 AST 解析错误。逐文件验证源码文本、原始字节 SHA-256 和节点行范围。
- `GPT.forward`：验证横向开头和缓存的 Yes/No 分支、Transformer 循环，代码组可展开和恢复；在交叉熵 L520 验证搜索、双向定位、源码折叠后自动展开。
- `download_single_file`：源码 L100 的尝试循环、异常分支以及回环可见；可选择异常/回环静态路径。
- `scripts/base_train.py:L426` → `nanochat/loss_eval.py:L8`：从调用节点打开真实目标，返回时恢复源码滚动、画布变换和高亮；刷新后仍定位原代码。动态 `model(x, y)` 不提供假跳转。
- `Engine.generate` L259：识别并标记 `use_calculator` 调用。
- Edge/Chromium 离线 `file://` 回归通过。验证白底总览、文件搜索与折叠、缩放/拖动、路径调暗、播放/暂停/复位、返回总览以及窄屏。`GPT.forward` 放大到 250% 后，验证指针锚点、箭头与节点的对齐、点击回到源码行，并检查放大截图；无 JS 异常和 HTTP(S) 请求。

## 重建

在 `CodeLens/` 运行：

```powershell
$env:CODELENS_NANOCHAT_ROOT = (Resolve-Path ../nanochat-master).Path
python codelens/scripts/codelens.py build $env:CODELENS_NANOCHAT_ROOT --notes examples/nanochat-notes.json --out output/index.html --analysis-out output/analysis.json --force
python -B -m unittest discover -s tests -v
node --test tests/test_graph.mjs
```

`nanochat-notes.json` 绑定验收快照。不同版本的 nanochat 先去掉 `--notes` 生成，或重新检查、更新对应笔记。运行实际浏览器回归时，可用已装的 Edge/Chromium (`BROWSER_EXECUTABLE`)，或安装 Playwright Chromium：

```bash
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node tests/nanochat-browser.mjs output/index.html
```

这些依赖只用于测试。交付 `index.html` 自带源码和资源，双击即可。`output/analysis.json` 是同一份分析数据，网页不依赖它。
