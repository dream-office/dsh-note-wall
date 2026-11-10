# Changelog

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
