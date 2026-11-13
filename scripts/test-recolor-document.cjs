const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../ps-bridge/recolor.host.js'), 'utf8');
const native = require('../ps-bridge/recolor-native');
const moves=[], groups=[], adjustments=[], history=[];
let disposed=0, masks=[0,255,128,255], modalDepth=0;
const target={id:22,name:'服装蒙版组',kind:'group',layers:[]};
const root={id:11,name:'父组',kind:'group',layers:[target]};
const doc={id:7,title:'样本.psd',width:2,height:2,layers:[root,{id:33,name:'原图',kind:'pixel'}],activeLayers:[],
 async createLayerGroup({name}){const group={id:100+groups.length,name,kind:'group',layers:[],visible:true,async move(to,placement){moves.push([this.id,to.id,placement]);to.layers.unshift(this);}};groups.push(group);doc.activeLayers=[group];return group;}
};
const data=(bytes,components)=>({width:2,height:2,components,componentSize:8,async getData(){return Uint8Array.from(bytes)},dispose(){disposed++;}});
const ps={app:{activeDocument:doc,documents:[doc]},constants:{LayerKind:{GROUP:'group'},ElementPlacement:{PLACEINSIDE:'inside'}},
 core:{async executeAsModal(fn){modalDepth++;try{return await fn({hostControl:{async suspendHistory(){return 1},async resumeHistory(id,success){history.push(success)}}})}finally{modalDepth--}}},
 action:{async batchPlay(list){return list.map(d=>{
  if(d._obj==='get')return{hasUserMask:d._target[0]._id===22,mode:{_value:'passThrough'}};
  assert(modalDepth>0,'所有写入必须在模态域');
  if(d._obj==='make'){const layer={id:200+adjustments.length,name:d.using.name,kind:d.using.type._obj,async move(to,placement){to.layers.unshift(this);moves.push([this.id,to.id,placement]);}};adjustments.push({layer,descriptor:d});doc.activeLayers=[layer];return{layerID:layer.id};}
  assert(['set','select'].includes(d._obj));return{};
 })}},
 imaging:{
  async getPixels(){assert(modalDepth>0,'必须在PS模态上下文读取像素');return{sourceBounds:{left:0,top:0,right:2,bottom:2},imageData:data([10,20,30,255,40,50,60,255,70,80,90,255,100,110,120,255],4)}},
  async getLayerMask(opts){assert(modalDepth>0,'必须在PS模态上下文读取蒙版');assert.equal(opts.layerID,22);return{sourceBounds:{left:0,top:0,right:2,bottom:2},imageData:data(masks,1)}},
  async putPixels(){assert.fail('原生模式禁止写入烘焙像素');},
 },
};
const sandbox={module:{exports:{}},require:name=>name==='photoshop'?ps:name==='./recolor-native'?native:assert.fail('未知依赖'),Uint8Array,Math,Array,Number,Error};
vm.createContext(sandbox);vm.runInContext(source,sandbox);
(async()=>{
 const api=sandbox.module.exports;
 const old={...sandbox,module:{exports:{}}};vm.createContext(old);vm.runInContext(source.replace("return core.executeAsModal(() => readInsideModal(params), { commandName: '来福：读取文档与组蒙版' });",'return readInsideModal(params);'),old);
 await assert.rejects(old.module.exports.read({docId:7,layerId:22}),/必须在PS模态/);
 const info=await api.inspect();assert.equal(info.groups.length,1);assert.equal(info.groups[0].path,'父组 / 服装蒙版组');
 const read=await api.read({docId:7,layerId:22});assert.deepEqual([...Buffer.from(read.weightB64,'base64')],masks);assert.equal(disposed,2);
 await assert.rejects(api.read({docId:7,layerId:33}),/不是图层组/);await assert.rejects(api.read({docId:999,layerId:22}),/已关闭/);
 const recipe={version:1,mode:'mode1',layers:[{name:'明暗曲线',kind:'curves',blend:'luminosity',opacity:1,fillOpacity:1,channels:[[{input:0,output:0},{input:255,output:255}]]}]};
 const placed=await api.place({docId:7,layerId:22,items:[{name:'SKU红',recipe},{name:'SKU白',recipe}]});
 assert.equal(placed.count,2);assert.equal(placed.native,true);assert.equal(groups.length,2);assert.equal(adjustments.length,2);
 assert.equal(groups[0].visible,true);assert.equal(groups[1].visible,false);
 assert(groups.every(g=>target.layers.includes(g)&&g.layers.length===1));assert.equal(doc.layers[1].id,33);assert.deepEqual(history,[true]);
 await assert.rejects(api.place({docId:7,layerId:22,items:[{name:'无效',recipe:{version:1,mode:'bad',layers:[]}}]}),/格式无效/);assert.equal(groups.length,2);
 masks=[0,0,0,0];await assert.rejects(api.read({docId:7,layerId:22}),/全黑/);assert.equal(disposed,4);
 console.log('通过：文档蒙版读取、模态约束、配方强校验、每SKU原生子组、保留原层与蒙版、无像素层写入');
})().catch(e=>{console.error(e);process.exitCode=1});
