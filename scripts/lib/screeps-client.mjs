export class ScreepsApiError extends Error {
  constructor(message, { endpoint, status }) {
    super(message);
    this.name = "ScreepsApiError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

export class ScreepsClient {
  constructor({
    baseUrl = "https://screeps.com/api",
    token,
    fetchImplementation = globalThis.fetch,
  }) {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("SCREEPS_TOKEN is required.");
    }

    if (typeof fetchImplementation !== "function") {
      throw new Error("A fetch implementation is required.");
    }

    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.token = token;
    this.fetchImplementation = fetchImplementation;
  }

  async get(endpoint, query = {}) {
    return this.request(endpoint, { query });
  }

  async post(endpoint, body, { allowApiError = false } = {}) {
    return this.request(endpoint, { allowApiError, body, method: "POST" });
  }

  async request(endpoint, { allowApiError = false, body, method = "GET", query = {} } = {}) {
    const normalizedEndpoint = endpoint.replace(/^\/+/, "");
    const url = new URL(normalizedEndpoint, this.baseUrl);

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await this.fetchImplementation(url, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Token": this.token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    let payload;

    try {
      payload = await response.json();
    } catch {
      throw new ScreepsApiError("Screeps returned a non-JSON response.", {
        endpoint: normalizedEndpoint,
        status: response.status,
      });
    }

    if (!response.ok) {
      throw new ScreepsApiError("Screeps returned an HTTP error.", {
        endpoint: normalizedEndpoint,
        status: response.status,
      });
    }

    if (!allowApiError && payload?.ok !== 1) {
      throw new ScreepsApiError("Screeps rejected the API request.", {
        endpoint: normalizedEndpoint,
        status: response.status,
      });
    }

    return payload;
  }
}
