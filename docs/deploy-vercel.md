# Vercel 部署教程

把 Daytrip Planner 部署到 Vercel。流程参考 `gemini-rss-app` 的 Vercel + 环境变量方式，但本项目当前把一日规划保存在用户浏览器 `localStorage`，所以暂时不需要 Neon 数据库。

## 你需要准备

- GitHub 账号
- Vercel 账号
- Google Maps 浏览器 key：给前端地图和地点搜索用
- Google Maps 服务端 key：给服务端路线接口用
- 可选：NAVITIME Route(totalnavi) RapidAPI key，用于日本公共交通

## 第一步：推送到 GitHub

1. 在 GitHub 新建仓库。
2. 把本项目代码推送到仓库。
3. 不要提交 `.env`，生产环境变量放到 Vercel Dashboard。

如果你的仓库是多目录仓库，Vercel 导入时把 Root Directory 设为 `work/daytrip-planner`。

## 第二步：导入 Vercel

1. 打开 [vercel.com](https://vercel.com/) 并用 GitHub 登录。
2. 点击 Add New... → Project。
3. 选择你的 GitHub 仓库并 Import。
4. Framework Preset 选择 Vite。

项目已包含 `vercel.json`，通常保持默认即可：

- Build Command：`npm run build`
- Output Directory：`dist`
- API Functions：`api/**/*.js`

## 第三步：配置环境变量

在 Vercel 项目 Settings → Environment Variables 添加：

| Name | 是否必填 | 说明 |
| --- | --- | --- |
| `VITE_GOOGLE_MAPS_API_KEY` | 推荐 | 浏览器端 Google Maps JavaScript / Places key。Vite 会在构建时写入前端，修改后需要重新部署。 |
| `VITE_GOOGLE_MAP_ID` | 可选 | Google Advanced Marker 所需 Map ID，没有就用 `DEMO_MAP_ID`。 |
| `GOOGLE_MAPS_SERVER_KEY` | 可选 | 服务端 Google Directions / Routes key；没有时公共交通会更多依赖 NAVITIME/免费兜底。 |
| `NAVITIME_RAPIDAPI_KEY` | 推荐 | NAVITIME Route(totalnavi) RapidAPI key，用于日本公共交通路线。 |
| `NAVITIME_RAPIDAPI_HOST` | 可选 | 默认 `navitime-route-totalnavi.p.rapidapi.com`。 |
| `TRANSITOUS_USER_AGENT` | 推荐 | Transitous 请求标识，例如 `DaytripPlanner/0.1 contact=you@example.com`。 |

不要设置 `PORT`。Vercel 会自己管理函数运行端口。

## 第四步：Google Cloud key 限制

浏览器 key：

- Application restrictions：HTTP referrers
- 添加你的生产域名，例如 `https://your-domain.com/*`
- 如果要用 Vercel Preview，也添加 `https://*.vercel.app/*`
- API restrictions：Maps JavaScript API、Places API

服务端 key：

- API restrictions：Directions API、Routes API
- 不要放到 `VITE_` 变量里
- Vercel Serverless 没有稳定出口 IP；如果要做 IP 限制，需要额外使用有静态出口的方案

## 第五步：部署

1. 点击 Deploy。
2. 等待构建完成。
3. 打开 Vercel 分配的网址。
4. 测试：
   - 地图是否显示
   - 搜索地点是否工作
   - Anitabi 导入是否工作
   - 两个点以上的自动规划是否能返回路线

## 已适配的代码结构

```text
vercel.json                         Vercel 构建、输出目录、函数超时配置
api/search.js                       /api/search
api/routes.js                       /api/routes
api/auto-route.js                   /api/auto-route
api/transitous-route.js             /api/transitous-route
api/free-route.js                   /api/free-route
api/anitabi/bangumi/[subjectId]/*   Anitabi 代理接口
server.mjs                          本地 Express + Vite dev server；Vercel 中只导出 Express app
```

## 注意事项

- 当前一日规划持久化在浏览器 `localStorage`，同一浏览器刷新后仍在，但不会跨设备同步。
- Vercel Hobby 当前单个函数最长 300 秒。项目已把 API 函数 `maxDuration` 设为 300；如果一次规划特别多公共交通段，仍可能碰到 Vercel 超时。正式产品建议把长路线规划拆成后台任务或接数据库保存进度。
- NAVITIME 的 50 次/分钟节流目前是单个函数实例内存级限流。多人并发访问时，Vercel 可能启动多个函数实例；正式产品要用 Redis、数据库或队列做共享限流。
- `.env` 只用于本地开发；Vercel 生产环境要在 Dashboard 配置环境变量。

## 后续如果要做账号和云端同步

可以再参考 Vercel + Neon 的流程：

1. 创建 Neon PostgreSQL。
2. 在 Vercel 添加 `DATABASE_URL`。
3. 新增 `plans`、`stops`、`route_plans` 等表。
4. 把当前 `localStorage` 保存逻辑迁移到服务端 API。

## 参考

- 示例部署流程：https://github.com/wwwbby/gemini-rss-app/blob/main/docs/deploy-vercel.md
- Vercel Express 文档：https://vercel.com/docs/frameworks/backend/express
- Vercel Function 最大时长：https://vercel.com/docs/functions/configuring-functions/duration
