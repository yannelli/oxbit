import {afterEach,describe,expect,it,vi} from 'vitest';
import * as Y from 'yjs';
import {Awareness,applyAwarenessUpdate,encodeAwarenessUpdate} from 'y-protocols/awareness';
import {createKernel} from '../../../core/src/index.js';
import {DocumentService} from '../../../documents/src/index.js';
import {RuntimeFileSystem} from '../../../host-runtime/src/index.js';
import {CollaborationService} from './index.js';
import type {FeatureOptions,Persistence,RpcClient} from '@oxbit/sdk';

afterEach(()=>vi.unstubAllGlobals());
describe('shared document lifecycle',()=>{
  async function setup(collaborative=false){vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}});const server=new Y.Doc();server.getText('content').insert(0,'saved');const calls:string[]=[],writes:Record<string,unknown>[]=[],listeners=new Map<string,Set<(value:any)=>void>>();const runtime:RpcClient={connected:true,async request<T>(method:string,params:Record<string,unknown>={}){calls.push(method);if(method==='fs.read')return {path:params.path,text:'saved',revision:'r1',encoding:'utf-8',eol:'LF'} as T;if(method==='fs.write'){writes.push(params);return {path:params.path,text:params.text,revision:'r2',encoding:'utf-8',eol:'LF'} as T;}if(method==='collab.join')return {update:Buffer.from(Y.encodeStateAsUpdate(server)).toString('base64'),revision:'r1',savedText:'saved'} as T;if(method==='collab.update')Y.applyUpdate(server,Buffer.from(params.update as string,'base64'));return {ok:true} as T;},subscribe(event,listener){const set=listeners.get(event)??new Set();set.add(listener);listeners.set(event,set);return()=>{set.delete(listener);};}};const values=new Map<string,unknown>(),persistence:Persistence={get:async<T>(key:string)=>values.get(key) as T|undefined,set:async(key,value)=>{values.set(key,value);},delete:async key=>{values.delete(key);}};const kernel=createKernel(),filesystem=new RuntimeFileSystem(runtime);filesystem.collaborative=collaborative;const documents=new DocumentService(filesystem,persistence,kernel),doc=await documents.open('file.ts');const options={kernel,documents,filesystem,runtime,workbench:{notify:()=>{},openFile:async()=>{}}} as unknown as FeatureOptions;return {server,calls,writes,kernel,filesystem,documents,doc,options};}
  it('uploads recovered unsaved text and leaves closed rooms',async()=>{const fixture=await setup();fixture.doc.replace('recovered draft');const collaboration=new CollaborationService(fixture.options);await collaboration.flush();expect(fixture.server.getText('content').toString()).toBe('recovered draft');fixture.documents.discard('file.ts');expect(fixture.calls).toContain('collab.leave');expect(fixture.filesystem.shared.has('file.ts')).toBe(false);collaboration.dispose();await fixture.documents.dispose();fixture.kernel.dispose();fixture.server.destroy();});
  it('saves shared documents through fs.write and drops presence after collaboration is disabled',async()=>{
    const fixture=await setup(true);const collaboration=new CollaborationService(fixture.options);
    expect(fixture.filesystem.shared.has('file.ts')).toBe(true);
    const remote=new Y.Doc(),remoteAwareness=new Awareness(remote);remoteAwareness.setLocalState({user:{name:'Remote'}});
    applyAwarenessUpdate(fixture.doc.awareness,encodeAwarenessUpdate(remoteAwareness,[remote.clientID]),'remote');
    expect(collaboration.participants()).toHaveLength(1);
    collaboration.dispose();
    expect(fixture.doc.awareness.getStates().size).toBe(0);
    expect(fixture.filesystem.collaborative).toBe(false);expect(fixture.filesystem.beforeWrite).toBeUndefined();
    expect(fixture.filesystem.shared.size).toBe(0);
    fixture.doc.replace('unsynchronized local text');
    await fixture.documents.save('file.ts');
    expect(fixture.writes).toEqual([expect.objectContaining({path:'file.ts',text:'unsynchronized local text',expectedRevision:'r1'})]);
    expect(fixture.calls).not.toContain('collab.save');
    expect(fixture.server.getText('content').toString()).toBe('saved');
    remoteAwareness.destroy();remote.destroy();await fixture.documents.dispose();fixture.kernel.dispose();fixture.server.destroy();
  });
  it('joins clean documents opened before enabling without duplicating their text',async()=>{
    const fixture=await setup();fixture.server.getText('content').insert(5,' with shared edit');
    expect(fixture.filesystem.shared.has('file.ts')).toBe(false);
    const collaboration=new CollaborationService(fixture.options);await collaboration.flush();
    expect(fixture.filesystem.shared.has('file.ts')).toBe(true);
    expect(fixture.doc.text.toString()).toBe('saved with shared edit');
    expect(fixture.server.getText('content').toString()).toBe('saved with shared edit');
    expect(fixture.doc.savedText).toBe('saved');
    const other=await fixture.documents.open('other.ts');
    expect(fixture.filesystem.shared.has('other.ts')).toBe(true);
    expect(other.text.toString()).toBe('saved with shared edit');
    collaboration.dispose();await fixture.documents.dispose();fixture.kernel.dispose();fixture.server.destroy();
  });
  it('keeps dirty documents local when the room has unsaved shared edits',async()=>{
    const fixture=await setup();fixture.server.getText('content').insert(5,' with shared edit');fixture.doc.replace('local draft');
    const collaboration=new CollaborationService(fixture.options);await collaboration.flush();
    expect(fixture.filesystem.shared.has('file.ts')).toBe(false);
    expect(fixture.calls).toContain('collab.leave');
    expect(fixture.doc.text.toString()).toBe('local draft');
    expect(fixture.server.getText('content').toString()).toBe('saved with shared edit');
    await fixture.documents.save('file.ts');
    expect(fixture.writes).toEqual([expect.objectContaining({text:'local draft',expectedRevision:'r1'})]);
    collaboration.dispose();await fixture.documents.dispose();fixture.kernel.dispose();fixture.server.destroy();
  });
});
