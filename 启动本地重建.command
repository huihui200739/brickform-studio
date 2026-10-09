#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  print '请先安装 Node.js 22.13+（含 npm），再重新启动。'
  read '?按回车关闭'
  exit 1
fi
if [[ ! -x work/local-3d/hy3d || ! -f work/local-3d/mlx.metallib || ! -f work/local-3d/weights/model.fp16.safetensors ]]; then
  print '本机 AI 重建依赖不齐：仍会启动工作台，可使用正交轮廓模式、正面图纸或导入 GLB。'
  print '单图 AI 重建需要 hy3d、mlx.metallib 和 model.fp16.safetensors。'
fi
print '启动后请打开 http://127.0.0.1:3000（也可用 http://localhost:3000）；保持这个窗口开启。'
print '服务仅绑定本机；若 3000 端口已占用会提示错误，不会自动换端口。'
npm run local
