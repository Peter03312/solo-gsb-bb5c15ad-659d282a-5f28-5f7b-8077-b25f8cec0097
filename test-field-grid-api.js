'use strict';

// 单视野网格空间密度的端到端 HTTP 自测（npm test）：在临时 DATA_DIR 上启动真实服务，
// 走 上传 → 定标 → 圈选（含孔洞）/视野（含孔洞）→ 发布 →
// 网格密度查询（id/名称、行列划分、面积/归属/零面积格）→ 错误语义（行列越界、视野不存在）→
// 草稿修改/更正后旧报告结果不变 → 查询不写回 全流程。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const PORT = 8241;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pm-field-grid-'));

const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

async function jget(p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function jsend(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function upload(buffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----b' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n` +
      'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const req = require('http').request(base + '/api/images', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + buffer.length + tail.length }
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(head); req.write(buffer); req.write(tail); req.end();
  });
}

const sq = (x, y, w, h = w) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }
];

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let started = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 100));
  if (!started) throw new Error('server did not start');

  try {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();
    const up = await upload(png);
    check('上传图片成功', up.status === 200 || up.status === 201, up);
    const imgId = up.body.id;

    // 定标 1 px = 1 μm
    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标 200', r.status === 200, r.body && r.body.error);

    // 视野 F 矩形 (0,0)-(100,100)，中央孔洞 (40,40)-(60,60)
    // 细胞：四个 10×10 方块质心分别在 (15,15)(65,15)(15,65)(65,65)，另有一个在视野外
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 2,
      cells: [
        { id: 'k1', name: 'k1', outer: sq(10, 10, 10), holes: [] },
        { id: 'k2', name: 'k2', outer: sq(60, 10, 10), holes: [] },
        { id: 'k3', name: 'k3', outer: sq(10, 60, 10), holes: [] },
        { id: 'k4', name: 'k4', outer: sq(60, 60, 10), holes: [] },
        { id: 'out', name: 'out', outer: sq(200, 200, 10), holes: [] }
      ]
    });
    check('保存轮廓 200', r.status === 200, r.body && r.body.error);

    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: 3,
      fields: [
        { id: 'F', name: '中心视野', outer: sq(0, 0, 100), holes: [sq(40, 40, 20)] }
      ]
    });
    check('保存视野 200', r.status === 200, r.body && r.body.error);

    // 先记录发布前视野统计（4 个计入细胞）
    const draft = (await jget(`/api/images/${imgId}`)).body;
    check('草稿视野统计 4 个细胞', draft.fieldStats[0].cellCount === 4, draft.fieldStats[0]);

    r = await jsend('POST', `/api/images/${imgId}/publish`, { version: 4, title: '网格密度报告' });
    check('发布 201', r.status === 201, r.body && r.body.error);
    const rep = r.body.report;

    const gridQ = (body) => jsend('POST', `/api/reports/${rep.id}/field-grid`, body);

    // ---- 2×2：每格扣孔 100 → 2400 px²；质心各落一格 ----
    r = await gridQ({ fieldId: 'F', cols: 2, rows: 2 });
    check('网格查询 200', r.status === 200, r.body && r.body.error);
    let g = r.body.grid;
    check('scope/回显', r.body.scope === 'report' && r.body.reportId === rep.id &&
      r.body.scaleUmPerPx === 1 && r.body.matchedBy === 'id');
    check('格总数 4', g.cellCountTotal === 4 && g.cells.length === 4 && g.cols === 2 && g.rows === 2);
    check('每格有效面积 2400 px²', g.cells.every((c) => approx(c.areaPx, 2400)),
      g.cells.map((c) => c.areaPx));
    check('每格 mm² 0.0024', g.cells.every((c) => approx(c.areaMm2, 0.0024)));
    check('各格细胞 1 个', g.cells.map((c) => c.cellCount).join() === '1,1,1,1',
      g.cells.map((c) => c.cellCount));
    check('各格密度 416.6667 个/mm²（1/0.0024）',
      g.cells.every((c) => approx(c.densityPerMm2, 1 / 0.0024, 1e-3)),
      g.cells.map((c) => c.densityPerMm2));
    check('细胞合计 4 且与原视野统计一致',
      g.sumCellCount === 4 && g.cellCount === 4 && g.countMatchesFieldStats === true);
    check('各格面积合计 = 视野净面积 9600',
      approx(g.totalAreaPx, 9600) && approx(g.fieldAreaPx, 9600));
    check('计入名单不含视野外细胞', g.countedCellKeys.sort().join() === 'k1,k2,k3,k4');
    check('返回等分线供叠加', g.bounds.linesX.length === 3 && g.bounds.linesY.length === 3 &&
      approx(g.bounds.linesX[1], 50) && approx(g.bounds.linesY[1], 50) &&
      g.bounds.minX === 0 && g.bounds.maxX === 100);
    check('零面积格 0', g.zeroAreaCellCount === 0 &&
      g.cells.every((c) => c.computable && c.densityText !== '不可计算'));
    check('快照地址', r.body.snapshotUrl === `/api/reports/${rep.id}/file`);

    // ---- 按名称查询 + 数值字符串行列 ----
    r = await gridQ({ fieldId: ' 中心视野 ', cols: '4', rows: '1' });
    check('名称匹配 200', r.status === 200 && r.body.matchedBy === 'name', r.body && r.body.error);
    g = r.body.grid;
    // 孔洞 x∈[40,60]：列 [25,50] 与 [50,75] 各扣 20×100=200，首尾列不扣
    check('4×1 各列面积 2500/2300/2300/2500',
      g.cells.map((c) => Math.round(c.areaPx)).join() === '2500,2300,2300,2500',
      g.cells.map((c) => c.areaPx));
    check('行高 100、列宽 25', approx(g.bounds.colStep, 25) && approx(g.bounds.rowStep, 100));

    // ---- 1×1：整视野为一格，面积 9600、4 个细胞、密度 4/0.0096 ----
    r = await gridQ({ fieldId: 'F', cols: 1, rows: 1 });
    g = r.body.grid;
    check('1×1 面积 9600、4 个', approx(g.cells[0].areaPx, 9600) && g.cells[0].cellCount === 4,
      g.cells[0]);
    check('1×1 密度 416.6667', approx(g.cells[0].densityPerMm2, 4 / 0.0096, 1e-3));
    check('全视野密度对照一致', approx(g.fieldDensityPerMm2, 4 / 0.0096, 1e-3));

    // ---- 网格线归属：跨 50 线的细胞质心（额外发布场景用单格 1×10 切条验证行列） ----
    // 1 列 × 10 行（每行 10 px）：k1 质心 y=15 → 行2（索引1），k2 同；k3/k4 y=65 → 行7
    r = await gridQ({ fieldId: 'F', cols: 1, rows: 10 });
    g = r.body.grid;
    check('10 行划分', g.cells.length === 10);
    check('行2 有 2 个（k1,k2，质心 y=15）', g.cells[1].cellCount === 2, g.cells[1].cellKeys);
    check('行7 有 2 个（k3,k4，质心 y=65）', g.cells[6].cellCount === 2, g.cells[6].cellKeys);
    check('合计仍为 4', g.sumCellCount === 4 && g.countMatchesFieldStats);
    // 落在孔洞横跨行的面积：孔洞 y 40..60 → 行5,6 各扣 200 px（20 宽×10 高）
    check('孔洞行扣减', approx(g.cells[4].areaPx, 800) && approx(g.cells[5].areaPx, 800),
      [g.cells[4].areaPx, g.cells[5].areaPx]);

    // ---- 零面积格：非矩形视野需要新报告，这里用超大行列仍每格有面积；
    //      改用孔洞占满整格的情形：3×3，中央孔洞 40..60 不覆盖整格，构造不出零面积。
    //      零面积语义已由纯逻辑覆盖；这里验证非矩形视野报告。
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: 5,
      fields: [
        { id: 'F', name: '中心视野', outer: sq(0, 0, 100), holes: [sq(40, 40, 20)] },
        // 三角形 (0,0),(100,0),(100,100)：2×2 网格左下格零面积
        { id: 'T', name: '三角视野',
          outer: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], holes: [] }
      ]
    });
    check('加三角视野 200', r.status === 200, r.body && r.body.error);
    r = await jsend('POST', `/api/images/${imgId}/publish`, { version: 6, title: '含三角' });
    check('第二次发布 201', r.status === 201, r.body && r.body.error);
    const rep2 = r.body.report;
    r = await jsend('POST', `/api/reports/${rep2.id}/field-grid`, { fieldId: 'T', cols: 2, rows: 2 });
    check('三角视野 200', r.status === 200, r.body && r.body.error);
    g = r.body.grid;
    check('三角左下零面积格保留',
      g.cells[2].computable === false && approx(g.cells[2].areaPx, 0) &&
      g.cells[2].densityText === '不可计算' && g.cells[2].densityPerMm2 === null);
    check('零面积计数 1', g.zeroAreaCellCount === 1);
    check('三角合计 5000', approx(g.totalAreaPx, 5000));

    // ---- 错误语义 ----
    r = await jsend('POST', `/api/reports/${rep.id}/field-grid`, { fieldId: 'F', cols: 0, rows: 2 });
    check('列数 0 → 400', r.status === 400 && /1～40/.test(r.body.error), r.body);
    r = await jsend('POST', `/api/reports/${rep.id}/field-grid`, { fieldId: 'F', cols: 2, rows: 41 });
    check('行数 41 → 400', r.status === 400 && /1～40/.test(r.body.error), r.body);
    r = await jsend('POST', `/api/reports/${rep.id}/field-grid`, { fieldId: 'F', cols: 2.5, rows: 2 });
    check('非整数 → 400', r.status === 400 && /整数/.test(r.body.error), r.body);
    r = await jsend('POST', `/api/reports/${rep.id}/field-grid`, { fieldId: 'F', cols: 2 });
    check('缺行数 → 400', r.status === 400, r.body);
    r = await jsend('POST', `/api/reports/${rep.id}/field-grid`, { fieldId: 'F', rows: 2, cols: 'x' });
    check('非数值 → 400', r.status === 400, r.body);
    r = await jsend('POST', `/api/reports/${rep.id}/field-grid`, { fieldId: 'no-such', cols: 2, rows: 2 });
    check('视野不存在 → 400', r.status === 400 && /视野标识不存在/.test(r.body.error), r.body);
    r = await jsend('POST', `/api/reports/${rep.id}/field-grid`, { fieldId: '', cols: 2, rows: 2 });
    check('空视野标识 → 400', r.status === 400, r.body);
    r = await jsend('POST', '/api/reports/nope/field-grid', { fieldId: 'F', cols: 2, rows: 2 });
    check('报告不存在 → 404', r.status === 404 && /报告不存在/.test(r.body.error), r.body);

    // ---- 查询不写回报告 ----
    const before = (await jget(`/api/reports/${rep.id}`)).body;
    check('报告无 grid 字段', !('grid' in before) && before.cells.length === 5 && before.fields.length === 1);

    // ---- 冻结性：草稿再改轮廓/标尺后旧报告网格结果不变 ----
    const frozen = await gridQ({ fieldId: 'F', cols: 2, rows: 2 });
    let img = (await jget(`/api/images/${imgId}`)).body;
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: img.version,
      cells: [{ id: 'n1', name: 'n1', outer: sq(10, 10, 10), holes: [] }]
    });
    check('草稿改轮廓 200', r.status === 200, r.body && r.body.error);
    img = r.body;
    r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: img.version, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 200 // 1px=2μm
    });
    check('草稿重定标 200', r.status === 200, r.body && r.body.error);
    const after = await gridQ({ fieldId: 'F', cols: 2, rows: 2 });
    check('草稿修改后旧报告网格结果不变',
      JSON.stringify(after.body.grid) === JSON.stringify(frozen.body.grid) &&
      after.body.scaleUmPerPx === 1,
      { before: frozen.body.grid.cells, after: after.body.grid.cells });

    // ---- 更正后新报告反映新草稿，旧报告仍冻结 ----
    img = (await jget(`/api/images/${imgId}`)).body;
    r = await jsend('POST', `/api/reports/${rep2.id}/correct`, {
      reason: '重画细胞后重发', draftVersion: img.version, expectedTipId: rep2.id
    });
    check('更正 201', r.status === 201, r.body && r.body.error);
    const rep3 = r.body.report;
    // 新报告：视野回到两个（草稿当前为 F+T），F 内只有 n1
    r = await jsend('POST', `/api/reports/${rep3.id}/field-grid`, { fieldId: 'F', cols: 2, rows: 2 });
    check('新报告网格只含新细胞',
      r.status === 200 && r.body.grid.cellCount === 1 && r.body.grid.sumCellCount === 1 &&
      r.body.scaleUmPerPx === 2, r.body && r.body.grid);
    const oldAgain = await gridQ({ fieldId: 'F', cols: 2, rows: 2 });
    check('更正后旧报告网格仍冻结（4 个细胞、标尺 1）',
      oldAgain.status === 200 && oldAgain.body.grid.cellCount === 4 &&
      oldAgain.body.scaleUmPerPx === 1);

  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 200));
  }

  if (failures) { console.error(`\n${failures} 项失败 ✖`); process.exit(1); }
  console.log('\n单视野网格空间密度端到端自测全部通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
