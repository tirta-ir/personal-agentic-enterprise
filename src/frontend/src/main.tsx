import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { WorkspaceGate } from './WorkspaceGate'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkspaceGate />
  </StrictMode>,
)
