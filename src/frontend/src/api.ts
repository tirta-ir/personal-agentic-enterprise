export class ApiFailure extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed: { error?: string } = JSON.parse(text);
      message = parsed.error ?? text;
    } catch {
      /* Plain HTTP errors remain visible. */
    }
    throw new ApiFailure(
      message || `Request failed (${response.status})`,
      response.status,
    );
  }
  return response.json() as Promise<T>;
}
export const post = <T>(path: string, data?: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(data ?? {}) });
export const put = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(data) });

// getRandomValues also works over HTTP on the private network interface.
export const requestId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
