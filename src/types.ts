/** Detail-view viewport: first visible sample and samples per CSS pixel. */
export interface View {
  start: number
  spp: number
}

/** A selected region in samples; doubles as the loop region. */
export interface Selection {
  start: number
  end: number
}

export interface AudioFilePayload {
  name: string
  path: string
  data: Uint8Array
}

declare global {
  interface Window {
    /** Present when running inside Electron (see electron/preload.cjs). */
    api?: {
      platform: string
      openFile(): Promise<AudioFilePayload | null>
      initialFile(): Promise<AudioFilePayload | null>
      pathForFile(file: File): string | null
      loadProject(key: string): Promise<string | null>
      saveProject(key: string, json: string): Promise<boolean>
      /** Registers OS-wide hotkeys; resolves with the accelerators that couldn't be registered. */
      setGlobalShortcuts(list: { accelerator: string; action: string }[]): Promise<string[]>
      onGlobalShortcut(callback: (action: string) => void): () => void
      onMenu(callback: (command: 'open' | 'shortcuts') => void): () => void
      onFileOpened(callback: (file: AudioFilePayload) => void): () => void
      stems: import('./stems/types').StemsApi
    }
  }
}
