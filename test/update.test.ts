import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, readdir, symlink } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// @ts-ignore Standalone updater intentionally runs before npm install/build.
import { chooseRelease, checkedFiles, installPrepared, update } from '../../scripts/update.mjs';
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
async function fixture(t: TestContext) {
 const root=await mkdtemp(join(tmpdir(),'moodle-updater-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=join(root,'installed');await mkdir(target);
 await writeFile(join(target,'package.json'),JSON.stringify({name:'local-moodle-mcp',version:'0.4.1'}));
 await mkdir(join(target,'materials'));await writeFile(join(target,'materials','notes.pdf'),'personal notes');
 await writeFile(join(target,'courses.json'),'personal selection');
 const source=join(root,'unnc-moodle-mcp');await mkdir(source);
 const contents: Record<string,string>={
  'package.json':JSON.stringify({name:'local-moodle-mcp',version:'0.4.2'}),
  'package-lock.json':'{}','tsconfig.json':'{}','src/server.ts':'synthetic server','src/config.ts':'synthetic config'
 };
 for(const [p,s]of Object.entries(contents)){await mkdir(join(source,p,'..'),{recursive:true});await writeFile(join(source,p),s);}
 const provenance={schemaVersion:1,dirty:false,finalCandidate:true,files:Object.entries(contents).map(([path,s])=>({path,sha256:hash(s),mode:0o644}))};
 await writeFile(join(source,'release-source.json'),JSON.stringify(provenance));
 const archive=join(root,'release.zip');if (process.platform === 'darwin') execFileSync('/usr/bin/zip',['-qr',archive,'unnc-moodle-mcp'],{cwd:root});
 else await writeFile(archive, 'Unused archive for platform-independent rollback test');
 const bytes=await readFile(archive);
 const release={tag_name:'v0.4.2',draft:false,prerelease:true,assets:[{name:'unnc-moodle-mcp-v0.4.2.zip',digest:'sha256:'+hash(bytes),browser_download_url:'https://github.com/MarkyMarkMa/unnc-moodle-mcp/releases/download/v0.4.2/unnc-moodle-mcp-v0.4.2.zip'}]};
 const fetcher=async(url:string)=>new Response(url.includes('api.github.com')?JSON.stringify([release]):bytes);
 const run=(command:string,args: string[],options: any)=>{
  if(command==='git')throw Error('Not a Git checkout');
  if(command==='npm'||command===process.execPath){mkdirSync(join(options.cwd,'dist/src'),{recursive:true});writeFileSync(join(options.cwd,'dist/src/server.js'),'built server');return Buffer.alloc(0);}
  return execFileSync(command,args,options);
 };
 return {root,target,release,bytes,fetcher,run};
}
test('release selection includes numbered prereleases and never downgrades',()=>{
 assert.equal(chooseRelease([{tag_name:'v0.4.2',draft:false,prerelease:true},{tag_name:'v0.5.0',draft:true},{tag_name:'v0.4.10',draft:false}], '0.4.1').tag_name,'v0.4.10');
 assert.equal(chooseRelease([{tag_name:'v0.4.2',draft:false}],'0.4.2'),undefined);
 assert.throws(()=>checkedFiles({schemaVersion:1,dirty:false,finalCandidate:true,files:[{path:'src/../../outside',sha256:'a'.repeat(64),mode:0o644}]}),/Unsafe/);
});
test('ZIP update keeps installation path, settings and personal materials; saves previous program',{skip:process.platform !== 'darwin'},async t=>{
 const f=await fixture(t);const result=await update(f.target,{fetcher:f.fetcher,run:f.run,acquire:async()=>async()=>{},log:()=>{}});
 assert.equal(result.version,'0.4.2');assert.equal(JSON.parse(await readFile(join(f.target,'package.json'),'utf8')).version,'0.4.2');
 assert.equal(await readFile(join(f.target,'materials/notes.pdf'),'utf8'),'personal notes');
 assert.equal(await readFile(join(f.target,'courses.json'),'utf8'),'personal selection');
 assert.equal(JSON.parse(await readFile(join(result.backup,'package.json'),'utf8')).version,'0.4.1');
 assert.equal(await readFile(join(f.target,'dist/src/server.js'),'utf8'),'built server');
 assert.ok(!(await readdir(f.target)).includes('.moodle-update-lock'));
 const again=await update(f.target,{fetcher:f.fetcher,run:f.run,acquire:async()=>async()=>{},log:()=>{}});assert.equal(again.updated,false);
});
test('checksum, download and build failures leave installed version intact and release update lock',{skip:process.platform !== 'darwin'},async t=>{
 for(const mode of ['digest','network','build']){
  const f=await fixture(t);
  if(mode==='digest')f.release.assets[0]!.digest='sha256:'+'0'.repeat(64);
  const fetcher=mode==='network'?async()=>{throw Error('offline');}:f.fetcher;
  const run=mode==='build'?(cmd:string,args:string[],opts:any)=>{if(cmd==='npm'||cmd===process.execPath)throw Error('build failed');return f.run(cmd,args,opts);}:f.run;
  await assert.rejects(update(f.target,{fetcher,run,acquire:async()=>async()=>{},log:()=>{}}));
  assert.equal(JSON.parse(await readFile(join(f.target,'package.json'),'utf8')).version,'0.4.1');
  assert.equal(await readFile(join(f.target,'materials/notes.pdf'),'utf8'),'personal notes');
  assert.ok(!(await readdir(f.target)).includes('.moodle-update-lock'));
 }
});
test('failed replacement rolls back every moved entry and preserves unrelated files',async t=>{
 const {root,target}=await fixture(t);const prepared=join(root,'prepared'),backup=join(root,'backup');
 await mkdir(prepared);await mkdir(backup);await mkdir(join(target,'src'));await writeFile(join(target,'src/old.ts'),'old');
 await mkdir(join(prepared,'src'));await writeFile(join(prepared,'src/new.ts'),'new');await writeFile(join(prepared,'package.json'),'new package');
 let calls=0;const move=async(a:string,b:string)=>{if(++calls===4)throw Error('disk failure');await rename(a,b);};
 await assert.rejects(installPrepared(target,prepared,backup,{move,idle:async()=>{}}),/disk failure/);
 assert.equal(await readFile(join(target,'src/old.ts'),'utf8'),'old');assert.equal(JSON.parse(await readFile(join(target,'package.json'),'utf8')).version,'0.4.1');
 assert.equal(await readFile(join(target,'courses.json'),'utf8'),'personal selection');
});
test('symlink destinations and occupied updater lock stop before replacing code',{skip:process.platform !== 'darwin'},async t=>{
 const f=await fixture(t);await symlink(f.root,join(f.target,'src'));
 await assert.rejects(update(f.target,{fetcher:f.fetcher,run:f.run,acquire:async()=>async()=>{},log:()=>{}}),/symlink/);
 assert.equal(JSON.parse(await readFile(join(f.target,'package.json'),'utf8')).version,'0.4.1');
 await mkdir(join(f.target,'.moodle-update-lock'));
 await assert.rejects(update(f.target,{fetcher:f.fetcher,run:f.run,acquire:async()=>async()=>{},log:()=>{}}),/Another update/);
});
