import { useState, type ChangeEvent } from 'react'
import IfcViewer from './IfcViewer'
import './App.css'

function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSelectedFile(event.target.files?.[0] ?? null)
  }

  return (
    <div className="app">
      <header className="app__toolbar">
        <div className="app__intro">
          <h1>IFC Viewer</h1>
          <p>Select an .ifc file to inspect it directly in the browser.</p>
        </div>
        <div className="file-input">
          <label htmlFor="ifc-file">Choose IFC file</label>
          <input id="ifc-file" type="file" accept=".ifc" onChange={handleFileChange} />
        </div>
        <p className="file-input__info">
          {selectedFile ? `Loaded file: ${selectedFile.name}` : 'No file selected yet.'}
        </p>
      </header>

      <section className="viewer-shell">
        <IfcViewer file={selectedFile ?? undefined} />
      </section>
    </div>
  )
}

export default App
