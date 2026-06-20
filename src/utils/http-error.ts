export interface HttpErrorContext {
  method: string;
  secretValues?: string[];
  url: string;
}

export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }

  static async fromResponse(response: Response, context: HttpErrorContext): Promise<HttpError> {
    const body = await response.text().catch(() => '');
    const masked = (context.secretValues || []).reduce(
      (value, secret) => value.split(secret).join('***'),
      body
    );
    return new HttpError(
      `${context.method} ${context.url} failed with ${response.status} ${response.statusText}: ${masked}`,
      response.status
    );
  }
}
