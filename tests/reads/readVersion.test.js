// @vitest-environment node
/** Product version is an explicit implementation path. */
import {it,expect} from 'vitest'
import fs from 'node:fs'
it('TC-010 candidate and lock retain the assigned 2.1.13 version',()=>{
 const pkg=JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url),'utf8'))
 const lock=JSON.parse(fs.readFileSync(new URL('../../package-lock.json',import.meta.url),'utf8'))
 expect(pkg.version).toBe('2.1.13');expect(lock.version).toBe(pkg.version);expect(lock.packages[''].version).toBe(pkg.version)
})
