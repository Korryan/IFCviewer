import { useCallback, useEffect, useRef, useState } from 'react'
import { Color, Mesh } from 'three'
import CameraControls from 'camera-controls'
import { IfcViewerAPI } from 'web-ifc-viewer'

type IfcViewerProps = {
  file?: File | null
  defaultModelUrl?: string
}

type Loader = (viewer: IfcViewerAPI) => Promise<any>

type SelectedElement = {
  modelID: number
  expressID: number
  type?: string
}

type PropertyField = {
  key: string
  label: string
  value: string
}

type OffsetVector = {
  dx: number
  dy: number
  dz: number
}

type SpatialTreeNode = {
  expressID: number
  type: string
  name: string
  children: SpatialTreeNode[]
}

const wasmRootPath = '/ifc/'
const BASE_SUBSET_ID = 'base-offset-subset'
const MOVED_SUBSET_PREFIX = 'moved-offset-'
const zeroOffset: OffsetVector = { dx: 0, dy: 0, dz: 0 }

const IfcViewer = ({ file, defaultModelUrl = '/test.ifc' }: IfcViewerProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<IfcViewerAPI | null>(null)
  const lastModelIdRef = useRef<number | null>(null)
  const loadTokenRef = useRef(0)
  const propertyRequestRef = useRef(0)
  const treeRequestRef = useRef(0)
  const spatialIndexRef = useRef<Map<number, number[]>>(new Map())
  const baseSubsetsRef = useRef<Map<number, Mesh>>(new Map())
  const movedSubsetsRef = useRef<Map<string, Mesh>>(new Map())
  const elementOffsetsRef = useRef<Map<string, OffsetVector>>(new Map())
  const [status, setStatus] = useState<string | null>('Loading sample model...')
  const [error, setError] = useState<string | null>(null)
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null)
  const [offsetInputs, setOffsetInputs] = useState<OffsetVector>(zeroOffset)
  const [propertyFields, setPropertyFields] = useState<PropertyField[]>([])
  const [propertyError, setPropertyError] = useState<string | null>(null)
  const [isFetchingProperties, setIsFetchingProperties] = useState(false)
  const [spatialTree, setSpatialTree] = useState<SpatialTreeNode | null>(null)
  const [spatialTreeError, setSpatialTreeError] = useState<string | null>(null)
  const [isFetchingSpatialTree, setIsFetchingSpatialTree] = useState(false)
  const [expandedNodes, setExpandedNodes] = useState<Set<number>>(() => new Set())

  // Lazy-initialize the underlying IfcViewerAPI once the div ref is ready
  const ensureViewer = useCallback(() => {
    if (viewerRef.current || !containerRef.current) {
      return viewerRef.current
    }

    const viewer = new IfcViewerAPI({
      container: containerRef.current,
      backgroundColor: new Color(0xf3f4f6)
    })

    viewer.axes.setAxes()
    viewer.grid.setGrid()
    viewer.IFC.setWasmPath(wasmRootPath)
    viewer.context.renderer.postProduction.active = true
    const cameraControls = viewer.context.ifcCamera.cameraControls
    cameraControls.mouseButtons.left = CameraControls.ACTION.NONE
    cameraControls.mouseButtons.middle = CameraControls.ACTION.ROTATE
    cameraControls.mouseButtons.right = CameraControls.ACTION.TRUCK
    cameraControls.mouseButtons.wheel = CameraControls.ACTION.DOLLY

    viewerRef.current = viewer
    return viewer
  }, [])

  const resetSelection = useCallback(() => {
    propertyRequestRef.current += 1
    setSelectedElement(null)
    setOffsetInputs(zeroOffset)
    setPropertyFields([])
    setPropertyError(null)
    setIsFetchingProperties(false)
  }, [])

  const resetSpatialTree = useCallback(() => {
    treeRequestRef.current += 1
    spatialIndexRef.current.clear()
    setSpatialTree(null)
    setSpatialTreeError(null)
    setIsFetchingSpatialTree(false)
    setExpandedNodes(new Set())
  }, [])

  const getElementKey = useCallback((modelID: number, expressID: number) => {
    return `${modelID}:${expressID}`
  }, [])

  const removePickable = useCallback((viewer: IfcViewerAPI, mesh: Mesh) => {
    const pickables = viewer.context.items.pickableIfcModels
    const index = pickables.indexOf(mesh as any)
    if (index !== -1) {
      pickables.splice(index, 1)
    }
  }, [])

  const registerPickable = useCallback(
    (viewer: IfcViewerAPI, mesh: Mesh, slot?: number) => {
      const pickables = viewer.context.items.pickableIfcModels
      if (typeof slot === 'number') {
        pickables[slot] = mesh as any
        return
      }
      if (!pickables.includes(mesh as any)) {
        pickables.push(mesh as any)
      }
    },
    []
  )

  const getAllExpressIdsForModel = useCallback((modelID: number) => {
    const viewer = viewerRef.current
    if (!viewer) return []

    const model = viewer.IFC.loader.ifcManager.state?.models?.[modelID]?.mesh
    const expressAttr = model?.geometry.getAttribute('expressID')
    if (!expressAttr || !('array' in expressAttr)) return []

    const uniqueIds = new Set<number>()
    Array.from((expressAttr as { array: ArrayLike<number> }).array).forEach((rawId) => {
      if (typeof rawId === 'number') {
        uniqueIds.add(rawId)
      }
    })
    return Array.from(uniqueIds)
  }, [])

  const ensureBaseSubset = useCallback(
    (modelID: number) => {
      const viewer = viewerRef.current
      if (!viewer) return null
      if (baseSubsetsRef.current.has(modelID)) {
        return baseSubsetsRef.current.get(modelID) || null
      }

      const ids = getAllExpressIdsForModel(modelID)
      if (ids.length === 0) {
        return null
      }

      const manager = viewer.IFC.loader.ifcManager
      const model = manager.state?.models?.[modelID]?.mesh
      const subset = manager.createSubset({
        modelID,
        ids,
        scene: viewer.context.getScene(),
        removePrevious: true,
        customID: BASE_SUBSET_ID
      })

      if (!subset || !model) {
        return null
      }

      subset.matrix.copy(model.matrix)
      subset.matrixAutoUpdate = false
      model.visible = false

      baseSubsetsRef.current.set(modelID, subset as Mesh)
      registerPickable(viewer, subset as Mesh, modelID)
      return subset as Mesh
    },
    [getAllExpressIdsForModel, registerPickable]
  )

  const clearOffsetArtifacts = useCallback(
    (modelID?: number | null) => {
      const viewer = viewerRef.current
      if (!viewer) return

      const manager = viewer.IFC.loader.ifcManager
      const scene = viewer.context.getScene()
      const derivedIds = Array.from(
        new Set([
          ...baseSubsetsRef.current.keys(),
          ...Array.from(movedSubsetsRef.current.keys())
            .map((key) => Number(key.split(':')[0]))
            .filter((id) => Number.isFinite(id))
        ])
      )
      const idsToClear = typeof modelID === 'number' ? [modelID] : derivedIds

      idsToClear.forEach((id) => {
        const movedKeys = Array.from(movedSubsetsRef.current.keys()).filter((key) =>
          key.startsWith(`${id}:`)
        )
        movedKeys.forEach((key) => {
          const moved = movedSubsetsRef.current.get(key)
          if (moved) {
            scene.remove(moved)
            removePickable(viewer, moved)
            manager.removeSubset(id, undefined, `${MOVED_SUBSET_PREFIX}${key}`)
          }
          movedSubsetsRef.current.delete(key)
          elementOffsetsRef.current.delete(key)
        })

        const baseSubset = baseSubsetsRef.current.get(id)
        if (baseSubset) {
          scene.remove(baseSubset)
          removePickable(viewer, baseSubset)
          manager.removeSubset(id, undefined, BASE_SUBSET_ID)
          baseSubsetsRef.current.delete(id)
        }

        const model = manager.state?.models?.[id]?.mesh
        if (model) {
          model.visible = true
          registerPickable(viewer, model, id)
        }
      })
    },
    [registerPickable, removePickable]
  )

  const normalizeIfcValue = useCallback((rawValue: any): string => {
    if (rawValue === null || rawValue === undefined) {
      return ''
    }
    if (typeof rawValue === 'object') {
      if ('value' in rawValue) {
        return rawValue.value === null || rawValue.value === undefined
          ? ''
          : String(rawValue.value)
      }
      if (Array.isArray(rawValue)) {
        return rawValue.map((entry) => normalizeIfcValue(entry)).join(', ')
      }
      return ''
    }
    return String(rawValue)
  }, [])

  const mapSpatialNode = useCallback(
    (rawNode: any): SpatialTreeNode | null => {
      if (!rawNode || typeof rawNode !== 'object') {
        return null
      }

      const expressID =
        typeof rawNode.expressID === 'number'
          ? rawNode.expressID
          : typeof rawNode.expressId === 'number'
            ? rawNode.expressId
            : typeof rawNode.id === 'number'
              ? rawNode.id
              : null

      if (expressID === null) {
        return null
      }

      const type =
        typeof rawNode.type === 'string'
          ? rawNode.type
          : typeof rawNode.ifcClass === 'string'
            ? rawNode.ifcClass
            : 'IFCENTITY'

      const labelCandidates = [
        rawNode.Name,
        rawNode.name,
        rawNode.LongName,
        rawNode.ObjectType,
        rawNode.Description
      ]

      const name =
        labelCandidates
          .map((candidate) => {
            if (typeof candidate === 'string') {
              return candidate
            }
            return normalizeIfcValue(candidate)
          })
          .find((candidate) => candidate && candidate.trim().length > 0) || `${type} #${expressID}`

      const childEntries = Object.entries(rawNode).filter(
        ([key, value]) => Array.isArray(value) && /children|items/i.test(key)
      )

      const children = childEntries
        .flatMap(([, value]) => value as any[])
        .map((child) => mapSpatialNode(child))
        .filter((child): child is SpatialTreeNode => Boolean(child))

      return {
        expressID,
        type,
        name,
        children
      }
    },
    [normalizeIfcValue]
  )

  const rebuildSpatialIndex = useCallback((root: SpatialTreeNode | null) => {
    spatialIndexRef.current.clear()
    const initiallyExpanded = new Set<number>()

    if (!root) {
      return initiallyExpanded
    }

    const traverse = (node: SpatialTreeNode, ancestors: number[]) => {
      spatialIndexRef.current.set(node.expressID, ancestors)
      node.children.forEach((child) => traverse(child, [...ancestors, node.expressID]))
    }

    traverse(root, [])
    initiallyExpanded.add(root.expressID)
    root.children.forEach((child) => initiallyExpanded.add(child.expressID))
    return initiallyExpanded
  }, [])

  const expandToNode = useCallback((expressID: number) => {
    const ancestors = spatialIndexRef.current.get(expressID)
    if (!ancestors) {
      return
    }

    setExpandedNodes((prev) => {
      const next = new Set(prev)
      ancestors.forEach((ancestorID) => next.add(ancestorID))
      next.add(expressID)
      return next
    })
  }, [])

  const buildPropertyFields = useCallback(
    (rawProperties: any): PropertyField[] => {
      if (!rawProperties) {
        return []
      }

      const fields: PropertyField[] = []
      const preferredKeys = [
        'GlobalId',
        'Name',
        'Description',
        'ObjectType',
        'PredefinedType',
        'Tag'
      ]

      const seenKeys = new Set<string>()
      const addField = (key: string, label: string, rawValue: any) => {
        const normalized = normalizeIfcValue(rawValue)
        if (normalized === '' && normalized !== rawValue) {
          // Skip empty derived values to avoid noise
          return
        }
        const uniqueKey = seenKeys.has(key) ? `${key}-${seenKeys.size}` : key
        seenKeys.add(uniqueKey)
        fields.push({
          key: uniqueKey,
          label,
          value: normalized
        })
      }

      preferredKeys.forEach((key) => {
        if (rawProperties[key] !== undefined) {
          addField(key, key, rawProperties[key])
        }
      })

      Object.entries(rawProperties).forEach(([key, value]) => {
        if (preferredKeys.includes(key)) {
          return
        }
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          addField(key, key, value)
        } else if (value && typeof value === 'object' && 'value' in value) {
          addField(key, key, value)
        }
      })

      if (Array.isArray(rawProperties.psets)) {
        rawProperties.psets.forEach((pset: any, psetIndex: number) => {
          const setName =
            normalizeIfcValue(pset?.Name) || `Property Set ${psetIndex + 1}`
          const properties = Array.isArray(pset?.HasProperties) ? pset.HasProperties : []
          properties.forEach((prop: any, propIndex: number) => {
            const propName =
              normalizeIfcValue(prop?.Name) || `Property ${propIndex + 1}`
            const propValue =
              prop?.NominalValue ??
              prop?.LengthValue ??
              prop?.AreaValue ??
              prop?.VolumeValue ??
              prop?.BooleanValue ??
              prop?.IntegerValue ??
              prop?.RealValue ??
              prop?.Value ??
              prop

            const key = `pset-${pset?.expressID ?? psetIndex}-${prop?.expressID ?? propIndex}`
            addField(key, `${setName} / ${propName}`, propValue)
          })
        })
      }

      return fields.slice(0, 60)
    },
    [normalizeIfcValue]
  )

  const fetchSpatialTree = useCallback(
    async (modelID: number) => {
      const viewer = viewerRef.current
      if (!viewer) return

      const requestToken = ++treeRequestRef.current
      setIsFetchingSpatialTree(true)
      setSpatialTreeError(null)

      try {
        const rawStructure = await viewer.IFC.getSpatialStructure(modelID, true)
        if (treeRequestRef.current !== requestToken) {
          return
        }

        const mappedTree = mapSpatialNode(rawStructure)
        setSpatialTree(mappedTree)
        setExpandedNodes(rebuildSpatialIndex(mappedTree))
      } catch (err) {
        if (treeRequestRef.current !== requestToken) {
          return
        }
        console.error('Failed to read IFC spatial structure', err)
        setSpatialTree(null)
        setExpandedNodes(new Set())
        setSpatialTreeError('Unable to read IFC spatial structure.')
      } finally {
        if (treeRequestRef.current === requestToken) {
          setIsFetchingSpatialTree(false)
        }
      }
    },
    [mapSpatialNode, rebuildSpatialIndex]
  )

  const fetchProperties = useCallback(
    async (modelID: number, expressID: number) => {
      const viewer = viewerRef.current
      if (!viewer) return

      const requestToken = ++propertyRequestRef.current
      setIsFetchingProperties(true)
      setPropertyError(null)

      try {
        const properties = await viewer.IFC.getProperties(modelID, expressID, true, true)
        if (!properties) {
          throw new Error('No properties returned for this element.')
        }
        if (propertyRequestRef.current !== requestToken) {
          return
        }

        setSelectedElement({
          modelID,
          expressID,
          type: properties.type ?? properties.ifcClass
        })
        const key = getElementKey(modelID, expressID)
        setOffsetInputs(elementOffsetsRef.current.get(key) ?? zeroOffset)
        expandToNode(expressID)
        setPropertyFields(buildPropertyFields(properties))
      } catch (err) {
        if (propertyRequestRef.current !== requestToken) {
          return
        }
        console.error('Failed to load IFC properties', err)
        setPropertyError('Unable to load IFC properties for the selected element.')
        setSelectedElement(null)
        setPropertyFields([])
      } finally {
        if (propertyRequestRef.current === requestToken) {
          setIsFetchingProperties(false)
        }
      }
    },
    [buildPropertyFields, expandToNode, getElementKey]
  )

  const handleFieldChange = useCallback((key: string, value: string) => {
    setPropertyFields((prev) =>
      prev.map((field) => (field.key === key ? { ...field, value } : field))
    )
  }, [])

  const handleOffsetInputChange = useCallback((axis: keyof OffsetVector, value: number) => {
    setOffsetInputs((prev) => ({
      ...prev,
      [axis]: Number.isFinite(value) ? value : 0
    }))
  }, [])

  const applyOffsetToSelectedElement = useCallback(() => {
    const viewer = viewerRef.current
    if (!viewer || !selectedElement) return

    const manager = viewer.IFC.loader.ifcManager
    const scene = viewer.context.getScene()
    const { modelID, expressID } = selectedElement
    const key = getElementKey(modelID, expressID)

    const baseSubset = ensureBaseSubset(modelID)
    if (!baseSubset) {
      return
    }

    const previous = movedSubsetsRef.current.get(key)
    if (previous) {
      scene.remove(previous)
      removePickable(viewer, previous)
      manager.removeSubset(modelID, undefined, `${MOVED_SUBSET_PREFIX}${key}`)
      movedSubsetsRef.current.delete(key)
    }

    const isZeroOffset =
      offsetInputs.dx === 0 && offsetInputs.dy === 0 && offsetInputs.dz === 0

    if (isZeroOffset) {
      manager.createSubset({
        modelID,
        ids: [expressID],
        scene,
        removePrevious: false,
        customID: BASE_SUBSET_ID
      })
      elementOffsetsRef.current.delete(key)
      return
    }

    manager.removeFromSubset(modelID, [expressID], BASE_SUBSET_ID)

    const moved = manager.createSubset({
      modelID,
      ids: [expressID],
      scene,
      removePrevious: true,
      customID: `${MOVED_SUBSET_PREFIX}${key}`
    })

    if (!moved) {
      return
    }

    moved.position.set(offsetInputs.dx, offsetInputs.dy, offsetInputs.dz)
    moved.updateMatrix()
    moved.matrixAutoUpdate = false

    movedSubsetsRef.current.set(key, moved as Mesh)
    elementOffsetsRef.current.set(key, offsetInputs)
    registerPickable(viewer, moved as Mesh)
  }, [
    ensureBaseSubset,
    getElementKey,
    offsetInputs,
    registerPickable,
    removePickable,
    selectedElement
  ])

  const toggleNode = useCallback((expressID: number) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(expressID)) {
        next.delete(expressID)
      } else {
        next.add(expressID)
      }
      return next
    })
  }, [])

  const handleNodeSelect = useCallback(
    async (node: SpatialTreeNode) => {
      const viewer = viewerRef.current
      const modelID = lastModelIdRef.current
      if (!viewer || modelID === null) {
        return
      }

      try {
        await viewer.IFC.selector.pickIfcItemsByID(modelID, [node.expressID], true, true)
      } catch (err) {
        console.warn('Failed to highlight selection from tree', err)
      }

      await fetchProperties(modelID, node.expressID)
    },
    [fetchProperties]
  )

  const handlePick = useCallback(async () => {
    const viewer = viewerRef.current
    if (!viewer) {
      return
    }

    try {
      const picked = await viewer.IFC.selector.pickIfcItem(true)
      if (!picked || picked.id === undefined || picked.modelID === undefined) {
        viewer.IFC.selector.unpickIfcItems()
        resetSelection()
        return
      }

      await fetchProperties(picked.modelID, picked.id)
    } catch (err) {
      console.error('Failed to pick IFC item', err)
      resetSelection()
    }
  }, [fetchProperties, resetSelection])

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

  // Helper to sequentially load models and clean up/abort overlapping requests
  const loadModel = useCallback(
    async (loader: Loader, message: string) => {
      const viewer = ensureViewer()
      if (!viewer) return

      const token = ++loadTokenRef.current

      setStatus(message)
      setError(null)
      resetSelection()
      resetSpatialTree()
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
          fetchSpatialTree(model.modelID)
        }
        setStatus(null)
      } catch (err) {
        if (loadTokenRef.current !== token) {
          return
        }
        console.error('Failed to load IFC model', err)
        setError('Failed to load IFC model. Check the console for details.')
        setStatus(null)
      }
    },
    [clearOffsetArtifacts, ensureViewer, fetchSpatialTree, resetSelection, resetSpatialTree]
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
    }
  }, [clearOffsetArtifacts, ensureViewer])

  useEffect(() => {
    if (!defaultModelUrl) {
      return
    }

    // Switch between default sample (URL) and uploaded file
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
    <div className="viewer-wrapper">
      <div className="viewer-layout">
        <div className="viewer-stage">
          <div ref={containerRef} className="viewer-container" />
          {status && <div className="viewer-overlay">{status}</div>}
          {error && <div className="viewer-overlay viewer-overlay--error">{error}</div>}
        </div>
        <aside className="properties-panel">
          <header className="properties-panel__header">
            <h2>Element properties</h2>
            {selectedElement && (
              <p className="properties-panel__meta">
                #{selectedElement.expressID}{' '}
                {selectedElement.type ? `· ${selectedElement.type}` : ''}
              </p>
            )}
          </header>
          <div className="properties-panel__content">
            {isFetchingProperties && (
              <p className="properties-panel__status">Loading properties…</p>
            )}
            {propertyError && (
              <p className="properties-panel__status properties-panel__status--error">
                {propertyError}
              </p>
            )}
            {!isFetchingProperties && !propertyError && !selectedElement && (
              <p className="properties-panel__status">
                Click any element in the scene to inspect and edit its metadata.
              </p>
            )}
            {!isFetchingProperties && !propertyError && selectedElement && (
              <>
                <div className="offset-panel">
                  <h3>Offset</h3>
                  <div className="offset-panel__grid">
                    {(['dx', 'dy', 'dz'] as Array<keyof OffsetVector>).map((axis) => (
                      <label key={axis} className="offset-panel__field">
                        <span>{axis.toUpperCase()}</span>
                        <input
                          type="number"
                          step="0.01"
                          value={offsetInputs[axis]}
                          onChange={(event) =>
                            handleOffsetInputChange(
                              axis,
                              Number.isFinite(parseFloat(event.target.value))
                                ? parseFloat(event.target.value)
                                : 0
                            )
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="offset-panel__apply"
                    onClick={applyOffsetToSelectedElement}
                  >
                    Apply offset
                  </button>
                  <p className="properties-panel__hint">
                    The IFC file stays untouched; only the rendered element moves.
                  </p>
                </div>
                <form className="properties-form">
                  {propertyFields.length > 0 ? (
                    propertyFields.map((field) => {
                      const isLongValue = field.value.length > 60 || field.value.includes('\n')
                      return (
                        <label key={field.key} className="properties-form__field">
                          <span>{field.label}</span>
                          {isLongValue ? (
                            <textarea
                              value={field.value}
                              onChange={(event) =>
                                handleFieldChange(field.key, event.target.value)
                              }
                              rows={Math.min(6, Math.max(2, Math.ceil(field.value.length / 60)))}
                            />
                          ) : (
                            <input
                              type="text"
                              value={field.value}
                              onChange={(event) =>
                                handleFieldChange(field.key, event.target.value)
                              }
                            />
                          )}
                        </label>
                      )
                    })
                  ) : (
                    <p className="properties-panel__status">
                      This element does not expose any simple IFC attributes.
                    </p>
                  )}
                </form>
                <p className="properties-panel__hint">
                  Changes are stored only in memory for now; backend sync will come later.
                </p>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

export default IfcViewer
