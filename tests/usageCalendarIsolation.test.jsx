/** Shared component defaults remain compatible. @module tests/usageCalendarIsolation */
import React from 'react'
import { describe,it,expect } from 'vitest'
import {render,screen,cleanup} from '@testing-library/react'
import PageShell from '../src/components/PageShell'
import DayRing from '../src/pages/usage/components/DayRing'
describe('usage calendar isolation',()=>{
 it('TC030: PageShell retains its existing markup and default class',()=>{const {container}=render(<PageShell title="Harness 管理" subtitle="旧页面">原内容</PageShell>);expect(container.firstChild.className).toBe('page-shell');expect(screen.getByRole('heading',{name:'Harness 管理'})).toHaveClass('page-shell__title');cleanup()})
 it('TC029: 99.9 uses blue open ring; >=200 renders extra circle',()=>{const {container,rerender}=render(<DayRing total={999000} target={1000000}/>);expect(container.querySelector('svg')).toHaveAttribute('data-tier','under');expect(Number(container.querySelector('[data-progress]').getAttribute('stroke-dashoffset'))).toBeGreaterThan(0);rerender(<DayRing total={2000000} target={1000000}/>);expect(container.querySelector('svg')).toHaveAttribute('data-tier','over');expect(container.querySelector('[data-second-circle]')).not.toBeNull();cleanup()})
})
