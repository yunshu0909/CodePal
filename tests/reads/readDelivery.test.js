// @vitest-environment node
/** Delivery additions are guarded without editing the original red tests. */
import {it,expect} from 'vitest'
import fs from 'node:fs'
it('TC-011 version badge and read tests are wired into npm test',()=>{
 const pkg=JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url),'utf8'))
 const readme=fs.readFileSync(new URL('../../README.md',import.meta.url),'utf8')
 expect(readme).toContain('version-v'+pkg.version+'-blue')
 expect(pkg.scripts.test).toContain('npm run test:reads')
 expect(pkg.scripts['test:reads']).toContain('tests/reads')
})
