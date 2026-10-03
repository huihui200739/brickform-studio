# 材质与颜色链路审计：2026-10-04

## 结论与当前边界

House 草地变黄有固定输入下可复查的色板缺色证据，支持追加实际 Lime / Olive_Green。House 的局部中性色变蓝、区域内部像素对应、Temple 隐藏面的跨方向借色仍是独立问题。本轮完整 donor 方向门槛在 House CAD 中发生灰墙回归，已被拒绝；生产保留 Lime / Olive_Green 及采购色号映射，撤回该方向门槛。

恢复后的仅加色版本指纹为 `ea8b01354e21a4b16e6fbdf4eb7624e7fbe7681db7360eab502ccee8e046d0b4`，与旧色板冻结审计和被拒绝方向版本分别保存。[当前候选结果](/Users/huihui/Documents/乐高图纸生成/outputs/material-palette-calibration/candidate-results.json)

来源追踪复用已有本机推理输出。本轮另行执行当前生产转换、259 项单元测试、类型检查、构建及 12 份缓存回归，没有新增模型推理或下载。现有样例、单元测试、CAD 连通或扣接检查没有给出“任意图片”的成功率，也没有实物完整拼装成功率。所有改善都限定于本文列出的输入与控制；两类失败案例仍不能按成品套装交付。

## 1. 原始观测与材料假设分别说明什么

原图 RGB 是相机记录的辐射颜色，会共同受到材料、彩色光照、阴影、反射和遮挡影响。同样的暗像素可以来自真实深色涂装，也可以来自浅色材料的阴影。`observed` 说明源面取得了图片样本；它没有证明像素投到了正确物体部位，也没有证明最近积木色就是材料真值。

学习得到的 albedo 是另一份材料候选。有限输出、低重建残差、同模型重复一致或相邻区域颜色一致都不能独立证明材料正确。原图、原相机和几何被冻结后，仍可能稳定地采错同一片像素，或稳定地把真实暗涂装提亮。必须保留原始 RGBA、来源 hash、源 mesh 坐标、投影像素与源面 ID、原始区域 ID、法线/面积和精确共边关系，分别记录观测、候选和设计推断。

House 当前来源相机是 yaw 35°、pitch 10°、perspective 0；轮廓 IoU 为 0.917108。原实现使用 192 网格及既有像素映射，账本记录原变换；没有把保存账本说成修正了对齐。轮廓拟合只约束外形，不能认证屋顶、墙、门窗和草地的内部对应。候选继续使用原图做相机与特征检测，不覆盖原图观测。typed array 由独立拷贝和所有权隔离保存，并非运行时深度写保护。[House 来源链](/Users/huihui/Documents/乐高图纸生成/outputs/house-colour-chain-audit/summary.json)

## 2. House 草地：固定输入证明旧色板缺色

冻结审计使用旧生产指纹 `edb90867f9839817357a79ec6a4eb145a5488aa2ec70a60f75ba11c1a420728f`，显式保存原 0–13 共 14 种 opaque RGB，排除索引 14 的透明橙。后续生产加色不会改变这份距离控制。草地 mask 用原图 alpha >100、y≥260，以及原图 G>R×1.12、G>B×1.2、G−max(R,B)>15；它是有边界的颜色/位置控制，不是完整语义分割。

| 4,198 个草地像素 | 原图 | 实际 albedo 候选 |
| --- | --- | --- |
| 平均 RGB | 104.81, 142.28, 53.25 | 144.45, 208.23, 57.36 |
| 逐像素 Lab 均值 | 54.14, −27.53, 41.51 | 77.07, −42.03, 63.21 |
| 旧色板最近色为黄的像素 | 1,483 | 3,514 |

候选平均色相变化为 7.74°，Lab a 仍为负且更负。草地仍为绿色，但增亮、彩度变化使缺少亮绿色的旧色板选黄。这里的 Lab 是生产距离函数所用的表示，最近色距离为 `sqrt(0.5×ΔL²+Δa²+Δb²)`，没有称其为 CIEDE2000。[冻结距离控制](/Users/huihui/Documents/乐高图纸生成/outputs/house-colour-chain-audit/palette-control-frozen.json)

具体像素 `(266,279)`：原图 `[62,115,46]`、Lab `[43.48,−31.83,32.23]`；候选 `[136,209,49]`、Lab `[76.71,−46.41,66.72]`。旧色板距离为黄 45.84、深绿 49.93；实际 Lime 距离为 14.67。最终黄色地台 cell `(28,2,10)` 的 observed 来源面 153780、154131、154128、154130 原为深绿 5，候选变黄 3；同一来源像素、面 ID 和区域均可追查。

以实际 LDraw Lime `#A5CA18`（LDraw 27 / LEGO 119）和 Olive_Green `#77774E`（LDraw 330 / LEGO 330）加入距离控制后，旧候选判黄的 3,514 个像素中，3,513 个转为 Lime，1 个仍黄；全部草地像素中 Lime 3,896、Olive 27。2,095 个蓝屋顶样本与 1,184 个正面砖墙样本的最近色计数保持一致；精确黑、深棕、蓝、灰测试 RGB 保持原 ID。

LDraw 色值取自已核验文件，SHA256 `0178cd14fba46acb9df049c835e60e223b134d178f7e928ace0be1dfbe78895d`。[官方颜色表](https://ldraw.org/parts/colour.html) 生产追加索引 15=Lime、16=Olive，原索引保持。采购映射为 BrickLink 34 / 155；颜色编号存在不能证明每个所需零件与颜色组合已生产、可采购或有库存，缺少组合证据仍需核实。

这些控制验证色板可表示性。它们没有证明 learned albedo 能保留任意真实暗色涂装，也没有解决灰墙或几何。

## 3. House 墙面：三种来源必须分别追踪

### 3.1 observed 中性色变蓝是实测局部风险

source face 132099 近垂直，法线 `[0.9961,−0.0592,0.0652]`。它采样原图 `(223,239)` 的 `[100,95,106]`，Lab `[41.11,4.31,−5.53]`，最近色深灰 12；实际候选变为 `[102,104,162]`，Lab `[46.09,13.82,−31.57]`，最近色蓝 4。候选蓝距离 31.13，深灰距离 34.55。

源面中心所在最终 cell `(22,12,11)`，原模型砖 1232 是黑 1，候选砖 1286 是蓝 4。这条链说明局部候选色偏会到达最终积木。它并不把原像素升级为真实材料测量。该面是 observed，按候选像素取色；所在 region 虽标记 compatible-surface，其 donor 规则只决定未观察成员，不能据此把该 observed 面误归因给 donor。[原像素、候选像素与最终砖](/Users/huihui/Documents/乐高图纸生成/outputs/house-colour-chain-audit/summary.json)

### 3.2 侧壁/屋顶交界样本：撤回明确跨区域错误的判断

source face 112142 法线 `[0.0494,0.0140,0.9987]`、grid center `[20.27,31.43,14.70]`，取得 `(191,175)` 的像素。原图 RGB `[29,44,87]`，候选 `[95,112,170]`。最终 cell `(20,31,14)` 在原模型与候选中均为蓝。随后查看原图和精确共边局部网格，发现该点位于阁楼窗砌块侧壁下缘与斜屋顶的交界阴影。旧 `manual-roof-core` 矩形不能把这个边界点认证为屋顶内部。

连续投影点距实际侧壁/斜面共边仅 0.168 pixel；取整后落在同侧壁邻面，没有证明跨越墙/屋顶语义边界。局部网格保留侧壁与斜面折角。因此撤回“该面证明屋顶像素投错到墙”或“屋顶被竖直化”的判断，把它保留为边界取样不确定性控制。当前也没有逐面材料真值或多个内部锚点对齐证据，不能宣称对应已经校准。[局部对应复核与更正](/Users/huihui/Documents/乐高图纸生成/docs/interior-correspondence-audit-2026-10-04.md)

### 3.3 未观察面推色、体积填充与底板是另一些来源

严格低墙诊断 mask 是 grid y8–32、x7–23、z5–21、abs(normalY)<0.2，并非确认的完整墙语义。其源面面积 345.45 stud²；原蓝面积 8.09，候选蓝面积 7.75。灰→蓝为 10 个 observed 面，共 0.248 stud²。候选蓝面积中 observed 6.12、inferred 1.63；推断部分 compatible-surface 0.571、local-observation 1.062。

更宽的低层蓝砖 mask 有 3,520 个最终矩形 cells，其中 3,049 没有截取到 source triangle area；包含内部填充或 packing 体积，不能当可见蓝墙面积。其蓝色 winning source area 为 155.94，其中 137.28（88.0%）原已蓝。独立蓝底板共 368 个 base 砖，由 volume dominant4 选择，不能归因给原图草地。

因此，直接统一替换蓝面会同时影响真实蓝屋顶、局部色偏、内部错配候选和隐藏设计颜色。应保留每种来源及未观察状态，先核对区域边界和来源，再决定材质。

## 4. Temple：对向、正交 donor 的具体反例

Temple 审计冻结于 `dcb6e28` / 同一 `edb90867…0728f` 指纹；中途混合实现的结果已丢弃，最终只使用冻结生产快照。区域包络是诊断范围，不是经验证的完整背墙分割。[Temple 冻结审计](/Users/huihui/Documents/乐高图纸生成/outputs/temple-colour-chain-audit/summary.json)

| 未观察目标 region → donor | 实测关系 | donor 原始与候选像素 |
| --- | --- | --- |
| 1863 → 2229 | 目标 normal 约 −Z；dot −0.999398；中心距离 11.472 studs；面偏移 3.795 studs；inclination 差 0.001694 | `(182,105)`，原 `[78,55,34]` → 候选 `[135,90,45]`；raw region413；候选棕9 |
| 1695 → 2229 | 目标 normal 约 +X；dot −0.076983；中心距离 12.009 studs；面偏移 3.110 studs；inclination 差 0.072729 | 同一 donor 样本与棕9候选 |

region1863 的 observedFaces 为 0，inferredFaces 为 647；region1695 的 observedFaces 为 0，inferredFaces 为 499。二者通过 abs(normalY) 的倾斜相容性获得借色，但全法线分别近乎相反或正交。后方包络的棕9 winning area 为 241.207 stud²，全部标记 compatible-surface；其中 240.181 stud² 没有通过审计所定义的“同向且同面” donor 控制。该控制只是资格诊断，没有证明隐藏面的真实材料。

底台深灰是另一条来源：lower-source-platform 中深灰12的 winning area 86.507 stud² 全为 observed。修背面借色时不能把这些 observed 深灰整体洗成沙色；同样不能把原 region413 的暗棕像素单凭场景名字认定为浅沙色阴影。

## 5. 被拒绝的完整方向门槛：`9050b8`

保留的 rejected patch 将未直接共边 donor 限制为法线 dot≥0.9，直接 manifold 共边允许 dot≥−1e−6，并保留 inclination≤0.12。它加入方向限制和相应测试，没有建立区域内部图像对应或隐藏材料真值。[被拒绝的生产 patch](/Users/huihui/Documents/乐高图纸生成/benchmarks/experiments/surface-direction-rejected-2026-10-04.patch)

实际候选输出的完整指纹为 `9050b8aef2c6c00d1839e3b435859a859e999401689315e590eeecf1b41e5801`。`candidate-results.json` 的 `passed:true` 只覆盖列出的转换门槛，文件本身明确没有套装外观或实物拼装通过声明。该版本 House 28 档生成 2,966 件、182 个辅助支撑、548 步；碰撞、无支撑、无效零件计数为 0，连通为 true，2,953 次最后一层接近检查失败为 0。检查范围没有覆盖完整安装路径、手部操作或稳定性，采购仍有 35 行未核实且未检查库存。[被拒绝候选结果](/Users/huihui/Documents/乐高图纸生成/outputs/material-direction-calibration/candidate-results.json)

仅加色版本与方向门槛版本使用同一色板、原图和实际候选，全部 6,078 个区域的 `id/faces/area/normal/center/observedFaces/inferredFaces/observedPixels/materialPixels` 逐项相同。本文只读核对两个保存模型，这些字段差异计数为 0。方向门槛改变的是 donor 与后续颜色结果。[同色板回归控制](/Users/huihui/Documents/乐高图纸生成/outputs/material-palette-calibration/direction-regression-control.json)

| 同色板比较 | 仅加色、保留原 donor 行为 | 被拒绝完整方向门槛 |
| --- | --- | --- |
| reference-default 面数 | 1,694 | 54,698 |
| 从灰 compatible-surface 变成蓝 reference-default | — | 763 个 region，25,167 个 inferred 面 |
| House 最终零件 / 辅助支撑 / 步数 | 3,096 / 172 / 577 | 2,966 / 182 / 548 |

具体 region1895：两份输出的 1,150 个面均为未观察面，observedPixels 为 0，面积、中心和法线完全一致；法线 `[0.01659,0.07290,−0.99720]`。仅加色版本借 donor `[2576,2579,2278,2888]`，选灰11、source 为 compatible-surface；被拒绝版本 donor 变空，source 变 reference-default，颜色变蓝4。过滤借色证据后继续用全局颜色补未知面的行为，产生了这次具体回归。灰色旧推断本身也没有获得隐藏材料真值认证；撤回门槛保留已有可审查行为，不表示跨方向借色已正确。

实际背面 CAD 中，仅加色版本保留大面积灰墙，被拒绝版本相应外形被大面积蓝块覆盖。两者都有草地 Lime，配合相同区域几何和观测字段，交叉支持 donor/fallback 链路的退化。仅加色版本仍有阶梯屋顶、杂色与重建外形问题，不能作完成声明。

| 仅加色 `ea8b013…d0b4` | 被拒绝方向门槛 `9050b8…5801` |
| --- | --- |
| [House 背面 CAD](/Users/huihui/Documents/乐高图纸生成/outputs/material-palette-calibration/house-back.png) | [House 背面 CAD](/Users/huihui/Documents/乐高图纸生成/outputs/material-direction-calibration/house-back.png) |
| [House 立体 CAD](/Users/huihui/Documents/乐高图纸生成/outputs/material-palette-calibration/house-hero.png) | [House 立体 CAD](/Users/huihui/Documents/乐高图纸生成/outputs/material-direction-calibration/house-hero.png) |
| 背面 PNG SHA256 `547438154a3dfdc7069488b494bd8164d205b93ebbf0f0489c523d5f8a3c8613` | 背面 PNG SHA256 `ae94bd3428fea748c7895c627fc4c14679f9193e179fcf8d427eca6cc3c4252e` |

两份最终 House 模型也固定保存：[仅加色模型](/Users/huihui/Documents/乐高图纸生成/outputs/material-palette-calibration/house-candidate.json)，SHA256 `887447eecce59ac52e511899c9ceb666cd6e77b59cc7d18e654f2619d7d8444d`；[被拒绝模型](/Users/huihui/Documents/乐高图纸生成/outputs/material-direction-calibration/house-candidate.json)，SHA256 `8b64dc1352951811cf45da3cd5b4d2af6e3319f921e9a2a7ec083d4739e84f61`。旧14色与加色版本的区域编号会变化，本文不采用跨色板直接按 region777 对比的辅助数字；上述 **763 / 25,167** 是最终同色板控制结果。

## 6. 最小后续工程切片与验收顺序

首个切片只处理有实测风险的局部区域：House 的屋顶/灰墙边界与地台、Temple 的隐藏墙借色边界。每一步输出可独立复查，未满足本步条件就保留草稿或明确未知，不由后续构造掩盖前一阶段的错误。

| 顺序 | 最小输入与输出 | 本步必须检查 |
| --- | --- | --- |
| 1. 区域内部对应 | 用 immutable 原图 ledger 和同一相机，为屋顶、墙、开口、地台建立边界及少量内部锚点；记录像素→源面和遮挡。输出已核对、冲突或未知的区域对应。 | 外轮廓与内部边界均检查；核对 House `(191,175)` 来源面，保护门窗、火焰、树和装饰。不能只凭 silhouette IoU 通过。 |
| 2. 材料置信度与未观察状态 | 原始 RGB、albedo、色板距离和见证共同形成区域候选；observed-radiance、材料推断、隐藏设计色分开保存，保留置信度依据和拒绝理由。 | 控制真实深色、木纹、蓝屋顶、中性墙；同像素多种材料解释保持不确定。无合格 donor 时保留未观察状态，不能默默使用全局蓝/沙主色作为材料真值。 |
| 3. 设计面 | 从已核对区域提出有边界的平面、斜面或曲面候选，保留洞、折角、薄片与装饰；原 mesh 单独保存。 | 用同一来源相机检查内部边界和轮廓，检查曲率、残差、相邻面间隙与交叉；候选退化时回滚。改平面不能顺便统一刷色。 |
| 4. 构造 | 对设计面共同选择实际目录砖、板、铺面、斜坡或曲面件，明确背面/内部、跨梁和支撑意图；保留砖→区域→源观测/设计假设链。 | 开口、错缝、连接、碰撞、结构和采购逐项检查。保留未核实零件色组合；内部 dominant 填色和底板设计不进入原图材料正确率。 |
| 5. 说明书验收 | 输出每件或总成的安装前状态、装入路径、必要临时支撑、可辨识步骤、BOM 和采购状态。 | 最终 CAD 多视角和原图区域对应通过后，检查完整安装路径及操作空间；真人按图完整试拼并记录返工、弱连接和缺件。连接图、BOM 总数或最后一层接近检查不能替代这一关。 |

每个切片至少保留蓝屋顶、真实暗色/木材、中性灰墙、开口及未观察侧面的正反例。改一个区域必须同时检查其邻近区域和隐藏状态；拒绝结果、源 hash 和原始 CAD 也要保留。当前只有限定失败夹具和引擎样例，没有独立真实照片统计或完整真人试拼统计，不能给出任意图片/实物拼装成功率。

## 7. 固定来源与复查入口

| 来源 | SHA256 / pin |
| --- | --- |
| House 原 canonical RGBA | `7db1435cb4531df28da3719eea61516c7149636014c64ea8ee4b2429ae106225` |
| House 实际候选 canonical RGBA | `2938cc73052fe27ce6b5305a0a967fb4586c3464a3417012a757270f07433a53` |
| House GLB | `6028d6c60c1553c54991e00562924249178653dc0eabcb828e486bf3dbc76171` |
| Temple 原 canonical RGBA | `3b15881cb3e604ae23d1d8823471ffc04282961a22928481444e729ec6da7244` |
| Temple GLB | `432bff9f81a91d9e02f9e8ba3b09344b107fe2a6d08a1266ddce172215ed051f` |
| Marigold 官方 revision | `08c3930bb641abf786ba44ce92547507ebefbc16` |
| 材质引擎 fingerprint | `4931e60dda9afe89059075405da5bd7545c642366341f8091c248b99c68deb14` |

House 实际候选来自 [固定 job 结果](/Users/huihui/Documents/乐高图纸生成/work/intrinsic-engine/jobs/104400262b9bba895d4f85f6d14edca9f1eff057909b700d674257ffaf3529fd/material-analysis.json)。该结果是材料假设，不覆盖原图；source hash、尺寸、alpha 和几何/覆盖保留是输入一致性门槛，没有材料真值认证含义。冻结的 [完整旧色板 trace](/Users/huihui/Documents/乐高图纸生成/outputs/house-colour-chain-audit/evidence-frozen-old14.json) 和 [固定色板控制脚本](/Users/huihui/Documents/乐高图纸生成/outputs/house-colour-chain-audit/palette-control.ts) 与当前生产追加色隔离。

`outputs/`、`work/` 中的证据是本机文件，不随 Git 文档自动分发；复查需要同一文件与 hash。本文不复用被丢弃的混合实现结果，也不把测试 passed、目录模型渲染或降低零件数改写为外观、材料或实物拼装通过。
