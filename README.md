# 图片元数据编辑器

一个本地图片元数据工具，用于读取、编辑、导出和保存 JPEG、PNG、WebP、AVIF 图片中的元数据。

## 使用方式

Windows 下可直接双击 `启动.bat`。它会启动本地服务并打开：

```text
http://localhost:4173/
```

也可以手动运行：

```bash
npm start
```

## 已支持

- 后台 Web Worker 解析和保存，减少大图卡顿。
- JPEG、PNG、WebP 元数据读取与写入。
- AVIF 元数据读取。
- JPEG/WebP 保存时保留原始 EXIF，并额外写入本工具的 XMP 字段。
- PNG 支持读取 `tEXt`、`iTXt`、`zTXt`、`eXIf`，保存时写入 UTF-8 `iTXt`。
- 读取更多常见 XMP 字段，例如 `dc:description`、`dc:title`、`xmp:CreatorTool`。
- 信息读取支持 Stable Diffusion、Negative prompt、Workflow JSON 等参数，并可新增自定义参数类型。
- 信息读取历史记忆管理器，记忆内容保存在 `info-memory.json`，支持按类型锁定，锁定后不再自动新增该类型记忆。
- 各类应用配置保存在 `app-config.json`，包括自定义信息读取类型、记忆类型锁定状态、分页数量、长字段折叠阈值等；未通过本地服务打开时会回退到浏览器本地存储。
- 保存前预览即将写入的字段和 XMP 内容。
- 撤销/重做与未保存状态提示。
- 字段内容为文件格式时显示“导出 类型”按钮。
- 大量字段分页显示，超长字段默认折叠。
- 本地服务只监听 `127.0.0.1`，记忆 API 限制本机和同源访问。

## 文件结构

- `index.html`：页面结构。
- `styles.css`：界面样式。
- `app.js`：界面状态、交互、撤销/重做、弹窗。
- `metadata-core.js`：图片元数据解析与写入核心。
- `metadata-worker.js`：后台 Worker。
- `metadata-worker-client.js`：Worker 调用封装。
- `server.js`：本地静态服务和记忆文件 API。
- `start.js`：稳定的一键启动器。
- `启动.bat`：Windows 双击入口。
- `info-memory.json`：信息读取历史记忆。
- `app-config.json`：应用配置文件。
- `.editorconfig`：统一 UTF-8 和换行配置。
