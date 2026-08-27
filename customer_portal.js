/* Customer-only gallery separation, origin permissions, and help-page wiring. */
(function customerPortalRuntime(){
'use strict';
if(!window.GALLERY_BOOTSTRAP)return;

const isLocal=chart=>String(chart?.chart_id||'').startsWith('LOCAL-CH-')||chart?.access_level==='browser_local'||chart?.creation_source==='browser_local';
const isBuiltIn=chart=>!isLocal(chart);
galleryVisibilityPredicate=isBuiltIn;
const originBadge=chart=>isLocal(chart)?'我的草稿':'内置内容';
let myPage=1;
const pageSize=18;
state.myGalleryDimensionSelections=Object.fromEntries(GALLERY_DIMENSION_KEYS.map(key=>[key,new Set()]));
let myGalleryPreviewObserver=null;
const baseSwitchView=switchView;
const baseRenderGallery=renderGallery;
const baseRenderShowcase=renderShowcase;
const baseSaveNote=saveNote;
const baseRenderDerivedPreview=renderDerivedPreview;

function addBadge(root,chart){if(!root||root.querySelector('.customer-origin-badge'))return;const badge=document.createElement('span');badge.className=`customer-origin-badge ${isLocal(chart)?'local':'built-in'}`;badge.textContent=originBadge(chart);(root.querySelector('.gallery-name,.showcase-title')||root).prepend(badge)}
function safeLocalCharts(){if(window.GHGY_WORKSPACE?.getCollection)return window.GHGY_WORKSPACE.getCollection('yd-local-charts');try{const rows=JSON.parse((window.workspaceGetItem?.('yd-local-charts')??localStorage.getItem('yd-local-charts'))||'[]');return Array.isArray(rows)?rows:[]}catch{return[]}}
function safeNotes(){try{const value=JSON.parse((window.workspaceGetItem?.('yd-chart-notes')??localStorage.getItem('yd-chart-notes'))||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}catch{return{}}}
async function persistVerified(key,value){const text=typeof value==='string'?value:JSON.stringify(value);if(window.GHGY_WORKSPACE?.setItem)await window.GHGY_WORKSPACE.setItem(key,text);else await workspaceSetItem(key,text)}
function renderLocalFigure(frame,chart){const figure=chart.figure||chart.interactive_figure;if(!figure||frame.dataset.previewActivated==='1')return;frame.dataset.previewActivated='1';frame.srcdoc=localFigureDocument({...chart,figure},false)}
function attachMyGalleryPreviews(root){
  myGalleryPreviewObserver?.disconnect();myGalleryPreviewObserver=null;const frames=[...root.querySelectorAll('iframe[data-my-local-chart]')],activate=frame=>{const chart=state.charts.find(item=>item.chart_id===frame.dataset.myLocalChart);if(chart)renderLocalFigure(frame,chart)};
  if(!('IntersectionObserver'in window)){frames.forEach(activate);return}
  myGalleryPreviewObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{if(!entry.isIntersecting)return;myGalleryPreviewObserver?.unobserve(entry.target);activate(entry.target)}),{rootMargin:'420px 0px',threshold:.01});frames.forEach(frame=>myGalleryPreviewObserver.observe(frame));
}
function chartMatchesMyGalleryDimensions(chart){return GALLERY_DIMENSION_KEYS.every(key=>{const selected=state.myGalleryDimensionSelections[key];if(!selected?.size)return true;const values=new Set(galleryDimensionTerms(chart,key).map(term=>term.term_id));return[...selected].some(termId=>values.has(termId))})}
function myGalleryDimensionSummary(key){const selected=state.myGalleryDimensionSelections[key]||new Set(),definition=galleryDimensionDefinition(key),names=(definition.terms||[]).filter(term=>selected.has(term.term_id)).map(term=>term.term_name);return names.length?names.join('、'):'全部'}
function renderMyGalleryDimensionFilters(){const root=$('myGalleryDimensionFilters');if(!root)return;root.innerHTML=effectiveClassificationDimensions().map(dimension=>`<details class="gallery-dimension-group-v2" data-my-gallery-dimension="${escapeHTML(dimension.dimension_key)}"><summary><span>${escapeHTML(dimension.display_name)}</span><strong data-my-gallery-summary>${escapeHTML(myGalleryDimensionSummary(dimension.dimension_key))}</strong></summary><div class="gallery-dimension-options-v2">${(dimension.terms||[]).map(term=>`<label><span>${escapeHTML(term.term_name)}</span><input type="checkbox" value="${escapeHTML(term.term_id)}" ${state.myGalleryDimensionSelections[dimension.dimension_key]?.has(term.term_id)?'checked':''}></label>`).join('')||'<span class="wb-contract__muted">暂无分类项。</span>'}</div></details>`).join('');root.querySelectorAll('[data-my-gallery-dimension]').forEach(group=>group.querySelectorAll('input').forEach(input=>input.onchange=()=>{const selected=state.myGalleryDimensionSelections[group.dataset.myGalleryDimension];input.checked?selected.add(input.value):selected.delete(input.value);myPage=1;renderMyGallery()}))}
function myRows(){const query=String($('myGallerySearch')?.value||'').trim(),kind=$('myGalleryKind')?.value||'',eligible=state.charts.filter(isLocal).filter(chart=>(!kind||chartKind(chart)===kind)&&chartMatchesMyGalleryDimensions(chart)),fields=chart=>[chart.title,chart.original_title,...galleryAllDimensionTerms(chart).map(term=>term.term_name)],rows=window.GHGY_FUZZY_SEARCH?window.GHGY_FUZZY_SEARCH.filter(eligible,query,fields):eligible.filter(chart=>!query||fields(chart).join(' ').toLowerCase().includes(query.toLowerCase()));return rows.sort((left,right)=>Number(galleryOrganization(right).is_pinned)-Number(galleryOrganization(left).is_pinned)||gallerySortValue(right).localeCompare(gallerySortValue(left))||String(left.chart_id).localeCompare(String(right.chart_id)))}
function localPreview(chart){const figure=chart.figure||chart.interactive_figure,title=chartDisplayTitle(chart);if(figure)return`<iframe data-my-local-chart="${escapeHTML(chart.chart_id)}" loading="lazy" title="${escapeHTML(title)}"></iframe>`;if(chart.png_url)return`<img src="${escapeHTML(chart.png_url)}" loading="lazy" decoding="async" alt="${escapeHTML(title)}">`;return'<div class="indicator-meta customer-empty-preview">本机草稿暂无预览，可进入临时试画重新生成。</div>'}
function myOrganizationTags(chart){return galleryAllDimensionTerms(chart).map(term=>`<span class="category-chip-v154">${escapeHTML(term.term_name)}</span>`).join('')}
function renderMyGallery(){
  renderMyGalleryDimensionFilters();const rows=myRows(),pages=Math.max(1,Math.ceil(rows.length/pageSize));myPage=Math.min(myPage,pages);const visible=rows.slice((myPage-1)*pageSize,myPage*pageSize);$('myGalleryCount').textContent=`${rows.length} 张 · 第 ${myPage}/${pages} 页`;
  $('myGalleryGrid').innerHTML=visible.map(chart=>{const organization=galleryOrganization(chart),tags=myOrganizationTags(chart),title=chartDisplayTitle(chart);return`<article class="gallery-card customer-local-card${isSeasonalMode(chart.config?.chart_mode)?' seasonal-card':''}" data-open-my-chart="${escapeHTML(chart.chart_id)}">${localPreview(chart)}<div class="gallery-name"><span class="customer-origin-badge local">我的草稿</span>${escapeHTML(title)}</div>${tags?`<div class="gallery-organization-tags-v2 category-chip-line-v154">${tags}</div>`:''}<div class="gallery-organization-toolbar-v2"><button type="button" class="gallery-pin-v2" data-pin-my-chart="${escapeHTML(chart.chart_id)}" data-pinned="${organization.is_pinned}" aria-label="${organization.is_pinned?'取消置顶':'置顶图片'}">${organization.is_pinned?'★ 已置顶':'☆ 置顶'}</button><button type="button" class="gallery-classify-v2" data-classify-my-chart="${escapeHTML(chart.chart_id)}" aria-label="编辑分类">分类</button></div><div class="gallery-meta">${kindLabel(chartKind(chart))} · ${escapeHTML(chart.domain||'未分类')} · 本机人工更新 ${galleryActivityText(chart)}</div><div class="gallery-actions"><span><button class="text-button" data-view-my-chart="${escapeHTML(chart.chart_id)}">放大查看</button> · <button class="text-button" data-edit-my-chart="${escapeHTML(chart.chart_id)}">继续编辑</button> · <button class="text-button customer-delete-draft" data-delete-my-chart="${escapeHTML(chart.chart_id)}">删除本机草稿</button></span><label class="gallery-check"><input type="checkbox" data-my-showcase="${escapeHTML(chart.chart_id)}" ${state.showcase.has(chart.chart_id)?'checked':''}>加入展示面板</label></div></article>`}).join('')||'<div class="customer-empty-gallery"><strong>“我的图库”还是空的</strong><span>在“临时试画”中保存图片后，会存入当前浏览器并显示在这里。</span></div>';
  $('myGalleryPager').innerHTML=rows.length?`<button class="secondary" data-my-page="prev" ${myPage<=1?'disabled':''}>上一页</button><span>第 ${myPage} / ${pages} 页</span><button class="secondary" data-my-page="next" ${myPage>=pages?'disabled':''}>下一页</button>`:'';
  attachMyGalleryPreviews($('myGalleryGrid'));
  $('myGalleryGrid').querySelectorAll('[data-view-my-chart]').forEach(button=>button.onclick=event=>{event.stopPropagation();openViewer(button.dataset.viewMyChart,'my-gallery')});
  $('myGalleryGrid').querySelectorAll('[data-edit-my-chart]').forEach(button=>button.onclick=event=>{event.stopPropagation();loadChart(button.dataset.editMyChart)});
  $('myGalleryGrid').querySelectorAll('[data-open-my-chart]').forEach(card=>card.ondblclick=event=>{if(!event.target.closest('button,input,textarea,label'))openViewer(card.dataset.openMyChart,'my-gallery')});
  $('myGalleryGrid').querySelectorAll('[data-delete-my-chart]').forEach(button=>button.onclick=event=>{event.stopPropagation();deleteLocalChart(button.dataset.deleteMyChart)});
  $('myGalleryGrid').querySelectorAll('[data-pin-my-chart]').forEach(button=>button.onclick=event=>{event.stopPropagation();const chart=state.charts.find(item=>item.chart_id===button.dataset.pinMyChart);if(chart)toggleGalleryPin(chart,button)});
  $('myGalleryGrid').querySelectorAll('[data-classify-my-chart]').forEach(button=>button.onclick=event=>{event.stopPropagation();const chart=state.charts.find(item=>item.chart_id===button.dataset.classifyMyChart);if(chart)openGalleryOrganization(chart)});
  $('myGalleryGrid').querySelectorAll('[data-my-showcase]').forEach(input=>input.onchange=()=>{input.checked?state.showcase.add(input.dataset.myShowcase):state.showcase.delete(input.dataset.myShowcase);persistShowcase();renderShowcase()});
  $('myGalleryGrid').querySelectorAll('[data-open-my-chart]').forEach(card=>{const chart=state.charts.find(item=>item.chart_id===card.dataset.openMyChart);if(chart)insertNoteBox(card,chart)});attachNoteBoxes($('myGalleryGrid'));
  $('myGalleryPager').querySelectorAll('[data-my-page]').forEach(button=>button.onclick=()=>{myPage+=button.dataset.myPage==='next'?1:-1;renderMyGallery();window.scrollTo({top:0,behavior:'smooth'})});
}
async function deleteLocalChart(chartId){
  const chart=state.charts.find(item=>item.chart_id===chartId);
  if(!chart||!isLocal(chart))return showMessage('只能删除“我的图库”中的本机草稿。',true);
  if(!confirm(`确认删除本机草稿“${chart.title}”？此操作不会影响内置内容。`))return;
  const notesBefore=safeNotes(),notes=cloneChart(notesBefore);delete notes[chartId];const historyBefore=(()=>{try{return JSON.parse((window.workspaceGetItem?.('yd-chart-range-history')??localStorage.getItem('yd-chart-range-history'))||'[]')}catch{return[]}})(),history=historyBefore.filter(item=>item.chart_id!==chartId),showcaseBefore=[...state.showcase];state.showcase.delete(chartId);
  try{await persistVerified('yd-chart-notes',notes);await persistVerified('yd-chart-range-history',history);await persistVerified('yd-showcase',[...state.showcase]);if(window.GHGY_WORKSPACE?.deleteChart)await window.GHGY_WORKSPACE.deleteChart(chartId);else await persistVerified('yd-local-charts',safeLocalCharts().filter(item=>item.chart_id!==chartId))}catch(error){state.showcase=new Set(showcaseBefore);await Promise.allSettled([persistVerified('yd-chart-notes',notesBefore),persistVerified('yd-chart-range-history',historyBefore),persistVerified('yd-showcase',showcaseBefore)]);return showMessage(`删除未完成：${error.message}`,true)}
  await reloadCharts();renderMyGallery();renderShowcase();showMessage('本机草稿已删除；内置内容未改变。')
}
async function copyBuiltInWithNote(chartId,noteText,statusElement){
  const source=state.charts.find(item=>item.chart_id===chartId);if(!source||!isBuiltIn(source))return baseSaveNote(chartId,noteText,statusElement);
  const id=`LOCAL-CH-${Date.now()}-${Math.random().toString(16).slice(2,8)}`,now=new Date().toISOString(),title=String(source.title||'未命名图表').includes('客户草稿')?source.title:`${source.title||'未命名图表'} · 客户草稿`,copy={...cloneChart(source),chart_id:id,title,status:'browser_draft',access_level:'browser_local',creation_source:'browser_local',config:{...cloneChart(source.config||{}),chart_id:id,title,status:'browser_draft',access_level:'browser_local'},html_url:null,created_at:now,manual_activity_at:now,updated_at:now},notesBefore=safeNotes(),notes=cloneChart(notesBefore);notes[id]={note_text:String(noteText||''),version:1};
  try{if(window.GHGY_WORKSPACE?.saveChart)await window.GHGY_WORKSPACE.saveChart(copy);else await persistVerified('yd-local-charts',[...safeLocalCharts(),copy]);await persistVerified('yd-chart-notes',notes)}catch(error){if(window.GHGY_WORKSPACE?.deleteChart)await window.GHGY_WORKSPACE.deleteChart(id).catch(()=>{});await persistVerified('yd-chart-notes',notesBefore).catch(()=>{});throw error}await reloadCharts();if(statusElement)statusElement.textContent='已另存到“我的图库” · 说明 V1';showMessage('内置图片未修改；已另存为“我的图库”本机草稿。');switchView('my-gallery');return{chart_id:id,note_text:String(noteText||''),version:1}
}
function cloneChart(value){return value==null?value:JSON.parse(JSON.stringify(value))}

renderGallery=function(){baseRenderGallery();$('galleryGrid').querySelectorAll('[data-open-chart]').forEach(card=>{const chart=state.charts.find(item=>item.chart_id===card.dataset.openChart);if(chart){addBadge(card,chart);const edit=card.querySelector('[data-edit-chart]');if(edit)edit.textContent='另存试画'}})};
renderShowcase=function(){baseRenderShowcase();$('showcaseGrid')?.querySelectorAll('.showcase-item').forEach(item=>{const chart=state.charts.find(row=>row.chart_id===item.dataset.openChart);if(chart)addBadge(item,chart)});$('showcasePickerResults')?.querySelectorAll('[data-pick-chart]').forEach(input=>{const chart=state.charts.find(row=>row.chart_id===input.dataset.pickChart),container=input.closest('.showcase-pick-item');if(chart&&container&&!container.querySelector('.customer-origin-badge')){const badge=document.createElement('small');badge.className=`customer-origin-badge ${isLocal(chart)?'local':'built-in'}`;badge.textContent=originBadge(chart);container.querySelector('span')?.appendChild(badge)}})};
saveNote=async function(chartId,noteText,statusElement){const chart=state.charts.find(item=>item.chart_id===chartId);return chart&&isBuiltIn(chart)?copyBuiltInWithNote(chartId,noteText,statusElement):baseSaveNote(chartId,noteText,statusElement)};
renderDerivedPreview=function(payload){baseRenderDerivedPreview(payload);window.GHGY_CUSTOMER_FACTORY?.renderRecentFive(payload)};
switchView=function(view){baseSwitchView(view);if(view==='my-gallery')renderMyGallery();if(view==='manual')window.scrollTo({top:0,behavior:'smooth'})};

for(const id of['myGallerySearch','myGalleryKind'])$(id)?.addEventListener(id==='myGallerySearch'?'input':'change',()=>{myPage=1;renderMyGallery()});
window.addEventListener('ghgy-workspace-save-error',event=>showMessage(`浏览器保存失败：${event.detail?.error||'存储空间不足或写入被阻止'}`,true));
window.addEventListener('ghgy-customer-organization-changed',()=>renderMyGallery());
window.addEventListener('ghgy-classification-taxonomy-changed',()=>renderMyGallery());
window.addEventListener('ghgy-workspace-hydrated',event=>{if(event.detail?.ok){renderMyGallery();renderShowcase()}});
renderGallery();renderMyGallery();renderShowcase();
})();
