const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../updates.js'),'utf8');
class Element {
 constructor(tag){this.tag=tag;this.hidden=false;this.children=[];this.events={};this.attributes={};this.open=false;this.textContent=''}
 setAttribute(key,value){this.attributes[key]=value} append(...children){this.children.push(...children)}
 addEventListener(name,handler){this.events[name]=handler} contains(node){return this===node||this.children.some(child=>child.contains(node))}
 showModal(){this.open=true}close(){this.open=false}
}
async function app(state){
 const body=new Element('body');const context={console,Map,Error};const pending=[];
 const document={body,createElement:tag=>new Element(tag),addEventListener(){}};context.document=document;context.window=context;
 context.webkit={messageHandlers:{raminStation:{postMessage(message){pending.push(message);queueMicrotask(()=>context.raminNativeResolve(message.id,message.action==='updateAck'?{ok:true}:state))}}}};
 vm.runInNewContext(source,context);await new Promise(setImmediate);
 const byClass=name=>body.children.find(element=>element.className===name);
 return {context,body,pending,badge:byClass('station-update-notice'),menu:byClass('station-update-menu'),key:byClass('station-file-key'),dialog:byClass('station-update-dialog')};
}
test('no visible update notification when current',async()=>{const a=await app({available:false,currentVersion:'2.1.0',platform:'macos'});assert.equal(a.badge.hidden,true);assert.equal(a.key.hidden,true);assert.equal(a.dialog.open,false)});
test('background availability only shows a discreet badge, no dialog',async()=>{const a=await app({available:false,currentVersion:'2.1.0',platform:'windows'});await a.context.raminUpdateChanged({available:true,version:'2.1.1',currentVersion:'2.1.0'});assert.equal(a.badge.hidden,false);assert.match(a.badge.textContent,/2\.1\.1/);assert.equal(a.dialog.open,false);assert.equal(a.key.hidden,false)});
test('notification disappears when installed build is current',async()=>{const a=await app({available:true,version:'2.1.1',currentVersion:'2.1.0'});assert.equal(a.badge.hidden,false);await a.context.raminUpdateChanged({available:false,currentVersion:'2.1.1'});assert.equal(a.badge.hidden,true)});
test('check is inside the collapsed File menu on Windows',async()=>{const a=await app({available:false,currentVersion:'2.1.0',platform:'windows'});assert.equal(a.menu.hidden,true);a.key.events.click({stopPropagation(){}});assert.equal(a.menu.hidden,false);assert.equal(a.menu.children[0].textContent,'Check for Updates…')});
test('update bridge does not swallow media-library responses',async()=>{const a=await app({available:false});let called=false;const context={document:{body:new Element('body'),createElement:tag=>new Element(tag),addEventListener(){}},console,Map,Error};context.window=context;context.raminNativeResolve=()=>{called=true};vm.runInNewContext(source,context);context.raminNativeResolve(1,{message:'download complete'});assert.equal(called,true)});
