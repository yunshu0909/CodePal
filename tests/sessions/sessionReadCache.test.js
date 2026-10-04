// @vitest-environment node
/** Metadata reuse must keep live identity checks, isolation and caller cancellation. */
import {it,expect,beforeEach,afterEach} from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {L,stamp,makeProjectsDir} from './fixtures'
const require=createRequire(import.meta.url)
const svc=require('../../electron/services/sessionBrowserService')
const reader=require('../../electron/services/sessionFileReader')
let p
beforeEach(()=>p=makeProjectsDir())
afterEach(()=>p.cleanup())
it('TC-003 repeat list and search preparation reuse metadata including successful null entries',async()=>{
 const file=p.write('-a','s1',stamp([L.user('first'),L.answer('response')],{cwd:'/fixture/project'}))
 p.write('-a','empty',[L.system()])
 const options={projectsDir:p.dir}
 const first=await svc.listRecent(options)
 reader.resetReaderStats()
 expect(await svc.listRecent(options)).toEqual(first)
 expect(reader.getReaderStats().bytesRead).toBe(0)
 first.sessions[0].title='corrupted'
 expect((await svc.listRecent(options)).sessions[0].title).toBe('first')
 reader.resetReaderStats()
 const found=await svc.searchSessions('first',options)
 expect(found).toHaveLength(1)
 // Only the one eligible session body is read by search; no metadata head/tail reread.
 expect(reader.getReaderStats().bytesRead).toBeLessThanOrEqual(fs.statSync(file).size)
})
it('TC-004 rewrite with preserved mtime, deletion, escaped roots and independent aborts stay correct',async()=>{
 const file=p.write('-a','s1',stamp([L.user('before')],{cwd:'/fixture/project'}))
 const options={projectsDir:p.dir}
 await svc.listRecent(options)
 reader.resetReaderStats();await svc.listRecent(options);expect(reader.getReaderStats().bytesRead).toBe(0)
 const before=fs.statSync(file)
 fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('before','after!'))
 fs.utimesSync(file,before.atime,before.mtime)
 expect((await svc.listRecent(options)).sessions[0].title).toBe('after!')
 const abort=new AbortController()
 const cancelled=svc.listRecent({...options,signal:abort.signal});const active=svc.listRecent(options)
 abort.abort()
 await expect(cancelled).rejects.toMatchObject({code:'CANCELLED'})
 expect((await active).sessions).toHaveLength(1)
 fs.unlinkSync(file);expect((await svc.listRecent(options)).sessions).toHaveLength(0)
 const other=makeProjectsDir()
 try {
  const external=other.write('-a','s1',stamp([L.user('external')],{cwd:'/fixture/external'}))
  fs.symlinkSync(external,path.join(p.dir,'-a','escape.jsonl'))
  expect((await svc.listRecent(options)).sessions).toEqual([])
  expect((await svc.listRecent({projectsDir:other.dir})).sessions[0].title).toBe('external')
 } finally {other.cleanup()}
})
it('TC-004 concurrent unchanged callers share metadata reads and keep separate cancellation',async()=>{
 p.write('-a','s1',stamp([L.user('shared')],{cwd:'/fixture/project'}))
 reader.resetReaderStats();await svc.listRecent({projectsDir:p.dir});const single=reader.getReaderStats().bytesRead
 // Change content to ensure the next pair cannot use the ready result.
 await fsp.appendFile(path.join(p.dir,'-a','s1.jsonl'),JSON.stringify(L.aiTitle('changed'))+'\n')
 reader.resetReaderStats()
 const a=new AbortController();const b=new AbortController()
 const pair=await Promise.all([svc.listRecent({projectsDir:p.dir,signal:a.signal}),svc.listRecent({projectsDir:p.dir,signal:b.signal})])
 expect(pair[0]).toEqual(pair[1])
 expect(reader.getReaderStats().bytesRead).toBeLessThan(single*2+200)
})
