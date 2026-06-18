export interface LocatePcResult {
  ok: boolean
  lat?: number
  lng?: number
  accuracy?: number
  via?: 'windows' | 'macos' | 'ipwho.is' | 'ipapi.co' | 'freeipapi.com'
  code?: 'DENIED' | 'TIMEOUT' | 'UNKNOWN' | 'ERROR' | 'SPAWN_FAILED' | 'NODATA' | 'NO_HELPER' | 'ALL_FAILED'
  message?: string
}

export type RenderMode = 'hardware' | 'software'

export type LocateSource = 'auto' | 'native' | 'ip'

export interface RenderModeInfo {
  mode: RenderMode
  saved: RenderMode | null
  isWin10: boolean
}

declare global {
  interface Window {
    electronAPI?: {
      locatePc(): Promise<LocatePcResult>
      getLocateSource(): Promise<{ source: LocateSource }>
      setLocateSource(source: LocateSource): Promise<{ ok: boolean }>
      getRenderMode(): Promise<RenderModeInfo>
      setRenderMode(mode: RenderMode): Promise<{ ok: boolean }>
      relaunchApp(): Promise<void>
    }
  }
}

export {}
