// DailyPilot の Service Worker です。
// サーバー（Web Push）から届いた通知を表示し、通知をタップしたらアプリを開きます。
// オフライン用のキャッシュは行いません。

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "DailyPilot", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url: data.url || "/" },
    }),
  );
});

// 通知をタップしたら、開いている DailyPilot があればそれを前面に出し、なければ新しく開きます。
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      return;
    }
    await self.clients.openWindow(url);
  })());
});

// ブラウザが購読を更新した場合は、新しい購読情報をサーバーに登録し直します。
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const config = await fetch("/api/notifications").then((response) => response.json());
    if (!config.publicKey) return;
    const key = config.publicKey.replace(/-/g, "+").replace(/_/g, "/");
    const applicationServerKey = Uint8Array.from(atob(key + "===".slice((key.length + 3) % 4)), (char) => char.charCodeAt(0));
    const subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    await fetch("/api/push/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...subscription.toJSON(), label: "更新された端末" }),
    });
  })());
});
