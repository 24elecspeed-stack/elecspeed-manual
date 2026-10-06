// Localize report headings/labels, never user text, URLs or raw diagnostic logs.
function photoWriterStatusText(source,language='ko') {
  const index=({ko:0,en:1,ja:2,es:3})[language] ?? 0;
  const rows=[
    ['준비 단계','Preparing','準備中','Preparando'],
    ['1단계 비전 분석 완료','Step 1: photo analysis complete','ステップ1: 写真分析完了','Paso 1: análisis de fotos completado'],
    ['2단계 블로그 본문 작성','Step 2: writing the article','ステップ2: 記事作成','Paso 2: redacción del artículo'],
    ['추가 요청 반영 본문 재작성','Rewriting with feedback','要望を反映して再作成','Reescribiendo con comentarios'],
    ['3단계 사진 본문 결합','Step 3: assembling photos and article','ステップ3: 写真と記事の結合','Paso 3: combinar fotos y artículo'],
    ['AI 블로그 글 작성 준비 중...','Preparing the AI article...','AI記事を準備中…','Preparando el artículo con IA...'],
    ['입력하신 내용과 첨부 사진을 검토하고 있습니다.','Reviewing your notes and attached photos.','入力内容と添付写真を確認中です。','Revisando tus notas y fotos adjuntas.'],
    ['📷 1단계: 사진 비전 분석 시작','📷 Step 1: starting photo analysis','📷 ステップ1: 写真分析を開始','📷 Paso 1: iniciar el análisis de fotos'],
    ['📷 1단계: 사진 비전 분석 완료!','📷 Step 1: photo analysis complete!','📷 ステップ1: 写真分析完了！','📷 Paso 1: ¡análisis de fotos completado!'],
    ['✍️ 2단계: 비전 분석 기반 블로그 글 작성 중...','✍️ Step 2: writing from photo analysis...','✍️ ステップ2: 写真分析をもとに記事を作成中…','✍️ Paso 2: redactando a partir del análisis de fotos...'],
    ['사진들의 시각적 특징을 본문에 생생하게 녹여내고 최적의 위치에 사진을 배치하며 글을 작성하고 있습니다.','Writing the article using visible photo details and arranging photos in relevant places.','写真の特徴を記事に反映し、適切な位置に写真を配置しています。','Redactando el artículo con los detalles visibles de las fotos y colocándolas donde corresponda.'],
    ['🔄 추가 요청 반영하여 본문 재작성 중...','🔄 Rewriting with your feedback...','🔄 要望を反映して記事を再作成中…','🔄 Reescribiendo con tus comentarios...'],
    ['기존 사진 분석 결과를 유지한 채, 추가 요청사항을 반영하여 본문 내용과 사진 배치를 새롭게 다듬고 있습니다.','Refining the article and photo placement with your feedback while keeping the existing photo analysis.','写真分析の結果を保持し、要望を反映して記事と写真の配置を調整しています。','Mejorando el artículo y la distribución de fotos con tus comentarios, conservando el análisis existente.'],
    ['🧩 3단계: 사진 본문 결합 및 페이지 완성 중...','🧩 Step 3: assembling the article and photos...','🧩 ステップ3: 記事と写真を結合中…','🧩 Paso 3: combinando el artículo y las fotos...'],
    ['작성된 본문에 사용자의 원본 사진들을 완벽하게 결합하고 있습니다.','Combining the written article with your original photos.','作成した記事に元の写真を組み合わせています。','Combinando el artículo redactado con tus fotos originales.'],
    ['🤖 대표 썸네일이 \'AI 자율 선정\' 모드로 전환되었습니다.','🤖 AI will choose the cover photo.','🤖 カバー写真をAIが選ぶモードに変更しました。','🤖 La IA elegirá la foto de portada.'],
    ['✅ 이전 작성 내용과 사진이 완벽히 복원되었습니다!','✅ Previous notes and photos restored!','✅ 以前のメモと写真を復元しました！','✅ ¡Notas y fotos anteriores restauradas!']
  ];
  const text=String(source),row=rows.find(values=>values.includes(text));
  if(row)return row[index];
  const patterns=[
    [/^1단계 비전 분석 시작 \(총 (\d+)장\)$/,n=>[`1단계 비전 분석 시작 (총 ${n}장)`,`Step 1: starting analysis (${n} photos)`,`ステップ1: 分析開始（写真${n}枚）`,`Paso 1: iniciar análisis (${n} fotos)`]],
    [/^1단계 비전 분석 \((\d+)\/(\d+)차\)$/, (n,t)=>[`1단계 비전 분석 (${n}/${t}차)`,`Step 1: photo analysis (${n}/${t})`,`ステップ1: 写真分析（${n}/${t}回目）`,`Paso 1: análisis de fotos (${n}/${t})`]],
    [/^📷 1단계: 사진 비전 분석 중\.\.\. \((\d+)\/(\d+)차\)$/, (n,t)=>[`📷 1단계: 사진 비전 분석 중... (${n}/${t}차)`,`📷 Step 1: analyzing photos... (${n}/${t})`,`📷 ステップ1: 写真を分析中…（${n}/${t}回目）`,`📷 Paso 1: analizando fotos... (${n}/${t})`]],
    [/^총 (\d+)장의 사진을 (\d+)회\(10장 단위\)로 나누어 (.+) 비전 모델로 분석합니다\.$/, (n,t,p)=>[`총 ${n}장의 사진을 ${t}회(10장 단위)로 나누어 ${p} 비전 모델로 분석합니다.`,`Analyzing ${n} photos in ${t} batches of up to 10 with ${p}.`,`写真${n}枚を最大10枚ずつ${t}回に分け、${p}で分析します。`,`Analizando ${n} fotos en ${t} grupos de hasta 10 con ${p}.`]],
    [/^\[(\d+)번 ~ (\d+)번 사진\] \(총 (\d+)장\)을 대화창에 첨부하여 시각적 내용을 분석하고 있습니다\.$/, (a,b,n)=>[`[${a}번 ~ ${b}번 사진] (총 ${n}장)을 대화창에 첨부하여 시각적 내용을 분석하고 있습니다.`,`Attaching photos ${a}–${b} (${n} total) to the chat for visual analysis.`,`全${n}枚のうち写真${a}～${b}をチャットに添付し、内容を分析中です。`,`Adjuntando fotos ${a}–${b} (${n} en total) al chat para su análisis visual.`]],
    [/^총 (\d+)장의 사진 분석이 완료되었습니다\. 이제 블로그 본문 작성을 시작합니다\.$/, n=>[`총 ${n}장의 사진 분석이 완료되었습니다. 이제 블로그 본문 작성을 시작합니다.`,`Analysis of ${n} photos is complete. Starting article writing.`,`写真${n}枚の分析が完了しました。記事の作成を開始します。`,`Se ha completado el análisis de ${n} fotos. Iniciando la redacción del artículo.`]],
    [/^✨ 추가 요청사항이 반영되었습니다! \(버전: v(.+)\)$/, v=>[`✨ 추가 요청사항이 반영되었습니다! (버전: v${v})`,`✨ Feedback applied! (version: v${v})`,`✨ 要望を反映しました！（バージョン: v${v}）`,`✨ ¡Comentarios aplicados! (versión: v${v})`]],
    [/^⭐ '([\s\S]*)'이\(가\) 대표 썸네일로 지정되었습니다\.$/, name=>[`⭐ '${name}'이(가) 대표 썸네일로 지정되었습니다.`,`⭐ '${name}' selected as the cover photo.`,`⭐ '${name}'をカバー写真に指定しました。`,`⭐ '${name}' seleccionada como foto de portada.`]]
  ];
  for(const [pattern,format] of patterns){const match=text.match(pattern);if(match)return format(...match.slice(1))[index];}
  return text;
}
function buildPhotoDiagnosticReport(state, background, manifest, provider, language = 'ko') {
  const i = ({ko:0,en:1,ja:2,es:3})[language] ?? 0;
  const labels = {
    title:['사진 글쓰기 시스템 진단 리포트','Photo writing diagnostic report','写真記事作成の診断レポート','Informe de diagnóstico de redacción con fotos'],
    intro:['아래 내용을 복사하여 AI 어시스턴트에게 붙여넣으면 오류와 지연 원인을 분석하는 데 도움이 됩니다. 전송 전에 개인정보를 확인해 주세요.','Paste this report into your AI chat to help diagnose errors and delays. Review personal information before sending.','このレポートをAIチャットに貼り付けると、エラーや遅延の調査に役立ちます。送信前に個人情報を確認してください。','Pega este informe en el chat de IA para ayudar a diagnosticar errores y retrasos. Revisa los datos personales antes de enviarlo.'],
    environment:['기본 환경 및 현재 작업 상태','Environment and current task','環境と現在の作業状態','Entorno y tarea actual'],
    date:['일시','Date and time','日時','Fecha y hora'], version:['확장 프로그램 버전','Extension version','拡張機能のバージョン','Versión de la extensión'],
    ai:['사용 AI','AI provider','AIサービス','Proveedor de IA'], step:['현재 단계','Current step','現在のステップ','Paso actual'],
    elapsed:['경과 시간(초)','Elapsed time (seconds)','経過時間（秒）','Tiempo transcurrido (segundos)'],
    topic:['주제','Topic','テーマ','Tema'], length:['본문 입력 길이(자)','Input length (characters)','入力文字数','Longitud del texto (caracteres)'],
    tone:['어조/가이드','Tone / guide','文体・ガイド','Tono / guía'], photos:['첨부된 사진 수','Attached photo count','添付写真数','Cantidad de fotos adjuntas'],
    photoList:['사진 세부 목록','Photo details','写真の詳細','Detalles de las fotos'], missing:['없음','None','なし','Ninguno'],
    unknownSize:['크기 정보 없음','Size unknown','サイズ不明','Tamaño desconocido'], note:['메모','Note','メモ','Nota'], analysis:['분석','Analysis','分析','Análisis'],
    web:['웹페이지 및 DOM 실시간 상태','Web page and DOM status','ウェブページとDOMの状態','Estado de la página y del DOM'],
    tab:['탭 ID','Tab ID','タブID','ID de pestaña'], active:['활성','Active','アクティブ','Activa'], loading:['로드 상태','Loading status','読み込み状態','Estado de carga'],
    url:['페이지 URL','Page URL','ページURL','URL de la página'], dedicated:['전용 탭','Dedicated tab','専用タブ','Pestaña dedicada'],
    notFound:['감지되지 않음','Not detected','未検出','No detectada'], pageTitle:['페이지 제목','Page title','ページタイトル','Título de la página'],
    ready:['DOM 준비 상태','DOM ready state','DOM準備状態','Estado de preparación del DOM'],
    streaming:['답변 생성 중지 버튼 노출(스트리밍 중)','Stop-response button visible (streaming)','応答停止ボタンの表示（生成中）','Botón para detener la respuesta visible (generando)'],
    yes:['예','Yes','はい','Sí'], no:['아니오','No','いいえ','No'], thumbnails:['대화창 내 첨부된 이미지 썸네일 수','Attached image thumbnails in chat','チャット内の添付画像サムネイル数','Miniaturas de imágenes adjuntas en el chat'],
    editor:['입력 에디터','Input editor','入力エディター','Editor de entrada'], found:['감지됨','Detected','検出済み','Detectado'],
    tag:['태그','Tag','タグ','Etiqueta'], characters:['글자 수','Character count','文字数','Cantidad de caracteres'], focus:['포커스','Focused','フォーカス','Enfocado'], visible:['가시성','Visible','表示','Visible'],
    preview:['에디터 내용 미리보기','Editor text preview','入力内容のプレビュー','Vista previa del texto del editor'], send:['전송 버튼','Send button','送信ボタン','Botón de envío'],
    disabled:['비활성','Disabled','無効','Desactivado'], candidates:['전송 버튼 후보 수','Send-button candidate count','送信ボタン候補数','Cantidad de botones de envío candidatos'],
    blocks:['생성된 응답 블록 개수','Response block count','応答ブロック数','Cantidad de bloques de respuesta'],
    responseLength:['마지막 응답 길이(자)','Last response length (characters)','最後の応答文字数','Longitud de la última respuesta (caracteres)'],
    responsePreview:['마지막 응답 앞부분','Last response preview','最後の応答の冒頭','Inicio de la última respuesta'],
    snapshot:['DOM 스냅샷 수집 결과','DOM snapshot result','DOMスナップショット取得結果','Resultado de la captura del DOM'],
    logs:['최근 시스템 및 브라우저 실행 로그','Recent system and browser logs','最近のシステム・ブラウザ実行ログ','Registros recientes del sistema y del navegador'],
    contentLogs:['콘텐츠 스크립트 내부 로그','Content script logs','コンテンツスクリプトのログ','Registros del script de contenido']
  };
  const t = key => labels[key][i], boolean = value => value ? t('yes') : t('no');
  const date = new Intl.DateTimeFormat(({ko:'ko-KR',en:'en-US',ja:'ja-JP',es:'es-ES'})[language] || 'ko-KR', {
    dateStyle:'medium',timeStyle:'medium',timeZone:'Asia/Seoul'
  }).format(new Date());
  let report = `# 🩺 ${provider} ${t('title')}\n\n> ${t('intro')}\n\n### 1. ${t('environment')}\n`;
  const field = (key,value) => { report += `- **${t(key)}**: ${value}\n`; };
  field('date',date); field('version',`v${manifest.version}`); field('ai',provider);
  field('step',`${state.step} (${state.currentPhase ? photoWriterStatusText(state.currentPhase,language) : t('missing')})`);
  field('elapsed',state.stepStartTime ? Math.floor((Date.now()-state.stepStartTime)/1000) : 0);
  field('topic',state.topic || t('missing')); field('length',state.content?.length || 0);
  field('tone',`${state.tone} / ${state.guide ? state.guide.slice(0,50)+'...' : t('missing')}`);
  field('photos',state.uploadedImages.length);
  if(state.uploadedImages.length){
    field('photoList','');
    state.uploadedImages.forEach((img,n)=>{
      report += `  ${n+1}. ${img.name} (${img.size || t('unknownSize')})${img.label ? ` [${t('note')}: "${img.label}"]` : ''}${img.visionDescription ? ` [${t('analysis')}: "${img.visionDescription.slice(0,30)}..."]` : ''}\n`;
    });
  }
  report += `\n### 2. ${provider} ${t('web')}\n`;
  const tab=background?.tabInfo,diag=background?.geminiDiagnostics?.diagnostics;
  if(tab){field('tab',`${tab.id} (${t('active')}: ${boolean(tab.active)}, ${t('loading')}: ${tab.status})`);field('url',tab.url);}
  else field('dedicated',`${provider}: ${t('notFound')} ⚠️`);
  if(diag){
    field('pageTitle',`"${diag.title}"`);field('ready',diag.readyState);field('streaming',boolean(diag.isGeneratingResponse));field('thumbnails',diag.attachedThumbnailsCount);
    const ed=diag.editor || {},sb=diag.sendButton || {},rp=diag.responses || {};
    field('editor',ed.found ? `${t('found')} (${t('tag')}: ${ed.tagName}, ${t('characters')}: ${ed.textLength}, ${t('focus')}: ${boolean(ed.isFocused)}, ${t('visible')}: ${boolean(ed.visible)})` : `❌ ${t('notFound')}`);
    if(ed.found && ed.textPreview)field('preview',`"${ed.textPreview}"`);
    field('send',sb.found ? `${t('found')} (${t('tag')}: ${sb.tagName}, aria-label: "${sb.ariaLabel}", ${t('disabled')}: ${boolean(sb.disabled)}, ${t('visible')}: ${boolean(sb.visible)})` : `❌ ${t('notFound')}`);
    if(sb.detectedCandidatesCount !== undefined)field('candidates',sb.detectedCandidatesCount);
    field('blocks',rp.count);if(rp.lastResponseLength){field('responseLength',rp.lastResponseLength);field('responsePreview',`"${rp.lastResponsePreview}"`);}
  } else if(background?.geminiDiagnostics?.error || background?.error){
    field('snapshot',background.geminiDiagnostics?.error || background.error);
  }
  report += `\n### 3. ${t('logs')}\n\x60\x60\x60text\n`;
  for(const log of state.logs.slice(-25))report += `[${log.timestamp}] [SIDEPANEL:${log.level.toUpperCase()}] ${log.message}\n`;
  if(Array.isArray(diag?.recentLogs)){
    report += `--- [${provider}: ${t('contentLogs')}] ---\n`;
    for(const log of diag.recentLogs.slice(-15))report += `[${log.timestamp}] [CONTENT:${log.level.toUpperCase()}] ${log.message}\n`;
  }
  return report+'\x60\x60\x60\n';
}
