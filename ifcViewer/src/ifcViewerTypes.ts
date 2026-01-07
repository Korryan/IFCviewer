export type SelectedElement = {
  modelID: number
  expressID: number
  type?: string
}

export type PropertyField = {
  key: string
  label: string
  value: string
}

export type OffsetVector = {
  dx: number
  dy: number
  dz: number
}

export type Point3D = {
  x: number
  y: number
  z: number
}

export type ObjectTreeNode = {
  id: string
  modelID: number
  expressID: number | null
  label: string
  type: string
  nodeType: 'ifc' | 'custom'
  parentId: string | null
  children: string[]
}

export type ObjectTree = {
  nodes: Record<string, ObjectTreeNode>
  roots: string[]
}
