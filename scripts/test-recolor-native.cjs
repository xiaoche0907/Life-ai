const assert=require('node:assert/strict');
const C=require('../src/renderer/recolor-core');
const N=require('../ps-bridge/recolor-native');
function fabric(rgb){const data=new Uint8ClampedArray(64*64*4);for(let y=0;y<64;y++)for(let x=0;x<64;x++){const i=(y*64+x)*4,d=Math.round(10*Math.sin(x/3)*Math.sin(y/4));for(let c=0;c<3;c++)data[i+c]=rgb[c]+d;data[i+3]=255;}return {width:64,height:64,data};}
const src=fabric([180,175,170]),ref=fabric([120,30,50]);
const stats={src:C.analyzeSource(src,new Float32Array(4096).fill(1)),ref:C.analyzeReference(ref,{x:0,y:0,width:64,height:64})};
const kinds=new Set();
for(const mode of ['mode1','mode2','mode3','mode4']){
 const recipe=C.buildNativeRecipe(stats,{matchMode:mode,contrast:.2,shadows:.2,highlights:-.1,hue:15,saturation:.2,colorize:true,colorizeOpacity:.7});
 N.validate(recipe);assert.equal(recipe.mode,mode);assert.equal(recipe.layers[0].name,'对比度—曲线');assert.equal(recipe.layers.at(-1).name,'着色—色相饱和度');
 const clean=JSON.parse(JSON.stringify(recipe));assert.deepEqual(clean,recipe);
 for(const layer of recipe.layers){kinds.add(layer.kind);const d=N.descriptor(layer);assert.equal(d._obj,'make');assert(d.using.type._obj);assert(!JSON.stringify(d).includes('pixels'));}
 const bad=structuredClone(recipe);bad.layers[0].channels[0][1].input=-1;assert.throws(()=>N.validate(bad),/参数无效|递增/);
 console.log('通过：'+mode+' 原生配方、顺序、序列化和参数校验');
}
assert.equal(kinds.size,6);
assert.throws(()=>N.validate({version:1,mode:'unknown',layers:[]}),/无效/);
console.log('通过：六类PS原生图层descriptor覆盖；不包含烘焙像素层');
module.exports={stats};
