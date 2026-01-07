import { useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectTree } from '../ifcViewerTypes'

type ObjectTreePanelProps = {
  tree: ObjectTree
  selectedNodeId: string | null
  onSelectNode: (nodeId: string) => void
  onAddChild: (nodeId: string) => void
}

type RenderNodeArgs = {
  nodeId: string
  depth: number
  expanded: Set<string>
  pathSet: Set<string>
  toggle: (id: string) => void
  selectedNodeId: string | null
  onSelectNode: (nodeId: string) => void
  onAddChild: (nodeId: string) => void
  nodes: ObjectTree['nodes']
}

const indentSize = 12

const TreeNode = ({
  nodeId,
  depth,
  expanded,
  pathSet,
  toggle,
  selectedNodeId,
  onSelectNode,
  onAddChild,
  nodes
}: RenderNodeArgs) => {
  const node = nodes[nodeId]
  if (!node) return null
  const hasChildren = node.children.length > 0
  const isExpanded = expanded.has(nodeId)
  const isSelected = selectedNodeId === nodeId
  const isOnPath = pathSet.has(nodeId)

  return (
    <div className="tree-node" style={{ paddingLeft: depth * indentSize }}>
      <div className="tree-node__row">
        <button
          type="button"
          className="tree-node__toggle"
          onClick={() => (hasChildren ? toggle(nodeId) : onSelectNode(nodeId))}
          aria-label={hasChildren ? (isExpanded ? 'Collapse' : 'Expand') : 'Select'}
        >
          {hasChildren ? (isExpanded ? '▾' : '▸') : '•'}
        </button>
        <button
          type="button"
          className={[
            'tree-node__label',
            isOnPath ? 'tree-node__label--path' : '',
            isSelected ? 'tree-node__label--selected' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => onSelectNode(nodeId)}
          title={node.label}
          data-node-id={nodeId}
        >
          <span className="tree-node__type">{node.type}</span>
          <span className="tree-node__name">{node.label}</span>
        </button>
        <button
          type="button"
          className="tree-node__add"
          onClick={() => onAddChild(nodeId)}
          aria-label="Add child object"
          title="Add child object"
        >
          +
        </button>
      </div>
      {hasChildren && isExpanded && (
        <div className="tree-node__children">
          {node.children.map((childId) => (
            <TreeNode
              key={childId}
              nodeId={childId}
              depth={depth + 1}
              expanded={expanded}
              pathSet={pathSet}
              toggle={toggle}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
              onAddChild={onAddChild}
              nodes={nodes}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export const ObjectTreePanel = ({
  tree,
  selectedNodeId,
  onSelectNode,
  onAddChild
}: ObjectTreePanelProps) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const contentRef = useRef<HTMLDivElement | null>(null)

  // Auto-expand roots when tree changes
  useEffect(() => {
    const next = new Set<string>()
    tree.roots.forEach((rootId) => next.add(rootId))
    setExpanded(next)
  }, [tree.roots])

  const { selectionPath, selectionTrail } = useMemo(() => {
    const ids: string[] = []
    const trail: string[] = []
    if (!selectedNodeId) {
      return { selectionPath: new Set<string>(), selectionTrail: trail }
    }
    let current: string | null = selectedNodeId
    while (current) {
      ids.push(current)
      const node = tree.nodes[current]
      if (!node || !node.parentId) break
      current = node.parentId
    }
    ids
      .slice()
      .reverse()
      .forEach((id) => {
        const node = tree.nodes[id]
        if (node) {
          trail.push(node.label)
        }
      })
    return { selectionPath: new Set(ids), selectionTrail: trail }
  }, [selectedNodeId, tree.nodes])

  useEffect(() => {
    if (!selectedNodeId) return
    setExpanded((prev) => {
      const next = new Set(prev)
      selectionPath.forEach((id) => next.add(id))
      return next
    })
  }, [selectedNodeId, selectionPath])

  useEffect(() => {
    if (!selectedNodeId) return
    const container = contentRef.current
    if (!container) return
    const target = container.querySelector(`[data-node-id="${selectedNodeId}"]`)
    if (target && 'scrollIntoView' in target) {
      ;(target as HTMLElement).scrollIntoView({ block: 'center' })
    }
  }, [expanded, selectedNodeId])

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const hasContent = useMemo(() => tree.roots.length > 0, [tree.roots])

  return (
    <section className="tree-panel">
      <header className="tree-panel__header">
        <h2>Object tree</h2>
        <p>Hierarchy from IFC spatial structure.</p>
        <p className="tree-panel__path">
          {selectionTrail.length > 0 ? selectionTrail.join(' / ') : 'No selection'}
        </p>
      </header>
      <div ref={contentRef} className="tree-panel__content">
        {hasContent ? (
          tree.roots.map((rootId) => (
            <TreeNode
              key={rootId}
              nodeId={rootId}
              depth={0}
              expanded={expanded}
              pathSet={selectionPath}
              toggle={toggle}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
              onAddChild={onAddChild}
              nodes={tree.nodes}
            />
          ))
        ) : (
          <p className="tree-panel__status">Load an IFC model to see its hierarchy.</p>
        )}
      </div>
    </section>
  )
}
