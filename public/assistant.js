let createMessageRenderer, rendererLoading;
const loadRenderer=()=>rendererLoading ||= import('./vendor/assistant-renderer.js?v=20261023-chat-stream-1').then(module=>{createMessageRenderer=module.createMessageRenderer;});
// Adapted from rulelab-wt AssistantWindow, assistant.css and messageKeys.
// One in-memory conversation; no persistent store, model picker or context compaction.
import { readApiResponse } from './api-response.js?v=20261023-audio-errors-1';
const icon = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const chatIcon = icon('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>');
const sendIcon = icon('<path d="m6 11 6-6 6 6M12 5v15"/>');
const micIcon = icon('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3M8 21h8"/>');
const stopIcon = icon('<rect x="6" y="6" width="12" height="12" rx="1"/>');
// Copied from Rulelab's composer, with TypeScript types removed.
export function shouldSendMessage(text, key) {
  if (key.key !== 'Enter' || key.isComposing || key.shiftKey || key.altKey || key.metaKey) return false;
  return key.ctrlKey || !/[\r\n]/.test(text);
}
export function createAssistant({notify=()=>{}}={}) {
  const host=document.createElement('div');host.id='assistant-host';host.hidden=true;
  host.innerHTML=`<section id="food-assistant" class="assistant-window" aria-label="Asistente de comida" hidden><header class="assistant-header">${chatIcon}<h2>Asistente</h2></header><div class="assistant-messages" role="log" aria-label="Conversación" aria-live="polite" aria-relevant="additions"></div><p class="assistant-status" role="status" hidden></p><form class="assistant-composer"><textarea aria-label="Mensaje al asistente" placeholder="Preguntá sobre tu alimentación…" rows="1" maxlength="8000"></textarea><button type="submit" class="assistant-send" aria-label="Enviar mensaje">${sendIcon}</button></form></section>`;
  document.body.append(host);
  const panel=host.querySelector('.assistant-window'),messagesEl=host.querySelector('.assistant-messages'),status=host.querySelector('.assistant-status'),input=host.querySelector('textarea'),form=host.querySelector('form'),button=host.querySelector('.assistant-send');
  const renderers=new Set();
  let identity=null, messages=[],busy=false,controller=null,generation=0,follow=true, recording=null, active=false, savedScroll=0;
  const focusInput=()=>{if(active&&!matchMedia('(pointer: coarse), (max-width: 600px)').matches)input.focus({preventScroll:true});};
  const scroll=()=>{if(active&&follow)messagesEl.scrollTop=messagesEl.scrollHeight;};
  messagesEl.addEventListener('scroll',()=>{if(!active)return;follow=messagesEl.scrollHeight-messagesEl.scrollTop-messagesEl.clientHeight<40;});
  const addMessage=(role,content)=>{
    const item=document.createElement('div');item.className=`assistant-message assistant-message--${role}`;
    item.setAttribute('aria-label',role==='user'?'Tu mensaje':'Asistente');messagesEl.append(item);
    const renderer=createMessageRenderer(item,{animate:role==='assistant',onProgress:scroll});renderers.add(renderer);renderer.update(content);scroll();return renderer;
  };
  const empty=()=>{
    for(const renderer of renderers)renderer.dispose();renderers.clear();
    messagesEl.replaceChildren();const intro=document.createElement('div');intro.className='assistant-intro';
    const text=document.createElement('p');text.textContent='Tus registros, un poco más claros.';intro.append(text);
    for(const prompt of ['¿Cómo voy esta semana?','¿Qué hábitos podría mejorar?','Sugerime comidas para la semana']){
      const suggestion=document.createElement('button');suggestion.type='button';suggestion.textContent=prompt;
      suggestion.onclick=()=>{input.value=prompt;form.requestSubmit();};intro.append(suggestion);
    }
    messagesEl.append(intro);
  };
  const updateButton=()=>{
    const hasText=!!input.value.trim();
    button.innerHTML=busy||recording?stopIcon:hasText?sendIcon:micIcon;
    button.setAttribute('aria-label',recording?'Detener y enviar audio':busy?'Detener respuesta':hasText?'Enviar mensaje':'Grabar audio');
    button.disabled=false;
  };
  const releaseRecording=()=>{
    if(!recording)return;
    const previous=recording;recording=null;clearTimeout(previous.timer);
    previous.chunks.length=0;previous.stream?.getTracks().forEach(track=>track.stop());
    if(previous.recorder?.state==='recording')previous.recorder.stop();
  };
  const record=async()=>{
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){notify('Este navegador no permite grabar audio.',true);return;}
    const turn=++generation,session={stream:null,chunks:[],recorder:null};recording=session;input.disabled=true;status.hidden=false;status.textContent='Activando micrófono…';updateButton();
    try{
      session.stream=await navigator.mediaDevices.getUserMedia({audio:true});
      if(turn!==generation||recording!==session){session.stream.getTracks().forEach(track=>track.stop());return;}
      const mimeType=['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(type=>MediaRecorder.isTypeSupported(type));
      const recorder=session.recorder=new MediaRecorder(session.stream,{...(mimeType?{mimeType}:{}),audioBitsPerSecond:24000});
      recorder.ondataavailable=event=>{if(turn===generation&&event.data.size)session.chunks.push(event.data);};
      recorder.onerror=()=>{releaseRecording();setBusy(false);notify('No se pudo grabar el audio.',true);};
      recorder.onstop=async()=>{
        if(turn!==generation||recording!==session)return;
        const blob=new Blob(session.chunks,{type:recorder.mimeType});releaseRecording();
        if(!blob.size||blob.size>8*1024*1024){setBusy(false);notify('Grabá un audio de hasta 8 MB.',true);return;}
        const payload=new FormData();payload.append('audio',blob,'chat.audio');
        controller=new AbortController();setBusy(true);status.textContent='Transcribiendo audio…';
        try{
          const response=await fetch('/api/transcribe',{method:'POST',credentials:'same-origin',headers:{'X-Foodtrack':'1'},body:payload,signal:controller.signal});
          const data=await readApiResponse(response);
          if(!response.ok)throw new Error(data.error||'No se pudo transcribir el audio.');
          if(turn!==generation)return;
          if(!data.text?.trim())throw new Error('No se escuchó voz. Probá de nuevo.');
          input.value=data.text.trim();setBusy(false);form.requestSubmit();
        }catch(error){if(turn===generation){setBusy(false);if(error.name!=='AbortError')notify(error.message,true);}}
        finally{payload.delete('audio');}
      };
      recorder.start();status.textContent='Grabando… Tocá detener para enviar.';
      session.timer=setTimeout(()=>{if(recorder.state==='recording')recorder.stop();},60000);
    }catch{releaseRecording();if(turn===generation){setBusy(false);notify('No se pudo acceder al micrófono. Revisá el permiso.',true);}}
  };
  const setBusy=value=>{
    busy=value;input.disabled=!!recording;updateButton();status.hidden=!value;
  };
  const viewport=()=>{
    document.documentElement.style.setProperty('--chat-page-height',`${window.visualViewport?.height??window.innerHeight}px`);
  };
  window.visualViewport?.addEventListener('resize',viewport);window.addEventListener('resize',viewport);viewport();
  input.addEventListener('input',()=>{updateButton();input.style.height='auto';input.style.height=`${Math.min(input.scrollHeight,120)}px`;});
  input.addEventListener('keydown',event=>{if(shouldSendMessage(input.value,event)){event.preventDefault();form.requestSubmit();}});
  form.onsubmit=async event=>{
    event.preventDefault();
    try { await loadRenderer(); } catch { notify('No se pudo cargar el chat. Recargá la página.',true);return; }
    if(recording){if(recording.recorder?.state==='recording')recording.recorder.stop();else if(!recording.recorder){++generation;releaseRecording();setBusy(false);}return;}
    if(busy){if(event.submitter===button)controller?.abort();return;}
    if(!input.value.trim()){await record();return;}
    const text=input.value.trim();if(!text||!identity)return;
    const turn=++generation;controller=new AbortController();follow=true;
    const outgoing=[...messages,{role:'user',content:text}];
    if(!messages.length)messagesEl.replaceChildren();addMessage('user',text);input.value='';input.style.height='auto';status.textContent='Revisando tus registros…';setBusy(true);
    let completed=false,reply=null;
    const renderReply=(text,final=false)=>{
      if(!reply)reply=addMessage('assistant','');
      final?reply.finish(text):reply.update(text);status.hidden=true;
    };
    try{
      const response=await fetch('/api/chat',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Foodtrack':'1'},body:JSON.stringify({messages:outgoing}),signal:controller.signal});
      if(!response.ok){const data=await readApiResponse(response);throw Object.assign(new Error(data.error||'No se pudo consultar al asistente.'),{status:response.status});}
      if(!response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('El servidor no devolvió una respuesta válida. Volvé a intentarlo.');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      while(true){
        const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;
        while((end=buffer.indexOf('\n\n'))>=0){
          const block=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!block.startsWith('data: '))continue;
          const data=JSON.parse(block.slice(6));if(turn!==generation)return;
          if(data.type==='status')status.textContent=data.text;
          if(data.type==='error')throw new Error(data.text);
          if(data.type==='text')renderReply(data.text);
          if(data.type==='message'){messages=[...outgoing,{role:'assistant',content:data.text}];renderReply(data.text,true);completed=true;}
        }
      }
      if(!completed)throw new Error('Se interrumpió la respuesta. Volvé a intentarlo.');
    }catch(error){
      if(turn!==generation)return;
      // Failed/cancelled turns do not contaminate the conversation context.
      const item=document.createElement('p');item.className='assistant-error';item.setAttribute('role','alert');item.textContent=error.name==='AbortError'?'Consulta detenida.':error.message;messagesEl.append(item);if(!input.value.trim())input.value=text;scroll();
      if(error.status===403)notify(error.message,true);
    }finally{if(turn===generation){setBusy(false);focusInput();}}
  };
  window.addEventListener('pagehide',()=>{++generation;controller?.abort();releaseRecording();});
  empty();setBusy(false);
  return {
    mount(slot){
      const wasActive=active;
      if(active&&!slot){savedScroll=messagesEl.scrollTop;input.blur();if(recording){++generation;releaseRecording();setBusy(false);}}
      active=!!slot&&!!identity;panel.hidden=!active;
      (active?slot:host).append(panel);
      if(active){
        loadRenderer().catch(()=>notify('No se pudo cargar el chat. Recargá la página.',true));
        requestAnimationFrame(()=>{if(active){if(follow)scroll();else messagesEl.scrollTop=savedScroll;}});
        if(!wasActive)focusInput();
      }
    },
    setUser(user){
      const next=user?.canChat?user.id:null;
      if(next!==identity){++generation;controller?.abort();releaseRecording();identity=next;messages=[];input.value='';active=false;panel.hidden=true;empty();setBusy(false);}
    }
  };
}
