# 本机重建

当前 Mac 已安装，双击项目根目录的 `启动本地重建.command`。启动后打开 http://localhost:3000，上传图片，生成并检查三维草稿，再转换为积木。保持终端开启。停止使用时在终端按 Ctrl+C。

在线网站不能直接调用另一台电脑的 GPU。无需账号的重建只在这台电脑的本机工作台运行；可把生成的 GLB 下载后导入在线网站。原始 GLB 不带照片纹理，单色配色是用户选择，并非自动纹理还原。

## 本机依赖

- Hunyuan3D-Swift 源码：https://github.com/ZimengXiong/Hunyuan3D-Swift ，使用提交 `292331f4d26ddb80b9dcea6bcb5629ff82f12b82`。Swift 源码 MIT，模型和算法保留各自许可证。
- mlx-swift 0.31.4，底层 MLX 0.31.1；Swift Numerics 1.1.1。
- 权重：https://huggingface.co/zimengxiong/hunyuan3d-mlx-shape-small ，`model.fp16.safetensors` 3,819,958,234 字节，SHA-256 `3cc66f3bea33e4062b7dbc875ffe1d70c4888914aec3e91b60f94e9bd01b522b`。
- Metal 运算库来自 PyPI 的 `mlx-metal 0.31.1` macOS 26 ARM64 官方 wheel，SHA-256 `e7324b7c56b519ae67c025d3ced07e5d35bc3a9f19d4c45fe4927f385148c59e`。从 wheel 提取 `mlx.metallib`，与可执行文件放在一起。这样不需要另装完整 Xcode 的 Metal 编译器。
- `scripts/prepare-local-image.swift` 使用 macOS Vision 的前景掩模，并输出透明 PNG。没有向外部服务发送图片。

本轮仅使用 shape 小模型；没有下载或运行需要更大内存的 paint 纹理模型。完整模型的商用/分发应另查上游模型许可证，源码 MIT 不等于权重也采用 MIT。

## 在另一台 Apple Silicon Mac 安装

需要 Swift 6、Node.js 22.13+、macOS 14+、约 16 GB 内存。当前提取的 Metal 库针对 macOS 26；其他系统请选择对应的官方 wheel。

1. 从上述提交获取 Hunyuan3D-Swift，运行 `swift build -c release -j 4`。保留其上游许可证。
2. 把生成的 `hy3d` 复制到本项目 `work/local-3d/hy3d`；把匹配系统的 `mlx.metallib` 放在同一目录。
3. 从上述权重仓库下载 `model.fp16.safetensors` 和 `config.yaml` 至 `work/local-3d/weights/`，核对文件大小与哈希。首次需要约 4 GB 下载。
4. 在项目目录执行 `swiftc scripts/prepare-local-image.swift -o work/local-3d/prepare-image`。
5. 运行 `npm run local`。此模式的重建端点只接受本机请求，任务一次运行一个。

本次网络到 GitHub/Hugging Face 原站不稳定，源码依赖改用相同固定版本的 GitHub codeload，模型使用 Hugging Face 镜像，Metal wheel 使用 PyPI 镜像；两个大文件均与上游元数据中的 SHA-256 核验一致。临时源码位于系统临时目录，重启可能清理；已复制的可执行文件、Metal 库、权重在 `work/local-3d/`，正常启动不依赖临时源码。

## 已验证与限制

神庙照片经过 Vision 去背景后成功生成 163,004 个三角面的 GLB，正面与侧面可辨双塔、台阶、门内雕像、前方树木。HTTP 提交、状态查询和 GLB 下载也成功。三维网格不是乐高零件清单：需要第二阶段按真实网格体积转换，仍会损失细节并添加支撑，不能保证真实拼装稳定或每种零件颜色有库存。

无浏览器截图/交互测试。本轮用独立网格渲染、真实图片推理、HTTP 接口、转换与导出验证。
