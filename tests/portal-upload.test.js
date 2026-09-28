import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient} from '../apps/web/public/assets/portal/api-client.js';

test('ZIP上传遇到超时、非JSON和服务端拒绝必须结束等待，保留会话校验',async t=>{
 let xhr,invalidated=false;
 class Upload {
  listeners={};upload={addEventListener(){}};status=200;response={version:'1.0.0'};
  constructor(){xhr=this;}open(){}setRequestHeader(){}send(){}
  addEventListener(name,fn){this.listeners[name]=fn;}
  get responseText(){throw new Error('responseType=json forbids responseText');}
 }
 const original=globalThis.XMLHttpRequest;globalThis.XMLHttpRequest=Upload;
 t.after(()=>{if(original===undefined)delete globalThis.XMLHttpRequest;else globalThis.XMLHttpRequest=original;});
 const api=createApiClient({state:{csrf:'fixture'},onSessionInvalid(){invalidated=true;}});
 let pending=api.uploadZip('/upload',{});assert.equal(xhr.timeout,300000);xhr.listeners.timeout();await assert.rejects(pending,/超时/);
 pending=api.uploadZip('/upload',{});xhr.status=502;xhr.response=null;xhr.listeners.load();await assert.rejects(pending,/无效的上传结果.*502/);
 pending=api.uploadZip('/upload',{});xhr.status=409;xhr.response={error:{message:'该版本已经发布'}};xhr.listeners.load();await assert.rejects(pending,/该版本已经发布/);
 pending=api.uploadZip('/upload',{});xhr.status=401;xhr.response={error:{message:'请重新登录'}};xhr.listeners.load();await assert.rejects(pending,/请重新登录/);assert.equal(invalidated,true);
 pending=api.uploadZip('/upload',{});xhr.listeners.load();assert.equal((await pending).version,'1.0.0');
});
