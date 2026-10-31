/** Native EventSource retries dropped connections, but closes permanently on HTTP errors. */
export function connectEventStream(url: string, configure: (source: EventSource) => void): () => void {
  let source: EventSource
  let retry: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const open = () => {
    const current = new EventSource(url)
    source = current
    configure(current)
    const onError = current.onerror
    current.onerror = (event) => {
      onError?.call(current, event)
      if (!disposed && current.readyState === EventSource.CLOSED && retry === undefined) {
        retry = setTimeout(() => {
          retry = undefined
          current.close()
          if (!disposed) open()
        }, 2000)
      }
    }
  }
  open()
  return () => {
    disposed = true
    if (retry !== undefined) clearTimeout(retry)
    source.close()
  }
}
