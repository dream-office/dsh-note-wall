# dsh-note-wall · 便签墙

在 DeepSeek Harness 左栏加一个**便签墙**入口：随手把灵感贴到墙上，用颜色和分类整理，并可以给便签加**链接**和**图片**。
便签只保存在本机：页面不访问外部网络，文字和图片只在本机回环 HTTP 与文件系统之间传递，也不会写进任何会话日志。

## 使用

1. 点击左栏的便签图标打开「灵感便签墙」。
2. 在顶部的输入框写下灵感：
   - 底部圆点是便签颜色，默认暖黄；最后一个彩色圆点可以**自定义任意颜色**；
   - 「分类」可选，用于给便签加一个小标题；
   - 「链接」可选，填 `http` / `https` 地址，便签上会显示可点击的链接；
   - 「图片」按钮选择图片，也可以直接**粘贴**截图或把图片**拖进输入卡**；添加前会显示缩略图，可随时移除；
   - 点「添加到墙上」，或按 `⌘/Ctrl + Enter` 快速添加。
3. 右上角「动效」可以开关便签的入场、悬停和按钮动效；开关和上次选的颜色会记在浏览器本地。
4. 便签卡片右下角可以**编辑**（改文字、分类、颜色、链接，换图或移除图片）或**删除**（二次确认，图片一起清理）。
   如果这条便签在这期间被别处改过，保存时会提示并自动同步最新版本；再点一次「保存」会用你现在的内容覆盖它。
5. 编辑时在文本框里按 `Esc` 取消编辑；删除确认时按 `Esc` 取消删除。
6. 点便签上的图片可查看原图，点链接会在新标签页打开。

## 数据

| 项 | 值 |
|---|---|
| 存储位置 | `$DSH_HOME/note-wall/store.json`（未设置 `DSH_HOME` 时为 `~/.dsh/note-wall/store.json`） |
| 图片位置 | `$DSH_HOME/note-wall/images/<uuid>.<扩展名>` |
| 共享范围 | 同一个 `$DSH_HOME` 下的所有 profile 共用一面墙 |
| 格式 | `{ "version": 1, "notes": [...] }`，写入时先写唯一临时文件再原子替换；图片单独按文件保存 |
| 条数上限 | 500 条 |
| 单条字数 | 500 字符 |
| 分类长度 | 24 字符 |
| 链接长度 | 2048 字符，仅 `http` / `https` |
| 图片 | PNG / JPEG / WebP / GIF，单张不超过 3 MB |
| 颜色 | 暖黄、蜜桃、天蓝、薄荷、丁香、奶油，外加任意 `#RRGGBB` 自定义色 |
| 动效偏好 | 浏览器本地存储 `dsh-note-wall:prefs-v1`（开关 + 上次颜色），不写入便签存储 |
| 损坏处理 | 无法识别或无法解析的文件会改名成 `store.corrupt-<时间>.json` 保留；改名失败时插件停止读写，不会覆盖原文件 |

`note-wall` 目录由插件首次保存时创建，图片在首次上传时创建 `images/`。
删除便签或换图时，不再被任何便签引用的图片文件会被删除；删图失败只记录日志，不影响便签本身。
要清空便签墙：先停用插件（或退出 Harness），再删除这个目录；插件运行期间删除目录不会清掉内存里的便签。
同一份 `$DSH_HOME` 请只由一个 Harness 进程使用（没有跨进程文件锁）。

## 路由与安全

- `POST /plugins/dsh-note-wall/api`：便签操作（JSON，带 `x-dsh-note-wall: 1`）。
- `POST /plugins/dsh-note-wall/image`：图片上传（原始字节，带 `x-dsh-note-wall: 1`）。
- `GET /plugins/dsh-note-wall/image/<id>`：读取图片。`<img>` 请求无法附加自定义请求头，所以这条路由不做插件头校验；
  图片 id 是随机 UUID、没有列表路由，处理器只读取插件自己的 `images` 目录，路径不匹配一律 404。

上传按文件头校验真实格式（不只看扩展名或 Content-Type），大小、数量、字符数都由 Host 校验；便签里只能引用
`<uuid>.<png|jpg|webp|gif>` 形式的 id，且该图片文件必须真实存在，不能把服务指向任意路径。
便签存储不可用（例如损坏且无法保留）时，上传也会被拒绝（503），不会留下无法关联的图片文件。

## 安装与卸载

### 从 GitHub 获取

```bash
git clone https://github.com/dream-office/dsh-note-wall.git
```

在本机 Harness 里用 `plugin_manager`：

- 安装：`install_bundle`，`target` 指向克隆下来的 `dsh-note-wall` 目录（绝对路径）。
- 卸载：`remove_bundle`，`target` 为 `dsh-note-wall`。

安装后左栏会出现便签图标；Web 端的浏览器代码需要刷新一次页面才会加载。

### 本地开发目录

直接把 `target` 指向本仓库目录即可；修改 `client.js` 后刷新页面生效。

## 开发

```powershell
& $node --check index.js
& $node --check client.js
& $node --check lib\store.js
& $node --check lib\images.js
& $node test\store.test.mjs
& $node test\route.test.mjs
```

> 本机沙箱里 `node --test test\store.test.mjs` 会因 `spawn EPERM` 失败，直接执行测试文件即可（上面两条）。

- Host 半（`index.js`）只负责同源鉴权、请求解析和错误映射；存储与清理逻辑在 `lib/store.js`，图片格式识别在 `lib/images.js`。
- Web 半（`client.js`）是手写的 module-loader 模块：只 `require('react')`，不 import 任何 Harness Client 包，
  不写 `document.body/head`，界面颜色来自 `--dsw-alias-*` 主题 token，便签底色是插件自己的配色。
  暗色主题下会降低便签混色强度，并让文字/输入控件用主题前景色的高不透明度混色，保证对比度。
- 两半通过上面三条路由通信，图片在提交便签时先上传、拿到 id 后随便签保存；添加失败会尝试回收已上传的图片。

## 兼容性

- 需要 Harness 提供 `ctx.webServer`（Web GUI），并使用 `exact` 与 `prefix` 两类路由。
- 便签操作使用 `connection.requestRejection` 做请求准入；该服务缺失时回退到同源 Origin 校验。
  回退只防浏览器跨站请求，不防本机进程伪造 `Host`/`Origin`，本机部署请保留 `connection` 服务。

## 开发与贡献

- 语法检查：`npm run check`
- 测试：`npm test`（Node 内置测试，无第三方依赖）
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题：[SECURITY.md](SECURITY.md)

## 许可证

[MIT](LICENSE) © dream-office
