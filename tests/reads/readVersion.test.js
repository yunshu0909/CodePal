// @vitest-environment node
/** Product version is an explicit implementation path. */
import {it,expect} from 'vitest'
import fs from 'node:fs'
// 版本号每个任务都会升，这里只核 package 与 lock 一致，不写死某一版（写死会让之后每次升版本都挡住 CI）
it('TC-010 package and lock carry the same product version',()=>{
 const pkg=JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url),'utf8'))
 const lock=JSON.parse(fs.readFileSync(new URL('../../package-lock.json',import.meta.url),'utf8'))
 expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);expect(lock.version).toBe(pkg.version);expect(lock.packages[''].version).toBe(pkg.version)
})
