import {
  inventory,
  PALETTE,
  PARTS,
  type Brick,
  type Model,
} from './brick-engine.ts';
import { assemblyDiagram, orientationLabel } from './assembly-diagram.ts';
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
export function layerSVG(model: Model, layer: number, highlight?: number[]) {
  if (model.assembly) return assemblyDiagram(model, layer, highlight);
  const unit = 24,
    pad = 28;
  const elevation = model.levels[layer];
  const parts = model.bricks.filter((b) => b.y === elevation);
  const previous = model.bricks.filter(
    (b) => b.y < elevation && b.y + b.h >= elevation,
  );
  const shape = (b: Brick, previous = false) => {
    const active = !highlight || highlight.includes(b.id);
    return `<g opacity="${previous ? 0.16 : active ? 1 : 0.23}"><rect x="${pad + b.x * unit + 1}" y="${pad + b.z * unit + 1}" width="${b.w * unit - 2}" height="${b.d * unit - 2}" rx="2" fill="${PALETTE[b.color].hex}" stroke="#627067" stroke-width="1"/>${!previous ? `<text x="${pad + (b.x + b.w / 2) * unit}" y="${pad + (b.z + b.d / 2) * unit + 3}" text-anchor="middle" font-family="Arial" font-size="${b.w * b.d === 1 ? 8 : 10}" fill="${[1, 2, 4, 5].includes(b.color) ? 'white' : '#253b2a'}">${b.id}</text>` : ''}</g>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${model.width * unit + pad * 2} ${model.depth * unit + pad * 2}" role="img" aria-label="第 ${layer + 1} 层俯视图，数字为零件序号"><rect width="100%" height="100%" fill="#f6f8f5"/>${Array.from({ length: model.width }, (_, i) => `<text x="${pad + (i + 0.5) * unit}" y="17" text-anchor="middle" font-size="9" fill="#68766c">${i + 1}</text>`).join('')}${Array.from({ length: model.depth }, (_, i) => `<text x="15" y="${pad + (i + 0.5) * unit + 3}" text-anchor="middle" font-size="9" fill="#68766c">${i + 1}</text>`).join('')}${previous.map((b) => shape(b, true)).join('')}${parts.map((b) => shape(b)).join('')}</svg>`;
}
export function download(
  content: string,
  name: string,
  type = 'text/plain;charset=utf-8',
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function csv(model: Model) {
  return (
    '\uFEFF设计编号,零件名称,乐高颜色编号,颜色,数量\r\n' +
    inventory(model.bricks)
      .map(
        (i) =>
          `${i.part},${PARTS[i.part]},${PALETTE[i.color].lego},${PALETTE[i.color].name},${i.quantity}`,
      )
      .join('\r\n')
  );
}
export function manualHTML(model: Model) {
  if (model.assembly) return assemblyManual(model);
  const rows = (bricks: Brick[]) =>
    bricks
      .map(
        (b) =>
          `<tr><td>#${b.id}</td><td>${b.part} · ${PARTS[b.part]}</td><td>${PALETTE[b.color].name}${b.support ? '（支撑）' : ''}</td><td>X ${b.x + 1} / Z ${b.z + 1}</td><td>${b.w} × ${b.d}</td></tr>`,
      )
      .join('');
  let pages = '';
  let step = 0;
  for (let layerIndex = 0; layerIndex < model.levels.length; layerIndex++) {
    const y = model.levels[layerIndex];
    const layer = model.bricks.filter((b) => b.y === y);
    for (let offset = 0; offset < layer.length; offset += 18) {
      const batch = layer.slice(offset, offset + 18);
      pages += `<section class="page"><header>BRICKFORM / BUILDING GUIDE <span>${esc(model.name)}</span></header><h2>步骤 ${String(++step).padStart(2, '0')} <small>第 ${layerIndex + 1} 组 · 本步 ${batch.length} 块</small></h2><p>从上方观察，X 从左向右、Z 从上向下。按编号安装本步亮色零件；浅色为参考零件。底座前两层完成后连为整体。</p><div class="diagram">${layerSVG(
        model,
        layerIndex,
        batch.map((b) => b.id),
      )}</div><table><thead><tr><th>序号</th><th>零件</th><th>颜色</th><th>左上角坐标</th><th>X × Z 凸点</th></tr></thead><tbody>${rows(batch)}</tbody></table><footer>本组安装基准高度 ${(y * 3.2).toFixed(1)} mm · 薄板高 3.2 mm / 砖块高 9.6 mm · 凸点间距 8 mm</footer></section>`;
    }
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(model.name)} · Brickform 拼装说明书</title><style>*{box-sizing:border-box}body{font:14px Arial,'PingFang SC',sans-serif;color:#24362b;background:#edf1eb;margin:0}.page{background:white;max-width:820px;margin:25px auto;padding:44px;break-after:page}header{font:11px monospace;letter-spacing:2px;border-bottom:1px solid #d6dfd6;padding-bottom:15px}header span{float:right;letter-spacing:0}h1{font-size:40px;margin:60px 0 22px}h2{font-size:26px}small{font-size:13px;font-weight:400;margin-left:15px;color:#69776b}p{line-height:1.8;color:#647266}.diagram{max-width:650px;margin:20px auto}.diagram svg{width:100%;max-height:280px}table{width:100%;border-collapse:collapse;font-size:12px}td,th{text-align:left;padding:7px;border-bottom:1px solid #e1e7e0}footer{margin-top:25px;font-size:11px;color:#69776b}.notice{padding:20px;background:#f3f6ef;margin:25px 0;line-height:1.8}button{display:block;margin:20px auto;padding:12px 24px;background:#2b674f;color:white;border:0;border-radius:6px;cursor:pointer}@page{size:A4;margin:12mm}@media print{body{background:white}.page{margin:0;padding:12px;max-width:none}button{display:none}.diagram svg{max-height:230px}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}tr{break-inside:avoid}}</style></head><body><button onclick="window.print()">打印 / 另存为 PDF</button><section class="page"><header>BRICKFORM / BUILDING GUIDE</header><h1>${esc(model.name)}<br/>拼装说明书</h1><p>${model.bricks.length} 块积木 · ${model.levels.length} 组 · ${step} 个步骤<br/>含底座 ${model.width * 8} × ${model.depth * 8} × ${(model.height * 3.2).toFixed(1)} mm（不含凸点）</p><div class="notice">${model.source === 'image' ? '本模型由图片轮廓生成，厚度按所选模式估算；背面与体积未经三维扫描验证。' : '这是参数化小黄鸭示例模型。'}<br/>同色辅助支撑 ${model.supportCount} 块，已包含在清单内。已做网格重叠、下方连接与整体连通检查，未做物理稳定性仿真或实物试拼。基础零件设计编号可核查，具体零件与颜色组合及在售情况请在购买前核对。<br/>请先摆好底座第一层，再用第二层连接。按图中凸点坐标向上拼搭。</div><h2>完整零件清单</h2><table><thead><tr><th>设计编号</th><th>名称</th><th>颜色 / LEGO 颜色编号</th><th>数量</th></tr></thead><tbody>${inventory(
    model.bricks,
  )
    .map(
      (i) =>
        `<tr><td>${i.part}</td><td>${PARTS[i.part]}</td><td>${PALETTE[i.color].name} / ${PALETTE[i.color].lego}</td><td>${i.quantity}</td></tr>`,
    )
    .join(
      '',
    )}</tbody></table><footer>独立设计工具，与 LEGO Group 无关联或认证。<br/>零件核对：<a href="https://www.lego.com/en-us/pick-and-build/pick-a-brick">LEGO Pick a Brick</a></footer></section>${pages}</body></html>`;
}

function assemblyManual(model: Model) {
  const a = model.assembly!;
  const pages = a.steps
    .map((s, i) => {
      const batch = model.bricks.filter((b) => b.step === i);
      return `<section class="page"><header>BRICKFORM / BUILDING GUIDE <span>${esc(model.name)}</span></header><h2>${String(i + 1).padStart(2, '0')} · ${esc(s.name)}</h2><p>${esc(s.description)} 彩色是本步新增零件，灰色是已搭建部分。图为简化外形示意，3D 与 LDraw 文件使用完整零件几何。</p><div class="diagram">${assemblyDiagram(model, i)}</div><table><thead><tr><th>序号 / 零件</th><th>颜色</th><th>定位 X / Z</th><th>底部高度</th><th>安装方向</th></tr></thead><tbody>${batch.map((b) => `<tr><td>#${b.id} · ${b.part}<small>${esc(PARTS[b.part])}</small></td><td>${PALETTE[b.color].name}</td><td>${(b.x + 1).toFixed(2)} / ${(b.z + 1).toFixed(2)}</td><td>${(b.y * 3.2).toFixed(1)} mm</td><td>${orientationLabel(b)}</td></tr>`).join('')}</tbody></table><footer>坐标取零件外包框左后角；X 向右，Z 向前（鸭嘴方向）；1 格 = 8 mm。侧装件底部高度为外包框最低点。</footer></section>`;
    })
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(model.name)} · 拼装说明书</title><style>*{box-sizing:border-box}body{margin:0;background:#edf1f5;color:#233342;font:14px Arial,'PingFang SC',sans-serif}.page{max-width:840px;margin:24px auto;padding:34px;background:white;break-before:page}header{border-bottom:1px solid #dde4ea;padding-bottom:12px;font:11px monospace;letter-spacing:1px}header span{float:right}h1{font-size:36px;margin:40px 0 18px}h2{font-size:25px}p{line-height:1.8;color:#526372}.diagram{max-width:600px;margin:16px auto}.diagram svg{width:100%;max-height:310px}table{border-collapse:collapse;width:100%;font-size:12px}td,th{padding:7px 5px;text-align:left;border-bottom:1px solid #dfe6ed}td small{display:block;font-size:10px;color:#6a7985}footer{margin-top:18px;font-size:11px;line-height:1.7;color:#6a7985}button{display:block;margin:20px auto;padding:12px 24px;border:0;border-radius:8px;background:#17664b;color:white;cursor:pointer}.note{padding:18px;background:#f0f5f2;line-height:1.8}@page{size:A4;margin:12mm}@media print{body{background:white}.page{margin:0;padding:8px}button{display:none}tr{break-inside:avoid}.diagram svg{max-height:255px}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body><button onclick="window.print()">打印 / 另存为 PDF</button><section class="page"><header>BRICKFORM / BUILDING GUIDE</header><h1>${esc(model.name)}</h1><p>${model.bricks.length} 块零件 · ${new Set(model.bricks.map((b) => b.part)).size} 种零件 · ${a.steps.length} 个步骤<br/>${(model.width * 8).toFixed(1)} × ${(model.depth * 8).toFixed(1)} × ${(model.height * 3.2).toFixed(1)} mm（外包尺寸，不含凸点）</p><div class="diagram">${assemblyDiagram(
    model,
    a.steps.length - 1,
    model.bricks.map((b) => b.id),
  )}</div><div class="note">${esc(a.reference)}<br/>已检查零件外包框、凸点连接与步骤依赖。侧向零件按所列方向安装。未做受力仿真或实物试拼；零件与颜色组合、在售情况需购买前核对。</div><h2>搭建顺序</h2><p>${a.steps.map((s, i) => `${i + 1}. ${esc(s.name)}`).join(' → ')}</p></section><section class="page"><header>BRICKFORM / PARTS LIST</header><h2>完整零件清单</h2><table><thead><tr><th>设计编号</th><th>名称</th><th>颜色 / LEGO 色号</th><th>数量</th></tr></thead><tbody>${inventory(
    model.bricks,
  )
    .map(
      (p) =>
        `<tr><td>${p.part}</td><td>${esc(PARTS[p.part])}</td><td>${PALETTE[p.color].name} / ${PALETTE[p.color].lego}</td><td>${p.quantity}</td></tr>`,
    )
    .join(
      '',
    )}</tbody></table><footer>几何来源：LDraw.org 官方零件库（社区维护），原作者与 CC BY 授权见平台零件来源说明。独立设计工具，与 LEGO Group 无关联或认证。</footer></section>${pages}</body></html>`;
}
