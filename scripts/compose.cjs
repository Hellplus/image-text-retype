#!/usr/bin/env node
'use strict';

// Dependencies are resolved normally (local node_modules or NODE_PATH).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let sharp;
try { sharp = require('sharp'); }
catch { console.error('Missing dependency: sharp. Provide it in node_modules or NODE_PATH; this script does not install packages.'); process.exit(1); }

const USAGE = 'node compose.cjs --source input.png --clean-plate clean.png --text-layer text.png --plan plan.json --output final.png --report final.report.json';
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
const finite = value => typeof value === 'number' && Number.isFinite(value);

function argumentsFrom(argv) {
  const required = ['source', 'clean-plate', 'text-layer', 'plan', 'output', 'report'];
  if (argv.length === 1 && argv[0] === '--help') { console.log(USAGE); process.exit(0); }
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !required.includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || key in args) throw new Error(`Invalid arguments. ${USAGE}`);
    args[key] = path.resolve(argv[i + 1]);
  }
  if (required.some(key => !args[key])) throw new Error(`Missing arguments. ${USAGE}`);
  return args;
}

async function rgba(input) {
  return sharp(input, { failOn: 'error' }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

function pathKey(filename) {
  const resolved = path.join(fs.realpathSync(path.dirname(filename)), path.basename(filename));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function validateDestinations(args) {
  const inputs = ['source', 'clean-plate', 'text-layer', 'plan'].map(key => pathKey(fs.realpathSync(args[key])));
  for (const key of ['output', 'report']) {
    if (inputs.includes(pathKey(args[key]))) throw new Error(`${key} must not replace an input file.`);
    try { fs.lstatSync(args[key]); throw new Error(`${key} already exists; choose a new path.`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (pathKey(args.output) === pathKey(args.report)) throw new Error('Output and report must have different paths.');
}

function writeDeliverables(args, outputBytes, report) {
  const created = [];
  const handles = [];
  try {
    // Exclusive creation protects both destinations if another process creates
    // one after validation. Inputs and existing deliverables are never opened.
    for (const filename of [args.output, args.report]) {
      const fd = fs.openSync(filename, 'wx');
      handles.push(fd); created.push(filename);
    }
    fs.writeFileSync(handles[0], outputBytes);
    fs.writeFileSync(handles[1], JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    for (const fd of handles) fs.closeSync(fd);
    handles.length = 0;
    for (const filename of created) fs.unlinkSync(filename);
    throw error;
  } finally { for (const fd of handles) fs.closeSync(fd); }
}

function validatePlan(plan, width, height) {
  if (plan?.version !== 1 || plan.canvas?.width !== width || plan.canvas?.height !== height) throw new Error('Plan canvas must match the actual source width and height (version 1).');
  if (!Array.isArray(plan.text) || !Array.isArray(plan.cleanup) || plan.cleanup.length === 0) throw new Error('Plan requires text and nonempty cleanup arrays.');
  const ids = new Set();
  for (const item of plan.text) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) throw new Error('Text item IDs must be nonempty and unique.');
    ids.add(item.id);
    if (typeof item.text !== 'string' || !item.text.trim() || typeof item.font !== 'string' || !item.font.trim()) throw new Error(`Text ${item.id} requires text and font strings.`);
    if (![item.x, item.y, item.size, item.tracking].every(finite) || item.x < 0 || item.x >= width || item.y < 0 || item.y >= height || item.size <= 0) throw new Error(`Text ${item.id} has invalid coordinates or font metrics.`);
    if (typeof item.bold !== 'boolean' || typeof item.color !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(item.color)) throw new Error(`Text ${item.id} requires boolean bold and a hex RGB/RGBA color.`);
    for (const field of ['group', 'role']) if (item[field] !== undefined && typeof item[field] !== 'string') throw new Error(`Text ${item.id} ${field} must be a string.`);
  }
  for (const [index, patch] of plan.cleanup.entries()) {
    const r = patch?.rect;
    if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isInteger) || r[0] < 0 || r[1] < 0 || r[2] <= 0 || r[3] <= 0 || r[0] + r[2] > width || r[1] + r[3] > height) throw new Error(`Cleanup ${index} rectangle must be integer [x,y,width,height] within the source.`);
    if (!['matched-band', 'plate'].includes(patch.mode)) throw new Error(`Cleanup ${index} mode must be matched-band or plate.`);
    if (patch.feather !== undefined && (!finite(patch.feather) || patch.feather < 0)) throw new Error(`Cleanup ${index} feather must be nonnegative.`);
    if (patch.residualWeight !== undefined && (!finite(patch.residualWeight) || patch.residualWeight < 0 || patch.residualWeight > 1)) throw new Error(`Cleanup ${index} residualWeight must be between 0 and 1.`);
    const rows = patch.sampleRows;
    if (patch.mode === 'matched-band' || rows !== undefined) {
      if (!Array.isArray(rows) || rows.length !== 2 || !rows.every(Number.isInteger) || rows[0] < 0 || rows[0] >= r[1] || rows[1] < r[1] + r[3] || rows[1] >= height) throw new Error(`Cleanup ${index} sampleRows must bracket the rectangle outside its top and bottom, within the source.`);
    }
  }
  const unitCount = plan.text.filter(item => item.role === 'unit').length;
  if (plan.expected !== undefined && (!plan.expected || typeof plan.expected !== 'object' || Array.isArray(plan.expected))) throw new Error('expected must be an object.');
  if (plan.expected?.unitCount !== undefined && (!Number.isInteger(plan.expected.unitCount) || plan.expected.unitCount < 0 || plan.expected.unitCount !== unitCount)) throw new Error(`expected.unitCount does not match ${unitCount} text items with role=unit.`);
}

function validateImagePixels(plan, source, plate, layer, width, height) {
  const allowed = new Uint8Array(width * height);
  for (const [index, patch] of plan.cleanup.entries()) {
    const [left, top, patchWidth, patchHeight] = patch.rect;
    for (let y = top; y < top + patchHeight; y++) for (let x = left; x < left + patchWidth; x++) {
      const pixel = y * width + x;
      allowed[pixel] = 1;
      if (patch.mode === 'matched-band' && (source[pixel * 4 + 3] !== 255 || plate[pixel * 4 + 3] !== 255)) throw new Error(`Cleanup ${index} matched-band requires an opaque source and plate throughout its rectangle.`);
    }
    if (patch.mode === 'matched-band') for (const y of patch.sampleRows) for (let x = left; x < left + patchWidth; x++) {
      const i = (y * width + x) * 4;
      if (source[i + 3] !== 255 || plate[i + 3] !== 255) throw new Error(`Cleanup ${index} matched-band sampleRows must be opaque in source and plate.`);
    }
  }
  for (let pixel = 0; pixel < allowed.length; pixel++) if (!allowed[pixel] && layer[pixel * 4 + 3] !== 0) throw new Error(`Text layer alpha extends outside cleanup rectangles at ${pixel % width},${Math.floor(pixel / width)}.`);
  return allowed;
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  validateDestinations(args);
  const sourceBytes = fs.readFileSync(args.source);
  const sourceHash = sha256(sourceBytes);
  const sourceMeta = await sharp(sourceBytes, { failOn: 'error' }).metadata();
  if (sourceMeta.depth !== 'uchar') throw new Error('Source must be 8-bit; refusing to reduce a higher-bit-depth source.');
  if ((sourceMeta.pages || 1) !== 1) throw new Error('Source must be a single-frame raster image.');
  const source = await rgba(sourceBytes);
  const { width, height } = source.info;
  const plan = JSON.parse(fs.readFileSync(args.plan, 'utf8').replace(/^\uFEFF/, ''));
  validatePlan(plan, width, height);
  const plateMeta = await sharp(args['clean-plate']).metadata();
  const layerMeta = await sharp(args['text-layer']).metadata();
  if (plateMeta.width * height !== plateMeta.height * width) throw new Error('Clean plate aspect ratio must exactly match the source; do not stretch a mismatched plate.');
  if ((plateMeta.pages || 1) !== 1 || (layerMeta.pages || 1) !== 1) throw new Error('Clean plate and text layer must be single-frame raster images.');
  if (layerMeta.width !== width || layerMeta.height !== height || !layerMeta.hasAlpha) throw new Error('Text layer must have source dimensions and an alpha channel.');
  const plate = await sharp(args['clean-plate']).resize(width, height, { fit: 'fill' }).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  // A slight blur keeps only broad plate variation in the residual.
  const lowPlate = await sharp(plate, { raw: { width, height, channels: 4 } }).blur(3).raw().toBuffer();
  const layer = (await rgba(args['text-layer'])).data;
  const allowed = validateImagePixels(plan, source.data, plate, layer, width, height);
  const repaired = Buffer.from(source.data);
  for (const patch of plan.cleanup) {
    const [left, top, patchWidth, patchHeight] = patch.rect;
    const feather = patch.feather ?? 8;
    const weight = patch.residualWeight ?? 0.35;
    const [yt, yb] = patch.sampleRows || [0, height - 1];
    for (let y = top; y < top + patchHeight; y++) for (let x = left; x < left + patchWidth; x++) {
      const i = (y * width + x) * 4;
      const distance = Math.min(x - left, left + patchWidth - 1 - x, y - top, top + patchHeight - 1 - y);
      const blend = feather === 0 ? 1 : Math.min(1, distance / feather);
      const t = (y - yt) / (yb - yt);
      const it = (yt * width + x) * 4, ib = (yb * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const base = source.data[it + c] * (1 - t) + source.data[ib + c] * t;
        const residual = lowPlate[i + c] - (lowPlate[it + c] * (1 - t) + lowPlate[ib + c] * t);
        const clean = patch.mode === 'plate' ? plate[i + c] : base + residual * weight;
        const alpha = blend * (patch.mode === 'plate' ? plate[i + 3] / 255 : 1);
        repaired[i + c] = clamp(source.data[i + c] * (1 - alpha) + clean * alpha);
      }
    }
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const alpha = layer[i + 3] / 255;
    for (let c = 0; c < 3; c++) repaired[i + c] = clamp(repaired[i + c] * (1 - alpha) + layer[i + c] * alpha);
  }
  let changedPixels = 0, outside = 0, changedAlphaPixels = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (repaired[i + 3] !== source.data[i + 3]) changedAlphaPixels++;
    if (repaired[i] === source.data[i] && repaired[i + 1] === source.data[i + 1] && repaired[i + 2] === source.data[i + 2] && repaired[i + 3] === source.data[i + 3]) continue;
    changedPixels++;
    if (!allowed[y * width + x]) outside++;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (outside || changedAlphaPixels) throw new Error('Preservation validation failed: changed pixels outside cleanup or changed source alpha.');
  const outputBytes = await sharp(repaired, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const afterHash = sha256(fs.readFileSync(args.source));
  if (sourceHash !== afterHash) throw new Error('Source changed during composition.');
  const report = {
    version: 1, source: args.source, output: args.output, sourceHash, sourceHashAfter: afterHash,
    sourceUnchanged: true, outputHash: sha256(outputBytes), width, height,
    cleanPlate: { path: args['clean-plate'], width: plateMeta.width, height: plateMeta.height, usedAsIntermediate: true },
    textLayer: args['text-layer'], textItemCount: plan.text.length, unitCount: plan.text.filter(item => item.role === 'unit').length,
    expected: plan.expected || {}, allowedRects: plan.cleanup.map(patch => patch.rect),
    changedOutsideAllowedRects: outside, changedAlphaPixels, changedPixels,
    changedBounds: changedPixels ? [minX, minY, maxX + 1, maxY + 1] : null,
    requiresVisualReview: true, status: 'SELF_CHECKED_AWAITING_VISUAL_REVIEW',
    warnings: plan.cleanup.some(patch => patch.mode === 'plate') ? ['Plate-mode cleanup requires human visual QA on the restored background.'] : ['Matched-band cleanup assumes an opaque, smooth, pale backdrop; inspect every repaired band.'],
  };
  writeDeliverables(args, outputBytes, report);
  console.log(JSON.stringify({ output: args.output, report: args.report, status: report.status }));
}

main().catch(error => { console.error(`compose: ${error.message}`); process.exitCode = 1; });
