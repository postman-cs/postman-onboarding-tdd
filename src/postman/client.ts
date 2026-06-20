import { HttpError } from '../utils/http-error.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';

type JsonRecord = Record<string, unknown>;
type FetchResult = JsonRecord | null;

export interface PostmanClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  secretMasker?: SecretMasker;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function extractWorkspacesPage(data: FetchResult): { nextCursor?: string; workspaces: unknown[] } {
  const workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
  const meta = asRecord(data?.meta);
  const pagination = asRecord(data?.pagination);
  const nextCursor = String(
    data?.nextCursor ??
      data?.next_cursor ??
      meta?.nextCursor ??
      meta?.next_cursor ??
      pagination?.nextCursor ??
      pagination?.next_cursor ??
      ''
  ).trim() || undefined;
  return { nextCursor, workspaces };
}

export class PostmanClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly secretMasker: SecretMasker;

  constructor(options: PostmanClientOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.secretMasker = options.secretMasker ?? createSecretMasker([options.apiKey]);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async request(path: string, init: RequestInit = {}, ignore404 = false): Promise<FetchResult> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
        ...(init.headers || {})
      }
    });

    if (ignore404 && response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw await HttpError.fromResponse(response, {
        method: init.method || 'GET',
        secretValues: [this.apiKey],
        url
      });
    }

    try {
      return await response.json() as JsonRecord;
    } catch {
      return null;
    }
  }

  async createWorkspace(name: string, about: string, targetTeamId?: number): Promise<{ id: string }> {
    const payload = {
      workspace: {
        about,
        name,
        type: 'team',
        ...(targetTeamId != null && !Number.isNaN(targetTeamId) ? { teamId: targetTeamId } : {})
      }
    };
    const created = await this.request('/workspaces', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const workspace = asRecord(created?.workspace);
    const id = String(workspace?.id || '').trim();
    if (!id) {
      throw new Error('Workspace create did not return an id');
    }
    return { id };
  }

  async listWorkspaces(): Promise<Array<{ id: string; name: string; type: string }>> {
    const all: unknown[] = [];
    const seenCursors = new Set<string>();
    let nextCursor: string | undefined;

    do {
      const query = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : '';
      const data = await this.request(`/workspaces${query}`);
      const page = extractWorkspacesPage(data);
      all.push(...page.workspaces);
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
        nextCursor = undefined;
      } else {
        seenCursors.add(page.nextCursor);
        nextCursor = page.nextCursor;
      }
    } while (nextCursor);

    return all
      .map((entry) => asRecord(entry))
      .filter((entry): entry is JsonRecord => Boolean(entry?.id && entry?.name))
      .map((entry) => ({
        id: String(entry.id),
        name: String(entry.name),
        type: String(entry.type || 'team')
      }));
  }

  async findWorkspacesByName(name: string): Promise<Array<{ id: string; name: string }>> {
    const workspaces = await this.listWorkspaces();
    return workspaces
      .filter((workspace) => workspace.name === name)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((workspace) => ({ id: workspace.id, name: workspace.name }));
  }

  async uploadSpec(
    workspaceId: string,
    name: string,
    specContent: string,
    openapiVersion: '3.0' | '3.1'
  ): Promise<string> {
    const response = await this.request(`/specs?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        type: openapiVersion === '3.1' ? 'OPENAPI:3.1' : 'OPENAPI:3.0',
        files: [{ path: 'index.yaml', content: specContent }]
      })
    });
    const id = String(response?.id || '').trim();
    if (!id) {
      throw new Error('Spec upload did not return an ID');
    }
    return id;
  }

  async updateSpec(specId: string, specContent: string): Promise<void> {
    await this.request(`/specs/${encodeURIComponent(specId)}/files/index.yaml`, {
      method: 'PATCH',
      body: JSON.stringify({ content: specContent })
    });
  }

  async getSpecContent(specId: string): Promise<string | undefined> {
    const result = await this.request(`/specs/${encodeURIComponent(specId)}/files/index.yaml`, {}, true);
    return typeof result?.content === 'string' ? result.content : undefined;
  }

  async deleteSpec(specId: string): Promise<void> {
    await this.request(`/specs/${encodeURIComponent(specId)}`, { method: 'DELETE' }, true);
  }

  async generateCollection(
    specId: string,
    projectName: string,
    prefix: string,
    options: {
      folderStrategy?: string;
      nestedFolderHierarchy?: boolean;
      requestNameSource?: string;
    } = {}
  ): Promise<string> {
    const name = [prefix.trim(), projectName.trim()].filter(Boolean).join(' ');
    const response = await this.request(`/specs/${encodeURIComponent(specId)}/generations/collection`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        options: {
          requestNameSource: options.requestNameSource || 'Fallback',
          folderStrategy: options.folderStrategy || 'Paths',
          ...(options.folderStrategy === 'Tags'
            ? { nestedFolderHierarchy: Boolean(options.nestedFolderHierarchy) }
            : {})
        }
      })
    });

    const direct = extractCollectionId(response);
    if (direct) {
      return direct;
    }

    const taskUrl = String(
      response?.url ??
        response?.task_url ??
        response?.taskUrl ??
        asRecord(response?.links)?.task ??
        ''
    );
    if (!taskUrl) {
      throw new Error(`Collection generation did not return a collection ID or task URL for ${name}`);
    }

    for (let attempt = 0; attempt < 45; attempt += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
      const task = await this.request(taskUrl);
      const status = String(task?.status || asRecord(task?.task)?.status || '').toLowerCase();
      if (status === 'completed') {
        const id = extractCollectionId(task);
        if (!id) {
          throw new Error(`Collection generation task completed but no collection ID was returned for ${name}`);
        }
        return id;
      }
      if (status === 'failed') {
        throw new Error(`Collection generation task failed for ${name}`);
      }
    }

    throw new Error(`Collection generation timed out for ${name}`);
  }

  async getCollection(uid: string): Promise<unknown | undefined> {
    const result = await this.request(`/collections/${encodeURIComponent(uid)}`, {}, true);
    return result?.collection;
  }

  async updateCollection(uid: string, collection: unknown): Promise<void> {
    await this.request(`/collections/${encodeURIComponent(uid)}`, {
      method: 'PUT',
      body: JSON.stringify({ collection })
    });
  }

  async deleteCollection(uid: string): Promise<void> {
    await this.request(`/collections/${encodeURIComponent(uid)}`, { method: 'DELETE' }, true);
  }

  mask(value: string): string {
    return this.secretMasker(value);
  }
}

function extractCollectionId(data: unknown): string | undefined {
  const root = asRecord(data);
  const details = asRecord(root?.details);
  const resources = Array.isArray(details?.resources) ? details.resources : [];
  const first = asRecord(resources[0]);
  const collection = asRecord(root?.collection);
  const resource = asRecord(root?.resource);
  return String(
    first?.id ??
      collection?.id ??
      collection?.uid ??
      resource?.id ??
      resource?.uid ??
      ''
  ).trim() || undefined;
}
