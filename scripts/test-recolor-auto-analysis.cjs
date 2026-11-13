const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../src/renderer/recolor-core');
const html = fs.readFileSync(path.join(__dirname, '../src/renderer/recolor.html'), 'utf8');
const width=64, height=64, bytes=new Uint8ClampedArray(width*height*4);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){const n=(y*width+x)*4,inside=x>12&&x<51&&y>8&&y<58; bytes[n]=inside?160:255;bytes[n+1]=inside?25:255;bytes[n+2]=inside?40:255;bytes[n+3]=255;}
function node(){return{value:'',checked:false,disabled:false,innerHTML:'',textContent:'',dataset:{},style:{},listeners:{},classList:{add(){},remove(){}},setAttribute(){},appendChild(){},addEventListener(k,f){this.listeners[k]=f;},getContext(){return{drawImage(){},putImageData(){},getImageData(){return{width,height,data:new Uint8ClampedArray(bytes)}}}}};}
const nodes=new Map();for(const m of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)){const n=node();n.value=/value="([^"]*)"/.exec(m[0])?.[1]||'';nodes.set(m[1],n);}
const calls=[];const context={console,Uint8ClampedArray,Float32Array,ImageData:class{constructor(data,w,h){this.data=data;this.width=w;this.height=h;}},atob:t=>Buffer.from(t,'base64').toString('binary'),setTimeout:(fn,delay)=>{if(delay<=30)queueMicrotask(fn);return 0},clearTimeout(){},
 document:{getElementById:id=>nodes.get(id),createElement:node},
 Image:class{constructor(){this.naturalWidth=width;this.naturalHeight=height;}set src(_){queueMicrotask(()=>this.onload());}},
 window:{ORANGE_ICONS:{},ColorRecolor:C,addEventListener(){},orange:{glassLog(){},async pickFiles(){return ['sample-red.png']},async readImageBytes(){calls.push('read');return{ok:true,size:128,base64:'test'}},async recolorSave(p){calls.push('saveNative');assert.equal(p.skus.length,1);assert(!p.skus[0].png,'禁止烘焙PNG回传');require('../ps-bridge/recolor-native').validate(p.skus[0].recipe);assert.equal(p.skus[0].recipe.mode,'mode3');return{ok:true,jobId:'native-job'}},async recolorPlace(p){calls.push('placeNative');assert.equal(p.jobId,'native-job');assert(!p.files);return{ok:true,count:1}}}}};
vm.createContext(context);
let script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];script=script.replace(/\}\)\(\);\s*$/, 'window.testState={st,analyzeReferences};})();');
vm.runInContext(script,context);
(async()=>{
 const st=context.window.testState.st;
 st.cap={selection:{left:0,top:0,right:width,bottom:height},width,height};
 const mask=Buffer.alloc(width*height);for(let y=9;y<58;y++)for(let x=13;x<51;x++)mask[y*width+x]=255;
 st.mask={weightB64:mask.toString('base64'),mw:width,mh:height,bounds:{x:0,y:0,width,height},layerName:'服装'};
 nodes.get('cv').width=width;nodes.get('cv').height=height;
 await nodes.get('btnAdd').listeners.click();
 assert.equal(calls.length,1);assert.equal(st.refs.length,1);
 assert.equal(st.refs[0].status,'ready');assert(st.refs[0].stats.tone);
 assert(st.refs[0].coverage>20&&st.refs[0].coverage<80);
 assert.equal(nodes.get('btnGo').disabled,false);
 nodes.get('modeSel').value='mode3';nodes.get('modeSel').listeners.change();assert.equal(st.refs[0].matchMode,'mode3');
 await nodes.get('btnGo').listeners.click();assert.deepEqual(calls,['read','saveNative','placeNative']);assert(nodes.get('stat').textContent.includes('原生调色子组'));
 st.cap=null;await context.window.testState.analyzeReferences();assert.equal(st.refs[0].status,'waiting');
 console.log('通过：上传自动分析、独立模式、生成原生配方、按任务写回且无PNG、未选目标明确等待');
})().catch(e=>{console.error(e);process.exitCode=1});
