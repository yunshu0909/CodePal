// @vitest-environment node
/** Cross-module behavior stays independent from read reuse. */
import {it,expect} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const docs=require('../../electron/services/docBrowserService')
const sessions=require('../../electron/services/sessionBrowserService')
it('TC-008 live markdown body and realpath confinement stay intact',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codepal-read-guard-'))
 const outside=await fs.mkdtemp(path.join(os.tmpdir(),'codepal-read-outside-'))
 try {
  docs.initDocBrowserStore({get:(_k,f)=>f.length?[root]:[root],set:()=>{}})
  const file=path.join(root,'x.md');await fs.writeFile(file,'first');await docs.listFolders()
  await fs.writeFile(file,'second');expect((await docs.readFile(file)).content).toBe('second')
  const externalFile=path.join(outside,'x.md');await fs.writeFile(externalFile,'fixture');await fs.symlink(externalFile,path.join(root,'link.md'))
  await expect(docs.readFile(path.join(root,'link.md'))).rejects.toThrow('文件不在已注册')
  await expect(sessions.readSessionPage('../escape','s',{projectsDir:root})).rejects.toThrow('INVALID_ID')
  const main=await fs.readFile(new URL('../../electron/main.js',import.meta.url),'utf8')
  const startup=main.slice(main.indexOf('getCycles:async()=>'),main.indexOf('onError:()=>console.warn'))
  expect(startup).toContain('result.plan.cycles.at(-1)')
  expect(startup).not.toContain('.metadata')
 } finally {await fs.rm(root,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true})}
})
