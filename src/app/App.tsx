import { BrowserRouter, Route, Routes } from 'react-router'
import { Toaster } from 'sonner'
import { GameProvider } from './net/GameContext'
import { HostRoute } from './screens/host/HostRoute'
import { PlayerRoute } from './screens/player/PlayerRoute'

export default function App() {
  return (
    <GameProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/host" element={<HostRoute />} />
          {/* A company's own screen, read only, for the host (opened from the per-company table). */}
          <Route path="/watch" element={<PlayerRoute />} />
          <Route path="*" element={<PlayerRoute />} />
        </Routes>
      </BrowserRouter>
      <Toaster theme="dark" position="top-center" richColors />
    </GameProvider>
  )
}
