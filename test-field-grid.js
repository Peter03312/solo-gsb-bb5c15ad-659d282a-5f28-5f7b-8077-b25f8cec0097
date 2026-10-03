'use strict';

// 单视野网格空间密度纯逻辑自测（npm test）：
// 外接矩形等分、逐格净区域交集面积（含孔洞/非矩形视野）、质心归属唯一格
// （内部网格线归右侧/下侧、最外边线归末格）、零面积格“不可计算”、
// 行列数 1～40 校验、各格细胞合计等于计入视野细胞数、mm² 换算。

const fg = require('./server/field-grid');
const geo = require('./server/geometry');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

const sq = (x, y, w, h = w) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }
];
const tri = (x0, y0, x1, y1, x2, y2) => [{ x: x0, y: y0 }, { x: x1, y: y1 }, { x: x2, y: y2 }];

// ---------- 行列数校验 ----------
for (const v of [1, 40, 2, '3', ' 20 ']) {
  check(`行列数接受 ${JSON.stringify(v)}`, fg.validateGridCount(v, 'cols') === Number(String(v).trim()));
}
for (const v of [0, 41, -1, 1.5, NaN, Infinity, null, undefined, '', 'abc', true, {}, []]) {
  let threw = null;
  try { fg.validateGridCount(v, 'rows'); } catch (e) { threw = e; }
  check(`行列数拒绝 ${JSON.stringify(v)}`, threw && threw.status === 400 && /1～40/.test(threw.message), threw && threw.message);
}

// ---------- 矩形视野 100×200，2 列 × 4 行：每格 50×50 = 2500 px² ----------
{
  const field = { id: 'f1', name: '矩形视野', outer: sq(0, 0, 100, 200), holes: [] };
  const g = fg.buildFieldGrid(field, 0, [], null, 2, 4);
  check('格总数 2×4=8', g.cells.length === 8 && g.cellCountTotal === 8);
  check('每格有效面积 2500 px²', g.cells.every((c) => approx(c.areaPx, 2500)),
    g.cells.map((c) => c.areaPx));
  check('零面积格 0 个', g.zeroAreaCellCount === 0);
  check('各格面积合计 = 视野净面积 20000', approx(g.totalAreaPx, 20000) && approx(g.fieldAreaPx, 20000));
  check('无细胞时合计 0', g.sumCellCount === 0 && g.cellCount === 0 && g.countMatchesFieldStats);
  check('未标定 mm² 为 null、文本待定标',
    g.cells.every((c) => c.areaMm2 === null && c.densityText === '待定标' && c.areaText === '待定标'));
  check('等分线边界', approx(g.bounds.colStep, 50) && approx(g.bounds.rowStep, 50) &&
    g.bounds.linesX.length === 3 && g.bounds.linesY.length === 5 &&
    approx(g.bounds.linesX[2], 100) && approx(g.bounds.linesY[4], 200));
}

// ---------- 带孔洞视野：大矩形 0,0..100,100，孔洞 40,40..60,60；2×2 ----------
// 孔洞居中 20×20=400，每格扣 100：每格 2500-100=2400；总 10000-400=9600
{
  const field = {
    id: 'f2', name: '带孔视野',
    outer: sq(0, 0, 100),
    holes: [sq(40, 40, 20)]
  };
  const g = fg.buildFieldGrid(field, 1, [], 1, 2, 2); // scale=1 μm/px → mm² = px²/1e6
  check('带孔每格 2400 px²', g.cells.every((c) => approx(c.areaPx, 2400)),
    g.cells.map((c) => c.areaPx));
  check('带孔合计 9600', approx(g.totalAreaPx, 9600) && approx(g.fieldAreaPx, 9600));
  check('mm² 换算 ×1e-6', g.cells.every((c) => approx(c.areaMm2, 0.0024)));
  check('全视野密度 = 细胞数/0.0096', approx(g.fieldDensityPerMm2, 0) && g.fieldDensityText === '0');
}

// ---------- 孔洞在角格：只扣一个格子 ----------
{
  const field = { id: 'f3', outer: sq(0, 0, 100), holes: [sq(0, 0, 10)] };
  const g = fg.buildFieldGrid(field, 0, [], null, 2, 2);
  const byRC = (r, c) => g.cells[(r - 1) * 2 + (c - 1)];
  check('角格扣孔 2400', approx(byRC(1, 1).areaPx, 2400), byRC(1, 1).areaPx);
  check('其余三格 2500',
    approx(byRC(1, 2).areaPx, 2500) && approx(byRC(2, 1).areaPx, 2500) && approx(byRC(2, 2).areaPx, 2500));
  check('合计 9900', approx(g.totalAreaPx, 9900));
}

// ---------- 非矩形（三角形）视野 + 角落零面积格 ----------
// 三角形 (0,0),(100,0),(100,100)（区域 x≥y）：外接矩形 100×100；2×2 网格：
// 格按行优先（y 向下）：(行1,列1) 左上 1250；(行1,列2) 右上 2500；
// (行2,列1) 左下 0（y>x 全在区域外）；(行2,列2) 右下 1250；总 5000
{
  const field = { id: 'f4', name: '三角', outer: tri(0, 0, 100, 0, 100, 100), holes: [] };
  const g = fg.buildFieldGrid(field, 0, [], null, 2, 2);
  const a = g.cells.map((c) => Math.round(c.areaPx));
  check('三角形各格面积 1250/2500/0/1250',
    JSON.stringify(a) === JSON.stringify([1250, 2500, 0, 1250]), a);
  check('零面积格保留且密度不可计算',
    g.cells[2].computable === false && g.cells[2].densityText === '不可计算' &&
    g.cells[2].cellCount === 0 && g.zeroAreaCellCount === 1);
  check('三角形各格合计 = 净面积 5000', approx(g.totalAreaPx, 5000) && approx(g.fieldAreaPx, 5000));
}

// ---------- 质心归属唯一格；内部网格线归右侧/下侧；最外边线归末格 ----------
{
  // gridIndex 直接验证（100 宽，4 列，步长 25）
  check('质心普通位置', fg.gridIndex(10, 0, 25, 4) === 0);
  check('内部网格线 x=25 归右侧格(列2, 索引1)', fg.gridIndex(25, 0, 25, 4) === 1);
  check('内部网格线 x=50 归右侧格(索引2)', fg.gridIndex(50, 0, 25, 4) === 2);
  check('最外边线 x=100 归末格(索引3)', fg.gridIndex(100, 0, 25, 4) === 3);
  check('微小负向数值夹到首格', fg.gridIndex(-1e-12, 0, 25, 4) === 0);
  check('y 同理：内部线归下侧', fg.gridIndex(50, 10, 20, 4) === 2);
  check('1×1 网格任何点都归唯一格', fg.gridIndex(0, 5, 10, 1) === 0 && fg.gridIndex(15, 5, 10, 1) === 0);
}

// ---------- 端到端归属：矩形视野 0,0..100,100，2×2，细胞按质心落格 ----------
{
  const field = { id: 'f5', outer: sq(0, 0, 100), holes: [] };
  // 10×10 小方块细胞，质心即方块中心
  const cells = [
    { id: 'a', name: 'a', outer: sq(10, 10, 10), holes: [] },   // 质心 (15,15) → (行1,列1)
    { id: 'b', name: 'b', outer: sq(60, 10, 10), holes: [] },   // (65,15) → (1,2)
    { id: 'c', name: 'c', outer: sq(10, 60, 10), holes: [] },   // (15,65) → (2,1)
    { id: 'd1', name: 'd1', outer: sq(60, 60, 10), holes: [] },// (65,65) → (2,2)
    { id: 'd2', name: 'd2', outer: sq(80, 80, 10), holes: [] },// (85,85) → (2,2)
    { id: 'out', name: 'out', outer: sq(150, 150, 10), holes: [] } // 质心在视野外，不计入
  ];
  // 质心精确落在内部网格线 (50,50) 的细胞：方块 45..55，中心 (50,50) → 归 (2,2)
  cells.push({ id: 'edge', name: 'edge', outer: sq(45, 45, 10), holes: [] });
  const g = fg.buildFieldGrid(field, 0, cells, 1, 2, 2);
  const m = Object.fromEntries(g.cells.map((c) => [`${c.row}-${c.col}`, c]));
  check('(1,1)=1', m['1-1'].cellCount === 1 && m['1-1'].cellKeys.join() === 'a');
  check('(1,2)=1', m['1-2'].cellCount === 1 && m['1-2'].cellKeys.join() === 'b');
  check('(2,1)=1', m['2-1'].cellCount === 1 && m['2-1'].cellKeys.join() === 'c');
  check('(2,2)=3（含网格线归右下）', m['2-2'].cellCount === 3 &&
    m['2-2'].cellKeys.slice().sort().join() === ['d1', 'd2', 'edge'].sort().join(), m['2-2'].cellKeys);
  check('视野外细胞不计入', g.cellCount === 6 && !g.countedCellKeys.includes('out'));
  check('各格合计 = 计入视野细胞数 6', g.sumCellCount === 6 && g.countMatchesFieldStats);
  // 密度：每格 2500 px² = 0.0025 mm² → (2,2) 密度 3/0.0025 = 1200
  check('(2,2) 密度 1200 个/mm²', approx(m['2-2'].densityPerMm2, 1200) && m['2-2'].densityText === '1200');
}

// ---------- 视野孔洞内的细胞：质心不计入（沿用既有规则） ----------
{
  const field = { id: 'f6', outer: sq(0, 0, 100), holes: [sq(40, 40, 20)] };
  const cells = [
    { id: 'inhole', name: 'inhole', outer: sq(45, 45, 10), holes: [] }, // 质心 (50,50) 在孔洞内
    { id: 'ok', name: 'ok', outer: sq(5, 5, 10), holes: [] }
  ];
  const g = fg.buildFieldGrid(field, 0, cells, 1, 2, 2);
  check('孔洞内细胞不计入网格', g.cellCount === 1 && g.countedCellKeys.join() === 'ok');
  // 孔洞横跨 4 格，质心 (50,50) 即使被分配也应因点在孔洞内而整体排除
  check('合计仍一致', g.sumCellCount === 1 && g.countMatchesFieldStats);
}

// ---------- 质心在最外边线：夹到末格；计数不漏不重 ----------
{
  // 用极窄矩形细胞无法让质心恰好压在外接矩形边线（质心在细胞内部，细胞严格在视野内），
  // 直接验证 gridIndex 末格行为已覆盖；这里验证总分配为划分（互斥且穷尽计入细胞）。
  const field = { id: 'f7', outer: sq(0, 0, 40), holes: [] };
  const cells = [];
  // 40 个 1×1 细胞铺满 0..40 网格点中心 0.5..39.5（4×4 各格 100 个位置过多，
  // 改为每行每列一个代表点），4 列步长 10：中心 5,15,25,35 → 列 0..3 各一个
  for (let i = 0; i < 4; i++) {
    cells.push({ id: `x${i}`, outer: sq(5 + i * 10 - 0.5, 5 - 0.5, 1), holes: [] });
  }
  const g = fg.buildFieldGrid(field, 0, cells, 1, 4, 1);
  check('单行 4 列各 1 个', g.cells.map((c) => c.cellCount).join() === '1,1,1,1',
    g.cells.map((c) => c.cellCount));
}

// ---------- 非 0 起点外接矩形 ----------
{
  const field = { id: 'f8', outer: sq(200, 300, 80, 40), holes: [] };
  const g = fg.buildFieldGrid(field, 0, [], null, 2, 2);
  check('外接矩形起点保留', g.bounds.minX === 200 && g.bounds.minY === 300 &&
    approx(g.bounds.maxX, 280) && approx(g.bounds.maxY, 340));
  check('步长 40×20', approx(g.bounds.colStep, 40) && approx(g.bounds.rowStep, 20));
  check('每格 800 px²', g.cells.every((c) => approx(c.areaPx, 800)));
  // 质心 (240,320) 压内部十字线 → (行2, 列2)
  check('非原点网格线归右下', fg.gridIndex(240, 200, 40, 2) === 1 && fg.gridIndex(320, 300, 20, 2) === 1);
}

// ---------- 零面积格有细胞时仍计数、密度不可计算（防御：孔洞内质心已排除，
//            此处用三角形斜边零面积格——细胞无法以质心落入零面积开区域，
//            故只验证面积为 0 时密度文本规则） ----------
{
  const field = { id: 'f9', outer: tri(0, 0, 100, 0, 100, 100), holes: [] };
  const g = fg.buildFieldGrid(field, 0, [], 2, 2, 2);
  const zero = g.cells.find((c) => !c.computable);
  check('零面积格 densityPerMm2=null', zero && zero.densityPerMm2 === null);
  check('已定标零面积格仍标不可计算（非待定标）', zero && zero.densityText === '不可计算');
}

if (failures) { console.error(`\n${failures} 项失败 ✖`); process.exit(1); }
console.log('\n单视野网格空间密度纯逻辑自测全部通过 ✔');
