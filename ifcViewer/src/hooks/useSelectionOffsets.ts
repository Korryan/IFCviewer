import { useCallback, useRef, useState } from 'react'
// Encapsulates selection, IFC property fetching, and offset/subset handling
import {
  BoxGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  Vector3
} from 'three'
import type { IfcViewerAPI } from 'web-ifc-viewer'
import type { OffsetVector, Point3D, PropertyField, SelectedElement } from '../ifcViewerTypes'

const BASE_SUBSET_ID = 'base-offset-subset'
const MOVED_SUBSET_PREFIX = 'moved-offset-'
const zeroOffset: OffsetVector = { dx: 0, dy: 0, dz: 0 }
const CUBE_BASE_COLOR = 0x4f46e5
const CUBE_HIGHLIGHT_COLOR = 0xffb100
export const CUSTOM_CUBE_MODEL_ID = -999

type UseSelectionOffsetsResult = {
  selectedElement: SelectedElement | null
  offsetInputs: OffsetVector
  propertyFields: PropertyField[]
  propertyError: string | null
  isFetchingProperties: boolean
  handleOffsetInputChange: (axis: keyof OffsetVector, value: number) => void
  applyOffsetToSelectedElement: () => void
  handleFieldChange: (key: string, value: string) => void
  handlePick: () => Promise<void>
  moveSelectedTo: (targetOffset: OffsetVector) => void
  getSelectedWorldPosition: () => Vector3 | null
  resetSelection: () => void
  clearOffsetArtifacts: (modelID?: number | null) => void
  spawnCube: (target?: Point3D | null, options?: { focus?: boolean }) => Point3D | null
  spawnUploadedModel: (
    file: File,
    target?: Point3D | null,
    options?: { focus?: boolean }
  ) => Promise<void>
}

export const useSelectionOffsets = (
  viewerRef: { current: IfcViewerAPI | null }
): UseSelectionOffsetsResult => {
  // Local caches for subsets/cubes/offsets; kept outside React state to avoid re-renders
  const propertyRequestRef = useRef(0)
  const baseSubsetsRef = useRef<Map<number, Mesh>>(new Map())
  const movedSubsetsRef = useRef<Map<string, Mesh>>(new Map())
  const elementOffsetsRef = useRef<Map<string, OffsetVector>>(new Map())
  const cubeRegistryRef = useRef<Map<number, Mesh>>(new Map())
  const cubeIdCounterRef = useRef(1)
  const highlightedCubeRef = useRef<number | null>(null)

  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null)
  const [offsetInputs, setOffsetInputs] = useState<OffsetVector>(zeroOffset)
  const [propertyFields, setPropertyFields] = useState<PropertyField[]>([])
  const [propertyError, setPropertyError] = useState<string | null>(null)
  const [isFetchingProperties, setIsFetchingProperties] = useState(false)
  const focusOnPoint = useCallback(
    (point: Point3D | null) => {
      const viewer = viewerRef.current
      if (!viewer || !point) return
      const controls = viewer.context.ifcCamera.cameraControls
      const current = new Vector3()
      controls.getPosition(current)
      controls.setLookAt(current.x, current.y, current.z, point.x, point.y, point.z, true)
    },
    [viewerRef]
  )

  const setCubeHighlight = useCallback((expressID: number | null) => {
    // Toggle cube color to indicate selection
    if (highlightedCubeRef.current !== null && highlightedCubeRef.current !== expressID) {
      const prevCube = cubeRegistryRef.current.get(highlightedCubeRef.current)
      const prevMaterial = prevCube?.material as MeshStandardMaterial
      if (prevMaterial?.color) {
        prevMaterial.color.set(CUBE_BASE_COLOR)
      }
    }

    if (expressID === null) {
      highlightedCubeRef.current = null
      return
    }

    const cube = cubeRegistryRef.current.get(expressID)
    const material = cube?.material as MeshStandardMaterial
    if (material?.color) {
      material.color.set(CUBE_HIGHLIGHT_COLOR)
      highlightedCubeRef.current = expressID
    }
  }, [])

  const getSelectedWorldPosition = useCallback((): Vector3 | null => {
    if (!selectedElement) return null
    if (selectedElement.modelID === CUSTOM_CUBE_MODEL_ID) {
      const cube = cubeRegistryRef.current.get(selectedElement.expressID)
      return cube ? cube.position.clone() : null
    }
    return new Vector3(offsetInputs.dx, offsetInputs.dy, offsetInputs.dz)
  }, [offsetInputs, selectedElement])

  const resetSelection = useCallback(() => {
    // Cancel in-flight property requests and clear UI state
    propertyRequestRef.current += 1
    setSelectedElement(null)
    setOffsetInputs(zeroOffset)
    setPropertyFields([])
    setPropertyError(null)
    setIsFetchingProperties(false)
    setCubeHighlight(null)
  }, [setCubeHighlight])

  const getElementKey = useCallback((modelID: number, expressID: number) => {
    return `${modelID}:${expressID}`
  }, [])

  const getModelBaseOffset = useCallback(
    (modelID: number): OffsetVector => {
      // Prefer original mesh position; fall back to stored subset position
      const viewer = viewerRef.current
      const mesh = viewer?.IFC.loader.ifcManager.state?.models?.[modelID]?.mesh
      if (mesh) {
        return { dx: mesh.position.x, dy: mesh.position.y, dz: mesh.position.z }
      }
      const base = baseSubsetsRef.current.get(modelID)
      if (base) {
        return { dx: base.position.x, dy: base.position.y, dz: base.position.z }
      }
      return zeroOffset
    },
    [viewerRef]
  )

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

  const getAllExpressIdsForModel = useCallback(
    (modelID: number) => {
      // Extract every expressID present in a model geometry
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
    },
    [viewerRef]
  )

  const ensureBaseSubset = useCallback(
    (modelID: number) => {
      // Build one subset per model to hide originals and enable per-item offsets
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
    [getAllExpressIdsForModel, registerPickable, viewerRef]
  )

  const clearOffsetArtifacts = useCallback(
    (modelID?: number | null) => {
      // Remove derived subsets and restore pickable originals
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
    [registerPickable, removePickable, viewerRef]
  )

  const normalizeIfcValue = useCallback((rawValue: any): string => {
    // Flatten IFC property shapes into strings for display
    if (rawValue === null || rawValue === undefined) {
      return ''
    }
    if (typeof rawValue === 'object') {
      if ('value' in rawValue) {
        return rawValue.value === null || rawValue.value === undefined ? '' : String(rawValue.value)
      }
      if (Array.isArray(rawValue)) {
        return rawValue.map((entry) => normalizeIfcValue(entry)).join(', ')
      }
      return ''
    }
    return String(rawValue)
  }, [])

  const buildPropertyFields = useCallback(
    (rawProperties: any): PropertyField[] => {
      // Select a handful of readable properties and property sets for the panel
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
          const setName = normalizeIfcValue(pset?.Name) || `Property Set ${psetIndex + 1}`
          const properties = Array.isArray(pset?.HasProperties) ? pset.HasProperties : []
          properties.forEach((prop: any, propIndex: number) => {
            const propName = normalizeIfcValue(prop?.Name) || `Property ${propIndex + 1}`
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

  const fetchProperties = useCallback(
    async (modelID: number, expressID: number) => {
      // Guard against race conditions by tokenizing property requests
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
        const fallbackOffset = getModelBaseOffset(modelID)
        setOffsetInputs(elementOffsetsRef.current.get(key) ?? fallbackOffset)
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
    [buildPropertyFields, getElementKey, getModelBaseOffset, viewerRef]
  )

  const handleFieldChange = useCallback((key: string, value: string) => {
    setPropertyFields((prev) => prev.map((field) => (field.key === key ? { ...field, value } : field)))
  }, [])

  const handleOffsetInputChange = useCallback((axis: keyof OffsetVector, value: number) => {
    setOffsetInputs((prev) => ({
      ...prev,
      [axis]: Number.isFinite(value) ? value : 0
    }))
  }, [])

  const moveSelectedTo = useCallback(
    (targetOffset: OffsetVector) => {
      // Move cubes directly or rebuild IFC subsets so the element appears at the new offset
      const viewer = viewerRef.current
      if (!viewer || !selectedElement) return

      setOffsetInputs(targetOffset)

      if (selectedElement.modelID === CUSTOM_CUBE_MODEL_ID) {
        const key = `cube:${selectedElement.expressID}`
        const cube = cubeRegistryRef.current.get(selectedElement.expressID)
        if (cube) {
          cube.position.set(targetOffset.dx, targetOffset.dy, targetOffset.dz)
          cube.updateMatrix()
          cube.matrixAutoUpdate = false
          elementOffsetsRef.current.set(key, targetOffset)
        }
        return
      }

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

      const basePos = new Vector3()
      const baseQuat = baseSubset ? baseSubset.quaternion.clone() : new Vector3()
      const baseScale = baseSubset ? baseSubset.scale.clone() : new Vector3(1, 1, 1)
      if (baseSubset) {
        baseSubset.matrix.decompose(basePos, baseQuat as any, baseScale)
      }

      const isZeroOffset =
        targetOffset.dx === basePos.x && targetOffset.dy === basePos.y && targetOffset.dz === basePos.z

      if (isZeroOffset) {
        const restored = manager.createSubset({
          modelID,
          ids: [expressID],
          scene,
          removePrevious: false,
          customID: BASE_SUBSET_ID
        })
        if (restored && baseSubset) {
          restored.matrix.copy(baseSubset.matrix)
          restored.matrixAutoUpdate = false
        }
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

      if (baseSubset) {
        moved.quaternion.copy(baseQuat as any)
        moved.scale.copy(baseScale)
      }

      moved.position.set(targetOffset.dx, targetOffset.dy, targetOffset.dz)
      moved.updateMatrix()
      moved.matrixAutoUpdate = false

      movedSubsetsRef.current.set(key, moved as Mesh)
      elementOffsetsRef.current.set(key, targetOffset)
      registerPickable(viewer, moved as Mesh)
    },
    [
      ensureBaseSubset,
      getElementKey,
      registerPickable,
      removePickable,
      selectedElement,
      viewerRef
    ]
  )

  const applyOffsetToSelectedElement = useCallback(() => {
    moveSelectedTo(offsetInputs)
  }, [moveSelectedTo, offsetInputs])

  const handlePick = useCallback(async () => {
    const viewer = viewerRef.current
    if (!viewer) {
      return
    }

    try {
      const hit = viewer.context.castRayIfc()
      const hitObject: any = hit?.object
      if (hit && hitObject?.modelID === CUSTOM_CUBE_MODEL_ID && hit.face) {
        const expressAttr = hitObject.geometry.getAttribute('expressID')
        const hitExpressId =
          expressAttr && hit.faceIndex !== undefined
            ? expressAttr.getX(hit.face.a ?? 0) ?? cubeIdCounterRef.current
            : cubeIdCounterRef.current

        const key = `cube:${hitExpressId}`
        setSelectedElement({ modelID: CUSTOM_CUBE_MODEL_ID, expressID: hitExpressId, type: 'CUBE' })
        const cube = cubeRegistryRef.current.get(hitExpressId)
        const pos = cube?.position
        setOffsetInputs(pos ? { dx: pos.x, dy: pos.y, dz: pos.z } : zeroOffset)
        setPropertyFields([
          { key: 'type', label: 'Type', value: 'CUBE' },
          { key: 'x', label: 'X', value: pos ? pos.x.toFixed(3) : '0' },
          { key: 'y', label: 'Y', value: pos ? pos.y.toFixed(3) : '0' },
          { key: 'z', label: 'Z', value: pos ? pos.z.toFixed(3) : '0' }
        ])
        elementOffsetsRef.current.set(key, pos ? { dx: pos.x, dy: pos.y, dz: pos.z } : zeroOffset)
        setCubeHighlight(hitExpressId)
        return
      }

      setCubeHighlight(null)

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
  }, [fetchProperties, resetSelection, setCubeHighlight, viewerRef])

  const spawnCubeAt = useCallback(
    (target?: Point3D | null) => {
      const viewer = viewerRef.current
      if (!viewer) return null

      const scene = viewer.context.getScene()
      const geometry = new BoxGeometry(1, 1, 1)
      const material = new MeshStandardMaterial({
        color: CUBE_BASE_COLOR,
        metalness: 0.1,
        roughness: 0.8
      })
      const cube = new Mesh(geometry, material)

      if (target) {
        cube.position.set(target.x, target.y, target.z)
      }

      const cubeExpressId = cubeIdCounterRef.current++
      const positionAttr = cube.geometry.getAttribute('position')
      const vertexCount = positionAttr ? positionAttr.count : 0
      const ids = new Float32Array(vertexCount)
      ids.fill(cubeExpressId)
      cube.geometry.setAttribute('expressID', new Float32BufferAttribute(ids, 1))
      ;(cube as any).modelID = CUSTOM_CUBE_MODEL_ID

      cubeRegistryRef.current.set(cubeExpressId, cube)
      scene.add(cube)
      viewer.context.items.pickableIfcModels.push(cube as any)

      return target ?? null
    },
    [viewerRef]
  )

  const spawnCube = useCallback(
    (target?: Point3D | null, options?: { focus?: boolean }) => {
      // Convenience wrapper that also focuses the camera if requested
      const position = spawnCubeAt(target)
      if (options?.focus && position) {
        focusOnPoint(position)
      }
      return position
    },
    [focusOnPoint, spawnCubeAt]
  )

  const spawnUploadedModel = useCallback(
    async (file: File, target?: Point3D | null, options?: { focus?: boolean }) => {
      const viewer = viewerRef.current
      if (!viewer) return
      try {
        const resolved = target || { x: 0, y: 0, z: 0 }
        const model = (await viewer.IFC.loadIfc(file, false)) as Mesh | undefined
        if (model) {
          model.position.set(resolved.x, resolved.y, resolved.z)
          model.updateMatrix()
          if (options?.focus) {
            focusOnPoint(resolved)
          }
        }
      } catch (err) {
        console.error('Failed to load uploaded model', err)
      }
    },
    [focusOnPoint, viewerRef]
  )

  return {
    selectedElement,
    offsetInputs,
    propertyFields,
    propertyError,
    isFetchingProperties,
    handleOffsetInputChange,
    applyOffsetToSelectedElement,
    handleFieldChange,
    handlePick,
    moveSelectedTo,
    getSelectedWorldPosition,
    resetSelection,
    clearOffsetArtifacts,
    spawnCube,
    spawnUploadedModel
  }
}
