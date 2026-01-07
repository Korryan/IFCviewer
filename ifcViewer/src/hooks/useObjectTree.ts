import { useCallback, useRef, useState } from 'react'
import type { ObjectTree, ObjectTreeNode } from '../ifcViewerTypes'

type SpatialNode = {
  expressID?: number
  children?: SpatialNode[]
  type?: string
  Name?: { value?: string }
  name?: string
}

const emptyTree: ObjectTree = { nodes: {}, roots: [] }
const CUSTOM_ROOT_PREFIX = 'custom-root-'
const CUSTOM_NODE_PREFIX = 'custom-node-'
const CUSTOM_ROOT_LABEL = 'Custom objects'

const buildLabel = (node: SpatialNode): string => {
  if (node.Name?.value) return String(node.Name.value)
  if (node.name) return node.name
  if (node.type && node.expressID !== undefined) return `${node.type} #${node.expressID}`
  if (node.type) return node.type
  return 'IFC Item'
}

const traverseSpatial = (
  node: SpatialNode,
  modelID: number,
  parentId: string | null,
  acc: ObjectTree,
  counter: { current: number }
): string => {
  const expressID = typeof node.expressID === 'number' ? node.expressID : null
  const id = expressID !== null ? `ifc-${modelID}-${expressID}` : `ifc-${modelID}-aux-${counter.current++}`
  const label = buildLabel(node)
  const type = node.type ?? 'UNKNOWN'

  const treeNode: ObjectTreeNode = {
    id,
    modelID,
    expressID,
    label,
    type,
    nodeType: 'ifc',
    parentId,
    children: []
  }

  acc.nodes[id] = treeNode

  if (Array.isArray(node.children)) {
    node.children.forEach((child) => {
      const childId = traverseSpatial(child, modelID, id, acc, counter)
      treeNode.children.push(childId)
    })
  }

  return id
}

export const buildIfcTree = (spatialRoot: SpatialNode | null | undefined, modelID: number): ObjectTree => {
  if (!spatialRoot) return emptyTree
  const acc: ObjectTree = { nodes: {}, roots: [] }
  const counter = { current: 1 }
  const rootId = traverseSpatial(spatialRoot, modelID, null, acc, counter)
  acc.roots.push(rootId)
  return acc
}

const buildCustomRoot = (modelID: number): ObjectTreeNode => ({
  id: `${CUSTOM_ROOT_PREFIX}${modelID}`,
  modelID,
  expressID: null,
  label: CUSTOM_ROOT_LABEL,
  type: 'CUSTOM',
  nodeType: 'custom',
  parentId: null,
  children: []
})

const mergeWithCustomRoot = (tree: ObjectTree, modelID: number): ObjectTree => {
  const rootId = `${CUSTOM_ROOT_PREFIX}${modelID}`
  const nextNodes = { ...tree.nodes }
  const nextRoots = tree.roots.slice()
  if (!nextNodes[rootId]) {
    nextNodes[rootId] = buildCustomRoot(modelID)
    nextRoots.push(rootId)
  }
  return { nodes: nextNodes, roots: nextRoots }
}

// Hook that owns the tree state; UI can subscribe later
export const useObjectTree = () => {
  const [tree, setTree] = useState<ObjectTree>(emptyTree)
  const customIdCounterRef = useRef(1)

  const setIfcTree = useCallback((next: ObjectTree, modelID: number) => {
    setTree(mergeWithCustomRoot(next, modelID))
  }, [])

  const resetTree = useCallback(() => setTree(emptyTree), [])

  const addCustomNode = useCallback(
    (payload: {
      modelID: number
      expressID?: number | null
      label: string
      type?: string
      parentId?: string | null
    }) => {
      const nextId =
        payload.expressID !== undefined && payload.expressID !== null
          ? `${CUSTOM_NODE_PREFIX}${payload.modelID}-${payload.expressID}`
          : `${CUSTOM_NODE_PREFIX}${payload.modelID}-${customIdCounterRef.current++}`

      setTree((prev) => {
        const next = mergeWithCustomRoot(prev, payload.modelID)
        const rootId = `${CUSTOM_ROOT_PREFIX}${payload.modelID}`
        const resolvedParentId =
          payload.parentId && next.nodes[payload.parentId] ? payload.parentId : rootId

        const parent = next.nodes[resolvedParentId]
        if (!parent) {
          return next
        }

        if (next.nodes[nextId]) {
          return next
        }

        const node: ObjectTreeNode = {
          id: nextId,
          modelID: payload.modelID,
          expressID: payload.expressID ?? null,
          label: payload.label,
          type: payload.type ?? 'CUSTOM',
          nodeType: 'custom',
          parentId: resolvedParentId,
          children: []
        }

        return {
          nodes: {
            ...next.nodes,
            [nextId]: node,
            [resolvedParentId]: {
              ...parent,
              children: [...parent.children, nextId]
            }
          },
          roots: next.roots
        }
      })

      return nextId
    },
    []
  )

  return { tree, setIfcTree, resetTree, addCustomNode }
}
