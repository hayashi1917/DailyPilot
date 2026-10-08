// API・MCP・OAuth で共通利用する乱数とハッシュの関数です。

// 推測されにくいランダムな16進文字列を生成します（セッションID・トークンなど）。
export function randomId(bytes = 24) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// トークンやシークレットは平文で保存せず、このハッシュだけを保存します。
export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// PKCE（S256）の code_challenge と同じ形式（SHA-256 → base64url）に変換します。
export async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
