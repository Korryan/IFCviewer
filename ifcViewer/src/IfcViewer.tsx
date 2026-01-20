import { useCallback, useEffect, useRef, useState } from 'react'
import { Plane, Raycaster, Vector3 } from 'three'
import { IfcViewerAPI } from 'web-ifc-viewer'
import type { OffsetVector, Point3D } from './ifcViewerTypes'
import { useSelectionOffsets, CUSTOM_CUBE_MODEL_ID } from './hooks/useSelectionOffsets'
import { useViewerSetup } from './hooks/useViewerSetup'
import { CoordsOverlay } from './components/CoordsOverlay'
import { InsertMenu } from './components/InsertMenu'
import { PropertiesPanel } from './components/PropertiesPanel'
import { ObjectTreePanel } from './components/ObjectTreePanel'
import { buildIfcTree, useObjectTree } from './hooks/useObjectTree'

type IfcViewerProps = {
  file?: File | null
  defaultModelUrl?: string
}

type Loader = (viewer: IfcViewerAPI) => Promise<any>

const wasmRootPath = '/ifc/'

// Top-level viewer wiring together scene setup, selection hook, and UI overlays
const IfcViewer = ({ file, defaultModelUrl = '/test.ifc' }: IfcViewerProps) => {
  // Scene / viewer refs
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<IfcViewerAPI | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const treeUploadInputRef = useRef<HTMLInputElement | null>(null)
  const pendingTreeUploadRef = useRef<string | null>(null)
  // Pointer bookkeeping so the insert menu knows where to appear
  const lastPointerPosRef = useRef<{ x: number; y: number }>({ x: 16, y: 16 })
  // Remember the last loaded IFC model id for cleanup
  const lastModelIdRef = useRef<number | null>(null)
  const loadTokenRef = useRef(0)
  const [status, setStatus] = useState<string | null>('Loading sample model...')
  const [error, setError] = useState<string | null>(null)
  const [hoverCoords, setHoverCoords] = useState<Point3D | null>(null)
  const [isInsertMenuOpen, setIsInsertMenuOpen] = useState(false)
  const [insertMenuAnchor, setInsertMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const [insertTargetCoords, setInsertTargetCoords] = useState<Point3D | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragAxisLock, setDragAxisLock] = useState<'x' | 'y' | 'z' | null>(null)
  const dragPlaneRef = useRef<Plane | null>(null)
  const dragStartPointRef = useRef<Vector3 | null>(null)
  const dragStartOffsetRef = useRef<OffsetVector | null>(null)
  const { tree, setIfcTree, resetTree, addCustomNode } = useObjectTree()
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const {
    selectedElement,
    offsetInputs,
    propertyFields,
    propertyError,
    isFetchingProperties,
    handleOffsetInputChange,
    applyOffsetToSelectedElement,
    handleFieldChange,
    handlePick,
    selectById,
    selectCustomCube,
    clearIfcHighlight,
    getElementWorldPosition,
    moveSelectedTo,
    getSelectedWorldPosition,
    resetSelection,
    clearOffsetArtifacts,
    spawnCube,
    spawnUploadedModel
  } = useSelectionOffsets(viewerRef)

  const ensureViewer = useViewerSetup(containerRef, viewerRef, wasmRootPath)

  const updateHoverCoords = useCallback(() => {
    // Cast a ray to show world coordinates under cursor
    const viewer = viewerRef.current
    if (!viewer) return

    const hit = viewer.context.castRayIfc()
    if (hit?.point) {
      setHoverCoords({
        x: hit.point.x,
        y: hit.point.y,
        z: hit.point.z
      })
    } else {
      setHoverCoords(null)
    }
  }, [])

  const spawnUnitCube = useCallback(() => {
    const target = insertTargetCoords || hoverCoords || null
    const info = spawnCube(target, { focus: true })
    if (!info) return
    addCustomNode({
      modelID: CUSTOM_CUBE_MODEL_ID,
      expressID: info.expressID,
      label: `Cube #${info.expressID}`,
      type: 'CUBE',
      parentId: selectedNodeId
    })
  }, [addCustomNode, hoverCoords, insertTargetCoords, selectedNodeId, spawnCube])

  const spawnUploadedModelAt = useCallback(
    async (uploadFile: File) => {
      const target = insertTargetCoords || hoverCoords || { x: 0, y: 0, z: 0 }
      await spawnUploadedModel(uploadFile, target, { focus: true })
    },
    [hoverCoords, insertTargetCoords, spawnUploadedModel]
  )

  const getModelCenter = useCallback((modelID: number): Point3D | null => {
    const viewer = viewerRef.current
    if (!viewer) return null
    const model = viewer.IFC.loader.ifcManager.state?.models?.[modelID]?.mesh
    if (!model || !('geometry' in model)) return null
    model.geometry.computeBoundingBox()
    const bbox = model.geometry.boundingBox
    if (!bbox) return null
    const center = new Vector3()
    bbox.getCenter(center)
    model.updateMatrixWorld(true)
    center.applyMatrix4(model.matrixWorld)
    return { x: center.x, y: center.y, z: center.z }
  }, [])

  const rebuildTreeForModel = useCallback(
    async (modelID: number, loadToken: number) => {
      const viewer = viewerRef.current
      if (!viewer) return
      try {
        const spatial = await viewer.IFC.getSpatialStructure(modelID)
        if (loadTokenRef.current !== loadToken) return
        const tree = buildIfcTree(spatial, modelID)
        if (loadTokenRef.current !== loadToken) return
        setIfcTree(tree, modelID)
        setSelectedNodeId(tree.roots[0] ?? null)
      } catch (err) {
        if (loadTokenRef.current !== loadToken) return
        console.error('Failed to build IFC tree', err)
        resetTree()
        setSelectedNodeId(null)
      }
    },
    [resetTree, setIfcTree]
  )

  const collectDescendantExpressIds = useCallback(
    (nodeId: string) => {
      const root = tree.nodes[nodeId]
      if (!root) return []
      const stack = [...root.children]
      const ids = new Set<number>()
      while (stack.length > 0) {
        const currentId = stack.pop()
        if (!currentId) continue
        const node = tree.nodes[currentId]
        if (!node) continue
        if (node.nodeType === 'ifc' && node.expressID !== null) {
          ids.add(node.expressID)
        }
        if (node.children.length > 0) {
          stack.push(...node.children)
        }
      }
      return Array.from(ids)
    },
    [tree.nodes]
  )

  const resolveNodePosition = useCallback(
    (nodeId: string): Point3D | null => {
      const node = tree.nodes[nodeId]
      if (!node) return null
      if (node.expressID !== null) {
        const direct = getElementWorldPosition(node.modelID, node.expressID)
        if (direct) return direct
      }
      if (node.nodeType === 'ifc') {
        const descendantIds = collectDescendantExpressIds(nodeId)
        for (const id of descendantIds) {
          const pos = getElementWorldPosition(node.modelID, id)
          if (pos) return pos
        }
      }
      return null
    },
    [collectDescendantExpressIds, getElementWorldPosition, tree.nodes]
  )

  const nudgeTowardCamera = useCallback((point: Point3D): Point3D => {
    const viewer = viewerRef.current
    if (!viewer) return point
    const camera = viewer.context.getCamera()
    const target = new Vector3(point.x, point.y, point.z)
    const cameraPos = new Vector3()
    camera.getWorldPosition(cameraPos)
    const direction = cameraPos.clone().sub(target)
    const distance = direction.length()
    if (distance === 0) return point
    direction.normalize()
    const offset = Math.min(0.6, distance * 0.25)
    target.add(direction.multiplyScalar(offset))
    return { x: target.x, y: target.y, z: target.z }
  }, [])

  const resolveTreeInsertTarget = useCallback(
    (nodeId: string): Point3D => {
      const node = tree.nodes[nodeId]
      let target = resolveNodePosition(nodeId)
      if (target && node?.nodeType === 'ifc') {
        target = nudgeTowardCamera(target)
      }
      if (!target && node) {
        target = getModelCenter(node.modelID)
      }
      if (!target) {
        const selectedPos = getSelectedWorldPosition()
        if (selectedPos) {
          target = { x: selectedPos.x, y: selectedPos.y, z: selectedPos.z }
        }
      }
      return target ?? hoverCoords ?? { x: 0, y: 0, z: 0 }
    },
    [
      getModelCenter,
      getSelectedWorldPosition,
      hoverCoords,
      nudgeTowardCamera,
      resolveNodePosition,
      tree.nodes
    ]
  )

  const getCoordinatesInsertTarget = useCallback(
    (nodeId: string): Point3D => {
      if (selectedElement) {
        return { x: offsetInputs.dx, y: offsetInputs.dy, z: offsetInputs.dz }
      }
      return resolveTreeInsertTarget(nodeId)
    },
    [offsetInputs, resolveTreeInsertTarget, selectedElement]
  )

  const handleTreeSelect = useCallback(
    async (nodeId: string) => {
      setSelectedNodeId(nodeId)
      const node = tree.nodes[nodeId]
      if (!node) return
      if (node.nodeType === 'ifc') {
        if (node.expressID !== null) {
          const descendantIds = collectDescendantExpressIds(nodeId)
          await selectById(node.modelID, node.expressID, { highlightIds: descendantIds })
          return
        }
        clearIfcHighlight()
        return
      }
      clearIfcHighlight()
      if (
        node.nodeType === 'custom' &&
        node.modelID === CUSTOM_CUBE_MODEL_ID &&
        node.expressID !== null
      ) {
        selectCustomCube(node.expressID)
      }
    },
    [clearIfcHighlight, collectDescendantExpressIds, selectById, selectCustomCube, tree.nodes]
  )

  const handleTreeAddCube = useCallback(
    (nodeId: string) => {
      const resolvedTarget = getCoordinatesInsertTarget(nodeId)
      const info = spawnCube(resolvedTarget, { focus: true })
      if (!info) return
      const newNodeId = addCustomNode({
        modelID: CUSTOM_CUBE_MODEL_ID,
        expressID: info.expressID,
        label: `Cube #${info.expressID}`,
        type: 'CUBE',
        parentId: nodeId
      })
      setSelectedNodeId(newNodeId)
      selectCustomCube(info.expressID)
    },
    [addCustomNode, getCoordinatesInsertTarget, selectCustomCube, spawnCube]
  )

  const handleTreeUploadModel = useCallback((nodeId: string) => {
    pendingTreeUploadRef.current = nodeId
    treeUploadInputRef.current?.click()
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      handlePick()
    }

    container.addEventListener('pointerdown', handlePointerDown)
    return () => {
      container.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [handlePick])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handlePointerMove = (event: PointerEvent) => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        lastPointerPosRef.current = {
          x: Math.max(0, Math.min(event.clientX - rect.left, rect.width)),
          y: Math.max(0, Math.min(event.clientY - rect.top, rect.height))
        }
      }
      if (isDragging) {
        // Dragging with axis lock into the plane aligned to camera
        const viewer = viewerRef.current
        const plane = dragPlaneRef.current
        if (viewer && plane && containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect()
          const ndc = new Vector3(
            (event.clientX - rect.left) / rect.width * 2 - 1,
            -(event.clientY - rect.top) / rect.height * 2 + 1,
            0.5
          )
          const raycaster = new Raycaster()
          raycaster.setFromCamera(ndc, viewer.context.getCamera())
          const hitPoint = new Vector3()
          const ok = raycaster.ray.intersectPlane(plane, hitPoint)
          if (ok && dragStartPointRef.current && dragStartOffsetRef.current) {
            const delta = hitPoint.clone().sub(dragStartPointRef.current)
            if (dragAxisLock === 'x') {
              delta.y = 0
              delta.z = 0
            } else if (dragAxisLock === 'y') {
              delta.x = 0
              delta.z = 0
            } else if (dragAxisLock === 'z') {
              delta.x = 0
              delta.y = 0
            }
            const newOffset = {
              dx: dragStartOffsetRef.current.dx + delta.x,
              dy: dragStartOffsetRef.current.dy + delta.y,
              dz: dragStartOffsetRef.current.dz + delta.z
            }
            moveSelectedTo(newOffset)
          }
        }
      } else {
        updateHoverCoords()
      }
    }

    container.addEventListener('pointermove', handlePointerMove)
    return () => {
      container.removeEventListener('pointermove', handlePointerMove)
    }
  }, [dragAxisLock, isDragging, moveSelectedTo, updateHoverCoords])

  useEffect(() => {
    if (!selectedElement) {
      setSelectedNodeId(null)
      return
    }
    const match = Object.values(tree.nodes).find(
      (node) =>
        node.modelID === selectedElement.modelID &&
        node.expressID === selectedElement.expressID
    )
    setSelectedNodeId(match?.id ?? null)
  }, [selectedElement, tree.nodes])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'a') {
        // Pop insert menu near cursor and cache the casted target point
        const container = containerRef.current
        if (container) {
          const rect = container.getBoundingClientRect()
          const x = Math.max(0, Math.min(lastPointerPosRef.current.x, rect.width))
          const y = Math.max(0, Math.min(lastPointerPosRef.current.y, rect.height))
          setInsertMenuAnchor({
            x: x + 12,
            y: y - 4
          })
        } else {
          setInsertMenuAnchor({ x: 16, y: 16 })
        }
        const viewer = viewerRef.current
        const hit = viewer?.context.castRayIfc()
        const point =
          hit?.point ??
          hoverCoords ?? {
            x: 0,
            y: 0,
            z: 0
          }
        setInsertTargetCoords(point ? { x: point.x, y: point.y, z: point.z } : null)
        setIsInsertMenuOpen(true)
      }
      if (event.key.toLowerCase() === 'g') {
        if (!selectedElement) return
        const viewer = viewerRef.current
        const currentPos = getSelectedWorldPosition()
        if (!viewer || !currentPos) return
        // Build a drag plane facing camera, remember starting offset
        const camera = viewer.context.getCamera()
        const normal = new Vector3()
        camera.getWorldDirection(normal)
        let startPoint = currentPos
        if (selectedElement.modelID !== CUSTOM_CUBE_MODEL_ID) {
          const hit = viewer.context.castRayIfc()
          if (hit?.point) {
            startPoint = hit.point
          }
        }
        const plane = new Plane().setFromNormalAndCoplanarPoint(normal, startPoint)
        dragPlaneRef.current = plane
        dragStartPointRef.current = startPoint.clone()
        dragStartOffsetRef.current = {
          dx: offsetInputs.dx,
          dy: offsetInputs.dy,
          dz: offsetInputs.dz
        }
        setIsDragging(true)
        setDragAxisLock(null)
      }
      if (isDragging && ['x', 'y', 'z'].includes(event.key.toLowerCase())) {
        const key = event.key.toLowerCase() as 'x' | 'y' | 'z'
        setDragAxisLock(key)
      }
      if (event.key === 'Escape') {
        setIsInsertMenuOpen(false)
        setInsertMenuAnchor(null)
        setInsertTargetCoords(null)
        setIsDragging(false)
        setDragAxisLock(null)
        dragPlaneRef.current = null
        dragStartPointRef.current = null
        dragStartOffsetRef.current = null
      }
    }

    const handlePointerUp = () => {
      setIsDragging(false)
      setDragAxisLock(null)
      dragPlaneRef.current = null
      dragStartPointRef.current = null
      dragStartOffsetRef.current = null
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [getSelectedWorldPosition, hoverCoords, isDragging, offsetInputs, selectedElement])

  const loadModel = useCallback(
    async (loader: Loader, message: string) => {
      const viewer = ensureViewer()
      if (!viewer) return

      const token = ++loadTokenRef.current

      setStatus(message)
      setError(null)
      resetSelection()
      resetTree()
      setSelectedNodeId(null)
      if (lastModelIdRef.current !== null) {
        clearOffsetArtifacts(lastModelIdRef.current)
      }

      if (lastModelIdRef.current !== null) {
        viewer.IFC.removeIfcModel(lastModelIdRef.current)
        lastModelIdRef.current = null
      }

      try {
        const model = await loader(viewer)
        if (!model) {
          throw new Error('IFC model could not be loaded.')
        }

        if (loadTokenRef.current !== token) {
          if (model.modelID !== undefined) {
            viewer.IFC.removeIfcModel(model.modelID)
          }
          return
        }

        if (model.modelID !== undefined) {
          lastModelIdRef.current = model.modelID
          await rebuildTreeForModel(model.modelID, token)
        }
        setStatus(null)
      } catch (err) {
        if (loadTokenRef.current !== token) {
          return
        }
        console.error('Failed to load IFC model', err)
        setError('Failed to load IFC model. Check the console for details.')
        setStatus(null)
        resetTree()
      }
    },
    [clearOffsetArtifacts, ensureViewer, rebuildTreeForModel, resetSelection, resetTree]
  )

  useEffect(() => {
    ensureViewer()

    return () => {
      clearOffsetArtifacts()
      if (viewerRef.current) {
        viewerRef.current.dispose()
        viewerRef.current = null
      }
      lastModelIdRef.current = null
      resetTree()
      setSelectedNodeId(null)
    }
  }, [clearOffsetArtifacts, ensureViewer, resetTree])

  useEffect(() => {
    if (!defaultModelUrl) {
      return
    }

    if (file) {
      loadModel((viewer) => viewer.IFC.loadIfc(file, true), 'Loading IFC file...')
    } else {
      loadModel(
        (viewer) => viewer.IFC.loadIfcUrl(defaultModelUrl, true),
        'Loading sample model...'
      )
    }
  }, [defaultModelUrl, file, loadModel])

  return (
    <>
      <div className="viewer-wrapper">
        <div className="viewer-layout">
          <div className="viewer-stage">
            <div ref={containerRef} className="viewer-container" />
            <CoordsOverlay hoverCoords={hoverCoords} />
            <InsertMenu
              open={isInsertMenuOpen}
              anchor={insertMenuAnchor}
              onInsertCube={() => {
                spawnUnitCube()
                setIsInsertMenuOpen(false)
                setInsertMenuAnchor(null)
                setInsertTargetCoords(null)
              }}
              onUploadClick={() => uploadInputRef.current?.click()}
              onCancel={() => {
                setIsInsertMenuOpen(false)
                setInsertMenuAnchor(null)
                setInsertTargetCoords(null)
              }}
            />
            {status && <div className="viewer-overlay">{status}</div>}
            {error && <div className="viewer-overlay viewer-overlay--error">{error}</div>}
          </div>

          <div className="side-panel">
            <ObjectTreePanel
              tree={tree}
              selectedNodeId={selectedNodeId}
              onSelectNode={handleTreeSelect}
              onAddCube={handleTreeAddCube}
              onUploadModel={handleTreeUploadModel}
            />
            <PropertiesPanel
              selectedElement={selectedElement}
              isFetchingProperties={isFetchingProperties}
              propertyError={propertyError}
              offsetInputs={offsetInputs}
              onOffsetChange={handleOffsetInputChange}
              onApplyOffset={applyOffsetToSelectedElement}
              propertyFields={propertyFields}
              onFieldChange={handleFieldChange}
            />
          </div>
        </div>
      </div>
      <input
        type="file"
        accept=".ifc"
        style={{ display: 'none' }}
        ref={uploadInputRef}
        onChange={async (event) => {
          const inputFile = event.target.files?.[0]
          if (inputFile) {
            await spawnUploadedModelAt(inputFile)
          }
          event.target.value = ''
          setIsInsertMenuOpen(false)
          setInsertMenuAnchor(null)
          setInsertTargetCoords(null)
        }}
      />
      <input
        type="file"
        accept=".ifc"
        style={{ display: 'none' }}
        ref={treeUploadInputRef}
        onChange={async (event) => {
          const inputFile = event.target.files?.[0]
          const parentId = pendingTreeUploadRef.current
          if (inputFile && parentId) {
            const resolvedTarget = getCoordinatesInsertTarget(parentId)
            const info = await spawnUploadedModel(inputFile, resolvedTarget, { focus: true })
            if (info) {
              const newNodeId = addCustomNode({
                modelID: info.modelID,
                expressID: null,
                label: inputFile.name,
                type: 'IFC',
                parentId
              })
              setSelectedNodeId(newNodeId)
            }
          }
          pendingTreeUploadRef.current = null
          event.target.value = ''
        }}
      />
    </>
  )
}

export default IfcViewer
