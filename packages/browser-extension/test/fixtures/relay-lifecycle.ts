import assert from 'node:assert/strict'
const timers: {callback: Function, delay: number}[] = []
const intervals: {callback: Function, delay: number}[] = []
;(globalThis as any).setTimeout = (callback: Function, delay: number) => { const t = {callback, delay}; timers.push(t); return t }
;(globalThis as any).clearTimeout = (t: any) => { const i=timers.indexOf(t); if(i>=0) timers.splice(i,1) }
;(globalThis as any).setInterval = (callback: Function, delay: number) => { const t = {callback, delay}; intervals.push(t); return t }
;(globalThis as any).clearInterval = (t: any) => { const i=intervals.indexOf(t); if(i>=0) intervals.splice(i,1) }
const event = () => ({ listeners: [] as Function[], addListener(fn: Function) { this.listeners.push(fn) } })
let activeGroup: number | null = 7
let tabs = [{id: 11, groupId: 7, active: true, windowId: 1, url: 'about:blank', title:'Blank'}]
const created: any[] = []
const updates: any[] = []
const debuggerCalls: any[] = []
const debuggerAttachments: number[] = []
const debuggerResults: Record<string, any> = {}
let debuggerPending: Promise<void> | undefined
let attachPending: Promise<void> | undefined
let rejectUpdate = false
const sync = {browserRelayOrigin:'http://127.0.0.1:4096'}
;(globalThis as any).chrome = {
  tabs: {
    async query(query: any) { return tabs.filter(t => (query.groupId === undefined || query.groupId === t.groupId) && (!query.active || t.active)) },
    async get(id: number) { const tab=tabs.find(t => t.id === id); if(!tab) throw Error('No tab'); return {...tab} },
    async create(args: any) { created.push(args); const t={id:100+created.length,groupId:-1,active:true,windowId:1,url:args.url,title:'New'}; tabs.forEach(t=>t.active=false); tabs.push(t); return {...t} },
    async group(args: any) { const g=args.groupId ?? 7; for(const t of tabs) if(args.tabIds.includes(t.id)) t.groupId=g; activeGroup=g; return g },
    async update(id: number, args: any) { updates.push({id,args}); if(rejectUpdate) throw Error('Navigation rejected by Chrome fixture'); Object.assign(tabs.find(t=>t.id===id)!,args); return tabs.find(t=>t.id===id) },
    async sendMessage() {}, onCreated:event(),onUpdated:event(),onRemoved:event(),onActivated:event(),
  },
  tabGroups: { async get(g: number) { if(activeGroup === g) return {id:g, windowId:1}; throw Error('No group') }, async update() {} },
  storage: { local:{ async get() { return {activeNine1TabGroupId:activeGroup ?? -1} }, async set(v:any) {activeGroup=v.activeNine1TabGroupId}, async remove() {} }, sync:{ async get() {return sync},async set(v:any) {Object.assign(sync,v)}, async remove() {} }, onChanged:event() },
  debugger: {onDetach:event(), async attach({tabId}: any) { debuggerAttachments.push(tabId); await attachPending }, async sendCommand(source: any, method:string,params:any) { debuggerCalls.push({source,method,params}); await debuggerPending; if(method==='Input.dispatchMouseEvent' && params.type==='mouseWheel' && (params.deltaX===undefined || params.deltaY===undefined)) throw Error('Invalid parameters: mouseWheel deltaX/deltaY required'); return debuggerResults[method] ?? {data:'fake-image'} } },
  runtime: {getManifest() {return {version:'0.1.0'}},onMessage:event()},
}
;(globalThis as any).self = {addEventListener(){}}
let bootstrapId='instance-A'
let fetchCount=0
let bootstrapWait: Promise<any> | undefined
;(globalThis as any).fetch = async () => {fetchCount++; if(bootstrapWait) return bootstrapWait; return {ok:true,async json(){return {serverOrigin:'http://127.0.0.1:4096',instanceId:bootstrapId}}}}
class FakeWebSocket {
  static OPEN=1
  static sockets:FakeWebSocket[]=[]
  readyState=0; onopen?:Function;onclose?:Function;onmessage?:Function;onerror?:Function;
  sent:any[]=[]
  constructor(public url:string){FakeWebSocket.sockets.push(this)}
  send(data:string){this.sent.push(JSON.parse(data))}
  close(){this.readyState=3}
  open(){this.readyState=1;this.onopen?.()}
  receive(message:any){this.onmessage?.({data:JSON.stringify(message)})}
}
;(globalThis as any).WebSocket=FakeWebSocket
const relay = await import('../../src/background/relay-client')
const {toolExecutors} = await import('../../src/tools')
const flush = async () => { for (let i=0; i<200; i++) await Promise.resolve() }
let ws: FakeWebSocket
let nextId=1
async function connect() {
  relay.connectToRelay('ws://127.0.0.1:4096/browser/extension')
  ws=FakeWebSocket.sockets.at(-1)!; ws.open(); await flush()
}
async function command(method:string, params:any, targetId?:string, sessionId?:string) {
  const id=nextId++
  ws.receive({id,method:'forwardCDPCommand',params:{method,params,targetId,sessionId}})
  await flush()
  return ws.sent.find(x=>x.id===id)
}
const scenario=process.argv[2]
if(scenario==='blank') {
  await connect()
  assert.equal((await command('Extension.callTool',{toolName:'tabs_context_mcp',args:{}})).result.isError,undefined)
  assert.equal((await command('Target.getTargets',{})).result.targetInfos[0].url,'about:blank')
  assert.match((await command('Runtime.evaluate',{expression:'1'},'11')).error,/not an automatable/)
  tabs[0].url='chrome://newtab/'
  assert.deepEqual((await command('Page.navigate',{url:'https://example.test'})).result,{frameId:'main'})
  assert.equal(updates[0].id,11)
  tabs[0].url='about:blank'
  rejectUpdate=true
  assert.match((await command('Page.navigate',{url:'https://rejected.test'})).error,/Navigation rejected/)
  rejectUpdate=false
  assert.equal((await command('Extension.callTool',{toolName:'tabs_create_mcp',args:{url:'https://created.test'}})).result.isError,undefined)
  assert.equal(created.length,1)
  tabs=[]; activeGroup=null
  const context=await command('Extension.callTool',{toolName:'tabs_context_mcp',args:{createIfEmpty:true,url:'https://empty.test'}})
  assert.equal(JSON.parse(context.result.content[0].text).totalMcpTabs,1)
  assert.equal(created.length,2)
}
if(scenario==='scope') {
  tabs.push({id:22,groupId:9,active:false,windowId:1,url:'https://outside.test',title:'Outside'})
  tabs.push({id:33,groupId:7,active:false,windowId:1,url:'https://inside.test',title:'Inside'})
  await connect()
  const good=await command('Runtime.evaluate',{expression:'1'})
  assert.ok(good.result)
  assert.equal(debuggerCalls.at(-1).source.tabId,33)
  assert.match((await command('Runtime.evaluate',{expression:'1'},'22')).error,/outside/)
  assert.match((await command('Runtime.evaluate',{expression:'1'},'not-a-tab')).error,/Invalid browser target/)
  assert.match((await command('Extension.callTool',{toolName:'computer',args:{action:'left_click',coordinate:[2,3],tabId:22}},'33')).error,/disagree/)
  assert.match((await command('Extension.callTool',{toolName:'computer',args:{action:'left_click',coordinate:[2,3],tabId:22}})).error,/outside/)
  assert.match((await command('Page.navigate',{url:'https://other.test'},'22')).error,/outside/)
  const session=ws.sent.find(x=>x.method==='forwardCDPEvent'&&x.params.method==='Target.attachedToTarget').params.params.sessionId
  tabs.find(t=>t.id===33)!.url='chrome://settings/'
  assert.match((await command('Runtime.evaluate',{expression:'1'},undefined,session)).error,/not an automatable/)
  assert.equal(debuggerCalls.length,1)
}
if(scenario==='protocol') {
  await connect()
  // Restricted bootstrap is routed through tabs.update and propagates its error.
  tabs[0].url='chrome://newtab/'
  rejectUpdate=true
  assert.match((await command('Page.navigate',{url:'https://rejected.test'},'11')).error,/Navigation rejected/)
  assert.equal(debuggerAttachments.length,0)
  rejectUpdate=false
  await command('Page.navigate',{url:'https://inside.test'},'11')
  assert.equal(updates.length,2)
  // Once scriptable, navigate uses the actual CDP dispatcher and native errors.
  debuggerResults['Page.navigate']={frameId:'native-frame'}
  assert.equal((await command('Page.navigate',{url:'https://normal.test'},'11')).result.frameId,'native-frame')
  debuggerResults['Page.navigate']={frameId:'native-frame',errorText:'net::ERR_NAME_NOT_RESOLVED'}
  assert.match((await command('Page.navigate',{url:'https://invalid.test'},'11')).error,/net::ERR_NAME_NOT_RESOLVED/)
  assert.equal(updates.length,2)
  tabs.push({id:33,groupId:7,active:true,windowId:1,url:'https://other.test',title:'Other'})
  tabs[0].active=false
  assert.ok((await command('Page.handleJavaScriptDialog',{accept:true,promptText:'fixture'},'11')).result)
  assert.deepEqual(debuggerCalls.at(-1),{source:{tabId:11},method:'Page.handleJavaScriptDialog',params:{accept:true,promptText:'fixture'}})
  debuggerResults['Page.getLayoutMetrics']={cssContentSize:{x:0,y:0,width:1280,height:4000}}
  debuggerResults['Page.captureScreenshot']={data:'fullpage-fixture'}
  assert.equal((await command('Page.captureScreenshot',{fullPage:true,format:'jpeg',quality:73},'11')).result.data,'fullpage-fixture')
  assert.deepEqual(debuggerCalls.at(-1),{source:{tabId:11},method:'Page.captureScreenshot',params:{format:'jpeg',quality:73,fromSurface:true,captureBeyondViewport:true,clip:{x:0,y:0,width:1280,height:4000,scale:1}}})
  assert.match((await command('Unknown.method',{},'11')).error,/Unsupported CDP method/)
}
if(scenario==='bridge') {
  const { BridgeServer } = await import('../../../browser-mcp-server/src/bridge/server')
  await connect()
  const bridge=new BridgeServer()
  ;(bridge as any).relay={
    extensionConnected:()=>true,getTools:()=>[],getTargets:()=>[],
    sendCommand:async(method:string,params:any,targetId?:string)=>{
      const response=await command(method,params,targetId)
      assert.ok(response,`Missing relay response for ${method}`)
      if(response.error) throw new Error(response.error)
      return response.result
    },
  }
  assert.equal((await bridge.listTabs('user'))[0].id,'11')
  tabs[0].url='chrome://newtab/'
  rejectUpdate=true
  await assert.rejects(bridge.navigate('',{url:'https://rejected.test'},'user'),/Navigation rejected/)
  rejectUpdate=false
  await bridge.navigate('',{url:'https://inside.test'},'user')
  assert.equal(debuggerAttachments.length,0)
  debuggerResults['Page.navigate']={frameId:'f',errorText:'net::ERR_ABORTED'}
  await assert.rejects(bridge.navigate('11',{url:'https://normal-failed.test'},'user'),/net::ERR_ABORTED/)
  debuggerResults['Page.getLayoutMetrics']={cssContentSize:{width:1280,height:4000}}
  debuggerResults['Page.captureScreenshot']={data:'fixture-image'}
  assert.deepEqual(await bridge.screenshot('11',{fullPage:true,format:'jpeg',quality:71},'user'),{data:'fixture-image',mimeType:'image/jpeg'})
  assert.equal(debuggerCalls.at(-1).params.clip.height,4000)
  await bridge.handleDialog('11','dismiss',undefined,'user')
  assert.deepEqual(debuggerCalls.at(-1),{source:{tabId:11},method:'Page.handleJavaScriptDialog',params:{accept:false}})
  tabs=[];activeGroup=null
  assert.deepEqual(await bridge.navigate('',{action:'new_tab',url:'about:blank'},'user'),{tabId:'101'})
  assert.equal((await bridge.listTabs('user'))[0].url,'about:blank')
}
if(scenario==='pending_page') {
  tabs[0].url='https://inside.test'
  await connect(); const stale=ws
  let release!:()=>void
  attachPending=new Promise(resolve=>release=resolve)
  ws.receive({id:91,method:'forwardCDPCommand',params:{method:'Page.reload',targetId:'11',params:{}}})
  await flush(); assert.equal(debuggerAttachments.length,1)
  relay.disconnectFromRelay();await connect();release();await flush()
  assert.equal(debuggerCalls.length,0)
  assert.equal(ws.sent.some(x=>x.id===91),false)
  // A multi-stage full-page command must not dispatch a screenshot after an
  // obsolete connection's metrics response finally arrives.
  debuggerResults['Page.getLayoutMetrics']={cssContentSize:{width:1280,height:4000}}
  debuggerPending=new Promise(resolve=>release=resolve)
  ws.receive({id:92,method:'forwardCDPCommand',params:{method:'Page.captureScreenshot',targetId:'11',params:{fullPage:true}}})
  await flush();assert.equal(debuggerCalls.at(-1).method,'Page.getLayoutMetrics')
  relay.disconnectFromRelay();await connect();debuggerPending=undefined;release();await flush()
  assert.equal(debuggerCalls.some(call=>call.method==='Page.captureScreenshot'),false)
  assert.equal(ws.sent.some(x=>x.id===92),false)
  stale.onclose?.();assert.equal(relay.isRelayConnected(),true)
}
if(scenario==='stale') {
  await connect();const stale=ws
  relay.disconnectFromRelay(); relay.connectToRelay('ws://127.0.0.1:5000/browser/extension')
  ws=FakeWebSocket.sockets.at(-1)!;ws.open();await flush()
  const timersBefore=timers.length, intervalsBefore=intervals.length, sentBefore=ws.sent.length
  stale.onclose?.();stale.onerror?.(new Error('old'));stale.onopen?.();stale.receive({method:'ping'})
  await flush()
  assert.equal(relay.isRelayConnected(),true)
  assert.equal(timers.length,timersBefore);assert.equal(intervals.length,intervalsBefore);assert.equal(ws.sent.length,sentBefore)
  relay.disconnectFromRelay()
  assert.equal(intervals.length,0);assert.equal(timers.length,0)
}
if(scenario==='bootstrap') {
  let resolveBootstrap!:(value:any)=>void
  bootstrapWait=new Promise(resolve=>resolveBootstrap=resolve)
  relay.connectToRelay();relay.connectToRelay();await flush()
  assert.equal(fetchCount,1)
  relay.disconnectFromRelay();relay.connectToRelay('ws://127.0.0.1:5000/browser/extension')
  ws=FakeWebSocket.sockets.at(-1)!;ws.open();await flush()
  resolveBootstrap({ok:true,json:async()=>({serverOrigin:'http://old.test',instanceId:'old'})})
  await flush()
  assert.equal(FakeWebSocket.sockets.length,1);assert.equal(relay.isRelayConnected(),true)
  assert.equal(sync.browserRelayOrigin,'http://127.0.0.1:4096')
}
if(scenario==='pending') {
  tabs[0].url='https://inside.test'
  let finishOld!:(value:any)=>void, finishNew!:(value:any)=>void
  let oldSignal: AbortSignal | undefined, newSignal: AbortSignal | undefined
  toolExecutors.computer=async (_args,context)=> {oldSignal=context?.signal;return await new Promise(resolve=>finishOld=resolve)}
  await connect(); const stale=ws
  const pending={id:77,method:'forwardCDPCommand',params:{method:'Extension.callTool',targetId:'11',params:{toolName:'computer',args:{action:'wait'}}}}
  ws.receive(pending);await flush();assert.equal(oldSignal?.aborted,false)
  relay.disconnectFromRelay();await flush();assert.equal(oldSignal?.aborted,true)
  assert.equal(timers.length,0)
  await connect()
  toolExecutors.computer=async (_args,context)=>{newSignal=context?.signal;return await new Promise(resolve=>finishNew=resolve)}
  ws.receive(pending);await flush();assert.equal(newSignal?.aborted,false)
  finishOld({content:[{type:'text',text:'old result'}]});await flush();stale.onclose?.();await flush()
  assert.equal(ws.sent.some(x=>x.id===77),false)
  ws.receive({id:78,method:'cancelCDPCommand',params:{commandId:77}});await flush()
  assert.equal(ws.sent.find(x=>x.id===78).result.cancelled,1)
  assert.equal(newSignal?.aborted,true)
  finishNew({content:[{type:'text',text:'new result'}]});await flush()
  assert.match(ws.sent.find(x=>x.id===77).error,/cancelled/)
  assert.equal(timers.length,0)
}
if(scenario==='reconnect') {
  relay.connectToRelay();await flush();ws=FakeWebSocket.sockets.at(-1)!;ws.open();await flush()
  assert.equal(ws.sent.find(x=>x.method==='extension.hello').params.pairedInstanceId,'instance-A')
  ws.readyState=3;ws.onclose?.();bootstrapId='instance-B'
  assert.equal(intervals.length,0);assert.equal(timers.length,1)
  const timer=timers.pop()!;timer.callback();await flush()
  ws=FakeWebSocket.sockets.at(-1)!;ws.open();await flush()
  assert.equal(fetchCount,2)
  assert.equal(ws.sent.find(x=>x.method==='extension.hello').params.pairedInstanceId,'instance-B')
  const obsoleteTimer=timer
  ws.onerror?.(new Error('fixture transport failure'));await flush()
  obsoleteTimer.callback();await flush()
  assert.equal(relay.isRelayConnected(),false);assert.equal(timers.length,1);assert.equal(intervals.length,0)
  relay.disconnectFromRelay();assert.equal(timers.length,0)
}
relay.disconnectFromRelay()
console.log(`PASS ${scenario}`)
