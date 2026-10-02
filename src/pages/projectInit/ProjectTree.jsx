/**
 * 新建项目 · 会生成什么（目录树）
 *
 * 负责：按共用清单画出会生成的目录树（文件名列 + 说明列），仓库标签私人仓 / 代码仓。
 * 只读：行不可点、没有悬停效果；有子项的文件夹带展开箭头（固定展开），空文件夹和文件不带。
 *
 * @module pages/projectInit/ProjectTree
 */

import { buildTree } from '../../../shared/projectInitManifest.mjs'

const CHEV = (
  <svg className="chev pi-open" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5 3.5 8" /></svg>
)

const TAG = {
  private: <span className="np-tag np-tag--blue">私人仓</span>,
  code: <span className="np-tag np-tag--green">代码仓</span>,
}

/**
 * 一行：左列文件名（按层级缩进），右列说明左对齐
 */
function TreeRow({ depth, name, note, tag, root, hasChildren }) {
  return (
    <div className="pi-tr" data-testid="pi-tree-row">
      <div className="np-tr np-tr--static pi-name" style={{ '--lv': depth }}>
        {hasChildren ? CHEV : <span className="sp" />}
        <span className={`pi-nm${root ? ' pi-root' : ''}`}>{name}</span>
        {tag ? TAG[tag] : null}
      </div>
      <span className="pi-an np-note">{note}</span>
    </div>
  )
}

/**
 * @param {{projectName: string, gitMode: string, codeDirName: string}} props
 */
export default function ProjectTree({ projectName, gitMode, codeDirName }) {
  const { root, rows } = buildTree({ projectName, gitMode, codeDir: codeDirName })
  return (
    <div className="np-card pi-tree" data-testid="pi-tree">
      <div className="pi-rows">
        <TreeRow depth={0} name={root.name} note={root.note} tag={root.tag} root hasChildren />
        {rows.map((row, index) => (
          <TreeRow key={row.path} {...row} hasChildren={rows[index + 1]?.depth > row.depth} />
        ))}
      </div>
    </div>
  )
}
