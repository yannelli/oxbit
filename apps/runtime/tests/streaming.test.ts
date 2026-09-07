import {afterEach,describe,expect,it} from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runCommand,Processes} from '../src/processes.js';
import {WorkspaceFiles} from '../src/filesystem.js';

describe('runtime streaming and symlink entries',()=>{
  const directories:string[]=[];
  afterEach(async()=>{for(const directory of directories.splice(0))await fs.rm(directory,{recursive:true,force:true});});
  it('decodes UTF-8 split across subprocess output chunks',async()=>{const result=await runCommand(process.execPath,['-e',`process.stdout.write(Buffer.from([0xf0,0x9f]));setTimeout(()=>process.stdout.write(Buffer.from([0x9a,0x80])),30);`],{cwd:os.tmpdir()});expect(result.stdout).toBe('🚀');});
  it('bounds task replay and rejects invalid replay sequence numbers',async()=>{const processes=new Processes(os.tmpdir(),()=>{});try{const task=processes.runTask('owner',`${process.execPath} -e "process.stdout.write('x'.repeat(1200000))"`);const start=Date.now();while(processes.listTasks('owner')[0]?.exitCode===undefined&&Date.now()-start<5000)await new Promise(resolve=>setTimeout(resolve,10));const replay=processes.attachTask(task.id,'owner');expect(replay.exitCode).toBe(0);expect(replay.truncated).toBe(true);expect(replay.chunks.reduce((size,chunk)=>size+Buffer.byteLength(chunk.data),0)).toBeLessThanOrEqual(1048576);expect(()=>processes.attachTask(task.id,'owner',-1)).toThrow('Invalid task sequence');}finally{processes.close();}});
  it('renames and deletes internal symlink entries without deleting their target',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'oxbit-links-'));directories.push(root);await fs.mkdir(path.join(root,'target'));await fs.writeFile(path.join(root,'target/file.txt'),'keep');await fs.symlink('target',path.join(root,'alias'));const files=new WorkspaceFiles(root);await files.rename('alias','renamed');expect((await fs.lstat(path.join(root,'renamed'))).isSymbolicLink()).toBe(true);await files.delete('renamed');expect(await fs.readFile(path.join(root,'target/file.txt'),'utf8')).toBe('keep');await fs.symlink(root,path.join(root,'target/back'));expect((await files.list('target')).map(entry=>entry.name)).not.toContain('back');});
});
