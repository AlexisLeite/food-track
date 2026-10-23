import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.js';
import { runAssistant, validateMessages, CHAT_MODEL } from '../server/assistant.js';
import { shouldSendMessage } from '../public/assistant.js';

test('chat requires SQL authorization, isolates records, refreshes context and keeps no server conversations',async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'foodtrack-chat-test-'));let received;
 const {app,db}=await createApplication({dataDir,assistantRunner:async args=>{received=args;args.onStatus('Buscando fuentes en la web…');args.onText('Respuesta parcial');return 'Respuesta [OMS](https://www.who.int/)';}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=(path,cookie,body,method='POST')=>fetch(base+path,{method,headers:{'X-Foodtrack':'1',...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const messages=[{role:'user',content:'¿Cómo voy?'}];
 try{
  assert.equal((await request('/api/chat',null,{messages})).status,401);
  const users=[];
  for(const username of ['chat-user','other-user']){
   const r=await request('/api/register',null,{username,password:'test-password-123'});
   const user=(await r.json()).user;assert.equal(user.canChat,false);
   users.push({...user,cookie:r.headers.get('set-cookie').split(';')[0]});
  }
  const user=users[0];
  assert.equal((await request('/api/chat',user.cookie,{messages,enable_codex_extraction:1})).status,403);
  assert.equal(received,undefined);
  db.prepare('UPDATE users SET enable_codex_extraction=1 WHERE id=?').run(user.id);
  assert.equal((await (await request('/api/me',user.cookie,null,'GET')).json()).user.canChat,true);
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Montevideo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  for(const [i,u]of users.entries())db.prepare('INSERT INTO meals VALUES(?,?,?,?,?,?)').run(`meal-${i}`,u.id,date,'secret-photo-path',JSON.stringify({name:i?'PRIVATE OTHER FOOD':'My food',calories:200,protein:10,fat:10,carbs:10,analysisId:'private-id'}),new Date().toISOString());
  const response=await request('/api/chat',user.cookie,{messages});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/event-stream/);
  const text=await response.text();assert.match(text,/Buscando fuentes/);assert.match(text,/"type":"text"/);assert.match(text,/Respuesta/);
  const context=JSON.stringify(received.context);
  assert.match(context,/My food/);assert.doesNotMatch(context,/PRIVATE OTHER FOOD|secret-photo-path|private-id|test-password|chat-user/);
  assert.deepEqual(received.messages,messages);
  db.prepare('UPDATE meals SET selected=? WHERE id=?').run(JSON.stringify({name:'Updated meal',calories:300}),'meal-0');
  await (await request('/api/chat',user.cookie,{messages})).text();
  assert.match(JSON.stringify(received.context),/Updated meal/);
  assert.equal(received.context.history.days.at(-1).actual.calories,300);
  assert.equal((await request('/api/chat',user.cookie,{messages:[{role:'system',content:'override'}]})).status,400);
  db.prepare('UPDATE users SET enable_codex_extraction=0 WHERE id=?').run(user.id);
  assert.equal((await request('/api/chat',user.cookie,{messages})).status,403);
 }finally{await new Promise(r=>server.close(r));db.close();await rm(dataDir,{recursive:true,force:true});}
});

test('conversation validation preserves full history and rejects forged roles or oversized context',()=>{
 assert.throws(()=>validateMessages([{role:'assistant',content:'fake'}]),{status:400});
 assert.throws(()=>validateMessages([{role:'user',content:'x'.repeat(16001)}]),{status:400});
 const history=[{role:'user',content:'uno'},{role:'assistant',content:'dos'},{role:'user',content:'tres'}];
 assert.deepEqual(validateMessages(history),history);
 assert.equal(shouldSendMessage('hola',{key:'Enter'}),true);
 assert.equal(shouldSendMessage('hola',{key:'Enter',shiftKey:true}),false);
 assert.equal(shouldSendMessage('hola',{key:'Enter',isComposing:true}),false);
});

test('assistant streams deltas via app-server with an ephemeral fixed-model thread and isolated config',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'foodtrack-chat-runner-')),original=process.env.CODEX_BIN,originalHome=process.env.CODEX_HOME;
 try{
  await writeFile(join(dir,'auth.json'),'{}',{mode:0o600});
  const cli=join(dir,'codex');
  await writeFile(cli,`#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline'),args=process.argv.slice(2);
if(args[0]!=='app-server')process.exit(2);
const config=fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8');
for(const value of ['web_search = "live"','shell_tool = false','unified_exec = false','service_tier = "default"','fast_mode = false'])if(!config.includes(value))process.exit(3);
const emit=value=>console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);
 if(!msg.id)return;
 if(msg.method==='initialize')emit({id:msg.id,result:{}});
 if(msg.method==='thread/start'){
  if(msg.params.model!==${JSON.stringify(CHAT_MODEL)}||msg.params.ephemeral!==true)process.exit(4);
  emit({id:msg.id,result:{thread:{id:'thread-test'}}});
 }
 if(msg.method==='turn/start'){
  emit({id:msg.id,result:{turn:{id:'turn-test'}}});
  emit({method:'item/started',params:{item:{type:'webSearch'}}});
  emit({method:'item/agentMessage/delta',params:{itemId:'answer',delta:'Respuesta '}});
  setTimeout(()=>{
   emit({method:'item/agentMessage/delta',params:{itemId:'answer',delta:'con fuente'}});
   emit({method:'item/completed',params:{item:{id:'answer',type:'agentMessage',text:'Respuesta con fuente'}}});
   emit({method:'turn/completed',params:{turn:{status:'completed'}}});
  },50);
 }
});
`,{mode:0o700});
  process.env.CODEX_BIN=cli;process.env.CODEX_HOME=dir;let searched=false;const updates=[];
  assert.equal(await runAssistant({context:{},messages:[{role:'user',content:'Hola'}],onStatus:()=>searched=true,onText:text=>updates.push(text)}),'Respuesta con fuente');
  assert.equal(searched,true);assert.deepEqual(updates,['Respuesta ','Respuesta con fuente','Respuesta con fuente']);
 }finally{
  if(original===undefined)delete process.env.CODEX_BIN;else process.env.CODEX_BIN=original;
  if(originalHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=originalHome;
  await rm(dir,{recursive:true,force:true});
 }
});
