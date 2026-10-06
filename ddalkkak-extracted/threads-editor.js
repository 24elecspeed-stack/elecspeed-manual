// Serialized into the page; never click the publish button.
async function insertThreadsDraft(payload){
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const visible=e=>!!e&&!e.closest('[hidden],[aria-hidden="true"]')&&e.getBoundingClientRect().width>0&&getComputedStyle(e).visibility!=='hidden';
  const norm=s=>String(s||'').replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').trim();
  const name=e=>e.getAttribute('aria-label')||e.querySelector('svg[aria-label]')?.getAttribute('aria-label')||norm(e.textContent);
  const find=(root,re)=>Array.from(root.querySelectorAll('button,[role="button"]')).find(e=>visible(e)&&re.test(name(e)));
  const dialog=()=>Array.from(document.querySelectorAll('[role="dialog"]')).find(e=>visible(e)&&/새로운 스레드|New thread|新しいスレッド|新規スレッド|Nuevo hilo|Nueva publicación/i.test(e.textContent));
  let postIndex=0;
  const fields=()=>Array.from(dialog()?.querySelectorAll('[contenteditable="true"][role="textbox"]')||[]).filter(visible);
  const field=()=>fields()[postIndex];
  async function wait(fn,message,ms=15000){const start=Date.now();while(Date.now()-start<ms){const value=fn();if(value)return value;await sleep(200);}throw new Error(message);}
  let lock=false;
  try{
    if(!['www.threads.com','www.threads.net'].includes(location.hostname))throw new Error('Threads 탭이 아닙니다.');
    const posts=payload?.posts===undefined?[payload?.text]:payload.posts;
    if(!Array.isArray(posts)||posts.length<1||posts.length>10||posts.some(p=>typeof p!=='string'||!norm(p)||Array.from(norm(p)).length>500))throw new Error('연결 글은 1~10개, 각 1~500자로 준비하세요.');
    const images=payload?.images;
    let text=norm(posts[0]);
    if(!text||Array.from(text).length>500||!Array.isArray(images)||images.length>10)throw new Error('글 1~500자, 이미지 최대 10장을 준비하세요.');
    if(images.some(i=>!/^data:image\/(jpeg|png|webp);base64,/i.test(i?.dataUrl||''))||images.reduce((n,i)=>n+i.dataUrl.length,0)>24*1024*1024)throw new Error('이미지 형식·용량을 확인하세요.');
    if(window.__nbThreadsPreparing)throw new Error('이미 입력 중입니다.');
    window.__nbThreadsPreparing=true;lock=true;
    if(!dialog()){
      const open=await wait(()=>find(document,/^(새로운 스레드|New thread|新しいスレッド|新規スレッド|Nuevo hilo|Nueva publicación)$/i),'새로운 스레드 버튼을 찾지 못했습니다.');
      open.click();
    }
    let editor=await wait(field,'Threads 본문 입력란을 찾지 못했습니다.');
    const root=dialog();
    const mediaCount=()=>Array.from(root.querySelectorAll('button,[role="button"]')).filter(e=>visible(e)&&/^(삭제|제거|Remove|Delete)(?:\s|$)/i.test(name(e))).length;
    const inputs=Array.from(root.querySelectorAll('input[type="file"]')).filter(e=>/image\//.test(e.accept));
    if(norm(editor.innerText||editor.textContent)||root.querySelectorAll('[contenteditable="true"][role="textbox"]').length!==1||mediaCount()||inputs.some(e=>e.files?.length))throw new Error('기존 작성 중인 스레드가 있습니다. 먼저 작업을 마무리하세요.');
    if(images.length){
      if(inputs.length!==1||!inputs[0].multiple)throw new Error('이미지 첨부 입력란을 확인하지 못했습니다.');
      const transfer=new DataTransfer();
      for(let i=0;i<images.length;i++){const blob=await(await fetch(images[i].dataUrl)).blob();transfer.items.add(new File([blob],`threads-${i+1}.${blob.type==='image/png'?'png':blob.type==='image/webp'?'webp':'jpg'}`,{type:blob.type}));}
      inputs[0].files=transfer.files;
      inputs[0].dispatchEvent(new Event('change',{bubbles:true}));
      await wait(()=>mediaCount()===images.length,'이미지 업로드 개수를 확인하지 못했습니다. 작성창을 확인하세요.',45000);
    }
    for(postIndex=0;postIndex<posts.length;postIndex++){
    text=norm(posts[postIndex]);
    if(postIndex>0){
      const add=await wait(()=>{const button=find(root,/^(스레드에 추가|Add to thread|スレッドに追加|Añadir al hilo|Agregar al hilo)$/i);return button&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&button;},'스레드에 추가 버튼을 찾지 못했습니다. 입력된 글을 확인하세요.');
      add.click();
      await wait(()=>fields().length===postIndex+1,'다음 연결 글 입력란이 열리지 않았습니다.');
      if(norm(field()?.innerText||field()?.textContent))throw new Error('다음 글에 기존 내용이 있어 중단했습니다.');
    }
    editor=field();editor.focus();
    const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(editor);selection.removeAllRanges();selection.addRange(range);
    await sleep(180);
    if(editor.getAttribute('data-lexical-editor')==='true'){
      const data=new DataTransfer();data.setData('text/plain',text);
      const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,composed:true,clipboardData:data});
      editor.dispatchEvent(event);if(!event.defaultPrevented)throw new Error('본문 붙여넣기가 처리되지 않았습니다.');
    }else if(!document.execCommand('insertText',false,text))throw new Error('본문 입력에 실패했습니다.');
    const matches=()=>norm(field()?.innerText||field()?.textContent)===text;
    await wait(matches,'입력한 본문이 일치하지 않습니다.',5000);
    // Native editing triggers the site's change handling after controlled paste.
    editor=field();editor.focus();range.selectNodeContents(editor);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
    if(!document.execCommand('insertText',false,' '))throw new Error('입력 확정을 완료하지 못했습니다. 본문 끝에서 스페이스바를 눌러 확인하세요.');
    await sleep(250);
    if(!matches())throw new Error('입력 확정 중 본문이 변경되었습니다.');
    // A harmless trailing space is retained to commit the native edit.
    field().blur();await sleep(800);
    if(!matches())throw new Error('본문이 입력 후 변경되었습니다.');
    }
    const completed=fields();
    if(completed.length!==posts.length||completed.some((e,i)=>norm(e.innerText||e.textContent)!==norm(posts[i])))throw new Error('연결 글 전체의 입력 결과가 일치하지 않습니다.');
    return {ok:true,platform:'threads',stagedOnly:true,published:false,imageInsertedCount:images.length,postInsertedCount:posts.length,textInserted:true};
  }catch(error){return {ok:false,platform:'threads',published:false,error:error.message||String(error)};}
  finally{if(lock)delete window.__nbThreadsPreparing;}
}
if(typeof module!=='undefined')module.exports={insertThreadsDraft};
