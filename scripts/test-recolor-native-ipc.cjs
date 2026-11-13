const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const handlers={},written=[],sent=[];
const ctx={genDir:()=>'/virtual-results',olog(){},async sendToPSAwait(command){sent.push(command);return{ok:true,result:{ok:true,native:true,count:command.params.items.length}}}};
const fakeFs=Object.create(fs);fakeFs.writeFileSync=(file,contents,options)=>{written.push({file,contents,options})};
const sandbox={module:{exports:{}},__dirname:path.resolve(__dirname,'../src/core'),process:{},Buffer,Map,Date,JSON,Number,Error,require:name=>name==='electron'?{ipcMain:{handle:(id,fn)=>{handlers[id]=fn}},nativeImage:{}}:name==='./ctx'?ctx:name==='fs'?fakeFs:require(name)};
vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/core/recolor.js'),'utf8'),sandbox);
(async()=>{
 const recipe={version:1,mode:'mode1',layers:[{name:'色相',kind:'hueSaturation',blend:'normal',opacity:1,fillOpacity:1,hue:10,saturation:0,colorize:false}]};
 const saved=await handlers['recolor-save'](null,{skus:[{name:'红色SKU',recipe}],capture:{docId:7,layerId:22}});assert(saved.ok);assert(saved.jobId);assert.equal(written.length,1);assert(written[0].file.endsWith('_recipes.json'));assert.equal(written[0].options.flag,'wx');
 const placed=await handlers['recolor-place'](null,{jobId:saved.jobId});assert(placed.ok);assert.equal(sent[0].action,'placeRecolorLayers');assert.equal(sent[0].params.layerId,22);assert.equal(sent[0].params.docId,7);assert(!sent[0].params.items[0].rgbaB64);assert(!sent[0].params.items[0].file);assert.equal(sent[0].params.items[0].recipe.mode,'mode1');
 const missing=await handlers['recolor-place'](null,{jobId:'fake'});assert(!missing.ok);assert.equal(sent.length,1);
 const bad=await handlers['recolor-save'](null,{skus:[{name:'无效',recipe:{}}],capture:{docId:7,layerId:22}});assert(!bad.ok);assert.equal(written.length,1);
 console.log('通过：主进程仅保存原生配方、任务绑定文档与组、拒绝无效配方与任务、写回不含像素');
})().catch(e=>{console.error(e);process.exitCode=1});
