/**
 * Standalone client for the Sandbox API.
 * Ported from the sandbox service's own client code.
 */

interface TraceHeaders {
  [key: string]: string;
}

interface SandboxClientConfig {
  baseUrl: string;
  /** Request timeout in ms (default: 120000 for browser operations) */
  timeout?: number;
  /**
   * Headless service base for direct pod routing (StatefulSet).
   * Format: "sandbox-headless.namespace.svc.cluster.local:3001"
   */
  headlessService?: string;
  /**
   * URL template for direct pod routing with custom hostname patterns.
   * Placeholder: {pod} = full pod name from composite ID (e.g., "sandbox-0")
   * Takes precedence over headlessService if both are set.
   */
  podUrlTemplate?: string;
  /**
   * Optional callback to get trace headers for distributed tracing.
   */
  getTraceHeaders?: () => TraceHeaders | undefined;
}

interface ExecutionError {
  name: string;
  value: string;
  traceback?: string;
}

export interface Execution {
  text?: string;
  results: Array<{ text?: string; isMainResult?: boolean }>;
  logs: { stdout: string[]; stderr: string[] };
  error?: ExecutionError;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class SandboxClient {
  readonly baseUrl: string;
  private timeout: number;
  private headlessService?: string;
  private podUrlTemplate?: string;
  private getTraceHeaders?: () => TraceHeaders | undefined;

  constructor(config: SandboxClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.timeout = config.timeout ?? 120000;
    this.headlessService = config.headlessService;
    this.podUrlTemplate = config.podUrlTemplate;
    this.getTraceHeaders = config.getTraceHeaders;
  }

  /**
   * Parse composite workspace ID (pod:uuid) and return the pod-specific URL.
   * Returns baseUrl if no routing config or ID is legacy format.
   */
  getUrlForWorkspace(compositeId: string): string {
    const colonIndex = compositeId.indexOf(":");
    if (colonIndex === -1) {
      return this.baseUrl;
    }
    const pod = compositeId.slice(0, colonIndex);

    if (this.podUrlTemplate) {
      return this.podUrlTemplate.replace("{pod}", pod);
    }

    if (this.headlessService) {
      return `http://${pod}.${this.headlessService}`;
    }

    return this.baseUrl;
  }

  /** @internal */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    compositeWorkspaceId?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {};
      if (body) headers["Content-Type"] = "application/json";

      const url = compositeWorkspaceId
        ? this.getUrlForWorkspace(compositeWorkspaceId)
        : this.baseUrl;

      if (compositeWorkspaceId) {
        headers["X-Workspace-ID"] = compositeWorkspaceId;
      }

      const traceHeaders = this.getTraceHeaders?.();
      if (traceHeaders) {
        Object.assign(headers, traceHeaders);
      }

      const res = await fetch(`${url}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(
          (error as { error?: string }).error || `HTTP ${res.status}`,
        );
      }

      if (res.status === 204) {
        return undefined as T;
      }

      return res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async health(): Promise<{ status: string; workspaces: number }> {
    return this.request("GET", "/health");
  }

  /**
   * Get the current trace headers for manual fetch calls.
   * @internal
   */
  getTracingHeaders(): TraceHeaders {
    const headers: TraceHeaders = {};
    const traceHeaders = this.getTraceHeaders?.();
    if (traceHeaders) {
      Object.assign(headers, traceHeaders);
    }
    return headers;
  }

  async createWorkspace(opts?: {
    id?: string;
    ttlSeconds?: number;
  }): Promise<Workspace> {
    const id = opts?.id ?? crypto.randomUUID();
    const { id: compositeId } = await this.request<{ id: string }>(
      "POST",
      "/workspaces",
      { ...opts, id },
      id,
    );
    return new Workspace(this, compositeId);
  }

  async listWorkspaces(): Promise<string[]> {
    const { workspaces } = await this.request<{ workspaces: string[] }>(
      "GET",
      "/workspaces",
    );
    return workspaces;
  }

  async getWorkspace(id: string): Promise<Workspace> {
    await this.request("GET", `/workspaces/${id}`, undefined, id);
    return new Workspace(this, id);
  }
}

export class CodeContext {
  constructor(
    private client: SandboxClient,
    private workspaceId: string,
    readonly id: string,
  ) {}

  async runCode(code: string, opts?: { timeout?: number }): Promise<Execution> {
    return this.client.request(
      "POST",
      `/workspaces/${this.workspaceId}/contexts/${this.id}/execute`,
      { code, ...opts },
      this.workspaceId,
    );
  }

  async enableBrowser(cdpPath: string): Promise<void> {
    await this.client.request(
      "POST",
      `/workspaces/${this.workspaceId}/contexts/${this.id}/enable-browser`,
      { cdpPath },
      this.workspaceId,
    );
  }

  async runBash(
    command: string,
    opts?: { timeout?: number },
  ): Promise<ExecResult> {
    return this.client.request(
      "POST",
      `/workspaces/${this.workspaceId}/contexts/${this.id}/bash`,
      { command, ...opts },
      this.workspaceId,
    );
  }

  async delete(): Promise<void> {
    await this.client.request(
      "DELETE",
      `/workspaces/${this.workspaceId}/contexts/${this.id}`,
      undefined,
      this.workspaceId,
    );
  }
}

export class Workspace {
  private contexts = new Map<string, CodeContext>();

  constructor(
    private client: SandboxClient,
    readonly id: string,
  ) {}

  async createContext(): Promise<CodeContext> {
    const { id } = await this.client.request<{ id: string }>(
      "POST",
      `/workspaces/${this.id}/contexts`,
      undefined,
      this.id,
    );
    const ctx = new CodeContext(this.client, this.id, id);
    this.contexts.set(id, ctx);
    return ctx;
  }

  getContext(contextId: string): CodeContext | undefined {
    return this.contexts.get(contextId);
  }

  listContexts(): CodeContext[] {
    return Array.from(this.contexts.values());
  }

  async destroy(): Promise<void> {
    await this.client.request(
      "DELETE",
      `/workspaces/${this.id}`,
      undefined,
      this.id,
    );
    this.contexts.clear();
  }

  async runBash(
    command: string,
    opts?: { cwd?: string; timeout?: number },
  ): Promise<ExecResult> {
    return this.client.request(
      "POST",
      `/workspaces/${this.id}/bash`,
      { command, ...opts },
      this.id,
    );
  }

  readonly fs = {
    read: async (filePath: string): Promise<string> => {
      const url = this.client.getUrlForWorkspace(this.id);
      const res = await fetch(
        `${url}/workspaces/${this.id}/files/${filePath}`,
        {
          headers: {
            "X-Workspace-ID": this.id,
            ...this.client.getTracingHeaders(),
          },
        },
      );
      if (!res.ok) throw new Error(`File not found: ${filePath}`);
      return res.text();
    },

    write: async (filePath: string, content: string): Promise<void> => {
      await this.client.request(
        "PUT",
        `/workspaces/${this.id}/files/${filePath}`,
        { content },
        this.id,
      );
    },

    exists: async (filePath: string): Promise<boolean> => {
      const url = this.client.getUrlForWorkspace(this.id);
      const res = await fetch(
        `${url}/workspaces/${this.id}/files/${filePath}`,
        {
          method: "HEAD",
          headers: {
            "X-Workspace-ID": this.id,
            ...this.client.getTracingHeaders(),
          },
        },
      );
      return res.ok;
    },

    mkdir: async (dirPath: string): Promise<void> => {
      await this.client.request(
        "POST",
        `/workspaces/${this.id}/mkdir/${dirPath}`,
        undefined,
        this.id,
      );
    },

    remove: async (filePath: string): Promise<void> => {
      await this.client.request(
        "DELETE",
        `/workspaces/${this.id}/files/${filePath}`,
        undefined,
        this.id,
      );
    },

    list: async (dirPath: string = ""): Promise<string[]> => {
      const { files } = await this.client.request<{ files: string[] }>(
        "GET",
        `/workspaces/${this.id}/ls/${dirPath}`,
        undefined,
        this.id,
      );
      return files;
    },
  };
}

export function createSandboxClient(
  config: SandboxClientConfig | string = "http://localhost:3001",
): SandboxClient {
  if (typeof config === "string") {
    return new SandboxClient({ baseUrl: config });
  }
  return new SandboxClient(config);
}
