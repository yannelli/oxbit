import {afterEach,describe,expect,it,vi} from 'vitest';
import {RuntimeClient,RuntimeFileSystem} from './index.js';
import type {RpcClient} from '@oxbit/sdk';

class Socket {
  static OPEN=1;static instances:Socket[]=[];readyState=0;bufferedAmount=0;sent:any[]=[];onopen?:()=>void;onmessage?:(event:{data:string})=>void;onclose?:(event:{code:number})=>void;onerror?:()=>void;
  constructor(readonly url:string){Socket.instances.push(this);queueMicrotask(()=>{this.readyState=1;this.onopen?.();});}
  send(raw:string){const message=JSON.parse(raw);this.sent.push(message);if(message.method==='auth.authenticate')queueMicrotask(()=>this.receive({v:1,type:'response',id:message.id,result:{workspaceId:'default',workspaceKey:'test',trusted:true,capabilities:['git']}}));if(message.method==='operation.status')queueMicrotask(()=>this.receive({v:1,type:'response',id:message.id,result:{id:message.params.id,status:'completed',result:{commit:'saved'}}}));}
  receive(message:unknown){this.onmessage?.({data:JSON.stringify(message)});}
  close(){this.readyState=3;this.onclose?.({code:1000});}
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();Socket.instances=[];});
describe('runtime connection recovery',()=>{
  it('queries durable operation status after reconnect without repeating execution',async()=>{vi.useFakeTimers();vi.stubGlobal('WebSocket',Socket);const client=new RuntimeClient('http://runtime.test');await client.connect();const recovered:any[]=[];client.subscribe('operation.recovered',value=>recovered.push(value));const pending=client.request('git.commit',{message:'one commit'},{id:'commit-1'});const rejected=expect(pending).rejects.toMatchObject({code:'CONNECTION_LOST'});Socket.instances[0].close();await rejected;await vi.advanceTimersByTimeAsync(1000);expect(Socket.instances.flatMap(socket=>socket.sent).filter(message=>message.method==='git.commit')).toHaveLength(1);expect(recovered[0]).toMatchObject({id:'commit-1',status:'completed',result:{commit:'saved'}});client.dispose();});
  it('rejects oversized and buffered requests before enqueueing them',async()=>{vi.stubGlobal('WebSocket',Socket);const client=new RuntimeClient('http://runtime.test');await client.connect();await expect(client.request('fs.write',{text:'🚀'.repeat(600000)})).rejects.toMatchObject({code:'TOO_LARGE'});Socket.instances[0].bufferedAmount=1048577;await expect(client.request('fs.list')).rejects.toMatchObject({code:'BUSY'});client.dispose();});
  it('renews and disposes filesystem watches and saves detached shared documents through fs.write',async()=>{const listeners=new Map<string,Set<(value:any)=>void>>(),calls:string[]=[];const client:RpcClient={connected:true,request:async<T>(method:string)=>{calls.push(method);return {ok:true} as T;},subscribe(event,listener){const set=listeners.get(event)??new Set();set.add(listener);listeners.set(event,set);return()=>{set.delete(listener);};}};const files=new RuntimeFileSystem(client),watch=files.watch(()=>{});for(const listener of listeners.get('connection.change')??[])listener({state:'connected'});expect(calls.filter(method=>method==='fs.watch')).toHaveLength(2);watch.dispose();expect(calls.at(-1)).toBe('fs.unwatch');files.shared.set('file.ts',{revision:'old',savedText:'saved',update:''});await files.write('file.ts','local',{expectedRevision:'old'});expect(calls.at(-1)).toBe('fs.write');expect(files.shared.has('file.ts')).toBe(false);});
});

describe('collaboration routing',()=>{
  function fixture(){
    const calls:{method:string;params:Record<string,unknown>}[]=[];
    const client:RpcClient={connected:true,async request<T>(method:string,params:Record<string,unknown>={}){calls.push({method,params});if(method==='collab.join')return {update:'',revision:'room',savedText:'shared'} as T;return {path:params.path,text:'disk',revision:'disk',encoding:'utf-8',eol:'LF'} as T;},subscribe:()=>()=>{}};
    return {calls,files:new RuntimeFileSystem(client),methods:()=>calls.map(call=>call.method)};
  }
  it('reads and saves through fs.read and fs.write while collaboration is off',async()=>{
    const {files,calls,methods}=fixture();
    expect((await files.read('a.ts')).text).toBe('disk');
    await files.write('a.ts','next',{expectedRevision:'disk'});
    expect(methods()).toEqual(['fs.read','fs.write']);
    expect(calls[1]!.params).toMatchObject({path:'a.ts',text:'next',expectedRevision:'disk'});
    expect(files.shared.size).toBe(0);
  });
  it('joins rooms and saves through collab.save after flushing while collaboration is on',async()=>{
    const {files,methods}=fixture(),flush=vi.fn(async()=>{});
    files.collaborative=true;files.beforeWrite=flush;
    expect(await files.read('a.ts')).toMatchObject({text:'shared',revision:'room',sharedUpdate:''});
    await files.write('a.ts','next',{expectedRevision:'room'});
    expect(methods()).toEqual(['fs.read','collab.join','collab.save']);
    expect(flush).toHaveBeenCalledOnce();
  });
  it('keeps documents saveable when collaboration is toggled',async()=>{
    const {files,methods}=fixture();
    await files.read('local.ts');
    files.collaborative=true;files.beforeWrite=async()=>{};
    await files.read('shared.ts');
    await files.write('local.ts','next',{expectedRevision:'disk'});
    files.collaborative=false;delete files.beforeWrite;
    await files.write('shared.ts','next',{expectedRevision:'room'});
    await files.read('later.ts');
    expect(methods()).toEqual(['fs.read','fs.read','collab.join','fs.write','fs.write','fs.read']);
    expect(files.shared.size).toBe(0);
  });
});

describe('chunked binary reads',()=>{
  const base64=(bytes:Uint8Array)=>{const parts:string[]=[];for(let index=0;index<bytes.length;index+=8192)parts.push(String.fromCharCode(...bytes.subarray(index,index+8192)));return btoa(parts.join(''));};
  const server=(content:Uint8Array,tokens:string[]=['one'])=>{const requests:{offset:number;length:number}[]=[];let call=0;const client:RpcClient={connected:true,request:async<T>(_method:string,params?:Record<string,unknown>)=>{const offset=Number(params!.offset),length=Number(params!.length);requests.push({offset,length});const slice=content.subarray(offset,offset+Math.min(length,524288));return {base64:base64(slice),size:content.length,token:tokens[Math.min(call++,tokens.length-1)]} as T;},subscribe:()=>()=>{}};return {client,requests};};
  it('reassembles a file larger than one chunk in order',async()=>{const content=new Uint8Array(524288*2+9).map((_,index)=>index%251);const {client,requests}=server(content);expect([...await new RuntimeFileSystem(client).readBytes('logo.png')]).toEqual([...content]);expect(requests).toEqual([{offset:0,length:524288},{offset:524288,length:524288},{offset:1048576,length:524288}]);});
  it('requests once for a file that fits in a chunk and once for an empty file',async()=>{const {client,requests}=server(new Uint8Array([0x89,0x50,0x4e,0x47]));expect([...await new RuntimeFileSystem(client).readBytes('small.png')]).toEqual([0x89,0x50,0x4e,0x47]);expect(requests).toHaveLength(1);const empty=server(new Uint8Array());expect((await new RuntimeFileSystem(empty.client).readBytes('empty.png')).length).toBe(0);expect(empty.requests).toHaveLength(1);});
  it('rejects a file rewritten between chunks instead of stitching two versions',async()=>{const content=new Uint8Array(524288*2).fill(7);const {client}=server(content,['one','two']);await expect(new RuntimeFileSystem(client).readBytes('logo.png')).rejects.toMatchObject({code:'CONFLICT'});});
});

describe('desktop credentials and recovery identity', () => {
  it('authenticates with injected credentials without reading or writing sessionStorage', async () => {
    const getItem = vi.fn(() => 'browser-token'), setItem = vi.fn();
    vi.stubGlobal('sessionStorage', { getItem, setItem }); vi.stubGlobal('WebSocket', Socket);
    const client = new RuntimeClient('http://127.0.0.1:33001', 'default', { token: 'desktop-token', persistToken: false });
    await client.connect();
    expect(Socket.instances[0].sent[0].params.token).toBe('desktop-token');
    expect(getItem).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled();
    client.dispose();
  });
  it('keeps the same filesystem identity after the runtime changes port', () => {
    const a = new RuntimeClient('http://127.0.0.1:33001', 'default', { persistToken: false });
    const b = new RuntimeClient('http://127.0.0.1:33002', 'default', { persistToken: false });
    expect(new RuntimeFileSystem(a, 'desktop:canonical').id).toBe(new RuntimeFileSystem(b, 'desktop:canonical').id);
    expect(new RuntimeFileSystem(a).id).not.toBe(new RuntimeFileSystem(b).id);
    a.dispose(); b.dispose();
  });
});
