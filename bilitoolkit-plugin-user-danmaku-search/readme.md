# 直播弹幕查询

BiliToolkit UI 插件。选择输入直播间房间号或用户 UID，查询 Danmakus 第三方服务已经收录的直播弹幕记录，并在本地保存最近 20 个查询对象。沿用原 npm 包名 `bilitoolkit-plugin-user-danmaku-search`，已有用户可直接升级。

## 功能

- 按房间号（包括短号）解析主播，按时间倒序浏览直播间已收录场次及每场所有已收录弹幕
- 房间模式每次加载 1–10 场，可持续加载至全部已收录场次；同一场次的收录版本采用服务返回的主版本，避免重复
- 标明场次是否完整收录、是否结束；未结束场次提供查询时的收录快照
- 大场次先显示 200 条弹幕，可逐步展开；关键词筛选会覆盖当前已加载场次的所有记录
- 查询历史区分房间号和用户 UID，兼容旧版 UID 查询历史
- 按 UID 查询直播弹幕和互动记录
- 按直播间房间号或主播名称筛选全部历史场次
- 按关键词即时筛选当前已经加载的弹幕内容
- 按直播场次展示主播、标题、开播时间及弹幕内容
- 分页加载历史记录
- 可在 1–100 场之间自定义每次加载数量，并在结果顶部或底部继续加载
- 本地保存、单独删除或清空查询历史
- 支持取消仍在进行的首次查询

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

查询数据来自 [Danmakus](https://danmakus.com/) 的第三方接口，并非 Bilibili 官方弹幕历史接口。服务只提供本站或用户已经录制、上传的场次，不能保证覆盖该直播间截至目前的所有弹幕。直播间信息解析使用 Bilibili 公开房间接口；插件不连接直播 WebSocket、不进行实时采集。已加载的弹幕仅保留在当前页面内存中，本地数据库只保存查询对象、查询模式、名称、查询时间及加载设置。
