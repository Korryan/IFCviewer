import type { OffsetVector, PropertyField, SelectedElement } from '../ifcViewerTypes'

type PropertiesPanelProps = {
  selectedElement: SelectedElement | null
  isFetchingProperties: boolean
  propertyError: string | null
  offsetInputs: OffsetVector
  onOffsetChange: (axis: keyof OffsetVector, value: number) => void
  onApplyOffset: () => void
  propertyFields: PropertyField[]
  onFieldChange: (key: string, value: string) => void
}

// Right-hand side inspector for coordinates and editable IFC properties
export const PropertiesPanel = ({
  selectedElement,
  isFetchingProperties,
  propertyError,
  offsetInputs,
  onOffsetChange,
  onApplyOffset,
  propertyFields,
  onFieldChange
}: PropertiesPanelProps) => {
  return (
    <aside className="properties-panel">
      <header className="properties-panel__header">
        <h2>Element properties</h2>
        {selectedElement && (
          <p className="properties-panel__meta">
            #{selectedElement.expressID}
            {selectedElement.type ? ` - ${selectedElement.type}` : ''}
          </p>
        )}
      </header>
      <div className="properties-panel__content">
        {isFetchingProperties && <p className="properties-panel__status">Loading properties...</p>}
        {propertyError && (
          <p className="properties-panel__status properties-panel__status--error">{propertyError}</p>
        )}
        {!isFetchingProperties && !propertyError && !selectedElement && (
          <p className="properties-panel__status">
            Click any element in the scene to inspect and edit its metadata.
          </p>
        )}
        {!isFetchingProperties && !propertyError && selectedElement && (
          <>
            <div className="offset-panel">
              <div className="offset-panel__header">
                <h3>Coordinates</h3>
                <span className="offset-panel__units">world</span>
              </div>
              <div className="offset-panel__grid">
                {(['dx', 'dy', 'dz'] as Array<keyof OffsetVector>).map((axis) => (
                  <label key={axis} className="offset-panel__field">
                    <span>{axis.toUpperCase()}</span>
                    <input
                      type="number"
                      step="0.01"
                      value={offsetInputs[axis]}
                      onChange={(event) =>
                        onOffsetChange(
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
              <button type="button" className="offset-panel__apply" onClick={onApplyOffset}>
                Apply coordinates
              </button>
              <p className="properties-panel__hint">
                Coordinates update while dragging; the IFC file stays untouched.
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
                          onChange={(event) => onFieldChange(field.key, event.target.value)}
                          rows={Math.min(6, Math.max(2, Math.ceil(field.value.length / 60)))}
                        />
                      ) : (
                        <input
                          type="text"
                          value={field.value}
                          onChange={(event) => onFieldChange(field.key, event.target.value)}
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
  )
}
