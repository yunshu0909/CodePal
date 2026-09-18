/** Public navigation, bootstrap and page-local style compatibility. @module tests/planCompatibility */
import React from 'react'
import {it,expect} from 'vitest'
import {render,screen} from '@testing-library/react'
import fs from 'node:fs'
import WorkbenchLayout from '../../src/components/WorkbenchLayout'
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8')
it('TC-074 retained module ID mounts Plan and global silent bootstrap remains',()=>{const app=read('src/App.jsx');const nav=read('src/components/WorkbenchLayout.jsx');expect(app).toContain("activeModule === 'claude-usage'");expect(app).toContain('<PlanManagementPage');expect(app).toContain('ensureClaudeUsageStatusInstalled');expect(app).toContain("intent: 'silent'");expect(nav).toMatch(/id:\s*'claude-usage',\s*label:\s*'订阅管理'/);expect(app).not.toContain('<ClaudeUsageStatusPage')})
it('TC-075 local stylesheet isolates all rules and wires Plan into default suite',()=>{const css=read('src/pages/plan/plan.css');expect(css).not.toMatch(/(^|\})\s*(:root|body|html|\.btn\b|\.page-shell\b)\s*[{,]/);expect(css).toContain('.plan-page');expect(css).toContain('--plan-');const pkg=JSON.parse(read('package.json'));expect(pkg.scripts.test).toContain('npm run test:plan');expect(pkg.scripts['test:plan']).toContain('tests/plan');expect(read('src/pages/ComponentPreviewPage.jsx')).toContain('PlanCard')})
