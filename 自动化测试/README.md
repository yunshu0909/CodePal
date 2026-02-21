# 自动化测试索引

## 目录约定

- 每个 PRD 版本一套目录：`自动化测试/<版本>/`
- 每套目录包含：
  - `TEST_PLAN.md`
  - `TEST_REPORT.md`
  - `vitest.config.js`
  - `playwright.config.js`
  - `tests/`（unit/integration/e2e）

## 当前版本映射

- `V0.4`
  - PRD 范围：`/Users/wuhaoyang/Documents/trae_projects/skills/docs/prd/PRD-Skill-Manager-V0.1.md` ~ `PRD-Skill-Manager-V0.4.md`
  - 测试目录：`/Users/wuhaoyang/Documents/trae_projects/skills/skill-manager/自动化测试/V0.4`
  - 执行命令：
    - `npm run test:v04`
    - `npm run test:e2e:v04`
    - `npm run test:v04:all`

- `V0.5`
  - PRD：`/Users/wuhaoyang/Documents/trae_projects/skills/docs/prd/PRD-Skill-Manager-V0.5.md`
  - 测试目录：`/Users/wuhaoyang/Documents/trae_projects/skills/skill-manager/自动化测试/V0.5`
  - 执行命令：
    - `npm run test:v05`
    - `npm run test:e2e:v05`
    - `npm run test:v05:all`

- `V0.6`
  - PRD：`/Users/wuhaoyang/Documents/trae_projects/skills/docs/prd/PRD-Skill-Manager-V0.6-用量监测.md`
  - 测试目录：`/Users/wuhaoyang/Documents/trae_projects/skills/skill-manager/自动化测试/V0.6`
  - 执行命令：
    - `npm run test:v06`
    - `npm run test:e2e:v06`
    - `npm run test:v06:all`

- `V0.12`
  - PRD：`/Users/wuhaoyang/Documents/trae_projects/skills/docs/prd/PRD-Skill-Manager-V0.12-启动模式.md`
  - 测试目录：`/Users/wuhaoyang/Documents/trae_projects/skills/skill-manager/自动化测试/V0.12`
  - 执行命令：
    - `npm run test:v12:backend`
    - `npm run test:v12:integration`
    - `npm run test:e2e:v12`
    - `npm run test:v12:all`
