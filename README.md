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

然后访问服务器给出的地址（例如 `http://localhost:8000`），点击「新游戏」，在弹出的国家选择窗口中挑选国家。

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
| 双击 / 双击触摸 | 以点击位置为中心放大；移动端也支持双击放大 |
| 单击省份 | 选中省份，左下角显示速览卡（归属、驻扎部队、快捷部署） |
| 单击我方部队标记 | 选中部队（国家级视野会自动下钻到省份层级），地图高亮可移动的相邻省份 |
| 单击我方空军 / 舰队标记 | 选中空军群或舰队并高亮可移动省份（舰队仅限沿海与海域） |
| 选中部队后单击相邻省份 | 将部队移动过去；可连续点击逐格推进 |
| 右键 / `Esc` | 取消选择（`Esc` 也会关闭当前面板） |
| 顶部速度按钮 | 开局默认**暂停**，手动选择 1x–6x / 8x 推进（暂停时日期旁会显示「已暂停」提示） |
| `空格` | 暂停 / 继续 |
| `0`–`9` | 快速切换右侧功能面板 |
| 左上角地图视图 | ◇ 选择 / ⚔ 前线 / ▲ 地形 / ▦ 省份（点击立即切换地图表现，左下角出现图例） |
| 右侧图标栏 | 图标按钮，悬停显示名称：总览、政治、经济、生产、部队、科技、外交、情报、战争、通知、日志 |
| 底部状态条 | 资源/人力/工业/军事的紧凑指标，悬停显示指标全称；窄屏可横向滚动 |
| 右上角 `AI` | 切换 AI 接管：所有**非玩家**国家由 AI 决策（自行建造、科研、造兵、宣战），玩家国家始终由你操作 |
| 右上角 ☀ / ☾ | 切换深色 / 浅色主题 |
| 菜单 | 保存、继续、返回主菜单 |

**AI-only 模式**：在地址栏加 `?ai=1`（如 `http://localhost:8000/?ai=1`），开局后所有国家交由 AI 决策并以 5x 速度推进，适合观战和长时间压测。

手动存档写入浏览器 `localStorage`（`hoi4_campaign_save`），每月自动存档写入独立存档位
`hoi4_campaign_autosave`（增量快照，不覆盖手动存档）；主题偏好写入 `hoi4_theme`。

---

## 当前完成度

### 地图渲染（较完整）

- Natural Earth 10m 数据，**4,594 个省级行政区**、241 个国界几何，覆盖约 250 个国家/地区
- TopoJSON 双档 LOD：`l0` 粗档（8% 简化）/ `l1` 精档（30% 简化），按缩放切换
- **渐进加载**：首屏只下载国家层 + 粗档 + 索引（约 2 MB），精档（约 3 MB）在首帧后后台加载并无缝换入，不阻塞开局
- LOD 阈值与缩放上限按屏幕适配比例换算，移动端不会出现「要放大几十倍才看得到省份」
- 一次投影 + `Path2D` 缓存；国界、省界、海岸线按 512px 网格切块，只绘制视口内瓦片
- 整屏底图离屏缓存：平移/缩放时先拉伸旧图过渡，交互停止后再重建高清图
- 填充缓存按「颜色 × 空间网格」组织，只重绘视口覆盖的格子
- 小地图、悬停/选中高亮、国家/省份 tooltip、触屏与双指缩放、双击/双击触摸放大
- 移动端地址栏收起、横竖屏切换时不重置当前缩放与视野中心
- 日期变更线断线保护，避免最大缩放下出现横贯全图的假线
- 战争前线（流动虚线）、可指挥部队标记（同省多支部队环形排布，逐一点选）
- 深色 / 浅色双主题；台湾、香港、澳门与中国大陆同色（仅配色，不改变玩法归属）
- 缩放跨层级时国家底色兜底，任何缩放都不会露出海洋色

### 战役模拟核心（地基 + 经济 + 军事 + AI）

`js/core/`，纯 ES Module，不碰 DOM，可整体搬进 Web Worker：

- **确定性 PRNG**：xoshiro256**（BigInt 实现），绝不使用 `Math.random`，状态可存档
- **逻辑时钟**：1 tick = 1 游戏日；1x 速度下 1 tick = 1 真实秒；月结算每 30 tick；倍速 0–8 线性缩放
- **状态模型**：普通对象 + 数值 id，定点数（×1000）存稳定度/战争支持/合法性，可直接结构化克隆
- **命令管道**：所有变更走 `validateCommand → executeCommand → 记日志 → 排空级联`
  - 政治/外交：`assignOwner`、`setController`、`chooseFocus`、`cancelFocus`、`investPP`、`improveRelations`、`joinFaction`、`declareWar`、`makePeace`、`triggerEvent`、`executeDecision`；阵营与和平会议：`inviteFaction`、`acceptFactionInvite`、`rejectFactionInvite`、`leaveFaction`、`setFactionLeader`、`lendLease`、`addWarGoal`、`proposePeace`、`acceptPeace`、`rejectPeace`
  - 经济：`startConstruction`、`cancelConstruction`、`allocateFactory`、`cancelProduction`、`adjustProduction`、`toggleProduction`、`startResearch`
  - 军事：`deployArmy`、`moveArmy`、`moveArmyTo`（自动寻路）、`setArmyOrder`（待机/进攻/撤退）、`disbandArmy`；空军 `deployAirForce`、`moveAirForce`、`disbandAirForce`；海军 `deployFleet`、`moveFleet`、`disbandFleet`
  - UI 的按钮禁用态与命令校验同源（`Game.canCommand`）
- **经济结算（每 tick）**
  - 资源产出：按产能系数（工厂总数 / 基准）缩放，叠加科技资源加成
  - 生产线：产出速率 = 分配工厂数 ÷ 装备成本，资源不足时按最小可用比例整体缩放，不产生负库存
  - 建造队列：民用/军用工厂、船坞、基建、要塞、雷达站，同类项目越多越慢
  - 科研：研究槽推进，完成时应用效果（部队加成、工厂加成、解锁装备/模板、建造速度等）
  - 人力向人口上限增长、政治点数恢复、稳定度/战争支持向基线漂移、军队补给维持
- **军事结算（每 tick）**
  - 战斗宽度：省份基础宽度 100（基建每级 +5），超宽部队留在预备队，本轮不参战也不受损
  - 地形：防御修正（山地 +0.5、森林 +0.3、丘陵 +0.15…）与移动代价（山地 2.2×、森林 1.5×…），模板与科技地形加成叠加
  - 组织度：有补给且未交战时自然恢复（速度受补给系数影响），断补给则组织度与兵力持续流失
  - 补给网络：从己方/盟友控制的补给枢纽沿控制省份 BFS 扩散，省份受损按比例折损补给；同阵营共用一张补给网
  - 部队指令：`hold` / `advance` / `retreat`，进攻沿最短路径自动推进，撤退退往补给最好的己方邻省
  - **移动消耗组织度**：每格移动付出基础组织度（复杂地形叠加额外代价），组织度低于阈值（0.2）的部队无法行动，避免部队无限行动
  - 空军：空战夺取制空权、为地面战斗提供最多 +25% 支援、战略轰炸增加省份受损
  - 海军：舰队决战、炮击沿海省份；**海域省份**（`terrain=ocean`）供舰队部署与移动，舰队可由沿海进入大洋，陆军不得进入海域
  - 占领：省份内只剩一国部队时移交控制权；州内省份全部易主则整州翻转归属
  - 战争分数：击毁部队与控制省份累计，达到阈值进入**和平会议**；无省份且仍在交战的国家宣告投降
- **外交深度**：阵营（领袖、邀请、加入/退出）、租借（盟友好感门槛、月度额度与冷却）、战争目标（吞并州/索取资源）、简化和平会议（条款由战争目标生成，败方接受后执行）
- **规则级联**：州归属变更 → 省份控制权同步 → 重算胜利点 → 任务评估 → 胜负判定
- **内容加载**：剧本结构校验、引用校验、国策树 DAG 环检测、派生剧本深合并（1939 = 1936 + patch）；装备/科技/部队模板/飞机/舰船随剧本一起加载校验
- **本地化**：`l10n.*` key 解析与占位插值，缺 key 时严格模式报错
- **AI 决策**：月度一轮效用打分，覆盖产线、建造、科研、部署、推进、宣战、空军/海军建设与部队指令；每轮构建一次状态索引，避免重复全表扫描
- **存档 / 读档 / 回放**：全量快照 + 命令日志，同种子确定性复现；每月自动存档（增量补丁），存档带版本号并支持逐级迁移（v1 → v4）

### 内容

- **1936 全量世界剧本**：地图上全部 **4,594 个陆地省份**均有归属，共 **250 个国家/地区**、253 个州；**全部 250 个国家均可玩**。德国、波兰、法国保留手写的国家数值、经济配置、初始装备、国策、事件、决议与胜负条件；其余 247 个国家由生成器按地图数据自动建立**完整可运转**的定义（人口/人力/工厂/资源/装备/初始陆海空部队/解锁模板），地图上的任何省份都可以被部队进入与占领
- 另有 **367 个海域省份**（`terrain=ocean`、无归属、不入任何州），覆盖全球大洋与近海，供海军部署与移动，使舰队真正在海面行动而非停在陆地上。海域在 **1000×500 网格**上以多源 BFS（网格 Voronoi）一次性划分，每个格子只属于一个海域；构建时再用与蒙版同源的 10m admin-1 陆地省界裁剪，避免海陆错位。裁剪后若单个 MultiPolygon 仍含互不相连的部件，则拆成独立海域并分配新 id，只保留 ≥0.05 deg² 的碎片——因此每个海域省份都是**单连通多边形**，不会再出现「同一海域分成两块、中间不相连」
- **初始部队即可指挥**：1936 开局的德国 42 个师、波兰 28 个师以真实的 `state.armies` 实体存在（按每支最多 6 个师拆分），可直接选中、移动、作战，而不是仅用于显示的驻军计数
- **初始空军与舰队**：德国在柏林拥有战斗机与战术轰炸机群、在汉堡拥有驱逐舰队；波兰在华沙拥有战斗机群，开局即可指挥
- **预设阵营**：轴心（GER + ITA）与同盟（FRA + GBR），对阵营成员宣战会自动扩大为阵营战争
- 1939 派生剧本：通过 patch 覆盖起始日期、省份归属与预设战争
- 装备 14 种、科技 36 项、部队模板 5 种、飞机 4 种、舰船 4 种（`data/equipment.json`、`data/techs.json`、`data/divisions.json`、`data/aircraft.json`、`data/ships.json`）
- 德国国策树：3 个节点（重建 → 重整军备 → 要求但泽）
- 事件：但泽要求（吞并 / 宣战两条分支）
- 决议：战争债券（政治点数换人力）
- 任务与胜负条件：吞并波兰 / 生存到 1946

### 界面

- 启动菜单、国家选择（按大洲区域筛选 + 名称搜索，250 个国家可选）、继续游戏（含自动存档入口）
- 11 个功能面板：总览、政治、经济、生产、部队、科技、外交、情报、战争、通知、日志
- 生产面板支持追加 / 调整 / 暂停 / 取消生产线与建造队列，带进度条，全部走命令管道
- 部队面板支持部署、移动、自动寻路、定位、解散，以及待机 / 进攻 / 撤退指令与「向敌方推进一格」，显示人力、装备与补给状态
- 空军 / 海军面板：部署、移动、定位、解散；舰队部署受沿海省份限制
- 战争面板：双方战争分数条、军力对比、争夺中的省份、和平提议入口
- 通知中心：按战争 / 建造 / 科技 / 外交分类筛选历史播报
- 省份详情：地形防御、沿海、补给系数、基建/要塞、受损、州人口与工厂、驻军与建造情况
- 外交面板：阵营成员与邀请、租借、战争目标、宣战/议和/改善关系，全部经命令管道
- 地图直操作：点选部队 / 空军 / 舰队后高亮可移动省份并绘制箭头，点击目标即移动；省份速览卡可直接部署
- 国家速览：低缩放下点击国家（或省份速览卡的「国家」按钮）弹出，展示政体、首都、阵营、对我国关系、人口 / 工厂 / 军力 / 资源，并提供宣战、议和、改善关系、邀请入盟、租借与跳转外交面板等快捷操作
- 科技面板展示完整科技树、前置条件与研究进度
- 经济面板展示综合产能、资源收支、装备库存与建造进度
- 和平会议弹窗（自动暂停时间）、事件弹窗、胜负弹窗、通用模态框
- 底部状态条：资源、人力、工业、军事（含陆军、空军、舰队数量与战争场次）；使用紧凑简称，悬停显示全称
- 地图视图切换：选择 / 前线（本国边境与交战前线）/ 地形（按地形着色）/ 省份（全部省界与省名）
- 地图上绘制可指挥部队 / 空军 / 舰队标记（同省多支部队环形错开，可逐个点选）
- 键盘快捷键：`空格` 暂停/继续、`Esc` 关闭面板或取消选择、`0`–`9` 切换面板
- 响应式布局：窄屏下侧栏与面板自动收窄/堆叠
- 深色 / 浅色主题切换；右上角 `AI` 按钮一键切换 AI 接管

### 测试

```bash
npm test                            # 三套全跑：核心 + 集成 + 渲染层冒烟
npm run test:core                   # 战役核心 1026 项
npm run test:integration            # 主程序集成 75 项
npm run test:ui                     # 渲染层冒烟 125 项
npm run bench                       # AI-only 600 天性能基准
```

当前三套测试均全部通过，共 **1226 项**。覆盖：PRNG 确定性、时钟换算、剧本校验、命令管道、国策/决议、
经济结算（资源/产线/建造/科研/人力）、军事闭环（部署/移动/战斗/占领）、地形/战斗宽度/组织度/补给网络/
自动寻路与部队指令、空军与海军（部署/移动/空战/海战/轰炸/炮击/修复）、外交深度（阵营/邀请/租借/
战争目标/和平会议）、AI 决策与 600 天压测、同种子双跑一致、快照 + 命令日志回放、存档版本迁移与
增量补丁、门面层端到端流程，以及全部 11 个面板在「有数据」与「空态」两种状态下的渲染不抛错。

性能：AI-only 600 天从优化前的约 4.6 s 降至约 0.45 s（约 0.75 ms/游戏日）。
关键优化：AI 每轮只构建一次省份/部队索引（此前每个国家各扫一遍 4,594 个省份）、
补给网络按阵营合并 BFS、控制方索引与受损省份列表改为派生缓存、战争分数改用索引计数。

地图加载：首屏数据从 6.6 MB 降到约 3.1 MB（国界 TopoJSON 剥离属性 0.90→0.15 MB、
`index.json` 去掉无人读取的字段后约 0.79 MB、精档 TopoJSON 改为首帧后后台加载）；
首屏要构建的 Path2D 从三层减到两层（国家 + 粗档），精档的 4,961 个省份在后台换入。
缩放阈值与上限改为按 `fitScale` 换算，移动端不再需要放大 20–40 倍才能进入省份层级。

---

## 尚未完成 / 已知限制

这是原型，不是完成品。以下缺口按影响排序：

1. **可玩国家无手写内容**
   全部 250 个国家均可选中开局，且都有可运转的经济/军事底座与初始部队。但除德国、波兰、法国外，其余 247 个国家只有自动生成的数值，没有手写国策树、事件、决议与胜负任务（`Game.countryIdByIso3` 仍只硬编码 `DEU/POL/FRA` 三个与 ISO3 不同的标签，其余国家标签与 ISO3 相同，走回退逻辑）。
2. **空军与海军仍是简化模型**
   已有空战、制空支援、战略轰炸、海战与沿岸炮击，海军可在海域省份部署与移动；但没有航母舰载机、运输船队/护航、海上封锁与两栖登陆；制海权也不会影响海上补给线，远海舰队仅靠近岸一格补给。
3. **地图首屏仍需下载约 3.1 MB**
   开屏只加载国家层（0.16 MB）、省份粗档（2.1 MB，含海域省份）与 `index.json`（0.79 MB）；精档（3.8 MB，含海域）后台加载。冷启动解析仍有约 0.5–0.8 s，弱网下更久。进一步可做 gzip/二进制格式或按区域分片。
4. **无 CI，且没有真实浏览器测试**
   三套测试都在 Node 层运行（渲染层用 DOM 桩模拟），没有覆盖真实浏览器中的 Canvas 绘制、鼠标/触摸事件与交互，也没有接入持续集成。
5. **时间节奏偏快**
   1x 为 1 游戏日 / 真实秒，一个游戏年约 6 分钟；最高 8x 下约 45 秒一年。1936 → 1939 在 8x 下约 3.7 分钟，适合观战但细节偏快。

---

## 技术架构

```
┌─────────────────────────────────────────────────────────┐
│ 渲染层 js/render/（经典脚本，window 全局）                │
│   main.js   启动/国家选择/游戏循环/主题/AI 开关/快捷键     │
│   map.js    Canvas 地图、LOD、拾取、前线、海陆空标记、小地图│
│   ui.js     面板、弹窗、状态栏、和平会议                  │
│   game.js   门面：只读快照 + 命令入口 + 存档适配           │
│   data.js   界面展示常量（意识形态/资源/地形）            │
└──────────────────────────┬──────────────────────────────┘
                           │ Game.command(cmd) / 读 state
┌──────────────────────────▼──────────────────────────────┐
│ 模拟层 js/core/（ES Module，挂载 window.Core）            │
│   campaign.js   Campaign 门面：Clock + State + Command   │
│   clock.js       确定性时钟与日期换算                     │
│   state.js       世界状态构建（军队/空军/舰队/阵营/装备）  │
│   commands.js    校验 / 执行 / 日志 / 自动寻路             │
│   rules.js       级联规则、效果展开、任务与胜负            │
│   economy.js     每 tick 经济与科研结算                    │
│   war.js         每 tick 战斗 / 占领 / 战争分数 / 部队维持 │
│   airnavy.js     补给网络 / 空战 / 海战 / 轰炸 / 部队指令  │
│   supply.js      补给系数与控制方索引（共享底层）          │
│   diplomacy.js   阵营 / 租借 / 战争目标 / 和平会议          │
│   save.js        版本迁移 / 路径补丁 / 增量存档            │
│   ai.js          月度 AI 效用决策                          │
│   rng.js         xoshiro256**                            │
│   index.js       统一出口（window.Core）                  │
│ content/loader.js     剧本与外部内容加载                  │
│ content/schema.js     结构与引用校验                      │
│ content/conditions.js 触发器求值                          │
│ content/l10n.js       本地化                              │
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
│   ├── core/                  模拟层（时钟、状态、命令、规则、经济、军事、外交、存档、AI、RNG）
│   │   └── campaign.js        Campaign 门面（Clock + State + Command）
│   ├── content/               剧本加载、校验、条件、l10n
│   └── render/                渲染层（经典脚本）
│       ├── main.js            启动、游戏循环、主题、AI 开关、快捷键
│       ├── map.js             地图渲染与交互
│       ├── ui.js              面板与弹窗
│       ├── game.js            渲染层 ↔ 模拟层门面
│       └── data.js            界面展示常量
├── data/
│   ├── scenarios/             1936 手写模板 / 生成剧本、1939 派生补丁
│   ├── equipment.json         装备定义（成本与资源消耗）
│   ├── techs.json             科技树（前置与效果）
│   ├── divisions.json         部队模板（编制、宽度与消耗）
│   ├── aircraft.json          飞机型号（编组、制空/轰炸/运输）
│   ├── ships.json             舰种（编组、海战/炮击）
│   ├── focuses/               国策树
│   ├── events/                事件
│   ├── decisions/             决议
│   ├── l10n/                  本地化
│   ├── provinces.l0/l1.topo.json   省份双档 TopoJSON（l1 后台加载，含海域省份）
│   ├── sea.geojson            海域省份源数据（构建用，浏览器不加载）
│   ├── sea-ids.json           裁剪拆分后的最终海域 id 列表（构建中间产物）
│   ├── sea-adj.json           网格级海陆邻接（构建中间产物）
│   ├── countries.l1.topo.json      国界 TopoJSON（仅保留中文名等 4 个属性）
│   ├── index.json             省份名称 / 归属 / 邻接 / 沿海 / 海域标记
│   └── ne_*.geojson           Natural Earth 源数据（仅构建用，浏览器不加载）
├── scripts/
│   ├── build-sea.mjs          生成海域省份（1000×500 网格多源 BFS → sea.geojson + 网格海陆邻接）
│   ├── build-provinces.mjs    用陆地省界裁剪海域并按连通性拆分，再重建省份 TopoJSON
│   ├── build-index.mjs        重建 index.json（邻接 / 沿海 / 海域标记）
│   ├── build-scenario.mjs     模板 + index.json → 全量 1936 剧本（含全部国家与海域）
│   ├── strip-topo.mjs         删除 TopoJSON 中未使用的 properties
│   ├── slim-geojson.mjs       精简原始 GeoJSON 属性（39 MB → 28.5 MB）
│   ├── test-campaign-core.mjs 核心确定性测试
│   ├── test-integration.mjs   主程序集成测试
│   ├── test-ui-smoke.mjs      渲染层冒烟测试（DOM 桩）
│   └── bench-sim.mjs          AI-only 600 天性能基准
├── vendor/                    内置 d3 与 topojson-client
└── docs/                      地图数据与修复记录
```

---

## 数据与内容格式

### 剧本

`data/scenarios/1936.json` 定义国家、省份、州、战争、任务、胜负条件与内容引用。它是**生成产物**，不要直接手改：

- `data/scenarios/1936.template.json` 是手写源文件，只包含三个可玩国家的完整内容、20 个详细省份、州、任务，以及 `initialArmies` / `initialAirForces` / `initialFleets` / `alliances`
- `node scripts/build-scenario.mjs` 读取模板 + `data/index.json` + Natural Earth 国界数据，补齐其余省份、归属、国家最小定义与州，写出 `1936.json`
- 修改 1936 内容请改模板后重新生成；`initialArmies` 中 `count` 为初始师数，按 `divisionsPerArmy`（默认 6）拆成多支可指挥部队；空军/舰队的 `count` 为编组数，每个编组的飞机/舰船数由 `data/aircraft.json` / `data/ships.json` 决定

派生剧本使用：

```json
{ "base": "1936", "id": "1939", "patch": { "owners": { "...": "GER" } } }
```

补丁语义：对象递归合并，数组整体替换。

### 装备 / 科技 / 部队 / 飞机 / 舰船

这五个文件是经济与军事系统的底座，随剧本一起加载并校验，缺失或结构非法会直接报错。

- `data/equipment.json`：`{ cost, usesResources, category }`，`cost` 决定生产一件所需天数（1 个军用工厂）
- `data/techs.json`：`{ time, requires, effects }`，效果为结构化字段（`divisionBonus` / `factoryBonus` / `resourceBonus` / `terrainDefense` / `unlockTemplate` / `unlockEquipment` / `unlockAir` / `unlockShip` / `construction` 等）
- `data/divisions.json`：`{ baseStrength, org, speed, width, cost: { manpower, equipment }, requires, terrainBonus }`
- `data/aircraft.json`：`{ planes, role, cost, requires, airCombat, groundSupport, bombing, supplyBonus }`
- `data/ships.json`：`{ ships, role, cost, requires, navalCombat, bombardment, airCoverage }`

### 国策 / 事件 / 决议

- `data/focuses/*.json`：节点 DAG，支持 `prerequisites`、`requires`、`cost`、`days`、`effects`
- `data/events/*.json`：`trigger` + `options[].effects`，支持 `once`、`meanTimeToHappen`（当前未用于抽取）
- `data/decisions/*.json`：`scope`、`trigger`、`cost`、`cooldown`、`repeatable`、`effects`

### 重建地图数据

```bash
npm install
node scripts/build-sea.mjs         # 生成海域省份（1000×500 网格多源 BFS → sea.geojson + sea-adj.json）
node scripts/build-provinces.mjs   # 用 ne_10m_admin_1 裁剪海域并按连通性拆分，写出 sea-ids.json，再重建 l0/l1 TopoJSON
node scripts/build-index.mjs       # 按 ne_id 关联名称/归属，生成邻接、沿海与海域标记
node scripts/build-scenario.mjs    # 模板 + index.json → 全量 1936 剧本（含全部国家与海域）
npm run strip:countries            # 国界 TopoJSON 只保留中文名等 4 个属性
npm run slim:source                # 原始 GeoJSON 只保留构建所需 5 个属性
# 或一次性执行：npm run build:map && npm run build:scenario（npm run build:all）
```

`build-scenario.mjs` 依赖 `data/index.json` 与 `data/ne_50m_admin_0_countries.geojson`，应在重建地图数据之后运行。

注意：

- 构建时排除南极洲（`adm0_a3 != 'ATA'`）
- 海域先在网格上按连通性划成单连通块，再 explode 成单个矩形做 `-erase`：mapshaper 会整块丢弃「单个要素含大量互不相连部件」的 MultiPolygon，不拆分会丢掉海域省份
- 裁剪后若仍出现 MultiPolygon，`build-provinces` 会把每个连通部件拆成独立海域：最大部件保留原 id，其余从 `910000001` 起分配新 id；面积 < 0.05 deg² 的碎片直接丢弃，确保输出中每个海域都是单个 Polygon
- 两档必须同时重建：`index.json` 的邻接表与沿海标记由 `provinces.l1.topo.json` 的弧段共享关系推导；海域-陆地邻接另由 `sea-adj.json` 的网格邻接补入（裁剪后的海面常与海岸隔约一格，不共享弧段）
- 原始 `ne_10m_admin_1_states_provinces.geojson` 已精简为只含 `ne_id / name_zh / name / adm0_a3 / scalerank`（38.8 MB → 28.5 MB），几何没有改动；它只用于离线构建，网页不会下载
- `countries.l1.topo.json` 只保留 `NAME_ZH / NAME_ZHT / NAME / ADMIN`，体积从 0.90 MB 降到 0.15 MB
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
8. **派生缓存不进存档**。控制方索引、受损省份列表等属于可重建的派生数据，用 `WeakMap` 挂在状态对象上；
   控制权变更必须递增 `s.controllerVersion` 使索引失效，读档产生新状态对象时缓存自动丢弃。
9. **性能改动先跑基准**。`npm run bench` 以 AI-only 600 天为口径；优化前后对比耗时与确定性，不要只看单帧。

---

## 路线图

### P0 · 打通可玩闭环 ✅ 已完成

1. **调整时间节奏** — 1 tick = 1 游戏日，1x 为 1 真实秒/日，倍速 0–8 线性缩放；8x 下 1936 → 1939 约 3.7 分钟。
2. **实现经济 tick** — `js/core/economy.js`：资源产出、生产线装备、建造队列、科研推进与效果应用、人力增长、政治点数恢复、稳定度/战争支持漂移、补给维持，全部为 `onTick` 中的确定性结算。
3. **最小陆军闭环** — `js/core/war.js`：部队实体（兵力/组织度/速度）→ 沿 `index.json` 邻接表移动 → 同省战斗（地形/要塞/科技修正）→ `setController` 占领 → 州归属翻转 → 战争分数 → 自动议和与投降。
4. **简单 AI** — `js/core/ai.js`：月度效用打分，覆盖产线、建造、科研、部署、推进、宣战，全部经 `campaign.command()`；提供 AI-only 模式（`?ai=1`）与 600 天压测。
5. **修复生产面板** — 生产线改为追加 / 调整 / 取消，删除按钮不再直接改状态，全部走命令管道。

同时完成：装备 / 科技 / 部队模板从展示层迁出为 `data/*.json` 并由核心加载校验；科技面板改用核心科技表；
`js/render/data.js` 收敛为纯展示常量；`fastForward` 改为同步推进时钟（此前月界判定与任务评估在快进时不会触发）。

### P1 · 扩展世界与内容 ✅ 已完成

6. **全量剧本生成器** ✅
   `scripts/build-scenario.mjs` 基于 `data/index.json` 自动生成 250 个国家/地区的省份与州归属，并为全部国家生成**完整可运转**的经济/军事底座与初始陆海空部队（人口、工厂、资源、装备、解锁模板），让地图上的世界真正可进入、可占领、可开局；手写的德国/波兰/法国内容保留在 `1936.template.json` 中作为默认开局。`scripts/build-sea.mjs` 额外生成海域省份，使海军能在海面行动。
7. **战斗与军事系统补全** ✅
   `war.js` 加入战斗宽度、地形防御/移动代价、组织度自然恢复与断补给流失；`airnavy.js` 加入补给网络、空战/制空支援/战略轰炸、海战/沿岸炮击，以及 `hold/advance/retreat` 指令与自动寻路推进。
8. **外交深度** ✅
   `diplomacy.js`：阵营领袖/邀请/加入退出、阵营战争自动扩大、租借（关系门槛 + 月度额度 + 冷却）、战争目标、简化和平会议。
9. **UI 完善** ✅
   生产/建造进度与暂停取消、战争面板、省份详情、通知中心（分类筛选）、空军/海军操作、键盘快捷键、响应式布局。
10. **存档体系** ✅
    `save.js`：每月自动存档（独立存档位）、v1→v4 逐级版本迁移、路径式补丁增量存档与基线自动推进。

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
