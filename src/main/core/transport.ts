export type TransportMethod = 'GET' | 'POST'

export interface TransportRequest {
  url: string
  method?: TransportMethod
  headers?: Record<string, string>
  body?: string | Uint8Array
  responseType?: 'text' | 'binary'
  credentials?: 'include' | 'omit'
  timeoutMs?: number
  /** Safe diagnostic label. Never contains cookies, TBS values, or request bodies. */
  operation?: string
}

export interface TransportResponse {
  status: number
  body: string
  bytes?: Uint8Array
  url?: string
  headers?: Record<string, string | undefined>
}

/** Implemented by Electron's net/session layer in the application shell. */
export interface Transport {
  request(request: TransportRequest): Promise<TransportResponse>
}
