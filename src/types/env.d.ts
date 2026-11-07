// Ambient type declarations for Node.js built-ins and CommonJS globals
// Enables zero-dependency `tsc --noEmit` with `checkJs: true` across `src/`.

declare var require: {
  (id: string): any;
  main?: any;
  cache: Record<string, any>;
  resolve(id: string): string;
};
declare var module: {
  exports: any;
  id?: string;
  filename?: string;
};
declare var exports: any;
declare var __dirname: string;
declare var __filename: string;
declare var process: {
  env: Record<string, string | undefined>;
  uptime(): number;
  exit(code?: number): never;
  stderr: { write(str: string): boolean };
  stdout: { write(str: string): boolean };
  hrtime: { bigint(): bigint };
  memoryUsage(): { heapUsed: number; rss: number; heapTotal: number; external: number };
};
interface Buffer extends Uint8Array {
  toString(encoding?: string, start?: number, end?: number): string;
}
declare var Buffer: {
  new (size: any, encoding?: any): Buffer;
  alloc(size: number, fill?: any): Buffer;
  from(data: any, encodingOrOffset?: any, length?: number): Buffer;
  byteLength(str: any, encoding?: string): number;
  concat(list: any[], totalLength?: number): Buffer;
  isBuffer(obj: any): obj is Buffer;
};

declare function setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearInterval(intervalId: any): void;
declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearTimeout(timeoutId: any): void;
declare function fetch(input: any, init?: any): Promise<any>;

declare namespace AbortSignal {
  function timeout(ms: number): any;
}

declare module 'node:fs' {
  const fs: any;
  export = fs;
}
declare module 'node:path' {
  const path: any;
  export = path;
}
declare module 'node:http' {
  const http: any;
  export = http;
}
declare module 'node:url' {
  export class URL {
    href: string;
    protocol: string;
    hostname: string;
    port: string;
    pathname: string;
    search: string;
    searchParams: URLSearchParams;
    constructor(input: string, base?: string | URL);
  }
  export class URLSearchParams {
    constructor(init?: any);
    get(name: string): string | null;
    has(name: string): boolean;
  }
}
declare module 'node:crypto' {
  const crypto: any;
  export = crypto;
}
declare module 'node:events' {
  class EventEmitter {
    static EventEmitter: typeof EventEmitter;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    removeAllListeners(event?: string): this;
  }
  export = EventEmitter;
}
declare module 'node:perf_hooks' {
  export const performance: { now(): number };
}
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: any);
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: any[]): any;
      get(...params: any[]): any;
      all(...params: any[]): any[];
    };
    close(): void;
  }
}
declare module 'ws' {
  export class WebSocketServer {
    clients: Set<any>;
    constructor(options?: any);
    on(event: string, listener: (...args: any[]) => void): this;
    close(cb?: () => void): void;
  }
  export class WebSocket {
    static readonly OPEN: number;
    readyState: number;
    send(data: any): void;
    terminate(): void;
    close(): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
}
