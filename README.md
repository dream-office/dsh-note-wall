# dsh-note-wall · 便签墙

在 DeepSeek Harness 左栏加一个**便签墙**入口：随手把灵感贴到墙上，用颜色、分类和文件夹整理，并可以加**链接**、**图片**、**提醒**，做完整 ZIP 备份。
便签只保存在本机：页面不访问外部网络，文字和图片只在本机回环 HTTP 与文件系统之间传递，也不会写进任何会话日志。

> 版本：**1.2.0** · MIT · Node >= 22.13

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
7. 工具栏支持**搜索**（正文/标签/链接）和**颜色/分类/文件夹筛选**，可以叠加；点「设置」可开关分类历史、文件夹、提醒、全局提醒、AI 写入，并选择图片模式（缩略图/小图标/大图）。
8. 启用提醒后，可在输入卡或编辑卡里选日期时间；到点会提醒，关闭 Harness 期间错过的会在重开后补提醒。提醒/通知/全局弹窗默认关闭，需在设置里主动开启。
9. 启用文件夹后可新建/重命名/删除文件夹（删夹不删便签），也可进入选择模式批量移入。
10. 工具栏「完整备份 ZIP」导出 `notes.json` + `images/` + `manifest.json` + 可选 `settings.json`；导入可选替换或合并，替换前会自动备份当前墙。

## 数据

| 项 | 值 |
|---|---|
| 存储位置 | `$DSH_HOME/note-wall/store.json`（未设置 `DSH_HOME` 时为 `~/.dsh/note-wall/store.json`） |
| 图片位置 | `$DSH_HOME/note-wall/images/<uuid>.<扩展名>` |
| 设置位置 | `$DSH_HOME/note-wall/settings.json`（默认开启缩略图；分类历史/文件夹/提醒/全局提醒/AI 写入默认关） |
| 备份位置 | `$DSH_HOME/note-wall/backups/note-wall-auto-<时间>.zip`（替换导入前自动生成） |
| 共享范围 | 同一个 `$DSH_HOME` 下的所有 profile 共用一面墙 |
| 格式 | `{ "version": 2, "folders": [...], "notes": [...] }`，写入时先写唯一临时文件再原子替换；图片单独按文件保存 |
| 条数上限 | 500 条 |
| 文件夹上限 | 100 个，名称 40 字符 |
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
- `GET /plugins/dsh-note-wall/backup`：完整备份 ZIP（notes.json + images + manifest + 可选 settings.json，带 `x-dsh-note-wall: 1`）。
- `POST /plugins/dsh-note-wall/backup`：导入 ZIP（原始字节，`mode=replace|merge`，可选 `applySettings=0|1`，带 `x-dsh-note-wall: 1`）。
- `GET /plugins/dsh-note-wall/image/<id>`：读取图片。`<img>` 请求无法附加自定义请求头，所以这条路由不做插件头校验；
  图片 id 是随机 UUID、没有列表路由，处理器只读取插件自己的 `images` 目录，路径不匹配一律 404。

上传按文件头校验真实格式（不只看扩展名或 Content-Type），大小、数量、字符数都由 Host 校验；便签里只能引用
`<uuid>.<png|jpg|webp|gif>` 形式的 id，且该图片文件必须真实存在，不能把服务指向任意路径。
ZIP 导入校验路径穿越、绝对路径、未知文件、重复条目、加密/不支持的压缩、CRC、总解压大小与图片数；
替换导入会先在 `backups/` 自动备份当前墙，校验失败不会改动现有数据。
便签存储不可用（例如损坏且无法保留）时，上传也会被拒绝（503），不会留下无法关联的图片文件。

## 安装与卸载

### 从 GitHub 获取

```bash
git clone https://github.com/dream-office/dsh-note-wall.git
```

本包**不发布到 npm**，从 GitHub 克隆安装。

在本机 Harness 里用 `plugin_manager`：

- 安装：`install_bundle`，`target` 指向克隆下来的 `dsh-note-wall` 目录（绝对路径）。
- 卸载：`remove_bundle`，`target` 为 `dsh-note-wall`。

安装后左栏会出现便签图标；Web 端的浏览器代码需要刷新一次页面才会加载。

### 本地开发目录

直接把 `target` 指向本仓库目录即可；修改 `client.js` 后刷新页面生效。

## 开发

```bash
node --check index.js
node --check client.js
node --check lib/store.js
node --check lib/settings.js
node --check lib/images.js
node --check lib/backup.js
node test/store.test.mjs
node test/route.test.mjs
node test/signature.test.mjs
node test/tool.test.mjs
node test/settings.test.mjs
node test/ui.test.mjs
node test/backup.test.mjs
```

或：

```bash
npm run check
npm test
```

- Host 半（`index.js`）只负责同源鉴权、请求解析和错误映射；存储与清理逻辑在 `lib/store.js`，图片格式识别在 `lib/images.js`，设置持久化在 `lib/settings.js`，ZIP 备份在 `lib/backup.js`。
- Web 半（`client.js`）是手写的 module-loader 模块：只 `require('react')`，不 import 任何 Harness Client 包，
  不写 `document.body/head`，界面颜色来自 `--dsw-alias-*` 主题 token，便签底色是插件自己的配色。
  暗色主题下会降低便签混色强度，并让文字/输入控件用主题前景色的高不透明度混色，保证对比度。
- 两半通过上面几条路由通信，图片在提交便签时先上传、拿到 id 后随便签保存；添加失败会尝试回收已上传的图片。
- 提醒/全局提醒是客户端功能：关闭时不会启动 interval、Notification、AudioContext 或 overlay 节点。

## 兼容性与已知限制

- 仅 Web GUI：需要 `ctx.webServer`，支持 `exact` 与 `prefix` 路由；没有 CLI / headless 形态。
- 便签操作使用 `connection.requestRejection` 做请求准入；该服务缺失时回退到同源 Origin 校验。
  回退只防浏览器跨站请求，不防本机进程伪造 `Host`/`Origin`；本机部署请保留 `connection` 服务。
- 便签必须有文字；链接和图片是附件，暂不支持纯图片便签。
- 单机单用户，无多用户 ACL；图片读取路由不带插件头，依赖不可猜的随机 UUID；数据明文存盘。
- 同一 `$DSH_HOME` 建议只由一个 Harness 进程使用（无跨进程文件锁）；同一 home 下所有 profile 共用一面墙。
- 上限：500 条 / 100 个文件夹 / 单条 500 字 / 分类 24 字 / 链接 2048 字 / 图片 3MB（PNG、JPEG、WebP、GIF）。
- 搜索、颜色/分类/文件夹筛选、提醒、完整 ZIP 备份已支持；无分页，超过 500 条需先删。
- 新功能默认关：分类历史、文件夹、提醒、全局提醒、AI 写入；图片默认缩略图。可在便签墙「设置」或 DSH 设置页打开。
- AI 写入不是默认能力：`note_wall_add` 需要先在设置里打开；关闭时 Host 侧直接拒绝。
- 自动化测试覆盖 Host + store + 设置 + ZIP + 落款/搜索/导入导出/卡片渲染（120 条）；client 浏览器交互仍无自动化测试，CI 不做浏览器/视觉验收。
- 浏览器通知权限、提示音自动播放、`shell.overlay` 层级需要真人手验；关闭提醒后不会启动定时器/声音/弹窗。
- 正常添加失败会回收已上传图片；若进程在「上传成功、add 请求未发出」之间崩溃，可能留下未被引用的图片文件（无自动 GC）。
- 自定义色为保证文字对比度，采用近中性底色 + 同色边框，不是整块浓色。
- 开发/测试 Node ≥ 22（engines 已写）。

## 签名

面板页脚有 `dream-office` 落款；首次加载会在控制台留下一行项目签名。
落款不写入便签数据，也不影响任何操作。规范见 [DESIGN-SIGNATURE.md](DESIGN-SIGNATURE.md)。

## 贡献与安全

- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题：[SECURITY.md](SECURITY.md)

## 许可证

[MIT](LICENSE) © dream-office

---

dream-office · 把灵感，一张一张贴起来。
