//  src/lib/api.js

export async function api(path, init) {
  const res = await fetch(`/api${path}`, { credentials: "include", ...init });
  if (!res.ok)
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json(); // { ok, data }
}
