# 贡献

感谢你愿意改进 dsh-note-wall。

## 开发

```bash
node --check index.js
node --check client.js
node --check lib/store.js
node --check lib/images.js
node test/store.test.mjs
node test/route.test.mjs
node test/signature.test.mjs
node test/tool.test.mjs
node test/ui.test.mjs
```

不需要安装依赖；测试用 Node 内置模块。

## 提交前

- 保持零运行时依赖
- 新增/修改行为要补测试
- 不把真实姓名、学号、邮箱、手机号、绝对路径写进代码、文档、测试或截图
- 不提交 `$DSH_HOME/note-wall` 下的本地数据
- 说明改动动机与兼容性影响

## 许可证

提交即表示同意以 MIT License 发布。
