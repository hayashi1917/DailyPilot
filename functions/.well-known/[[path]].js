import { authorizationServerMetadata, corsPreflight, protectedResourceMetadata } from "../oauth/provider.js";

// OAuth のメタデータ（RFC 9728 / RFC 8414）。MCP クライアントはここから認可サーバーの各エンドポイントを発見します。
// /.well-known/oauth-protected-resource/api/mcp のようなパス付きの問い合わせにも同じ内容を返します。
export async function onRequest({ request }) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return corsPreflight();
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return protectedResourceMetadata(url.origin);
  if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) return authorizationServerMetadata(url.origin);
  return new Response("Not found", { status: 404 });
}
