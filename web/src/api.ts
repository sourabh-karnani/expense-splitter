export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Every request goes to /api on the same origin (Vite proxies it to the API),
// so the httpOnly session cookie is sent automatically. No tokens in JavaScript.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}

export type User = { id: string; email: string; name: string };
export type Note = { id: string; title: string; body: string; createdAt: string; updatedAt: string };
export type Page<T> = { items: T[]; nextCursor: string | null };
