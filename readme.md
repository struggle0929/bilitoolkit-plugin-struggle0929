# BiliToolkit 插件合集

这里存放由 [struggle0929](https://github.com/struggle0929) 开发和维护的 BiliToolkit 插件。

## 插件列表

| 插件名称 | npm | 描述 |
| --- | --- | --- |
| [用户弹幕查询](./bilitoolkit-plugin-user-danmaku-search) | [bilitoolkit-plugin-user-danmaku-search](https://www.npmjs.com/package/bilitoolkit-plugin-user-danmaku-search) | 根据 UID 查询第三方服务已经公开收录的直播弹幕记录，并保存本地查询历史。 |

## 开发与发布

每个插件都是独立的 npm 包。进入对应插件目录后执行：

```powershell
pnpm install
pnpm check
pnpm build
npm pack --dry-run
```

发布新版本前，需要更新插件自身的版本号。发布到 npm 后，BiliToolkit 会根据 `bilitoolkit-plugin` 关键词检索并安装插件。

