// @vitest-environment node
/** Directory reuse, fixed expiry and ownership races on disposable data. */
import {it,expect,vi,beforeEach,afterEach} from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const svc=require('../../electron/services/docBrowserService')
let root,values
beforeEach(async()=>{
 root=await fsp.mkdtemp(path.join(os.tmpdir(),'codepal-doc-cache-'))
 values=new Map([['docBrowser.folders',[root]]])
 svc.initDocBrowserStore({get:(k,f)=>values.get(k)??f,set:(k,v)=>values.set(k,v)})
 await fsp.writeFile(path.join(root,'a.md'),'# A')
})
afterEach(async()=>{vi.restoreAllMocks();vi.useRealTimers();await fsp.rm(root,{recursive:true,force:true})})
it('TC-001 listing expansion and concurrent requests reuse one independent snapshot',async()=>{
 const scan=vi.spyOn(fsp,'readdir')
 const [a,b]=await Promise.all([svc.listFolders(),svc.listFiles(root)])
 expect(a[0].fileCount).toBe(1)
 expect(b).toHaveLength(1)
 expect(scan).toHaveBeenCalledTimes(1)
 b[0].name='corrupted'
 scan.mockClear()
 expect((await svc.listFiles(root))[0].name).toBe('a.md')
 await svc.listFolders()
 expect(scan).toHaveBeenCalledTimes(0)
 svc.removeFolder(root)
 await svc.addFolder(root)
 scan.mockClear()
 await svc.listFolders();await svc.listFiles(root)
 expect(scan).toHaveBeenCalledTimes(0)
})
it('TC-002 expiry, removal during scan and same-path root replacement invalidate reuse',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-04T00:00Z'))
 await svc.listFolders()
 const scan=vi.spyOn(fsp,'readdir')
 await svc.listFiles(root);expect(scan).toHaveBeenCalledTimes(0)
 await fsp.writeFile(path.join(root,'b.md'),'# B')
 vi.setSystemTime(new Date('2026-10-04T00:00:31Z'))
 expect(await svc.listFiles(root)).toHaveLength(2);expect(scan).toHaveBeenCalledTimes(1)
 scan.mockRestore()
 svc.initDocBrowserStore({get:(k,f)=>values.get(k)??f,set:(k,v)=>values.set(k,v)})
 const original=fsp.readdir.bind(fsp);let release,started
 const began=new Promise(r=>started=r),gate=new Promise(r=>release=r)
 const slow=vi.spyOn(fsp,'readdir').mockImplementationOnce(async(...args)=>{started();await gate;return original(...args)})
 const late=svc.listFolders();await began
 svc.removeFolder(root);await svc.addFolder(root)
 release();await late
 slow.mockClear();await svc.listFiles(root);expect(slow).toHaveBeenCalledTimes(0)
 slow.mockRestore()
 const moved=root+'-old';await fsp.rename(root,moved)
 try {await fsp.mkdir(root);await fsp.writeFile(path.join(root,'new.md'),'# new');expect((await svc.listFiles(root)).map(f=>f.name)).toEqual(['new.md'])}
 finally {await fsp.rm(moved,{recursive:true,force:true})}
 await fsp.rm(root,{recursive:true,force:true})
 expect((await svc.listFolders())[0]).toMatchObject({valid:false,fileCount:0})
})
it('TC-002 a transient directory failure is retried, not retained as an empty index',async()=>{
 const scan=vi.spyOn(fsp,'readdir').mockRejectedValueOnce(Object.assign(Error('fixture'),{code:'EIO'}))
 expect(await svc.listFiles(root)).toEqual([])
 expect(await svc.listFiles(root)).toHaveLength(1)
 expect(scan).toHaveBeenCalledTimes(2)
})
