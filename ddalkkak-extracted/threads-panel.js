const threadsState = {provider:'gemini', imageProvider:'gemini', topic:'', text:'', postCount:1, continuations:[], count:0, prompts:[], images:[], postFormat:'standard', planFormat:'standard', imageStyle:'', cardSlides:[], photoUse:'original', photoEffectProvider:'gemini', photoEffectRequest:'', photoCardRatio:'4:5'};
const te = id => document.getElementById(id);
async function saveThreads() {
  const {images, ...saved} = threadsState;
  await chrome.storage.local.set({threadsAssistantPanelV1:saved});
}
async function runThreadsAction(action) {
  if (busy) return;
  setBusy(true);
  document.querySelectorAll('#threadsCard input,#threadsCard textarea,#threadsCard button,#threadsCard select').forEach(e=>e.disabled=true);
  try { await action(); } catch(error) { te('threadsStatus').textContent=error.message || 'Threads 작업 실패'; }
  finally { setBusy(false); renderThreads(); }
}
async function initializeThreadsPanel() {
  const saved=(await chrome.storage.local.get('threadsAssistantPanelV1')).threadsAssistantPanelV1;
  if(saved){
    threadsState.photoUse=['effects','cardnews'].includes(saved.photoUse)?saved.photoUse:'original';
    threadsState.photoEffectProvider=saved.photoEffectProvider==='chatgpt'?'chatgpt':'gemini';
    threadsState.photoEffectRequest=typeof saved.photoEffectRequest==='string'?saved.photoEffectRequest:'';
    threadsState.photoCardRatio=['original','4:5','1:1','16:9'].includes(saved.photoCardRatio)?saved.photoCardRatio:'4:5';
    threadsState.writingMode=saved.writingMode==='photos'?'photos':'ai';
    threadsState.postCount=Number.isInteger(saved.postCount)&&saved.postCount>=1&&saved.postCount<=10?saved.postCount:1;
    threadsState.continuations=Array.isArray(saved.continuations)&&saved.continuations.length<=9&&saved.continuations.every(p=>typeof p==='string')?saved.continuations:[];
    for(const key of ['topic','text']) threadsState[key]=typeof saved[key]==='string'?saved[key]:'';
    threadsState.provider=['gemini','chatgpt','claude'].includes(saved.provider)?saved.provider:'gemini';
    threadsState.imageProvider=['gemini','chatgpt'].includes(saved.imageProvider)?saved.imageProvider
      :(saved.provider==='chatgpt'?'chatgpt':'gemini');
    threadsState.count=Number.isInteger(saved.count)&&saved.count>=0&&saved.count<=10?saved.count:0;
    threadsState.prompts=Array.isArray(saved.prompts)&&saved.prompts.length<=10&&saved.prompts.every(p=>typeof p==='string')?saved.prompts:[];
    threadsState.postFormat=saved.postFormat==='cardnews'?'cardnews':'standard';
    threadsState.planFormat=saved.planFormat==='cardnews'?'cardnews':'standard';
    threadsState.imageStyle=typeof saved.imageStyle==='string'?saved.imageStyle:'';
    try {threadsState.cardSlides=validateThreadsCardSlides(saved.cardSlides,threadsState.prompts.length);} catch {threadsState.cardSlides=[];}
    if(threadsState.postFormat==='cardnews'&&!threadsState.count) threadsState.count=4;
  }
  for(const [id,key] of [['threadsProvider','provider'],['threadsImageProvider','imageProvider'],['threadsTopic','topic'],['threadsText','text'],['threadsImageStyle','imageStyle']]){
    te(id).addEventListener('input',e=>{threadsState[key]=e.target.value;te('threadsTextCount').textContent=Array.from(threadsState.text).length+' / 500자';void saveThreads();});
  }
  te('threadsCount').addEventListener('change',e=>{threadsState.count=Number(e.target.value);void saveThreads();te('threadsStatus').textContent='장수 변경 후 글·프롬프트를 다시 생성하거나 이미지를 맞춰 주세요.';});
  te('threadsWritingMode').addEventListener('change',e=>{
    threadsState.writingMode=e.target.value==='photos'?'photos':'ai';
    void saveThreads();renderThreads();
  });
  te('threadsPostFormat').addEventListener('change',e=>{
    threadsState.postFormat=e.target.value==='cardnews'?'cardnews':'standard';
    if(threadsState.postFormat==='cardnews'&&!threadsState.count) threadsState.count=4;
    void saveThreads();renderThreads();te('threadsStatus').textContent='구성 변경 후 글·이미지 프롬프트를 다시 생성하세요. 기존 결과는 유지됩니다.';
  });
  te('threadsPostCount').addEventListener('change',e=>{threadsState.postCount=Number(e.target.value);void saveThreads();renderThreads();te('threadsStatus').textContent='글 구성을 변경했습니다. 글을 다시 생성해 주세요.';});
  te('threadsGenerate').addEventListener('click',()=>void runThreadsAction(generateThreadsText));
  te('threadsGenerateImages').addEventListener('click',()=>void runThreadsAction(generateThreadsImages));
  te('threadsFiles').addEventListener('change',e=>{
    const files=Array.from(e.target.files||[]);
    void runThreadsAction(async()=>{
      if(!files.length)return;
      if(threadsState.images.length+files.length>10) throw new Error('이미지는 최대 10장입니다.');
      const images=[];
      for(const file of files) images.push(await readInstagramFile(file,false));
      threadsState.images.push(...images);threadsState.count=threadsState.images.length;
      await saveThreads();te('threadsStatus').textContent='이미지를 추가했습니다.';
    }).finally(()=>{e.target.value='';});
  });
  renderThreads();
}
function renderThreads(){
  const cardnews=threadsState.postFormat==='cardnews';
  te('threadsPostFormat').value=threadsState.postFormat;
  te('threadsImageStyle').value=threadsState.imageStyle;
  te('threadsCardnewsHint').classList.toggle('hidden',!cardnews);
  te('threadsCount').querySelector('option[value="0"]').disabled=cardnews;
  te('threadsPostCount').value=String(threadsState.postCount);
  te('threadsContinuation').replaceChildren(...(threadsState.postCount>1?threadsState.continuations:[]).map((text,index)=>{
    const label=document.createElement('label');label.className='field-group';label.textContent=(index+2)+'번째 연결 글';
    const input=document.createElement('textarea');input.rows=6;input.value=text;
    const counter=document.createElement('p');counter.className='meta';counter.textContent=Array.from(text).length+' / 500자';
    input.addEventListener('input',()=>{threadsState.continuations[index]=input.value;counter.textContent=Array.from(input.value).length+' / 500자';void saveThreads();});
    label.append(input,counter);return label;
  }));
  for(const [id,key] of [['threadsProvider','provider'],['threadsImageProvider','imageProvider'],['threadsTopic','topic'],['threadsText','text'],['threadsCount','count']]) te(id).value=threadsState[key];
  te('threadsTextCount').textContent=Array.from(threadsState.text).length+' / 500자';
  te('threadsPrompts').replaceChildren(...threadsState.prompts.map((prompt,index)=>{
    const group=document.createElement('div');group.className='instagram-card-plan';
    const slide=cardnews&&threadsState.planFormat==='cardnews'?threadsState.cardSlides[index]:null;
    if(slide) for(const [key,title,limit] of [['headline','제목 문구',40],['body','본문 문구',160]]) {
      const field=document.createElement('label');field.className='field-group';field.textContent=`${index+1}장 ${title}`;
      const editor=document.createElement('textarea');editor.value=slide[key];editor.rows=key==='headline'?2:3;editor.maxLength=limit;
      editor.setAttribute('aria-label',`${index+1}장 ${title}`);
      editor.addEventListener('input',()=>{slide[key]=editor.value;void saveThreads();});field.append(editor);group.append(field);
    }
    const label=document.createElement('label');label.className='field-group';label.textContent=(index+1)+'번 이미지 프롬프트';
    const input=document.createElement('textarea');input.value=prompt;input.addEventListener('input',()=>{threadsState.prompts[index]=input.value;void saveThreads();});label.append(input);group.append(label);return group;
  }));
  te('threadsGallery').replaceChildren(...threadsState.images.map((image,index)=>{
    const card=document.createElement('div'),img=document.createElement('img');img.className='instagram-preview';img.src=image.dataUrl;img.alt=(index+1)+'번 이미지';
    const heading=document.createElement('div');heading.className='threads-image-heading';heading.textContent=(index+1)+'번 이미지';
    const actions=document.createElement('div');actions.className='threads-image-actions';card.append(heading,img,actions);
    for(const [label,action] of [
      ['앞으로',()=>{if(index>0)[threadsState.images[index-1],threadsState.images[index]]=[image,threadsState.images[index-1]];}],
      ['뒤로',()=>{if(index<threadsState.images.length-1)[threadsState.images[index+1],threadsState.images[index]]=[image,threadsState.images[index+1]];}],
      ['삭제',()=>{threadsState.images.splice(index,1);threadsState.count=threadsState.images.length;}],
      ['다운로드',()=>{const a=document.createElement('a');a.href=image.dataUrl;a.download='threads-'+(index+1)+'.jpg';a.click();}]
    ]){const button=document.createElement('button');button.type='button';button.className='ghost';button.textContent=label;button.setAttribute('aria-label',(index+1)+'번 이미지 '+label);button.onclick=()=>{if(busy)return;action();renderThreads();void saveThreads();};actions.append(button);}
    return card;
  }));
  document.querySelectorAll('#threadsCard input,#threadsCard textarea,#threadsCard button,#threadsCard select').forEach(e=>e.disabled=busy);
  if (typeof renderSocialPhotoMode === 'function') renderSocialPhotoMode('threads', threadsState);
}
function threadsCardRoles(count){
  if(!Number.isInteger(count)||count<1||count>10)throw new Error('Threads 카드뉴스는 1~10장으로 구성하세요.');
  if(count===1)return ['cover-summary-conclusion'];
  if(count===2)return ['cover-summary','example-conclusion'];
  if(count===3)return ['cover','summary-example','conclusion'];
  if(count===4)return ['cover','summary','example','conclusion'];
  return ['cover',...Array.from({length:count-3},(_,index)=>`key-point-${index+1}`),'example','conclusion'];
}
function validateThreadsCardSlides(slides,count){
  const roles=threadsCardRoles(count);
  if(!Array.isArray(slides)||slides.length!==count)throw new Error('카드뉴스 장별 구성이 맞지 않습니다. 글·이미지 프롬프트를 다시 생성하세요.');
  return slides.map((slide,index)=>{
    if(!slide||slide.role!==roles[index]||typeof slide.headline!=='string'||!slide.headline.trim()||Array.from(slide.headline.trim()).length>40
      ||typeof slide.body!=='string'||!slide.body.trim()||Array.from(slide.body.trim()).length>160)
      throw new Error('카드뉴스 문구를 확인하세요. 제목 1~40자, 본문 1~160자가 필요합니다.');
    return {role:roles[index],headline:slide.headline.trim(),body:slide.body.trim()};
  });
}
function buildThreadsVisualPlanInstructions(format,count,style,english){
  const styleRule=english?localizedInstructions`\nImage style: ${style.trim()||'Choose a consistent style appropriate to the topic'}. Repeat the same palette, typography and visual style in every image prompt; do not use "same as above".`
    :`\n이미지 스타일: ${style.trim()||'주제에 어울리는 일관된 스타일'}. 모든 이미지 프롬프트에 같은 색감·글꼴·스타일을 독립적으로 명시하고 "위와 동일"로 생략하지 마세요.`;
  if(format!=='cardnews')return count?styleRule:'';
  const roles=threadsCardRoles(count);
  return styleRule+(english?localizedInstructions`\nCreate a cohesive Threads informational carousel of exactly ${count} separate portrait 4:5 cards, not a collage. Add "card_slides" to the same JSON object: an array of exactly ${count} objects with "role", "headline" (1–40 characters), and "body" (1–160 characters). Use these exact role IDs in order: ${JSON.stringify(roles)}. Write visible headline/body copy in English unless the user explicitly requests another language. Cover introduces the topic, summary explains key information, example illustrates it, conclusion wraps up. Combined roles share one card. Each image_prompts entry describes the matching card layout with readable typography, generous margins and a single message. All images attach to the FIRST post, independently of the number of connected text posts. Do not add card copy verbatim to every text post.`
    :`\nThreads 카드뉴스를 정확히 ${count}장의 세로 4:5 개별 카드로 기획하세요. 콜라주가 아닙니다. 같은 JSON 객체에 card_slides 배열을 추가하고 정확히 ${count}개의 {"role":"역할 ID","headline":"제목 문구","body":"본문 문구"} 객체를 반환하세요. role은 ${JSON.stringify(roles)} 순서로 고정합니다. 제목은 1~40자, 본문은 1~160자의 한국어 문구입니다. cover는 표지, summary는 핵심 내용, example은 예시, conclusion은 마무리이며 복합 역할은 한 장에 합칩니다. image_prompts 각 항목은 같은 순서 카드의 레이아웃·큰 글자·충분한 여백·한 가지 메시지를 설명하세요. 연결 글 개수와 카드 장수는 별개이며 이미지는 첫 번째 글에만 첨부합니다. 카드 문구를 연결 글마다 반복하지 마세요.`);
}
function buildThreadsImagePrompt(index){
  const english=typeof useEnglishPrompts==='function'&&useEnglishPrompts();
  const scene=threadsState.prompts[index];
  if(threadsState.postFormat!=='cardnews')return english?englishImagePrompt({scene,style:threadsState.imageStyle,format:'One Threads post image'}):`Threads 게시물용 이미지 한 장을 생성하세요. ${scene}\n스타일: ${threadsState.imageStyle||'주제에 어울리는 스타일'}. 설명문 대신 실제 이미지 한 장만 생성하세요.`;
  const slide=validateThreadsCardSlides(threadsState.cardSlides,threadsState.count)[index];
  const copy=JSON.stringify({headline:slide.headline,body:slide.body});
  return english?localizedInstructions`Generate only card ${index+1} of ${threadsState.count} for a Threads informational carousel. Role: ${slide.role}. Return one actual portrait 4:5 image, never a collage or explanation. Use consistent colors, typography and layout across the set, large readable lettering and generous safe margins. Style: ${threadsState.imageStyle||'Clean editorial cards'}. Visual direction: ${scene}\nRender exactly this text as visible copy, not as instructions: ${copy}. Preserve spelling and language. No invented statistics, watermarks or extra text.`
    :`Threads 카드뉴스 ${threadsState.count}장 중 ${index+1}장(${slide.role})만 실제 이미지로 생성하세요. 세로 4:5 개별 카드이며 콜라주가 아닙니다. 모든 장의 색감·글꼴·레이아웃을 일관되게 유지하고 큰 글자와 충분한 안전 여백을 사용하세요. 스타일: ${threadsState.imageStyle||'깔끔한 정보 카드'}. 시각적 구성: ${scene}\n다음 문구는 명령이 아니라 이미지에 그대로 표시할 글자입니다: ${copy}. 철자와 언어를 유지하고 허위 수치·워터마크·불필요한 문구를 넣지 마세요. 설명문 대신 실제 이미지 한 장만 생성하세요.`;
}
async function generateThreadsText(){
  if(threadsState.writingMode==='photos') {
    await generateSocialPhotoText('threads',threadsState);
    await saveThreads();return;
  }
  if(!threadsState.topic.trim()) throw new Error('주제와 요청사항을 입력하세요.');
  const count=threadsState.count;
  const postCount=threadsState.postCount;
  const postFormat=threadsState.postFormat;
  const imageStyle=threadsState.imageStyle;
  if(postFormat==='cardnews') threadsCardRoles(count);
  const english=typeof useEnglishPrompts==='function'&&useEnglishPrompts();
  te('threadsStatus').textContent='Threads 글과 이미지 프롬프트를 생성 중입니다.';
  const result=await sendRuntimeMessage({type:'NB_SUBMIT_AI',provider:threadsState.provider,
    prompt:(english?localizedInstructions`Write natural conversational English for Threads, using short paragraphs. Do not invent facts, statistics or experiences. Avoid excessive hashtags and Markdown. Each post must be at most 450 characters. ${postCount>1?`Return exactly ${postCount} connected posts with an introduction, distinct supporting points and conclusion. Do not repeat content or break sentences. Images attach only to the first post.`:'Return one post.'}
Return only JSON with ${postCount===1?'"text": "Post"':'"posts": ["First post", "Continuation"]'} and "image_prompts": an array of exactly ${count} distinct ${writingLanguageName()} image-generation instructions (empty when zero). Follow explicit user output-language requests; otherwise use ${writingLanguageName()}. User topic and instructions: ${threadsState.topic}`:`Threads용 한국어 게시글을 작성하세요. 450자 이내, 자연스러운 대화체, 짧은 단락으로 작성하고 없는 경험·수치를 만들지 마세요. 해시태그 남발과 마크다운은 피하세요.
사용자 주제와 요청: ${threadsState.topic}
JSON만 반환하세요: ${postCount===1?'{"text":"게시글","image_prompts":[]}':'{"posts":["첫 번째 글","이어지는 글"],"image_prompts":[]}'}
${postCount>1?`posts 배열은 정확히 ${postCount}개의 문자열로 작성하세요. 각 글은 450자 이내로, 도입 → 내용 전개 → 결론을 연결하세요. 같은 내용을 반복하지 말고 문장 중간에서 끊지 마세요. 이미지는 첫 번째 글에만 첨부됩니다.`:''}
image_prompts는 서로 다른 이미지 1장씩의 구체적인 생성 지시 문자열로 정확히 ${count}개 작성하세요. 0장이면 빈 배열입니다.`)+buildThreadsVisualPlanInstructions(postFormat,count,imageStyle,english),
    options:buildAiSubmitOptions({collectImages:false,timeoutMs:240000})});
  if(!result.ok)throw new Error(result.error);
  const value=parseJsonFromText(result.response?.text||'');
  const posts=postCount===1?[value?.text]:value?.posts;
  if(!Array.isArray(posts)||posts.length!==postCount||posts.some(p=>typeof p!=='string'||!p.trim()||Array.from(p.trim()).length>500)
    ||!Array.isArray(value.image_prompts)||value.image_prompts.length!==count||value.image_prompts.some(p=>typeof p!=='string'||!p.trim()))throw new Error('글·이미지 프롬프트 형식이 맞지 않습니다. 기존 결과를 유지했습니다. 다시 생성하세요.');
  const slides=postFormat==='cardnews'?validateThreadsCardSlides(value.card_slides,count):[];
  if(threadsState.postCount!==postCount||threadsState.count!==count||threadsState.postFormat!==postFormat||threadsState.imageStyle!==imageStyle)throw new Error('생성 중 구성이 변경되었습니다. 다시 생성하세요.');
  threadsState.cardSlides=slides;threadsState.planFormat=postFormat;
  threadsState.text=posts[0].trim();threadsState.continuations=posts.slice(1).map(p=>p.trim());threadsState.prompts=value.image_prompts;await saveThreads();
  te('threadsStatus').textContent='글과 프롬프트가 준비되었습니다. 확인 후 이미지를 생성하거나 작성창에 넣으세요.';
}
async function generateThreadsImages(){
  if(threadsState.writingMode==='photos')return;
  const count=threadsState.count;
  if(!count||threadsState.prompts.length!==count||threadsState.prompts.some(p=>!p.trim()))throw new Error('이미지 장수를 선택하고 해당 장수의 프롬프트를 준비하세요.');
  if(threadsState.planFormat!==threadsState.postFormat)throw new Error('구성 변경 후 글·이미지 프롬프트를 다시 생성하세요. 기존 결과는 유지됩니다.');
  if(threadsState.postFormat==='cardnews') validateThreadsCardSlides(threadsState.cardSlides,count);
  const images=[];
  for(let i=0;i<count;i++){
    te('threadsStatus').textContent=`이미지 ${i+1}/${count}장 생성 중입니다. 전체 완료 전에는 기존 이미지를 유지합니다.`;
    const result=await sendRuntimeMessage({type:'NB_SUBMIT_AI',provider:threadsState.imageProvider,
      prompt:buildThreadsImagePrompt(i),
      options:buildAiSubmitOptions({imageMode:true,collectImages:true,timeoutMs:300000})});
    if(!result.ok)throw new Error(result.error);
    images.push(await prepareInstagramImage(result.response?.images?.[0],false,false,true));
  }
  threadsState.images=images;te('threadsStatus').textContent='이미지가 준비되었습니다. 순서를 확인하세요.';
}
async function executeInsertThreads(){
  if(activeNaverEditorKind!=='threads'||!activeNaverTabId)throw new Error('Threads 홈·프로필에서 현재 탭 연결하기를 눌러 주세요.');
  const text=threadsState.text.trim();
  const posts=threadsState.postCount>1?[text,...threadsState.continuations.map(p=>p.trim())]:[text];
  if(posts.length!==threadsState.postCount||posts.some(p=>!p||Array.from(p).length>500))throw new Error('선택한 글 개수에 맞게 각 글을 1~500자로 준비하세요.');
  if(!text||Array.from(text).length>500)throw new Error('게시글은 1~500자로 입력하세요.');
  if(threadsState.images.length!==threadsState.count)throw new Error('선택한 장수와 준비된 이미지 개수를 맞춰 주세요.');
  const images=threadsState.images.map(({dataUrl,width,height})=>({dataUrl,width,height}));
  te('threadsStatus').textContent='Threads 작성창에 입력 중입니다.';
  const result=await sendRuntimeMessage({type:'NB_INSERT_POST',tabId:activeNaverTabId,options:{timeoutMs:180000},payload:{platform:'threads',text,posts,images}});
  if(!result.ok)throw new Error(result.error);
  te('threadsStatus').textContent='입력했습니다. 글·이미지를 확인하고 게시 버튼을 직접 누르세요.';
  return result.insertion;
}
