// @vitest-environment node
/** Root directory changes invalidate immediately; descendant-only updates retain the fixed TTL. */
import {it,expect,vi} from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const svc=require('../../electron/services/docBrowserService')
it('TC-012 root file changes invalidate before expiry and an in-flight add cannot undo removal',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codepal-root-change-'))
 const data=new Map([['docBrowser.folders',[root]]])
 svc.initDocBrowserStore({get:(k,f)=>data.get(k)??f,set:(k,v)=>data.set(k,v)})
 try {
  const file=path.join(root,'a.md');await fs.writeFile(file,'fixture')
  expect(await svc.listFiles(root)).toHaveLength(1)
  await fs.unlink(file)
  expect(await svc.listFiles(root)).toHaveLength(0)
  await fs.writeFile(path.join(root,'b.md'),'fixture')
  expect((await svc.listFiles(root))[0].name).toBe('b.md')
  svc.removeFolder(root)
  const original=fs.readdir.bind(fs);let release,started
  const gate=new Promise(r=>release=r),began=new Promise(r=>started=r)
  const scan=vi.spyOn(fs,'readdir').mockImplementationOnce(async(...args)=>{started();await gate;return original(...args)})
  const add=svc.addFolder(root);await began;svc.removeFolder(root);release()
  expect(await add).toMatchObject({success:false,errorCode:'ACCESS_DENIED'})
  expect(data.get('docBrowser.folders')).toEqual([])
  scan.mockRestore()
 } finally {vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true})}
})
