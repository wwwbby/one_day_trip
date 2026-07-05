# 一日行程地图

一个基于 Google Maps 服务的一日行程规划 MVP。它参考了 Anitabi 的几个产品思路：地图点位、外部地图链接粘贴、KML 导入、来源字段、轻量数据结构；业务上改成了“用户标记地点并规划一天路线”。

## 已实现

- Google Maps JavaScript API 地图
- 无 Google key 时自动使用 Leaflet + OpenStreetMap 免费地图
- Google Places Autocomplete 地点搜索
- 免费模式下使用 Nominatim 地点搜索
- 首页展示多个一日规划，可创建、命名、删除并进入单日编辑
- 规划可保存到服务端 Postgres/Neon，电脑和手机访问同一部署域名可看到同一份计划
- 本地开发没有数据库时自动使用 `.data/daytrip-plans.json` 兜底，浏览器 `localStorage` 只作为缓存和旧数据迁移来源
- 点击地图添加自定义地点
- 粘贴坐标或 Google Maps 链接添加地点
- 地点列表拖拽排序
- 设置每个地点停留分钟数
- 自动路线策略：固定第一个地点为起点，按近邻 + 2-opt 自动排序后规划；1km 内步行，超过 1km 优先公共交通
- 可选 NAVITIME Route(totalnavi) RapidAPI 接入，用于日本公共交通路线
- Google 模式下按相邻地点分段查询路线，并显示每段线路摘要
- 免费模式下使用 Transitous/MOTIS 尝试公共交通路线查询
- 路线折线、总距离、路上时间、预计结束时间
- KML 点位导入
- Anitabi 轻量巡礼点导入
- 导出 JSON
- 复制 Google Maps directions 链接
- 无 API key 的可视化占位状态

## 运行

```bash
npm install
copy .env.example .env
npm run dev
```

打开：

```text
http://localhost:5173
```

PowerShell 如果拦截 `npm.ps1`，可以改用：

```bash
npm.cmd run dev
```

## 环境变量

```env
VITE_GOOGLE_MAPS_API_KEY=your_browser_restricted_maps_javascript_key
VITE_GOOGLE_MAP_ID=DEMO_MAP_ID
GOOGLE_MAPS_SERVER_KEY=your_server_restricted_routes_api_key
NAVITIME_RAPIDAPI_KEY=your_navitime_route_totalnavi_rapidapi_key
NAVITIME_RAPIDAPI_HOST=navitime-route-totalnavi.p.rapidapi.com
TRANSITOUS_USER_AGENT=DaytripPlanner/0.1 contact=your-email@example.com
DATABASE_URL=postgresql://user:password@host/db?sslmode=require
PORT=5173
```

建议在 Google Cloud 里启用：

- Maps JavaScript API
- Places API
- Routes API

浏览器 key 只限制给前端域名使用；服务端 key 只给 Routes API 使用，不要暴露到前端。

不配置 `.env` 也可以运行。应用会自动进入免费模式：

- 地图：Leaflet + OpenStreetMap
- 搜索：Nominatim
- 公共交通路线：Transitous/MOTIS 实验接口
- 步行兜底：直线步行估算

免费模式适合本地原型和小流量测试。OSM 官方瓦片、Nominatim 和 Transitous 公共 API 都不是无限量生产服务；如果要上线，应换成自托管或有正式 SLA 的服务。

公共交通路线指 train/subway/JR/私铁/巴士等 transit 总类，而不是只查巴士。当前京都样例中 Google 对部分段返回 `ZERO_RESULTS`，应用会自动切到步行并在地点卡片显示“公共交通无结果”。日本正式产品更建议接 NAVITIME、駅すぱあと、ジョルダン，或自托管 GTFS + OpenTripPlanner/MOTIS。

如果配置 `NAVITIME_RAPIDAPI_KEY`，自动规划会先用 NAVITIME Route(totalnavi) 查询 1km 以上的日本公共交通段；没有 key 或 NAVITIME 返回失败时，仍会回到 Google/Transitous/步行兜底。RapidAPI 版的 host 默认为 `navitime-route-totalnavi.p.rapidapi.com`，key 只放在服务端 `.env`，不要写进前端环境变量。

自动规划会先把用户提供的地点排序：第一个地点视为当天起点，其余地点用地理距离做近邻排序，再通过 2-opt 局部交换减少总串联距离。排序后再按相邻地点查询步行/公共交通路线。按 NAVITIME 当前 50 次/分钟的路线查询限制，服务端会对 NAVITIME 请求做约 1.2 秒间隔的节流；地点较多时不会硬性中断，前端会显示等待状态并保持规划直到所有相邻路线完成。

## 关键结构

```text
api/                Vercel Serverless Function 入口
server.mjs          Express API + 本地 Vite dev middleware
src/App.tsx         地图、行程、KML、Anitabi、路线计算、导出
src/styles.css      应用样式
vercel.json         Vercel 构建、静态输出、函数超时配置
.env.example        Google Maps 配置模板
```

当前持久化优先使用 `DATABASE_URL` 指向的 Postgres/Neon，并自动创建 `daytrip_plans` 表。Vercel 上要实现手机/电脑同步必须配置 `DATABASE_URL`；本地没配数据库时才会写 `.data/daytrip-plans.json`。

## Vercel 部署

项目已适配 Vercel：前端按 Vite 构建到 `dist`，后端 API 通过 `api/**/*.js` 部署为 Vercel Functions。部署步骤见 [docs/deploy-vercel.md](docs/deploy-vercel.md)。

## 后续方向

- 用户登录、分享链接和协作编辑
- KMZ 导入
- Anitabi 详情点位和截图来源展示
- 营业时间、预约时间、午餐/晚餐、预算约束
- 地图服务 adapter，支持 Mapbox/高德等替换

## 参考

- Anitabi 文档：https://navi.anitabi.cn/docs/intro/
- Anitabi 开放 API：https://navi.anitabi.cn/docs/api/
- Google Maps JavaScript API：https://developers.google.com/maps/documentation/javascript
- Google Routes API：https://developers.google.com/maps/documentation/routes
- NAVITIME Route(totalnavi)：https://api-sdk.navitime.co.jp/api/specs/api_guide/route_transit.html
- NAVITIME RapidAPI：https://rapidapi.com/navitimejapan-navitimejapan/api/navitime-route-totalnavi/playground
- Transitous API：https://transitous.org/api/
