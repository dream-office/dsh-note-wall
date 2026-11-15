# Changelog

## [1.4.0] - 2026-11-15

### 新增

- UI 形状/尺寸归一（R11）：控件高度 28/32/36/44、圆角 10/12/20/999、字号 11/12/13/15/20、间距 4/8/12/16/24；所有可聚焦控件补 focus-visible。
- 状态补齐：错误 banner 变体（图标/文案/重试或关闭）、禁用态、loading 300ms 门槛。
- R12：设置弹窗/导入/文件夹弹窗等统一 Esc 只关最上层、Tab 焦点陷阱、关闭后焦点归还；提醒浮窗 Esc/外部关闭/焦点归还；编辑取消回卡片。
- 暖杏项目色（#E8A87C / accent-ink #7A4418）：只用于识别/选中/强调；背景、卡片、边框、正文继续用宿主 `--dsw-alias-*`；暗色由宿主 token 驱动；签名改用项目色，形状不变。
- 保留 1.3 文件夹方案 A 与缺失图片兜底；无 backdrop-filter。

### 说明

- 测试 146 通过（store 30 / route 19 / signature 7 / tool 5 / settings 10 / ui 57 / backup 18）。
- B5 真浏览器 320/360/亮暗截图复审未做（本会话无浏览器），不伪造；留待宿主侧。

## [1.3.0] - 2026-11-15

### 新增

- 文件夹交互方案 A：顶部常驻 chips（全部 / 未分类 / 各文件夹，带条数），单击筛选，`+` 内联新建。
- 文件夹 chip 支持右键、触屏长按 500ms、`Shift+F10` / Enter 打开菜单：重命名 / 删除文件夹。
- 卡片 `⋯` 菜单：移动到文件夹… / 编辑 / 删除便签；移动弹层显示各文件夹条数、当前项高亮，并支持新建文件夹后直接移入。
- 删除文件夹确认明确提示便签会移到「未分类」、不会被删除；删除当前筛选文件夹后自动切到未分类。
- 三种空态（全部 / 未分类 / 空文件夹）、选择模式批量移动保留、320/360 chips 横向滚动且 `+` 固定可见、焦点/Esc/aria 支持。

### 说明

- 测试 135 通过（store 30 / route 19 / signature 7 / tool 5 / settings 10 / ui 46 / backup 18）。
- 本版本只做文件夹交互；颜色、签名、Lumen 全量尺寸未动。
- 未补浏览器/Electron 截图与 320/360 手验，留待浏览器侧。

## [1.2.1] - 2026-11-15

### 修复

- 图片文件缺失时卡片不再破图：缩略图 / 图标 / 大图三种模式显示「图片缺失」文字占位；
  编辑态预览同样兜底，仍可换图 / 移除图片；image id 变化时重置失败状态。
- Host `state` 新增只读 `missingImages` 标注（`{ noteId, image }`），**不清空 image 引用、不自动删数据**。

### 说明

- 测试 125 通过（store 30 / route 19 / signature 7 / tool 5 / settings 10 / ui 36 / backup 18）。
- 本版本未补浏览器/Electron 截图与 320/360、键盘手验；README 截图留待浏览器侧完成。

## [1.2.0] - 2026-11-10

### 新增

- 搜索：正文 / 标签 / 链接；颜色、分类、文件夹筛选可叠加。
- 卡片图片模式：缩略图（默认）/ 小图标 / 大图；编辑态始终完整预览。
- 文件夹：新建 / 重命名 / 删除（删夹不删便签）、选择模式批量移入、按文件夹筛选。
- 提醒：datetime 选择、到点检查、过期补提醒；浏览器通知与提示音可独立开关；`shell.overlay` 全局提醒（独立 id `note-wall-reminders`，不写 body/head）。
- 分类历史：最近分类 chips，保留数量 4/8/12。
- 设置：便签墙右上角面板 + DSH `settings.section` 页；持久化、恢复默认、首次引导。
- `note_wall_add`：新增 `remindAt` / `folderId` / `folderName`；**AI 写入默认关闭**，Host 侧按设置真正 gate。
- ZIP 完整备份：`notes.json` + `images/` + `manifest.json` + 可选 `settings.json`；替换前自动备份、合并不删除；路径穿越、zip bomb、损坏包校验。

### 数据

- store v1 → v2：新增 `folders[]`、note `folderId` / `remindAt`；旧数据迁移到未分类。
- 可选新功能默认关闭：分类历史、文件夹、提醒、全局闹钟、AI 写入；图片默认缩略图。
- 不新增运行时依赖；ZIP 使用 Node 内置能力手写容器。

### 说明

- 测试 120 通过（store 30 / route 17 / signature 7 / tool 5 / settings 10 / ui 33 / backup 18）。
- ZIP 已用 Windows `Expand-Archive` 与 `tar` 验证可解压；浏览器通知权限、音频自动播放、overlay 层级仍需真人手验。

## [1.1.1] - 2026-11-10

### 修复

- 图片读取 prefix 路由改为不带结尾斜杠的 `IMAGE_UPLOAD_PATH` 注册。
  `dsh-host-webserver` 的前缀匹配是 `pathname === prefix || pathname.startsWith(prefix + '/')`；
  旧路径 `.../image/` 实际要求 `.../image//<id>`，导致 `/image/<id>` 落入 SPA fallback，
  便签卡片图片 404 / 裂图。client URL 与 `imageHandler` 切片逻辑不变。
- 新增路由回归测试：prefix 路径不得以 `/` 结尾，并按 webServer 的 match 规则选出路由后
  真正调用 handler（不再只直调 handler）。

### 说明

- 测试 40 通过（store 21 / route 12 / signature 7）。
- v1.1.0 的 tarball / Release 带此 bug，marketplace 请使用 1.1.1。

## [1.1.0] - 2026-11-09

A 版签名彩蛋（见 `DESIGN-SIGNATURE.md`）。

### 新增

- 面板页脚 `dream-office` 落款（11.5px，默认 55% 不透明度，hover/聚焦恢复）
- 三击落款（2 秒内 3 次）打开作者的一句话；键盘 Enter/Space 可直接打开；
  Esc 或关闭按钮收起，焦点回到落款
- 首次加载在控制台输出一次签名（模块级 flag，重复挂载不重复）
- 弹层使用 `role="dialog"`，落款带 `aria-expanded` / `aria-controls` / `aria-haspopup`

### 说明

- 不写存储、不收集数据、不新增网络请求，不影响便签主流程
- `prefers-reduced-motion` 下不播放动画

## [1.0.0] - 2026-11-09

首个开源版本。

### 新增

- DeepSeek Harness 左栏便签墙入口（Web GUI）
- 便签新增 / 编辑 / 删除；乐观并发校验，冲突时提示同步
- 颜色：暖黄、蜜桃、天蓝、薄荷、丁香、奶油 + 自定义 `#RRGGBB`
- 分类、链接（仅 `http`/`https`）、图片（PNG/JPEG/WebP/GIF，单张 ≤3MB）
- 图片粘贴、拖拽、缩略图预览；换图/删便签时清理无引用图片
- 动效开关；偏好保存在浏览器本地
- 本地存储 `$DSH_HOME/note-wall/store.json`，原子写入，损坏文件隔离
- 上限：500 条、单条 500 字、分类 24 字、链接 2048 字
- 便签/上传路由同源鉴权、插件头校验；图片上传校验真实文件头；图片读取按严格 id 路径白名单

### 说明

- 不访问外部网络；文字/图片只在本机回环 HTTP 与文件系统之间传递
- 同一 `$DSH_HOME` 只应由一个 Harness 进程使用（无跨进程文件锁）
