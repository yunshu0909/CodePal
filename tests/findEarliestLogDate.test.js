/* @vitest-environment node */

/**
 * findEarliestLogDate 单测
 *
 * 负责：
 * - Codex YYYY/MM/DD 目录解析 + 空目录跨日/月/年回溯
 * - Claude 按 mtime 升序遍历全部文件，取首条 timestamp 最小值（无 K 截断）
 * - 真实流 e2e：tmpdir + 真 jsonl 文件验 readline 闭合行为
 * - 两边都没数据返回 null；权限拒绝/异常兜底
 *
 * @module tests/findEarliestLogDate.test
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const {
  findEarliestLogDate,
  findEarliestCodexDate,
  findEarliestClaudeDate,
  findFirstClaudeTimestampInFile,
  toBeijingDateKey,
} = require('../electron/services/usageLogScanService.js')

/**
 * 构造一个假的 fs/promises，按目录树映射返回 readdir 结果
 * @param {Record<string, Array<{name: string, isDir: boolean}>>} tree - 目录树
 * @returns {object}
 */
function makeFakeFs(tree) {
  return {
    readdir: vi.fn(async (dir, opts) => {
      const entries = tree[dir] || []
      if (opts?.withFileTypes) {
        return entries.map((e) => ({
          name: e.name,
          isDirectory: () => e.isDir,
          isFile: () => !e.isDir,
        }))
      }
      return entries.map((e) => e.name)
    }),
    stat: vi.fn(),
  }
}

describe('findFirstClaudeTimestampInFile（真实流）', () => {
  const created = []
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  function makeTmpFile(contents) {
    const dir = mkdtempSync(join(tmpdir(), 'codepal-rl-'))
    created.push(dir)
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, contents)
    return file
  }

  it('跳过前面 config 行，命中第一条 usage 记录的 timestamp', async () => {
    const file = makeTmpFile(
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }) + '\n' +
      JSON.stringify({ type: 'file-history-snapshot' }) + '\n' +
      JSON.stringify({
        timestamp: '2025-01-15T08:30:00Z',
        message: { model: 'claude-opus-4-7', usage: { input_tokens: 1, output_tokens: 1 } }
      }) + '\n' +
      JSON.stringify({
        timestamp: '2025-01-15T09:00:00Z',
        message: { model: 'claude-opus-4-7', usage: { input_tokens: 5, output_tokens: 3 } }
      }) + '\n'
    )
    const ts = await findFirstClaudeTimestampInFile(file)
    expect(ts).toBeInstanceOf(Date)
    expect(ts.toISOString()).toBe('2025-01-15T08:30:00.000Z')
  })

  it('文件全是 config 无 usage → resolve null（不 hang）', async () => {
    const file = makeTmpFile(
      JSON.stringify({ type: 'permission-mode' }) + '\n' +
      JSON.stringify({ type: 'file-history-snapshot' }) + '\n'
    )
    const ts = await findFirstClaudeTimestampInFile(file)
    expect(ts).toBeNull()
  })

  it('文件不存在 → resolve null（不 hang）', async () => {
    const ts = await findFirstClaudeTimestampInFile('/no/such/path/never.jsonl')
    expect(ts).toBeNull()
  })

  it('空文件 → resolve null', async () => {
    const file = makeTmpFile('')
    const ts = await findFirstClaudeTimestampInFile(file)
    expect(ts).toBeNull()
  })

  it('部分坏行（无法 JSON.parse）+ 后面有合法 usage 行 → 仍能命中', async () => {
    const file = makeTmpFile(
      '{ this is not json\n' +
      JSON.stringify({
        timestamp: '2025-06-01T00:00:00Z',
        message: { model: 'claude-opus-4-7', usage: { input_tokens: 1, output_tokens: 1 } }
      }) + '\n'
    )
    const ts = await findFirstClaudeTimestampInFile(file)
    expect(ts.toISOString()).toBe('2025-06-01T00:00:00.000Z')
  })
})

describe('toBeijingDateKey', () => {
  it('把 UTC 时间转成北京日期 key', () => {
    // 2026-05-24T16:00:00Z = 2026-05-25 00:00:00+08:00
    expect(toBeijingDateKey(new Date('2026-05-24T16:00:00Z'))).toBe('2026-05-25')
  })

  it('跨日界点正确归到北京当天', () => {
    // UTC 当天但北京已经第二天
    expect(toBeijingDateKey(new Date('2024-12-31T17:00:00Z'))).toBe('2025-01-01')
  })
})

describe('findEarliestCodexDate', () => {
  it('从 YYYY/MM/DD 目录结构里拿到最小日期', async () => {
    const base = '/fake/codex/sessions'
    const fakeFs = makeFakeFs({
      [base]: [
        { name: '2024', isDir: true },
        { name: '2026', isDir: true },
        { name: '.DS_Store', isDir: false },
      ],
      [`${base}/2024`]: [
        { name: '11', isDir: true },
        { name: '12', isDir: true },
      ],
      [`${base}/2024/11`]: [{ name: '03', isDir: true }],
      [`${base}/2024/11/03`]: [
        { name: 'rollout-001.jsonl', isDir: false },
      ],
    })

    const result = await findEarliestCodexDate(base, { fsPromises: fakeFs })
    expect(result).toBe('2024-11-03')
  })

  it('忽略不合法的目录名（如 .DS_Store）', async () => {
    const base = '/fake/codex/sessions'
    const fakeFs = makeFakeFs({
      [base]: [
        { name: '.DS_Store', isDir: false },
        { name: 'README', isDir: true },
        { name: '2025', isDir: true },
      ],
      [`${base}/2025`]: [{ name: '03', isDir: true }],
      [`${base}/2025/03`]: [{ name: '15', isDir: true }],
      [`${base}/2025/03/15`]: [{ name: 'a.jsonl', isDir: false }],
    })

    const result = await findEarliestCodexDate(base, { fsPromises: fakeFs })
    expect(result).toBe('2025-03-15')
  })

  it('找到日期目录但里面没 jsonl → 返回 null', async () => {
    const base = '/fake/codex/sessions'
    const fakeFs = makeFakeFs({
      [base]: [{ name: '2025', isDir: true }],
      [`${base}/2025`]: [{ name: '03', isDir: true }],
      [`${base}/2025/03`]: [{ name: '15', isDir: true }],
      [`${base}/2025/03/15`]: [{ name: 'leftover.txt', isDir: false }],
    })

    const result = await findEarliestCodexDate(base, { fsPromises: fakeFs })
    expect(result).toBeNull()
  })

  it('空目录返回 null', async () => {
    const fakeFs = makeFakeFs({ '/fake/codex/sessions': [] })
    const result = await findEarliestCodexDate('/fake/codex/sessions', { fsPromises: fakeFs })
    expect(result).toBeNull()
  })

  it('readdir 抛错（权限拒绝等）返回 null', async () => {
    const fakeFs = {
      readdir: vi.fn(async () => {
        const err = new Error('EACCES')
        err.code = 'EACCES'
        throw err
      }),
    }
    const result = await findEarliestCodexDate('/fake/codex/sessions', { fsPromises: fakeFs })
    expect(result).toBeNull()
  })

  it('最早一天空目录 → 回溯到下一个有 jsonl 的日期', async () => {
    // 2024/01/01/ 被手动删空，2024/01/02/ 有数据 → 应返回 2024-01-02
    const base = '/fake/codex/sessions'
    const fakeFs = makeFakeFs({
      [base]: [{ name: '2024', isDir: true }],
      [`${base}/2024`]: [{ name: '01', isDir: true }],
      [`${base}/2024/01`]: [
        { name: '01', isDir: true },
        { name: '02', isDir: true },
      ],
      [`${base}/2024/01/01`]: [{ name: 'leftover.txt', isDir: false }], // 没 jsonl
      [`${base}/2024/01/02`]: [{ name: 'rollout.jsonl', isDir: false }],
    })

    const result = await findEarliestCodexDate(base, { fsPromises: fakeFs })
    expect(result).toBe('2024-01-02')
  })

  it('最早一月全空 → 跨月回溯', async () => {
    const base = '/fake/codex/sessions'
    const fakeFs = makeFakeFs({
      [base]: [{ name: '2024', isDir: true }],
      [`${base}/2024`]: [
        { name: '01', isDir: true },
        { name: '02', isDir: true },
      ],
      [`${base}/2024/01`]: [{ name: '15', isDir: true }],
      [`${base}/2024/01/15`]: [], // 空
      [`${base}/2024/02`]: [{ name: '03', isDir: true }],
      [`${base}/2024/02/03`]: [{ name: 'rollout.jsonl', isDir: false }],
    })

    const result = await findEarliestCodexDate(base, { fsPromises: fakeFs })
    expect(result).toBe('2024-02-03')
  })

  it('混合非数字目录名（backup, 2024, 2025）→ 只取数字目录', async () => {
    const base = '/fake/codex/sessions'
    const fakeFs = makeFakeFs({
      [base]: [
        { name: '2024', isDir: true },
        { name: 'backup', isDir: true },
        { name: '2025', isDir: true },
        { name: 'trash-2023', isDir: true },
      ],
      [`${base}/2024`]: [{ name: '03', isDir: true }],
      [`${base}/2024/03`]: [{ name: '15', isDir: true }],
      [`${base}/2024/03/15`]: [{ name: 'a.jsonl', isDir: false }],
    })

    const result = await findEarliestCodexDate(base, { fsPromises: fakeFs })
    expect(result).toBe('2024-03-15')
  })

  it('最早一年完全空 → 跨年回溯到下一年', async () => {
    // 2024 整年所有 day 都没 jsonl，2025 才有数据 → 应返回 2025-xx-xx
    const base = '/fake/codex/sessions'
    const fakeFs = makeFakeFs({
      [base]: [
        { name: '2024', isDir: true },
        { name: '2025', isDir: true },
      ],
      [`${base}/2024`]: [{ name: '01', isDir: true }],
      [`${base}/2024/01`]: [{ name: '15', isDir: true }],
      [`${base}/2024/01/15`]: [], // 空
      [`${base}/2025`]: [{ name: '03', isDir: true }],
      [`${base}/2025/03`]: [{ name: '20', isDir: true }],
      [`${base}/2025/03/20`]: [{ name: 'rollout.jsonl', isDir: false }],
    })

    const result = await findEarliestCodexDate(base, { fsPromises: fakeFs })
    expect(result).toBe('2025-03-20')
  })

  it('所有 year/month/day 都没 jsonl → 守住 fall-through return null', async () => {
    // 全部目录结构都在，但没有任何 jsonl 文件
    const base = '/fake/codex/sessions'
    const fakeFs = makeFakeFs({
      [base]: [
        { name: '2024', isDir: true },
        { name: '2025', isDir: true },
      ],
      [`${base}/2024`]: [{ name: '01', isDir: true }, { name: '02', isDir: true }],
      [`${base}/2024/01`]: [{ name: '15', isDir: true }],
      [`${base}/2024/01/15`]: [{ name: 'log.txt', isDir: false }], // 非 jsonl
      [`${base}/2024/02`]: [{ name: '10', isDir: true }],
      [`${base}/2024/02/10`]: [], // 空
      [`${base}/2025`]: [{ name: '03', isDir: true }],
      [`${base}/2025/03`]: [{ name: '20', isDir: true }],
      [`${base}/2025/03/20`]: [{ name: 'notes.md', isDir: false }], // 非 jsonl
    })

    const result = await findEarliestCodexDate(base, { fsPromises: fakeFs })
    expect(result).toBeNull()
  })

  it('year 目录名严格 4 位数字（mutation: /^\\d+$/ 放宽会被捕获）', async () => {
    // 混入 "999"（3 位）和 "20240"（5 位）应被忽略，只取合法 4 位年
    const base = '/fake/codex/sessions'
    const fakeFs = makeFakeFs({
      [base]: [
        { name: '999', isDir: true },
        { name: '20240', isDir: true },
        { name: '2024', isDir: true },
      ],
      [`${base}/2024`]: [{ name: '06', isDir: true }],
      [`${base}/2024/06`]: [{ name: '10', isDir: true }],
      [`${base}/2024/06/10`]: [{ name: 'r.jsonl', isDir: false }],
    })

    const result = await findEarliestCodexDate(base, { fsPromises: fakeFs })
    expect(result).toBe('2024-06-10')
  })

  it('month/day 严格 2 位数字（mutation: /^\\d{1,2}$/ 放宽会被捕获）', async () => {
    // 混入 "1"（1 位）和 "003"（3 位）应被忽略
    const base = '/fake/codex/sessions'
    const fakeFs = makeFakeFs({
      [base]: [{ name: '2024', isDir: true }],
      [`${base}/2024`]: [
        { name: '1', isDir: true },    // 非法
        { name: '003', isDir: true },  // 非法
        { name: '05', isDir: true },   // 合法
      ],
      [`${base}/2024/05`]: [
        { name: '7', isDir: true },    // 非法
        { name: '15', isDir: true },   // 合法
      ],
      [`${base}/2024/05/15`]: [{ name: 'r.jsonl', isDir: false }],
    })

    const result = await findEarliestCodexDate(base, { fsPromises: fakeFs })
    expect(result).toBe('2024-05-15')
  })

  it('hasJsonl 严格按 .jsonl 结尾（mutation: includes 放宽会被捕获）', async () => {
    // 混入 rollout.jsonl.bak / notes.jsonl-archived 等"包含 .jsonl 但不是 jsonl"
    const base = '/fake/codex/sessions'
    const fakeFs = makeFakeFs({
      [base]: [{ name: '2024', isDir: true }],
      [`${base}/2024`]: [
        { name: '01', isDir: true },
        { name: '02', isDir: true },
      ],
      [`${base}/2024/01`]: [{ name: '10', isDir: true }],
      [`${base}/2024/01/10`]: [
        { name: 'rollout.jsonl.bak', isDir: false },     // 不算
        { name: 'notes.jsonl-archived', isDir: false },  // 不算
      ],
      [`${base}/2024/02`]: [{ name: '03', isDir: true }],
      [`${base}/2024/02/03`]: [{ name: 'real.jsonl', isDir: false }],
    })

    const result = await findEarliestCodexDate(base, { fsPromises: fakeFs })
    expect(result).toBe('2024-02-03') // 01/10 全是假 jsonl 应回溯
  })

  it('hasJsonl 时 readdir 抛 EACCES → 该 day 被静默跳过，不影响其他 day', async () => {
    // day1 readdir 报权限错误，day2 正常 → 应返回 day2
    const base = '/fake/codex/sessions'
    let readdirCallCount = 0
    const fakeFs = {
      readdir: vi.fn(async (dir, opts) => {
        readdirCallCount += 1
        // hasJsonl 是裸 readdir（无 opts.withFileTypes），用这点区分
        if (!opts?.withFileTypes && dir.endsWith('2024/01/15')) {
          const err = new Error('EACCES')
          err.code = 'EACCES'
          throw err
        }
        const tree = {
          [base]: [{ name: '2024', isDir: true }],
          [`${base}/2024`]: [{ name: '01', isDir: true }],
          [`${base}/2024/01`]: [{ name: '15', isDir: true }, { name: '16', isDir: true }],
          // 裸 readdir 用于 hasJsonl 判断
          [`${base}/2024/01/16`]: ['rollout.jsonl'],
        }
        if (opts?.withFileTypes) {
          return (tree[dir] || []).map((e) => ({
            name: e.name,
            isDirectory: () => e.isDir,
            isFile: () => !e.isDir,
          }))
        }
        return tree[dir] || []
      }),
    }

    const result = await findEarliestCodexDate(base, { fsPromises: fakeFs })
    expect(result).toBe('2024-01-16') // 15 因 EACCES 跳过，回溯到 16
  })
})

describe('findEarliestClaudeDate', () => {
  it('按 mtime 升序遍历文件，从首条 usage 记录拿到最早 timestamp', async () => {
    const base = '/fake/claude/projects'
    const listFn = vi.fn(async () => [
      '/fake/claude/projects/p1/old.jsonl',
      '/fake/claude/projects/p1/new.jsonl',
    ])
    const fakeFs = {
      stat: vi.fn(async (file) => {
        if (file.includes('old')) return { mtimeMs: 1000 }
        if (file.includes('new')) return { mtimeMs: 9999 }
        throw new Error('unknown file')
      }),
    }
    const findTsFn = vi.fn(async (file) => {
      if (file.includes('old')) return new Date('2024-09-15T10:00:00+08:00')
      if (file.includes('new')) return new Date('2026-05-20T10:00:00+08:00')
      return null
    })

    const result = await findEarliestClaudeDate(base, {
      fsPromises: fakeFs,
      listJsonlFilesRecursiveFn: listFn,
      findFirstClaudeTimestampInFileFn: findTsFn,
    })
    expect(result).toBe('2024-09-15')
  })

  it('文件列表为空返回 null', async () => {
    const result = await findEarliestClaudeDate('/fake/claude/projects', {
      listJsonlFilesRecursiveFn: vi.fn(async () => []),
    })
    expect(result).toBeNull()
  })

  it('所有 fs.stat 都失败 → 返回 null 不崩', async () => {
    // 模拟磁盘错误 / 全部文件被并发删除：list 拿到文件但 stat 都失败
    const result = await findEarliestClaudeDate('/fake/claude/projects', {
      listJsonlFilesRecursiveFn: vi.fn(async () => [
        '/fake/claude/projects/a.jsonl',
        '/fake/claude/projects/b.jsonl',
      ]),
      fsPromises: {
        stat: vi.fn(async () => {
          const err = new Error('ENOENT')
          err.code = 'ENOENT'
          throw err
        }),
      },
      findFirstClaudeTimestampInFileFn: vi.fn(async () => new Date('2024-01-01')),
    })
    expect(result).toBeNull()
  })

  it('所有文件都没找到 timestamp（全是 config 行）返回 null', async () => {
    const result = await findEarliestClaudeDate('/fake/claude/projects', {
      listJsonlFilesRecursiveFn: vi.fn(async () => ['/fake/claude/projects/a.jsonl']),
      fsPromises: { stat: vi.fn(async () => ({ mtimeMs: 1 })) },
      findFirstClaudeTimestampInFileFn: vi.fn(async () => null),
    })
    expect(result).toBeNull()
  })

  it('遍历所有文件取 timestamp 最小值（不按 mtime 截断采样）', async () => {
    // 前 7 个文件 mtime 最早但全是 config-only 没 timestamp，第 8 个才有
    // 这个 case 必须>K（旧 K=5），否则有人加回 slice(0, 5) 时碰巧"全部样本被采到"测试不会挂
    // 文件数 8 + 唯一带 ts 的 h.jsonl mtime 排第 8 → 模拟回归绝对挂
    const files = ['a.jsonl', 'b.jsonl', 'c.jsonl', 'd.jsonl', 'e.jsonl', 'f.jsonl', 'g.jsonl', 'h.jsonl']
    const listFn = vi.fn(async () => files)
    const fakeFs = {
      stat: vi.fn(async (file) => {
        const order = {
          'a.jsonl': 1, 'b.jsonl': 2, 'c.jsonl': 3, 'd.jsonl': 4,
          'e.jsonl': 5, 'f.jsonl': 6, 'g.jsonl': 7, 'h.jsonl': 8,
        }
        return { mtimeMs: order[file] }
      }),
    }
    const findTsFn = vi.fn(async (file) => {
      // 只有最新 mtime 的 h.jsonl 才有 timestamp，前 7 个都是 config-only
      if (file === 'h.jsonl') return new Date('2024-08-15T10:00:00+08:00')
      return null
    })

    const result = await findEarliestClaudeDate('/fake/claude/projects', {
      fsPromises: fakeFs,
      listJsonlFilesRecursiveFn: listFn,
      findFirstClaudeTimestampInFileFn: findTsFn,
    })

    expect(result).toBe('2024-08-15')
    expect(findTsFn).toHaveBeenCalledTimes(files.length) // 所有文件都被遍历，没被 K 截断
  })

  it('文件被按 mtime 升序遍历（mutation: 删 sort 会被这个测试捕获）', async () => {
    // 把 findTsFn 包装成 spy，记录被调用的顺序
    // 即使最终 earliest 取 min 不依赖顺序，调用顺序仍应是 mtime asc
    const callOrder = []
    const findTsFn = vi.fn(async (file) => {
      callOrder.push(file)
      return null
    })
    const fakeFs = {
      stat: vi.fn(async (file) => {
        // mtime 故意逆序：c=1, a=2, b=3 → 升序应是 c → a → b
        const order = { 'a.jsonl': 2, 'b.jsonl': 3, 'c.jsonl': 1 }
        return { mtimeMs: order[file] }
      }),
    }

    await findEarliestClaudeDate('/fake/claude/projects', {
      fsPromises: fakeFs,
      listJsonlFilesRecursiveFn: vi.fn(async () => ['a.jsonl', 'b.jsonl', 'c.jsonl']),
      findFirstClaudeTimestampInFileFn: findTsFn,
    })

    expect(callOrder).toEqual(['c.jsonl', 'a.jsonl', 'b.jsonl'])
  })

  it('多个文件都有 timestamp → 取最小那个（mtime 不一定对应 ts 顺序）', async () => {
    // file A mtime 早但 ts 晚；file B mtime 晚但 ts 早
    // 长会话场景：B 是个跨月的旧 session，最后一次写入晚于 A
    const listFn = vi.fn(async () => ['A.jsonl', 'B.jsonl'])
    const fakeFs = {
      stat: vi.fn(async (file) => {
        if (file === 'A.jsonl') return { mtimeMs: 1 }
        if (file === 'B.jsonl') return { mtimeMs: 2 }
        throw new Error('?')
      }),
    }
    const findTsFn = vi.fn(async (file) => {
      if (file === 'A.jsonl') return new Date('2025-12-01T10:00:00+08:00')
      if (file === 'B.jsonl') return new Date('2024-03-15T10:00:00+08:00')
      return null
    })

    const result = await findEarliestClaudeDate('/fake/claude/projects', {
      fsPromises: fakeFs,
      listJsonlFilesRecursiveFn: listFn,
      findFirstClaudeTimestampInFileFn: findTsFn,
    })

    expect(result).toBe('2024-03-15')
  })
})

describe('findEarliestLogDate', () => {
  it('两边都没目录 → 返回 null', async () => {
    const result = await findEarliestLogDate({
      homeDir: '/fake/home',
      pathExistsFn: vi.fn(async () => false),
    })
    expect(result).toBeNull()
  })

  it('只有 Claude 有数据 → 用 Claude 日期', async () => {
    const result = await findEarliestLogDate({
      homeDir: '/fake/home',
      pathExistsFn: vi.fn(async (p) => p.includes('.claude')),
      findEarliestClaudeDateFn: vi.fn(async () => '2025-08-10'),
      findEarliestCodexDateFn: vi.fn(async () => null),
    })
    expect(result).toBe('2025-08-10')
  })

  it('只有 Codex 有数据 → 用 Codex 日期', async () => {
    const result = await findEarliestLogDate({
      homeDir: '/fake/home',
      pathExistsFn: vi.fn(async (p) => p.includes('.codex')),
      findEarliestClaudeDateFn: vi.fn(async () => null),
      findEarliestCodexDateFn: vi.fn(async () => '2024-11-03'),
    })
    expect(result).toBe('2024-11-03')
  })

  it('两边都有数据 → 取较小日期', async () => {
    const result = await findEarliestLogDate({
      homeDir: '/fake/home',
      pathExistsFn: vi.fn(async () => true),
      findEarliestClaudeDateFn: vi.fn(async () => '2025-08-10'),
      findEarliestCodexDateFn: vi.fn(async () => '2024-11-03'),
    })
    expect(result).toBe('2024-11-03')
  })

  it('其中一边抛错不应影响另一边', async () => {
    const result = await findEarliestLogDate({
      homeDir: '/fake/home',
      pathExistsFn: vi.fn(async () => true),
      findEarliestClaudeDateFn: vi.fn(async () => {
        throw new Error('boom')
      }),
      findEarliestCodexDateFn: vi.fn(async () => '2025-01-01'),
    })
    expect(result).toBe('2025-01-01')
  })

  it('真实文件系统 e2e：写入 tmpdir 后能找到最早日期', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'codepal-earliest-'))
    try {
      // Claude 侧：先建 projects/<cwd>/<uuid>.jsonl
      const claudeDir = join(tmp, '.claude', 'projects', 'demo-cwd')
      const fs = require('fs')
      fs.mkdirSync(claudeDir, { recursive: true })
      writeFileSync(
        join(claudeDir, 'session-old.jsonl'),
        // 真实 Claude jsonl 头：前两行是 config 无 timestamp
        JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }) + '\n' +
        JSON.stringify({ type: 'file-history-snapshot' }) + '\n' +
        // 第三行带 message.usage + timestamp，这才是真理源
        JSON.stringify({
          timestamp: '2024-09-15T10:00:00Z',
          message: { model: 'claude-opus-4-7', usage: { input_tokens: 10, output_tokens: 5 } }
        }) + '\n'
      )

      // Codex 侧：建 sessions/2024/03/22/xxx.jsonl
      const codexDay = join(tmp, '.codex', 'sessions', '2024', '03', '22')
      fs.mkdirSync(codexDay, { recursive: true })
      writeFileSync(join(codexDay, 'rollout.jsonl'), 'noop\n')

      // 不 mock 任何 fs，直接用真实文件
      const result = await findEarliestLogDate({ homeDir: tmp })
      // Codex 2024-03-22 早于 Claude 2024-09-15 → 应取 Codex
      expect(result).toBe('2024-03-22')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('两边都抛错 → null', async () => {
    const result = await findEarliestLogDate({
      homeDir: '/fake/home',
      pathExistsFn: vi.fn(async () => true),
      findEarliestClaudeDateFn: vi.fn(async () => {
        throw new Error('a')
      }),
      findEarliestCodexDateFn: vi.fn(async () => {
        throw new Error('b')
      }),
    })
    expect(result).toBeNull()
  })
})
