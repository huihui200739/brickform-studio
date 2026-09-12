#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if [[ ! -f work/local-3d/hy3d || ! -f work/local-3d/weights/model.fp16.safetensors ]]; then
  print '本地重建模型尚未安装完成，请先完成安装。'
  read '?按回车关闭'
  exit 1
fi
print '启动后请打开 http://localhost:3000；保持这个窗口开启。'
npm run local
