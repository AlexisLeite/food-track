// Copied/adapted from Rulelab AssistantMessage.tsx: same stable Markdown blocks,
// GFM rendering and token reveal plugin; editor-specific tools are omitted.
import React, { memo, useMemo, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { revealTextTokens } from './tokenReveal';
import { markdownBlocks } from './textPresentation';
const tokenPlugins=[revealTextTokens];
const components={a:({href,children}:any)=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>};
const MarkdownBlock=memo(function MarkdownBlock({text,reveal}:{text:string,reveal:boolean}){
 return <div className="assistant-markdown-block"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={reveal?tokenPlugins:undefined} components={components} disallowedElements={['img']}>{text}</ReactMarkdown></div>;
});
export const AssistantMessage=memo(function AssistantMessage({text,reveal,onProgress}:{text:string,reveal:boolean,onProgress:()=>void}){
 const blocks=useMemo(()=>markdownBlocks(text),[text]);
 useLayoutEffect(onProgress,[text,onProgress]);
 return <>{blocks.map((block,index)=><MarkdownBlock key={index} text={block} reveal={reveal}/>)}</>;
});
// Buffer network fragments into one paint per frame. Flush the final batch
// synchronously: there is no artificial typing queue after the response ends.
export function createMessageRenderer(element:HTMLElement,{animate=false,onProgress=()=>{}}={}){
 const root=createRoot(element),reveal=animate&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
 let text='',frame=0,disposed=false;
 const render=()=>{frame=0;if(!disposed)root.render(<AssistantMessage text={text} reveal={reveal} onProgress={onProgress}/>);};
 return {
  update(value:string){text=value;if(!frame&&!disposed)frame=requestAnimationFrame(render);},
  finish(value:string){text=value;cancelAnimationFrame(frame);frame=0;if(!disposed)flushSync(()=>root.render(<AssistantMessage text={text} reveal={reveal} onProgress={onProgress}/>));},
  dispose(){disposed=true;cancelAnimationFrame(frame);root.unmount();}
 };
}
