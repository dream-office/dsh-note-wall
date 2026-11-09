# 插件互通路线（待研究）

> 状态：想法记录，未排期。
> 目标：让插件之间通过稳定 API 互通，例如 AI 在便签墙上留言、任务和便签互相转换。

## 最小 PoC（建议先做）

1. 便签墙暴露版本化服务 `noteWall@1`：
   - `add({ text, tone?, tag?, link?, imageId? })`
   - `list({ limit?, tag? })`
   - `remove(id)`
   - `onChange(cb)`
2. 便签增加可选 `author` / `source`：
   - `author: 'user' | 'ai' | <plugin-id>`
   - `source`：写入方标识（不写会话正文/隐私数据）
   - UI 显示 `AI` / 插件徽标；旧数据默认 `user`
3. AI 写入走显式工具 + 用户确认：
   - 默认关闭「允许 AI 留言」
   - 每次写入可由用户确认，或一次性授权
   - 支持撤销；不自动上传任何内容
4. 不自动消费 AI 便签：其他插件读取时默认跳过 `author=ai`，除非用户显式允许。

## 权限与版本

- 插件 manifest 声明 `provides` / `consumes`
- 用户授权 scope：`note-wall:read` / `note-wall:write` / `note-wall:write:ai`
- 服务 API 带 `apiVersion` + capability；旧版插件可降级
- 宿主侧最好有通用事件总线：`note.created`、`task.created`、`message.received`

## 风险

- 装了插件就等于执行代码；没有 scope 的互通等于裸奔
- 循环：A 写 → B 读 → B 又写回；必须标记来源、默认不自动消费
- 隐私：AI 不能把会话日志/个人信息自动写进便签
- 数据兼容：`author/source` 是新增字段，需要 store format 迁移和旧数据默认值

## 下一步

有时间再做设计评审，不阻塞当前版本。
