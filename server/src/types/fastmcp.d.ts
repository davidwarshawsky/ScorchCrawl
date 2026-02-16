/**
 * Type augmentation for the FastMCP re-export.
 *
 * The npm "firecrawl-fastmcp" package provides its own types, but our tool
 * handler callbacks destructure `{ log }: { log: Logger }` where Logger
 * includes a `.log()` method.  The upstream Context type only has
 * debug/error/info/warn.  This declaration module merges a compatible
 * Logger interface so our code compiles cleanly.
 */
declare module 'firecrawl-fastmcp' {
  export interface Logger {
    debug(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    log(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
  }

  export interface ServerOptions<T = Record<string, unknown>> {
    name: string;
    version: string;
    authenticate?: (request: { headers: import('http').IncomingHttpHeaders }) => Promise<T>;
    health?: {
      enabled: boolean;
      message: string;
      path: string;
      status: number;
    };
    roots?: { enabled: boolean };
    logger?: Logger;
  }

  export class FastMCP<T = Record<string, unknown>> {
    constructor(options: ServerOptions<T>);
    addTool(tool: any): void;
    start(options?: any): Promise<any>;
    stop(): Promise<void>;
  }
}
