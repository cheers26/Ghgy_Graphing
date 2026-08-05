/* Browser-only derived-indicator calculation for the public customer package. */
(function customerFactoryRuntime(){
'use strict';

const SPRING='spring_festival_q1_average';
const SPRING_VERSION='spring-festival-jan-feb-mar-average-v1';
const FREQUENCY_ORDER={daily:0,weekly:1,monthly:2,quarterly:3,annual:4};
const FREQUENCY_LABEL={daily:'日频',weekly:'周频',monthly:'月频',quarterly:'季频',annual:'年频',unknown:'未知'};
const TRANSFORM_LABEL={level:'原值',yoy:'同比',mom:'环比',qoq:'季比',change:'差分',log_return:'对数收益率',log:'自然对数',index100:'首值定基100'};
const MAX_DAYS=100000;
const MAX_CELLS=5000000;

function clone(value){return value==null?value:JSON.parse(JSON.stringify(value))}
function pad(value){return String(value).padStart(2,'0')}
function validDate(text){const value=String(text);if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const parsed=new Date(`${value}T00:00:00Z`);return!Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===value}
function monthEnd(text){const match=/^(\d{4})-(\d{2})-\d{2}$/.exec(String(text));if(!match)throw new Error(`无法解析观测日期：${text}`);const year=Number(match[1]),month=Number(match[2]),day=new Date(Date.UTC(year,month,0)).getUTCDate();return`${match[1]}-${match[2]}-${pad(day)}`}
function shiftMonth(text,offset){
  if(!validDate(text))throw new Error(`无法解析观测日期：${text}`);
  const[year,month,day]=text.split('-').map(Number),index=year*12+month-1+offset,nextYear=Math.floor(index/12),nextMonth=index-nextYear*12+1,last=new Date(Date.UTC(nextYear,nextMonth,0)).getUTCDate();
  return`${String(nextYear).padStart(4,'0')}-${pad(nextMonth)}-${pad(Math.min(day,last))}`;
}
function daysBetween(left,right){return Math.floor((Date.parse(`${right}T00:00:00Z`)-Date.parse(`${left}T00:00:00Z`))/86400000)}
function calendarDays(start,end,inputCount){const count=daysBetween(start,end)+1;if(count<=0)throw new Error('各输入没有共同有效区间。');if(count>MAX_DAYS||count*inputCount>MAX_CELLS)throw new Error('自然日日期骨架超过安全保护上限。');const first=Date.parse(`${start}T00:00:00Z`);return Array.from({length:count},(_,index)=>new Date(first+index*86400000).toISOString().slice(0,10))}
function latest(rows,count=5){return rows.slice(-count).reverse().map(row=>({date:row.date,value:row.value}))}
function operationLag(operation,frequency){if(operation==='yoy')return({daily:252,weekly:52,monthly:12,quarterly:4,annual:1})[frequency]||12;if(operation==='qoq')return({daily:63,weekly:13,monthly:3,quarterly:1,annual:1})[frequency]||3;return 1}
function normalizeInput(input){
  const dateAlignment=input.date_alignment||'original',offset=Number(input.period_month_offset)||0,fill=input.fill_method==='ffill_daily'?'ffill':(input.fill_method||'none'),maxFill=input.max_fill_days==null||input.max_fill_days===''?null:Number(input.max_fill_days),windowTransform=input.window_transform||'none';
  if(!['original','eom'].includes(dateAlignment))throw new Error(`输入 ${input.alias} 的日期归位方式无效。`);
  if(!Number.isInteger(offset)||offset < -12||offset>12)throw new Error('所属月份偏移必须是 -12 至 +12 的整数。');
  if(!['none','ffill','ffill_within_month'].includes(fill))throw new Error(`输入 ${input.alias} 的补值方式无效。`);
  if(maxFill!=null&&(!Number.isInteger(maxFill)||maxFill<=0||maxFill>MAX_DAYS))throw new Error('最大向前填充天数必须是正整数或留空。');
  if(!['none',SPRING].includes(windowTransform))throw new Error(`输入 ${input.alias} 的窗口变形无效。`);
  return{...input,date_alignment:dateAlignment,period_month_offset:offset,fill_method:fill,max_fill_days:maxFill,window_transform:windowTransform,transform:input.transform||'level',lag_periods:Math.max(0,Math.trunc(Number(input.lag_periods)||0))};
}
function definitionUsesSpring(definition){
  if(!definition)return false;
  if(['spring_festival_smooth',SPRING].includes(definition.operation))return true;
  return(definition.config?.inputs||[]).some(input=>(input.window_transform||'none')===SPRING);
}
function isAlreadySmoothed(indicatorId,definitions){return(definitions||[]).some(item=>(item.indicator_id===indicatorId||item.derived_id===indicatorId)&&definitionUsesSpring(item))}

function prepareDates(raw,input,frequency){
  if(input.date_alignment==='eom'&&!['daily','weekly','monthly'].includes(frequency))throw new Error(`输入 ${input.alias} 的频率无法安全执行 EOM 月末归位。`);
  const seen=new Set(),shifted=[];
  for(const row of raw||[]){
    const date=String(row?.date||''),value=Number(row?.value);
    if(!validDate(date))throw new Error(`输入 ${input.alias} 存在无效观测日期：${date||'空值'}`);
    if(seen.has(date))throw new Error(`输入 ${input.alias} 存在重复观测日期：${date}`);seen.add(date);
    if(!Number.isFinite(value))continue;
    const shiftedDate=shiftMonth(date,input.period_month_offset);
    shifted.push({date:shiftedDate,value,detail:{status:shiftedDate===date?'original':'shifted',original_date:date,shifted_date:shiftedDate,aligned_date:shiftedDate,fill_age_days:0,eom_ignored_count:0}});
  }
  shifted.sort((a,b)=>a.date.localeCompare(b.date)||a.detail.original_date.localeCompare(b.detail.original_date));
  if(input.date_alignment!=='eom'){
    const dates=shifted.map(row=>row.date);if(new Set(dates).size!==dates.length)throw new Error(`输入 ${input.alias} 月份偏移后出现重复日期。`);
    return{points:shifted,frequency,ignored:0};
  }
  const groups=new Map();for(const row of shifted){const key=row.date.slice(0,7);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)}
  const points=[];let ignored=0;
  for(const[key,rows]of[...groups.entries()].sort(([a],[b])=>a.localeCompare(b))){
    if(input.window_transform===SPRING&&rows.length!==1)throw new Error(`春节平滑要求每个自然月只有一个有效观测：${key}`);
    const selected=rows.reduce((left,right)=>left.date>right.date||left.date===right.date&&left.detail.original_date>right.detail.original_date?left:right),date=monthEnd(`${key}-01`);ignored+=rows.length-1;
    points.push({...selected,date,detail:{...selected.detail,status:'eom',aligned_date:date,eom_ignored_count:rows.length-1}});
  }
  return{points,frequency:'monthly',ignored};
}
function smoothSpring(points,alias){
  const periods=new Map();for(const original of points){const date=monthEnd(original.date),key=date.slice(0,7);if(periods.has(key))throw new Error(`春节平滑要求每个自然月只有一个有效观测：${key}`);periods.set(key,{...original,date,detail:{...original.detail,aligned_date:date,window_transform:SPRING,window_transform_version:SPRING_VERSION,window_transform_status:'unchanged',window_original_value:original.value}})}
  const years=[...new Set([...periods.keys()].map(key=>Number(key.slice(0,4))))].sort(),smoothed=[],incomplete=[];
  for(const year of years){const quarter=[1,2,3].map(month=>periods.get(`${year}-${pad(month)}`)),present=quarter.filter(Boolean);if(present.length<3){incomplete.push(year);present.forEach(row=>{row.detail.window_transform_status='incomplete_first_quarter'});continue}const average=present.reduce((sum,row)=>sum+row.value,0)/3,sourceDates=present.map(row=>row.detail.original_date||row.date),known=present.map(row=>row.date).sort().at(-1);present.forEach(row=>{row.value=average;row.detail.window_transform_status='smoothed';row.detail.window_source_dates=sourceDates;row.detail.window_known_not_before_date=known});smoothed.push(year)}
  return{points:[...periods.values()].sort((a,b)=>a.date.localeCompare(b.date)),audit:{alias,smoothed_years:smoothed,incomplete_first_quarter_years:incomplete}};
}
function ratioValue(current,previous){return previous===0?NaN:(current/previous-1)*100}
function transformPoints(points,transform,frequency,calendarMonthYoy){
  if(!transform||transform==='level')return points.map(clone);
  if(transform==='log')return points.filter(row=>row.value>0).map(row=>({...clone(row),value:Math.log(row.value)}));
  if(transform==='index100'){const base=points.find(row=>row.value!==0)?.value;if(base==null)return[];return points.map(row=>({...clone(row),value:row.value/base*100}))}
  if(!['yoy','mom','qoq','change','log_return'].includes(transform))throw new Error(`未知输入变形：${transform}`);
  const result=[];
  if(transform==='yoy'&&calendarMonthYoy){const map=new Map(points.map(row=>[row.date.slice(0,7),row]));for(const row of points){const year=Number(row.date.slice(0,4)),month=row.date.slice(5,7),previous=map.get(`${year-1}-${month}`);if(!previous)continue;const value=ratioValue(row.value,previous.value);if(Number.isFinite(value))result.push({...clone(row),value,detail:{...clone(row.detail),transform_source_date:previous.date}})}return result}
  const operation=transform==='log_return'?'mom':transform,lag=operationLag(operation,frequency);
  for(let index=lag;index<points.length;index++){const row=points[index],previous=points[index-lag];let value;if(transform==='change')value=row.value-previous.value;else if(transform==='log_return'){if(row.value<=0||previous.value<=0)continue;value=Math.log(row.value/previous.value)*100}else value=ratioValue(row.value,previous.value);if(Number.isFinite(value))result.push({...clone(row),value,detail:{...clone(row.detail),transform_source_date:previous.date}})}
  return result;
}
function lagPoints(points,lag){if(!lag)return points;const result=[];for(let index=lag;index<points.length;index++){const target=points[index],source=points[index-lag];result.push({...clone(target),value:source.value,detail:{...clone(target.detail),lag_value_source_date:source.date}})}return result}
function prepareInput(raw,input,metadata,definitions){
  const frequency=metadata.frequency||'unknown',usesSpring=input.window_transform===SPRING;if(usesSpring&&frequency!=='monthly')throw new Error(`输入 ${input.alias} 的频率为${FREQUENCY_LABEL[frequency]||frequency}；春节平滑只允许月频指标，日频或周频即使选择 EOM 也不能使用。`);if(usesSpring&&isAlreadySmoothed(input.indicator_id,definitions))throw new Error(`输入 ${input.alias} 已经是春节平滑结果，不能重复平滑。`);
  const rawRows=(raw||[]).map(row=>({date:String(row.date||''),value:Number(row.value)})).filter(row=>Number.isFinite(row.value)).sort((a,b)=>a.date.localeCompare(b.date)),prepared=prepareDates(rawRows,input,frequency);let points=prepared.points,windowAudit=null;if(usesSpring){const smooth=smoothSpring(points,input.alias);points=smooth.points;windowAudit=smooth.audit}const transformed=lagPoints(transformPoints(points,input.transform,prepared.frequency,usesSpring),input.lag_periods);
  return{raw:rawRows,points:transformed,prepared_points:points,effective_frequency:prepared.frequency,eom_ignored_count:prepared.ignored,window_audit:windowAudit,recent_raw:latest(rawRows),recent_transformed:latest(transformed)};
}

function alignInputs(states,inputs){
  const aliases=inputs.map(input=>input.alias),empty=aliases.filter(alias=>!states[alias].points.length);if(empty.length)throw new Error(`输入 ${empty.join('、')} 在日期处理、变形和滞后后没有有效数据。`);const start=aliases.map(alias=>states[alias].points[0].date).sort().at(-1),end=aliases.map(alias=>states[alias].points.at(-1).date).sort()[0];if(start>end)throw new Error('各输入没有共同有效区间。');const nativePoints={},nativeDates={};for(const alias of aliases){nativePoints[alias]=new Map(states[alias].points.map(row=>[row.date,row]));nativeDates[alias]=new Set(nativePoints[alias].keys())}const hasFill=inputs.some(input=>input.fill_method!=='none');if(!hasFill){const dates=[...nativeDates[aliases[0]]].filter(date=>aliases.every(alias=>nativeDates[alias].has(date))).sort();return{dates,maps:nativePoints,nativeDates,skeletonCount:dates.length,hasFill:false}}
  const skeleton=calendarDays(start,end,aliases.length),maps={};for(const input of inputs){const alias=input.alias,rows=states[alias].points,map=new Map();let index=0,last=null;for(const date of skeleton){while(index<rows.length&&rows[index].date<=date){last=rows[index];index++}if(nativePoints[alias].has(date)){map.set(date,nativePoints[alias].get(date));continue}if(input.fill_method==='none'||!last)continue;const age=daysBetween(last.date,date);if(input.max_fill_days!=null&&age>input.max_fill_days)continue;if(input.fill_method==='ffill_within_month'&&date.slice(0,7)!==last.date.slice(0,7))continue;map.set(date,{date,value:last.value,detail:{...clone(last.detail),status:'ffill',ffill_source_date:last.date,fill_age_days:age}})}maps[alias]=map}return{dates:skeleton.filter(date=>aliases.every(alias=>maps[alias].has(date))),maps,nativeDates,skeletonCount:skeleton.length,hasFill:true};
}
function effectiveFrequency(input,metadata,state){return input.date_alignment==='eom'||input.window_transform===SPRING?'monthly':(state.effective_frequency||metadata.frequency||'unknown')}
function trimRule(inputs,metadata,states,alignment){if(alignment.trim_to_lowest_frequency!==true)return{enabled:false,anchor:null,frequency:null};const rows=inputs.map(input=>({alias:input.alias,frequency:effectiveFrequency(input,metadata[input.indicator_id],states[input.alias])})),unknown=rows.filter(row=>FREQUENCY_ORDER[row.frequency]==null);if(unknown.length)throw new Error(`输入 ${unknown.map(row=>row.alias).join('、')} 的频率无法识别，不能裁剪。`);const slowest=Math.max(...rows.map(row=>FREQUENCY_ORDER[row.frequency])),candidates=rows.filter(row=>FREQUENCY_ORDER[row.frequency]===slowest),anchor=alignment.trim_anchor_alias||candidates[0].alias,selected=candidates.find(row=>row.alias===anchor);if(!selected)throw new Error(`裁剪锚点 ${anchor} 不是最低频率输入。`);return{enabled:true,anchor,frequency:selected.frequency}}
function calculationFrequency(inputs,metadata,states){const rows=inputs.filter(input=>input.fill_method==='none'||input.fill_method==='ffill_within_month').map(input=>effectiveFrequency(input,metadata[input.indicator_id],states[input.alias]));if(!rows.length)return'daily';if(rows.some(frequency=>FREQUENCY_ORDER[frequency]==null))return'unknown';return rows.sort((a,b)=>FREQUENCY_ORDER[b]-FREQUENCY_ORDER[a])[0]}
function compileExpression(expression,aliases){if(!expression||expression.length>4000)throw new Error('公式不能为空，且长度不能超过4,000个字符。');if(!/^[A-Za-z0-9_+\-*/().,\s]+$/.test(expression))throw new Error('公式包含不允许的字符。');const allowed=new Set(['abs','min','max','round','pow','sqrt','log','log10','exp','floor','ceil']),identifiers=expression.match(/[A-Za-z_][A-Za-z0-9_]*/g)||[];for(const token of identifiers)if(!aliases.includes(token)&&!allowed.has(token))throw new Error(`公式引用了未选择的变量或函数：${token}`);let normalized=expression;for(const name of allowed)normalized=normalized.replace(new RegExp(`\\b${name}\\b`,'g'),`Math.${name}`);return Function(...aliases,`"use strict";return (${normalized});`)}
function resolveExpression(operation,aliases,expression){if(operation==='difference')return`${aliases[0]}-${aliases[1]}`;if(operation==='ratio')return`${aliases[0]}/${aliases[1]}`;if(operation==='sum')return aliases.join('+');if(operation==='product')return aliases.join('*');return expression||''}
function operationResults(config,inputs,aligned,frequency){
  const aliases=inputs.map(input=>input.alias),operation=config.operation||'custom',result=[];if(operation==='level'){if(inputs.length!==1)throw new Error('原值变形只能选择一个输入指标。');for(const date of aligned.dates)result.push({date,value:aligned.maps[aliases[0]].get(date).value});return{result,expression:aliases[0]}}
  if(['yoy','mom','qoq','change'].includes(operation)){if(inputs.length!==1)throw new Error(`${operation}只能选择一个输入指标。`);const alias=aliases[0],usesSpring=inputs[0].window_transform===SPRING;if(usesSpring&&operation==='yoy'){if(inputs[0].fill_method!=='none')throw new Error('春节平滑后的同比必须在 ffill 前计算；请关闭补值，或把同比放入参与公式前数值变形。');const map=new Map(aligned.dates.map(date=>[date.slice(0,7),aligned.maps[alias].get(date)]));for(const date of aligned.dates){const previous=map.get(`${Number(date.slice(0,4))-1}-${date.slice(5,7)}`),current=aligned.maps[alias].get(date);if(!previous)continue;const value=ratioValue(current.value,previous.value);if(Number.isFinite(value))result.push({date,value})}return{result,expression:'同比'}}const rows=aligned.dates.map(date=>aligned.maps[alias].get(date)),lag=operationLag(operation,frequency);for(let index=lag;index<rows.length;index++){const current=rows[index],previous=rows[index-lag],value=operation==='change'?current.value-previous.value:ratioValue(current.value,previous.value);if(Number.isFinite(value))result.push({date:current.date,value})}return{result,expression:operation}}
  if(['difference','ratio'].includes(operation)&&inputs.length<2)throw new Error('差值和比值至少需要两个输入。');const expression=resolveExpression(operation,aliases,config.expression),evaluate=compileExpression(expression,aliases);for(const date of aligned.dates){try{const value=Number(evaluate(...aliases.map(alias=>aligned.maps[alias].get(date).value)));if(Number.isFinite(value))result.push({date,value})}catch{}}return{result,expression};
}

function calculate(config,context){
  const inputs=(config.inputs||[]).filter(input=>input.indicator_id).map(normalizeInput);if(!inputs.length)throw new Error('至少选择一个指标。');if(inputs.length>64)throw new Error('单个草稿指标最多使用64个输入。');const aliases=inputs.map(input=>String(input.alias||'').trim());if(new Set(aliases).size!==aliases.length||aliases.some(alias=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)))throw new Error('公式变量名必须唯一，并以字母或下划线开头。');const metadata=Object.fromEntries((context.metadata||[]).map(item=>[item.indicator_id,item])),missing=inputs.filter(input=>!metadata[input.indicator_id]);if(missing.length)throw new Error(`找不到输入指标：${missing.map(input=>input.alias).join('、')}`);const states={};for(const input of inputs)states[input.alias]=prepareInput(context.series?.[input.indicator_id]||[],input,metadata[input.indicator_id],context.definitions||[]);const aligned=alignInputs(states,inputs),frequency=calculationFrequency(inputs,metadata,states),trim=trimRule(inputs,metadata,states,config.alignment||{}),calculated=operationResults(config,inputs,aligned,frequency);let result=calculated.result;if(trim.enabled)result=result.filter(row=>aligned.nativeDates[trim.anchor].has(row.date));if(!result.length)throw new Error('没有得到有效观察值，请检查共同日期、变形、补值和公式。');const outputFrequency=trim.enabled?trim.frequency:frequency,warnings=[],inputMeta=[];
  for(const input of inputs){const source=metadata[input.indicator_id],state=states[input.alias];if(input.window_transform===SPRING){warnings.push({code:'spring_festival_ex_post',message:`输入 ${input.alias} 的春节平滑属于事后口径：1月和2月结果使用同年3月数据，不适用于未经时点修正的实时回测。`});if(state.window_audit.incomplete_first_quarter_years.length)warnings.push({code:'spring_festival_incomplete_first_quarter',message:`输入 ${input.alias} 的以下年份第一季度不完整，已有月份保持原值：${state.window_audit.incomplete_first_quarter_years.join('、')}`})}if(input.date_alignment==='eom')warnings.push({code:'eom_availability_semantics',message:`输入 ${input.alias} 的 EOM 是期间归位，不代表真实发布日期。`});inputMeta.push({alias:input.alias,name:source.name||'已选择指标',unit:source.unit||'',frequency:source.frequency||'unknown',original_frequency:source.frequency||'unknown',effective_frequency:effectiveFrequency(input,source,state),transform:input.transform,transform_label:TRANSFORM_LABEL[input.transform]||input.transform,lag_periods:input.lag_periods,date_alignment:input.date_alignment,date_alignment_label:input.date_alignment==='eom'?'EOM 月末归位':'原始日期',period_month_offset:input.period_month_offset,fill_method:input.fill_method,fill_method_label:{none:'不填充',ffill:'普通 ffill',ffill_within_month:'仅月内 ffill'}[input.fill_method],max_fill_days:input.max_fill_days,eom_ignored_count:state.eom_ignored_count,window_transform:input.window_transform,window_transform_label:input.window_transform===SPRING?'春节平滑（1—3月算术平均）':'无',window_transform_version:input.window_transform===SPRING?SPRING_VERSION:null,smoothed_years:state.window_audit?.smoothed_years||[],incomplete_first_quarter_years:state.window_audit?.incomplete_first_quarter_years||[],recent_raw:state.recent_raw,recent_transformed:state.recent_transformed})}
  const rows=result.slice(-5).reverse().map(row=>({date:row.date,inputs:Object.fromEntries(aliases.map(alias=>[alias,aligned.maps[alias].get(row.date)?.value])),input_provenance:Object.fromEntries(aliases.map(alias=>[alias,aligned.maps[alias].get(row.date)?.detail?.status||'original'])),input_audit:Object.fromEntries(aliases.map(alias=>[alias,clone(aligned.maps[alias].get(row.date)?.detail||{})])),result:row.value}));
  return{ok:true,result:result.map(row=>({date:row.date,value:row.value})),output_frequency:outputFrequency,frequency:outputFrequency,calculation_frequency:frequency,effective_range:{start:result[0].date,end:result.at(-1).date},alignment:{mode:aligned.hasFill?'per_input_daily':'intersection',label:aligned.hasFill?'逐输入补值后共同有效日期':'共同日期精确交集'},skeleton_row_count:aligned.skeletonCount,calculation_row_count:aligned.dates.length,final_output_count:result.length,calculable_count:result.length,trimming:{enabled:trim.enabled,anchor_alias:trim.anchor,anchor_frequency:trim.frequency},expression:calculated.expression,inputs:inputMeta,warnings,rows,normalized_inputs:inputs};
}

function renderRecentFive(payload){
  const root=document.getElementById('derivedAuditInputs');if(!root)return;const articles=[...root.querySelectorAll('article')];(payload.inputs||[]).forEach((input,index)=>{const article=articles[index];if(!article)return;const format=rows=>(rows||[]).map(row=>`${row.date}：${Number(row.value).toLocaleString('zh-CN',{maximumSignificantDigits:15})}`).join('；')||'无有效数据',details=document.createElement('details');details.className='customer-recent-five';details.open=true;const summary=document.createElement('summary');summary.textContent='最近5条数据核对';const raw=document.createElement('p');raw.textContent=`原始：${format(input.recent_raw)}`;const transformed=document.createElement('p');transformed.textContent=`处理后：${format(input.recent_transformed)}`;details.append(summary,raw,transformed);article.appendChild(details)});
}

window.GHGY_CUSTOMER_FACTORY={calculate,renderRecentFive,constants:{SPRING,SPRING_VERSION}};
})();
