/*
 * Task 14 customer workspace persistence and portable work-package runtime.
 *
 * IndexedDB is the durable store.  localStorage remains a compatibility cache
 * for the existing synchronous drawing runtime; legacy values are never
 * removed automatically.  Every write is verified in IndexedDB and failures
 * are surfaced in the storage panel instead of reporting a false success.
 */
(function customerWorkspaceRuntime(){
'use strict';

const DB_NAME='ghgy-customer-workspace';
const DB_VERSION=1;
const RECORD_STORE='records';
const META_STORE='meta';
const SCHEMA_VERSION='ghgy-workspace-v2';
const SUPPORTED_SCHEMA_VERSIONS=new Set(['ghgy-workspace-v1',SCHEMA_VERSION]);
const PACKAGE_LIMIT=256*1024*1024;
const FILE_LIMIT=128*1024*1024;
const ENTRY_LIMIT=64;
const LEGACY_KEYS=[
  'ghgy-local-derived-drafts-v1',
  'yd-local-charts',
  'yd-chart-notes',
  'yd-custom-domains',
  'yd-showcase',
  'yd-showcase-layout-draft-v2',
  'yd-showcase-layout-order-v1',
  'yd-chart-range-history',
  'ghgy-display-name-overrides-v1',
];
const FORBIDDEN_KEY=/(?:^|_)(?:indicator_id|derived_id|chart_id|database_id|source_id|source_file_id|external_id|publisher|source_system|source_sheet|source_column|path|original_path|snapshot_path|internal_id)$/i;
const TECHNICAL_ID=/\b(?:PI|PC)-[A-F0-9]{12,}|\b(?:YD|SC|CH)-[A-Z0-9][A-Z0-9-]{3,}|\bLOCAL-(?:DERIVED|CH)-[A-Z0-9-]+/gi;
const EXECUTABLE_EXT=/\.(?:js|mjs|cjs|html?|svg|wasm|exe|dll|dylib|sh|command|bat|cmd|ps1|py|rb|php|jar)$/i;
const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true});
let dbPromise=null;
let lastSaveError='';
let pendingImport=null;

function byId(id){return document.getElementById(id)}
function nowISO(){return new Date().toISOString()}
function compactLocalTimestamp(date=new Date()){
  const pad=value=>String(value).padStart(2,'0');
  return `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function safeJSON(text,fallback){try{return JSON.parse(text)}catch{return fallback}}
function cleanText(value){return String(value??'').replace(TECHNICAL_ID,'').replace(/\s*·\s*·/g,' · ').trim()}
function clone(value){return value==null?value:JSON.parse(JSON.stringify(value))}
function uuid(prefix){return `${prefix}-${Date.now()}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`}
function bytesToHex(bytes){return[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('')}
async function sha256Bytes(bytes){return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))}
async function sha256JSON(value){return sha256Bytes(encoder.encode(stableJSON(value)))}
function stableJSON(value){
  if(Array.isArray(value))return`[${value.map(stableJSON).join(',')}]`;
  if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function assertObject(value,label){if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label}格式不正确。`)}
function assertKeys(value,allowed,label){assertObject(value,label);const unknown=Object.keys(value).filter(key=>!allowed.includes(key));if(unknown.length)throw new Error(`${label}包含未知字段：${unknown.slice(0,5).join('、')}`)}
function parseArray(key){const value=safeJSON(localStorage.getItem(key)||'[]',[]);return Array.isArray(value)?value:[]}
function parseObject(key){const value=safeJSON(localStorage.getItem(key)||'{}',{});return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}

function openDB(){
  if(!('indexedDB'in window))return Promise.reject(new Error('当前浏览器不支持 IndexedDB，不能可靠保存完整工作包。'));
  if(dbPromise)return dbPromise;
  dbPromise=new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(RECORD_STORE))db.createObjectStore(RECORD_STORE,{keyPath:'key'});
      if(!db.objectStoreNames.contains(META_STORE))db.createObjectStore(META_STORE,{keyPath:'key'});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error('IndexedDB 打开失败。'));
    request.onblocked=()=>reject(new Error('另一个旧页面阻止了存储升级，请关闭其他页面后重试。'));
  });
  return dbPromise;
}
async function idbGet(store,key){
  const db=await openDB();
  return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readonly'),request=tx.objectStore(store).get(key);request.onsuccess=()=>resolve(request.result?.value);request.onerror=()=>reject(request.error)});
}
async function idbPut(store,key,value){
  const db=await openDB();
  await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put({key,value,updated_at:nowISO()});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('IndexedDB 写入被中止。'))});
  const verified=await idbGet(store,key);
  if(verified!==value)throw new Error('IndexedDB 写入校验失败。');
}
async function setMeta(key,value){return idbPut(META_STORE,key,JSON.stringify(value))}
async function getMeta(key,fallback=null){const text=await idbGet(META_STORE,key);return text==null?fallback:safeJSON(text,fallback)}
async function migrateLegacy(){
  const migrated=[];
  for(const key of LEGACY_KEYS){
    const durable=await idbGet(RECORD_STORE,key);
    const legacy=localStorage.getItem(key);
    if(durable==null&&legacy!=null){await idbPut(RECORD_STORE,key,legacy);migrated.push(key)}
    else if(durable!=null&&legacy==null)localStorage.setItem(key,durable);
  }
  await setMeta('schema_version',SCHEMA_VERSION);
  await setMeta('legacy_migration',{verified_at:nowISO(),keys:migrated,legacy_retained:true});
  return migrated;
}
async function durableSetItem(key,value){
  if(!LEGACY_KEYS.includes(key))return;
  try{
    await idbPut(RECORD_STORE,key,String(value));
    lastSaveError='';
    await setMeta('last_saved_at',nowISO());
    updateStorageUI();
  }catch(error){
    lastSaveError=error?.message||String(error);
    updateStorageUI();
    window.dispatchEvent(new CustomEvent('ghgy-workspace-save-error',{detail:{key,error:lastSaveError}}));
    throw error;
  }
}
function workspaceSetItem(key,value){
  localStorage.setItem(key,value);
  if(LEGACY_KEYS.includes(key))durableSetItem(key,value).catch(()=>{});
}
window.workspaceSetItem=workspaceSetItem;

function safeDescriptor(meta){
  return{kind:'public_dependency',name:cleanText(meta?.name),unit:cleanText(meta?.unit),frequency:cleanText(meta?.frequency),domain:cleanText(meta?.domain),subdomain:cleanText(meta?.subdomain)};
}
function descriptorKey(descriptor){return[descriptor.name,descriptor.unit,descriptor.frequency,descriptor.domain,descriptor.subdomain].map(value=>String(value||'').trim()).join('\u001f')}
function publicIndicators(){return clone(window.GALLERY_BOOTSTRAP?.indicators||window.state?.indicators||[])}
function publicCharts(){return clone(window.GALLERY_BOOTSTRAP?.charts||window.state?.charts||[]).filter(item=>item?.access_level==='public'||window.GALLERY_BOOTSTRAP)}
function dependencyFor(indicatorId,draftKeyById){
  if(draftKeyById.has(indicatorId))return{kind:'draft_dependency',draft_key:draftKeyById.get(indicatorId)};
  const meta=publicIndicators().find(item=>item.indicator_id===indicatorId);
  if(!meta)throw new Error('草稿引用了当前公开目录中不存在的指标，不能生成可恢复工作包。');
  return safeDescriptor(meta);
}
function scrubGeneric(value){
  if(Array.isArray(value))return value.map(scrubGeneric);
  if(value&&typeof value==='object'){
    const result={};
    for(const[key,item]of Object.entries(value)){
      if(FORBIDDEN_KEY.test(key)||key==='chart_id'||key==='derived_id'||key==='indicator_id')continue;
      result[key]=scrubGeneric(item);
    }
    return result;
  }
  return typeof value==='string'?cleanText(value):value;
}
function exportConfig(config,draftKeyById){
  const safe=scrubGeneric(config||{}),instanceMap=new Map();
  safe.series=(config?.series||[]).map((series,index)=>{
    const instanceKey=`series-${index+1}`;
    if(series.instance_id)instanceMap.set(series.instance_id,instanceKey);
    const row=scrubGeneric(series);
    row.series_key=instanceKey;
    row.dependency=dependencyFor(series.indicator_id,draftKeyById);
    return row;
  });
  if(safe.time_alignment){safe.time_alignment.reference_series_key=instanceMap.get(config?.time_alignment?.reference_instance_id)||null;delete safe.time_alignment.reference_instance_id}
  return safe;
}
function chartDescriptor(chart){return{kind:'public_chart',title:cleanText(chart?.title),domain:cleanText(chart?.domain),updated_at:chart?.updated_at||null}}
function displayIndicatorDescriptor(meta){return{kind:'published_indicator_name',name:cleanText(meta?.original_name||meta?.published_name||meta?.name),unit:cleanText(meta?.unit),frequency:cleanText(meta?.frequency),domain:cleanText(meta?.domain),subdomain:cleanText(meta?.subdomain)}}
function displayChartDescriptor(chart){return{kind:'published_chart_name',title:cleanText(chart?.original_title||chart?.published_title||chart?.title),domain:cleanText(chart?.domain)}}
function exportDisplayNames(){const saved=parseObject('ghgy-display-name-overrides-v1'),indicators=publicIndicators(),charts=publicCharts(),rows=[];for(const[entityId,record]of Object.entries(saved.indicator||{})){const item=indicators.find(row=>row.indicator_id===entityId),name=cleanText(record?.display_name);if(item&&name)rows.push({entity_type:'indicator',descriptor:displayIndicatorDescriptor(item),display_name:name,updated_at:record?.updated_at||null})}for(const[entityId,record]of Object.entries(saved.chart||{})){const item=charts.find(row=>row.chart_id===entityId),name=cleanText(record?.display_name);if(item&&name)rows.push({entity_type:'chart',descriptor:displayChartDescriptor(item),display_name:name,updated_at:record?.updated_at||null})}return rows}
function convertLayoutKeys(value,refByChartId){
  if(Array.isArray(value))return value.map(item=>typeof item==='string'&&refByChartId.has(item)?refByChartId.get(item):convertLayoutKeys(item,refByChartId));
  if(value&&typeof value==='object'){
    const result={};
    for(const[key,item]of Object.entries(value))result[refByChartId.get(key)||key]=convertLayoutKeys(item,refByChartId);
    return result;
  }
  return typeof value==='string'&&refByChartId.has(value)?refByChartId.get(value):scrubGeneric(value);
}
async function buildWorkspaceModel(){
  await window.GHGY_WORKSPACE_READY;
  const rawDerived=parseArray('ghgy-local-derived-drafts-v1');
  const rawCharts=parseArray('yd-local-charts').filter(chart=>String(chart?.chart_id||'').startsWith('LOCAL-CH-'));
  const draftKeyById=new Map(rawDerived.map((draft,index)=>[draft?.indicator?.indicator_id,`draft-indicator-${index+1}`]));
  const chartKeyById=new Map(rawCharts.map((chart,index)=>[chart.chart_id,`draft-chart-${index+1}`]));
  const derived=rawDerived.map((draft,index)=>{
    const definition=draft?.definition||{},config=definition.config||{};
    const inputs=(config.inputs||[]).map(input=>({...scrubGeneric(input),dependency:dependencyFor(input.indicator_id,draftKeyById)}));
    return{
      draft_key:`draft-indicator-${index+1}`,
      metadata:scrubGeneric(draft?.indicator||{}),
      definition:{name:cleanText(definition.name),operation:definition.operation,expression:cleanText(definition.expression),unit:cleanText(definition.unit),frequency:cleanText(definition.frequency),domain:cleanText(definition.domain),status:'browser_draft',created_at:definition.created_at||null,updated_at:definition.updated_at||null,config:{...scrubGeneric(config),inputs}},
      observations:(draft?.series||[]).map(point=>({date:String(point.date||''),value:Number(point.value)})).filter(point=>/^\d{4}-\d{2}-\d{2}$/.test(point.date)&&Number.isFinite(point.value)),
    };
  });
  const rawNotes=parseObject('yd-chart-notes');
  const charts=rawCharts.map((chart,index)=>({
    draft_key:`draft-chart-${index+1}`,
    title:cleanText(chart.title),domain:cleanText(chart.domain),updated_at:chart.updated_at||null,
    config:exportConfig(chart.config||{},draftKeyById),
    preview_png:typeof chart.png_url==='string'&&chart.png_url.startsWith('data:image/png;base64,')?chart.png_url:null,
    figure:scrubGeneric(chart.interactive_figure||chart.figure||null),
    render:{fingerprint:null,data_snapshot_hash:chart.data_snapshot_hash||null,renderer_version:cleanText(chart.renderer_version)},
    note:{text:cleanText(rawNotes[chart.chart_id]?.note_text||chart.note_text||''),version:Number(rawNotes[chart.chart_id]?.version||chart.note_version||0)},
  }));
  const refByChartId=new Map([...chartKeyById]);
  publicCharts().forEach((chart,index)=>{if(!refByChartId.has(chart.chart_id))refByChartId.set(chart.chart_id,`public-chart-${index+1}`)});
  const selected=parseArray('yd-showcase').map(id=>refByChartId.get(id)).filter(Boolean);
  const publicDependencies=publicCharts().map((chart,index)=>({ref:`public-chart-${index+1}`,descriptor:chartDescriptor(chart)}));
  const layout=convertLayoutKeys(parseObject('yd-showcase-layout-draft-v2'),refByChartId);
  const order=convertLayoutKeys(parseArray('yd-showcase-layout-order-v1'),refByChartId);
  const model={schema_version:SCHEMA_VERSION,generated_at:nowISO(),derived_drafts:derived,chart_drafts:charts,display_names:exportDisplayNames(),custom_domains:parseArray('yd-custom-domains').map(cleanText).filter(Boolean),showcase:{selected,order,layout,public_dependencies:publicDependencies},client_meta:{origin:location.origin,browser:navigator.userAgent.replace(/\([^)]*\)/g,'').slice(0,160)}};
  const serialized=stableJSON(model);
  if(TECHNICAL_ID.test(serialized)){TECHNICAL_ID.lastIndex=0;throw new Error('工作包脱敏检查失败：仍包含内部或运行时关联键。')}
  TECHNICAL_ID.lastIndex=0;
  return model;
}

const CRC_TABLE=(()=>{const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0}return table})();
function crc32(bytes){let c=0xffffffff;for(const byte of bytes)c=CRC_TABLE[(c^byte)&0xff]^(c>>>8);return(c^0xffffffff)>>>0}
function dosDateTime(date=new Date()){let year=Math.max(1980,date.getFullYear());return{date:((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate(),time:(date.getHours()<<11)|(date.getMinutes()<<5)|Math.floor(date.getSeconds()/2)}}
function zipStore(files){
  const chunks=[],central=[];let offset=0;const stamp=dosDateTime();
  for(const file of files){
    const name=encoder.encode(file.name),data=file.data,crc=crc32(data),header=new Uint8Array(30+name.length),view=new DataView(header.buffer);
    view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(6,0x0800,true);view.setUint16(8,0,true);view.setUint16(10,stamp.time,true);view.setUint16(12,stamp.date,true);view.setUint32(14,crc,true);view.setUint32(18,data.length,true);view.setUint32(22,data.length,true);view.setUint16(26,name.length,true);header.set(name,30);chunks.push(header,data);
    const entry=new Uint8Array(46+name.length),ev=new DataView(entry.buffer);ev.setUint32(0,0x02014b50,true);ev.setUint16(4,20,true);ev.setUint16(6,20,true);ev.setUint16(8,0x0800,true);ev.setUint16(10,0,true);ev.setUint16(12,stamp.time,true);ev.setUint16(14,stamp.date,true);ev.setUint32(16,crc,true);ev.setUint32(20,data.length,true);ev.setUint32(24,data.length,true);ev.setUint16(28,name.length,true);ev.setUint32(38,0,true);ev.setUint32(42,offset,true);entry.set(name,46);central.push(entry);offset+=header.length+data.length;
  }
  const centralOffset=offset,centralSize=central.reduce((sum,item)=>sum+item.length,0),end=new Uint8Array(22),ev=new DataView(end.buffer);ev.setUint32(0,0x06054b50,true);ev.setUint16(8,files.length,true);ev.setUint16(10,files.length,true);ev.setUint32(12,centralSize,true);ev.setUint32(16,centralOffset,true);return new Blob([...chunks,...central,end],{type:'application/zip'});
}
function validPackagePath(name){return Boolean(name)&&name.length<=180&&!name.includes('\\')&&!name.startsWith('/')&&!name.split('/').includes('..')&&!name.includes('\0')&&!EXECUTABLE_EXT.test(name)}
async function parseZip(file){
  if(!file||file.size>PACKAGE_LIMIT)throw new Error('工作包超过256MB上限。');
  const bytes=new Uint8Array(await file.arrayBuffer()),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let eocd=-1;
  for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--)if(view.getUint32(offset,true)===0x06054b50){eocd=offset;break}
  if(eocd<0)throw new Error('ZIP中央目录缺失或文件已损坏。');
  const count=view.getUint16(eocd+10,true),centralSize=view.getUint32(eocd+12,true),centralOffset=view.getUint32(eocd+16,true);
  if(!count||count>ENTRY_LIMIT)throw new Error(`工作包文件数量必须在1到${ENTRY_LIMIT}之间。`);
  if(centralOffset+centralSize>eocd)throw new Error('ZIP中央目录越界。');
  const result=new Map();let cursor=centralOffset,total=0;
  for(let index=0;index<count;index++){
    if(cursor+46>bytes.length||view.getUint32(cursor,true)!==0x02014b50)throw new Error('ZIP中央目录条目损坏。');
    const flags=view.getUint16(cursor+8,true),method=view.getUint16(cursor+10,true),expectedCRC=view.getUint32(cursor+16,true),compressed=view.getUint32(cursor+20,true),expanded=view.getUint32(cursor+24,true),nameLength=view.getUint16(cursor+28,true),extraLength=view.getUint16(cursor+30,true),commentLength=view.getUint16(cursor+32,true),localOffset=view.getUint32(cursor+42,true);
    if(flags&1)throw new Error('不接受加密工作包。');if(method!==0||compressed!==expanded)throw new Error('只接受本系统生成的无压缩安全工作包。');if(expanded>FILE_LIMIT)throw new Error('工作包内单个文件超过128MB。');total+=expanded;if(total>PACKAGE_LIMIT)throw new Error('工作包展开后超过256MB。');
    const name=decoder.decode(bytes.slice(cursor+46,cursor+46+nameLength));if(!validPackagePath(name)||result.has(name))throw new Error(`工作包路径非法或重复：${name}`);
    if(view.getUint32(localOffset,true)!==0x04034b50)throw new Error('ZIP本地条目损坏。');const localNameLength=view.getUint16(localOffset+26,true),localExtraLength=view.getUint16(localOffset+28,true),start=localOffset+30+localNameLength+localExtraLength,end=start+expanded;if(end>bytes.length)throw new Error('ZIP文件内容越界。');const data=bytes.slice(start,end);if(crc32(data)!==expectedCRC)throw new Error(`CRC校验失败：${name}`);result.set(name,data);cursor+=46+nameLength+extraLength+commentLength;
  }
  return result;
}
async function packageFiles(model){
  const documents={
    'drafts/indicators.json':model.derived_drafts,
    'drafts/charts.json':model.chart_drafts,
    'workspace/showcase.json':model.showcase,
    'workspace/domains.json':model.custom_domains,
    'workspace/display-names.json':model.display_names,
    'workspace/meta.json':model.client_meta,
  };
  const entries=[];
  for(const[path,value]of Object.entries(documents)){const data=encoder.encode(JSON.stringify(value));entries.push({path,data,size:data.length,sha256:await sha256Bytes(data)})}
  const contentDigest=await sha256JSON(entries.map(({path,size,sha256})=>({path,size,sha256})));
  const manifest={schema_version:SCHEMA_VERSION,generated_at:model.generated_at,content_digest:contentDigest,counts:{derived_drafts:model.derived_drafts.length,chart_drafts:model.chart_drafts.length,chart_notes:model.chart_drafts.filter(chart=>chart.note?.text).length,display_names:model.display_names.length,custom_domains:model.custom_domains.length,showcase_items:model.showcase.selected.length},limits:{max_package_bytes:PACKAGE_LIMIT,max_file_bytes:FILE_LIMIT,max_entries:ENTRY_LIMIT},files:entries.map(({path,size,sha256})=>({path,size,sha256}))};
  const manifestData=encoder.encode(JSON.stringify(manifest,null,2));return[{name:'manifest.json',data:manifestData},...entries.map(entry=>({name:entry.path,data:entry.data}))];
}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=name;document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
async function exportPackage(){
  setWorkspaceStatus('正在整理草稿并执行脱敏检查…');
  const model=await buildWorkspaceModel(),files=await packageFiles(model),total=files.reduce((sum,file)=>sum+file.data.length,0);if(total>PACKAGE_LIMIT)throw new Error('工作包超过256MB，请删除过大的本机预览后重试。');
  const blob=zipStore(files),stamp=compactLocalTimestamp();downloadBlob(blob,`Ghgy-客户工作包-${stamp}.zip`);await setMeta('last_backup_at',nowISO());setWorkspaceStatus(`工作包已导出：${model.derived_drafts.length}个草稿指标、${model.chart_drafts.length}张草稿图、${model.display_names.length}项显示名称。`);updateStorageUI();
}
function parseDocument(entries,path){const data=entries.get(path);if(!data)throw new Error(`工作包缺少：${path}`);try{return JSON.parse(decoder.decode(data))}catch{throw new Error(`JSON损坏：${path}`)}}
async function validatePackage(file){
  setWorkspaceStatus('正在本机解析并校验工作包，不会写入草稿…');const entries=await parseZip(file),manifest=parseDocument(entries,'manifest.json');assertKeys(manifest,['schema_version','generated_at','content_digest','counts','limits','files'],'manifest');if(!SUPPORTED_SCHEMA_VERSIONS.has(manifest.schema_version))throw new Error(`不兼容的工作包版本：${manifest.schema_version||'未知'}`);if(!Array.isArray(manifest.files)||manifest.files.length>ENTRY_LIMIT-1)throw new Error('manifest文件清单无效。');
  const declared=new Set(['manifest.json']);for(const item of manifest.files){assertKeys(item,['path','size','sha256'],'manifest.files');if(!validPackagePath(item.path)||declared.has(item.path))throw new Error(`manifest路径非法或重复：${item.path}`);const data=entries.get(item.path);if(!data||data.length!==item.size)throw new Error(`文件缺失或大小不符：${item.path}`);if(await sha256Bytes(data)!==item.sha256)throw new Error(`SHA-256校验失败：${item.path}`);declared.add(item.path)}
  if([...entries.keys()].some(path=>!declared.has(path)))throw new Error('工作包包含manifest未声明的文件。');const digest=await sha256JSON(manifest.files.map(({path,size,sha256})=>({path,size,sha256})));if(digest!==manifest.content_digest)throw new Error('工作包内容摘要不一致。');
  const derived=parseDocument(entries,'drafts/indicators.json'),charts=parseDocument(entries,'drafts/charts.json'),showcase=parseDocument(entries,'workspace/showcase.json'),domains=parseDocument(entries,'workspace/domains.json'),meta=parseDocument(entries,'workspace/meta.json'),displayNames=manifest.schema_version===SCHEMA_VERSION?parseDocument(entries,'workspace/display-names.json'):[];if(!Array.isArray(derived)||!Array.isArray(charts)||!Array.isArray(domains)||!Array.isArray(displayNames))throw new Error('工作包内容类型不正确。');assertKeys(showcase,['selected','order','layout','public_dependencies'],'showcase');
  const payload={manifest,derived,charts,showcase,domains,meta,displayNames};const text=stableJSON(payload);if(TECHNICAL_ID.test(text)){TECHNICAL_ID.lastIndex=0;throw new Error('工作包包含伪造内部身份或公开运行关联键。')}TECHNICAL_ID.lastIndex=0;if(/<\s*script\b|javascript\s*:|onerror\s*=|onload\s*=/i.test(text))throw new Error('工作包包含脚本载荷。');return payload;
}
function findPublicIndicator(descriptor){const target=descriptorKey(descriptor),matches=publicIndicators().filter(item=>descriptorKey(safeDescriptor(item))===target);if(matches.length!==1)throw new Error(`正式依赖无法唯一匹配：${descriptor.name||'未命名指标'}`);return matches[0].indicator_id}
function findPublicChart(descriptor){const matches=publicCharts().filter(chart=>cleanText(chart.title)===descriptor.title&&cleanText(chart.domain)===descriptor.domain);return matches.length===1?matches[0].chart_id:null}
function findDisplayIndicator(descriptor){const target=descriptorKey(descriptor),matches=publicIndicators().filter(item=>descriptorKey(displayIndicatorDescriptor(item))===target);return matches.length===1?matches[0].indicator_id:null}
function findDisplayChart(descriptor){const matches=publicCharts().filter(chart=>cleanText(displayChartDescriptor(chart).title)===cleanText(descriptor?.title)&&cleanText(chart.domain)===cleanText(descriptor?.domain));return matches.length===1?matches[0].chart_id:null}
function materializeDisplayNames(rows){const saved={indicator:{},chart:{}};for(const item of rows||[]){if(!['indicator','chart'].includes(item?.entity_type))continue;const displayName=cleanText(item.display_name);if(!displayName)continue;const entityId=item.entity_type==='indicator'?findDisplayIndicator(item.descriptor||{}):findDisplayChart(item.descriptor||{});if(!entityId)continue;saved[item.entity_type][entityId]={display_name:displayName,version:1,updated_at:item.updated_at||nowISO(),history:[]}}return saved}
function restoreConfig(config,draftIdByKey){
  const restored=clone(config||{}),seriesKeyMap=new Map();restored.series=(config?.series||[]).map((row,index)=>{const instanceId=uuid('SI'),copy=clone(row);seriesKeyMap.set(row.series_key,instanceId);delete copy.series_key;copy.instance_id=instanceId;copy.indicator_id=row.dependency?.kind==='draft_dependency'?draftIdByKey.get(row.dependency.draft_key):findPublicIndicator(row.dependency||{});delete copy.dependency;return copy});if(restored.time_alignment){restored.time_alignment.reference_instance_id=seriesKeyMap.get(restored.time_alignment.reference_series_key)||'';delete restored.time_alignment.reference_series_key}return restored;
}
function remapLayout(value,chartIdByRef){
  if(Array.isArray(value))return value.map(item=>typeof item==='string'&&chartIdByRef.has(item)?chartIdByRef.get(item):remapLayout(item,chartIdByRef));
  if(value&&typeof value==='object'){const result={};for(const[key,item]of Object.entries(value))result[chartIdByRef.get(key)||key]=remapLayout(item,chartIdByRef);return result}
  return typeof value==='string'&&chartIdByRef.has(value)?chartIdByRef.get(value):value;
}
function materializeImport(payload){
  const draftIdByKey=new Map(payload.derived.map(item=>[item.draft_key,uuid('LOCAL-DERIVED')])) ,chartIdByRef=new Map();
  const derived=payload.derived.map(item=>{const id=draftIdByKey.get(item.draft_key),definition=clone(item.definition),inputs=(definition.config?.inputs||[]).map(input=>{const copy=clone(input);copy.indicator_id=input.dependency?.kind==='draft_dependency'?draftIdByKey.get(input.dependency.draft_key):findPublicIndicator(input.dependency||{});delete copy.dependency;return copy});definition.config={...(definition.config||{}),inputs,derived_id:id};definition.derived_id=id;definition.indicator_id=id;const observations=(item.observations||[]).map(point=>({date:point.date,value:Number(point.value),value_display:String(point.value)}));const metadata={...(item.metadata||{}),indicator_id:id,external_id:id,source_system:'浏览器草稿',publisher:'客户本机草稿',access_level:'browser_local',first_date:observations[0]?.date||null,latest_date:observations.at(-1)?.date||null,latest_value:observations.at(-1)?.value??null};return{indicator:metadata,definition,series:observations}});
  const charts=payload.charts.map(item=>{const id=uuid('LOCAL-CH');chartIdByRef.set(item.draft_key,id);const config=restoreConfig(item.config,draftIdByKey);return{chart_id:id,title:item.title||'未命名草稿',domain:item.domain||'未分类',status:'browser_draft',access_level:'browser_local',creation_source:'browser_local',config:{...config,chart_id:id,title:item.title||'未命名草稿',status:'browser_draft',access_level:'browser_local'},html_url:null,png_url:item.preview_png||null,interactive_figure:item.figure||null,figure:null,updated_at:nowISO(),data_snapshot_hash:item.render?.data_snapshot_hash||null,renderer_version:item.render?.renderer_version||null,note_text:item.note?.text||'',note_version:Number(item.note?.version||0)}});
  for(const item of payload.showcase.public_dependencies||[]){const id=findPublicChart(item.descriptor||{});if(id)chartIdByRef.set(item.ref,id)}
  const notes=Object.fromEntries(charts.filter(chart=>chart.note_text).map(chart=>[chart.chart_id,{note_text:chart.note_text,version:chart.note_version||1}]));return{derived,charts,notes,displayNames:materializeDisplayNames(payload.displayNames||[]),domains:payload.domains,showcase:remapLayout(payload.showcase.selected||[],chartIdByRef).filter(Boolean),order:remapLayout(payload.showcase.order||[],chartIdByRef).filter(Boolean),layout:remapLayout(payload.showcase.layout||{},chartIdByRef)};
}
async function applyImport(mode){
  if(!pendingImport)throw new Error('请先选择并预览工作包。');if(mode==='replace'){if(!confirm('清空后恢复会删除当前本机草稿。请先导出备份。是否继续？'))return;if(!confirm('第二次确认：确实清空当前本机草稿并恢复所选工作包？'))return}
  const incoming=materializeImport(pendingImport),current={derived:parseArray('ghgy-local-derived-drafts-v1'),charts:parseArray('yd-local-charts'),notes:parseObject('yd-chart-notes'),displayNames:parseObject('ghgy-display-name-overrides-v1'),domains:parseArray('yd-custom-domains'),showcase:parseArray('yd-showcase')},next=mode==='replace'?incoming:{derived:[...current.derived,...incoming.derived],charts:[...current.charts,...incoming.charts],notes:{...current.notes,...incoming.notes},displayNames:{indicator:{...(current.displayNames.indicator||{}),...(incoming.displayNames.indicator||{})},chart:{...(current.displayNames.chart||{}),...(incoming.displayNames.chart||{})}},domains:[...new Set([...current.domains,...incoming.domains])],showcase:[...new Set([...current.showcase,...incoming.showcase])],order:[...parseArray('yd-showcase-layout-order-v1'),...incoming.order],layout:{...parseObject('yd-showcase-layout-draft-v2'),...incoming.layout}};
  const values={'ghgy-local-derived-drafts-v1':next.derived,'yd-local-charts':next.charts,'yd-chart-notes':next.notes,'ghgy-display-name-overrides-v1':next.displayNames,'yd-custom-domains':next.domains,'yd-showcase':next.showcase,'yd-showcase-layout-order-v1':next.order||incoming.order,'yd-showcase-layout-draft-v2':next.layout||incoming.layout};for(const[key,value]of Object.entries(values)){const text=JSON.stringify(value);localStorage.setItem(key,text);await idbPut(RECORD_STORE,key,text)}await setMeta('last_restore_at',{at:nowISO(),mode,schema_version:SCHEMA_VERSION});const nameCount=Object.keys(incoming.displayNames.indicator||{}).length+Object.keys(incoming.displayNames.chart||{}).length;setWorkspaceStatus(`恢复完成：新增${incoming.derived.length}个草稿指标、${incoming.charts.length}张草稿图、${nameCount}项显示名称。页面将刷新。`);setTimeout(()=>location.reload(),600);
}
async function previewFile(file){pendingImport=await validatePackage(file);const counts=pendingImport.manifest.counts||{};setWorkspaceStatus(`预览通过：${counts.derived_drafts||0}个草稿指标、${counts.chart_drafts||0}张草稿图、${counts.chart_notes||0}份说明、${counts.display_names||0}项显示名称、${counts.showcase_items||0}个展示项。尚未写入。`);if(byId('workspaceMergeRestore'))byId('workspaceMergeRestore').disabled=false;if(byId('workspaceReplaceRestore'))byId('workspaceReplaceRestore').disabled=false}
function setWorkspaceStatus(message,error=false){const target=byId('customerWorkspaceStatus');if(target){target.textContent=message||'';target.dataset.kind=error?'error':'info'}}
async function updateStorageUI(){
  const target=byId('customerStorageStatus');if(!target)return;try{const estimate=await navigator.storage?.estimate?.()||{},used=Number(estimate.usage||0),quota=Number(estimate.quota||0),remaining=Math.max(0,quota-used),backup=await getMeta('last_backup_at',null),saved=await getMeta('last_saved_at',null);target.textContent=`已用 ${formatBytes(used)} · 剩余约 ${formatBytes(remaining)} · 最近保存 ${saved?new Date(saved).toLocaleString('zh-CN'):'—'} · 最近备份 ${backup?new Date(backup).toLocaleString('zh-CN'):'从未导出'}${lastSaveError?` · 保存失败：${lastSaveError}`:''}`;target.dataset.kind=lastSaveError?'error':'info'}catch(error){target.textContent=`无法读取存储状态：${error.message}`;target.dataset.kind='error'}
}
function formatBytes(value){if(!Number.isFinite(value)||value<=0)return'0 B';const units=['B','KB','MB','GB'],index=Math.min(units.length-1,Math.floor(Math.log(value)/Math.log(1024)));return`${(value/1024**index).toFixed(index?1:0)} ${units[index]}`}
function bindUI(){
  const panel=byId('customerWorkspacePanel');if(panel)panel.hidden=!window.GALLERY_BOOTSTRAP;
  byId('workspaceExport')?.addEventListener('click',()=>exportPackage().catch(error=>setWorkspaceStatus(error.message,true)));
  byId('workspaceImportFile')?.addEventListener('change',event=>{pendingImport=null;byId('workspaceMergeRestore').disabled=true;byId('workspaceReplaceRestore').disabled=true;const file=event.target.files?.[0];if(file)previewFile(file).catch(error=>setWorkspaceStatus(error.message,true))});
  byId('workspaceMergeRestore')?.addEventListener('click',()=>applyImport('merge').catch(error=>setWorkspaceStatus(error.message,true)));
  byId('workspaceReplaceRestore')?.addEventListener('click',()=>applyImport('replace').catch(error=>setWorkspaceStatus(error.message,true)));
  byId('workspacePersistStorage')?.addEventListener('click',async()=>{try{const persisted=await navigator.storage?.persist?.();setWorkspaceStatus(persisted?'浏览器已允许持久存储。':'浏览器未授予持久存储；请定期导出工作包。');updateStorageUI()}catch(error){setWorkspaceStatus(error.message,true)}});
  updateStorageUI();
}

window.GHGY_WORKSPACE={schemaVersion:SCHEMA_VERSION,setItem:durableSetItem,exportPackage,validatePackage,applyImport,updateStorageUI};
window.GHGY_WORKSPACE_READY=(async()=>{try{return await migrateLegacy()}catch(error){lastSaveError=error.message;throw error}})();
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bindUI,{once:true});else bindUI();
})();
