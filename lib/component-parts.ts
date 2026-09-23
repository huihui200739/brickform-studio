import {
  ASSEMBLY_PARTS,
  IDENTITY,
  add,
  multiply,
  rotate,
  transform,
  worldPoint,
  type M3,
  type V3,
} from './assembly-catalog.ts';
import { SPECIAL_DATA } from './special-part-data.ts';
import { SPECIAL_PORTS } from './special-connectors.ts';
import type { Brick } from './brick-engine.ts';
import type { ComponentKind } from './semantic-components.ts';
const rx = (degree: number): M3 => {
  const c = Math.cos((degree * Math.PI) / 180),
    s = Math.sin((degree * Math.PI) / 180);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};
const rz = (degree: number): M3 => {
  const c = Math.cos((degree * Math.PI) / 180),
    s = Math.sin((degree * Math.PI) / 180);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
export function componentBricks(kind: ComponentKind): Brick[] {
  const bricks: Brick[] = [];
  function put(
    part: string,
    color: number,
    position: V3,
    matrix: M3,
    installation: string,
  ) {
    const b: Brick = {
      id: bricks.length + 1,
      part,
      color,
      pose: { position, matrix },
      x: 0,
      y: 0,
      z: 0,
      w: 0,
      h: 0,
      d: 0,
      installation,
    };
    bricks.push(b);
    return b;
  }
  function attach(
    parent: Brick,
    parentPort: number,
    part: string,
    childPort: number,
    color: number,
    matrix: M3,
    text: string,
  ) {
    const at = worldPoint(
      parent.pose!,
      SPECIAL_PORTS[parent.part][parentPort].point,
    );
    return put(
      part,
      color,
      at.map(
        (v, i) =>
          v - transform(matrix, SPECIAL_PORTS[part][childPort].point)[i],
      ) as V3,
      matrix,
      text,
    );
  }
  // Standard 2 x 2 mounting plate is counted and installed first.
  put(
    '3022',
    7,
    [0, -8, 0],
    IDENTITY,
    '把这块 2 × 2 薄板安装在标记的四个凸点上，作为组件底座。',
  );
  if (kind === 'tree') {
    const jumper = put(
      '87580',
      7,
      [0, -16, 0],
      IDENTITY,
      '把中心单凸点薄板扣在底板上，树干将安装在正中央。',
    );
    let trunk = attach(
      jumper,
      4,
      '3062b',
      0,
      9,
      IDENTITY,
      '将圆砖接在正中央的凸点上，作为树干。',
    );
    for (let i = 0; i < 2; i++)
      trunk = attach(
        trunk,
        1,
        '3062b',
        0,
        9,
        IDENTITY,
        '把下一节圆砖接在树干顶端，保持垂直。',
      );
    let leaf = attach(
      trunk,
      1,
      '2423',
      0,
      5,
      rotate(0),
      '将枝叶片根部的圆孔扣在树干顶部，枝叶朝后伸出。',
    );
    for (let i = 1; i < 4; i++)
      leaf = attach(
        leaf,
        1,
        '2423',
        0,
        5,
        rotate(i),
        `在上一片枝叶根部继续叠一片，转向${['', '左', '前', '右'][i]}，形成展开的树冠。`,
      );
  } else if (kind === 'brazier') {
    const jumper = put(
      '87580',
      1,
      [0, -16, 0],
      IDENTITY,
      '把中心单凸点薄板装在底板上，让火盆位于正中央。',
    );
    const dish = attach(
      jumper,
      4,
      '4740',
      0,
      1,
      IDENTITY,
      '将黑色碟形件中心的底孔扣在中央凸点上。',
    );
    const holder = attach(
      dish,
      1,
      '85861',
      0,
      1,
      IDENTITY,
      '把空心凸点圆板接到碟形件中央，为火焰预留插孔。',
    );
    attach(
      holder,
      2,
      '6126b',
      0,
      6,
      rx(90),
      '握住火焰底部，将短插杆插入中央圆孔。火尖向上；不要按压细长火尖。',
    );
  } else {
    const right = put(
      '3816c',
      11,
      [0, -36, -8.75],
      IDENTITY,
      '人物面向前方。将右脚底部的孔对准底板左后凸点；腿部通常随髋部成套购买，不建议拆卸已装好的关节。',
    );
    const hips = attach(
      right,
      1,
      '3815b',
      0,
      11,
      IDENTITY,
      '将髋部与右腿关节对齐；若使用已组装腿部，可连同下一块一起完成。',
    );
    attach(
      hips,
      1,
      '3817c',
      1,
      11,
      IDENTITY,
      '安装另一条腿，两只脚平齐，分别接到底板的两个凸点上。',
    );
    const torso = attach(
      hips,
      2,
      '973',
      0,
      11,
      IDENTITY,
      '将躯干底部套在髋部上，肩部在上方，人物面向前方。',
    );
    const armR = attach(
      torso,
      2,
      '3818',
      0,
      11,
      rz(9.792),
      '对齐人物右肩安装右臂。已带手臂的躯干可保持原装。',
    );
    const armL = attach(
      torso,
      3,
      '3819',
      0,
      11,
      rz(-9.792),
      '对齐人物左肩安装左臂，两臂自然垂下。',
    );
    const handR = attach(
      armR,
      1,
      '3820',
      0,
      11,
      multiply(rz(9.792), rx(45)),
      '将右手的短轴对准右臂末端孔，握口朝向前方。',
    );
    const handL = attach(
      armL,
      1,
      '3820',
      0,
      11,
      multiply(rz(-9.792), rx(45)),
      '将左手的短轴装入左臂，握口朝向前方。',
    );
    const head = attach(
      torso,
      1,
      '3626c',
      0,
      11,
      IDENTITY,
      '把无印刷灰色头部套在颈部圆柱上，作为石雕头部。',
    );
    attach(
      head,
      1,
      '3844',
      0,
      11,
      IDENTITY,
      '把头盔套在头部上，面部开口朝前。',
    );
    attach(
      handR,
      1,
      '4497',
      0,
      11,
      IDENTITY,
      '将长矛杆扣入右手握口，尖端朝上。可轻转手臂调整方向。',
    );
    attach(
      handL,
      1,
      '3846',
      0,
      11,
      IDENTITY,
      '将盾牌背面的握柄扣入左手，盾面朝前。检查配件与建筑之间留有间隙。',
    );
  }
  return bricks;
}
