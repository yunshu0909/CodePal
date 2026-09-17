/** Restored settings entry: real UI/hooks, isolated IPC responses and write-boundary checks. @module tests/StatusLineSettingsPage */
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import StatusLineSettingsPage from '../../src/pages/StatusLineSettingsPage'
import WorkbenchLayout from '../../src/components/WorkbenchLayout'

const config = {displayMode:'always',fiveHourThreshold:70,sevenDayThreshold:70}
const ready = (overrides={}) => ({success:true,integrationState:'ready',usesManagedStatusLine:true,scriptOutdated:false,config:{...config},snapshot:{updatedAt:Date.now()/1000,fiveHourUsedPercentage:53,sevenDayUsedPercentage:61},...overrides})
beforeEach(() => {
  window.electronAPI = {
    getClaudeUsageStatusState:vi.fn(async()=>ready()),
    getCodexUsageStatusState:vi.fn(async()=>({success:true,integrationState:'waiting_for_data'})),
    saveClaudeUsageStatusConfig:vi.fn(async draft=>ready({config:draft})),
    ensureClaudeUsageStatusInstalled:vi.fn(async()=>ready()),
  }
})
afterEach(()=>{cleanup();vi.clearAllMocks();delete window.electronAPI})
async function openSettings() {
  render(<StatusLineSettingsPage/>);
  const button = await screen.findByRole('button',{name:'显示设置'});
  await waitFor(()=>expect(button).toBeEnabled());
  fireEvent.click(button);
  return screen.getByRole('dialog');
}

it('tool settings navigation is separate from the existing Plan entry',()=>{
  const change=vi.fn();render(<WorkbenchLayout activeModule="claude-usage" onModuleChange={change}/>);
  fireEvent.click(screen.getByRole('button',{name:/状态栏设置/}));
  expect(change).toHaveBeenCalledWith('statusline-settings');
  expect(screen.getByRole('button',{name:/Plan 管理/})).toHaveClass('active');
})

it('reads existing settings; cancelling a modified draft does not write and reopening restores saved fields',async()=>{
  const dialog=await openSettings();
  expect(screen.getByRole('heading',{name:'状态栏设置'})).toBeVisible();
  expect(window.electronAPI.ensureClaudeUsageStatusInstalled).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('radio',{name:/达阈值才显示/}));
  fireEvent.change(within(dialog).getAllByRole('spinbutton')[0],{target:{value:'88'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'取消'}));
  expect(window.electronAPI.saveClaudeUsageStatusConfig).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'显示设置'}));
  expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(70);
  expect(screen.getByRole('radio',{name:/总是显示/})).toBeChecked();
})

it.each([['always','总是显示'],['threshold','达阈值才显示'],['off','关闭']])('saves %s mode plus numeric thresholds through the original IPC and survives remount',async(mode,label)=>{
  const dialog=await openSettings();
  fireEvent.click(within(dialog).getByRole('radio',{name:new RegExp('^'+label)}));
  const fields=within(dialog).getAllByRole('spinbutton');
  fireEvent.change(fields[0],{target:{value:'65'}});fireEvent.change(fields[1],{target:{value:'85'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'保存设置'}));
  const saved={displayMode:mode,fiveHourThreshold:65,sevenDayThreshold:85};
  await waitFor(()=>expect(window.electronAPI.saveClaudeUsageStatusConfig).toHaveBeenCalledWith(saved));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByText('显示设置已保存')).toBeVisible();
  window.electronAPI.getClaudeUsageStatusState.mockResolvedValue(ready({config:saved}));
  cleanup();render(<StatusLineSettingsPage/>);
  const button=await screen.findByRole('button',{name:'显示设置'});await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button);
  expect(screen.getByRole('radio',{name:new RegExp('^'+label)})).toBeChecked();
  expect(screen.getAllByRole('spinbutton').map(n=>n.value)).toEqual(['65','85']);
})

it('failed save keeps the draft open for retry instead of discarding it',async()=>{
  window.electronAPI.saveClaudeUsageStatusConfig.mockResolvedValueOnce({success:false,error:'SAVE_FAILED'});
  const dialog=await openSettings();fireEvent.change(within(dialog).getAllByRole('spinbutton')[0],{target:{value:'90'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'保存设置'}));
  await screen.findByText('保存失败，请重试');expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(90);
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect(window.electronAPI.saveClaudeUsageStatusConfig).toHaveBeenCalledTimes(2);
})

it('custom statusLine is untouched until takeover confirmation; cancelling the explanation does not write',async()=>{
  window.electronAPI.getClaudeUsageStatusState.mockResolvedValue(ready({integrationState:'conflict',usesManagedStatusLine:false}));
  render(<StatusLineSettingsPage/>);
  fireEvent.click(await screen.findByRole('button',{name:'查看接管说明'}));
  expect(window.electronAPI.ensureClaudeUsageStatusInstalled).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'显示设置'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'取消'}));
  expect(window.electronAPI.ensureClaudeUsageStatusInstalled).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'查看接管说明'}));fireEvent.click(screen.getByRole('button',{name:'确认接管'}));
  await waitFor(()=>expect(window.electronAPI.ensureClaudeUsageStatusInstalled).toHaveBeenCalledWith({force:true,intent:'explicit'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
})

it('unconfigured statusLine requires the existing explicit integration action',async()=>{
  window.electronAPI.getClaudeUsageStatusState.mockResolvedValue(ready({integrationState:'not_configured',usesManagedStatusLine:false}));
  render(<StatusLineSettingsPage/>);
  const button=await screen.findByRole('button',{name:'立即接入'});
  expect(window.electronAPI.ensureClaudeUsageStatusInstalled).not.toHaveBeenCalled();fireEvent.click(button);
  await waitFor(()=>expect(window.electronAPI.ensureClaudeUsageStatusInstalled).toHaveBeenCalledWith({force:false,intent:'explicit'}));
})
