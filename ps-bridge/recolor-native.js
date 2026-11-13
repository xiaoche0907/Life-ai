// 可序列化原生调整层配方；Node与UXP共用校验和descriptor转换。
const MODES = ['mode1', 'mode2', 'mode3', 'mode4'];
const BLENDS = ['normal', 'color', 'luminosity'];
const RANGES = ['reds','yellows','greens','cyans','blues','magentas','whites','neutrals','blacks'];
function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw Error('原生配方参数无效：' + label);
  return value;
}
function validate(recipe) {
  if (!recipe || recipe.version !== 1 || !MODES.includes(recipe.mode) || !Array.isArray(recipe.layers) || !recipe.layers.length || recipe.layers.length > 16) throw Error('原生调色配方格式无效');
  for (const layer of recipe.layers) {
    if (!layer || typeof layer.name !== 'string' || !layer.name.trim() || layer.name.length > 160 || !BLENDS.includes(layer.blend)) throw Error('原生图层名称或混合模式无效');
    number(layer.opacity,0,1,'opacity'); number(layer.fillOpacity,0,1,'fillOpacity');
    switch(layer.kind) {
      case 'curves':
        if (!Array.isArray(layer.channels) || ![1,4].includes(layer.channels.length)) throw Error('曲线通道数无效');
        for (const points of layer.channels) {
          if (!Array.isArray(points) || points.length < 2 || points.length > 32) throw Error('曲线点数无效');
          let last=-1;
          for (const p of points) { number(p.input,0,255,'curve.x'); number(p.output,0,255,'curve.y'); if(p.input<=last)throw Error('曲线横坐标必须递增'); last=p.input; }
          if (points[0].input!==0 || points[points.length-1].input!==255) throw Error('曲线必须包含两端点');
        }
        break;
      case 'solid':
        if (!Array.isArray(layer.rgb) || layer.rgb.length!==3)throw Error('填充颜色无效');
        layer.rgb.forEach(v=>number(v,0,255,'rgb'));break;
      case 'hueSaturation':
        if(typeof layer.colorize!=='boolean')throw Error('着色开关无效');
        number(layer.hue,layer.colorize?0:-180,layer.colorize?359:180,'hue');number(layer.saturation,layer.colorize?0:-100,100,'saturation');break;
      case 'selectiveColor':
        for(const range of RANGES)for(const c of ['c','m','y','k'])number(layer.adjustment?.[range]?.[c],-100,100,'selective.'+range+'.'+c);break;
      case 'gradientMap':
        if(!Array.isArray(layer.stops)||layer.stops.length<2||layer.stops.length>64)throw Error('渐变色标无效');
        let last=-1;
        for(const s of layer.stops){number(s.location,0,1,'stop.location');if(s.location<=last)throw Error('色标位置必须递增');last=s.location;for(const c of ['r','g','b'])number(s.color?.[c],0,255,'stop.color');}
        if(layer.stops[0].location!==0||last!==1)throw Error('色标必须覆盖0到1');break;
      case 'channelMixer':
        for(const ch of ['red','green','blue'])for(const c of ['red','green','blue','constant'])number(layer.adjustment?.[ch]?.[c],c==='constant'?-100:-200,c==='constant'?100:200,'mixer.'+ch+'.'+c);break;
      default: throw Error('不支持的原生调整层类型');
    }
  }
  return recipe;
}
const percent=v=>({_unit:'percentUnit',_value:v*100});
const rgb=c=>({_obj:'RGBColor',red:c[0],grain:c[1],blue:c[2]});
function descriptor(layer) {
  validate({version:1,mode:'mode1',layers:[layer]});
  let type;
  if(layer.kind==='solid')return {_obj:'make',_target:[{_ref:'contentLayer'}],using:{_obj:'contentLayer',name:layer.name,mode:{_enum:'blendMode',_value:layer.blend},opacity:percent(layer.opacity),type:{_obj:'solidColorLayer',color:rgb(layer.rgb)}}};
  if(layer.kind==='curves')type={_obj:'curves',presetKind:{_enum:'presetKindType',_value:'presetKindCustom'},adjustment:layer.channels.map((points,i)=>({_obj:'curvesAdjustment',channel:{_ref:'channel',_enum:'channel',_value:['composite','red','grain','blue'][i]},curve:points.map(p=>({_obj:'paint',horizontal:p.input,vertical:p.output}))}))};
  if(layer.kind==='hueSaturation')type={_obj:'hueSaturation',presetKind:{_enum:'presetKindType',_value:'presetKindCustom'},colorize:layer.colorize,adjustment:[{_obj:'hueSatAdjustmentV2',hue:layer.hue,saturation:layer.saturation,lightness:0}]};
  if(layer.kind==='selectiveColor')type={_obj:'selectiveColor',presetKind:{_enum:'presetKindType',_value:'presetKindCustom'},method:{_enum:'correctionMethod',_value:'absolute'},colorCorrection:RANGES.map(range=>({_obj:'colorCorrection',colors:{_enum:'colors',_value:range},cyan:layer.adjustment[range].c,magenta:layer.adjustment[range].m,yellow:layer.adjustment[range].y,black:layer.adjustment[range].k}))};
  if(layer.kind==='gradientMap')type={_obj:'gradientMapClass',reverse:false,dither:false,gradient:{_obj:'gradientClassEvent',name:'来福参考色',gradientForm:{_enum:'gradientForm',_value:'customStops'},interfaceIconFrameDimmed:4096,colors:layer.stops.map(s=>({_obj:'colorStop',color:rgb([s.color.r,s.color.g,s.color.b]),type:{_enum:'colorStopType',_value:'userStop'},location:Math.round(s.location*4096),midpoint:50})),transparency:[0,4096].map(location=>({_obj:'transferSpec',opacity:percent(1),location,midpoint:50}))}};
  if(layer.kind==='channelMixer'){
    type={_obj:'channelMixer',monochromatic:false};
    for(const ch of ['red','green','blue']){const a=layer.adjustment[ch];type[ch==='green'?'grain':ch]={_obj:'channelMatrix',red:a.red,grain:a.green,blue:a.blue,constant:a.constant};}
  }
  return {_obj:'make',_target:[{_ref:'adjustmentLayer'}],using:{_obj:'adjustmentLayer',name:layer.name,mode:{_enum:'blendMode',_value:layer.blend},opacity:percent(layer.opacity),type}};
}
module.exports={validate,descriptor};
