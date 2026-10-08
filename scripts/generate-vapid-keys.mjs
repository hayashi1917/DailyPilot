// Web Push 用の VAPID 鍵ペアを生成します。
//   node scripts/generate-vapid-keys.mjs
// 出力された値を、Pages と通知用 Worker の両方にシークレットとして設定してください（README 参照）。
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const rawPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
const { d } = await crypto.subtle.exportKey("jwk", privateKey);
const base64Url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log(`VAPID_PUBLIC_KEY=${base64Url(rawPublicKey)}`);
console.log(`VAPID_PRIVATE_KEY=${d}`);
console.log("VAPID_SUBJECT=mailto:<あなたのメールアドレス>");
