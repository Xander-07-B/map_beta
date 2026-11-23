# 随便地图 · beta

一个运行在浏览器里的《钢铁雄心4》风格大战略原型：Natural Earth 矢量世界地图 + 确定性的战役模拟核心 + 可操作的国家面板。

> 本项目是个人学习用原型，与 Paradox Interactive 无关。

---

## 快速开始

项目没有构建步骤，但**必须通过 HTTP 服务器打开**（`fetch` 加载地图与剧本数据，`file://` 会被浏览器拦截）。

```bash
# 任选一种方式，在项目根目录启动静态服务器
npx serve .
# 或
python -m http.server 8000
```

然后访问服务器给出的地址（例如 `http://localhost:8000`），点击「新游戏」并选择国家。

环境要求：

- 现代浏览器（Chrome / Edge / Firefox / Safari），需要 `Canvas 2D`、`Path2D`、`structuredClone`
- Node.js 18+（仅运行测试与重建地图数据时需要）

`vendor/` 已内置 `d3` 与 `topojson-client`，运行游戏不需要 `npm install`。

---

## 操作说明

| 操作 | 说明 |
|---|---|
| 拖动 | 平移地图 |
| 滚轮 / 双指捏合 | 缩放（按缩放级别自动切换国家 / 省份粗档 / 省份精档） |
| 单击省份 | 选中省份，左下角显示速览卡（归属、驻扎部队、快捷部署） |
| 单击我方部队标记 | 选中部队（国家级视野会自动下钻到省份层级），地图高亮可移动的相邻省份 |
| 选中部队后单击相邻省份 | 将部队移动过去；可连续点击逐格推进 |
| 右键 / `Esc` | 取消部队选择 |
| 顶部速度按钮 | 开局默认**暂停**，手动选择 1x–6x / 8x 推进（暂停时日期旁会显示「已暂停」提示） |
| 右侧图标栏 | 总览、政治、经济、生产、部队、科技、外交、情报、日志 |
| 右上角 `AI` | 切换 AI 接管：所有**非玩家**国家由 AI 决策（自行建造、科研、造兵、宣战），玩家国家始终由你操作 |
| 右上角 ☀ / ☾ | 切换深色 / 浅色主题 |
| 菜单 | 保存、继续、返回主菜单 |

**AI-only 模式**：在地址栏加 `?ai=1`（如 `http://localhost:8000/?ai=1`），开局后所有国家交由 AI 决策并以 5x 速度推进，适合观战和长时间压测。

存档写入浏览器 `localStorage`（`hoi4_campaign_save`），主题偏好写入 `hoi4_theme`。

---

## 当前完成度

### 地图渲染（较完整）

- Natural Earth 10m 数据，**4,594 个省级行政区**、241 个国界几何，覆盖约 250 个国家/地区
- TopoJSON 双档 LOD：`l0` 粗档（8% 简化）/ `l1` 精档（30% 简化），按缩放切换
- 一次投影 + `Path2D` 缓存；国界、省界、海岸线按 512px 网格切块，只绘制视口内瓦片
- 整屏底图离屏缓存：平移/缩放时先拉伸旧图过渡，交互停止后再重建高清图
- 填充缓存按「颜色 × 空间网格」组织，只重绘视口覆盖的格子
- 小地图、悬停/选中高亮、国家/省份 tooltip、触屏与双指缩放
- 日期变更线断线保护，避免最大缩放下出现横贯全图的假线
- 战争前线（流动虚线）、可指挥部队标记（同省多支部队环形排布，逐一点选）
- 深色 / 浅色双主题；台湾、香港、澳门与中国大陆同色（仅配色，不改变玩法归属）
- 缩放跨层级时国家底色兜底，任何缩放都不会露出海洋色

### 战役模拟核心（地基 + 经济 + 军事 + AI）

`js/core/` + `js/campaign.js`，纯 ES Module，不碰 DOM，可整体搬进 Web Worker：

- **确定性 PRNG**：xoshiro256**（BigInt 实现），绝不使用 `Math.random`，状态可存档
- **逻辑时钟**：1 tick = 1 游戏日；1x 速度下 1 tick = 1 真实秒；月结算每 30 tick；倍速 0–8 线性缩放
- **状态模型**：普通对象 + 数值 id，定点数（×1000）存稳定度/战争支持/合法性，可直接结构化克隆
- **命令管道**：所有变更走 `validateCommand → executeCommand → 记日志 → 排空级联`
  - 政治/外交：`assignOwner`、`setController`、`chooseFocus`、`cancelFocus`、`investPP`、`improveRelations`、`joinFaction`、`declareWar`、`makePeace`、`triggerEvent`、`executeDecision`
  - 经济：`startConstruction`、`allocateFactory`、`cancelProduction`、`adjustProduction`、`startResearch`
  - 军事：`deployArmy`、`moveArmy`、`disbandArmy`
  - UI 的按钮禁用态与命令校验同源（`Game.canCommand`）
- **经济结算（每 tick）**
  - 资源产出：按产能系数（工厂总数 / 基准）缩放，叠加科技资源加成
  - 生产线：产出速率 = 分配工厂数 ÷ 装备成本，资源不足时按最小可用比例整体缩放，不产生负库存
  - 建造队列：民用/军用工厂、船坞、基建、要塞、雷达站，同类项目越多越慢
  - 科研：研究槽推进，完成时应用效果（部队加成、工厂加成、解锁装备/模板、建造速度等）
  - 人力向人口上限增长、政治点数恢复、稳定度/战争支持向基线漂移、军队补给维持
- **军事结算（每 tick）**
  - 战斗：省份内多国部队自动交战，伤害受组织度、地形、要塞、科技加成影响，进攻方同样付出代价
  - 占领：省份内只剩一国部队时移交控制权；州内省份全部易主则整州翻转归属
  - 战争分数：击毁部队与控制省份累计，达到阈值自动议和；无省份且仍在交战的国家宣告投降
- **规则级联**：州归属变更 → 省份控制权同步 → 重算胜利点 → 任务评估 → 胜负判定
- **内容加载**：剧本结构校验、引用校验、国策树 DAG 环检测、派生剧本深合并（1939 = 1936 + patch）；装备/科技/部队模板随剧本一起加载校验
- **本地化**：`l10n.*` key 解析与占位插值，缺 key 时严格模式报错
- **AI 决策**：月度一轮效用打分，覆盖产线、建造、科研、部署、推进、宣战，全部走同一套命令管道
- **存档 / 读档 / 回放**：全量快照 + 命令日志，支持同种子确定性复现

### 内容

- **1936 全量世界剧本**：地图上全部 **4,594 个省份**均有归属，共 **250 个国家/地区**、253 个州；德国、波兰、法国为可玩国家，保留手写的国家数值、经济配置、初始装备、国策、事件、决议与胜负条件
- 其余 247 个国家由生成器按地图数据自动建立最小定义（名称、旗帜、配色、首都、州归属），地图上的任何省份都可以被部队进入与占领
- **初始部队即可指挥**：1936 开局的德国 42 个师、波兰 28 个师以真实的 `state.armies` 实体存在（按每支最多 6 个师拆分），可直接选中、移动、作战，而不是仅用于显示的驻军计数
- 1939 派生剧本：通过 patch 覆盖起始日期、省份归属与预设战争
- 装备 14 种、科技 34 项、部队模板 5 种（`data/equipment.json`、`data/techs.json`、`data/divisions.json`）
- 德国国策树：3 个节点（重建 → 重整军备 → 要求但泽）
- 事件：但泽要求（吞并 / 宣战两条分支）
- 决议：战争债券（政治点数换人力）
- 任务与胜负条件：吞并波兰 / 生存到 1946

### 界面

- 启动菜单、国家选择、继续游戏
- 9 个功能面板：总览、政治、经济、生产、部队、科技、外交、情报、日志
- 生产面板支持追加 / 调整 / 取消生产线，全部走命令管道
- 部队面板支持选择目标省份部署（1 / 5 支）、向相邻省份移动、定位、解散，并显示人力与装备消耗
- 地图直操作：点选部队后高亮可移动省份并绘制箭头，点击目标省份即移动；省份速览卡可直接部署
- 科技面板展示完整科技树、前置条件与研究进度
- 经济面板展示综合产能、资源收支、装备库存与建造进度
- 国策、决议、外交、宣战/议和/改善关系已接通命令管道
- 事件弹窗（自动暂停时间）、胜负弹窗、通用模态框
- 底部资源 / 人力 / 工业 / 军事状态栏（含部队数、总兵力与战争场次）
- 地图上绘制可指挥部队标记（圆形，标注兵力；同省多支部队环形错开，可逐个点选）
- 情报面板列出玩家全部部队的驻扎省份、模板与兵力
- 深色 / 浅色主题切换；右上角 `AI` 按钮一键切换 AI 接管

### 测试

```bash
npm test                            # 三套全跑：核心 + 集成 + 渲染层冒烟
npm run test:core                   # 战役核心 864 项
npm run test:integration            # 主程序集成 74 项
npm run test:ui                     # 渲染层冒烟 57 项
```

当前三套测试均全部通过，共 **995 项**。覆盖：PRNG 确定性、时钟换算、剧本校验、命令管道、国策/决议、
经济结算（资源/产线/建造/科研/人力）、军事闭环（部署/移动/战斗/占领）、AI 决策与 600 天压测、
同种子双跑一致、快照 + 命令日志回放、存档读档、门面层端到端流程，以及全部 9 个面板在
「有数据」与「空态」两种状态下的渲染不抛错。

---

## 尚未完成 / 已知限制

这是原型，不是完成品。以下缺口按影响排序：

1. **只有 3 个可玩国家**
   1936 剧本已经覆盖全地图的省份与归属，但国家选择菜单仍只开放德国、波兰、法国。其余 247 个国家是自动生成的最小定义：可以在地图上被进攻、占领和宣战，但没有手写国策、事件、决议与初始经济。`Game.countryIdByIso3` 仍只硬编码 `DEU/POL/FRA` 三个与 ISO3 不同的标签（其余国家标签与 ISO3 相同，走回退逻辑）。
2. **战斗是简化模型**
   只有「同省多国部队交战」这一层：没有战斗宽度、组织度自然恢复、补给网络、地形移动惩罚、空军与海军。部队也不会自动寻路，只能沿邻接表逐格移动。
3. **外交深度不足**
   只有宣战、议和、改善关系与加入阵营；没有阵营机制、租借、战争目标、和平会议。
4. **地图数据加载约 1.3 s**
   省份 TopoJSON 与 `index.json` 共约 6 MB，首次进入游戏需等待。可改按需分片加载或预构建更精简的数据。
5. **存档为全量 JSON**
   没有增量存档与版本迁移机制，剧本变大后存档体积会明显增长。
6. **无 CI，且没有真实浏览器测试**
   三套测试都在 Node 层运行（渲染层用 DOM 桩模拟），没有覆盖真实浏览器中的 Canvas 绘制、鼠标/触摸事件与交互，也没有接入持续集成。
7. **时间节奏偏快**
   1x 为 1 游戏日 / 真实秒，一个游戏年约 6 分钟；最高 8x 下约 45 秒一年。1936 → 1939 在 8x 下约 3.7 分钟，适合观战但细节偏快。

---

## 技术架构

```
┌─────────────────────────────────────────────────────────┐
│ 渲染层（经典脚本，window 全局）                           │
│   main.js   启动/国家选择/游戏循环/主题/AI 开关           │
│   map.js    Canvas 地图、LOD、拾取、前线、部队标记、小地图 │
│   ui.js     面板、弹窗、状态栏                            │
│   game.js   门面：只读快照 + 命令入口                     │
│   data.js   界面展示常量（意识形态/资源/地形）            │
└──────────────────────────┬──────────────────────────────┘
                           │ Game.command(cmd) / 读 state
┌──────────────────────────▼──────────────────────────────┐
│ 模拟层（ES Module，挂载 window.Core）                     │
│   campaign.js   Campaign 门面：Clock + State + Command   │
│   core/clock.js       确定性时钟与日期换算                │
│   core/state.js       世界状态构建（含军队/装备/科技加成）│
│   core/commands.js    校验 / 执行 / 日志                  │
│   core/rules.js       级联规则、效果展开、任务与胜负       │
│   core/economy.js     每 tick 经济与科研结算               │
│   core/war.js        每 tick 战斗 / 占领 / 战争分数        │
│   core/ai.js         月度 AI 效用决策                     │
│   core/rng.js         xoshiro256**                       │
│   content/loader.js   剧本与外部内容加载（装备/科技/模板）│
│   content/schema.js   结构与引用校验                      │
│   content/conditions.js  触发器求值                       │
│   content/l10n.js     本地化                              │
└─────────────────────────────────────────────────────────┘
```

关键约定：

- **模拟层不碰 DOM**，渲染层只读快照；所有变更必须走命令管道
- **确定性**：同种子 + 同命令序列 → 逐位一致的状态，可回放
- **数值**：跨端敏感的量用整数/定点数；遍历影响结果时用 `orderedKeys`
- **效果即命令**：国策/事件/决议中的 `annex`、`declareWar` 会展开为正式命令并记日志

---

## 目录结构

```text
.
├── index.html                 入口页面
├── css/style.css              界面样式（深/浅主题）
├── js/
│   ├── main.js                启动、游戏循环、主题、AI 开关
│   ├── map.js                 地图渲染与交互
│   ├── ui.js                  面板与弹窗
│   ├── game.js                渲染层 ↔ 模拟层门面
│   ├── data.js                界面展示常量
│   ├── campaign.js            Campaign 门面
│   ├── core/                  时钟、状态、命令、规则、经济、军事、AI、RNG
│   └── content/               剧本加载、校验、条件、l10n
├── data/
│   ├── scenarios/             1936 手写模板 / 生成剧本、1939 派生补丁
│   ├── equipment.json         装备定义（成本与资源消耗）
│   ├── techs.json             科技树（前置与效果）
│   ├── divisions.json         部队模板（编制与消耗）
│   ├── focuses/               国策树
│   ├── events/                事件
│   ├── decisions/             决议
│   ├── l10n/                  本地化
│   ├── provinces.l0/l1.topo.json   省份双档 TopoJSON
│   ├── countries.l1.topo.json      国界 TopoJSON
│   ├── index.json             省份元数据 + 邻接表 + bbox
│   └── ne_*.geojson           Natural Earth 源数据
├── scripts/
│   ├── build-provinces.mjs    重建省份 TopoJSON
│   ├── build-index.mjs        重建 index.json
│   ├── build-scenario.mjs     模板 + index.json → 全量 1936 剧本
│   ├── test-campaign-core.mjs 核心确定性测试
│   ├── test-integration.mjs   主程序集成测试
│   └── test-ui-smoke.mjs      渲染层冒烟测试（DOM 桩）
├── vendor/                    内置 d3 与 topojson-client
└── docs/                      地图数据与修复记录
```

---

## 数据与内容格式

### 剧本

`data/scenarios/1936.json` 定义国家、省份、州、战争、任务、胜负条件与内容引用。它是**生成产物**，不要直接手改：

- `data/scenarios/1936.template.json` 是手写源文件，只包含三个可玩国家的完整内容、20 个详细省份、州、任务与 `initialArmies`
- `node scripts/build-scenario.mjs` 读取模板 + `data/index.json` + Natural Earth 国界数据，补齐其余省份、归属、国家最小定义与州，写出 `1936.json`
- 修改 1936 内容请改模板后重新生成；`initialArmies` 中 `count` 为初始师数，按 `divisionsPerArmy`（默认 6）拆成多支可指挥部队

派生剧本使用：

```json
{ "base": "1936", "id": "1939", "patch": { "owners": { "...": "GER" } } }
```

补丁语义：对象递归合并，数组整体替换。

### 装备 / 科技 / 部队模板

这三个文件是经济与军事系统的底座，随剧本一起加载并校验，缺失或结构非法会直接报错。

- `data/equipment.json`：`{ cost, usesResources, category }`，`cost` 决定生产一件所需天数（1 个军用工厂）
- `data/techs.json`：`{ time, requires, effects }`，效果为结构化字段（`divisionBonus` / `factoryBonus` / `resourceBonus` / `unlockTemplate` / `unlockEquipment` / `construction` 等）
- `data/divisions.json`：`{ baseStrength, org, speed, cost: { manpower, equipment }, requires, terrainBonus }`

### 国策 / 事件 / 决议

- `data/focuses/*.json`：节点 DAG，支持 `prerequisites`、`requires`、`cost`、`days`、`effects`
- `data/events/*.json`：`trigger` + `options[].effects`，支持 `once`、`meanTimeToHappen`（当前未用于抽取）
- `data/decisions/*.json`：`scope`、`trigger`、`cost`、`cooldown`、`repeatable`、`effects`

### 重建地图数据

```bash
npm install
node scripts/build-provinces.mjs   # 从 ne_10m_admin_1 重建 l0/l1 TopoJSON
node scripts/build-index.mjs       # 按 ne_id 关联名称/归属，生成邻接与 bbox
node scripts/build-scenario.mjs    # 模板 + index.json → 全量 1936 剧本
# 或一次性执行：npm run build:map && npm run build:scenario（npm run build:all）
```

`build-scenario.mjs` 依赖 `data/index.json` 与 `data/ne_50m_admin_0_countries.geojson`，应在重建地图数据之后运行。

注意：

- 构建时排除南极洲（`adm0_a3 != 'ATA'`）
- 两档必须同时重建，否则 `index.json` 的 bbox 会对不上
- TopoJSON 在经纬度空间构建，不做投影；运行时由 `d3.geoMercator().fitSize([4096, 2048])` 投影

---

## 开发约定

1. **不要直接改状态**。新增玩法先加命令类型，在 `commands.js` 中实现校验与执行。
2. **不要递归执行规则**。级联规则只入队，由 `drainPending` 统一排空，保证顺序确定。
3. **不要引入 `Math.random`**。需要随机时用 `ctx.rng`，并把状态写进存档。
4. **模拟层不引用 DOM**。如果逻辑需要浏览器能力，通过依赖注入传入。
5. **随时间变化的副作用只放在结算函数里**。资源、科研、战斗等逻辑写在 `economy.js` / `war.js` 的结算函数中，由 `Campaign.onTick` 统一调用；不要在命令执行里做时间累积。
6. **规则数据不放在 JS 里**。装备、科技、部队模板、剧本、国策、事件一律放 `data/*.json`，由 `content/loader.js` 加载与校验。
7. **改内容先跑校验**。`loadScenario` 会做结构与引用校验；新增剧本/国策/事件后跑一遍测试。

---

## 路线图

### P0 · 打通可玩闭环 ✅ 已完成

1. **调整时间节奏** — 1 tick = 1 游戏日，1x 为 1 真实秒/日，倍速 0–8 线性缩放；8x 下 1936 → 1939 约 3.7 分钟。
2. **实现经济 tick** — `js/core/economy.js`：资源产出、生产线装备、建造队列、科研推进与效果应用、人力增长、政治点数恢复、稳定度/战争支持漂移、补给维持，全部为 `onTick` 中的确定性结算。
3. **最小陆军闭环** — `js/core/war.js`：部队实体（兵力/组织度/速度）→ 沿 `index.json` 邻接表移动 → 同省战斗（地形/要塞/科技修正）→ `setController` 占领 → 州归属翻转 → 战争分数 → 自动议和与投降。
4. **简单 AI** — `js/core/ai.js`：月度效用打分，覆盖产线、建造、科研、部署、推进、宣战，全部经 `campaign.command()`；提供 AI-only 模式（`?ai=1`）与 600 天压测。
5. **修复生产面板** — 生产线改为追加 / 调整 / 取消，删除按钮不再直接改状态，全部走命令管道。

同时完成：装备 / 科技 / 部队模板从 `js/data.js` 迁出为 `data/*.json` 并由核心加载校验；科技面板改用核心科技表；
`js/data.js` 收敛为纯展示常量；`fastForward` 改为同步推进时钟（此前月界判定与任务评估在快进时不会触发）。

### P1 · 扩展世界与内容

6. **全量剧本生成器** ✅ 已完成
   `scripts/build-scenario.mjs` 基于 `data/index.json` 自动生成 250 个国家/地区的省份与州归属，让地图上的世界真正可进入、可占领；手写的德国/波兰/法国内容保留在 `1936.template.json` 中作为默认开局。
7. **战斗与军事系统补全**
   组织度自然恢复、地形移动惩罚、战斗宽度、补给网络、部队自动寻路与进攻指令、空军与海军。
8. **外交深度**
   阵营机制、结盟与邀请、租借、战争目标、简化和平会议。
9. **UI 完善**
   建造/生产线可视化编辑、战争进度面板、省份详情、通知中心、键盘快捷键、移动端布局。
10. **存档体系**
    自动存档、版本迁移、增量存档。

### P2 · 性能与工程化

11. 模拟与 AI 移入 Web Worker，避免长任务阻塞渲染
12. 地图数据按需分片加载，缩短首次进入时间
13. 必要时升级 WebGL 渲染
14. CI：两套测试纳入流水线，补充浏览器端冒烟测试

---

## 致谢

- 地理数据：[Natural Earth](https://www.naturalearthdata.com/)
- 地图渲染：[d3-geo](https://github.com/d3/d3-geo)、[TopoJSON](https://github.com/topojson/topojson-client)
- 数据简化：[mapshaper](https://github.com/mbloch/mapshaper)
