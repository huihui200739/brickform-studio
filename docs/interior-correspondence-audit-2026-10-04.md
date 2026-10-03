# 区域内部对应审计：2026-10-04

## 结论及对先前判断的更正

**撤回把 House face112142 当作“明确的蓝屋顶内部像素投到竖直墙面”的假设。** 源图与精确共边邻域的局部叠图显示，它位于阁楼窗左侧砌块侧壁的下缘，接近侧壁与斜屋顶的交界阴影。此前 `manual-roof-core` 矩形把这个边界点归入屋顶，不能作为语义真值。

局部源网格保留了竖直侧壁和相邻斜面，形状与照片中的阁楼窗侧壁相容。本例目前没有支持“整片屋顶被竖直化”或“全局相机错误”的充分证据，也没有证明墙面真实材质颜色或内部对应已经正确。它应作为**边界观测不确定性控制**，不作为已证实的跨语义投影错误正例。[原图/源面叠图](/Users/huihui/Documents/乐高图纸生成/outputs/interior-correspondence-audit/house-local-overlay.png) · [局部源网格正交视图](/Users/huihui/Documents/乐高图纸生成/outputs/interior-correspondence-audit/house-local-geometry.png)

局部来源复核只读复用缓存 House GLB、原始 RGBA、`referenceAlignment` 和观测账本；随后追加第5节的独立轮廓试验。两项均未重跑原生图生三维模型或积木转换，没有把实验接入生产相机或颜色。已有原始观测、材质候选和最终模型保持原样。

## 1. face112142 的实际源几何与投影

源面法线为 `[0.04942,0.01404,0.99868]`；按 28 凸点缩放的 grid center 为 `[20.27198,31.42749,14.70039]`。纯几何共边扩展不使用颜色或场景类别：

| 侧壁邻域条件 | 面数 / 面积 | 空间跨度 | 实际 observed 像素包络 |
| --- | --- | --- | --- |
| 与 seed 法线 dot≥0.995，距 seed 平面≤0.06 stud | 106 / 2.539 stud² | X 1.993 studs、Y 4.984 plates≈1.993 studs、Z 0.098 stud | x186–199、y160–175，92 次网格样本 |
| dot≥0.97，平面距离≤0.2 stud | 291 / 6.024 stud² | X 3.322 studs、Y 7.752 plates≈3.101 studs | x176–199、y152–180，208 次网格样本 |

该邻域投到照片中的阁楼窗侧壁，沿下方斜边接主屋顶；没有把邻域整体投到一片完整蓝屋顶。face112142 与面112141精确共边，法线夹角 **43.079°**；112141 的法线为 `[0.51803,0.49327,0.69880]`。另一个共边面112150的法线与 seed 仅差 0.035°。因此，局部网格本身存在侧壁/斜面折边，不能仅因 seed 近垂直就判定屋顶几何被竖直化。[源面、共边与投影数据](/Users/huihui/Documents/乐高图纸生成/outputs/interior-correspondence-audit/house-face112142.json)

### 网格采样与像素取整的不确定性

账本保留既有 192 网格、分母191、网格中心偏移 `(0.5,0.5)` 和 `Math.round`。原图 bounds 为 `[35,284,26,294]`。seed 唯一网格样本 index20471 / grid `(119,106)` 的坐标为：

| 项目 | 数值 |
| --- | --- |
| 连续映射原图点 | `(190.78796,175.43455)` |
| 取整后的原图像素 | `(191,175)` |
| 取整位移 | `(+0.21204,−0.43455)` pixel |
| 连续点在 seed 三角面内的重心坐标 | `[0.78684,0.07263,0.14053]` |
| 取整点相对 seed 的重心坐标 | `[0.66040,−0.16427,0.50386]` |
| 连续点至侧壁/斜面共边的投影距离 | **0.16766 pixel** |

取整坐标离开 seed 三角面的连续投影，但落在同侧壁的相邻面112150内，重心坐标 `[0.49604,0.33967,0.16429]`。这证明微三角面归属与离散像素中心存在量化差异；**没有证明取整跨越了墙/屋顶语义边界**。不能把每个微三角面的此类差异直接判为采错材料。

该像素原 RGB `[29,44,87]`，原始 radiance region1972仅 **1 pixel**，boundary bits 为15（四个方向均是原始区域边界）。它就在图像中的强阴影/色度变化处：相邻 `(192,175)` 为 `[54,49,58]`，`(193,175)` 为 `[77,59,56]`；这些差异不足以唯一分辨蓝光、屋顶像素混合和侧壁真实涂装。既有实际 albedo 同点为 `[95,112,170]`，仍须保留材料不确定性。

### 相机诊断的边界

保留相机 yaw35°/pitch10°/perspective0，轮廓 IoU 0.917108。只读扰动 yaw±5°，seed 中心横向移动约 +2.70/−1.56 pixels；pitch±5°，纵向移动约 +2.55/−2.44 pixels。四个扰动的轮廓拟合分均下降。它们足以改变这一边界点附近的像素，却没有建立多个内部特征共同改善的证据。

故不能从一个低裕量边界样本选新全局相机。下一次相机修改必须同时对齐独立的门、窗、阶梯和侧壁/屋顶边界，并检查其他区域是否退化。当前相机也不能因为轮廓分较高而被宣称已经校准正确。

## 2. 已有两图内部区域分割探针能提供什么

另一项已完成的有界探针使用原始 House / Temple，固定 GroundingDINO tiny 与 SlimSAM，离线加载现有权重；每图一次完整图检测、一次批量 SAM，没有切片、重试或阈值搜索。检测阈值0.30、文本阈值0.25，最多24 boxes；实际 House 9 detections、Temple 6。引擎 fingerprint 为 `c6c6a791a10c5c44de30ce0b16ea0c12a99b1c5b463f4ffef1b40d2494ffeb04`。本文读取其审查记录和实际叠图，不执行新的模型调用。[完整探针审查](/Users/huihui/Documents/乐高图纸生成/outputs/interior-region-probe/review.md)

| 输入 | 可继续检查的候选 | 明确不支持的用途 |
| --- | --- | --- |
| House | 门00、阶梯01、窗03–05可作为局部开口/路径对应候选 | roof02有19,401 pixels，连砌块、烟囱、山墙与窗一起包含；SAM分0.969仍不能作为屋顶材料边界。ground floor06–08混入草地、竖直台沿和阶梯，不能作单一水平面。 |
| Temple | 阶梯00可作中央阶梯 footprint 候选；窗03–04可作匿名狭窄凹槽边界候选 | door01包含中央雕像壁龛及雕像，不能直接当门或空腔；ground floor02包含台沿及其他投影特征；roof05只给粗顶檐范围。 |
| 两图 wall | 无 | 固定阈值下没有 wall detections，探针没有提供墙区域约束。 |

House roof 的广泛错误覆盖和 Temple “door” 包含雕像可从实际图直接复查：[House roof02](/Users/huihui/Documents/乐高图纸生成/outputs/interior-region-probe/house/02-overlay.png) · [Temple door01](/Users/huihui/Documents/乐高图纸生成/outputs/interior-region-probe/temple/01-overlay.png)。探针检查了15份 mask PNG与保存 RLE的往返一致性；这是文件完整性，不能代替语义正确率。检测分与 SAM estimated IoU 分是不同且未校准的量，重叠的 ground floor proposals 也不是独立确认。

## 3. 最小可证伪的下一步

1. **先做候选特征对应。** 用保留的原相机，将源网格投到 House 门/窗/阶梯和 Temple 阶梯的候选 mask；比较边界、内部覆盖与遮挡。mask 与实际形状冲突则拒绝身份/范围，保留原始实例与几何；不能直接按 mask 删雕像或整面涂色。
2. **给边界样本保留不确定性。** face112142 用作 near-crease / singleton-radiance 控制，同时检查同一侧壁内部样本。分别记录连续投影、离散原像素、几何折边距离和辐射边界；未知材料保持未知。不要用三角面内外差异自动抹掉微小装饰。
3. **多个锚点共同约束相机。** 新相机须在独立内部锚点上改善，且保留轮廓、开口与邻近区域。单点颜色更像灰或蓝不能成为相机接受条件。

完成这些检查后才能讨论区域材料置信度与设计面。现有 probe 没有自动墙分区，face112142 也没有提供确定的材质真值。未完成区域内部对应校准、任意图片评估或真人完整试拼，不能报告材料/构造成功率。

## 4. 来源固定与复查

| 文件/来源 | pin |
| --- | --- |
| [原 House GLB](/Users/huihui/Documents/乐高图纸生成/outputs/image-benchmark/house/model.glb) | SHA256 `6028d6c60c1553c54991e00562924249178653dc0eabcb828e486bf3dbc76171` |
| [原 House RGBA](/Users/huihui/Documents/乐高图纸生成/outputs/identity-calibration/house.rgba) | canonical SHA256 `7db1435cb4531df28da3719eea61516c7149636014c64ea8ee4b2429ae106225` |
| [既有实际材质候选 job](/Users/huihui/Documents/乐高图纸生成/work/intrinsic-engine/jobs/104400262b9bba895d4f85f6d14edca9f1eff057909b700d674257ffaf3529fd/material-analysis.json) | Marigold revision `08c3930bb641abf786ba44ce92547507ebefbc16`；candidate canonical RGBA SHA256 `2938cc73052fe27ce6b5305a0a967fb4586c3464a3417012a757270f07433a53` |
| [原/候选/砖来源链](/Users/huihui/Documents/乐高图纸生成/outputs/house-colour-chain-audit/summary.json) | 旧生产 fingerprint `edb90867f9839817357a79ec6a4eb145a5488aa2ec70a60f75ba11c1a420728f`；其旧 manual-roof 矩形判断由本文更正 |
| [局部数据](/Users/huihui/Documents/乐高图纸生成/outputs/interior-correspondence-audit/house-face112142.json) / [脚本](/Users/huihui/Documents/乐高图纸生成/outputs/interior-correspondence-audit/audit.ts) | 只读取上述固定缓存，保存原图坐标、源面 ID、共边及原实现采样变换 |
| [Temple probe source](/Users/huihui/Documents/乐高图纸生成/outputs/interior-region-probe/temple/source.rgba) | canonical SHA256 `3b15881cb3e604ae23d1d8823471ffc04282961a22928481444e729ec6da7244` |

`outputs/` 和 `work/` 是本机证据，不随此 tracked 文档自动分发；复查时须保留对应文件及 hash。上一份颜色链路审计第3.2节已同步上述更正，原冻结来源链和模型没有被重写。

## 5. 已执行的内部轮廓试验及拒绝结果

新增独立实验入口 `npm run test:correspondence` 与 `npm run benchmark:correspondence`，没有将评分接入网页生成流程。提取器只使用精确共边、稳定几何片和可见折边；原图使用双尺度持续灰度线、方向与距离匹配，明确不把颜色边认定为真实几何。完整连通图像组件与分方向的线组分别保存，一个窗框的三条边不能冒充三个独立观测。源边组 ID 与相机无关，留一组检查不会因为可见性变化错删其他组。

### 5.1 控制发现并修复的选择错误

独立射线/长方体渲染给出已知相机，不复用被测三角投影器；两种投影的最大坐标差为0.689 pixel，仅来自原图包络与像素中心离散化。正确前视15°/10°有1,120个样本、24组几何边、8个匹配图像组件；错误背视180°/10°仅79个样本、1组/1组件，却取得更低的原始有向平均残差：**0.1323 < 0.2884**。

这个反例保留在测试和报告中，不能用平均分直接选相机。候选现在必须先满足独立组件、方向分布、空间覆盖和匹配支持，再参加残差排名；错误稀疏背面被排除，已知前面得到实验提名。由于只有一个合格竞争候选，最终状态仍是 `unresolved`，生产和对应真实性标志均为false。线性亮度变换后，同一个原始评分反例与正确提名保持。重复对称结构、平面涂装框、源几何缺失真实开口均保持未知，没有被“校准”成正确形状。

### 5.2 实际两图：没有足够支持改相机

| 输入 | 现相机 / 外轮廓IoU | 当前提取器的实际结果 | 决策 |
| --- | --- | --- | --- |
| House | 35°/10°/perspective0，0.9171 | 32个稳定片，8,360个折边候选均未通过双侧稳定支持；0个内部样本。10个相机候选均无可用内部线。 | unresolved；不能把提取器拒绝解释为已经证明整片源几何错误 |
| Temple | 0°/20°/perspective0.5，0.8854 | 69个稳定片，仅39个内部样本，集中在一处方向；10个候选不足以提供独立内部约束。 | unresolved；低残差和coverage1不能认证中央壁龛对应 |

House约5.6秒、Temple约4.9秒，均复用原缓存；本项无模型推理、下载或积木转换。两张原图坐标叠图已人工检查：[House候选](/Users/huihui/Documents/乐高图纸生成/outputs/interior-camera-calibration/house-contours.png) · [Temple候选](/Users/huihui/Documents/乐高图纸生成/outputs/interior-camera-calibration/temple-standard-contours.png)。蓝线是辐射边缘，紫线是提取到的可见源几何折边。这些图是诊断图，不是成品CAD或浏览器外观验收。

新增 **17项实验控制全部通过**，当前类型检查、定向lint通过。生产转换代码指纹仍为 `ea8b01354e21a4b16e6fbdf4eb7624e7fbe7681db7360eab502ccee8e046d0b4`；沿用同指纹上一批259项核心测试及构建证据，本项没有重复执行完整核心测试或构建。实际两例与全部候选的数值、脚本指纹、源hash及控制记录已保存为 tracked [报告](/Users/huihui/Documents/乐高图纸生成/benchmarks/interior-correspondence-2026-10-04.json)。完整逐样本匹配保存在本机文件，tracked报告记录其数量和hash。

当前实验不能承担通用自动相机校正。下一步限定为原图候选门/窗/阶梯与源几何的局部对应，保持轮廓、遮挡与未知状态；不能通过降低几何稳定阈值把三角噪声变成建筑边，也不能把未检测到的墙或错误屋顶mask补成事实。雕像后方杂块、隐藏墙推色与官方级构造尚未修复，仍需已核对的区域设计面和真实零件构造阶段。
