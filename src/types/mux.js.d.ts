declare module 'mux.js' {
  const mux: {
    mp4: {
      Transmuxer: new (options?: Record<string, unknown>) => {
        on(event: string, cb: (segment: any) => void): void
        push(data: Uint8Array): void
        flush(): void
        dispose?(): void
      }
    }
  }
  export default mux
}
