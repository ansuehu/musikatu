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
      /** Whether the window's File/Edit/View menu bar is hidden; null where there is none (macOS). */
      menuBarHidden(): Promise<boolean | null>
      setMenuBarHidden(hidden: boolean): Promise<void>
      onMenuBar(callback: (hidden: boolean) => void): () => void
      stems: import('./stems/types').StemsApi
      notes: {
        /** Mono 22.05 kHz audio → Basic Pitch frame and onset activations (frames × 88, row-major). */
        transcribe(mono: Float32Array): Promise<{ note: Float32Array; onset: Float32Array; frames: number; seconds: number }>
        onProgress(callback: (fraction: number) => void): () => void
      }
      beats: {
        /** Mono 22.05 kHz audio → beat and downbeat times in seconds. */
        track(mono: Float32Array): Promise<{ beats: number[]; downbeats: number[]; seconds: number; sampleRate: number }>
        onProgress(callback: (fraction: number) => void): () => void
      }
    }
  }
}
