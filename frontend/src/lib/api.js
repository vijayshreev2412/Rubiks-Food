const fallbackBaseUrl =
  typeof window !== "undefined"
    ? window.location.origin.replace(/(?::\d+)?$/, ":4000")
    : "http://localhost:4000";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || fallbackBaseUrl;

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const message = errorBody.error || response.statusText;
    throw new Error(message);
  }

  return response.json();
}

export function getTasks() {
  return request("/api/tasks");
}

export function createTask(payload) {
  return request("/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateTaskStatus(id, status) {
  return request(`/api/tasks/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export { API_BASE_URL };
