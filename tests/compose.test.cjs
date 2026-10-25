const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');

const CLI = path.resolve(__dirname, '../scripts/compose.cjs');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function fixture(t, { alpha = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-text-retype-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const width = 96, height = 64;
  const source = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    // A flat cream backdrop makes the independently known repaired values exact.
    source.set([224, 220, 210, alpha && x < 5 ? 80 : 255], i);
  }
  // Both pale outline and dark ink must be removed, including gaps in the ink.
  for (let y = 25; y < 39; y++) for (let x = 25; x < 72; x++) {
    source.set([251, 249, 242, 255], (y * width + x) * 4);
  }
  for (let y = 29; y < 35; y++) for (let x = 30; x < 67; x++) {
    source.set([110, 40, 35, 255], (y * width + x) * 4);
  }
  const p = name => path.join(dir, name);
  await sharp(source, { raw: { width, height, channels: 4 } }).png().toFile(p('source.png'));
  await sharp({ create: { width: 48, height: 32, channels: 4, background: { r: 224, g: 220, b: 210, alpha: 1 } } }).png().toFile(p('plate.png'));
  const layer = Buffer.alloc(width * height * 4);
  for (let y = 29; y < 35; y++) for (let x = 37; x < 60; x++) layer.set([25, 40, 55, 255], (y * width + x) * 4);
  await sharp(layer, { raw: { width, height, channels: 4 } }).png().toFile(p('layer.png'));
  const plan = {
    version: 1, canvas: { width, height },
    text: [{ id: 'line', text: 'Example', x: 37, y: 29, font: 'Example Font', size: 10, bold: false, color: '#192837', tracking: 0 }],
    cleanup: [{ rect: [16, 16, 64, 32], mode: 'matched-band', sampleRows: [12, 51], feather: 8, residualWeight: 0.35 }],
  };
  const run = ({ planOverride, planBom = false, sourcePath, platePath, layerPath, outputPath, reportPath } = {}) => {
    fs.writeFileSync(p('plan.json'), (planBom ? '\uFEFF' : '') + JSON.stringify(planOverride || plan));
    return spawnSync(process.execPath, [CLI, '--source', sourcePath || p('source.png'), '--clean-plate', platePath || p('plate.png'), '--text-layer', layerPath || p('layer.png'), '--plan', p('plan.json'), '--output', outputPath || p('final.png'), '--report', reportPath || p('final.report.json')], { encoding: 'utf8', env: process.env });
  };
  return { dir, p, plan, run, width, height, source, layer };
}

test('repairs the entire text band at source resolution and protects every outside RGBA pixel', async t => {
  const f = await fixture(t, { alpha: true });
  const before = sha(f.p('source.png'));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(sha(f.p('source.png')), before);
  const final = await sharp(f.p('final.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(final.info.width, f.width);
  assert.equal(final.info.height, f.height);
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    const i = (y * f.width + x) * 4;
    if (x < 16 || x >= 80 || y < 16 || y >= 48) assert.deepEqual(final.data.subarray(i, i + 4), f.source.subarray(i, i + 4), `outside at ${x},${y}`);
    assert.equal(final.data[i + 3], f.source[i + 3], `alpha at ${x},${y}`);
  }
  // Pale outline (26,26) and the old ink (31,31) lie outside the new text.
  for (const [x, y] of [[26, 26], [31, 31]]) assert.deepEqual([...final.data.subarray((y * f.width + x) * 4, (y * f.width + x) * 4 + 4)], [224, 220, 210, 255]);
  assert.deepEqual([...final.data.subarray((30 * f.width + 40) * 4, (30 * f.width + 40) * 4 + 4)], [25, 40, 55, 255]);
  const report = JSON.parse(fs.readFileSync(f.p('final.report.json'), 'utf8'));
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.changedOutsideAllowedRects, 0);
  assert.equal(report.width, 96);
  assert.equal(report.height, 64);
  assert.equal(report.cleanPlate.width, 48);
  assert.equal(report.cleanPlate.height, 32);
  assert.equal(report.requiresVisualReview, true);
});

test('refuses to overwrite existing deliverables or any input and leaves their bytes intact', async t => {
  for (const target of ['output', 'report', 'source', 'plate', 'layer', 'plan', 'same-output-report']) await t.test(target, async t => {
    const f = await fixture(t);
    const sentinel = 'DO NOT REPLACE';
    let options = {};
    let protectedPath;
    if (target === 'output' || target === 'report') {
      protectedPath = f.p(target === 'output' ? 'final.png' : 'final.report.json');
      fs.writeFileSync(protectedPath, sentinel);
    } else if (target === 'same-output-report') {
      options.reportPath = f.p('final.png');
    } else {
      protectedPath = f.p({ source: 'source.png', plate: 'plate.png', layer: 'layer.png', plan: 'plan.json' }[target]);
      fs.writeFileSync(f.p('plan.json'), JSON.stringify(f.plan));
      options.outputPath = protectedPath;
    }
    const before = protectedPath && sha(protectedPath);
    const result = f.run(options);
    assert.notEqual(result.status, 0, 'must refuse output collision');
    if (protectedPath) assert.equal(sha(protectedPath), before);
    if (target !== 'output' && target !== 'same-output-report') assert.equal(fs.existsSync(f.p('final.png')), false);
    if (target !== 'report') assert.equal(fs.existsSync(f.p('final.report.json')), false);
  });
});

test('rejects invalid geometry, sampling, modes and expected unit counts before writing', async t => {
  const cases = {
    'wrong-canvas': p => { p.canvas.width = 48; },
    'wrong-version': p => { p.version = 2; },
    'negative-rectangle': p => { p.cleanup[0].rect[0] = -1; },
    'rectangle-past-edge': p => { p.cleanup[0].rect[2] = 97; },
    'fractional-rectangle': p => { p.cleanup[0].rect[1] = 16.5; },
    'empty-rectangle': p => { p.cleanup[0].rect[2] = 0; },
    'wrong-mode': p => { p.cleanup[0].mode = 'magic'; },
    'missing-sample-rows': p => { delete p.cleanup[0].sampleRows; },
    'sample-inside-band': p => { p.cleanup[0].sampleRows = [16, 51]; },
    'sample-outside-source': p => { p.cleanup[0].sampleRows = [-1, 64]; },
    'sample-reversed': p => { p.cleanup[0].sampleRows = [51, 12]; },
    'sample-fractional': p => { p.cleanup[0].sampleRows = [12.5, 51]; },
    'negative-feather': p => { p.cleanup[0].feather = -1; },
    'bad-residual-weight': p => { p.cleanup[0].residualWeight = 1.5; },
    'text-anchor-outside-canvas': p => { p.text[0].x = 96; },
    'wrong-unit-count': p => { p.expected = { unitCount: 1 }; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
    const f = await fixture(t);
    change(f.plan);
    const before = sha(f.p('source.png'));
    const result = f.run();
    assert.notEqual(result.status, 0, 'invalid plan must fail');
    assert.equal(fs.existsSync(f.p('final.png')), false);
    assert.equal(fs.existsSync(f.p('final.report.json')), false);
    assert.equal(sha(f.p('source.png')), before);
  });
});

test('rejects mismatched plate aspect ratios, invalid layers and translucent matched-band sampling', async t => {
  for (const kind of ['plate-ratio', 'layer-size', 'layer-no-alpha', 'layer-outside-even-if-invisible-after-rounding', 'band-alpha', 'sample-alpha']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'plate-ratio') await sharp({ create: { width: 47, height: 32, channels: 4, background: '#e0dcd2' } }).png().toFile(f.p('plate.png'));
    if (kind === 'layer-size') await sharp({ create: { width: 48, height: 32, channels: 4, background: '#00000000' } }).png().toFile(f.p('layer.png'));
    if (kind === 'layer-no-alpha') await sharp(f.layer, { raw: { width: f.width, height: f.height, channels: 4 } }).removeAlpha().png().toFile(f.p('layer.png'));
    if (kind === 'layer-outside-even-if-invisible-after-rounding') {
      f.layer.set([224, 220, 210, 1], 0);
      await sharp(f.layer, { raw: { width: f.width, height: f.height, channels: 4 } }).png().toFile(f.p('layer.png'));
    }
    if (kind === 'band-alpha' || kind === 'sample-alpha') {
      const y = kind === 'band-alpha' ? 22 : 12;
      f.source[(y * f.width + 30) * 4 + 3] = 254;
      await sharp(f.source, { raw: { width: f.width, height: f.height, channels: 4 } }).png().toFile(f.p('source.png'));
    }
    const result = f.run();
    assert.notEqual(result.status, 0, 'invalid image input must fail');
    assert.equal(fs.existsSync(f.p('final.png')), false);
    assert.equal(fs.existsSync(f.p('final.report.json')), false);
  });
});

test('matched-band follows source samples in each column instead of pasting the plate colors', async t => {
  const f = await fixture(t);
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    const i = (y * f.width + x) * 4;
    f.source.set([Math.min(255, 150 + Math.floor(x / 2) + y), 140 + Math.floor(x / 2) + y, 130 + Math.floor(x / 2) + y, 255], i);
  }
  for (let y = 25; y < 39; y++) for (let x = 25; x < 72; x++) f.source.set([251, 249, 242, 255], (y * f.width + x) * 4);
  for (let y = 29; y < 35; y++) for (let x = 30; x < 67; x++) f.source.set([110, 40, 35, 255], (y * f.width + x) * 4);
  await sharp(f.source, { raw: { width: f.width, height: f.height, channels: 4 } }).png().toFile(f.p('source.png'));
  await sharp({ create: { width: 48, height: 32, channels: 4, background: '#808080' } }).png().toFile(f.p('plate.png'));
  f.layer.fill(0);
  await sharp(f.layer, { raw: { width: f.width, height: f.height, channels: 4 } }).png().toFile(f.p('layer.png'));
  assert.equal(f.run().status, 0);
  const out = await sharp(f.p('final.png')).ensureAlpha().raw().toBuffer();
  for (const [x, y, expected] of [[26, 26, [189, 179, 169, 255]], [31, 31, [196, 186, 176, 255]]]) assert.deepEqual([...out.subarray((y * f.width + x) * 4, (y * f.width + x) * 4 + 4)], expected);
});

test('plate mode preserves source alpha locally and reports unit roles separately from other text', async t => {
  const f = await fixture(t);
  f.plan.cleanup[0].mode = 'plate';
  f.plan.cleanup[0].feather = 0;
  delete f.plan.cleanup[0].sampleRows;
  f.plan.text[0].role = 'label';
  f.plan.text.push({ ...f.plan.text[0], id: 'unit', role: 'unit', text: 'One unit' });
  f.plan.expected = { unitCount: 1 };
  f.source[(26 * f.width + 26) * 4 + 3] = 128;
  await sharp(f.source, { raw: { width: f.width, height: f.height, channels: 4 } }).png().toFile(f.p('source.png'));
  await sharp({ create: { width: 48, height: 32, channels: 4, background: '#b4d2e6' } }).png().toFile(f.p('plate.png'));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const out = await sharp(f.p('final.png')).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...out.subarray((26 * f.width + 26) * 4, (26 * f.width + 26) * 4 + 4)], [180, 210, 230, 128]);
  const report = JSON.parse(fs.readFileSync(f.p('final.report.json'), 'utf8'));
  assert.equal(report.textItemCount, 2);
  assert.equal(report.unitCount, 1);
  assert.equal(report.changedAlphaPixels, 0);
  assert.match(report.warnings.join(' '), /human visual QA/);
});

test('accepts UTF-8 BOM plans produced by Windows PowerShell', async t => {
  const f = await fixture(t);
  const result = f.run({ planBom: true });
  assert.deepEqual([...fs.readFileSync(f.p('plan.json')).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(f.p('final.png')), true);
});

test('refuses 16-bit and multi-frame sources instead of silently converting them', async t => {
  for (const kind of ['16-bit', 'multi-frame']) await t.test(kind, async t => {
    const f = await fixture(t);
    let input;
    if (kind === '16-bit') {
      input = f.p('source16.png');
      await sharp(f.p('source.png')).toColourspace('rgb16').png().toFile(input);
      assert.equal((await sharp(input).metadata()).depth, 'ushort');
    } else {
      input = f.p('animated.gif');
      const single = await sharp(f.p('source.png')).gif().toBuffer();
      // Duplicate a complete frame section after the global GIF palette.
      const prefixLength = 13 + ((single[10] & 0x80) ? 3 * (2 << (single[10] & 7)) : 0);
      const frame = single.subarray(prefixLength, single.length - 1);
      fs.writeFileSync(input, Buffer.concat([single.subarray(0, prefixLength), frame, frame, Buffer.from([0x3b])]));
      assert.equal((await sharp(input).metadata()).pages, 2);
    }
    const before = sha(input);
    const result = f.run({ sourcePath: input });
    assert.notEqual(result.status, 0, 'unsupported source must fail');
    assert.equal(fs.existsSync(f.p('final.png')), false);
    assert.equal(fs.existsSync(f.p('final.report.json')), false);
    assert.equal(sha(input), before);
  });
});

test('continues to support 8-bit JPEG source pixels and writes a source-size PNG', async t => {
  const f = await fixture(t);
  const input = f.p('source.jpg');
  await sharp(f.p('source.png')).removeAlpha().jpeg({ quality: 95 }).toFile(input);
  const meta = await sharp(input).metadata();
  assert.equal(meta.depth, 'uchar');
  const before = sha(input);
  const decoded = await sharp(input).ensureAlpha().raw().toBuffer();
  const result = f.run({ sourcePath: input });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(sha(input), before);
  const out = await sharp(f.p('final.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(out.info.width, f.width);
  assert.equal(out.info.height, f.height);
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) if (x < 16 || x >= 80 || y < 16 || y >= 48) {
    const i = (y * f.width + x) * 4;
    assert.deepEqual(out.data.subarray(i, i + 4), decoded.subarray(i, i + 4));
  }
});
