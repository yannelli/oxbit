import {afterEach,describe,expect,it} from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceFiles} from '../src/filesystem.js';
import {LanguageServer} from '../src/lsp.js';

describe('server-initiated language workspace edits',()=>{
  const directories:string[]=[],servers:LanguageServer[]=[];
  afterEach(async()=>{for(const server of servers.splice(0))await server.stop();for(const directory of directories.splice(0))await fs.rm(directory,{recursive:true,force:true});});
  it('waits for the initiating document client and propagates rejected edits',async()=>{
    const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'oxbit-lsp-edit-'));directories.push(root);const text='import { helper } from "./helper";\nexport const value = 1;\n';await fs.writeFile(path.join(root,'helper.ts'),'export const helper = 1;\n');await fs.writeFile(path.join(root,'main.ts'),text);const files=new WorkspaceFiles(root),server=new LanguageServer(files,()=>{});servers.push(server);const uri=server.uri('main.ts');await server.start();await server.notify('textDocument/didOpen',{textDocument:{uri,languageId:'typescript',version:1,text}});const snapshot=await files.read('main.ts');let applied=0;
    await server.request('workspace/executeCommand',{command:'_typescript.organizeImports',arguments:[path.join(root,'main.ts')]},undefined,async(edit:any)=>{const edits=edit.changes[uri] as any[],lines=snapshot.text.split('\n'),offset=(position:any)=>lines.slice(0,position.line).reduce((sum,line)=>sum+line.length+1,0)+position.character;let next=snapshot.text;for(const change of edits.map(edit=>({from:offset(edit.range.start),to:offset(edit.range.end),insert:edit.newText})).sort((a,b)=>b.from-a.from))next=next.slice(0,change.from)+change.insert+next.slice(change.to);await files.write('main.ts',next,{expectedRevision:snapshot.revision});applied++;return {applied:true};});expect(applied).toBe(1);expect(await fs.readFile(path.join(root,'main.ts'),'utf8')).not.toContain('import');
    await server.notify('textDocument/didChange',{textDocument:{uri,version:2},contentChanges:[{text}]});await expect(server.request('workspace/executeCommand',{command:'_typescript.organizeImports',arguments:[path.join(root,'main.ts')]},undefined,async()=>({applied:false,failureReason:'Document revision changed'}))).rejects.toMatchObject({code:'LSP_EDIT_REJECTED',message:'Document revision changed'});expect(await fs.readFile(path.join(root,'main.ts'),'utf8')).not.toContain('import');
  },30000);
});
