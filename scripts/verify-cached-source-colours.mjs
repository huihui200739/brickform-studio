// Fixed-source replay; never submit inference, lower precision, or relax assembly checks.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readGLB } from '../lib/read-glb.ts';
import { colorFromReference } from '../lib/reference-colors.ts';
import { meshToDesign } from '../lib/mesh-design.ts';
import { coherentModelColors } from '../lib/clean-design-colors.ts';
import { PALETTE, validateModel, toLDraw } from '../lib/brick-engine.ts';
import { validateAssembly } from '../lib/assembly-validation.ts';
import { procurementReport, purchaseInventoryCSV } from '../lib/purchase-inventory.ts';
const out = process.env.BRICKFORM_SOURCE_COLOUR_OUT || 'outputs/continue-colour-verification';
await mkdir(out, {recursive:true});
const sha = value => createHash('sha256').update(value).digest('hex');
const encoded = value => JSON.stringify(value, (_k,v) => ArrayBuffer.isView(v) ? {typedArray:v.constructor.name, values:Array.from(v)} : v);
const hash = value => sha(encoded(value));
const revive = (_k,v) => v?.typedArray && v.values ? new globalThis[v.typedArray](v.values) : v;
const save = (name,value) => writeFile(`${out}/${name}`, typeof value === 'string' ? value : JSON.stringify(value,null,2), {flag:'wx'});
const geometry = model => hash(model.bricks.map(({color:_color,...b})=>b));
const counts = model => PALETTE.map((p,color)=>({color,name:p.name,bricks:model.bricks.filter(b=>b.color===color).length}));
globalThis.fetch = async () => { throw Error('Network/inference forbidden during cached source verification'); };
const mode = process.argv[2];
let model,mesh,source;
if (mode === '--temple') {
  const glbPath = 'work/local-3d/jobs/c2f96a0caa7021080d0ce506/model.glb';
  const rasterPath = 'outputs/color-review-c2-source320.json';
  const bytes = await readFile(glbPath), rasterBytes = await readFile(rasterPath);
  const raster = JSON.parse(rasterBytes.toString(),revive);
  if (!ArrayBuffer.isView(raster.data)) raster.data = Uint8ClampedArray.from(raster.data);
  assert.deepEqual([raster.width,raster.height],[256,320]);
  const raw = await readGLB(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'Temple c2 cached source');
  const before = hash(raw);
  mesh = colorFromReference(raw,raster,undefined,true,{unobservedPolicy:'legacy'});
  assert.equal(hash(raw),before);
  source = {scope:'Exact c2 native GLB + saved exact browser Canvas, basic fixed48. No matching semantic Scene is borrowed; NOT exact screenshot8843 Model.', glbPath,rasterPath, glbSha256:sha(bytes),rasterFileSha256:sha(rasterBytes),rasterRGBASha256:sha(Buffer.from(raster.data)), triangles:mesh.positions.length/9, resolution:48, unobservedPolicy:'legacy'};
  const started = Date.now();
  try { model = meshToDesign(mesh,48,[],{image:raster},{colorMode:'faithful'}); }
  catch(error) {
    const report = {source,status:'strict-assembly-rejected',error:String(error),stack:error.stack,elapsedMs:Date.now()-started, sourceColourAudit:mesh.colourPipelineAudit?.counts, projection:mesh.materialDesign?.projection, limitations:['No valid Model was returned. No rejected structure is exported or presented as repaired.', 'No lower precision, borrowed semantic cache, geometry alteration or assembly-check bypass was used.']};
    await save('temple-source-regression.json',report); console.log(JSON.stringify(report,null,2)); process.exit(0);
  }
} else if (mode === '--tower-colours') {
  const dir = 'outputs/new-colour-rootcause/tower-replay';
  const replay = JSON.parse(await readFile(`${dir}/replay-summary.json`,'utf8'));
  assert.deepEqual(replay.changedAPI,[]);
  const outcome = replay.outcomes.find(o=>o.successful);
  if(!outcome) {
    const report = {status:'strict-assembly-rejected',scope:replay.scope,outcomes:replay.outcomes.map(o=>({job:o.job,paths:o.paths.map(p=>({path:p.path,status:p.status,error:p.error}))}))};
    await save('tower-colour-regression.json',report); console.log(JSON.stringify(report,null,2)); process.exit(0);
  }
  const path = outcome.paths.find(p=>p.status==='strict-success').path;
  const modelPath = `${dir}/${outcome.job}-${path}-model.json`,meshPath = `${dir}/${outcome.job}-colored-mesh.json`;
  const mb = await readFile(modelPath),sb = await readFile(meshPath);
  model = JSON.parse(mb);mesh = JSON.parse(sb,revive);
  source = {scope:replay.scope,job:outcome.job,path,modelPath,meshPath,modelFileSha256:sha(mb),meshFileSha256:sha(sb),sourceID:replay.sourceID,referenceFileSha256:replay.referenceFileSha256,resolution:48};
} else throw Error('Use --temple or --tower-colours');
const modelBefore = hash(model),sourceBefore = hash(mesh),before = geometry(model);
assert.equal(model.resolution,48);
assert.equal(model.colorDesign,undefined);
const started = Date.now();
const coherent = coherentModelColors(model,mesh,48);
assert.equal(hash(model),modelBefore);assert.equal(hash(mesh),sourceBefore);assert.equal(geometry(coherent),before);
const actual = model.bricks.flatMap((b,i)=>b.color===coherent.bricks[i].color ? [] : [{brickId:b.id,from:b.color,to:coherent.bricks[i].color}]);
assert.deepEqual(coherent.colorDesign.changes.map(({brickId,from,to})=>({brickId,from,to})),actual);
assert.equal(coherent.colorDesign.changedBricks,actual.length);
const validationBefore = validateModel(model),validationAfter = validateModel(coherent);
const physicalBefore = validateAssembly(model),physicalAfter = validateAssembly(coherent);
assert.deepEqual(validationAfter,validationBefore);assert.deepEqual(physicalAfter,physicalBefore);
assert.ok(validationAfter.connected&&!validationAfter.collisions&&!validationAfter.unsupported&&!validationAfter.invalidParts);
const name = mode==='--temple' ? 'temple' : 'tower';
const procurement = procurementReport(coherent);
const report = {status:'strict-model-colour-verified',source,elapsedMs:Date.now()-started,bricks:model.bricks.length,steps:model.levels.length,partTypes:new Set(model.bricks.map(b=>b.part)).size,geometrySha256:before,sourceUnchanged:true,modelUnchanged:true,before:counts(model),after:counts(coherent),colorDesign:coherent.colorDesign,validationBefore,validationAfter,physicalBefore,physicalAfter,procurement:{unsupportedColors:procurement.unsupportedColors,unverified:procurement.unverified,stockChecked:procurement.stockChecked}, limitations:['Source-licensed material design is not measured intrinsic albedo. Remaining unknowns stay unchanged.', 'Cached true input-family replay, not proof of exact screenshot Model provenance or full physical assembly.']};
await save(`${name}-faithful.json`,JSON.stringify(model));
await save(`${name}-coherent.json`,JSON.stringify(coherent));
await save(`${name}-coherent.ldr`,toLDraw(coherent));
await save(`${name}-purchase.csv`,purchaseInventoryCSV(coherent.bricks));
await save(`${name}-colour-regression.json`,report);
console.log(JSON.stringify({...report,colorDesign:{...report.colorDesign,changes:undefined}},null,2));
