// Expected errors (404, 401, 409...). The error handler turns these into JSON responses.
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
