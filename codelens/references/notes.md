# CodeLens 笔记格式 v1

笔记是可选的 UTF-8 JSON。只写实际查过的文件和作用域；节点 ID 和文件 SHA-256 从 `inspect` 取。网页将笔记当纯文本显示，不解析 HTML。最小结构为 `{"version":1,"files":{}}`。

```json
{
  "version": 1,
  "project": "一个用来学习 Python 项目结构的小工具。",
  "catalog": {"tests": "回归测试", "docs/setup.md": "开发环境安装说明"},
  "files": {
    "app.py": {
      "sha256": "从 inspect 复制原始字节 SHA-256",
      "summary": "解析命令并调用相应处理函数。",
      "key": true,
      "focus": {"scope": "main"},
      "scopes": {
        "main": {
          "steps": {"12:4": {"title": "选择处理器", "summary": "从命令名称查找已注册的处理函数。"}},
          "groups": [{"first": "8:4", "last": "10:4", "title": "准备参数", "summary": "读取选项，并填入默认值。"}]
        }
      }
    }
  }
}
```

- `project` 是一句项目简介；`catalog` 给已存在的目录或非源码文件加简短描述。源码文件的说明放在 `files[path].summary`。
- `focus.scope` 指定打开文件时默认显示的函数、类或 `(module)`。可选 `focus.node` 指向该 scope 下真实的控制结构节点，`focus.label` 给下拉中的局部视图命名；用户仍可换回完整文件或函数。
- `steps` 只覆盖节点显示名和讲解，不改变真实行号、边或调用目标。`groups` 只可合并同一分支下相邻的普通语句，不得跨越判断、循环、异常处理和退出点；点击 `+` 可回到原始节点。
- 每个带笔记的源码文件必须验证 SHA-256。源文件更新后，重新检查受影响的笔记；不要绕过校验。多个 `--notes` 文件须覆盖不重叠的文件和目录。
- 默认只放一句话；`summary` 不要复述语法，要指出该操作在当前流程里的作用。对形状、动态绑定和异常路径，区分源码证据、约束和推测。`examples/nanochat-notes.json` 是真实例子。
