# dsh-note-wall · 签名规范（A 版）

> 依据 dream-office 签名规范 v1.0 的 A 版，按便签墙的口径落地。
> 本项目**只做 A 版**：页脚落款、三击彩蛋、控制台签名；不做 B 版（大图、插画、主界面重做）。

## 1. 视觉

- 落款文字固定为 `dream-office`：小写、无空格、不翻译。
- 标记：10px 圆角小方块。
  - 浅色主题 `#5B57F0`
  - 深色主题 `#8B87FF`
- 字号 11–12px；默认 `opacity: 0.55`，hover / 键盘聚焦时恢复 100%。
- 位置：便签墙页面页脚，不放在首屏主视觉，不改变原有布局。

## 2. 结构

落款是可聚焦按钮，不是裸文字：

```html
<button type="button" aria-label="关于作者"
        aria-haspopup="dialog" aria-expanded="false"
        aria-controls="nw-signature-note">
  <span aria-hidden="true"></span>
  <span>dream-office</span>
</button>
```

打开后弹层为一行作者的话 + 关闭按钮：

- `role="dialog"`，带无障碍名称。
- 打开时焦点进入关闭按钮；关闭后焦点回到落款按钮。
- `Esc`、关闭按钮、再次点击落款都可以关闭。
- 弹层不遮挡输入卡和便签操作，不阻塞主流程。

## 3. 触发

- 鼠标/触控：2 秒内点击落款 3 次。
- 键盘：`Enter` / `Space` 直接打开，不要求三击。
- 窗口判定是纯函数：超时自动丢弃旧点击；第 3 次打开后清空计数。
- 1 次、2 次点击不弹。

## 4. 文案

| 用途 | 文案 |
|---|---|
| 作者 | `dream-office`（不翻译） |
| 作者的话（zh） | `把灵感，一张一张贴起来。` |
| 作者的话（en） | `Pinning down inspiration, one note at a time.` |
| 关闭 | `关闭` / `Close` |
| 控制台 | `dsh-note-wall · dream-office · 把灵感，一张一张贴起来` |

- 控制台签名在每次页面加载时只输出一次；用模块级 flag，重复挂载/StrictMode 不重复。
- 控制台不输出个人信息、不输出本机路径。

## 5. 边界

- 不写 `localStorage`，不写便签存储，不收集数据，不新增网络请求。
- 不改变便签增删改查流程，不影响图片上传/读取。
- `prefers-reduced-motion: reduce` 时不播放弹层/落款动画。
- 不放在首屏主视觉；不加“关注 / 打赏 / 扫码”。

## 6. 实现与验收

实现位置：

- `client.js`：落款、弹层、三击判定（`signatureTap`）、控制台签名（`printSignatureConsole`）。
- `test/signature.test.mjs`：加载真实 `client.js`，覆盖 1/2 次不弹、3 次弹、2 秒窗口、超时重置、2 秒边界、console 只一次。

验收清单：

- [ ] 320 / 360 宽不换行错位、不横向溢出
- [ ] 键盘 `Enter` / `Space` 打开，`Esc` 关闭并回焦
- [ ] 2 秒内 3 次打开，1/2 次不弹，超时重置
- [ ] 控制台只输出一次，无个人信息
- [ ] 无新增存储、无网络请求
- [ ] `prefers-reduced-motion` 下无动画
- [ ] README 文末有 `dream-office` 落款

## 7. 实现备注

`client.js` 是手写的 module-loader bundle；`@deepseek-ai/dsh-client-modules` 不允许 client 同步
`require` 同目录的本地模块，因此三击纯逻辑直接放在 `client.js`，测试通过 `vm` 加载真实文件并
使用仅测试时存在的 `window.__DSH_NOTE_WALL_TEST__` 钩子，不引入运行时依赖或第二份实现。
