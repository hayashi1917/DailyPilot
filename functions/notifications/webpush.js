// ===== Web Push 送信 =====
// 外部ライブラリを使わず、Workers の Web Crypto だけで実装しています。
//   - ペイロード暗号化: RFC 8291（Message Encryption for Web Push, aes128gcm）
//   - 送信元の認証:     RFC 8292（VAPID, ES256 の JWT）
// プッシュサービス（Chrome は FCM、iPhone は Apple など）へ暗号化したメッセージを POST すると、端末に届きます。

const encoder = new TextEncoder();

export function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function concat(...parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// HKDF（抽出 + 展開）。Web Crypto の deriveBits は両方をまとめて行います。
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// RFC 8291: 端末の公開鍵（p256dh）と auth シークレットを使い、端末だけが読めるようにペイロードを暗号化します。
export async function encryptPayload(payload, p256dh, auth) {
  const userAgentPublicKey = base64UrlDecode(p256dh);
  const authSecret = base64UrlDecode(auth);

  // 送信ごとに使い捨ての鍵ペアを作り、端末の公開鍵との ECDH で共有鍵を得ます。
  const localKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", localKeys.publicKey));
  const userAgentKey = await crypto.subtle.importKey("raw", userAgentPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: userAgentKey }, localKeys.privateKey, 256));

  const keyInfo = concat(encoder.encode("WebPush: info\0"), userAgentPublicKey, localPublicKey);
  const inputKeyMaterial = await hkdf(authSecret, sharedSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(salt, inputKeyMaterial, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, inputKeyMaterial, encoder.encode("Content-Encoding: nonce\0"), 12);

  // 1レコードだけ送るので、末尾に区切り（0x02）を付けて暗号化します。
  const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(encoder.encode(payload), new Uint8Array([2]))));

  // ヘッダー: salt(16) | レコードサイズ(4) | 鍵IDの長さ(1) | 送信側の公開鍵(65)
  const header = new Uint8Array(16 + 4 + 1 + localPublicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = localPublicKey.length;
  header.set(localPublicKey, 21);
  return concat(header, ciphertext);
}

// RFC 8292: VAPID の秘密鍵で署名した JWT を作り、どのサーバーからの通知かをプッシュサービスに証明します。
async function vapidAuthorization(endpoint, vapid) {
  const publicKey = base64UrlDecode(vapid.publicKey);
  const signingKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: base64UrlEncode(publicKey.slice(1, 33)), y: base64UrlEncode(publicKey.slice(33, 65)), d: vapid.privateKey, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: vapid.subject,
  })));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, encoder.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${base64UrlEncode(signature)}, k=${vapid.publicKey}`;
}

// 1台の端末へ送信します。gone=true の場合は購読が無効になっているので削除してください。
export async function sendWebPush(subscription, message, vapid, { ttl = 60 * 60, urgency = "normal" } = {}) {
  const body = await encryptPayload(JSON.stringify(message), subscription.p256dh, subscription.auth);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuthorization(subscription.endpoint, vapid),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(ttl),
      urgency,
    },
    body,
  });
  return {
    ok: response.ok,
    status: response.status,
    gone: response.status === 404 || response.status === 410,
    error: response.ok ? null : (await response.text()).slice(0, 300),
  };
}
