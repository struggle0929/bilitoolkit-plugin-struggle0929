# 用户弹幕查询与本地弹幕采集

BiliToolkit UI 插件。它既可以查询 Danmakus 第三方服务已经收录的直播弹幕，也可以直接连接 Bilibili 直播间，将公开弹幕持续保存到本地。

## 功能

- 按 UID 查询直播弹幕和互动记录
- 按直播间房间号或主播名称筛选全部历史场次
- 按关键词即时筛选当前已经加载的弹幕内容
- 按直播场次展示主播、标题、开播时间及弹幕内容
- 分页加载历史记录
- 可在 1–100 场之间自定义每次加载数量，并在结果顶部或底部继续加载
- 本地保存、单独删除或清空查询历史
- 支持取消仍在进行的首次查询
- 按主播 UID 或直播间号实时采集公开直播弹幕
- 使用 BiliToolkit 主程序提供的 Bilibili API 代理获取直播信息和弹幕服务器配置
- 使用 `bili-live-message-core` 处理直播 WebSocket、心跳、重连和 Brotli/zlib 解压
- 将每个采集会话保存为独立 JSONL 文件，支持断点后读取、关键词/发送者筛选和分页浏览
- 关闭后重新打开时，将未正常结束的会话标记为“上次中断”，已写入的记录仍可查看

## 本地开发

需要 Node.js 22 和 pnpm。

```powershell
cd bilitoolkit-plugin-user-danmaku-search
pnpm install
pnpm dev
```

在 BiliToolkit 的插件开发模式中载入开发地址 `http://localhost:5174`。

## 构建

```powershell
pnpm check
pnpm build
```

构建产物位于 `dist`。发布到 npm 后，BiliToolkit 可根据 `package.json` 中的 `bilitoolkit-plugin`、名称及 `type:ui` 关键字识别并安装它。

## 数据与隐私

查询数据来自 Danmakus 的第三方接口，并非 Bilibili 官方接口，因此完整性和长期可用性取决于该服务。实时采集使用 Bilibili 公开直播信息流，不需要登录 Cookie；采集文件保存在当前设备的插件目录 `captures` 下，数据库只保存会话索引和统计信息。请遵守 Bilibili 服务条款，并合理控制采集频率和时长。
