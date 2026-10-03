'use strict';

// 已发布报告 · 单取样视野网格空间密度（只读）
//
// 选定一份报告冻结的取样视野与其外接矩形的行列划分（各 1～40）：
//   - 外接矩形按列数/行数等分为 cols×rows 个格子；
//   - 每格有效面积 = 格子矩形与视野【净区域】（外环扣除孔洞）的几何交集面积，
//     采用 Sutherland–Hodgman 逐边半平面裁剪精确计算（外环与每个孔洞分别裁剪后相减）；
//   - 零面积格保留在结果中，密度标为“不可计算”；
//   - 细胞沿用既有净区域质心归属规则：仅【计入该视野】的细胞才参与网格分配，
//     每只细胞按其净区域质心落到唯一格子；质心落在内部网格线上归右侧/下侧，
//     落在最外边线归末格；
//   - 各格细胞数合计恒等于该视野发布时冻结的细胞数（与原视野统计一致）。
//
// 结果同时给出像素与平方毫米有效面积、细胞数、每 mm² 密度。
// 物理换算只用报告冻结标尺；模块本身不接触数据库，冻结性由接口层保证。

const geo = require('./geometry');
const fieldsSvc = require('./fields');
const mergeSvc = require('./merge-stats');

const EPS = 1e-9;
const MIN_GRID = 1;
const MAX_GRID = 40;
const NOT_COMPUTABLE = '不可计算';

// ---------- 行列数校验（各 1～40；数值字符串按数值接受） ----------

function validateGridCount(raw, which) {
  const label = which === 'cols' ? '列数 cols' : '行数 rows';
  if (typeof raw === 'string' && raw.trim() !== '') raw = Number(raw.trim());
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw { status: 400, message: `网格划分无效：${label} 必须是 ${MIN_GRID}～${MAX_GRID} 的整数（收到 ${JSON.stringify(raw)}）` };
  }
  if (!Number.isInteger(raw) || raw < MIN_GRID || raw > MAX_GRID) {
    throw { status: 400, message: `网格划分无效：${label} 必须是 ${MIN_GRID}～${MAX_GRID} 之间的整数（收到 ${raw}），请求被拒绝` };
  }
  return raw;
}

// 视野标识解析复用单视野覆盖核对的同一规则：id 精确优先，其次名称精确匹配，
// 重名报错提示改用 id；不存在/为空抛错（由接口层返回 400）。
function resolveField(fields, identifier) {
  return mergeSvc.resolveFieldIdentifier(fields, identifier);
}

// ---------- Sutherland–Hodgman 多边形逐边裁剪 ----------
//
// 把凸裁剪矩形的四条边依次作为半平面，对被裁剪多边形逐边求交。
// 外环与每个孔洞各自独立裁剪；被裁剪多边形可以非凸、可以在裁剪后变成多段，
// 连接段沿裁剪边界走，对【有向面积】求和的贡献为零，不影响面积结果。

function clipConvexHalfPlane(poly, inside, intersect) {
  if (poly.length === 0) return [];
  const out = [];
  let prev = poly[poly.length - 1];
  let prevIn = inside(prev);
  for (const cur of poly) {
    const curIn = inside(cur);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
    prev = cur;
    prevIn = curIn;
  }
  return out;
}

// 轴对齐矩形 [x0,x1]×[y0,y1] 裁剪环（点数组，首尾不重复），返回裁剪后的顶点环
function clipRingByRect(ring, x0, y0, x1, y1) {
  let poly = ring;
  // 左：x >= x0
  poly = clipConvexHalfPlane(
    poly,
    (p) => p.x >= x0 - EPS,
    (a, b) => { const t = (x0 - a.x) / (b.x - a.x); return { x: x0, y: a.y + t * (b.y - a.y) }; });
  if (!poly.length) return poly;
  // 右：x <= x1
  poly = clipConvexHalfPlane(
    poly,
    (p) => p.x <= x1 + EPS,
    (a, b) => { const t = (x1 - a.x) / (b.x - a.x); return { x: x1, y: a.y + t * (b.y - a.y) }; });
  if (!poly.length) return poly;
  // 上（图像坐标 y 向下，y0 为上边）：y >= y0
  poly = clipConvexHalfPlane(
    poly,
    (p) => p.y >= y0 - EPS,
    (a, b) => { const t = (y0 - a.y) / (b.y - a.y); return { x: a.x + t * (b.x - a.x), y: y0 }; });
  if (!poly.length) return poly;
  // 下：y <= y1
  poly = clipConvexHalfPlane(
    poly,
    (p) => p.y <= y1 + EPS,
    (a, b) => { const t = (y1 - a.y) / (b.y - a.y); return { x: a.x + t * (b.x - a.x), y: y1 }; });
  return poly;
}

// 环的有向面积（顶点序 CCW 为正）
function ringSignedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

// 一个格子矩形与视野净区域（外环扣除孔洞）的交集面积（像素²，非负）。
// 外环与每个孔洞分别裁剪到格子矩形：净面积 = |裁剪外环面积| − Σ|裁剪孔洞面积|。
function rectNetIntersectionAreaPx(field, x0, y0, x1, y1) {
  const clippedOuter = clipRingByRect(field.outer, x0, y0, x1, y1);
  if (clippedOuter.length < 3) return 0;
  let area = Math.abs(ringSignedArea(clippedOuter));
  for (const h of field.holes || []) {
    const clippedHole = clipRingByRect(h, x0, y0, x1, y1);
    if (clippedHole.length >= 3) area -= Math.abs(ringSignedArea(clippedHole));
  }
  // 数值噪声夹取：交集面积落在 [0, 格子面积]
  if (area < EPS) area = 0;
  return Math.max(0, area);
}

function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// 质心归属格子索引：
//   等分后第 i 列覆盖 [bounds.minX + i*cw, minX + (i+1)*cw)（行同理）；
//   内部网格线上的点（u 为正数个步长）按 floor 即归到右侧/下侧一格；
//   浮点算出的“差极小量到线”也吸附为落线（+EPS 后再 floor），
//   落在最外边线（或越出极小量）则夹到末格。
function gridIndex(p, min, step, n) {
  const raw = (p - min) / step;
  let idx = Math.floor(raw + EPS);
  if (idx < 0) idx = 0;
  if (idx > n - 1) idx = n - 1;
  return idx;
}

// ---------- 单视野网格密度 ----------
//
// field：已解析的冻结视野；fieldIndex：该视野在报告 fields 中的序号（用于默认名称）；
// cells：报告冻结的全部细胞；scale：冻结标尺 μm/px（未定标传 null）；
// cols/rows：已校验的 1～40 整数。
function buildFieldGrid(field, fieldIndex, cells, scale, cols, rows) {
  const safeCells = Array.isArray(cells) ? cells : [];

  // 外接矩形取视野外环顶点包围盒；等分边界
  const b = ringBBox(field.outer);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const colStep = w / cols;
  const rowStep = h / rows;

  // 各格边界（cols+1 个 x、rows+1 个 y），末格边界钉到外接矩形边线，避免浮点漂移
  const xs = [];
  for (let i = 0; i <= cols; i++) xs.push(i === cols ? b.maxX : b.minX + i * colStep);
  const ys = [];
  for (let j = 0; j <= rows; j++) ys.push(j === rows ? b.maxY : b.minY + j * rowStep);

  // 先按既有净区域质心规则找出【计入该视野】的细胞（与原视野统计完全同源）
  const centroids = fieldsSvc.computeCentroids(safeCells);
  const countedCells = [];
  safeCells.forEach((cell, i) => {
    const ctr = centroids[i];
    if (!ctr) return;
    if (fieldsSvc.pointInFieldNet(ctr, field)) {
      countedCells.push({ cell, index: i, ctr });
    }
  });

  // 计入细胞按质心分配到唯一格子
  const counts = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const assignedKeysByCell = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => []));
  for (const { cell, index, ctr } of countedCells) {
    const ci = gridIndex(ctr.x, b.minX, colStep, cols);
    const rj = gridIndex(ctr.y, b.minY, rowStep, rows);
    counts[rj][ci] += 1;
    assignedKeysByCell[rj][ci].push(fieldsSvc.cellKey(cell, index));
  }

  const calibrated = typeof scale === 'number' && Number.isFinite(scale) && scale > 0;

  // 逐格有效面积与密度（行优先，row 从上到下、col 从左到右）
  let totalAreaPx = 0;
  let totalAreaMm2 = 0;
  const gridCells = [];
  for (let rj = 0; rj < rows; rj++) {
    for (let ci = 0; ci < cols; ci++) {
      const x0 = xs[ci], x1 = xs[ci + 1], y0 = ys[rj], y1 = ys[rj + 1];
      const areaPx = rectNetIntersectionAreaPx(field, x0, y0, x1, y1);
      const areaMm2 = calibrated ? fieldsSvc.px2ToMm2(areaPx, scale) : null;
      const count = counts[rj][ci];
      const computable = areaPx > EPS;
      const densityPerMm2 = calibrated && computable ? count / areaMm2 : null;
      totalAreaPx += areaPx;
      if (areaMm2) totalAreaMm2 += areaMm2;
      gridCells.push({
        row: rj + 1,
        col: ci + 1,
        index: rj * cols + ci,
        rect: { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 },
        areaPx: fieldsSvc.round(areaPx, 3),
        areaMm2: areaMm2 === null ? null : fieldsSvc.round(areaMm2),
        cellCount: count,
        cellKeys: assignedKeysByCell[rj][ci],
        computable,
        densityPerMm2,
        areaText: calibrated ? String(fieldsSvc.round(areaMm2)) : fieldsSvc.PENDING,
        densityText: !computable
          ? NOT_COMPUTABLE
          : calibrated
            ? String(fieldsSvc.round(densityPerMm2, 4))
            : fieldsSvc.PENDING,
        calibrated
      });
    }
  }

  const totalCellCount = countedCells.length;
  const sumCellCount = gridCells.reduce((s, g) => s + g.cellCount, 0);
  const fieldNetAreaPx = Math.abs(geo.signedArea(field.outer)) -
    (field.holes || []).reduce((s, hh) => s + Math.abs(geo.signedArea(hh)), 0);
  const fieldNetAreaMm2 = calibrated ? fieldsSvc.px2ToMm2(fieldNetAreaPx, scale) : null;

  return {
    kind: 'field-grid-density',
    fieldId: field.id,
    fieldName: fieldsSvc.fieldLabel(field, fieldIndex),
    fieldHoles: Array.isArray(field.holes) ? field.holes.length : 0,
    cols,
    rows,
    cellCountTotal: cols * rows,
    zeroAreaCellCount: gridCells.filter((g) => !g.computable).length,
    // 外接矩形（等分对象）与等分步长；前端据此在冻结快照上叠加网格
    bounds: {
      minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY,
      width: w, height: h,
      colStep, rowStep,
      linesX: xs,
      linesY: ys
    },
    // 视野净区域（与逐视野统计同公式）；各格有效面积之和应与其一致
    fieldAreaPx: fieldsSvc.round(fieldNetAreaPx, 3),
    fieldAreaMm2: fieldNetAreaMm2 === null ? null : fieldsSvc.round(fieldNetAreaMm2),
    fieldAreaText: calibrated ? String(fieldsSvc.round(fieldNetAreaMm2)) : fieldsSvc.PENDING,
    totalAreaPx: fieldsSvc.round(totalAreaPx, 3),
    totalAreaMm2: totalAreaMm2 === 0 && !calibrated ? null : fieldsSvc.round(totalAreaMm2),
    totalAreaText: calibrated ? String(fieldsSvc.round(totalAreaMm2)) : fieldsSvc.PENDING,
    // 密度合计口径：各格细胞数之和 = 计入该视野的细胞数（原视野统计）
    cellCount: totalCellCount,
    sumCellCount,
    countMatchesFieldStats: sumCellCount === totalCellCount,
    countedCellKeys: countedCells.map((x) => fieldsSvc.cellKey(x.cell, x.index)),
    // 整个视野口径的密度（与原视野统计一致），供对照
    fieldDensityPerMm2: calibrated && fieldNetAreaMm2 > 0 ? totalCellCount / fieldNetAreaMm2 : null,
    fieldDensityText: calibrated
      ? String(fieldsSvc.round(totalCellCount / fieldNetAreaMm2, 4))
      : fieldsSvc.PENDING,
    cells: gridCells,
    calibrated
  };
}

module.exports = {
  MIN_GRID,
  MAX_GRID,
  NOT_COMPUTABLE,
  validateGridCount,
  resolveField,
  clipRingByRect,
  rectNetIntersectionAreaPx,
  gridIndex,
  buildFieldGrid
};
