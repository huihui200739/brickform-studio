import {
  inventory,
  PALETTE,
  PARTS,
  type Brick,
  type Model,
} from './brick-engine.ts';
import { assemblyDiagram, orientationLabel } from './assembly-diagram.ts';
import {
  stageBricks,
  cleanStageName,
  partThumbnail,
  detailDiagram,
  installationText,
  gridAddress,
  topDiagram,
} from './build-instructions.ts';
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
    .flatMap((s, i) => {
      const batch = stageBricks(model, i),
        pages: string[] = [];
      pages.push(
        `<section class="page"><header>BRICKFORM / 本组总览 <span>${esc(model.name)}</span></header><h2>${String(i + 1).padStart(2, '0')} · ${esc(cleanStageName(s.name))}</h2><p>本组共 ${batch.length} 块，先备好下列零件，再按下一页逐块安装。图中数字对应本组的安装顺序。</p><div class="diagram group-map">${topDiagram(model, i, batch.length - 1, true)}</div><p class="group-intro">↑ 前方是鸭嘴方向。字母从左向右，数字从后向前。定位格取零件的左后角；侧装件请看后面的局部图。</p><table><thead><tr><th>零件</th><th>颜色 / 编号</th><th>准备数量</th></tr></thead><tbody>${inventory(
          batch,
        )
          .map(
            (p) =>
              `<tr><td>${esc(PARTS[p.part])}</td><td>${PALETTE[p.color].name} · ${p.part}</td><td>× ${p.quantity}</td></tr>`,
          )
          .join('')}</tbody></table></section>`,
      );
      for (let offset = 0; offset < batch.length; offset += 4) {
        const group = batch.slice(offset, offset + 4);
        pages.push(
          `<section class="page instruction-page"><header>BRICKFORM / 跟着拼 <span>${esc(model.name)}</span></header><h2>${String(i + 1).padStart(2, '0')} · ${esc(cleanStageName(s.name))}</h2><p class="group-intro">第 ${i + 1} / ${a.steps.length} 组 · 本页安装第 ${offset + 1}–${offset + group.length} 块（本组共 ${batch.length} 块）<br/>按 ① 拿零件 → ② 对位置 → ③ 按紧的顺序，一块一块完成。彩色零件沿箭头装入橙色虚线位置；灰色是此前已装部分。</p><div class="instruction-grid">${group.map((b, j) => `<article class="instruction-card"><h3>第 ${offset + j + 1} 块 <small>□ 已装好</small></h3><div class="instruction-pick"><div>${partThumbnail(b)}</div><span><b>${esc(PARTS[b.part])} × 1</b><small>${PALETTE[b.color].name} · ${b.part}</small></span></div><div class="placement-diagram">${detailDiagram(model, i, offset + j)}</div><p>${esc(installationText(model, b))}</p><table><tbody><tr><td>#${b.id} · ${b.part}</td><td>${esc(gridAddress(model, b))}</td></tr><tr><td colspan="2">${orientationLabel(b)}</td></tr></tbody></table></article>`).join('')}</div><footer>局部放大示意，省略远处零件及底部空腔。定位格字母向右、数字向前；前方是鸭嘴方向。完整定位网格见本组总览页。</footer></section>`,
        );
      }
      return pages;
    })
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(model.name)} · 拼装说明书</title><style>*{box-sizing:border-box}body{margin:0;background:#edf1f5;color:#233342;font:14px Arial,'PingFang SC',sans-serif}.page{max-width:840px;margin:24px auto;padding:34px;background:white;break-before:page}header{border-bottom:1px solid #dde4ea;padding-bottom:12px;font:11px monospace;letter-spacing:1px}header span{float:right}h1{font-size:36px;margin:40px 0 18px}h2{font-size:25px}p{line-height:1.8;color:#526372}.diagram{max-width:600px;margin:16px auto}.diagram svg{width:100%;max-height:310px}table{border-collapse:collapse;width:100%;font-size:12px}td,th{padding:7px 5px;text-align:left;border-bottom:1px solid #dfe6ed}td small{display:block;font-size:10px;color:#6a7985}footer{margin-top:18px;font-size:11px;line-height:1.7;color:#6a7985}button{display:block;margin:20px auto;padding:12px 24px;border:0;border-radius:8px;background:#17664b;color:white;cursor:pointer}.note{padding:18px;background:#f0f5f2;line-height:1.8}.instruction-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.instruction-card{border:1px solid #dbe4e9;border-radius:8px;padding:12px;break-inside:avoid}.instruction-card h3{font-size:16px;margin:0 0 10px}.instruction-card h3 small{float:right;font-size:10px;color:#6a7b85;font-weight:400}.instruction-pick{display:flex;gap:8px;align-items:center}.instruction-pick>div{width:72px;height:52px;flex-shrink:0}.instruction-pick svg{width:100%;height:100%}.instruction-pick b{font-size:12px}.instruction-pick small{display:block;color:#6a7b85;font-size:10px;margin-top:4px}.placement-diagram{height:170px;margin:8px 0}.placement-diagram svg{width:100%;height:100%}.instruction-card p{font-size:11px;line-height:1.65;margin:6px 0}.instruction-card td{font-size:10px;padding:4px}.group-map svg{max-height:390px}.group-intro{font-size:12px;margin:10px 0 16px}.instruction-page h2{font-size:22px;margin:15px 0 8px}@page{size:A4;margin:12mm}@media print{body{background:white}.page{margin:0;padding:8px}button{display:none}tr{break-inside:avoid}.instruction-page{padding:4px}.placement-diagram{height:145px}.instruction-card{padding:9px}.instruction-card p{font-size:10px}.diagram svg{max-height:255px}.group-map svg{max-height:400px}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body><button onclick="window.print()">打印 / 另存为 PDF</button><section class="page"><header>BRICKFORM / BUILDING GUIDE</header><h1>${esc(model.name)}</h1><p>${model.bricks.length} 块零件 · ${new Set(model.bricks.map((b) => b.part)).size} 种零件 · ${a.steps.length} 个步骤<br/>${(model.width * 8).toFixed(1)} × ${(model.depth * 8).toFixed(1)} × ${(model.height * 3.2).toFixed(1)} mm（外包尺寸，不含凸点）</p><div class="diagram">${assemblyDiagram(
    model,
    a.steps.length - 1,
    model.bricks.map((b) => b.id),
  )}</div><div class="note">${esc(a.reference)}<br/>已检查零件外包框、凸点连接与步骤依赖。侧向零件按所列方向安装。未做受力仿真或实物试拼；零件与颜色组合、在售情况需购买前核对。</div><h2>先读这三个提示</h2><p>1. 每张小图只新增一块零件；其他彩色零件要等后面的图。<br/>2. 左侧零件小图用于找零件，安装姿态以局部放大图为准。<br/>3. 顶装向下按，眼睛和翅膀等侧装件从侧面按入。完成一块后勾选“已装好”。</p><h2>搭建顺序</h2><p>${a.steps.map((s, i) => `${i + 1}. ${esc(s.name)}`).join(' → ')}</p></section><section class="page"><header>BRICKFORM / PARTS LIST</header><h2>完整零件清单</h2><table><thead><tr><th>设计编号</th><th>名称</th><th>颜色 / LEGO 色号</th><th>数量</th></tr></thead><tbody>${inventory(
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
