import { useCallback, useEffect, useRef, useState } from 'react'
import { Color } from 'three'
import { IfcViewerAPI } from 'web-ifc-viewer'

type IfcViewerProps = {
  file?: File | null
  defaultModelUrl?: string
}

type Loader = (viewer: IfcViewerAPI) => Promise<any>

const wasmRootPath = '/ifc/'

const IfcViewer = ({ file, defaultModelUrl = '/test.ifc' }: IfcViewerProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<IfcViewerAPI | null>(null)
  const lastModelIdRef = useRef<number | null>(null)
  const loadTokenRef = useRef(0)
  const [status, setStatus] = useState<string | null>('Loading sample model...')
  const [error, setError] = useState<string | null>(null)

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

    viewerRef.current = viewer
    return viewer
  }, [])

  const loadModel = useCallback(
    async (loader: Loader, message: string) => {
      const viewer = ensureViewer()
      if (!viewer) return

      const token = ++loadTokenRef.current

      setStatus(message)
      setError(null)

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
    [ensureViewer]
  )

  useEffect(() => {
    ensureViewer()

    return () => {
      if (viewerRef.current) {
        viewerRef.current.dispose()
        viewerRef.current = null
      }
      lastModelIdRef.current = null
    }
  }, [ensureViewer])

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
    <div className="viewer-wrapper">
      <div ref={containerRef} className="viewer-container" />
      {status && <div className="viewer-overlay">{status}</div>}
      {error && <div className="viewer-overlay viewer-overlay--error">{error}</div>}
    </div>
  )
}

export default IfcViewer
